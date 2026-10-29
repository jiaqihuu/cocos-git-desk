const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module'),{EventEmitter}=require('node:events');
// main.js runs with __dirname inside a temporary extension root, so the reopen marker never lands in the real .cache.
function projectDir(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gd-project-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function extensionRoot(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'gd-activation-'));fs.mkdirSync(path.join(root,'dist'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('load starts once, repeated open does not duplicate services, unload closes MCP, reload restarts',async t=>{
 const filename=path.resolve(__dirname,'../dist/main.js'),req=createRequire(filename),counts={desk:0,bridge:0,closed:0},exports={};
 class Desk{constructor(){counts.desk++;}task(){return undefined;}}
 class Contexts{constructor(){this.worktrees={ready:Promise.resolve()};}running(){return false;}handle(){} }
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{exports,__dirname:path.join(extensionRoot(t),'dist'),console,setTimeout,clearTimeout,require:Object.assign(n=>n==='./git'?{GitDesk:Desk}:n==='./contexts'?{WorkspaceContexts:Contexts}:n==='./mcp-bridge'?{startMcpBridge:async()=>{counts.bridge++;return {close:async()=>counts.closed++};}}:req(n),{cache:req.cache}),Editor:{Project:{path:'/fixture'},Panel:{has:async()=>true,open:async()=>true,close:async()=>{}}}});
 exports.load();await Promise.resolve();await Promise.resolve();assert.deepEqual(counts,{desk:1,bridge:1,closed:0});
 await exports.methods.open();await exports.methods.open();await Promise.resolve();assert.equal(counts.desk,1);assert.equal(counts.bridge,1);
 await exports.unload();assert.equal(counts.closed,1);assert.equal((await exports.methods.snapshot()).ok,false);
 exports.load();await Promise.resolve();await Promise.resolve();assert.equal(counts.desk,2);assert.equal(counts.bridge,2);await exports.unload();assert.equal(counts.closed,2);
});
test('unload closes an open debug preview and leaves a marker; the next load reopens it once, a stale marker or a quit does not',async t=>{
 const root=extensionRoot(t),project=projectDir(t),marker=path.join(root,'.cache','debug-preview-reopen-'+require('../dist/config').projectId(project)),filename=path.resolve(__dirname,'../dist/main.js'),req=createRequire(filename),exports={},calls=[],timers=[],app=new EventEmitter(),editor=new EventEmitter(),panel=new EventEmitter();
 editor.getTitle=()=>'Cocos Creator - demo';panel.getTitle=()=>'Debug Preview';let tool;
 fs.symlinkSync(path.resolve(__dirname,'../static'),path.join(root,'static'));
 const open=new Set(['scene','hierarchy','inspector','cocos-git-desk.default','cocos-git-desk.debug-preview']);
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{exports,__dirname:path.join(root,'dist'),console,setTimeout:(fn,ms)=>timers.push({fn,ms}),clearTimeout:id=>{if(timers[id-1])timers[id-1].fn=null;},
  require:Object.assign(n=>n==='./git'?{GitDesk:class{task(){return undefined;}}}:n==='./contexts'?{WorkspaceContexts:class{constructor(){this.worktrees={ready:Promise.resolve()};}running(){return false;}}}:n==='./mcp-bridge'?{startMcpBridge:async(_cache,_project,_handle,call)=>{tool=call;return {close:async()=>{calls.push(['mcp-close']);}};}}:n==='electron'?{app,BrowserWindow:{getAllWindows:()=>[panel,editor]}}:req(n),{cache:req.cache}),
  Editor:{Project:{path:project},Message:{request:async(...args)=>{if(args[0]==='preview')return undefined;calls.push(args);return true;}},Panel:{has:async name=>open.has(name),open:async()=>true,focus:async name=>{calls.push(['focus',name]);return true;},close:async name=>{calls.push(['close',name]);open.delete(name);},openBeside:async(anchor,name)=>{calls.push(['beside',anchor,name]);open.add(name);return true;}}}});
 // Startup asks Creator for its preview URL; those requests are not part of what this test checks.
 // Timers fire in order; the 2 s marker recheck and the 500 ms reopen are both one-shot.
 const runTimers=async()=>{for(const timer of timers.splice(0))timer.fn?.();await new Promise(resolve=>setImmediate(resolve));};
 const pending=()=>timers.filter(timer=>timer.fn);
 exports.load();assert.equal(app.listenerCount('before-quit'),1);assert.equal(editor.listenerCount('close'),1,'the editor window, found by its title');assert.equal(panel.listenerCount('close'),0);
 assert.deepEqual(pending().map(timer=>timer.ms),[2000],'without a marker only the late-marker recheck waits');
 await exports.unload();assert.deepEqual(calls,[['mcp-close'],['close','cocos-git-desk.debug-preview']],'the MCP port is released before the tab closes');
 assert.equal(app.listenerCount('before-quit'),0);assert.equal(editor.listenerCount('close'),0);
 assert.ok(Date.now()-Number(fs.readFileSync(marker,'utf8'))<5000,'the marker records when the tab was closed');
 calls.length=0;timers.length=0;exports.load();assert.equal(fs.existsSync(marker),false,'load consumes the marker');assert.deepEqual(pending().map(timer=>timer.ms),[500]);
 await runTimers();assert.deepEqual(calls,[['beside','cocos-git-desk.default','cocos-git-desk.debug-preview']],'the tab comes back beside Git Desk');
 assert.deepEqual(pending().map(timer=>timer.ms),[1500],'then the runtime panels are docked once more');calls.length=0;await runTimers();
 assert.deepEqual(calls,[['beside','hierarchy','cocos-git-desk.runtime-hierarchy'],['beside','inspector','cocos-git-desk.runtime-properties']],'after the closed tab\'s late restore request');
 exports.load();assert.deepEqual(pending().map(timer=>timer.ms),[2000],'only once');await exports.unload();
 calls.length=0;timers.length=0;fs.writeFileSync(marker,String(Date.now()-3*60*1000));exports.load();assert.equal(fs.existsSync(marker),false);assert.deepEqual(pending().map(timer=>timer.ms),[2000],'a stale marker is dropped');
 // A load that ran before the old unload finished writing its marker picks it up on the recheck.
 fs.writeFileSync(marker,String(Date.now()));await runTimers();assert.equal(fs.existsSync(marker),false);assert.deepEqual(pending().map(timer=>timer.ms),[500]);
 await runTimers();assert.deepEqual(calls,[['beside','cocos-git-desk.default','cocos-git-desk.debug-preview']]);await runTimers();assert.equal(timers.length,0,'the recheck looks only once');
 await exports.unload();fs.rmSync(marker,{force:true});
 calls.length=0;timers.length=0;fs.writeFileSync(marker,String(Date.now()));exports.load();assert.equal(pending().length,1);await exports.unload();await runTimers();assert.equal(calls.some(c=>c[0]==='beside'),false,'an unload cancels a pending reopen');
 open.add('cocos-git-desk.debug-preview');fs.rmSync(marker,{force:true});exports.load();calls.length=0;
 app.emit('before-quit');await exports.unload();assert.deepEqual(calls,[['mcp-close']],'a quit leaves the tab to Creator\'s layout');assert.equal(fs.existsSync(marker),false);
 exports.load();calls.length=0;editor.emit('close');await exports.unload();assert.equal(calls.some(c=>c[0]==='close'),false,'closing the editor window counts as quitting');assert.equal(fs.existsSync(marker),false);
 exports.load();calls.length=0;panel.emit('close');await exports.unload();assert.equal(calls.some(c=>c[0]==='close'),true,'closing another window does not');fs.rmSync(marker,{force:true});
 open.add('cocos-git-desk.debug-preview');exports.load();calls.length=0;timers.length=0;editor.emit('close');
 // creator_reload_extension marks its own reload, which reopens the tab even after the editor window started closing.
 await new Promise(resolve=>setImmediate(resolve));await tool('creator_reload_extension',{name:'cocos-git-desk'});
 const reload=timers.find(timer=>timer.ms===400);reload.fn();assert.deepEqual(calls.at(-1),['extension','reload',root]);
 await exports.unload();assert.ok(calls.some(c=>c[0]==='close'));assert.ok(fs.existsSync(marker),'a requested reload reopens');
 timers.length=0;exports.load();assert.deepEqual(pending().map(timer=>timer.ms),[500]);await exports.unload();
});
test('the reopen marker belongs to one project, and a failed self-reload does not turn a later quit into a reload',async t=>{
 const root=extensionRoot(t),filename=path.resolve(__dirname,'../dist/main.js'),req=createRequire(filename),{projectId}=require('../dist/config');
 const timers=[],app=new EventEmitter(),editor=new EventEmitter();editor.getTitle=()=>'Cocos Creator - demo';fs.symlinkSync(path.resolve(__dirname,'../static'),path.join(root,'static'));
 const make=project=>{const exports={},calls=[],open=new Set(['scene','cocos-git-desk.default','cocos-git-desk.debug-preview']);let tool,reload=async()=>true;
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{exports,__dirname:path.join(root,'dist'),console,setTimeout:(fn,ms)=>timers.push({fn,ms}),clearTimeout:id=>{if(timers[id-1])timers[id-1].fn=null;},
   require:Object.assign(n=>n==='./git'?{GitDesk:class{task(){return undefined;}}}:n==='./contexts'?{WorkspaceContexts:class{constructor(){this.worktrees={ready:Promise.resolve()};}running(){return false;}}}:n==='./mcp-bridge'?{startMcpBridge:async(_c,_p,_h,call)=>{tool=call;return {close:async()=>{}};}}:n==='electron'?{app,BrowserWindow:{getAllWindows:()=>[editor]}}:req(n),{cache:req.cache}),
   Editor:{Project:{path:project},Message:{request:async(...args)=>{if(args[0]==='preview')return undefined;calls.push(args);return args[1]==='reload'?reload():true;}},Panel:{has:async name=>open.has(name),open:async()=>true,focus:async()=>true,close:async name=>{calls.push(['close',name]);open.delete(name);},openBeside:async(a,name)=>{calls.push(['beside',a,name]);open.add(name);return true;}}}});
  return {exports,calls,open,tool:()=>tool,failReload:()=>{reload=async()=>{throw Error('reload refused');};}};};
 const pa=projectDir(t),pb=projectDir(t),pc=projectDir(t),a=make(pa),b=make(pb),markerA=path.join(root,'.cache','debug-preview-reopen-'+projectId(pa));
 a.exports.load();await a.exports.unload();assert.ok(fs.existsSync(markerA),'project A leaves its own marker');
 timers.length=0;b.exports.load();assert.ok(fs.existsSync(markerA),'project B does not consume it');for(const timer of timers.splice(0))timer.fn?.();await new Promise(resolve=>setImmediate(resolve));for(const timer of timers.splice(0))timer.fn?.();await new Promise(resolve=>setImmediate(resolve));assert.ok(fs.existsSync(markerA),'not even on the late recheck');
 assert.equal(b.calls.some(c=>c[0]==='beside'),false,'and does not open a preview it never had');await b.exports.unload();fs.rmSync(markerA,{force:true});
 const c=make(pc),markerC=path.join(root,'.cache','debug-preview-reopen-'+projectId(pc));c.failReload();c.exports.load();await new Promise(resolve=>setImmediate(resolve));
 timers.length=0;await c.tool()('creator_reload_extension',{name:'cocos-git-desk'});timers.find(timer=>timer.ms===400).fn();await new Promise(resolve=>setImmediate(resolve));
 app.emit('before-quit');c.calls.length=0;await c.exports.unload();
 assert.equal(c.calls.some(call=>call[0]==='close'),false,'a reload that never happened does not count as a self-reload at quit');assert.equal(fs.existsSync(markerC),false);
});
