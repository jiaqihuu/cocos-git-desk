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
