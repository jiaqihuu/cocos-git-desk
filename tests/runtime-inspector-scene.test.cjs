const test=require('node:test'),assert=require('node:assert/strict');
const {findPrefabNode}=require('../dist/runtime-inspector-scene');
const uuid='fc991dd7-0033-4b80-9d41-c8a86a702e59';
const node=(id,fileId,asset=uuid,children=[])=>({uuid:id,name:'same-name',prefab:{asset:{uuid:asset},fileId},children});
test('maps the source file ID instead of names or runtime UUIDs',()=>{
 const root=node('editor-root','root',uuid,[node('editor-a','a'),node('editor-b','b')]);
 assert.deepEqual(findPrefabNode(root,uuid,'b'),{state:'found',uuid:'editor-b'});
 assert.deepEqual(findPrefabNode(root,uuid,'removed'),{state:'missing'});
});
test('does not select an instance in the original scene while the prefab editor is opening',()=>{
 const scene={uuid:'scene',children:[node('instance','target')]};
 assert.deepEqual(findPrefabNode(scene,uuid,'target'),{state:'pending'});
 assert.deepEqual(findPrefabNode(null,uuid,'target'),{state:'pending'});
});
test('nested prefab IDs and duplicate node names cannot select a different source',()=>{
 const other='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
 const root=node('root','root',uuid,[node('wrong','target',other),node('correct','target')]);
 assert.equal(findPrefabNode(root,uuid,'target').uuid,'correct');
 root.children.push(node('ambiguous','target'));
 assert.throws(()=>findPrefabNode(root,uuid,'target'),/不唯一/);
 assert.throws(()=>findPrefabNode(root,uuid,''),/源节点标识/);
});
test('scene script is registered and only reports the match; selection belongs to the main process',()=>{
 const {methods}=require('../dist/runtime-inspector-scene');const calls=[];
 global.cce={Scene:{rootNode:node('root','root',uuid,[node('editor-node','child')])}};
 global.Editor={Selection:{update:(type,ids)=>calls.push([type,ids]),getSelected:()=>['editor-node']}};
 try {assert.deepEqual(methods.selectPrefabNode(uuid,'child'),{state:'found',uuid:'editor-node'});assert.deepEqual(calls,[]);
 assert.equal(require('../package.json').contributions.scene.script,'./dist/runtime-inspector-scene.js');}
 finally{delete global.cce;delete global.Editor;}
});
