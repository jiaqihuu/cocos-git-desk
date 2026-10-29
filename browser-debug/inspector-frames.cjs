'use strict';
const fs=require('node:fs'),path=require('node:path');
const methods=new Set(['snapshot','select','pick','hover','edit','undo','read','print','destroy','close','capture','captureCancel','renderSnapshot','hierarchy','inspect','layout']);
const runtime=fs.readFileSync(path.join(__dirname,'inspector-runtime.js'),'utf8');
const render=fs.readFileSync(path.join(__dirname,'inspector-render.js'),'utf8');
const factory=source=>`(()=>{const module={exports:{}};${source}\nreturn module.exports;})()`;
const defaultEngineVersions=['3.8.x'];
async function evaluate(frame,expression) {
 const result=await frame.executeJavaScript(`(async()=>{try{return {ok:true,value:await (${expression})};}catch(error){return {ok:false,error:String(error?.message||error)};}})()`);
 if(!result?.ok)throw Error(result?.error||'The inspector returned no valid result');
 return result.value;
}
// The engine version check accepts the configured patterns (preview.engineVersions): "3.8.x" matches every
// 3.8 release, "3.8.8" exactly one. The list is inlined into the bootstrap so the page needs no host call.
// Failures while the game is still loading carry a code so the hub can show them as waiting in any language.
const engineMissing='This frame has no loaded Cocos engine',exportsIncomplete='The Cocos module exports of this frame are incomplete; node highlighting cannot start';
const coded=(error,code)=>{if(error&&typeof error==='object')error.code=code;return error;};
function bootstrap(engineVersions) {
 const allowed=JSON.stringify(engineVersions);
 return `(async()=>{if(window.__GIT_DESK_INSPECTOR__)return;let cc=window.System?.import?await window.System.import('cc'):(window.cc || window.cclegacy);if(!cc?.director)throw Error(${JSON.stringify(engineMissing)});if(!cc.UITransform||!cc.Vec2||!cc.Vec3)throw Error(${JSON.stringify(exportsIncomplete)});const allowed=${allowed};const version=String(cc.VERSION||cc.ENGINE_VERSION||'');if(!allowed.some(pattern=>{const want=pattern.split('.'),have=version.split('.');return want.length<=have.length&&want.every((part,index)=>part==='x'||part===have[index]);}))throw Error('The inspector supports Cocos Creator '+allowed.join(', ')+'; detected '+(version||'unknown'));const scan=()=>{const nodes=[],stack=[];const scene=cc.director.getScene();if(scene)stack.push({node:scene,depth:0});while(stack.length&&nodes.length<10000){const item=stack.pop();if(!cc.isValid(item.node,true))continue;nodes.push(item);for(let i=item.node.children.length-1;i>=0;i--)stack.push({node:item.node.children[i],depth:item.depth+1});}return{nodes,scanLimitReached:stack.length>0};};const sessionId=crypto.randomUUID();const inspector=${factory(runtime)}({cc,scan,safeText:s=>String(s).slice(0,4096),sessionId,document,window});const renderer=${factory(render)}({cc,window});window.__GIT_DESK_INSPECTOR__={...inspector,capture:()=>renderer.capture(),captureCancel:()=>{renderer.close();return true;},renderSnapshot:()=>renderer.snapshot(),close:()=>{inspector.close();renderer.close();}};window.addEventListener('pagehide',()=>window.__GIT_DESK_INSPECTOR__?.close(),{once:true});})()`;
}
class InspectorFrames {
 constructor(guest,{engineVersions=defaultEngineVersions}={}){this.guest=guest;this.bootstrap=bootstrap(engineVersions);this.epoch=0;this.closed=false;this.active=null;this.queue=Promise.resolve();}
 frames(){if(this.closed||this.guest.isDestroyed())throw Error('The preview is closed');return this.guest.mainFrame.framesInSubtree;}
 list(){return this.frames().filter(f=>/^(https?:|about:)/.test(f.url)).slice(0,64).map(f=>({id:`${f.processId}:${f.routingId}`,name:f.name||'frame',url:f.url.split(/[?#]/)[0]}));}
 call(id,method,args){
  if(!methods.has(method)||!Array.isArray(args)||JSON.stringify(args).length>65536)return Promise.reject(Error('Invalid inspector operation'));
  const job=()=>this.run(id,method,args);const result=this.queue.then(job);this.queue=result.catch(()=>{});return result;
 }
 async run(id,method,args){
  const frame=this.frames().find(f=>`${f.processId}:${f.routingId}`===id);if(!frame)throw coded(Error('The debug frame was removed; select another frame'),'FRAME_REMOVED');
  const epoch=this.epoch;
  if(this.active && this.active!==frame){await this.cleanup(this.active);this.active=null;}
  if(this.closed||epoch!==this.epoch)throw Error('The inspector is closed');
  this.active=frame;
  if(method==='close'){await this.cleanup(frame);return true;}
  // One round trip per call: the readiness probe and the invocation share an evaluation.
  const invoke=`window.__GIT_DESK_INSPECTOR__?{ready:true,value:window.__GIT_DESK_INSPECTOR__[${JSON.stringify(method)}](...${JSON.stringify(args)})}:{ready:false}`;
  let result=await evaluate(frame,invoke);
  if(this.closed||epoch!==this.epoch)throw Error('The inspector is closed');
  if(!result?.ready){
   try{await evaluate(frame,this.bootstrap);}catch(error){throw [engineMissing,exportsIncomplete].includes(error?.message)?coded(error,'ENGINE_NOT_LOADED'):error;}
   if(this.closed||epoch!==this.epoch){await this.cleanup(frame);throw Error('The inspector is closed');}
   result=await evaluate(frame,invoke);
  }
  if(this.closed||epoch!==this.epoch)throw Error('The preview changed during the query');
  if(!result?.ready)throw Error('The inspector is still not ready after injection; reload the preview');
  return result.value;
 }
 async cleanup(frame){try{await evaluate(frame,'window.__GIT_DESK_INSPECTOR__?.close()');}catch(error){if(!this.closed && this.frames().includes(frame))throw error;}}
 close(){this.closed=true;this.epoch++;const frame=this.active;this.active=null;if(frame)void this.cleanup(frame).catch(()=>{});}
}
module.exports={InspectorFrames,bootstrap,defaultEngineVersions};
