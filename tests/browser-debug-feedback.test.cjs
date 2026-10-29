const test=require('node:test'),assert=require('node:assert/strict');
const {BrowserDebugFeedback,TransientNotice}=require('../dist/browser-debug-feedback');
test('reports progress immediately, prevents duplicate clicks, and keeps completion',async()=>{
 const states=[];const f=new BrowserDebugFeedback((...s)=>states.push(s));let finish,count=0;
 const pending=f.run('打开浏览器',()=>{count++;return new Promise(r=>finish=r)});
 assert.deepEqual(states,[['打开浏览器…',true,false]]);await f.run('重复',async()=>{count++;return 'wrong'});assert.equal(count,1);
 finish('已连接');await pending;assert.deepEqual(states.at(-1),['已连接',false,false]);f.dispose();
});
test('shows rejected and synchronous errors and allows subsequent actions',async()=>{
 const states=[];const f=new BrowserDebugFeedback((...s)=>states.push(s));
 await f.run('开始记录',()=>{throw Error('消息未注册')});assert.deepEqual(states.at(-1),['开始记录失败：消息未注册',false,true],'failures are flagged');
 await f.run('开始记录',async()=>{throw Error('端口未就绪')});assert.match(states.at(-1)[0],/端口未就绪/);
 await f.run('停止记录',async()=>'已关闭');assert.deepEqual(states.at(-1),['已关闭',false,false]);f.dispose();
});
test('panel destruction ignores late completion',async()=>{
 const states=[];const f=new BrowserDebugFeedback((...s)=>states.push(s));let done;
 const pending=f.run('打开',()=>new Promise(r=>done=r));f.dispose();done('late');await pending;assert.equal(states.length,1);
});

test('missing Creator registration explains recovery',async()=>{const states=[];const f=new BrowserDebugFeedback((...s)=>states.push(s));await f.run('开启',async()=>{throw Error('Message does not exist: cocos-git-desk - browser-debug-set-enabled')});assert.match(states.at(-1)[0],/保存工作后重启 Creator/);f.dispose()});

test('transient notice closes successes after 3 s and failures after 10 s, keeps pending progress, pauses on hover',t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const el=new EventTarget();el.hidden=true;el.textContent='';const notice=new TransientNotice(el);
 notice.show('正在打开…',true);assert.equal(el.hidden,false);t.mock.timers.tick(60000);assert.equal(el.hidden,false,'pending progress stays');
 notice.show('已打开',false,false);t.mock.timers.tick(2999);assert.equal(el.hidden,false);t.mock.timers.tick(1);assert.equal(el.hidden,true,'success closes after 3 s');
 notice.show('打开失败：x',false,true);t.mock.timers.tick(9999);assert.equal(el.hidden,false);t.mock.timers.tick(1);assert.equal(el.hidden,true,'failure closes after 10 s');
 notice.show('已打开',false,false);t.mock.timers.tick(2000);el.dispatchEvent(new Event('pointerenter'));t.mock.timers.tick(20000);assert.equal(el.hidden,false,'hover keeps it open');
 el.dispatchEvent(new Event('pointerleave'));t.mock.timers.tick(2999);assert.equal(el.hidden,false,'leaving restarts the countdown');t.mock.timers.tick(1);assert.equal(el.hidden,true);
 notice.show('已打开',false);notice.hide();assert.equal(el.hidden,true);el.hidden=false;t.mock.timers.tick(5000);assert.equal(el.hidden,false,'hide cancels the pending close');
 notice.show('已打开',false);notice.dispose();t.mock.timers.tick(5000);assert.equal(el.hidden,false,'dispose stops the timer');
 el.dispatchEvent(new Event('pointerleave'));t.mock.timers.tick(5000);assert.equal(el.hidden,false,'dispose removes hover listeners');
});
