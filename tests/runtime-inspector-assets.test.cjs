const test=require('node:test'),assert=require('node:assert/strict');
const {assetUuid,locateRuntimeAsset}=require('../dist/runtime-inspector-assets');
const uuid='fc991dd7-0033-4b80-9d41-c8a86a702e59';
test('normalizes compressed Cocos script IDs and preserves subasset IDs',()=>{
 assert.equal(assetUuid('fcmR3XADNLgJ1ByKhqcC5Z'),uuid);
 assert.equal(assetUuid('fcmR3XADNLgJ1ByKhqcC5Z@f9941'),uuid+'@f9941');
 for(const value of ['cc.Button','../../x','javascript:alert(1)',uuid+'@../x'])assert.throws(()=>assetUuid(value));
});
test('locates only validated project assets and opens only scripts',async()=>{
 const calls=[];let info={uuid,url:'db://assets/Test.ts',invalid:false};
 const request=async(...args)=>{calls.push(args);return args[1]==='query-asset-info'?info:undefined;};
 assert.match(await locateRuntimeAsset(uuid,'reveal',request,id=>calls.push(['select',id])),/^已定位/);
 assert.deepEqual(calls.at(-1),['select',uuid]);
 info={uuid:uuid+'@f9941',url:'db://assets/bg.png/spriteFrame',invalid:false};await locateRuntimeAsset(uuid+'@f9941','reveal',request,id=>calls.push(['select',id]));
 assert.deepEqual(calls.at(-1),['select',uuid],'a sub-asset reveals its owning file');assert.deepEqual(calls.at(-2).slice(0,3),['assets','twinkle',uuid]);
 info={uuid,url:'db://internal/default-materials/ui-sprite.mtl',invalid:false};assert.match(await locateRuntimeAsset(uuid,'reveal',request,()=>{}),/已定位：db:\/\/internal/);
 info={uuid,url:'db://assets/Test.ts',invalid:false};
 await locateRuntimeAsset(uuid,'open',request,()=>{});assert.equal(calls.at(-1)[1],'open-asset');
 const confirming=async(...args)=>{calls.push(args);return args[1]==='query-asset-info'?info:true;};
 await locateRuntimeAsset(uuid,'open',confirming,()=>{});assert.equal(calls.at(-1)[1],'open-asset','a non-undefined open-asset reply is still success');
 info.url='db://assets/prefab.prefab';await assert.rejects(()=>locateRuntimeAsset(uuid,'open',request,()=>{}),/只有源脚本/);
 info.url='db://other/x';await assert.rejects(()=>locateRuntimeAsset(uuid,'reveal',request,()=>{}),/没有这个源资源/);
 info=null;await assert.rejects(()=>locateRuntimeAsset(uuid,'reveal',request,()=>{}));
});
test('opens prefab once, waits for the editor root, then selects the source file ID',async()=>{
 const calls=[];let queries=0;
 const request=async(...args)=>{calls.push(args);if(args[1]==='query-asset-info')return {uuid,url:'db://assets/Test.prefab'};if(args[1]==='open-asset')return true;
 if(args[1]==='execute-scene-script')return ++queries===1?{state:'pending'}:{state:'found',uuid:'editor-node'};};
 const selected=[],assets=[];const result=await locateRuntimeAsset(uuid,'prefab',request,id=>assets.push(id),'source-id',id=>{selected.push(id);return true;});
 assert.match(result,/已打开 Prefab 并选中源节点/);assert.deepEqual(selected,['editor-node']);assert.equal(calls.filter(c=>c[1]==='open-asset').length,1);
 assert.deepEqual(assets,[uuid],'the prefab file is selected in the assets panel');assert.ok(calls.findIndex(c=>c[1]==='twinkle')<calls.findIndex(c=>c[1]==='open-asset'),'assets reveal happens before the editor switch');
 queries=0;assert.match(await locateRuntimeAsset(uuid,'prefab',request,()=>{},'source-id',()=>false),/未回报选中状态/);
 assert.deepEqual(calls.at(-1)[2],{name:'cocos-git-desk',method:'selectPrefabNode',args:[uuid,'source-id']});
});
test('missing prefab source IDs fail before navigation; deleted nodes report failure',async()=>{
 const calls=[];const request=async(...args)=>{calls.push(args);if(args[1]==='query-asset-info')return {uuid,url:'db://assets/Test.prefab'};
 if(args[1]==='execute-scene-script')return {state:'missing'};};
 await assert.rejects(()=>locateRuntimeAsset(uuid,'prefab',request,()=>{},''),/源节点标识/);
 assert.equal(calls.some(c=>c[1]==='open-asset'),false);
 await assert.rejects(()=>locateRuntimeAsset(uuid,'prefab',request,()=>{},'deleted'),/源节点已删除/);
});
test('scene navigation is no longer an action',async()=>{
 await assert.rejects(()=>locateRuntimeAsset(uuid,'scene',async()=>({uuid,url:'db://assets/main.scene'}),()=>{},'node-id',()=>true),/不支持的资源操作/);
});
test('a twinkle the assets panel never answers does not block the reveal',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const calls=[];
 const request=(...args)=>{calls.push(args);if(args[1]==='query-asset-info')return Promise.resolve({uuid,url:'db://assets/bg.png',invalid:false});return new Promise(()=>{});};
 const pending=locateRuntimeAsset(uuid,'reveal',request,id=>calls.push(['select',id]));
 await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(3000);
 assert.match(await pending,/未回应闪烁请求/);assert.deepEqual(calls.at(-1),['select',uuid]);
});
test('class names resolve to the single matching script file; ambiguity and misses are reported',async()=>{
 const calls=[];let scripts=[{uuid,url:'db://assets/script/LoginView.ts'}];
 const request=async(...args)=>{calls.push(args);if(args[1]==='query-assets')return args[2].pattern.endsWith('.ts')?scripts:[];if(args[1]==='query-asset-info')return {uuid,url:'db://assets/script/LoginView.ts',invalid:false};return undefined;};
 assert.match(await locateRuntimeAsset('LoginView','open',request,()=>{}),/已请求打开组件脚本/);
 assert.deepEqual(calls[0].slice(0,3),['asset-db','query-assets',{pattern:'db://assets/**/LoginView.ts'}]);assert.equal(calls.filter(c=>c[1]==='open-asset').length,1);
 scripts=[];await assert.rejects(()=>locateRuntimeAsset('LoginView','open',request,()=>{}),/没有找到脚本 LoginView/);
 scripts=[{uuid,url:'db://assets/a/LoginView.ts'},{uuid:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',url:'db://assets/b/LoginView.ts'}];await assert.rejects(()=>locateRuntimeAsset('LoginView','open',request,()=>{}),/多个同名脚本.*db:\/\/assets\/b/);
 await assert.rejects(()=>locateRuntimeAsset('../x','open',request,()=>{}),/UUID/);assert.equal(calls.filter(c=>c[1]==='query-assets'&&c[2].pattern.includes('..')).length,0,'path-like names never reach the asset query');
});
