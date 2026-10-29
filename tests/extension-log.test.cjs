const test=require('node:test'),assert=require('node:assert/strict');
const {ExtensionLog}=require('../dist/extension-log');
function sink(){const lines=[];return {lines,log:(...a)=>lines.push(['log',...a]),info:(...a)=>lines.push(['info',...a]),warn:(...a)=>lines.push(['warn',...a]),error:(...a)=>lines.push(['error',...a]),debug:(...a)=>lines.push(['debug',...a])};}
test('the logger records what it forwards, formats like console, and never touches the global console',()=>{
 const target=sink();const log=new ExtensionLog(target,5,3);
 const original=console.info;
 log.console.info('[调试预览] 已定位：%s','db://assets/a.png');log.console.warn({a:1});log.console.error('boom',new Error('x'));
 assert.equal(console.info,original);
 assert.deepEqual(target.lines.map(l=>l[0]),['info','warn','error']);assert.deepEqual(target.lines[0].slice(1),['[调试预览] 已定位：%s','db://assets/a.png'],'arguments reach the sink untouched');
 const tail=log.tail();assert.equal(tail.entries.length,3);assert.equal(tail.entries[0].text,'[调试预览] 已定位：db://assets/a.png');assert.equal(tail.entries[1].text,'{ a: 1 }');assert.match(tail.entries[2].text,/boom Error: x/);
 assert.equal(tail.dropped,0);assert.equal(tail.oldestId,1);assert.equal(tail.newestId,3);
});
test('tail pages forward with a cursor, filters by level and text, and reports dropped entries',()=>{
 const log=new ExtensionLog(sink(),5,3);
 for(let i=1;i<=8;i++)log.console[i%2?'log':'warn']('line '+i);
 const latest=log.tail({limit:2});assert.deepEqual(latest.entries.map(e=>e.text),['line 7','line 8']);assert.equal(latest.hasMore,true);assert.equal(latest.dropped,3);assert.equal(latest.oldestId,4);
 const forward=log.tail({sinceId:4,limit:2});assert.deepEqual(forward.entries.map(e=>e.text),['line 5','line 6']);assert.equal(forward.nextSinceId,6);
 const next=log.tail({sinceId:forward.nextSinceId,limit:10});assert.deepEqual(next.entries.map(e=>e.text),['line 7','line 8']);assert.equal(next.hasMore,false);
 assert.deepEqual(log.tail({level:'warn'}).entries.map(e=>e.text),['line 4','line 6','line 8']);
 assert.deepEqual(log.tail({level:['warn','log'],query:'LINE 7'}).entries.map(e=>e.text),['line 7']);
 assert.equal(log.tail({level:'nope',limit:999}).entries.length,0,'unknown levels match nothing');
 assert.equal(log.tail({sinceId:0,limit:0}).entries.length,5,'limit is clamped to at least one and at most the buffer');
 assert.equal(log.record('info','x'.repeat(5000)).text.length,2000);
});
test('issues keep the most recent failures with their source',()=>{
 const log=new ExtensionLog(sink(),5,2);
 log.issue('runtimeInspectorState','请先打开调试预览');log.issue('panel:hierarchy','TypeError: x');log.issue('mcp:browser_debug_state','内嵌预览未连接');
 const issues=log.recentIssues();assert.deepEqual(issues.map(i=>i.source),['panel:hierarchy','mcp:browser_debug_state']);assert.equal(issues[1].message,'内嵌预览未连接');assert.ok(issues[0].id<issues[1].id);
 assert.equal(log.recentIssues(1).length,1);
});
