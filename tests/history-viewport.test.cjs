const test=require('node:test'),assert=require('node:assert/strict');
const {historyVisibleRange}=require('../dist/history-viewport');
const {layoutGraph}=require('../dist/graph');

test('history range covers viewport and stays bounded for 1000 and 5000 loaded commits',()=>{
 for(const count of [1000,5000])for(const height of [0,260,600])for(const top of [0,54,25000,count*54-600]){
  const [start,end]=historyVisibleRange(count,top,height,54);
  assert(start>=0&&end<=count&&end>=start);assert(end-start<=Math.ceil(Math.max(1,height)/54)+9);
  for(let index=0;index<count;index++)if((index+1)*54>top&&index*54<top+height)assert(index>=start&&index<end);
 }
 assert.deepEqual(historyVisibleRange(0,0,600,54),[0,0]);
});

test('fractional filtered-row heights remain covered at a page boundary',()=>{
 const count=5000,h=65.796875,top=999*h+10,[start,end]=historyVisibleRange(count,top,500,h);
 assert(start<=999);assert(end>=1007);assert(end-start<20);
});

test('graph prefix geometry is stable when older history is appended',()=>{
 const commits=Array.from({length:1000},(_,i)=>({sha:'c'+i,parents:i===999?['older']:i%13===0&&i<998?['c'+(i+1),'c'+(i+2)]:['c'+(i+1)]}));
 const first=layoutGraph(commits.slice(0,200)),next=layoutGraph(commits);
 assert.deepEqual(next.rows.slice(0,200),first.rows);
 const middle=next.rows.slice(450,470);
 assert(middle.some(row=>row.incoming));assert(middle.every(row=>row.edges.every(edge=>edge.from>=0&&edge.to>=0)));
});
