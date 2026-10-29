const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events');
const {EmbeddedPreview,allowedUrl}=require('../embedded.cjs');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gd-embedded-preview-'));fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({uuid:'test-project-0003'}));
 const session={},guest=new EventEmitter();guest.id=71;guest.url='about:blank';guest.session=session;guest.hostWebContents={getURL:()=> 'file:///creator/main.html'};guest.getType=()=> 'webview';guest.getURL=()=>guest.url;guest.isDestroyed=()=>false;guest.setWindowOpenHandler=handler=>guest.openHandler=handler;
 guest.debugger=new EventEmitter();let attached=false;guest.debugger.attach=()=>attached=true;guest.debugger.detach=()=>attached=false;guest.debugger.isAttached=()=>attached;guest.debugger.sendCommand=async(method)=>({result:{value:method}});
 const relay=new EmbeddedPreview(root,{session:{fromPartition:()=>session},webContents:{fromId:id=>id===71?guest:null}});
 t.after(async()=>{await relay.close();fs.rmSync(root,{recursive:true,force:true})});return{root,guest,relay};
}
test('dedicated guest rejects editor and wrong partition, restricts navigation and cleans listeners',async t=>{
 const {guest,relay}=fixture(t);await assert.rejects(relay.bind(99),/dedicated preview page/);
 guest.getType=()=> 'window';await assert.rejects(relay.bind(71),/dedicated preview page/);guest.getType=()=> 'webview';
 const original=guest.session;guest.session={};await assert.rejects(relay.bind(71),/dedicated preview page/);guest.session=original;
 await relay.bind(71);let blocked=false;guest.emit('will-navigate',{preventDefault(){blocked=true}},'https://other.test');assert.ok(blocked);assert.equal(guest.openHandler().action,'deny');
 assert.equal(allowedUrl('http://localhost:7456/?x=1',relay.options.url),true);assert.equal(allowedUrl('http://localhost:7456/other',relay.options.url),false);
 relay.release(12);assert.equal(relay.guest,guest);relay.release(71);assert.equal(guest.listenerCount('will-navigate'),0);assert.equal(guest.debugger.listenerCount('message'),0);assert.equal(guest.debugger.isAttached(),false);
});
test('page events reach in-process listeners only while the preview page is current; reloads bump the target',async t=>{
 const {guest,relay}=fixture(t);const seen=[];const stop=relay.onEvent((method,params)=>seen.push([method,params]));
 await relay.bind(71);guest.debugger.emit('message',{},'Runtime.consoleAPICalled',{type:'log'});assert.equal(seen.length,0,'about:blank is not the preview page');
 guest.url=relay.options.url;const target=relay.status().targetId;assert.ok(relay.status().connected);
 guest.debugger.emit('message',{},'Runtime.consoleAPICalled',{type:'log'});assert.deepEqual(seen,[['Runtime.consoleAPICalled',{type:'log'}]]);
 guest.debugger.emit('message',{},'Page.frameNavigated',{frame:{url:guest.url}});assert.notEqual(relay.status().targetId,target,'a main-frame navigation is a new target');
 guest.debugger.emit('message',{},'Page.frameNavigated',{frame:{url:guest.url,parentId:'top'}});assert.equal(seen.length,3);
 relay.onEvent(()=>{throw Error('listener failure');});relay.logger={error(){},log(){}};
 assert.doesNotThrow(()=>guest.debugger.emit('message',{},'Log.entryAdded',{}));assert.equal(seen.length,4,'a failing listener does not starve the others');
 stop();guest.debugger.emit('message',{},'Log.entryAdded',{});assert.equal(seen.length,4);
});
test('evaluate and screenshot run on the current page and surface page exceptions',async t=>{
 const {guest,relay}=fixture(t);await assert.rejects(relay.evaluate('1'),/not connected/);
 await relay.bind(71);guest.url=relay.options.url;const commands=[];
 guest.debugger.sendCommand=async(method,params)=>{commands.push([method,params]);if(method==='Runtime.evaluate')return params.expression==='boom'?{exceptionDetails:{exception:{description:'Error: boom\n    at <anonymous>:7:48'}}}:{result:{value:{answer:42}}};if(method==='Page.captureScreenshot')return {data:Buffer.from('png').toString('base64')};return {};};
 assert.deepEqual(await relay.evaluate('answer()'),{answer:42});assert.equal(commands[0][1].returnByValue,true);assert.equal(commands[0][1].awaitPromise,true);
 await assert.rejects(relay.evaluate('boom'),error=>error.message==='boom','only the message: no Error prefix, no code location');
 assert.equal((await relay.screenshot()).toString(),'png');assert.equal(commands.at(-1)[0],'Page.captureScreenshot');
});
test('reload and close invalidate in-flight commands',async t=>{
 const {guest,relay}=fixture(t);await relay.bind(71);guest.url=relay.options.url;
 let finish;guest.debugger.sendCommand=()=>new Promise(r=>finish=r);
 const pending=relay.command('Runtime.evaluate',{});
 guest.debugger.emit('message',{},'Page.frameNavigated',{frame:{url:guest.url}});finish({});await assert.rejects(pending,/changed/);
 const pending2=relay.command('Runtime.evaluate',{});relay.release();finish({});await assert.rejects(pending2,/changed|not connected/);
});
test('destroyed guest releases without touching native getters or detaching, and can rebind',async t=>{
 const {guest,relay}=fixture(t);await relay.bind(71);const debug=guest.debugger;let destroyed=false,detaches=0;
 guest.isDestroyed=()=>destroyed;
 Object.defineProperty(guest,'debugger',{configurable:true,get(){if(destroyed)throw TypeError('Object has been destroyed');return debug;}});
 Object.defineProperty(guest,'id',{configurable:true,get(){if(destroyed)throw TypeError('Object has been destroyed');return 71;}});
 debug.isAttached=()=>{if(destroyed)throw TypeError('Object has been destroyed');return true;};debug.detach=()=>{detaches++;};
 destroyed=true;
 assert.doesNotThrow(()=>guest.emit('destroyed'));assert.equal(relay.guest,null);
 assert.equal(debug.listenerCount('message'),0);assert.equal(guest.listenerCount('will-navigate'),0);assert.equal(detaches,0);
 assert.equal(relay.release(71),false);assert.equal(relay.status().connected,false);
 destroyed=false;await relay.bind(71);assert.equal(debug.listenerCount('message'),1);assert.equal(relay.release(71),true);assert.equal(detaches,1);
});
test('destroying during bind rejects cleanly without masking the lifecycle error',async t=>{
 const {guest,relay}=fixture(t);const debug=guest.debugger;let finish,destroyed=false;
 debug.sendCommand=()=>new Promise(resolve=>finish=resolve);
 guest.isDestroyed=()=>destroyed;Object.defineProperty(guest,'debugger',{get(){if(destroyed)throw TypeError('Object has been destroyed');return debug;}});
 const pending=relay.bind(71);destroyed=true;guest.emit('destroyed');finish({});
 await assert.rejects(pending,/preview panel was closed/);assert.equal(debug.listenerCount('message'),0);
});
test('forwards live preview console levels once, with source, without CDP replay duplicates',async t=>{
 const {guest,relay}=fixture(t),logs=[];
 relay.logger=Object.fromEntries(['log','info','debug','warn','error'].map(level=>[level,text=>logs.push({level,text})]));
 await relay.bind(71);guest.url=relay.options.url;
 for(const [level,message]of [[0,'debug'],[1,'hello'],[2,'warning'],[3,'Uncaught Error: broken']])guest.emit('console-message',{},level,message,12,'http://localhost:7456/app.js');
 assert.deepEqual(logs.map(log=>log.level),['debug','log','warn','error']);assert.match(logs[1].text,/\[Git Desk\] hello/);assert.match(logs[1].text,/app.js:12/);
 guest.debugger.emit('message',{},'Runtime.consoleAPICalled',{type:'log',args:[{type:'string',value:'hello'}]});
 assert.equal(logs.length,4);
 await relay.bind(71);guest.emit('console-message',{},1,'hello',12,'http://localhost:7456/app.js');assert.equal(logs.length,5);
 guest.emit('console-message',{},1,'%c%s%s%s:%s color:#0091aaff; [17:24:08:171] [网络日志] [SampleService] 开始增量拉取',12,'http://localhost:7456/app.js');assert.deepEqual(logs.at(-1),{level:'info',text:'[Git Desk] [17:24:08:171] [网络日志] [SampleService] 开始增量拉取\n    http://localhost:7456/app.js:12'},'DevTools format strings are stripped and the game tag picks the level');logs.pop();
 guest.url='about:blank';guest.emit('console-message',{},1,'not preview',0,'');assert.equal(logs.length,5);
 relay.release(71);assert.equal(guest.listenerCount('console-message'),0);
 guest.url=relay.options.url;guest.emit('console-message',{},1,'after close',0,'');assert.equal(logs.length,5);
 await relay.bind(71);guest.emit('console-message',{},1,'new session',0,'');assert.equal(logs.length,6);
});
test('console format stripping only touches a leading DevTools format string',()=>{
 const {plainConsoleText}=require('../embedded.cjs');
 assert.equal(plainConsoleText('%c%s%s%s:%s color:#000000; [17:24:07:141] [标准日志] 内容'),'[17:24:07:141] [标准日志] 内容');
 assert.equal(plainConsoleText('%c%s%s%s:%s%o color:#0091aaff; [Network Send][RPC] svc.catalog.v1.Catalog/Get [object Object]'),'[Network Send][RPC] svc.catalog.v1.Catalog/Get [object Object]');
 assert.equal(plainConsoleText('%cstyled font-weight:bold;color:red; text'),'text');
 assert.equal(plainConsoleText('%s only 42'),'only 42','without a style block only the format token goes');
 assert.equal(plainConsoleText('progress 50% done'),'progress 50% done');
 assert.equal(plainConsoleText('%'),'%');
});
test('game log tags map to Creator console levels while real warn/error levels win',()=>{
 const {consoleMethod}=require('../embedded.cjs');
 assert.equal(consoleMethod(1,'[17:24:07:141] [错误日志] [x.ts->f] 失败'),'error');
 assert.equal(consoleMethod(1,'[17:24:07:141] [警告日志] 注意'),'warn');
 assert.equal(consoleMethod(1,'[17:24:07:141] [标准日志] 普通'),'log');assert.equal(consoleMethod(1,'[17:24:07:141] [业务日志] 普通'),'log');assert.equal(consoleMethod(1,'[17:24:07:141] [视图日志] 普通'),'log');
 for(const tag of ['网络日志','数据日志','配置日志','热更日志','网络代理日志','棋牌引擎日志'])assert.equal(consoleMethod(1,'[17:24:07:141] ['+tag+'] 条目'),'info',tag);
 assert.equal(consoleMethod(1,'[配置日志] 没有时间戳也能识别'),'info');
 assert.equal(consoleMethod(1,'plain message'),'log');assert.equal(consoleMethod(0,'[错误日志] verbose'),'error');
 assert.equal(consoleMethod(2,'[标准日志] 页面自己的 warn'),'warn');assert.equal(consoleMethod(3,'[标准日志] 页面自己的 error'),'error');
 assert.equal(consoleMethod(1,'[Git Desk] $gd0 = 节点 bg'),'log','non-game brackets are untouched');
});
test('page metrics come from the live page and are absent while disconnected',async t=>{
 const {guest,relay}=fixture(t);assert.equal(await relay.pageMetrics(),null);
 await relay.bind(71);guest.url=relay.options.url;let expression='';guest.debugger.sendCommand=async(method,params)=>{expression=params?.expression||'';return {result:{value:{width:428,height:926,toolbar:50}}};};
 assert.deepEqual(await relay.pageMetrics(),{width:428,height:926,toolbar:50});assert.match(expression,/#GameDiv/);
 guest.debugger.sendCommand=async()=>({result:{value:{width:'x'}}});assert.equal(await relay.pageMetrics(),null);
});
test('partition, preview url and page control object come from the project configuration',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gd-embedded-config-'));fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({uuid:'test-project-0004'}));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const plain=new EmbeddedPreview(root,{});assert.equal(plain.partition,'persist:cocos-git-desk-test-project-0004','persist: keeps the preview account across Creator restarts');assert.equal(plain.options.url,'http://localhost:7456/');assert.equal(plain.controlName,'__COCOS_GIT_DESK_PREVIEW_CONTROL__');assert.deepEqual(plain.engineVersions,['3.8.x']);
 const custom=new EmbeddedPreview(root,{},console,{url:'http://127.0.0.1:7457/',projectId:'override',controlName:'__MY_CONTROL__',engineVersions:['3.7.x']});
 assert.equal(custom.partition,'persist:cocos-git-desk-override');
 assert.throws(()=>plain.inspectorCall('main','snapshot',[]),error=>error.code==='PREVIEW_NOT_CONNECTED','a call before the page connects is a loading-phase wait');assert.equal(custom.options.url,'http://127.0.0.1:7457/');assert.deepEqual(custom.engineVersions,['3.7.x']);
 const expressions=[];custom.status=()=>({present:true,connected:true,targetId:'t',generation:1});custom.evaluate=async expression=>{expressions.push(expression);return {recording:true};};
 assert.deepEqual((await custom.pageStatus()).recording,{recording:true});assert.ok(expressions[0].includes('window["__MY_CONTROL__"]'));
});
