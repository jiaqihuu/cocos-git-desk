const test=require('node:test'),assert=require('node:assert/strict');
const {RuntimeInspectorHub,formatPrint}=require('../dist/runtime-inspector-hub');
const flush=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));};
const snapshot=(over={})=>({sessionId:'s',selected:'',nodes:[],candidates:[],candidateCount:0,detail:null,offset:0,total:0,scanLimitReached:false,picking:false,digest:'d1',...over});
function fixture(t,options={}){
 const calls=[],published=[],outputs=[],picked=[];let frames=options.frames||[{id:'main',name:'main',url:'http://localhost/'}];
 const transport={frames:async()=>{calls.push(['frames']);return frames;},call:async(id,method,args)=>{calls.push([id,method,args]);if(options.call)return options.call(id,method,args);if(method==='snapshot')return args[0].digest==='d1'?{sessionId:'s',digest:'d1',unchanged:true}:snapshot();if(method==='renderSnapshot')return {pending:false,error:'',result:null};return true;}};
 const hub=new RuntimeInspectorHub(transport,state=>published.push(state),record=>outputs.push(record),()=>picked.push(Date.now()));
 t.after(()=>hub.close());
 return {hub,calls,published,outputs,picked,setFrames:value=>{frames=value;},snapshots:()=>calls.filter(c=>c[1]==='snapshot')};
}
test('polling runs only while a viewer is visible and stops the page runtime afterwards',async t=>{
 t.mock.timers.enable({apis:['setInterval','Date']});const f=fixture(t);
 t.mock.timers.tick(1000);await flush();assert.equal(f.snapshots().length,0,'no viewer, no polling');
 f.hub.setViewer('hierarchy',true);await flush();assert.equal(f.snapshots().length,1);assert.equal(f.published.at(-1).snapshot.sessionId,'s');
 t.mock.timers.tick(300);await flush();assert.equal(f.snapshots().length,2);assert.equal(f.snapshots()[1][2][0].digest,'d1','second poll resends the digest');
 assert.equal(f.published.length,1,'unchanged snapshot publishes nothing new');
 assert.equal(f.hub.viewerVisible('hierarchy'),true);f.hub.setViewer('hierarchy',false);await flush();assert.equal(f.hub.viewerVisible('hierarchy'),false);assert.equal(f.hub.viewerVisible('properties'),true,'an unregistered viewer counts as visible');const count=f.snapshots().length;assert.ok(f.calls.some(c=>c[1]==='close'),'hidden viewers release the page runtime');
 t.mock.timers.tick(3000);await flush();assert.equal(f.snapshots().length,count);
});
test('idle polling slows to a heartbeat; option updates and actions refresh immediately',async t=>{
 t.mock.timers.enable({apis:['setInterval','Date']});const f=fixture(t);f.hub.setViewer('window',true);await flush();
 const run=async ticks=>{const before=f.snapshots().length;for(let i=0;i<ticks;i++){t.mock.timers.tick(300);await flush();}return f.snapshots().length-before;};
 assert.equal(await run(6),6);const idle=await run(10);assert.ok(idle>=2&&idle<=3,'idle cadence: '+idle);
 f.hub.update({fold:'root'});await flush();assert.deepEqual(f.hub.state().options.collapsed,['root']);
 const after=f.snapshots().length;t.mock.timers.tick(300);await flush();assert.equal(f.snapshots().length,after+1,'interaction restores the fast cadence');
 f.hub.update({fold:'root'});await flush();assert.deepEqual(f.hub.state().options.collapsed,[]);
 f.hub.update({contains:'abc',offset:400});await flush();assert.equal(f.hub.state().options.contains,'abc');assert.equal(f.hub.state().options.offset,0,'a new query restarts at the first page');f.hub.update({offset:400});await flush();assert.equal(f.hub.state().options.offset,400);
 f.hub.update({component:{id:'c1',open:true}});f.hub.update({component:{id:'c1',open:true}});await flush();assert.deepEqual(f.hub.state().options.components,['c1']);
 assert.deepEqual(f.snapshots().at(-1)[2][0].components,['c1']);
});
test('actions reach the page with the current frame; errors are published and cleared by the next action',async t=>{
 const f=fixture(t,{call:(id,method,args)=>{if(method==='edit')throw Error('属性已发生变化');if(method==='print')return {kind:'节点',name:'n'};if(method==='snapshot')return snapshot();return true;}});
 f.hub.setViewer('properties',true);await flush();
 assert.equal(await f.hub.action('edit',[{},'s']),false);assert.equal(f.published.at(-1).message,'属性已发生变化');
 assert.equal(await f.hub.action('print',['node','','s']),true);assert.deepEqual(f.outputs,[{kind:'节点',name:'n'}]);assert.equal(f.published.at(-1).message,'');
 assert.deepEqual(f.calls.find(c=>c[1]==='print')[2].at(-1),{snapshot:true});
 await assert.rejects(f.hub.action('evaluate',[]),/不支持/);
 f.hub.update({component:{id:'c1',open:true}});await flush();
 assert.equal(await f.hub.action('select',['node','s']),true);assert.equal(f.snapshots().at(-1)[2][0].reveal,true);assert.deepEqual(f.hub.state().options.components,[],'a new selection starts with collapsed components');
 const before=f.published.length;f.hub.announce();assert.equal(f.published.length,before+1);assert.equal(f.published.at(-1).closed,false);
});
test('capture polls the render snapshot until the frame completes even without viewers',async t=>{
 t.mock.timers.enable({apis:['setInterval','Date']});let pending=true;
 const f=fixture(t,{call:(id,method)=>{if(method==='renderSnapshot')return {pending,error:'',result:pending?null:{frame:1}};if(method==='snapshot')return snapshot();return true;}});
 f.hub.setViewer('preview',true);await flush();f.hub.setViewer('preview',false);await flush();
 assert.equal(await f.hub.action('capture',[]),true);await flush();assert.equal(f.hub.state().capturePending,true);
 t.mock.timers.tick(1200);await flush();const renders=f.calls.filter(c=>c[1]==='renderSnapshot').length;assert.ok(renders>=2);
 pending=false;t.mock.timers.tick(1200);await flush();assert.equal(f.hub.state().capturePending,false);assert.equal(f.published.at(-1).capture.result.frame,1);
 const settled=f.calls.filter(c=>c[1]==='renderSnapshot').length;t.mock.timers.tick(2000);await flush();assert.equal(f.calls.filter(c=>c[1]==='renderSnapshot').length,settled,'polling stops once the capture settles');
});
test('a vanished frame falls back to the first frame and resets state; closing publishes a closed state',async t=>{
 const f=fixture(t,{frames:[{id:'a',name:'a',url:'http://a/'},{id:'b',name:'b',url:'http://b/'}]});
 f.hub.setViewer('hierarchy',true);await flush();assert.equal(f.hub.state().frame,'a');assert.equal('frames' in f.hub.state(),false,'frames are not part of the published state');
 f.hub.update({fold:'x'});await flush();f.setFrames([{id:'b',name:'b',url:'http://b/'}]);f.hub.lastFrames=0;await f.hub.refresh(true);
 assert.equal(f.hub.state().frame,'b');assert.deepEqual(f.hub.state().options.collapsed,[]);assert.equal(f.snapshots().at(-1)[0],'b');
 f.hub.close();assert.equal(f.published.at(-1).closed,true);assert.equal(f.published.at(-1).snapshot,null);assert.match(f.published.at(-1).message,/已关闭/);
 assert.throws(()=>f.hub.update({fold:'x'}),/已关闭/);assert.throws(()=>f.hub.setViewer('hierarchy',true),/已关闭/);
});
test('transport failures reset the snapshot and surface the reason',async t=>{
 let fail=false;const f=fixture(t,{call:(id,method)=>{if(fail)throw Error('预览已关闭');if(method==='snapshot')return snapshot();return true;}});
 f.hub.setViewer('hierarchy',true);await flush();assert.equal(f.hub.state().snapshot.sessionId,'s');
 fail=true;await f.hub.refresh(true);assert.equal(f.hub.state().snapshot,null);assert.match(f.hub.state().message,/预览已关闭/);
 assert.throws(()=>f.hub.setViewer('',true),/无效/);
});
test('print records become labelled indented text for the Creator console and long bodies are truncated',()=>{
 const text=formatPrint({kind:'节点',name:'bg',path:'main/root/gui/bg',data:{uuid:'u1',active:true}});
 assert.match(text,/^\[调试预览\] 打印节点 bg（main\/root\/gui\/bg）· 预览 DevTools 中可用 \$gd0\n\{\n  "uuid": "u1",/);
 const long=formatPrint({kind:'组件',name:'C',path:'p',data:{big:'x'.repeat(70000)}});assert.ok(long.length<61000);assert.match(long,/已截断/);
 assert.match(formatPrint('$gd0'),/打印结果/);
});
test('only canvas picks reported by the page trigger the picked callback, and only while click linking is on',async t=>{
 let picks=0;const f=fixture(t,{call:(id,method,args)=>method==='snapshot'?snapshot({picks,digest:'p'+picks+args[0].link}):true});
 f.hub.setViewer('hierarchy',true);await flush();assert.equal(f.picked.length,0,'the first snapshot only records the baseline');
 await f.hub.refresh(true);assert.equal(f.picked.length,0);
 assert.equal(f.hub.state().options.link,true,'click linking is on by default');assert.equal(f.snapshots().at(-1)[2][0].link,true,'the page learns the link flag through the snapshot request');
 picks=1;await f.hub.refresh(true);assert.equal(f.picked.length,1);
 f.hub.update({link:false});await flush();assert.equal(f.hub.state().options.link,false);
 picks=2;await f.hub.refresh(true);assert.equal(f.picked.length,1,'linking off: no tab switching');
 f.hub.update({link:true});await flush();
 await f.hub.action('select',['node','s']);assert.equal(f.picked.length,1,'tree selections do not count as picks');
 picks=3;await f.hub.refresh(true);assert.equal(f.picked.length,2);
});
test('cancelling a capture clears the result, stops polling and tells the page to release its hooks',async t=>{
 t.mock.timers.enable({apis:['setInterval','Date']});
 const f=fixture(t,{call:(id,method)=>{if(method==='renderSnapshot')return {pending:true,error:'',result:null};if(method==='snapshot')return snapshot();return true;}});
 f.hub.setViewer('preview',true);await flush();await f.hub.action('capture',[]);await flush();assert.equal(f.hub.state().capturePending,true);
 f.hub.update({capture:false});await flush();assert.equal(f.hub.state().capturePending,false);assert.equal(f.hub.state().capture,null);assert.ok(f.calls.some(c=>c[1]==='captureCancel'));
 const renders=f.calls.filter(c=>c[1]==='renderSnapshot').length;t.mock.timers.tick(2500);await flush();assert.equal(f.calls.filter(c=>c[1]==='renderSnapshot').length,renders);
});
test('closing with a vanished page never throws and a closed hub refuses new viewers',async t=>{
 const published=[];const transport={frames:async()=>[{id:'main',name:'main',url:'http://localhost/'}],call:async(id,method)=>{if(method==='close')throw Error('请先打开调试预览，再打开运行时检查器');if(method==='snapshot')return snapshot();return true;}};
 const hub=new RuntimeInspectorHub(transport,state=>published.push(state),()=>{});
 hub.setViewer('hierarchy',true);await flush();assert.equal(hub.isClosed,false);
 hub.close();assert.equal(hub.isClosed,true);assert.equal(published.at(-1).closed,true,'the closed state is still published');
 assert.throws(()=>hub.setViewer('hierarchy',true),/已关闭/);
 const sync={frames:async()=>[],call:()=>{throw Error('同步抛出');}};const other=new RuntimeInspectorHub(sync,()=>{},()=>{});
 other.setViewer('x',true);await flush();other.setViewer('x',false);await flush();other.update({capture:false});other.close();
});
test('AI queries and actions discover the frame on demand and never start polling',async t=>{
 const f=fixture(t,{call:(id,method,args)=>{if(method==='hierarchy')return {sessionId:'s',nodes:[{uuid:'n1'}],total:1,offset:0};if(method==='inspect')return {sessionId:'s',uuid:args[0],components:[]};if(method==='print')return {kind:'节点',name:'n1'};if(method==='snapshot')return snapshot();return true;}});
 assert.deepEqual(await f.hub.query('hierarchy',[{contains:'n'}]),{sessionId:'s',nodes:[{uuid:'n1'}],total:1,offset:0});
 assert.equal(f.calls[0][0],'frames','the frame list is loaded before the first query');assert.deepEqual(f.calls[1],['main','hierarchy',[{contains:'n'}]]);
 assert.equal((await f.hub.query('inspect',['n1','s',{all:false}])).uuid,'n1');
 await f.hub.query('layout',[{limit:5}]);assert.ok(f.calls.some(c=>c[1]==='layout'&&c[2][0].limit===5),'layout reaches the page');
 await assert.rejects(f.hub.query('snapshot',[]),/不支持/);
 assert.equal(f.snapshots().length,0,'queries do not poll');assert.equal(f.published.length,0,'queries do not publish state');
 assert.equal(await f.hub.action('print',['n1','','s']),true);assert.deepEqual(f.hub.lastPrint(),{kind:'节点',name:'n1'});assert.deepEqual(f.outputs,[{kind:'节点',name:'n1'}]);
 f.setFrames([]);f.hub.close();await assert.rejects(f.hub.query('hierarchy',[{}]),/已关闭/);
});
test('viewer states are exposed for the status self-check',async t=>{
 const f=fixture(t);assert.deepEqual(f.hub.viewerStates(),{});
 f.hub.setViewer('hierarchy',true);f.hub.setViewer('properties',false);await flush();assert.deepEqual(f.hub.viewerStates(),{hierarchy:true,properties:false});
 f.hub.close();assert.deepEqual(f.hub.viewerStates(),{},'closing forgets the viewers');
});
test('a poll failure while the game loads shows a quiet waiting message that the next good poll clears',async t=>{
 const {t:text}=require('../dist/i18n'),coded=(message,code)=>Object.assign(Error(message),{code});
 let fail=coded('This frame has no loaded Cocos engine','ENGINE_NOT_LOADED');
 const f=fixture(t,{call:(id,method)=>{if(method==='snapshot'){if(fail)throw fail;return snapshot();}return true;}});
 f.hub.setViewer('hierarchy',true);await flush();
 assert.equal(f.hub.state().message,text('inspector.waitingGameLoad'));assert.equal(f.hub.state().waiting,true);
 fail=coded('The debug frame was removed; select another frame','FRAME_REMOVED');await f.hub.refresh(true);await flush();assert.equal(f.hub.state().waiting,true);
 fail=Error('The inspector supports Cocos Creator 3.8.x; found 3.7.4');await f.hub.refresh(true);await flush();
 assert.equal(f.hub.state().message,'The inspector supports Cocos Creator 3.8.x; found 3.7.4','a real failure is shown as it is');assert.equal(f.hub.state().waiting,false);
 fail=null;await f.hub.refresh(true);await flush();
 assert.equal(f.hub.state().message,'');assert.equal(f.hub.state().waiting,false);assert.equal(f.hub.state().snapshot.sessionId,'s');
});
