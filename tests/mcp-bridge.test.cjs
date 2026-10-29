const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const http=require('node:http');const {spawn}=require('node:child_process');
const { windows, portableName, exoticNames, posixModes, linkTarget } = require('./platform.cjs');
const {startMcpBridge,mcpQuery,isDebugTool}=require('../dist/mcp-bridge');
const os=require('node:os');const {spawnSync}=require('node:child_process');
// The stdio adapter is Python; machines without python3 skip the adapter tests instead of failing.
const python=spawnSync('python3',['--version']).status===0;
const tempProject=()=>fs.mkdtemp(path.join(os.tmpdir(),'gd-mcp-'));
test('tool mapping blocks read-to-write injection and requires a task for staging and commit',()=>{
    assert.throws(()=>mcpQuery('git_desk_query',{op:'execute'}));
    assert.throws(()=>mcpQuery('git_desk_query',{op:'status',arguments:{op:'execute'}}));
    assert.throws(()=>mcpQuery('git_desk_prepare',{operation:{action:'commit'}}));
    assert.throws(()=>mcpQuery('git_desk_prepare',{operation:{action:'amendCommit'},taskId:'x'}));
    assert.equal(mcpQuery('git_desk_prepare',{operation:{action:'stage'},taskId:'x'}).query.taskId,'x');
    assert.deepEqual(mcpQuery('git_desk_task_extend',{id:'x',paths:['new.ts']}).query,{id:'x',paths:['new.ts'],kind:'agent',protocol:1,op:'scopeExtend'});
    assert.throws(()=>mcpQuery('git_desk_execute',{token:'x',digest:'x',command:'rm'}));
});
test('private loopback authentication, MCP stdio lifecycle and bounded tools work without arbitrary evaluation',async t=>{
    if(!python)return t.skip('python3 is not available');
    const base=await tempProject();
    const cache=path.join(base,'extensions/cocos-git-desk/.cache');const calls=[];
    const debugCalls=[];const bridge=await startMcpBridge(cache,base,async(repo,query)=>{calls.push({repo,query});return {ok:true,data:{protocol:1,op:query.op,result:{repo}}};},async(name,args)=>{debugCalls.push({name,args});if(name==='browser_debug_identity')throw Error('内嵌预览未连接');return {nodes:[],sessionId:'s'};});
    t.after(async()=>{await bridge.close();await fs.rm(base,{recursive:true,force:true});});
    const connection=JSON.parse(await fs.readFile(path.join(cache,'agent-connection.json'),'utf8'));
    if(posixModes)assert.equal((await fs.stat(path.join(cache,'agent-connection.json'))).mode&0o777,0o600);
    const request=(headers={})=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:connection.port,path:'/rpc',method:'POST',headers},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end('{}');});
    assert.equal(await request(),403);assert.equal(await request({Authorization:'Bearer '+connection.token,Origin:'http://evil.invalid'}),403);assert.equal(calls.length,0);
    const child=spawn('python3',[path.resolve(__dirname,'../scripts/git-desk-mcp.py'),'--project',base],{stdio:['pipe','pipe','pipe']});t.after(()=>child.kill());let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    const messages=[{id:0,method:'tools/list'},{id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fixture',version:'1'}}},{method:'notifications/initialized'},{id:2,method:'tools/list'},{id:3,method:'tools/call',params:{name:'git_desk_query',arguments:{op:'status'}}},{id:4,method:'tools/call',params:{name:'git_desk_prepare',arguments:{operation:{action:'commit'}}}},{id:5,method:'tools/call',params:{name:'runtime_inspector_hierarchy',arguments:{contains:'btn'}}},{id:6,method:'tools/call',params:{name:'browser_debug_identity',arguments:{}}}];
    for(const message of messages)child.stdin.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');child.stdin.end();
    const exit=await new Promise(resolve=>child.on('exit',resolve));assert.equal(exit,0,stderr);
    const replies=stdout.trim().split('\n').map(JSON.parse);assert.equal(replies[0].error.code,-32602);assert.equal(replies[1].result.protocolVersion,'2025-11-25');assert.equal(replies[2].result.tools.length,76,'core, inspector and bridge without an i18n key pattern');assert.equal(replies[2].result.tools.filter(tool=>isDebugTool(tool.name)).length,61);assert.equal(replies[2].result.tools.some(tool=>tool.name==='creator_language_keys'),false);assert.equal(replies[3].result.isError,false);assert.equal(replies[4].result.isError,true);assert.equal(calls.length,1);assert.equal(calls[0].query.op,'status');
    assert.equal(replies[5].result.isError,false);assert.deepEqual(replies[5].result.structuredContent,{ok:true,data:{nodes:[],sessionId:'s'}});assert.equal(replies[6].result.isError,true);assert.match(replies[6].result.content[0].text,/内嵌预览未连接/);assert.deepEqual(debugCalls.map(c=>c.name),['runtime_inspector_hierarchy','browser_debug_identity']);assert.deepEqual(debugCalls[0].args,{contains:'btn'});
});
test('debug tools never reach the Git handler and are refused without a debug host',async t=>{
    const base=await tempProject();const cache=path.join(base,'extensions/cocos-git-desk/.cache');
    const bridge=await startMcpBridge(cache,base,async()=>{throw Error('git handler must not see debug tools');});
    t.after(async()=>{await bridge.close();await fs.rm(base,{recursive:true,force:true});});
    const connection=JSON.parse(await fs.readFile(path.join(cache,'agent-connection.json'),'utf8'));
    const call=body=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:connection.port,path:'/rpc',method:'POST',headers:{Authorization:'Bearer '+connection.token}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));});req.on('error',reject);req.end(JSON.stringify(body));});
    const refused=await call({name:'browser_debug_status',arguments:{}});assert.equal(refused.status,400);assert.match(refused.body.error,/未提供调试工具/);
    assert.equal(isDebugTool('git_desk_query'),false);assert.equal(isDebugTool('runtime_inspector_print'),true);assert.equal(isDebugTool('creator_asset_query'),true);
});
test('the adapter explains an unreachable or missing Creator connection instead of a bare socket error',async t=>{
    if(!python)return t.skip('python3 is not available');
    const base=await tempProject();const cache=path.join(base,'extensions/cocos-git-desk/.cache');
    t.after(()=>fs.rm(base,{recursive:true,force:true}));
    const run=async()=>{const child=spawn('python3',[path.resolve(__dirname,'../scripts/git-desk-mcp.py'),'--project',base],{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
        for(const message of [{id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fixture',version:'1'}}},{method:'notifications/initialized'},{id:2,method:'tools/call',params:{name:'git_desk_query',arguments:{op:'status'}}}])child.stdin.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');
        child.stdin.end();const exit=await new Promise(resolve=>child.on('exit',resolve));assert.equal(exit,0,stderr);return stdout.trim().split("\n").map(JSON.parse)[1].result;};
    const missing=await run();assert.equal(missing.isError,true);assert.match(missing.content[0].text,/connection file not found/);assert.match(missing.content[0].text,/Extension Manager/);
    // A connection file left behind by a Creator that has since exited points at a port nobody listens on.
    const port=await new Promise(resolve=>{const server=http.createServer();server.listen(0,'127.0.0.1',()=>{const {port}=server.address();server.close(()=>resolve(port));});});
    await fs.mkdir(cache,{recursive:true});await fs.writeFile(path.join(cache,'agent-connection.json'),JSON.stringify({schema:1,project:base,port,token:'a'.repeat(64)}),{mode:0o600});
    const refused=await run();assert.equal(refused.isError,true);assert.match(refused.content[0].text,/cannot connect to port \d+/);assert.match(refused.content[0].text,/Git Desk in Cocos Creator is not reachable/);assert.match(refused.content[0].text,/do not retry unconfirmed writes/);assert.doesNotMatch(refused.content[0].text,/AMSAChess/);
});
test('the adapter lists the i18n catalogue only when git-desk.config.json sets a key pattern, like the Creator side',async t=>{
    if(!python)return t.skip('python3 is not available');
    const {toolCatalogue,validateConfig}=require('../dist/config');
    const base=await tempProject();t.after(()=>fs.rm(base,{recursive:true,force:true}));
    const list=async()=>{const child=spawn('python3',[path.resolve(__dirname,'../scripts/git-desk-mcp.py'),'--project',base],{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
        for(const message of [{id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fixture',version:'1'}}},{method:'notifications/initialized'},{id:2,method:'tools/list'},{id:3,method:'tools/call',params:{name:'creator_language_keys',arguments:{}}}])child.stdin.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');
        child.stdin.end();const exit=await new Promise(resolve=>child.on('exit',resolve));assert.equal(exit,0,stderr);const replies=stdout.trim().split('\n').map(JSON.parse);return {init:replies[0].result,tools:replies[1].result.tools.map(tool=>tool.name),call:replies[2]};};
    const plain=await list();assert.deepEqual(plain.tools,toolCatalogue(validateConfig({})).map(tool=>tool.name));assert.equal(plain.call.error.code,-32602,'an unlisted tool cannot be called');
    assert.equal(plain.init.serverInfo.name,'cocos-git-desk');assert.equal(plain.init.serverInfo.version,require('../package.json').version);
    await fs.writeFile(path.join(base,'git-desk.config.json'),JSON.stringify({i18n:{keyPattern:'\\btxt_[a-z]+\\b'}}));
    const enabled=await list();assert.deepEqual(enabled.tools,toolCatalogue(validateConfig({i18n:{keyPattern:'x'}})).map(tool=>tool.name));assert.equal(enabled.tools.length,77);assert.ok(enabled.tools.includes('creator_language_keys'));
    await fs.writeFile(path.join(base,'git-desk.config.json'),'{not json');assert.equal((await list()).tools.length,76,'an unreadable configuration lists no i18n tools');
});
