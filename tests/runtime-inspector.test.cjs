const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const runtimeModule={exports:{}};require('node:vm').runInNewContext(fs.readFileSync(path.resolve(__dirname,'../browser-debug/inspector-runtime.js'),'utf8'),{module:runtimeModule});
const create=runtimeModule.exports;
class Element extends EventTarget {
 constructor(){super();this.style={};this.children=[];this.width=200;this.height=100;}
 setAttribute(){}append(...items){this.children.push(...items);}remove(){this.removed=true;}
 getBoundingClientRect(){return {left:10,top:20,right:110,bottom:70,width:100,height:50};}
}
class Node {constructor(id,parent=null){this.uuid=id;this.name=id;this.parent=parent;this.components=[];this.active=true;this.activeInHierarchy=true;this.layer=1;this.position=new Vec3(0,0,0);this.scale=new Vec3(1,1,1);this.eulerAngles=new Vec3(0,0,0);}getComponent(type){return this.components.find(c=>c instanceof type)||null;}}
class Component {constructor(){this.enabled=true;this.enabledInHierarchy=true;}}
class UIRenderer extends Component {}
class Asset {constructor(uuid,name){this.uuid=uuid;this.name=name;}}
class Vec2 {constructor(x,y){this.x=x;this.y=y;}}
class Vec3 extends Vec2 {constructor(x,y,z){super(x,y);this.z=z;}}
class Canvas extends Component {constructor(){super();this.cameraComponent={visibility:1,worldToScreen:v=>v};}}
class UITransform extends Component {constructor(){super();this.width=100;this.height=50;this.anchorX=0;this.anchorY=0;}hitTest(p){this.lastPoint=p;return this.hit!==false;}convertToWorldSpaceAR(v){return v;}}
function fixture(){
 const window=new EventTarget();window.innerWidth=100;window.innerHeight=80;let tick;window.setInterval=fn=>{tick=fn;return 1;};window.clearInterval=()=>{tick=null;};
 const canvas=new Element(),body=new Element();const document={body,createElement:()=>new Element(),querySelector:()=>canvas};
 const root=new Node('root'),child=new Node('child',root);root.components=[new Canvas()];const transform=new UITransform();child.components=[transform];
 let scans=0;let nodes=[{node:root,depth:0},{node:child,depth:1}],limit=false;
 const camera={visibility:1,worldToScreen(out,world){out.x=world.x;out.y=world.y;out.z=world.z;return out;}};
 const inspector=create({cc:{director:{getScene:()=>({uuid:'scene-source'}),root:{batcher2D:{getFirstRenderCamera:()=>camera}}},Node,Component,Asset,Vec2,Vec3,Canvas,UITransform,UIRenderer,screen:{devicePixelRatio:2},isValid:o=>!o.destroyed,js:{getClassName:o=>o.constructor.name,getClassId:o=>o.script||''}},scan:()=>{scans++;return {nodes:nodes.filter(({node})=>!node.destroyed),scanLimitReached:limit};},safeText:s=>String(s),sessionId:'session',document,window});
 return {scanCount:()=>scans,inspector,root,child,transform,body,window,canvas,camera,setNodes:v=>nodes=v,setLimit:v=>limit=v,tick:()=>tick?.()};
}
test('snapshot, prefab and component references; never invokes custom getters',()=>{
 const f=fixture();let getterCalls=0;const component=new Component();component.node=f.child;component.script='fcmR3XADNLgJ1ByKhqcC5Z';component.sprite=new Asset('image','Image');component.child=f.root;component.token='private';component.value=3;Object.defineProperty(component,'danger',{enumerable:true,get(){getterCalls++;throw Error('side effect');}});f.child.components.push(component);f.child.prefab={asset:new Asset('prefab','Prefab'),fileId:'node-source'};
 f.inspector.snapshot();f.inspector.select('child','session');const data=f.inspector.snapshot();
 assert.equal(data.detail.prefab.uuid,'prefab');assert.equal(data.detail.components[1].script,component.script);
 assert.equal(data.detail.components[1].fields.find(x=>x.name==='sprite').value.kind,'asset');assert.equal(JSON.stringify(data.detail.assets),JSON.stringify([{uuid:'image',name:'Image',type:'Asset'}]),'direct asset references are summarized per node');
 assert.equal(data.detail.components[1].fields.some(x=>x.name==='token'),false);assert.equal(getterCalls,0);
 assert.throws(()=>f.inspector.select('child','old'),/reloaded/);f.child.destroyed=true;assert.equal(f.inspector.snapshot().detail,null);f.inspector.close();
});
test('picker absorbs mouse input, uses physical screen coordinates, supports Escape and cleanup',()=>{
 const f=fixture();f.inspector.snapshot();f.inspector.pick(true,'session');const overlay=f.body.children[0];
 const event=new Event('pointerup',{cancelable:true});Object.assign(event,{clientX:40,clientY:40,button:0});overlay.dispatchEvent(event);
 assert.equal(event.defaultPrevented,true);assert.deepEqual(f.transform.lastPoint,new Vec2(60,60));assert.equal(f.inspector.snapshot().selected,'child');
 const click=new Event('click',{cancelable:true});overlay.dispatchEvent(click);assert.equal(click.defaultPrevented,true);
 const escape=new Event('keydown',{cancelable:true});escape.key='Escape';f.window.dispatchEvent(escape);assert.equal(f.inspector.snapshot().picking,false);
 f.inspector.close();assert.ok(f.body.children.every(e=>e.removed));f.tick();
});
test('pagination and scan gaps are explicit; stale node selection fails',()=>{
 const f=fixture();f.setNodes(Array.from({length:450},(_,i)=>({node:new Node('n'+i),depth:1})));f.setLimit(true);
 const page=f.inspector.snapshot({offset:200});assert.equal(page.nodes.length,200);assert.equal(page.nodes[0].uuid,'n200');assert.equal(page.total,450);assert.equal(page.scanLimitReached,true);
 assert.throws(()=>f.inspector.select('gone','session'),/destroyed/);f.inspector.close();
});
test('runtime edits detect conflicts, undo only unchanged values, and reject stale sessions',()=>{
 const f=fixture();f.inspector.snapshot();f.inspector.select('child','session');
 f.inspector.edit({uuid:'child',field:'active',value:false,expected:true},'session');assert.equal(f.child.active,false);
 f.inspector.undo('session');assert.equal(f.child.active,true);
 assert.throws(()=>f.inspector.edit({uuid:'child',field:'active',value:false,expected:false},'session'),/changed/);
 assert.throws(()=>f.inspector.edit({uuid:'child',field:'name',value:'changed',expected:'child'},'old'),/reloaded/);
 f.inspector.edit({uuid:'child',field:'name',value:'changed',expected:'child'},'session');f.child.name='game changed';assert.throws(()=>f.inspector.undo('session'),/game changed/);
 assert.throws(()=>f.inspector.edit({uuid:'child',field:'__proto__',value:{},expected:{}},'session'),/Unsupported/);f.inspector.close();
});
test('component identity and explicit getters survive inspection without implicit execution',()=>{
 const f=fixture();const component=new Component();component.count=2;component.node=f.child;let reads=0;Object.defineProperty(component,'custom',{enumerable:true,get(){reads++;return 7;},set(v){this.count=v;}});f.child.components.push(component);
 f.inspector.snapshot();f.inspector.select('child','session');const id=f.inspector.snapshot().detail.components[1].id;assert.equal(reads,0);
 assert.equal(f.inspector.read('child',id,'custom','session'),7);assert.equal(reads,1);f.inspector.snapshot();assert.equal(reads,1);
 f.inspector.edit({uuid:'child',id,field:'count',value:5,expected:2},'session');assert.equal(component.count,5);
 f.child.components.splice(1,1);assert.throws(()=>f.inspector.edit({uuid:'child',id,field:'count',value:6,expected:5},'session'),/removed/);f.inspector.close();
});
test('collapsed subtrees, fuzzy search and selected-node reveal retain ancestry',()=>{
 const f=fixture();f.root.children=[f.child];
 assert.equal(f.inspector.snapshot({collapsed:['root']}).nodes.length,1);
 assert.equal(f.inspector.snapshot({contains:'rcld'}).nodes.length,1);
 f.inspector.select('child','session');const state=f.inspector.snapshot({collapsed:['root'],reveal:true});assert.equal(state.nodes.length,2);assert.equal(state.ancestors[0],'root');f.inspector.close();
});
test('destroy is runtime-only, root deletion blocked; console printing keeps selected reference',()=>{
 const f=fixture();f.window.console={log(){}};f.child.destroy=()=>{f.child.destroyed=true;};f.inspector.snapshot();
 assert.throws(()=>f.inspector.destroy('root','session'),/scene root/);
 assert.equal(f.inspector.print('child','','session'),'$gd0');assert.equal(f.window.$gd0,f.child);
 f.inspector.destroy('child','session');assert.equal(f.child.destroyed,true);f.inspector.close();assert.equal(f.window.$gd0,undefined);
});
test('vector edits use node setter and retain undo value independently',()=>{
 const f=fixture();Vec3.prototype.clone=function(){return new Vec3(this.x,this.y,this.z);};f.child.setPosition=function(value){this.position=value;};
 f.inspector.snapshot();f.inspector.edit({uuid:'child',field:'position',expected:{x:0,y:0,z:0},value:{x:2,y:3,z:4}},'session');assert.equal(f.child.position.x,2);assert.ok(f.child.position instanceof Vec3);
 f.inspector.undo('session');assert.equal(f.child.position.x,0);assert.throws(()=>f.inspector.edit({uuid:'child',field:'position',expected:{x:0,y:0,z:0},value:{x:Infinity,y:0,z:0}},'session'),/Invalid/);f.inspector.close();
});
test('selection remains labelled while another node is hovered; uses render camera without ancestor Canvas',()=>{
 const f=fixture();f.root.components=[];f.inspector.snapshot();f.inspector.pick(true,'session');f.inspector.select('child','session');
 const selected=f.body.children[1];assert.equal(selected.style.display,'block');assert.equal(selected.style.left,'10px');assert.equal(selected.style.top,'45px');assert.equal(selected.style.width,'50px');assert.match(selected.children[0].textContent,/Selected: child/);
 const sibling=new Node('other',f.root);sibling.components=[new UITransform()];f.setNodes([{node:f.root,depth:0},{node:f.child,depth:1},{node:sibling,depth:1}]);
 f.inspector.hover('other','session');assert.equal(selected.style.display,'block');assert.match(f.body.children[2].children[0].textContent,/Hover: other/);
 f.inspector.hover('','session');assert.equal(f.body.children[2].style.display,'none');assert.equal(selected.style.display,'block');
 f.child.activeInHierarchy=false;f.tick();assert.equal(selected.style.display,'none');assert.match(f.inspector.snapshot().highlightMessage,/inactive/);f.inspector.pick(false,'session');assert.equal(f.inspector.snapshot().highlightMessage,'','no highlight hints outside pick mode');f.inspector.close();
});
test('picking scales CSS coordinates into the canvas backing dimensions',()=>{
 const f=fixture();f.canvas.width=400;f.canvas.height=200;f.inspector.snapshot();f.inspector.pick(true,'session');
 const event=new Event('pointerup',{cancelable:true});Object.assign(event,{clientX:40,clientY:40,button:0});f.body.children[0].dispatchEvent(event);
 assert.deepEqual(f.transform.lastPoint,new Vec2(120,120));f.inspector.close();
});

test('selected label stays inside the viewport when the preview canvas extends beyond it',()=>{
 const f=fixture();f.canvas.getBoundingClientRect=()=>({left:-150,top:20,right:250,bottom:120,width:400,height:100});
 f.inspector.snapshot();f.inspector.pick(true,'session');f.inspector.select('child','session');assert.equal(f.body.children[1].children[0].style.left,'0px');f.inspector.close();
});
test('canvas hover is tracked only in pick mode, reveals the tree node without changing selection or swallowing game input',()=>{
 const f=fixture();f.inspector.snapshot();f.inspector.select('root','session');
 const event=new Event('pointermove',{cancelable:true});Object.defineProperty(event,'target',{value:f.canvas});Object.assign(event,{clientX:40,clientY:40});
 let received=0;f.window.addEventListener('pointermove',()=>received++);f.window.dispatchEvent(event);
 assert.equal(f.inspector.snapshot().hovered,'','pick mode off: no passive hover');assert.equal(received,1);
 f.inspector.pick(true,'session');f.window.dispatchEvent(event);received=1;
 const state=f.inspector.snapshot({hovered:'',selected:'root',collapsed:['root'],contains:'no match'});
 assert.equal(state.selected,'root');assert.equal(state.hovered,'child');assert.equal(state.revealHover,true);assert.equal(state.nodes.length,2);assert.equal(state.ancestors[0],'root');assert.equal(event.defaultPrevented,false);assert.equal(received,1);
 assert.equal(f.body.children[0].style.display,'block','pick mode shows the click overlay');assert.equal(f.body.children[2].style.display,'block');
 f.inspector.pick(false,'session');assert.equal(f.inspector.snapshot().hovered,'','leaving pick mode clears the hover');
 f.inspector.pick(true,'session');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,70);f.window.dispatchEvent(event);assert.equal(f.inspector.snapshot().hovered,'child');
 f.window.dispatchEvent(new Event('blur'));assert.equal(f.inspector.snapshot({hovered:'child'}).hovered,'');f.inspector.close();
});
test('hover listeners are removed when the inspector closes',()=>{
 const f=fixture();f.inspector.snapshot();f.inspector.pick(true,'session');f.inspector.close();
 const event=new Event('pointermove');Object.defineProperty(event,'target',{value:f.canvas});Object.assign(event,{clientX:40,clientY:40});f.window.dispatchEvent(event);
 assert.equal(f.inspector.snapshot().hovered,'');f.inspector.close();
});
test('empty later Canvas and full-screen layers do not steal hover or picking from rendered children',()=>{
 const f=fixture();f.child.components.push(new UIRenderer());
 const layer=new Node('empty-layer',f.root);layer.components=[new UITransform()];
 const canvas=new Node('Canvas');canvas.components=[new UITransform(),new Canvas()];
 f.setNodes([{node:f.root,depth:0},{node:f.child,depth:1},{node:layer,depth:1},{node:canvas,depth:0}]);
 f.inspector.snapshot();f.inspector.pick(true,'session');
 const move=new Event('pointermove');Object.defineProperty(move,'target',{value:f.canvas});Object.assign(move,{clientX:40,clientY:40});f.window.dispatchEvent(move);
 assert.equal(f.inspector.snapshot().hovered,'child');
 const pick=new Event('pointerup',{cancelable:true});Object.assign(pick,{clientX:40,clientY:40,button:0});f.body.children[0].dispatchEvent(pick);
 const state=f.inspector.snapshot();assert.equal(state.selected,'child');assert.equal(state.candidates.length,3);assert.equal(state.picks,1,'canvas picks are counted');f.inspector.select('root','session');assert.equal(f.inspector.snapshot().picks,1,'tree selection does not count');
 f.inspector.close();
});
test('overlapping renderers retain front sibling precedence and disabled renderers cannot steal it',()=>{
 const f=fixture();f.child.components.push(new UIRenderer());
 const front=new Node('front',f.root),disabled=new Node('disabled',f.root);
 front.components=[new UITransform(),new UIRenderer()];disabled.components=[new UITransform(),new UIRenderer()];disabled.components[1].enabledInHierarchy=false;
 f.setNodes([{node:f.root,depth:0},{node:f.child,depth:1},{node:front,depth:1},{node:disabled,depth:1}]);
 f.inspector.snapshot();f.inspector.pick(true,'session');
 const pick=new Event('pointerup',{cancelable:true});Object.assign(pick,{clientX:40,clientY:40,button:0});f.body.children[0].dispatchEvent(pick);
 assert.equal(f.inspector.snapshot().selected,'front');f.inspector.close();
});
test('print snapshot is serializable, excludes sensitive fields and never evaluates getters',()=>{
 const f=fixture();f.window.console={log(){}};let reads=0;
 const component=new Component();component.node=f.child;component.value=42;component.token='private';Object.defineProperty(component,'danger',{enumerable:true,get(){reads++;throw Error('do not read');}});f.child.components.push(component);
 f.inspector.snapshot();const node=f.inspector.print('child','','session',{snapshot:true});
 assert.equal(node.kind,'node');assert.equal(node.data.uuid,'child');assert.equal(f.window.$gd0,f.child);
 const id=node.data.components[1].id,result=f.inspector.print('child',id,'session',{snapshot:true});
 assert.equal(result.kind,'component');assert.equal(result.data.fields.find(field=>field.name==='value').value,42);
 assert.equal(JSON.stringify(result).includes('private'),false);assert.equal(reads,0);assert.equal(f.window.$gd0,component);f.inspector.close();
});

test('highlight ticks and node operations reuse the last scan; destroyed nodes drop out without rescanning per tick',()=>{
 const f=fixture();f.inspector.snapshot();const before=f.scanCount();for(let i=0;i<20;i++)f.tick();assert.equal(f.scanCount(),before);
 f.inspector.select('child','session');assert.equal(f.body.children[1].style.display,'none','tree selection draws nothing outside pick mode');
 f.inspector.pick(true,'session');const selected=f.scanCount();for(let i=0;i<20;i++)f.tick();assert.equal(f.scanCount(),selected);
 assert.equal(f.body.children[1].style.display,'block');
 f.inspector.hover('child','session');f.inspector.read('child','','name','session');assert.equal(f.scanCount(),selected);
 f.child.destroyed=true;f.tick();assert.equal(f.scanCount(),selected);assert.equal(f.body.children[1].style.display,'none');
 assert.throws(()=>f.inspector.hover('child','session'),/destroyed/);assert.equal(f.scanCount(),selected+1);f.inspector.close();
});
test('unchanged snapshots return only a digest; any change or option difference returns the full state',()=>{
 const f=fixture();const first=f.inspector.snapshot();assert.ok(first.digest);assert.equal(first.unchanged,undefined);
 const again=f.inspector.snapshot({digest:first.digest});assert.equal(JSON.stringify(again),JSON.stringify({sessionId:'session',digest:first.digest,unchanged:true}));
 assert.equal(f.inspector.snapshot({digest:first.digest,collapsed:['root']}).unchanged,undefined);
 f.child.name='renamed';const changed=f.inspector.snapshot({digest:first.digest});assert.equal(changed.unchanged,undefined);assert.notEqual(changed.digest,first.digest);
 assert.equal(changed.nodes[1].name,'renamed');f.inspector.close();
});
test('pointer hit testing and highlighting share one fresh scan per interaction',()=>{
 const f=fixture();f.inspector.snapshot();f.inspector.select('root','session');f.inspector.pick(true,'session');
 const event=new Event('pointermove');Object.defineProperty(event,'target',{value:f.canvas});Object.assign(event,{clientX:40,clientY:40});
 let before=f.scanCount();f.window.dispatchEvent(event);assert.equal(f.scanCount()-before,1);assert.equal(f.body.children[2].style.display,'block');
 f.child.destroyed=true;
 const click=new Event('pointerup',{cancelable:true});Object.assign(click,{clientX:40,clientY:40,button:0});
 before=f.scanCount();f.body.children[0].dispatchEvent(click);assert.equal(f.scanCount()-before,1);assert.equal(f.inspector.snapshot().selected,'');f.inspector.close();
});
test('collapsed components omit field collection, expanded components and print retain details',()=>{
 const f=fixture();f.inspector.snapshot();f.inspector.select('child','session');
 const folded=f.inspector.snapshot({components:[]});const id=folded.detail.components[0].id;
 assert.equal(folded.detail.components[0].fields.length,0);
 assert.ok(f.inspector.snapshot({components:[id]}).detail.components[0].fields.length>0);
 f.window.console={log(){}};assert.ok(f.inspector.print('child','','session',{snapshot:true}).data.components[0].fields.length>0);
 f.inspector.close();
});
test('with click linking on, a plain canvas click selects the node under the cursor without blocking the game',()=>{
 const f=fixture();f.inspector.snapshot();
 const down=new Event('pointerdown',{cancelable:true});Object.defineProperty(down,'target',{value:f.canvas});Object.assign(down,{clientX:40,clientY:40,button:0});
 f.window.dispatchEvent(down);assert.equal(f.inspector.snapshot().selected,'','linking off: clicks stay with the game');
 f.inspector.snapshot({link:true});f.window.dispatchEvent(down);assert.equal(down.defaultPrevented,false);
 const state=f.inspector.snapshot();assert.equal(state.selected,'child');assert.equal(state.picks,1);assert.equal(f.body.children[1].style.display,'none','no outline outside pick mode');
 f.inspector.close();f.window.dispatchEvent(down);const after=f.inspector.snapshot({link:true});assert.equal(after.selected,'','listeners are removed on close');assert.equal(after.picks,1);f.inspector.close();
});
test('a plain child node reports the nearest ancestor that carries project scripts as its owner',()=>{
 const f=fixture();class LoginView extends Component{}class Sprite extends Component{}
 const view=new LoginView();view.node=f.root;view.script='fcmR3XADNLgJ1ByKhqcC5Z';f.root.components=[view];
 const sprite=new Sprite();sprite.node=f.child;sprite.script='cc.Sprite';f.child.components.push(sprite);
 f.inspector.snapshot();f.inspector.select('child','session');const owner=f.inspector.snapshot().detail.owner;
 assert.equal(owner.uuid,'root');assert.equal(owner.name,'root');assert.equal(JSON.stringify(owner.components),JSON.stringify([{type:'LoginView',script:'fcmR3XADNLgJ1ByKhqcC5Z'}]));
 f.inspector.select('root','session');assert.equal(f.inspector.snapshot().detail.owner,null,'the scene root has no owner');f.inspector.close();
});
test('read-only hierarchy and inspect queries never install the overlay or change the selection',()=>{
 const f=fixture();const component=new Component();component.node=f.child;component.value=7;f.child.components.push(component);f.root.active=false;f.root.activeInHierarchy=false;
 const all=f.inspector.hierarchy({});assert.equal(all.sessionId,'session');assert.deepEqual(all.nodes.map(n=>n.uuid),['root','child']);assert.equal(all.truncated,false);
 assert.deepEqual(f.inspector.hierarchy({contains:'CHILD'}).nodes.map(n=>n.uuid),['child']);
 assert.deepEqual(f.inspector.hierarchy({activeOnly:true}).nodes.map(n=>n.uuid),['child'],'activeOnly follows each node\'s own activeInHierarchy flag');
 const page=f.inspector.hierarchy({offset:1,limit:1});assert.deepEqual(page.nodes.map(n=>n.uuid),['child']);assert.equal(page.total,2);
 const detail=f.inspector.inspect('child','session',{});assert.equal(detail.uuid,'child');assert.equal(detail.components[1].fields.find(x=>x.name==='value').value,7);
 const one=f.inspector.inspect('child','session',{componentId:detail.components[1].id});assert.equal(one.component.type,'Component');assert.equal(one.node.uuid,'child');
 assert.throws(()=>f.inspector.inspect('child','session',{componentId:'999'}),/component was removed/);assert.throws(()=>f.inspector.inspect('child','old',{}),/reloaded/);
 assert.equal(f.body.children.length,0,'no overlay for read-only queries');assert.equal(f.inspector.snapshot().selected,'');
});
