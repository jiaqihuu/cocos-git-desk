(function(factory){if(typeof module==='object'&&module.exports)module.exports=factory;})(function({cc,window}){
    let result=null,pending=false,dispose=null,error='';
    const idMap=new WeakMap();let next=0;
    const id=value=>value && typeof value==='object'?(idMap.has(value)?idMap.get(value):(idMap.set(value,++next),next)):null;
    const name=node=>{const names=[];for(let p=node;p;p=p.parent)names.unshift(p.name);return names.join('/');};
    function close(){if(dispose)dispose();dispose=null;pending=false;}
    function capture(){
        if(pending)throw Error('Waiting for the next frame');
        const director=cc.director,batcher=director.root?.batcher2D;
        if(!batcher || typeof batcher.commitComp!=='function' || typeof batcher.update!=='function')throw Error('This renderer does not support UI batch analysis (a 2D batcher with commitComp/update is required)');
        pending=true;error='';result=null;
        const changes=[],records=[],gpuCalls=[],batches=[],batchIndices=new Set(),pendingNodes=new Set();let recording=false,limited=false,previous=null,timeout;
        function patch(object,key,wrap){const own=Object.getOwnPropertyDescriptor(object,key),original=object[key];if(typeof original!=='function')return;const replacement=wrap(original);object[key]=replacement;changes.push(()=>{if(object[key]===replacement){if(own)Object.defineProperty(object,key,own);else delete object[key];}});}
        const append=entry=>{if(records.length<10000)records.push(entry);else limited=true;};
        function batchData(batch,index,nodes){return {index,nodes:[...nodes],texture:id(batch.texture),sampler:id(batch.sampler),materialPasses:(batch.passes||[]).map(id),stencil:batch.depthStencilState?.hash??null,layer:batch.visFlags,indices:batch.inputAssembler?.indexCount??null,model:!!batch.model};}
        const before=()=>{recording=true;};
        const after=()=>{
            if(!recording)return;
            const device=director.root.device;
            result={time:Date.now(),frame:director.getTotalFrames(),drawCalls:device.numDrawCalls,triangles:device.numTris,uiBatches:batches,gpuCalls,submissions:records,limited,
                note:'UI batches do not map one-to-one to GPU draw calls; several cameras, passes and 3D drawing change the totals. Unattributed batches are listed explicitly.'};
            close();
        };
        dispose=()=>{recording=false;for(const restore of changes.reverse())restore();director.off(cc.Director.EVENT_BEFORE_DRAW,before);director.off(cc.Director.EVENT_AFTER_DRAW,after);window.clearTimeout(timeout);};
        try{
            const gl=director.root.device.gl;
            if(!gl)throw Error('The rendering backend is not WebGL; GPU draw calls cannot be captured');
            const observe=(method,args)=>{
                if(!recording)return;if(gpuCalls.length>=10000){limited=true;return;}
                try{gpuCalls.push({index:gpuCalls.length+1,method,args:Array.from(args),program:id(gl.getParameter(gl.CURRENT_PROGRAM)),framebuffer:id(gl.getParameter(gl.FRAMEBUFFER_BINDING)),activeTextureUnit:gl.getParameter(gl.ACTIVE_TEXTURE)-gl.TEXTURE0,activeTexture:id(gl.getParameter(gl.TEXTURE_BINDING_2D)),blend:gl.isEnabled(gl.BLEND),stencil:gl.isEnabled(gl.STENCIL_TEST),depth:gl.isEnabled(gl.DEPTH_TEST)});}catch(e){error='GPU state read incomplete: '+String(e);}
            };
            for(const method of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced','drawRangeElements'])patch(gl,method,original=>function(...args){observe(method,args);return original.apply(this,args);});
            if(!gl.drawArraysInstanced){const instancing=gl.getExtension('ANGLE_instanced_arrays');if(instancing)for(const method of ['drawArraysInstancedANGLE','drawElementsInstancedANGLE'])patch(instancing,method,original=>function(...args){observe(method,args);return original.apply(this,args);});}
            patch(batcher,'autoMergeBatches',original=>function(...args){const count=this._batches.length;const value=original.apply(this,args);if(recording && this._batches.length>count){for(let i=count;i<this._batches.length;i++){batches.push(batchData(this._batches.array[i],i,pendingNodes));batchIndices.add(i);}pendingNodes.clear();}return value;});
            patch(batcher,'commitComp',original=>function(comp,data,frame,...rest){
                if(!recording || data?.chunk && typeof data.isValid==='function' && !data.isValid())return original.call(this,comp,data,frame,...rest);
                const entry={node:comp.node.uuid,path:name(comp.node),component:cc.js.getClassName(comp),texture:id(frame?.getGFXTexture?.()),asset:frame?.uuid||'',sampler:id(frame?.getGFXSampler?.()),material:id(data?.material),dataHash:data?.dataHash||0,buffer:data?.chunk?.bufferId??null,stencil:comp.stencilStage,layer:comp.node.layer,reasons:[]};
                if(previous){for(const [key,label]of [['texture','texture/atlas'],['sampler','sampler'],['material','material'],['dataHash','vertex data/batch hash'],['buffer','vertex buffer'],['stencil','mask/stencil state'],['layer','layer mask']])if(entry[key]!==previous[key])entry.reasons.push(label);}else entry.reasons.push('first commit of the frame');
                const value=original.call(this,comp,data,frame,...rest);if(pendingNodes.size<10000)pendingNodes.add(comp.node.uuid);else limited=true;append(entry);previous=entry;return value;
            });
            patch(batcher,'update',original=>function(...args){const value=original.apply(this,args);if(recording){for(let i=0;i<this._batches.length && i<10000;i++){if(!batchIndices.has(i))batches.push(batchData(this._batches.array[i],i,[]));}batches.sort((a,b)=>a.index-b.index);}return value;});
            director.on(cc.Director.EVENT_BEFORE_DRAW,before);director.on(cc.Director.EVENT_AFTER_DRAW,after);
            timeout=window.setTimeout(()=>{error='No complete frame was drawn within 5 s; resume game rendering and retry';close();},5000);
        }catch(e){close();throw e;}
        return true;
    }
    return {capture,close,snapshot:()=>({pending,error,result})};
});
