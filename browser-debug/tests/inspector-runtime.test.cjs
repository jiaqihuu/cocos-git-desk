'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../inspector-runtime.js'),'utf8');
const factory=vm.runInNewContext('(()=>{const module={exports:{}};'+source+'\nreturn module.exports;})()',{console});
const same=(a,b,m)=>assert.deepEqual(JSON.parse(JSON.stringify(a)),b,m);
class UITransform{constructor(rect,anchor={x:0.5,y:0.5}){this.rect=rect;this.anchorX=anchor.x;this.anchorY=anchor.y;this.width=rect.width;this.height=rect.height;}getBoundingBoxToWorld(){return {...this.rect};}}
class Label{constructor(string,fontSize,color){this.string=string;this.fontSize=fontSize;this.color=color;}}
class Sprite{constructor(name,color){this.spriteFrame=name?{name}:null;this.color=color;}}
class UIOpacity{constructor(opacity){this.opacity=opacity;}}
class Button{}
const cc={UITransform,Label,Sprite,UIOpacity,Button,Canvas:class{},Asset:class{},Node:class{},Component:class{},Vec2:class{},Vec3:class{},isValid:()=>true,VERSION:'3.8.8',
 js:{getClassName:value=>({UITransform:'cc.UITransform',Label:'cc.Label',Sprite:'cc.Sprite',UIOpacity:'cc.UIOpacity',Button:'cc.Button'})[value.constructor.name]||value.constructor.name,getClassId:()=>''},
 view:{getVisibleSize:()=>({width:720,height:1280}),getDesignResolutionSize:()=>({width:720,height:1280})},director:{root:{}}};
function node(uuid,name,parent,components,over={}){const n={uuid,name,parent,children:[],components,activeInHierarchy:true,layer:1<<25,scale:{x:1,y:1},getComponent(type){return components.find(c=>c instanceof type)||null;},...over};if(parent)parent.children.push(n);return n;}
function fixture(){
 const scene=node('scene','scene',null,[]);
 const canvas=node('canvas','Canvas',scene,[new UITransform({x:0,y:0,width:720,height:1280})]);
 const title=node('title','Title',canvas,[new UITransform({x:10,y:1000,width:100,height:50},{x:0,y:1}),new Label('Hello',32,{r:255,g:128,b:0,a:255})]);
 const icon=node('icon','Icon',title,[new UITransform({x:300,y:200,width:64,height:64}),new Sprite('coin',{r:255,g:255,b:255,a:128}),new UIOpacity(200),new Button()]);
 node('hidden','Hidden',canvas,[new UITransform({x:0,y:0,width:10,height:10})],{activeInHierarchy:false});
 node('plain','Plain',canvas,[]);
 const list=[];const walk=(n,depth)=>{list.push({node:n,depth});for(const c of n.children)walk(c,depth+1);};walk(scene,0);
 const api=factory({cc,scan:()=>({nodes:list,scanLimitReached:false}),safeText:value=>String(value),sessionId:'s1',document:{querySelector:()=>null},window:{addEventListener(){},removeEventListener(){}}});
 return {api,icon,title};
}
test('layout flattens UITransform nodes into top-left design pixels with the fields a design comparison needs',()=>{
 const {api}=fixture();
 const out=api.layout({});
 assert.equal(out.sessionId,'s1');same(out.visible,{width:720,height:1280});assert.match(out.coordinates,/top-left/);
 same(out.nodes.map(n=>[n.name,n.x,n.y,n.width,n.height,n.depth,n.kind]),[['Canvas',0,0,720,1280,1,'node'],['Title',10,230,100,50,2,'label'],['Icon',300,1016,64,64,3,'button']]);
 const title=out.nodes[1];assert.equal(title.fontSize,32);assert.equal(title.color,'#ff8000');assert.equal(title.text,undefined,'text is opt-in');same(title.anchor,{x:0,y:1});
 const icon=out.nodes[2];assert.equal(icon.sprite,'coin');assert.equal(icon.color,'#ffffff80');assert.equal(icon.opacity,200);
 assert.equal(out.total,3);assert.equal(out.truncated,false);
 assert.equal(api.layout({includeText:true}).nodes[1].text,'Hello');
 assert.equal(api.layout({activeOnly:false}).nodes.length,4,'inactive nodes are included on request');
 same(api.layout({root:'title'}).nodes.map(n=>n.name),['Title','Icon']);
 same(api.layout({contains:'icon'}).nodes.map(n=>n.name),['Icon']);
 const cut=api.layout({limit:1});assert.equal(cut.nodes.length,1);assert.equal(cut.truncated,true);
 same(api.layout({maxDepth:1}).nodes.map(n=>n.name),['Canvas']);
 assert.throws(()=>api.layout({root:'nope'}),/node/);
});
test('hierarchy still answers without an overlay and stale sessions are refused',()=>{
 const {api}=fixture();
 const tree=api.hierarchy({contains:'icon'});assert.equal(tree.total,1);assert.equal(tree.nodes[0].name,'Icon');
 assert.throws(()=>api.inspect('icon','old'),/preview reloaded/);
});
// Shaped like Creator 3.8.8: string/inputFlag/textLabel are prototype accessors over serialized fields and the box
// renders into a child TEXT_LABEL. Here that Label holds the plaintext (the engine shows bullets) so a leak through it shows.
function passwordFixture(){
 class Component{constructor(){this.enabled=true;this.enabledInHierarchy=true;}}
 class UITransform extends Component{constructor(){super();this.anchorX=0;this.anchorY=0;this.width=40;this.height=10;}getBoundingBoxToWorld(){return {x:0,y:0,width:40,height:10};}}
 class Label extends Component{constructor(text){super();this._string=text;this.fontSize=20;}get string(){return this._string;}set string(v){this._string=v;}}
 class EditBox extends Component{constructor(text,flag){super();this._string=text;this._inputFlag=flag;this._textLabel=null;}get string(){return this._string;}set string(v){this._string=v;}get inputFlag(){return this._inputFlag;}set inputFlag(v){this._inputFlag=v;}get textLabel(){return this._textLabel;}get placeholder(){return '输入';}}
 Label.__props__=['string','_string','fontSize'];EditBox.__props__=['string','placeholder','textLabel','inputFlag','_string','_inputFlag','_textLabel'];EditBox.InputFlag={PASSWORD:0,SENSITIVE:1,DEFAULT:5};
 const names={UITransform:'cc.UITransform',Label:'cc.Label',EditBox:'cc.EditBox'};
 const cc={UITransform,Label,EditBox,Canvas:class{},Asset:class{},Node:class{},Component,Vec2:class{},Vec3:class{},isValid:()=>true,VERSION:'3.8.8',
  js:{getClassName:v=>names[v.constructor.name]||v.constructor.name,getClassId:()=>''},view:{getVisibleSize:()=>({width:100,height:100}),getDesignResolutionSize:()=>({width:100,height:100})},director:{root:{}}};
 const make=(uuid,name,parent,components)=>{const n={uuid,name,parent,children:[],components:[new UITransform(),...components],active:true,activeInHierarchy:true,layer:1,scale:{x:1,y:1},getComponent(type){return this.components.find(c=>c instanceof type)||null;}};for(const c of n.components)c.node=n;if(parent)parent.children.push(n);return n;};
 const box=(uuid,text,flag,parent)=>{const edit=new EditBox(text,flag),node=make(uuid,uuid,parent,[edit]);edit._textLabel=make(uuid+'-text','TEXT_LABEL',node,[new Label(text)]).components[1];make(uuid+'-hint','PLACEHOLDER_LABEL',node,[new Label('请输入'+uuid)]);return edit;};
 const scene=make('scene','scene',null,[]),canvas=make('canvas','Canvas',scene,[]);
 const pwd=box('pwd','hunter2',0,canvas),user=box('user','jev-visible',5,canvas);
 const list=[];const walk=(n,d)=>{list.push({node:n,depth:d});for(const c of n.children)walk(c,d+1);};walk(scene,0);
 const logs=[],element=()=>({style:{},children:[],setAttribute(){},addEventListener(){},append(...items){this.children.push(...items);},remove(){}});
 const window={innerWidth:100,innerHeight:100,console:{log:line=>logs.push(String(line))},addEventListener(){},removeEventListener(){},setInterval:()=>1,clearInterval(){}};
 const api=factory({cc,scan:()=>({nodes:list,scanLimitReached:false}),safeText:v=>String(v),sessionId:'s1',document:{body:{append(){}},createElement:element,querySelector:()=>null},window});
 return {api,pwd,user,logs};
}
const fieldOf=(component,name)=>component.fields.find(field=>field.name===name);
test('a password EditBox never echoes its text through inspect, read, print, snapshots, layout or its text Label',()=>{
 const {api,pwd,logs}=passwordFixture(),mask='[password hidden, length 7]';
 const leak=(value,what)=>assert.equal(JSON.stringify(value).includes('hunter2'),false,what+' leaked the password');
 const detail=api.inspect('pwd','s1',{});leak(detail,'inspect');leak(api.inspect('pwd','s1',{all:true}),'inspect all');
 const edit=detail.components.find(c=>c.type==='cc.EditBox');
 same(fieldOf(edit,'_string'),{name:'_string',value:mask,editable:false});assert.equal(fieldOf(edit,'string').getter,true,'the accessor still waits for an explicit read');
 assert.equal(api.read('pwd',edit.id,'string','s1'),mask);assert.equal(api.read('pwd',edit.id,'_string','s1'),mask);
 const cached=api.inspect('pwd','s1',{componentId:edit.id}).component;leak(cached,'cached read');same(fieldOf(cached,'string'),{name:'string',accessor:true,editable:false,value:mask});
 leak(api.print('pwd','','s1',{snapshot:true}),'node print');const printed=api.print('pwd',edit.id,'s1',{snapshot:true});leak(printed,'component print');assert.equal(fieldOf(printed.data,'_string').value,mask);leak(logs,'console line');
 api.select('pwd','s1');leak(api.snapshot({components:[edit.id]}),'snapshot');
 const text=api.inspect('pwd-text','s1',{}),label=text.components.find(c=>c.type==='cc.Label');leak(text,'text Label');assert.equal(fieldOf(label,'_string').value,mask);
 assert.equal(api.read('pwd-text',label.id,'string','s1'),mask);leak(api.print('pwd-text',label.id,'s1',{snapshot:true}),'text Label print');
 const rows=api.layout({includeText:true}).nodes;leak(rows,'layout');assert.equal(rows.find(r=>r.uuid==='pwd-text').text,mask);assert.equal(rows.find(r=>r.uuid==='pwd-hint').text,'请输入pwd','the placeholder Label stays readable');
 assert.throws(()=>api.edit({uuid:'pwd',id:edit.id,field:'string',value:'x',expected:mask},'s1'),/password box/i);
 assert.throws(()=>api.edit({uuid:'pwd-text',id:label.id,field:'string',value:'x',expected:mask},'s1'),/password box/i);assert.equal(pwd.string,'hunter2','a refused edit leaves the box untouched');api.close();
});
test('the inspector cannot turn a password EditBox into a plain one to read it',()=>{
 const {api,pwd}=passwordFixture();
 const edit=api.inspect('pwd','s1',{}).components.find(c=>c.type==='cc.EditBox');
 assert.equal(api.read('pwd',edit.id,'inputFlag','s1'),0);
 const flag=fieldOf(api.inspect('pwd','s1',{componentId:edit.id}).component,'inputFlag');assert.equal(flag.value,0);assert.equal(flag.editable,false);
 assert.throws(()=>api.edit({uuid:'pwd',id:edit.id,field:'inputFlag',value:5,expected:0},'s1'),/password box/i);
 assert.throws(()=>api.edit({uuid:'pwd',id:edit.id,field:'_inputFlag',value:5,expected:0},'s1'),/password box/i);
 assert.equal(pwd.inputFlag,0);assert.equal(api.read('pwd',edit.id,'string','s1'),'[password hidden, length 7]');
 const plain=api.inspect('user','s1',{}).components.find(c=>c.type==='cc.EditBox');api.read('user',plain.id,'inputFlag','s1');
 assert.equal(fieldOf(api.inspect('user','s1',{componentId:plain.id}).component,'inputFlag').editable,true,'a normal box can still change its input flag');api.close();
});
test('a normal EditBox stays readable and editable; a read cached before it turns into a password box is masked',()=>{
 const {api,user}=passwordFixture();
 const edit=api.inspect('user','s1',{}).components.find(c=>c.type==='cc.EditBox');
 assert.equal(fieldOf(edit,'_string').value,'jev-visible');assert.equal(api.read('user',edit.id,'string','s1'),'jev-visible');
 assert.match(JSON.stringify(api.print('user',edit.id,'s1',{snapshot:true})),/jev-visible/);
 assert.equal(fieldOf(api.inspect('user-text','s1',{}).components.find(c=>c.type==='cc.Label'),'_string').value,'jev-visible');
 assert.equal(api.layout({includeText:true}).nodes.find(r=>r.uuid==='user-text').text,'jev-visible');
 assert.equal(api.edit({uuid:'user',id:edit.id,field:'string',value:'retyped',expected:'jev-visible'},'s1'),true);assert.equal(user.string,'retyped');
 assert.equal(api.read('user',edit.id,'string','s1'),'retyped');user.inputFlag=0;
 const after=api.inspect('user','s1',{componentId:edit.id}).component;
 same(fieldOf(after,'string'),{name:'string',accessor:true,editable:false,value:'[password hidden, length 7]'});assert.equal(JSON.stringify(after).includes('retyped'),false);api.close();
});
test('undo cannot turn a box that became a password box back into a plain one',()=>{
 const {api,user}=passwordFixture();
 const edit=api.inspect('user','s1',{}).components.find(c=>c.type==='cc.EditBox');
 api.read('user',edit.id,'inputFlag','s1');assert.equal(api.edit({uuid:'user',id:edit.id,field:'inputFlag',value:0,expected:5},'s1'),true,'a plain box may become a password box');
 assert.throws(()=>api.undo('s1'),/password box/i);assert.equal(user.inputFlag,0,'the refused undo leaves it a password box');
 assert.equal(api.read('user',edit.id,'string','s1'),'[password hidden, length 11]');api.close();
});
