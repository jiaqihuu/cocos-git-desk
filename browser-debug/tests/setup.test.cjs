const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { projectOptions, projectId, configBlock, claudeEntry, mergeConfig, configureCodex, configureClaude, configureClients, codexConfigured, claudeConfigured, clientsConfigured, bundledSkills, browserArgs, browserCandidates, begin, end, serverName } = require('../setup.cjs');
// Every fixture lives under the system temporary directory; nothing is written to the real home directory.
function fixture(t, uuid = 'test-project-' + Math.random().toString(16).slice(2, 10)) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-debug-setup-'));
    if (uuid !== null) fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({uuid}));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true})); return fs.realpathSync(root);
}
const skill = name => path.join('.agents', 'skills', name, 'SKILL.md');
test('Codex gets the same Python MCP as Claude Code; unrelated servers and the skill are kept in step', t=>{
    const root=fixture(t),backup=path.join(root,'backups');fs.mkdirSync(path.join(root,'.codex'));
    const existing='[mcp_servers.other]\ncommand = "keep-me"\n';
    fs.writeFileSync(path.join(root,'.codex/config.toml'),existing);
    const config=configureCodex(root,'python3',backup),once=fs.readFileSync(config,'utf8');
    assert.equal(serverName,'cocos-git-desk');
    assert.ok(once.startsWith(existing));assert.ok(once.includes('[mcp_servers.cocos-git-desk]'));assert.ok(once.includes('git-desk-mcp.py'));
    assert.ok(once.includes('# BEGIN COCOS GIT DESK (managed by Creator)'));assert.ok(once.includes('# END COCOS GIT DESK'));
    assert.doesNotMatch(once,/amsa/i);
    configureCodex(root,'python3',backup);assert.equal(fs.readFileSync(config,'utf8'),once);
    assert.equal(fs.readdirSync(backup).length,1);
    assert.deepEqual(bundledSkills(),['cocos-git-desk-debug']);assert.ok(fs.existsSync(path.join(root,skill('cocos-git-desk-debug'))));
    assert.equal(codexConfigured(root),true);
    const template=fs.readFileSync(path.join(__dirname,'../../templates/codex-config.toml'),'utf8');
    assert.ok(template.includes(configBlock(root).split(fs.realpathSync(root).split(path.sep).join('/')).join('<project>').trim()),'templates/codex-config.toml matches the managed block');
});
test('a stale managed block is replaced; a hand-written cocos-git-desk entry is kept as-is',t=>{
    const stale='[mcp_servers.other]\ncommand = "keep-me"\n\n'+begin+'\n[mcp_servers.cocos-git-desk]\ncommand = "/old/python"\n'+end+'\n';
    const merged=mergeConfig(stale,configBlock(fixture(t)));
    assert.equal(merged.includes('/old/python'),false);assert.ok(merged.startsWith('[mcp_servers.other]'));assert.ok(merged.includes('[mcp_servers.cocos-git-desk]'));
    const manual='[mcp_servers.cocos-git-desk]\ncommand = "/usr/bin/python3"\n';
    assert.equal(mergeConfig(manual+'\n'+stale.slice(stale.indexOf('# BEGIN')),'new'),manual,'the managed block goes, the manual entry stays');
    assert.equal(mergeConfig(manual,'new'),manual);
    assert.throws(()=>mergeConfig(begin,'new'),/markers are incomplete/);
});
test('project id is the Creator uuid, or a path hash without one; profile and port are stable per project',t=>{
    const home=fs.mkdtempSync(path.join(os.tmpdir(),'gd-home-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
    const a=projectOptions(fixture(t,'uuid-a'),{home}),b=projectOptions(fixture(t,'uuid-b'),{home});
    assert.equal(a.id,'uuid-a');assert.notEqual(a.profile,b.profile);assert.notEqual(a.port,b.port);
    assert.equal(a.profile,path.join(home,'.cocos-git-desk','uuid-a','browser-profile'));
    assert.equal(projectOptions(a.root,{home}).port,a.port);assert.equal(a.url,'http://localhost:7456/');
    assert.equal(projectOptions(a.root,{home,url:'http://127.0.0.1:7457/'}).url,'http://127.0.0.1:7457/','preview.url from git-desk.config.json wins');
    const bare=fixture(t,null);assert.match(projectId(bare),/^[0-9a-f]{12}$/);assert.equal(projectId(bare),projectId(bare));
    assert.ok(browserArgs(a).includes('--remote-debugging-address=127.0.0.1'));
    assert.ok(browserArgs(a).includes('--user-data-dir='+a.profile));assert.ok(browserCandidates('win32',{PROGRAMFILES:'C:\\Program Files'}).length);
});
test('browser launch waits for matching Preview and reports bounded failure', async()=>{
    const {waitForPreview}=require('../actions.cjs');
    const options={port:1234,url:'http://localhost:7456/'};let reads=0;
    await waitForPreview(options,async()=>++reads===3?[{type:'page',url:options.url}]:[],3,async()=>{});
    assert.equal(reads,3);reads=0;
    await assert.rejects(waitForPreview(options,async()=>{reads++;return [{type:'page',url:'http://elsewhere/'}]},2,async()=>{}),/not connected to the preview page/);
    assert.equal(reads,2);
});
test('Codex status is read-only and detects missing, current, disabled and manual setups',t=>{
 const root=fixture(t);
 assert.equal(codexConfigured(root),false);
 assert.equal(fs.existsSync(path.join(root,'.codex')),false);
 const file=configureCodex(root,'python3',path.join(root,'backups'));
 assert.equal(codexConfigured(root),true);
 fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('enabled = true','enabled = false'));
 assert.equal(codexConfigured(root),false);
 fs.writeFileSync(file,'[mcp_servers.cocos-git-desk]\ncommand = "/usr/bin/python3"\n');
 assert.equal(codexConfigured(root),true,'a manual entry with the current skill counts as configured');
 fs.writeFileSync(path.join(root,skill('cocos-git-desk-debug')),'old');
 assert.equal(codexConfigured(root),false,'an outdated skill copy asks for a re-run');
});
test('Claude Code gets the cocos-git-desk entry in .mcp.json next to the servers already there',t=>{
    const root=fixture(t),backup=path.join(root,'backups');
    assert.deepEqual(claudeEntry(),require('../../templates/mcp.json').mcpServers['cocos-git-desk'],'templates/mcp.json carries the same entry');
    assert.ok(claudeEntry().args[1].includes('CLAUDE_PROJECT_DIR'));assert.equal(claudeEntry().args[1].includes(root),false,'no machine path is committed');
    assert.equal(claudeConfigured(root),false);
    fs.writeFileSync(path.join(root,'.mcp.json'),JSON.stringify({mcpServers:{other:{command:'keep-me'}}}));
    const file=configureClaude(root,backup),written=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.deepEqual(written.mcpServers.other,{command:'keep-me'});assert.deepEqual(written.mcpServers['cocos-git-desk'],claudeEntry());
    assert.equal(claudeConfigured(root),true);assert.equal(fs.readdirSync(backup).length,1);
    configureClaude(root,backup);assert.equal(fs.readdirSync(backup).length,1,'an unchanged file is not rewritten');
    fs.writeFileSync(file,'{broken');assert.equal(claudeConfigured(root),false);assert.throws(()=>configureClaude(root,backup),/not valid JSON/);
});
test('configureClients writes only the clients listed in git-desk.config.json and always returns both snippets',t=>{
    const root=fixture(t),backupRoot=path.join(root,'backups');
    const none=configureClients(root,{clients:[],backupRoot});
    assert.deepEqual(none.written,[]);assert.equal(fs.existsSync(path.join(root,'.codex')),false);assert.equal(fs.existsSync(path.join(root,'.mcp.json')),false);
    assert.ok(none.snippets.codex.includes('[mcp_servers.cocos-git-desk]'));assert.deepEqual(JSON.parse(none.snippets.claudeCode).mcpServers['cocos-git-desk'],claudeEntry());
    assert.equal(clientsConfigured(root,{clients:[]}),false,'nothing listed is never "configured"');
    const claude=configureClients(root,{clients:['claude-code'],backupRoot});
    assert.deepEqual(claude.written,[path.join(root,'.mcp.json')]);assert.equal(fs.existsSync(path.join(root,'.codex')),false);
    assert.equal(clientsConfigured(root,{clients:['claude-code']}),true);assert.equal(clientsConfigured(root,{clients:['claude-code','codex']}),false);
    configureClients(root,{clients:['codex','claude-code'],backupRoot});assert.equal(clientsConfigured(root,{clients:['codex','claude-code']}),true);
    assert.throws(()=>configureClients(root,{clients:['cursor'],backupRoot}),/Unknown AI client/);
});
