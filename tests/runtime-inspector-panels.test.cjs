const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const inspector=require('../dist/runtime-inspector-panel');
const Original=inspector.mountInspector;
let mounts=[];
inspector.mountInspector=(root,options)=>{const mount={root,options,visible:[],disposed:0,setVisible(v){this.visible.push(v);},dispose(){this.disposed++;}};mounts.push(mount);return mount;};
const hierarchy=require('../dist/runtime-hierarchy-panel'),properties=require('../dist/runtime-properties-panel'),window=require('../dist/runtime-inspector-window');
test.after(()=>{inspector.mountInspector=Original;});
// main.js runs with __dirname inside a temporary extension root (static linked in), so the debug preview reopen marker never touches the real .cache.
function extensionDist(t){const root=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'gd-main-'));fs.mkdirSync(path.join(root,'dist'));fs.symlinkSync(path.resolve(__dirname,'../static'),path.join(root,'static'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return path.join(root,'dist');}
test('docked hierarchy and properties panels mount their own viewer and forward show/hide',()=>{
 for(const [module,viewer,id] of [[hierarchy,'hierarchy','#runtime-hierarchy'],[properties,'properties','#runtime-properties']]){
  mounts=[];const root={};const instance={$:{root}};
  module.ready.call(instance);assert.equal(mounts.length,1);assert.equal(mounts[0].options.viewer,viewer);assert.equal(mounts[0].root,root);assert.notEqual(mounts[0].options.passive,true);assert.equal(mounts[0].options.tooltips,true);
  module.listeners.hide.call(instance);module.listeners.show.call(instance);assert.deepEqual(mounts[0].visible,[false,true]);
  module.ready.call(instance);assert.equal(mounts[0].disposed,1,'re-ready disposes the previous mount');
  module.close.call(instance);module.close.call(instance);assert.equal(mounts[1].disposed,1);
  assert.equal(module.$.root,id);assert.match(module.template,new RegExp('id="'+id.slice(1)+'"'));
 }
 assert.match(hierarchy.template,/id="inspector-tree"/);assert.doesNotMatch(hierarchy.template,/id="inspector-detail"/);
 assert.match(properties.template,/id="inspector-detail"/);assert.doesNotMatch(properties.template,/id="inspector-tree"/);
});
test('floating window combines every surface including the pick button and mounts a window viewer',()=>{
 mounts=[];const root={};const instance={$:{root}};
 window.ready.call(instance);assert.equal(mounts[0].options.viewer,'window');assert.equal(mounts[0].options.tooltips,true);
 assert.match(window.template,/id="inspector-pick"/);assert.doesNotMatch(window.template,/inspector-frame|inspector-keys/);assert.match(window.template,/id="inspector-tree"/);assert.match(window.template,/id="inspector-detail"/);assert.doesNotMatch(window.template,/inspector-output/);assert.doesNotMatch(window.template,/<webview/);
 window.close.call(instance);assert.equal(mounts[0].disposed,1);
});
test('package manifest declares the docked panels, the floating window and every hub message with built entry files',()=>{
 const manifest=require('../package.json');
 assert.equal(manifest.panels['runtime-hierarchy'].type,'dockable');assert.equal(manifest.panels['runtime-properties'].type,'dockable');assert.equal(manifest.panels['runtime-inspector'].type,'simple');
 for(const name of ['runtime-hierarchy','runtime-properties','runtime-inspector','debug-preview'])assert.ok(fs.existsSync(path.resolve(__dirname,'..',manifest.panels[name].main)),name);
 const main=require('../dist/main');
 for(const message of ['runtime-inspector-dock','runtime-inspector-restore','runtime-inspector-state','runtime-inspector-view','runtime-inspector-update','runtime-inspector-action','runtime-inspector-read','runtime-inspector-call','runtime-inspector-open']);assert.equal(manifest.contributions.messages['runtime-inspector-frames'],undefined);
 for(const message of []){
  const method=manifest.contributions.messages[message]?.methods?.[0];assert.ok(method,message);assert.equal(typeof main.methods[method],'function',method);
 }
});
test('showing the preview docks the runtime panels beside Creator\'s own without needing a preview; hiding closes them',async t=>{
 const filename=path.resolve(__dirname,'../dist/main.js'),req=createRequire(filename),exports={},calls=[];const open=new Set(['hierarchy','inspector']);const logs=[];
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{exports,__dirname:extensionDist(t),console:Object.assign(Object.create(console),{info:(...a)=>logs.push(['info',...a]),warn:(...a)=>logs.push(['warn',...a])}),process,setTimeout,clearTimeout,setInterval,clearInterval,require:Object.assign(n=>n==='./git'?{GitDesk:class{task(){return undefined;}}}:n==='./contexts'?{WorkspaceContexts:class{constructor(){this.worktrees={ready:Promise.resolve()};}running(){return false;}}}:n==='./mcp-bridge'?{startMcpBridge:async()=>undefined}:req(n),{cache:req.cache}),
  Editor:{Project:{path:'/fixture'},Panel:{has:async name=>open.has(name),open:async name=>{calls.push(['open',name]);return true;},focus:async name=>{calls.push(['focus',name]);return true;},close:async name=>{calls.push(['close',name]);open.delete(name);},openBeside:async(anchor,name)=>{calls.push(['beside',anchor,name]);open.add(name);return true;}},Message:{broadcast(){},request:async()=>undefined}}});
 exports.load();await new Promise(resolve=>setImmediate(resolve));
 try {
  let reply=await exports.methods.runtimeInspectorDock();assert.equal(reply.ok,true);
  assert.deepEqual(calls,[['beside','hierarchy','cocos-git-desk.runtime-hierarchy'],['beside','inspector','cocos-git-desk.runtime-properties']]);
  calls.length=0;reply=await exports.methods.runtimeInspectorDock();assert.equal(reply.ok,true);assert.deepEqual(calls,[],'without a hub the docked panels are left alone');
  calls.length=0;reply=await exports.methods.runtimeInspectorRestore();assert.equal(reply.ok,true);assert.deepEqual(calls,[['close','cocos-git-desk.runtime-hierarchy'],['close','cocos-git-desk.runtime-properties']],'built-in panels are never opened or focused; the runtime tabs close instead');
  reply=await exports.methods.runtimeInspectorState();assert.equal(reply.ok,false);assert.match(reply.error,/请先打开调试预览/);
  reply=await exports.methods.debugPreviewRelease(1);assert.equal(reply.ok,true,'releasing without a bound page never surfaces the inspector error');
  reply=await exports.methods.runtimeInspectorAsset('../x','reveal');assert.equal(reply.ok,false);assert.deepEqual(logs.at(-1).slice(0,2),['warn','[调试预览] 该对象未保留可定位的源资源 UUID'],'failures reach the console status bar');
 } finally { await exports.unload(); }
});
test('runtime_inspector_status answers without a preview, collects panel reports and remembers failed replies; creator_extension_log reads the notices',async t=>{
 const os=require('node:os');const filename=path.resolve(__dirname,'../dist/main.js'),req=createRequire(filename),exports={},broadcasts=[],logs=[];
 const project=fs.mkdtempSync(path.join(os.tmpdir(),'gd-status-'));fs.writeFileSync(path.join(project,'package.json'),JSON.stringify({uuid:'test-project-0002'}));
 let debugHandler;const open=new Set(['hierarchy','inspector','cocos-git-desk.debug-preview']);
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{exports,__dirname:extensionDist(t),console:Object.assign(Object.create(console),{info:(...a)=>logs.push(['info',...a]),warn:(...a)=>logs.push(['warn',...a]),error:(...a)=>logs.push(['error',...a])}),process,Buffer,setTimeout,clearTimeout,setInterval,clearInterval,
  require:Object.assign(n=>n==='./git'?{GitDesk:class{task(){return undefined;}}}:n==='./contexts'?{WorkspaceContexts:class{constructor(){this.worktrees={ready:Promise.resolve()};}running(){return false;}}}:n==='./mcp-bridge'?{startMcpBridge:async(cache,projectPath,handle,debug)=>{debugHandler=debug;return {close:async()=>{}};}}:n==='electron'?{session:{fromPartition:()=>({})},webContents:{fromId:()=>null}}:req(n),{cache:req.cache}),
  Editor:{Project:{path:project},Panel:{has:async name=>open.has(name),open:async()=>true,focus:async()=>true,close:async name=>{open.delete(name);},openBeside:async(anchor,name)=>{open.add(name);return true;}},Message:{broadcast:(...args)=>broadcasts.push(args),request:async()=>undefined}}});
 exports.load();await new Promise(resolve=>setImmediate(resolve));
 try {
  assert.equal(typeof debugHandler,'function');
  assert.equal((await exports.methods.runtimeInspectorReport('hierarchy',{kind:'report',hierarchy:{rows:3}})).ok,true);
  assert.equal((await exports.methods.runtimeInspectorReport('properties',{kind:'issue',message:'TypeError: boom'})).ok,true);
  assert.equal((await exports.methods.runtimeInspectorReport('',{kind:'report'})).ok,false);
  assert.equal((await exports.methods.runtimeInspectorState()).ok,false,'no preview yet');
  const status=await debugHandler('runtime_inspector_status',{});
  assert.equal(status.preview.present,false);assert.equal(status.hub,null);assert.equal(status.panels['cocos-git-desk.debug-preview'],true);assert.equal(status.panels['cocos-git-desk.runtime-hierarchy'],false);
  assert.equal(status.reports.hierarchy.report.hierarchy.rows,3);assert.equal(status.reports.properties,undefined,'issues are not reports');
  assert.deepEqual(status.issues.map(i=>i.source),['panel:properties','runtimeInspectorReport','runtimeInspectorState']);assert.match(status.issues[2].message,/请先打开调试预览/);
  assert.ok(broadcasts.some(b=>b[0]==='cocos-git-desk:runtime-inspector-report-request'),'panels were asked for a report');
  await assert.rejects(debugHandler('browser_debug_state',{}),/not connected/);
  const log=await debugHandler('creator_extension_log',{level:['warn'],limit:5});
  await exports.methods.runtimeInspectorAsset('../x','reveal');
  const after=await debugHandler('creator_extension_log',{level:['warn'],limit:5});
  assert.equal(after.entries.length,log.entries.length+1);assert.match(after.entries.at(-1).text,/\[调试预览\] 该对象未保留可定位的源资源 UUID/);
  assert.ok((await debugHandler('runtime_inspector_status',{})).issues.some(i=>i.source==='mcp:browser_debug_state'),'MCP failures are remembered too');
 } finally { await exports.unload();fs.rmSync(project,{recursive:true,force:true}); }
});
