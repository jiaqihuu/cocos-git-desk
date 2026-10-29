'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
// Names shared with src/config.ts (CommonJS cannot import the TypeScript module without a build).
const serverName = 'cocos-git-desk';
const extensionDir = 'extensions/cocos-git-desk';
const dataDirName = '.cocos-git-desk';
const defaultUrl = 'http://localhost:7456/';
const begin = '# BEGIN COCOS GIT DESK (managed by Creator)';
const end = '# END COCOS GIT DESK';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
// Creator project uuid from package.json, or a stable hash of the project path.
function projectId(root) {
    try {
        const uuid = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).uuid;
        if (typeof uuid === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(uuid)) return uuid;
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    return sha256(root).slice(0, 12);
}
function dataDir(id, home = os.homedir()) { return path.join(home, dataDirName, id); }
// url comes from git-desk.config.json (preview.url) or the Creator default; the port and the browser
// profile are stable per project so an external browser can be reopened on the same debugging session.
function projectOptions(project, { url, projectId: id, home } = {}) {
    const root = fs.realpathSync(project);
    const resolved = id || projectId(root);
    return { root, id: resolved, port: 19222 + parseInt(sha256(resolved).slice(0, 4), 16) % 10000, url: url || defaultUrl,
        profile: path.join(dataDir(resolved, home), 'browser-profile') };
}
// One MCP for every client: the Python adapter next to this extension, served by the running Creator.
function configBlock(project, python = 'python3') {
    // Forward slashes on every platform: Python and Codex accept D:/work/x on Windows, and the block stays readable
    // (JSON escaping would double every backslash) and comparable with templates/codex-config.toml.
    const root = fs.realpathSync(project).split(path.sep).join('/');
    return [begin, '[mcp_servers.' + serverName + ']',
        'command = ' + JSON.stringify(python),
        'args = ' + JSON.stringify([[root, extensionDir, 'scripts', 'git-desk-mcp.py'].join('/'), '--project', root]),
        'cwd = ' + JSON.stringify(root), 'startup_timeout_sec = 30', 'tool_timeout_sec = 150', 'enabled = true', end, ''].join('\n');
}
// Claude Code reads .mcp.json at the project root; the entry locates the adapter through CLAUDE_PROJECT_DIR,
// so the committed file holds no machine path. templates/mcp.json carries the same entry (checked by the tests).
const claudeLauncher = "import os,runpy,sys; from pathlib import Path; root=Path(os.environ.get('CLAUDE_PROJECT_DIR') or os.getcwd()).resolve(); script=root/'"
    + extensionDir + "/scripts/git-desk-mcp.py'; sys.argv=[str(script),'--project',str(root)]; runpy.run_path(str(script),run_name='__main__')";
function claudeEntry() { return { type: 'stdio', command: 'python3', args: ['-c', claudeLauncher] }; }
const manualEntry = new RegExp('^\\s*\\[\\s*mcp_servers\\s*\\.\\s*["\']?' + serverName + '["\']?(?:\\s*\\.|\\s*\\])', 'm');
function stripManaged(existing) {
    const start = existing.indexOf(begin), finish = existing.indexOf(end);
    if (start < 0 && finish < 0) return existing;
    if (start < 0 || finish < start || existing.indexOf(begin, start + begin.length) >= 0) throw Error('The managed block markers are incomplete; check .codex/config.toml first');
    // Blank lines that separated the block are dropped with it, so repeated runs do not grow the file.
    return existing.slice(0, start).replace(/\n+$/, '\n') + existing.slice(finish + end.length).replace(/^\r?\n/, '');
}
// A hand-written cocos-git-desk entry outside the markers is kept as the user's own; only the managed block is replaced or removed.
function mergeConfig(existing, block) {
    const rest = stripManaged(existing);
    if (manualEntry.test(rest)) return rest;
    return rest + (rest.endsWith('\n') || !rest ? '' : '\n') + '\n' + block;
}
// Every skill bundled next to this file is installed for Codex under .agents/skills.
function bundledSkills() {
    return fs.readdirSync(path.join(__dirname, 'skills'), { withFileTypes: true }).filter(entry => entry.isDirectory() && fs.existsSync(path.join(__dirname, 'skills', entry.name, 'SKILL.md'))).map(entry => entry.name).sort();
}
function skillsCurrent(root) {
    return bundledSkills().every(name => fs.existsSync(path.join(root, '.agents', 'skills', name, 'SKILL.md'))
        && fs.readFileSync(path.join(root, '.agents', 'skills', name, 'SKILL.md'), 'utf8') === fs.readFileSync(path.join(__dirname, 'skills', name, 'SKILL.md'), 'utf8'));
}
function codexConfigured(project, python = 'python3') {
    const root = fs.realpathSync(project);
    try {
        const config = fs.readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8').replace(/\r\n/g, '\n');
        const current = config.includes(configBlock(root, python).trim()) || (manualEntry.test(config) && !config.includes(begin));
        return current && skillsCurrent(root);
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function claudeConfigured(project) {
    const root = fs.realpathSync(project);
    try {
        const config = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
        return JSON.stringify(config && config.mcpServers && config.mcpServers[serverName]) === JSON.stringify(claudeEntry());
    } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
}
// True when every client listed in git-desk.config.json is current; an empty list is never "configured".
function clientsConfigured(project, { clients = [], python = 'python3' } = {}) {
    return clients.length > 0 && clients.every(name => name === 'codex' ? codexConfigured(project, python) : name === 'claude-code' ? claudeConfigured(project) : false);
}
function backup(backupRoot, id, name, content) {
    fs.mkdirSync(backupRoot, { recursive: true });
    fs.writeFileSync(path.join(backupRoot, id + '-' + crypto.randomUUID() + '-' + name), content, { mode: 0o600, flag: 'wx' });
}
function writeAtomic(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.' + crypto.randomUUID();
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
}
function configureCodex(project, python = 'python3', backupRoot) {
    const { root, id } = projectOptions(project);
    backupRoot = backupRoot || path.join(dataDir(id), 'backups');
    const config = path.join(root, '.codex', 'config.toml');
    const old = fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : '';
    const next = mergeConfig(old, configBlock(root, python));
    if (next !== old) {
        if (old) backup(backupRoot, id, 'config.toml', old);
        writeAtomic(config, next);
    }
    for (const name of bundledSkills()) {
        const source = path.join(__dirname, 'skills', name, 'SKILL.md');
        const target = path.join(root, '.agents', 'skills', name, 'SKILL.md');
        if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') !== fs.readFileSync(source, 'utf8')) backup(backupRoot, id, name + '-SKILL.md', fs.readFileSync(target));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
    }
    return config;
}
// .mcp.json keeps every other server; only the cocos-git-desk entry is written.
function configureClaude(project, backupRoot) {
    const { root, id } = projectOptions(project);
    backupRoot = backupRoot || path.join(dataDir(id), 'backups');
    const file = path.join(root, '.mcp.json');
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    let config = {};
    if (old.trim()) {
        try { config = JSON.parse(old); } catch { throw Error('.mcp.json is not valid JSON; fix it before Git Desk writes the ' + serverName + ' entry'); }
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('.mcp.json must hold a JSON object');
    }
    if (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) config.mcpServers = {};
    config.mcpServers[serverName] = claudeEntry();
    const next = JSON.stringify(config, null, 2) + '\n';
    if (next !== old) {
        if (old) backup(backupRoot, id, 'mcp.json', old);
        writeAtomic(file, next);
    }
    return file;
}
// Writes the configuration of every listed client and returns the snippets for the others.
function configureClients(project, { clients = [], python = 'python3', backupRoot } = {}) {
    const root = fs.realpathSync(project);
    const written = [];
    for (const name of clients) {
        if (name === 'codex') written.push(configureCodex(root, python, backupRoot));
        else if (name === 'claude-code') written.push(configureClaude(root, backupRoot));
        else throw Error('Unknown AI client in git-desk.config.json: ' + String(name));
    }
    return { written, skills: bundledSkills(), snippets: { codex: configBlock(root, python), claudeCode: JSON.stringify({ mcpServers: { [serverName]: claudeEntry() } }, null, 2) + '\n' } };
}
function browserCandidates(platform = process.platform, env = process.env) {
    if (platform === 'darwin') return [
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')];
    if (platform === 'win32') return [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean).flatMap(base => [
        path.join(base, 'Microsoft/Edge/Application/msedge.exe'), path.join(base, 'Google/Chrome/Application/chrome.exe')]);
    return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
}
function browserArgs(options) {
    return ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + options.port,
        '--user-data-dir=' + options.profile, '--no-first-run', '--no-default-browser-check', options.url];
}
module.exports = { serverName, extensionDir, defaultUrl, begin, end, projectId, dataDir, projectOptions, configBlock, claudeEntry, mergeConfig, configureCodex, configureClaude, configureClients, codexConfigured, claudeConfigured, clientsConfigured, bundledSkills, browserCandidates, browserArgs };
