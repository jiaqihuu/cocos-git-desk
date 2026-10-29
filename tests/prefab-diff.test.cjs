const test=require('node:test'),assert=require('node:assert/strict');
const {parseSerialized,diffSerialized,decompressUuid,collectReferences}=require('../dist/prefab-diff');
const {compressUuid}=require('../dist/creator-tools');
const node=(name,parent,children,components,prefab,extra={})=>({__type__:'cc.Node',_name:name,_parent:parent,_children:children,_components:components,_prefab:prefab,_id:'',_active:true,...extra});
const info=(root,fileId,asset='pf-1')=>({__type__:'cc.PrefabInfo',root:{__id__:root},asset:{__uuid__:asset},fileId});
function left(){return [
 {__type__:'cc.Prefab',data:{__id__:1}},
 node('Root',null,[{__id__:2},{__id__:4}],[{__id__:6}],{__id__:7},{_lpos:{__type__:'cc.Vec3',x:0,y:0,z:0}}),
 node('Title',{__id__:1},[],[{__id__:3}],{__id__:8},{_lpos:{__type__:'cc.Vec3',x:10,y:20,z:0}}),
 {__type__:'cc.Label',node:{__id__:2},_string:'Hello',_fontSize:32,_color:{__type__:'cc.Color',r:255,g:255,b:255,a:255}},
 node('Icon',{__id__:1},[],[{__id__:5}],{__id__:9}),
 {__type__:'cc.Sprite',node:{__id__:4},_spriteFrame:{__uuid__:'aaaa',__expectedType__:'cc.SpriteFrame'}},
 {__type__:'6a3b2cRsAt1Yk3f8sdf9sK',node:{__id__:1},target:{__id__:2},speed:1},
 info(1,'rootfile'),info(2,'titlefile'),info(4,'iconfile')];}
function withoutIcon(){return [
 {__type__:'cc.Prefab',data:{__id__:1}},
 node('Root',null,[{__id__:2}],[{__id__:4}],{__id__:5},{_lpos:{__type__:'cc.Vec3',x:0,y:0,z:0}}),
 node('Title',{__id__:1},[],[{__id__:3}],{__id__:6},{_lpos:{__type__:'cc.Vec3',x:10,y:20,z:0}}),
 {__type__:'cc.Label',node:{__id__:2},_string:'Hello',_fontSize:32,_color:{__type__:'cc.Color',r:255,g:255,b:255,a:255}},
 {__type__:'6a3b2cRsAt1Yk3f8sdf9sK',node:{__id__:1},target:{__id__:2},speed:1},
 info(1,'rootfile'),info(2,'titlefile')];}
function right(){const r=left();
 r[1]._children=[{__id__:2},{__id__:10}];r[1]._active=false;
 r[2]._name='Header';r[2]._children=[{__id__:4}];
 r[3]._string='Hi';
 r[4]._parent={__id__:2};
 r[5]._spriteFrame={__uuid__:'bbbb',__expectedType__:'cc.SpriteFrame'};
 r[6].target={__id__:4};
 r.push(node('Extra',{__id__:1},[],[{__id__:11}],{__id__:12}),{__type__:'cc.UITransform',node:{__id__:10},_contentSize:{__type__:'cc.Size',width:100,height:50}},info(10,'extrafile'));
 return r;}
test('nodes are paired by path then by stable id, so renames and moves are not reported as remove plus add',()=>{
 const diff=diffSerialized(left(),right(),{labelType:type=>type.startsWith('cc.')?undefined:'Mover',labelAsset:uuid=>({aaaa:'icon_old.png',bbbb:'icon_new.png'})[uuid]});
 assert.deepEqual(diff.nodes,[{kind:'renamed',path:'Root/Header',from:'Root/Title'},{kind:'moved',path:'Root/Header/Icon',from:'Root/Icon'},{kind:'added',path:'Root/Extra'}]);
 assert.deepEqual(diff.components,[{kind:'added',node:'Root/Extra',type:'cc.UITransform'}]);
 const props=diff.properties.map(p=>[p.node,p.component??'',p.property,p.before,p.after]);
 assert.deepEqual(props,[
  ['Root','','_active',true,false],
  ['Root','Mover','target','node:Root/Title','node:Root/Header/Icon'],
  ['Root/Header','','_name','Title','Header'],
  ['Root/Header','cc.Label','_string','Hello','Hi'],
  ['Root/Header/Icon','cc.Sprite','_spriteFrame','asset:icon_old.png','asset:icon_new.png'],
 ]);
 assert.deepEqual(diff.assets.map(a=>[a.uuid,a.label??null,a.before,a.after]),[['aaaa','icon_old.png',1,0],['bbbb','icon_new.png',0,1],['pf-1',null,3,4]]);
 assert.equal(diff.left.nodes,3);assert.equal(diff.right.nodes,4);assert.equal(diff.right.components,4);assert.equal(diff.truncated,false);
 assert.equal(diff.summary,'节点 +1 −0 移动 1 改名 1；组件 +1 −0；属性改动 5；资源引用变化 3');
});
test('removed nodes, limits, prefab overrides and parsing errors',()=>{
 const removed=diffSerialized(left(),withoutIcon());
 assert.deepEqual(removed.nodes,[{kind:'removed',path:'Root/Icon'}]);assert.deepEqual(removed.components,[{kind:'removed',node:'Root/Icon',type:'cc.Sprite'}]);
 assert.deepEqual(removed.properties,[]);assert.deepEqual(removed.assets,[{uuid:'aaaa',before:1,after:0},{uuid:'pf-1',before:3,after:2}]);
 const cut=diffSerialized(left(),right(),{limit:2});assert.equal(cut.properties.length,2);assert.equal(cut.truncated,true);assert.match(cut.summary,/属性改动 2\+/);
 // A prefab instance override is reported as one property per target and path.
 const c=left(),d=left();
 for(const side of [c,d]){side[8].instance={__id__:side.length};side.push({__type__:'cc.PrefabInstance',propertyOverrides:[{__id__:side.length+1}],mountedChildren:[]},{__type__:'cc.PropertyOverrideInfo',targetInfo:{__id__:side.length+2},propertyPath:['_string'],value:'A'},{__type__:'cc.TargetInfo',localID:['label1']});}
 d[d.length-2].value='B';
 const override=diffSerialized(c,d);
 assert.deepEqual(override.properties,[{node:'Root/Title',property:'override:label1:_string',before:'A',after:'B'}]);
 assert.throws(()=>parseSerialized('{'),/不是合法的 JSON/);assert.throws(()=>parseSerialized('{"a":1}'),/序列化数组/);
 assert.deepEqual(collectReferences([left(),right()]),{uuids:['aaaa','pf-1','bbbb'],types:['6a3b2cRsAt1Yk3f8sdf9sK']});
});
test('compressed script class ids decompress back to the asset uuid',()=>{
 const uuid='5f2d9c1a-8b3e-4c7d-9a6f-0e1b2c3d4e5f';
 assert.equal(compressUuid(uuid).length,23);assert.equal(compressUuid(uuid,true).length,22);assert.equal(decompressUuid(compressUuid(uuid)),uuid);assert.equal(decompressUuid(compressUuid(uuid,true)),uuid);
 assert.equal(compressUuid(uuid,true),'5f'+Buffer.from('2d9c1a8b3e4c7d9a6f0e1b2c3d4e5f','hex').toString('base64'),'the short form is plain base64 of the remaining bytes');
 assert.equal(decompressUuid('cc.Sprite'),null);assert.equal(decompressUuid('zz'),null);assert.equal(decompressUuid('86cefAWukVE77lEwgfFdYeD'),'86cef016-ba45-44ef-b944-c207c5758783','a real component class id from TournamentDetailsView.prefab (UIButton.ts)');
});
