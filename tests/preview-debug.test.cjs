const test=require('node:test'),assert=require('node:assert/strict');
const { windows, portableName, exoticNames, posixModes, linkTarget } = require('./platform.cjs');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {PreviewDebugService,validateToolArgs}=require('../dist/preview-debug');
const {toolCatalogue,defaultConfig}=require('../dist/config');
const tools=toolCatalogue();
const projectId='test-project-0001';
function fixture(t,{connected=true,bridge=defaultConfig().bridge,identity={},configError=null}={}){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'gd-preview-debug-'));
 const root=path.join(base,'project');fs.mkdirSync(root);fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({uuid:projectId}));
 const home=path.join(base,'home');fs.mkdirSync(home);
 const settings={projectId,bridge,configError,stateDir:path.join(home,'state'),outputDir:path.join(home,'exports')};
 const evaluations=[],listeners=new Set();let generation=1;
 // environment answers the control object's identity(); observerOff makes the debug object refuse like a disabled observer.
 const page={options:{url:'http://localhost:7456/',root},environment:'dev',status:()=>({present:true,connected,targetId:connected?'embedded-71-'+generation:null,generation}),
  evaluate:async expression=>{evaluations.push(expression);if(!connected)throw Error('内嵌预览未连接');if(page.fail)throw Error(page.fail);
   if(expression.includes(' in identity))')){if(page.environmentError)throw Error(page.environmentError);return page.environmentReply!==undefined?page.environmentReply:{environment:page.environment};}
   if(expression.includes('const control = window['+JSON.stringify(bridge.controlName)+']'))return {enabled:true,applied:true,updatedAt:1};
   if(page.observerOff&&expression.includes('window['+JSON.stringify(bridge.debugName)+']'))throw Error('调试采集未开启；先调用 browser_debug_enable');
   const bridgeCall=/api\["(\w+)"\]\(/.exec(expression);
   if(bridgeCall){
    const method=bridgeCall[1];const data=method==='events'?{entries:page.entries??[{time:1,sequence:1}],pending:[]}:method==='hierarchy'?{nodes:[{uuid:'n1'}]}:method==='uiOpen'?{uiid:2,open:true}:method==='language'?Promise.resolve({current:'en'}):{method};
    return {identity:{apiVersion:bridge.apiVersion,projectId,preview:true,sessionId:'page-1',integration:'project-preview',...identity},data:await data};}
   return null;},
  screenshot:async()=>Buffer.from('png'),onEvent:listener=>{listeners.add(listener);return ()=>listeners.delete(listener);},reload:()=>{generation++;for(const l of listeners)l('Page.frameNavigated',{frame:{url:'http://localhost:7456/'}});},emit:(m,p)=>{for(const l of listeners)l(m,p);}};
 const runtimeCalls=[];const service=new PreviewDebugService(page,async(name,args)=>{runtimeCalls.push([name,args]);return {name};},tools,settings);
 t.after(()=>{service.close();fs.rmSync(base,{recursive:true,force:true});});
 return {service,page,evaluations,runtimeCalls,home,root,settings};
}
test('tool arguments are validated against the catalog before anything runs',()=>{
 const schema=tools.find(t=>t.name==='browser_debug_inspect_node');
 assert.throws(()=>validateToolArgs(schema,{uuid:'a'}),/缺少参数：sessionId/);
 assert.throws(()=>validateToolArgs(schema,{uuid:'a',sessionId:'s',extra:1}),/未知参数/);
 assert.throws(()=>validateToolArgs(schema,{uuid:'',sessionId:'s'}),/参数无效：uuid/);
 assert.throws(()=>validateToolArgs(tools.find(t=>t.name==='browser_debug_events'),{limit:0}),/整数：limit/);
 assert.throws(()=>validateToolArgs(tools.find(t=>t.name==='browser_debug_events'),{levels:[1]}),/字符串数组/);
 assert.throws(()=>validateToolArgs(schema,[]),/JSON 对象/);
 assert.deepEqual(validateToolArgs(schema,{uuid:'a',sessionId:'s',includeText:false}),{uuid:'a',sessionId:'s',includeText:false});
});
test('preference is saved per machine, pushed to the page, re-applied after reload and adopted from a newer page choice',async t=>{
 const f=fixture(t);
 assert.deepEqual(f.service.status(),{enabled:false,applied:false,lastError:null,waiting:null,noBridge:false});
 const message=await f.service.setEnabled(true);assert.match(message,/已开启/);assert.deepEqual(f.service.status(),{enabled:true,applied:true,lastError:null,waiting:null,noBridge:false});
 const file=fs.readdirSync(f.settings.stateDir)[0];assert.match(file,/^observer-[0-9a-f]{64}\.json$/);const saved=JSON.parse(fs.readFileSync(path.join(f.settings.stateDir,file),'utf8'));assert.equal(saved.enabled,true);if(posixModes)assert.equal((fs.statSync(path.join(f.settings.stateDir,file)).mode&0o777),0o600);
 assert.ok(f.evaluations.at(-1).includes('control.setEnabled(true,'));
 const count=f.evaluations.length;await f.service.reconcile();assert.equal(f.evaluations.length,count,'applied pages are not re-injected');
 f.page.reload();assert.equal(f.service.status().applied,false);await f.service.reconcile();assert.equal(f.service.status().applied,true);assert.equal(f.evaluations.length,count+1);
 await f.service.reconcile(false,{enabled:false,updatedAt:saved.updatedAt+10});assert.equal(f.service.status().enabled,false,'a newer choice made in the page wins');
 assert.ok(f.evaluations.at(-1).includes('control.setEnabled(false,'));
 f.page.fail='页面尚未加载';const pending=await f.service.setEnabled(true);assert.match(pending,/尚未确认/);assert.equal(f.service.status().lastError,'页面尚未加载');
 const fresh=new PreviewDebugService(f.page,async()=>null,tools,f.settings);t.after(()=>fresh.close());f.page.fail=undefined;await fresh.reconcile();assert.equal(fresh.status().enabled,true,'the saved choice is restored by a new service');
});
test('tools dispatch to the capture, the page bridge and the runtime inspector; export writes a complete package',async t=>{
 const f=fixture(t);
 await assert.rejects(f.service.call('browser_debug_nope',{}),/未知工具/);
 assert.deepEqual(await f.service.call('runtime_inspector_hierarchy',{contains:'a'}),{name:'runtime_inspector_hierarchy'});assert.deepEqual(f.runtimeCalls,[['runtime_inspector_hierarchy',{contains:'a'}]]);
 const started=await f.service.call('browser_debug_start',{});assert.equal(started.active,true);assert.equal(started.connected,true);
 f.page.emit('Runtime.exceptionThrown',{exceptionDetails:{text:'Error X'}});
 assert.equal((await f.service.call('browser_debug_events',{})).events.length,1);
 assert.equal((await f.service.call('browser_debug_mark',{label:'step'})).marker.message,'step');
 const hierarchy=await f.service.call('browser_debug_hierarchy',{contains:'btn',activeOnly:true});assert.deepEqual(hierarchy.data,{nodes:[{uuid:'n1'}]});assert.ok(f.evaluations.at(-1).includes('api["hierarchy"](...[{"contains":"btn","activeOnly":true}])'));
 await f.service.call('browser_debug_inspect_node',{uuid:'n1',sessionId:'page-1'});assert.ok(f.evaluations.at(-1).includes('api["inspect"](...["n1","page-1",false])'));
 await f.service.call('browser_debug_timeline',{afterSequence:3});assert.ok(f.evaluations.at(-1).includes('api["events"](...[3,200])'));
 const identity=await f.service.call('browser_debug_identity',{});assert.equal(identity.identity.sessionId,'page-1');assert.equal(identity.preference.enabled,false);
 const exported=await f.service.call('browser_debug_export',{screenshot:true});assert.equal(exported.complete,true);assert.ok(exported.directory.startsWith(fs.realpathSync.native(f.settings.outputDir)+path.sep));assert.match(path.basename(exported.directory),/^evidence-/);
 const evidence=JSON.parse(fs.readFileSync(path.join(exported.directory,'evidence.json'),'utf8'));assert.equal(evidence.identity.identity.sessionId,'page-1');assert.equal(evidence.browserCapture.exportedEvents,2);assert.equal(evidence.timeline.length,3);
 assert.deepEqual(fs.readdirSync(exported.directory).sort(),['README.md','evidence.json','manifest.json','screenshot.png']);
 const status=await f.service.call('browser_debug_status',{});assert.equal(status.bufferedEvents,2);assert.equal(status.preference.enabled,false);
 const stopped=await f.service.call('browser_debug_stop',{});assert.equal(stopped.active,false);assert.match(stopped.message,/关闭/);
});
test('command tools reach the page bridge with their arguments, await asynchronous results and validate objects',async t=>{
 const f=fixture(t);
 assert.deepEqual((await f.service.call('browser_debug_ui_list',{})).data,{method:'uiList'});assert.ok(f.evaluations.at(-1).includes('await Promise.race'));assert.ok(f.evaluations.at(-1).includes('api["uiList"](...[])'));
 assert.deepEqual((await f.service.call('browser_debug_ui_open',{name:'HallView',args:{tab:1}})).data,{uiid:2,open:true});assert.ok(f.evaluations.at(-1).includes('api["uiOpen"](...["HallView",{"tab":1}])'));
 await f.service.call('browser_debug_ui_open',{uiid:9});assert.ok(f.evaluations.at(-1).includes('api["uiOpen"](...[9])'));
 await f.service.call('browser_debug_ui_close',{name:'HallView'});assert.ok(f.evaluations.at(-1).includes('api["uiClose"](...["HallView"])'));
 assert.deepEqual((await f.service.call('browser_debug_language',{code:'en'})).data,{current:'en'},'promise results are awaited in the page');
 await f.service.call('browser_debug_language',{});assert.ok(f.evaluations.at(-1).includes('api["language"](...[])'));
 await f.service.call('browser_debug_mock_set',{transport:'rpc',name:'pkg.x/Get',response:{a:1},once:true});assert.ok(f.evaluations.at(-1).includes('api["mockSet"](...[{"transport":"rpc","name":"pkg.x/Get","response":{"a":1},"once":true}])'));
 await f.service.call('browser_debug_mock_clear',{transport:'rpc',name:'pkg.x/Get'});assert.ok(f.evaluations.at(-1).includes('api["mockClear"](...["rpc","pkg.x/Get"])'));
 await f.service.call('browser_debug_mock_clear',{transport:'http'});assert.ok(f.evaluations.at(-1).includes('api["mockClear"](...["http"])'),'a transport alone clears only that transport');
 await f.service.call('browser_debug_mock_clear',{});assert.ok(f.evaluations.at(-1).includes('api["mockClear"](...[])'));
 const sent=f.evaluations.length;await assert.rejects(f.service.call('browser_debug_mock_clear',{name:'pkg.x/Get'}),/按名字清除假响应需要同时给 transport（rpc 或 http）/);assert.equal(f.evaluations.length,sent,'a name without its transport never reaches the page');
 await f.service.call('browser_debug_mock_list',{});assert.ok(f.evaluations.at(-1).includes('api["mockList"](...[])'));
 await assert.rejects(f.service.call('browser_debug_mock_set',{transport:'ws',name:'x'}),/参数无效：transport/);
 await assert.rejects(f.service.call('browser_debug_mock_set',{transport:'rpc',name:'x',response:[1]}),/JSON 对象：response/);
 await assert.rejects(f.service.call('browser_debug_ui_open',{name:'HallView',args:{big:'x'.repeat(17000)}}),/16 KB/);
 await assert.rejects(f.service.call('browser_debug_mock_set',{transport:'rpc',name:'x',delayMs:20000}),/整数：delayMs/);
 const schema=tools.find(t=>t.name==='browser_debug_ui_open');assert.equal(schema.annotations.readOnlyHint,false);assert.equal(tools.find(t=>t.name==='browser_debug_ui_list').annotations.readOnlyHint,true);
 const timeout=new PreviewDebugService({...f.page,evaluate:async expression=>{if(expression.includes(' in identity))'))return {environment:'dev'};throw Error('预览桥调用超时（20 秒）');}},async()=>null,tools,f.settings);t.after(()=>timeout.close());
 await assert.rejects(timeout.call('browser_debug_language',{code:'en'}),/^Error: 预览桥调用超时/);
});
test('bridge calls are refused while the preview is disconnected or the page bridge is missing',async t=>{
 const f=fixture(t,{connected:false});
 await assert.rejects(f.service.call('browser_debug_state',{}),/未连接/);
 assert.deepEqual(await f.service.call('browser_debug_connect',{}),{present:true,connected:false,targetId:null,generation:1,...require('../dist/preview-capture').PreviewCapture.prototype.status.call(f.service.capture),preference:{enabled:false,applied:false,lastError:null,waiting:null,noBridge:false}});
 const g=fixture(t);g.page.evaluate=async()=>null;await assert.rejects(g.service.call('browser_debug_state',{}),/无效结果/);
});
test('bridge object names, api version and project id come from the settings and are inlined into the page checks',async t=>{
 const bridge={controlName:'__MY_CONTROL__',debugName:'__MY_DEBUG__',apiVersion:'my-bridge/2'};
 const f=fixture(t,{bridge});
 await f.service.setEnabled(true);assert.ok(f.evaluations.at(-1).includes('window["__MY_CONTROL__"]'));assert.ok(f.evaluations.at(-1).includes('"my-bridge/2"'));
 await f.service.call('browser_debug_state',{});assert.ok(f.evaluations.at(-1).includes('window["__MY_DEBUG__"]'));assert.ok(f.evaluations.at(-1).includes(JSON.stringify(projectId)));
 const legacy=fixture(t,{identity:{projectId:undefined,projectUuid:projectId}});assert.equal((await legacy.service.call('browser_debug_state',{})).identity.projectUuid,projectId,'a bridge that still reports projectUuid is accepted');
 assert.ok(!f.evaluations.some(item=>/__AMSA|amsa-preview/.test(item)));
 // A page without any project bridge gets the "bridge missing" message, a page with one gets "enable first".
 const call=f.evaluations.at(-1);assert.ok(call.includes('window["__MY_CONTROL__"] ?'));assert.ok(call.includes('__MY_CONTROL__'));assert.ok(call.includes(JSON.stringify(require('../dist/i18n').t('preview.bridgeNotEnabled'))));
});
test('startup waits are reported as waiting by message id, and a missing bridge only right after a page load',async t=>{
 const f=fixture(t),service=f.service,{t:text}=require('../dist/i18n'),{bridgeGraceMs}=require('../dist/preview-debug');
 for(const wait of [text('preview.waitingConnection'),text('preview.bridgeWaitingGame')]){service.lastError=wait;const s=service.status();assert.equal(s.lastError,null);assert.equal(s.waiting,wait);}
 const missing=text('preview.bridgeControlMissing',{name:f.settings.bridge.controlName});
 service.lastError=missing;assert.equal(service.status().waiting,missing,'shortly after a page load the bridge script may not be there yet');
 service.navigatedAt=Date.now()-bridgeGraceMs-1;const late=service.status();assert.equal(late.waiting,null);assert.equal(late.lastError,null,'a project without a bridge is a state, not an error');assert.equal(late.noBridge,true);
 f.page.reload();assert.equal(service.status().waiting,missing,'a new page load restarts the grace period');
 service.lastError=text('preview.bridgeMismatch');const mismatch=service.status();assert.equal(mismatch.lastError,text('preview.bridgeMismatch'));assert.equal(mismatch.waiting,null);
});
test('page commands run only on a configured test environment and fail closed; listing, reading the language and clearing mocks stay available', async t => {
 const f=fixture(t);const sent=method=>f.evaluations.some(e=>e.includes('api["'+method+'"]'));
 const query=()=>f.evaluations.find(e=>e.includes(' in identity))'));
 await f.service.call('browser_debug_ui_open',{name:'HallView'});assert.ok(sent('uiOpen'),'dev is a default test environment');
 assert.ok(query().includes('window["__COCOS_GIT_DESK_PREVIEW_CONTROL__"]')&&!query().includes('__COCOS_GIT_DESK_DEBUG__'),'the environment comes from the control object, not the observer');
 f.evaluations.length=0;
 const commands=[['browser_debug_ui_open',{name:'HallView'},'打开界面','uiOpen'],['browser_debug_ui_close',{uiid:2},'关闭界面','uiClose'],['browser_debug_language',{code:'en'},'切换语言','language'],['browser_debug_mock_set',{transport:'rpc',name:'pkg.x/Get',response:{a:1}},'设置假响应','mockSet']];
 for(const [setup,reason] of [[()=>{f.page.environment='prod';},/预览运行环境是 prod，不在允许的测试环境（dev, test, staging）之列，已拒绝/],
  [()=>{f.page.environment='Dev';},/预览运行环境是 Dev/],
  [()=>{f.page.environment=null;},/游戏还没有报告运行环境，已拒绝/],[()=>{f.page.environment='';},/游戏还没有报告运行环境/],
  [()=>{f.page.environmentError='预览桥的 identity() 没有报告运行环境字段 environment';},/无法确认预览的运行环境（预览桥的 identity\(\) 没有报告运行环境字段 environment），为避免误操作正式环境已拒绝/],
  [()=>{f.page.environmentReply=null;},/无法确认预览的运行环境（预览桥返回无效结果）/]]){
  for(const [name,args,action] of commands){
   f.page.environment='dev';f.page.environmentError=undefined;f.page.environmentReply=undefined;setup();
   await assert.rejects(f.service.call(name,args),error=>reason.test(error.message)&&error.message.includes('已拒绝'+action),name+' '+reason);
  }
 }
 assert.ok(!['uiOpen','uiClose','language','mockSet'].some(sent),'refused commands never reach the page bridge');
 f.page.environment='prod';f.page.environmentError=undefined;f.page.environmentReply=undefined;
 assert.deepEqual((await f.service.call('browser_debug_ui_list',{})).data,{method:'uiList'});
 assert.deepEqual((await f.service.call('browser_debug_language',{})).data,{current:'en'},'reading the language is not a command');
 assert.deepEqual((await f.service.call('browser_debug_mock_list',{})).data,{method:'mockList'});
 assert.deepEqual((await f.service.call('browser_debug_mock_clear',{transport:'rpc'})).data,{method:'mockClear'},'removing fake responses is always allowed');
});
test('the environment field and the allowed environments come from the settings; "*" accepts any reported environment', async t => {
 const bridge={...defaultConfig().bridge,environmentField:'runEnv',testEnvironments:['dev','pre']};
 const f=fixture(t,{bridge});f.page.environment='pre';
 await f.service.call('browser_debug_mock_set',{transport:'http',name:'/api/x',response:{a:1}});
 const query=f.evaluations.find(e=>e.includes(' in identity))'));assert.ok(query.includes('!("runEnv" in identity))')&&query.includes('identity["runEnv"]'));
 f.page.environment='staging';await assert.rejects(f.service.call('browser_debug_ui_open',{name:'HallView'}),/staging，不在允许的测试环境（dev, pre）之列/);
 const any=fixture(t,{bridge:{...defaultConfig().bridge,testEnvironments:['*']}});any.page.environment='prod';
 await any.service.call('browser_debug_ui_open',{name:'HallView'});assert.ok(any.evaluations.some(e=>e.includes('api["uiOpen"]')));
 any.page.environment=null;await assert.rejects(any.service.call('browser_debug_ui_open',{name:'HallView'}),/游戏还没有报告运行环境/,'"*" still refuses an unreported environment');
});
test('page commands do not need the observer: the environment check reads only the control object', async t => {
 const f=fixture(t);f.page.observerOff=true;
 await assert.rejects(f.service.call('browser_debug_ui_open',{name:'HallView'}),/调试采集未开启/,'the command itself still needs the observer');
 assert.ok(f.evaluations.some(e=>e.includes(' in identity))')),'the environment was read before the observer refused');
});
test('the evidence export strips captured request and response bodies, as its note says', async t => {
 const f=fixture(t);
 f.page.entries=[{time:1,sequence:1,kind:'http-end',requestId:1,name:'POST /api/reset',outcome:'success',bodies:{request:'{"email":"player@example.com","code":"493817"}',response:'{"token":"[redacted]"}'}},{time:2,sequence:2,kind:'command',name:'uiOpen gui/hall/HallView'}];
 const exported=await f.service.call('browser_debug_export',{screenshot:false});
 const text=fs.readFileSync(path.join(exported.directory,'evidence.json'),'utf8'),evidence=JSON.parse(text);
 assert.doesNotMatch(text,/493817|player@example\.com|"bodies"/,'no body content in the package');
 assert.deepEqual(evidence.trace.entries.map(e=>[e.sequence,e.name,e.bodiesOmitted??false]),[[1,'POST /api/reset',true],[2,'uiOpen gui/hall/HallView',false]]);
 assert.deepEqual(evidence.timeline.filter(e=>e.source==='bridge').map(e=>e.event.bodiesOmitted??false),[true,false]);
 assert.ok(evidence.notes.some(note=>/captured request\/response bodies are omitted/.test(note)));
 assert.equal(f.page.entries[0].bodies.request.includes('493817'),true,'the live timeline itself is untouched');
});
test('an unusable git-desk.config.json refuses page commands instead of falling back to the default environments', async t => {
 const f=fixture(t,{configError:'git-desk.config.json：未知字段 clients.cursor'});f.page.environment='dev';
 for(const [name,args] of [['browser_debug_ui_open',{name:'HallView'}],['browser_debug_language',{code:'en'}],['browser_debug_mock_set',{transport:'rpc',name:'pkg.x/Get',response:{a:1}}]])
  await assert.rejects(f.service.call(name,args),/git-desk\.config\.json 无法使用（git-desk\.config\.json：未知字段 clients\.cursor），为避免按默认环境列表误操作，已拒绝/);
 assert.ok(!f.evaluations.some(e=>e.includes(' in identity))')||/api\["(uiOpen|language|mockSet)"\]/.test(e)),'nothing reaches the page');
 assert.deepEqual((await f.service.call('browser_debug_mock_clear',{})).data,{method:'mockClear'},'clearing mocks stays available');
});
