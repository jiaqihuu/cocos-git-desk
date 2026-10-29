const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {inspectorClient,stateBroadcast}=require('../dist/runtime-inspector-panel');
test('inspector client addresses the hub through versioned Git Desk messages and unwraps replies',async()=>{
 const calls=[];global.Editor={Message:{request:async(...values)=>{calls.push(values);return values[1]==='runtime-inspector-action'?{ok:false,error:'属性已发生变化'}:{ok:true,data:'done'};}}};
 try {
  const client=inspectorClient('hierarchy');
  assert.equal(await client.view(true),'done');assert.deepEqual(calls.at(-1),['cocos-git-desk','runtime-inspector-view','hierarchy',true]);
  await client.update({fold:'a'});assert.deepEqual(calls.at(-1),['cocos-git-desk','runtime-inspector-update',{fold:'a'}]);
  await client.hover('frame','node','session');assert.deepEqual(calls.at(-1),['cocos-git-desk','runtime-inspector-call','frame','hover',['node','session']]);
  await client.read('node','c','field');assert.deepEqual(calls.at(-1),['cocos-git-desk','runtime-inspector-read','node','c','field']);
  await client.navigate('asset','prefab','file-id');assert.deepEqual(calls.at(-1),['cocos-git-desk','runtime-inspector-asset','asset','prefab','file-id']);
  await client.state();assert.deepEqual(calls.at(-1),['cocos-git-desk','runtime-inspector-state']);
  await assert.rejects(client.action('edit',[]),/属性已发生变化/);
 } finally {delete global.Editor;}
});
test('mounting subscribes to hub broadcasts, honours document visibility and unsubscribes on dispose',async()=>{
 const inspector=require('../dist/runtime-inspector-panel');
 const listeners=new Map(),calls=[];
 global.Editor={Message:{request:async(...values)=>{calls.push(values);return {ok:true,data:values[1]==='runtime-inspector-state'?{serial:1,closed:false,frame:'',options:{contains:'',offset:0,all:false,collapsed:[],components:[]},snapshot:null,message:'来自状态',capture:null,capturePending:false}:true};},addBroadcastListener:(name,fn)=>listeners.set(name,fn),removeBroadcastListener:name=>listeners.delete(name)}};
 try {
  const document=Object.assign(new EventTarget(),{hidden:false});
  const message={textContent:''};const root=Object.assign(new EventTarget(),{ownerDocument:document,querySelector:selector=>selector==='.inspector-message'?message:null});
  const mount=inspector.mountInspector(root,{viewer:'properties'});
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  const {reportRequestBroadcast}=require('../dist/runtime-inspector-hub');
  assert.ok(listeners.has(stateBroadcast));assert.ok(listeners.has(reportRequestBroadcast));assert.equal(listeners.size,2,'state broadcast plus the self-check report request');
  listeners.get(reportRequestBroadcast)(123);await new Promise(resolve=>setImmediate(resolve));
  const report=calls.find(c=>c[1]==='runtime-inspector-report');assert.ok(report,'a report request is answered through runtime-inspector-report');assert.equal(report[2],'properties');assert.equal(report[3].kind,'report');assert.equal(report[3].requestId,123);assert.equal(report[3].visible,true);
  assert.deepEqual(calls[0],['cocos-git-desk','runtime-inspector-view','properties',true]);assert.equal(message.textContent,'来自状态');
  listeners.get(stateBroadcast)({serial:2,closed:false,frame:'',options:{contains:'',offset:0,all:false,collapsed:[],components:[]},snapshot:null,message:'广播',capture:null,capturePending:false});
  assert.equal(message.textContent,'广播');
  document.hidden=true;document.dispatchEvent(new Event('visibilitychange'));await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls.at(-1),['cocos-git-desk','runtime-inspector-view','properties',false]);
  mount.dispose();assert.equal(listeners.size,0);
 } finally {delete global.Editor;}
});
test('arguments remain data rather than executable code in the hub call expression',()=>{
 const {InspectorFrames}=require('../browser-debug/inspector-frames.cjs');
 const payload='\");globalThis.pwned=true;//';let value;
 const context=vm.createContext({window:{__GIT_DESK_INSPECTOR__:{select:(...args)=>{value=args;return true;}}}});
 const item={processId:1,routingId:1,url:'http://localhost/',executeJavaScript:code=>Promise.resolve(vm.runInContext(code,context))};
 const api=new InspectorFrames({isDestroyed:()=>false,mainFrame:{framesInSubtree:[item]}});
 return api.call('1:1','select',[payload,'session']).then(()=>{assert.equal(value[0],payload);assert.equal(context.pwned,undefined);api.close();});
});
