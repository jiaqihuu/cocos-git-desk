const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {SceneTools,sceneToolNames}=require('../dist/scene-tools');
const {CreatorTools}=require('../dist/creator-tools');
const tools=require('../dist/config').toolCatalogue();
const sceneId='44444444-4444-4444-4444-444444444444',prefabId='11111111-1111-1111-1111-111111111111',root='aaaa',child='bbbb';
function dump(value,type,extra={}){return {value,type,...extra};}
function fixture(over={}){
 const calls=[];let dirty=over.dirty??false,current=over.current??sceneId;
 const byUuid={[sceneId]:{uuid:sceneId,url:'db://assets/main.scene'},[prefabId]:{uuid:prefabId,url:'db://assets/hall/HallView.prefab'},'55555555-5555-5555-5555-555555555555':{uuid:'55555555-5555-5555-5555-555555555555',url:'db://assets/a.png'}};
 const tree={uuid:root,name:'Canvas',active:true,type:'cc.Node',children:[{uuid:child,name:'Label',active:false,type:'cc.Node',prefab:{uuid:'p'},children:[{uuid:'cccc',name:'Deep',children:[]}]},{uuid:'dddd',name:'Bg',prefab:{state:0,assetUuid:''},children:[]}]};
 const node={name:dump('Label','String'),active:dump(false,'Boolean'),position:dump({x:1,y:2,z:0},'cc.Vec3'),parent:dump({uuid:root},'cc.Node'),children:[],
  __prefab__:{uuid:'p',fileId:'f'},__comps__:[{type:'cc.Label',value:{uuid:dump('comp-1','String'),enabled:dump(true,'Boolean'),string:dump('x'.repeat(600),'String'),color:dump({r:1,g:2,b:3,a:255},'cc.Color'),font:dump({uuid:'55555555-5555-5555-5555-555555555555'},'cc.Font',{readonly:false}),nested:{deep:{deeper:{deepest:{too:1}}}}}}]};
 const host={request:async(channel,message,...args)=>{calls.push([channel,message,...args]);
   if(over.fail===message)throw Error('scene refused '+message);
   if(channel==='scene'&&message==='query-current-scene')return current;
   if(channel==='scene'&&message==='query-dirty')return dirty;
   if(channel==='scene'&&message==='query-node-tree')return args[0]?tree.children[0]:tree;
   if(channel==='scene'&&message==='query-node')return args[0]===child?node:null;
   if(channel==='scene'&&message==='snapshot')return true;
   if(channel==='scene'&&message==='create-node'){dirty=true;return over.createArray?['new-1']:'new-1';}
   if(channel==='scene'&&['remove-node','create-component','remove-component','set-property'].includes(message)){dirty=true;return message==='set-property'?true:undefined;}
   if(channel==='scene'&&message==='save-scene'){if(!over.cancelSave)dirty=false;return true;}
   if(channel==='scene'&&message==='open-scene'){if(!over.refuseOpen)current=args[0];return true;}
   if(channel==='asset-db'&&message==='query-asset-info')return byUuid[args[0]]||null;
   if(channel==='asset-db'&&message==='query-uuid')return Object.values(byUuid).find(a=>a.url===args[0])?.uuid??null;
   throw Error('unexpected '+channel+' '+message);},
  assertIdle:()=>{if(over.running)throw Error('Git 操作正在执行');},
  taskPaths:async id=>id==='task-1'?['assets/main.scene','assets/main.scene.meta']:id==='task-2'?['assets/other.scene']:null};
 return {tools:new SceneTools(host,tools),calls};
}
test('the catalog carries every scene tool and CreatorTools delegates them',async()=>{
 for(const name of sceneToolNames)assert.ok(tools.some(t=>t.name===name),name+' is in the catalog');
 const creator=new CreatorTools({request:async(c,m)=>{if(m==='query-node-tree')return {uuid:'r',name:'Canvas',children:[]};if(m==='query-current-scene')return '';throw Error(m);},assertIdle:()=>{},taskPaths:async()=>null},tools);
 const out=await creator.call('creator_scene_tree',{});assert.equal(out.nodes[0].name,'Canvas');assert.equal(out.scene,null);
});
test('scene tree flattens with paths, depth and limit and reports truncation',async()=>{
 const f=fixture();
 const all=await f.tools.call('creator_scene_tree',{});
 assert.deepEqual(all.nodes.map(n=>n.path),['Canvas','Canvas/Label','Canvas/Label/Deep','Canvas/Bg']);assert.equal(all.nodes[1].active,false);assert.equal(all.nodes[1].prefab,true);assert.equal(all.nodes[1].prefabAsset,'p');assert.equal(all.nodes[3].prefab,false,'an empty prefab block is not an instance');assert.equal(all.nodes[0].prefab,false);assert.equal(all.nodes[0].childCount,2);assert.equal(all.truncated,false);assert.equal(all.scene.url,'db://assets/main.scene');
 const shallow=await f.tools.call('creator_scene_tree',{depth:1});assert.equal(shallow.nodes.length,3);assert.equal(shallow.truncated,true);
 const limited=await f.tools.call('creator_scene_tree',{limit:2});assert.equal(limited.nodes.length,2);assert.equal(limited.truncated,true);
 const sub=await f.tools.call('creator_scene_tree',{uuid:child});assert.equal(sub.nodes[0].name,'Label');assert.ok(f.calls.some(c=>c[1]==='query-node-tree'&&c[2]===child));
});
test('node inspect unwraps dumps, trims long values and exposes component property paths',async()=>{
 const f=fixture();
 const out=await f.tools.call('creator_node_inspect',{uuid:child});
 assert.equal(out.node.name,'Label');assert.equal(out.node.active,false);assert.deepEqual(out.node.position,{x:1,y:2,z:0});assert.equal(out.node.parent,undefined);assert.deepEqual(out.prefab,{uuid:'p',fileId:'f'});
 assert.equal(out.components.length,1);const comp=out.components[0];assert.equal(comp.type,'cc.Label');assert.equal(comp.uuid,'comp-1');assert.equal(comp.enabled,true);assert.equal(comp.pathPrefix,'__comps__.0.');
 assert.equal(comp.properties.string.length,501);assert.deepEqual(comp.properties.font,{uuid:'55555555-5555-5555-5555-555555555555'});assert.equal(comp.properties.nested.deep.deeper.deepest,'[对象]');
 await assert.rejects(f.tools.call('creator_node_inspect',{uuid:'nope'}),/节点不存在/);
});
test('writes need a task that contains the open scene, take a snapshot first and never save by themselves',async()=>{
 const f=fixture();
 await assert.rejects(f.tools.call('creator_node_create',{parent:root,name:'X'}),/taskId/);
 await assert.rejects(f.tools.call('creator_node_create',{parent:root,name:'X',taskId:'task-9'}),/任务不存在/);
 await assert.rejects(f.tools.call('creator_node_create',{parent:root,name:'X',taskId:'task-2'}),/不在任务范围内/);
 const created=await f.tools.call('creator_node_create',{parent:root,name:'X',taskId:'task-1'});
 assert.equal(created.created,'new-1');assert.equal(created.dirty,true);assert.match(created.note,/creator_scene_save/);
 const order=f.calls.filter(c=>c[0]==='scene').map(c=>c[1]);assert.deepEqual(order.slice(-3),['snapshot','create-node','query-dirty']);assert.deepEqual(f.calls.find(c=>c[1]==='create-node')[2],{parent:root,name:'X'});
 assert.ok(!f.calls.some(c=>c[1]==='save-scene'));
 const set=await f.tools.call('creator_property_set',{uuid:child,path:'__comps__.0.string',value:'hi',type:'String',taskId:'task-1'});
 assert.deepEqual(f.calls.find(c=>c[1]==='set-property')[2],{uuid:child,path:'__comps__.0.string',dump:{value:'hi',type:'String'}});assert.equal(set.result,true);
 await f.tools.call('creator_component_add',{uuid:child,component:'cc.Sprite',taskId:'task-1'});assert.deepEqual(f.calls.find(c=>c[1]==='create-component')[2],{uuid:child,component:'cc.Sprite'});
 await f.tools.call('creator_component_remove',{uuid:child,component:'comp-1',taskId:'task-1'});assert.deepEqual(f.calls.find(c=>c[1]==='remove-component')[2],{uuid:child,component:'comp-1'});
 const removed=await f.tools.call('creator_node_remove',{uuid:'dddd',taskId:'task-1'});assert.equal(removed.removed,'dddd');assert.equal(removed.result,null);
 const busy=fixture({running:true});await assert.rejects(busy.tools.call('creator_node_remove',{uuid:'dddd',taskId:'task-1'}),/Git 操作正在执行/);
 const noScene=fixture({current:''});await assert.rejects(noScene.tools.call('creator_node_remove',{uuid:'dddd',taskId:'task-1'}),/没有打开的场景/);
});
test('prefab instantiation resolves the prefab by url or uuid and refuses other assets',async()=>{
 const f=fixture({createArray:true});
 const out=await f.tools.call('creator_prefab_instantiate',{parent:root,prefab:'db://assets/hall/HallView.prefab',name:'Hall',taskId:'task-1'});
 assert.equal(out.created,'new-1');assert.equal(out.prefab,'db://assets/hall/HallView.prefab');assert.deepEqual(f.calls.find(c=>c[1]==='create-node')[2],{parent:root,assetUuid:prefabId,name:'Hall'});
 await f.tools.call('creator_prefab_instantiate',{parent:root,prefab:prefabId,taskId:'task-1'});
 await assert.rejects(f.tools.call('creator_prefab_instantiate',{parent:root,prefab:'55555555-5555-5555-5555-555555555555',taskId:'task-1'}),/不是 Prefab/);
 await assert.rejects(f.tools.call('creator_prefab_instantiate',{parent:root,prefab:'db://assets/missing.prefab',taskId:'task-1'}),/找不到 Prefab/);
});
test('save reports clean scenes, cancelled saves and the meta reminder',async()=>{
 const clean=fixture();assert.equal((await clean.tools.call('creator_scene_save',{taskId:'task-1'})).saved,false);assert.ok(!clean.calls.some(c=>c[1]==='save-scene'));
 const f=fixture({dirty:true});const out=await f.tools.call('creator_scene_save',{taskId:'task-1'});assert.equal(out.saved,true);assert.match(out.note,/\.meta/);
 const cancelled=fixture({dirty:true,cancelSave:true});await assert.rejects(cancelled.tools.call('creator_scene_save',{taskId:'task-1'}),/未完成保存/);
 await assert.rejects(fixture({dirty:true}).tools.call('creator_scene_save',{taskId:'task-2'}),/不在任务范围内/);
});
test('open switches to scenes or prefabs and reports when Creator kept the current one',async()=>{
 const f=fixture();
 const out=await f.tools.call('creator_scene_open',{url:'db://assets/hall/HallView.prefab'});assert.equal(out.opened,true);assert.equal(out.url,'db://assets/hall/HallView.prefab');assert.ok(f.calls.some(c=>c[1]==='open-scene'&&c[2]===prefabId));
 await assert.rejects(f.tools.call('creator_scene_open',{uuid:'55555555-5555-5555-5555-555555555555'}),/只能打开场景或 Prefab/);
 await assert.rejects(f.tools.call('creator_scene_open',{url:'db://assets/none.scene'}),/找不到资源/);
 const kept=fixture({refuseOpen:true});const stay=await kept.tools.call('creator_scene_open',{uuid:prefabId});assert.equal(stay.opened,false);assert.equal(stay.current,sceneId);assert.match(stay.note,/未保存/);
 const busy=fixture({running:true});await assert.rejects(busy.tools.call('creator_scene_open',{uuid:prefabId}),/Git 操作正在执行/);
});
