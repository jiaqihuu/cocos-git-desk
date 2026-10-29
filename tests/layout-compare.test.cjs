const test=require('node:test'),assert=require('node:assert/strict');
const {compareLayout}=require('../dist/layout-compare');
const node=(name,path,x,y,width,height,extra={})=>({uuid:name,name,path,x,y,width,height,depth:path.split('/').length,kind:'node',...extra});
const runtime=[
 node('Canvas','Canvas',0,0,1920,1080),
 node('title','Canvas/Login/title',100,40,300,60,{text:'Welcome',fontSize:32,color:'#ffffff'}),
 node('btn_ok','Canvas/Login/btn_ok',800,900,240,80),
 node('icon','Canvas/Login/left/icon',50,50,64,64),
 node('icon','Canvas/Login/right/icon',1800,50,64,64),
 node('lab_hint','Canvas/Login/lab_hint',100,120,400,30,{text:'Enter code',fontSize:20,color:'#ff8000ff'}),
 node('empty','Canvas/Login/empty',0,0,0,0),
];
test('design boxes are matched by name, deltas and attribute mismatches are reported, duplicates pick the nearest node',()=>{
 const design=[
  {name:'title',x:100,y:40,width:300,height:60,text:'Welcome',fontSize:32,color:'#FFFFFF'},
  {name:'Btn_OK',x:800,y:905,width:240,height:80},
  {name:'icon',x:1795,y:52,width:64,height:64},
  {name:'hint',x:100,y:120,width:400,height:30,text:'Enter your code',fontSize:24,color:'#ff8000'},
  {name:'missing',x:0,y:0,width:10,height:10},
 ];
 const out=compareLayout(runtime,design,{tolerance:2});
 assert.deepEqual(out.matched.map(m=>[m.design,m.path,m.how,m.dx,m.dy,m.dw,m.dh,m.within]),[
  ['title','Canvas/Login/title','exact',0,0,0,0,true],
  ['Btn_OK','Canvas/Login/btn_ok','case',0,-5,0,0,false],
  ['icon','Canvas/Login/right/icon','nearest',5,-2,0,0,false],
  ['hint','Canvas/Login/lab_hint','contains',0,0,0,0,true],
 ]);
 assert.deepEqual(out.matched[0].text,{design:'Welcome',runtime:'Welcome',same:true});assert.equal(out.matched[0].color.same,true);
 assert.deepEqual(out.matched[3].text,{design:'Enter your code',runtime:'Enter code',same:false});assert.equal(out.matched[3].fontSize.same,false);assert.equal(out.matched[3].color.same,true,'alpha ff equals no alpha');
 assert.deepEqual(out.unmatchedDesign,['missing']);
 assert.deepEqual(out.unmatchedRuntime.map(n=>n.path),['Canvas','Canvas/Login/left/icon'],'zero-size nodes are not listed');
 assert.deepEqual(out.summary,{designItems:5,runtimeNodes:7,matched:4,withinTolerance:2,offTolerance:2,textMismatches:1});
 assert.deepEqual(out.offTolerance.map(m=>m.design),['Btn_OK','icon']);
});
test('scale and offsets convert design canvas coordinates and path matching is exact',()=>{
 const out=compareLayout(runtime,[{name:'title',x:50,y:20,width:150,height:30}],{scale:2,tolerance:0});
 assert.deepEqual([out.matched[0].dx,out.matched[0].dy,out.matched[0].dw,out.matched[0].dh],[0,0,0,0]);
 const shifted=compareLayout(runtime,[{name:'title',x:0,y:0,width:300,height:60}],{offsetX:100,offsetY:40,tolerance:0});assert.equal(shifted.matched[0].within,true);
 const byPath=compareLayout(runtime,[{name:'Canvas/Login/left/icon',x:50,y:50,width:64,height:64}],{matchBy:'path'});
 assert.equal(byPath.matched[0].path,'Canvas/Login/left/icon');assert.equal(byPath.matched[0].how,'exact');
 const strict=compareLayout(runtime,[{name:'TITLE',x:100,y:40,width:300,height:60}],{ignoreCase:false});assert.deepEqual(strict.unmatchedDesign,['TITLE']);
});
