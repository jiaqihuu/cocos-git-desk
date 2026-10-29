const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {InspectorFrames}=require('../inspector-frames.cjs');
function frame(id,url){const calls=[];const context=vm.createContext({window:{__GIT_DESK_INSPECTOR__:{snapshot:()=>({id}),close:()=>calls.push('close'),select:(...args)=>args}}});return {processId:1,routingId:id,url,name:'frame'+id,calls,executeJavaScript:code=>Promise.resolve(vm.runInContext(code,context))};}
test('routes cross-origin frames only within the owned preview and closes previous target',async()=>{
 const first=frame(1,'http://localhost:7456/'),second=frame(2,'https://another.example/game?token=hidden');const guest={isDestroyed:()=>false,mainFrame:{framesInSubtree:[first,second]}};const api=new InspectorFrames(guest);
 assert.equal(api.list()[1].url,'https://another.example/game');assert.equal((await api.call('1:1','snapshot',[])).id,1);assert.equal((await api.call('1:2','snapshot',[])).id,2);assert.equal(first.calls[0],'close');
 const value='\");globalThis.hacked=true;//';const result=await api.call('1:2','select',[value]);assert.equal(result[0],value);
 await assert.rejects(api.call('9:9','snapshot',[]),error=>/removed/.test(error.message)&&error.code==='FRAME_REMOVED');await assert.rejects(api.call('1:2','evaluate',[]),/Invalid/);api.close();
});
test('close during bootstrap rejects late results and cleans up the old frame',async()=>{
 const item=frame(1,'http://localhost/');let resolve;let count=0;const original=item.executeJavaScript;item.executeJavaScript=code=>++count===1?new Promise(done=>resolve=done):original(code);
 const api=new InspectorFrames({isDestroyed:()=>false,mainFrame:{framesInSubtree:[item]}});const pending=api.call('1:1','snapshot',[]);await new Promise(done=>setImmediate(done));api.close();resolve({ok:true});await assert.rejects(pending,/closed/);assert.ok(item.calls.includes('close'));
});
test('bootstrap imports the full cc namespace even when the legacy global already has a director',async()=>{
 let imports=0;const payloads=[];
 const cc={VERSION:'3.8.8',director:{getScene:()=>null},UITransform:class{},Vec2:class{},Vec3:class{}};
 const context=vm.createContext({window:{cc:{VERSION:'3.8.8',director:cc.director},System:{import:async name=>{assert.equal(name,'cc');imports++;return cc;}},addEventListener(){}},document:{},crypto:{randomUUID:()=> 'current-session'}});
 const item={processId:1,routingId:1,url:'http://localhost/',executeJavaScript:code=>{payloads.push(code.length);return Promise.resolve(vm.runInContext(code,context));}};
 const api=new InspectorFrames({isDestroyed:()=>false,mainFrame:{framesInSubtree:[item]}});
 await api.call('1:1','renderSnapshot',[]);assert.equal(imports,1);assert.ok(context.window.__GIT_DESK_INSPECTOR__);
 payloads.length=0;await api.call('1:1','renderSnapshot',[]);assert.equal(imports,1);assert.ok(payloads.every(size=>size<1000),'steady polling must not resend runtime factories');
 delete context.window.__GIT_DESK_INSPECTOR__;await api.call('1:1','renderSnapshot',[]);assert.equal(imports,2,'reload on the same frame must bootstrap again');
});
test('a ready frame costs one evaluation per call and arguments still arrive intact',async()=>{
 let evaluations=0;const context=vm.createContext({window:{__GIT_DESK_INSPECTOR__:{snapshot:(options)=>({echo:options}),close(){}}}});
 const item={processId:1,routingId:1,url:'http://localhost/',executeJavaScript:code=>{evaluations++;return Promise.resolve(vm.runInContext(code,context));}};
 const api=new InspectorFrames({isDestroyed:()=>false,mainFrame:{framesInSubtree:[item]}});
 const result=await api.call('1:1','snapshot',[{digest:'a:1',contains:'"quoted"'}]);
 assert.equal(JSON.stringify(result),JSON.stringify({echo:{digest:'a:1',contains:'"quoted"'}}));assert.equal(evaluations,1);
 await api.call('1:1','snapshot',[{}]);assert.equal(evaluations,2);api.close();
});
test('incomplete engine exports report an initialization error rather than silently losing highlighting',async()=>{
 const context=vm.createContext({window:{cc:{VERSION:'3.8.8',director:{}}}});
 const item={processId:1,routingId:1,url:'http://localhost/',executeJavaScript:code=>Promise.resolve(vm.runInContext(code,context))};
 const api=new InspectorFrames({isDestroyed:()=>false,mainFrame:{framesInSubtree:[item]}});
 await assert.rejects(api.call('1:1','renderSnapshot',[]),error=>/incomplete/.test(error.message)&&error.code==='ENGINE_NOT_LOADED','still loading, not a real failure');
 assert.equal(context.window.__GIT_DESK_INSPECTOR__,undefined);
});
test('runtime validation errors are caught inside the frame instead of escaping into the game error handler',async()=>{
 const context=vm.createContext({window:{__GIT_DESK_INSPECTOR__:{edit(){throw Error('属性已发生变化');},close(){}}}});
 let escaped=0;
 const item={processId:1,routingId:1,url:'http://localhost/',executeJavaScript:async code=>{
  try{return await vm.runInContext(code,context);}catch(error){escaped++;throw error;}
 }};
 const api=new InspectorFrames({isDestroyed:()=>false,mainFrame:{framesInSubtree:[item]}});
 await assert.rejects(api.call('1:1','edit',[{},'session']),/属性已发生变化/);assert.equal(escaped,0);api.close();
});
test('the engine check follows the configured versions: 3.8.x by default, other patterns on request',async()=>{
 const {matchesEngineVersion}=require('../../dist/config');
 const run=async(version,options)=>{
  const cc={VERSION:version,director:{getScene:()=>null},UITransform:class{},Vec2:class{},Vec3:class{}};
  const context=vm.createContext({window:{cc,addEventListener(){}},document:{},crypto:{randomUUID:()=> 'session'}});
  const item={processId:1,routingId:1,url:'http://localhost/',executeJavaScript:code=>Promise.resolve(vm.runInContext(code,context))};
  const api=new InspectorFrames({isDestroyed:()=>false,mainFrame:{framesInSubtree:[item]}},options);
  try { await api.call('1:1','renderSnapshot',[]); return !!context.window.__GIT_DESK_INSPECTOR__; } finally { api.close(); }
 };
 assert.equal(await run('3.8.6'),true);assert.equal(await run('3.8.8'),true);
 await assert.rejects(run('3.7.4'),/supports Cocos Creator 3\.8\.x; detected 3\.7\.4/);
 assert.equal(await run('3.7.4',{engineVersions:['3.7.x','3.8.x']}),true);
 await assert.rejects(run('3.8.6',{engineVersions:['3.8.8']}),/detected 3\.8\.6/);
 for(const [version,patterns,expected] of [['3.8.6',['3.8.x'],true],['3.8.6',['3.x'],true],['3.8.6',['3.8.8'],false],['3.8',['3.8.x'],false],['3.7.4',['3.8.x','3.7.4'],true]])assert.equal(matchesEngineVersion(version,patterns),expected,version+' '+patterns);
});
test('a frame without a loaded engine is a loading-phase failure; a version mismatch is not',async()=>{
 const make=window=>{const context=vm.createContext({window});return {processId:1,routingId:1,url:'http://localhost/',executeJavaScript:code=>Promise.resolve(vm.runInContext(code,context))};};
 const empty=new InspectorFrames({isDestroyed:()=>false,mainFrame:{framesInSubtree:[make({})]}});
 await assert.rejects(empty.call('1:1','snapshot',[]),error=>/no loaded Cocos engine/.test(error.message)&&error.code==='ENGINE_NOT_LOADED');
 const old=new InspectorFrames({isDestroyed:()=>false,mainFrame:{framesInSubtree:[make({cc:{VERSION:'3.7.4',director:{},UITransform:{},Vec2:{},Vec3:{}}})]}});
 await assert.rejects(old.call('1:1','snapshot',[]),error=>/3\.7\.4/.test(error.message)&&error.code===undefined);
});
test('a preview page on a LAN address (no secure context, no crypto.randomUUID) still bootstraps the inspector',async()=>{
 const cc={VERSION:'3.8.8',director:{getScene:()=>null},UITransform:class{},Vec2:class{},Vec3:class{}};
 const webcrypto=require('node:crypto').webcrypto;
 const context=vm.createContext({window:{System:{import:async()=>cc},addEventListener(){}},document:{},crypto:{getRandomValues:array=>webcrypto.getRandomValues(array)}});
 const item={processId:1,routingId:1,url:'http://192.168.31.17:7456/',executeJavaScript:code=>Promise.resolve(vm.runInContext(code,context))};
 const api=new InspectorFrames({isDestroyed:()=>false,mainFrame:{framesInSubtree:[item]}});
 await api.call('1:1','renderSnapshot',[]);assert.ok(context.window.__GIT_DESK_INSPECTOR__,'bootstrapped without crypto.randomUUID');
});
