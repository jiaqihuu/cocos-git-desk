const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const moduleMock={exports:{}};vm.runInNewContext(fs.readFileSync(require.resolve('../browser-debug/inspector-render.js'),'utf8'),{module:moduleMock});const create=moduleMock.exports;
function fixture(){
 const events=new Map();let timeout;
 const gl={CURRENT_PROGRAM:1,FRAMEBUFFER_BINDING:2,ACTIVE_TEXTURE:3,TEXTURE0:10,TEXTURE_BINDING_2D:4,BLEND:5,STENCIL_TEST:6,DEPTH_TEST:7,getParameter:k=>k===3?10:null,isEnabled:()=>false,getExtension:()=>null,drawArrays(){this.calls=(this.calls||0)+1;}};
 const material={},texture={};const batcher={_batches:{length:0,array:[]},last:null,autoMergeBatches(){if(this.last){this._batches.array.push({texture,sampler:null,passes:[],visFlags:1,inputAssembler:{indexCount:6}});this._batches.length++;this.last=null;}},commitComp(comp,data){if(this.last&&this.last!==data.material)this.autoMergeBatches();this.last=data.material;},update(){this.autoMergeBatches();}};
 const director={root:{batcher2D:batcher,device:{gl,numDrawCalls:1,numTris:2}},on:(e,f)=>events.set(e,f),off:(e,f)=>{if(events.get(e)===f)events.delete(e);},getTotalFrames:()=>5};
 const window={setTimeout:f=>{timeout=f;return 1;},clearTimeout:()=>{timeout=null;}};
 const api=create({cc:{director,Director:{EVENT_BEFORE_DRAW:'before',EVENT_AFTER_DRAW:'after'},js:{getClassName:()=> 'Sprite'}},window});
 return {api,batcher,gl,events,material,emit:e=>events.get(e)?.(),timeout:()=>timeout?.()};
}
test('captures actual GPU calls and batched UI contributions then restores all hooks',()=>{
 const f=fixture(),commit=f.batcher.commitComp,draw=f.gl.drawArrays;
 f.api.capture();f.gl.drawArrays(4,0,6);assert.equal(f.gl.calls,1);f.emit('before');
 for(const uuid of ['a','b'])f.batcher.commitComp({node:{uuid,name:uuid,layer:1},stencilStage:0},{material:f.material,dataHash:1,chunk:{bufferId:0}},null);
 f.batcher.update();f.gl.drawArrays(4,0,6);f.emit('after');
 const data=f.api.snapshot();assert.equal(data.pending,false);assert.equal(data.result.gpuCalls.length,1);assert.equal(data.result.uiBatches.length,1);assert.deepEqual(Array.from(data.result.uiBatches[0].nodes),['a','b']);assert.equal(f.batcher.commitComp,commit);assert.equal(f.gl.drawArrays,draw);assert.equal(f.events.size,0);
});
test('timeout and close cancel listeners and restore hooks without running a frame',()=>{
 const f=fixture(),commit=f.batcher.commitComp;f.api.capture();assert.throws(()=>f.api.capture(),/next frame/);f.timeout();assert.match(f.api.snapshot().error,/5 s\b/);assert.equal(f.batcher.commitComp,commit);assert.equal(f.events.size,0);
 f.api.capture();f.api.close();assert.equal(f.api.snapshot().pending,false);assert.equal(f.batcher.commitComp,commit);
});
test('cleanup does not overwrite another debugger hook installed after capture began',()=>{
 const f=fixture();f.api.capture();const later=()=>{};f.batcher.commitComp=later;f.api.close();assert.equal(f.batcher.commitComp,later);
});
