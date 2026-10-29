const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
test('load starts once, repeated open does not duplicate services, unload closes MCP, reload restarts',async()=>{
 const filename=path.resolve(__dirname,'../dist/main.js'),req=createRequire(filename),counts={desk:0,bridge:0,closed:0},exports={};
 class Desk{constructor(){counts.desk++;}task(){return undefined;}}
 class Contexts{constructor(){this.worktrees={ready:Promise.resolve()};}running(){return false;}handle(){} }
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{exports,__dirname:path.dirname(filename),console,setTimeout,require:Object.assign(n=>n==='./git'?{GitDesk:Desk}:n==='./contexts'?{WorkspaceContexts:Contexts}:n==='./mcp-bridge'?{startMcpBridge:async()=>{counts.bridge++;return {close:async()=>counts.closed++};}}:req(n),{cache:req.cache}),Editor:{Project:{path:'/fixture'},Panel:{has:async()=>true,open:async()=>true,close:async()=>{}}}});
 exports.load();await Promise.resolve();await Promise.resolve();assert.deepEqual(counts,{desk:1,bridge:1,closed:0});
 await exports.methods.open();await exports.methods.open();await Promise.resolve();assert.equal(counts.desk,1);assert.equal(counts.bridge,1);
 await exports.unload();assert.equal(counts.closed,1);assert.equal((await exports.methods.snapshot()).ok,false);
 exports.load();await Promise.resolve();await Promise.resolve();assert.equal(counts.desk,2);assert.equal(counts.bridge,2);await exports.unload();assert.equal(counts.closed,2);
});
