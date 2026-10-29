const test=require('node:test'),assert=require('node:assert/strict');
const toolbar=require('../dist/debug-preview-toolbar');
function fixture(t){
 class Element extends EventTarget {constructor(){super();this.hidden=true;this.disabled=false;this.attrs={};}setAttribute(k,v){this.attrs[k]=v;}}
 const button=new Element(),gitButton=new Element(),result=new Element(),wrap=new Element();wrap.ownerDocument=new EventTarget();
 const instance={$:{button,gitButton,result,wrap}};t.after(()=>{toolbar.close.call(instance);delete global.Editor});return{instance,button,gitButton,result};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('toolbar dispatches only embedded IPC, gives feedback and prevents duplicate clicks',async t=>{
 const f=fixture(t);let done;const calls=[];global.Editor={Message:{request:async(...args)=>{calls.push(args);return new Promise(resolve=>done=resolve)}}};
 toolbar.ready.call(f.instance);f.button.dispatchEvent(new Event('click'));f.button.dispatchEvent(new Event('click'));
 assert.deepEqual(calls,[['cocos-git-desk','debug-preview-open']]);assert.equal(f.button.disabled,true);assert.match(f.result.textContent,/正在打开/);
 done({ok:true,data:'已打开内嵌调试预览。'});await flush();assert.equal(f.button.disabled,false);assert.equal(f.result.textContent,'已打开内嵌调试预览。');
});
test('old backend gives actionable failure and allows retry',async t=>{
 const f=fixture(t);global.Editor={Message:{request:async()=>{throw Error('Message does not exist')}}};toolbar.ready.call(f.instance);
 f.button.dispatchEvent(new Event('click'));await flush();assert.match(f.result.textContent,/重新加载 Git Desk/);assert.equal(f.button.disabled,false);
 Editor.Message.request=async()=>({ok:false,error:'面板打开失败'});f.button.dispatchEvent(new Event('click'));await flush();assert.match(f.result.textContent,/面板打开失败/);
});
test('toolbar reload does not duplicate listeners; close ignores late responses',async t=>{
 const f=fixture(t);let count=0,done;global.Editor={Message:{request:()=>{count++;return new Promise(resolve=>done=resolve)}}};
 toolbar.ready.call(f.instance);toolbar.ready.call(f.instance);f.button.dispatchEvent(new Event('click'));assert.equal(count,1);
 toolbar.close.call(f.instance);const message=f.result.textContent;done({ok:true,data:'late'});await flush();assert.equal(f.result.textContent,message);
 f.button.dispatchEvent(new Event('click'));assert.equal(count,1);
});

test('Git Desk reuses open IPC, handles existing panel and disposes listeners',async t=>{
 const f=fixture(t),calls=[];let done;global.Editor={Message:{request:(...args)=>{calls.push(args);return new Promise(resolve=>done=resolve)}}};
 toolbar.ready.call(f.instance);toolbar.ready.call(f.instance);
 f.gitButton.dispatchEvent(new Event('click'));f.gitButton.dispatchEvent(new Event('click'));f.button.dispatchEvent(new Event('click'));
 assert.deepEqual(calls,[['cocos-git-desk','open']]);assert.equal(f.gitButton.disabled,true);assert.equal(f.button.disabled,true);
 done(false);await flush();assert.equal(f.gitButton.disabled,false);assert.equal(f.button.disabled,false);assert.equal(f.result.textContent,'已打开 Git Desk。');
 toolbar.close.call(f.instance);f.gitButton.dispatchEvent(new Event('click'));assert.equal(calls.length,1);
});
test('Git Desk failure is visible and retryable',async t=>{
 const f=fixture(t);global.Editor={Message:{request:async()=>{throw Error('Git Desk 内嵌打开失败')}}};toolbar.ready.call(f.instance);
 f.gitButton.dispatchEvent(new Event('click'));await flush();assert.match(f.result.textContent,/内嵌打开失败/);assert.equal(f.gitButton.disabled,false);
 Editor.Message.request=async()=>true;f.gitButton.dispatchEvent(new Event('click'));await flush();assert.equal(f.result.textContent,'已打开 Git Desk。');
});
