const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),{createRequire}=require('node:module');
// creator_screenshot through main.js with fake Electron windows: a panel that is not docked lives in its own window.
// main.js runs with __dirname inside a temporary extension root (static linked in), so it never reads or writes the repo's real .cache.
function extensionDist(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'gd-main-'));fs.mkdirSync(path.join(root,'dist'));fs.symlinkSync(path.resolve(__dirname,'../static'),path.join(root,'static'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return path.join(root,'dist');}
function load(t,windows){
 const filename=path.resolve(__dirname,'../dist/main.js'),req=createRequire(filename),exports={};let debug;
 const project=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'gd-capture-')));t.after(()=>fs.rmSync(project,{recursive:true,force:true}));
 fs.writeFileSync(path.join(project,'package.json'),JSON.stringify({uuid:'test-capture'}));
 const stubs={'./git':{GitDesk:class{task(){return undefined;}}},'./contexts':{WorkspaceContexts:class{constructor(){this.worktrees={ready:Promise.resolve()};}running(){return false;}}},'./mcp-bridge':{startMcpBridge:async(cache,root,handle,handler)=>{debug=handler;return {close:async()=>{}};}},electron:{BrowserWindow:{getAllWindows:()=>windows},session:{fromPartition:()=>({})},webContents:{fromId:()=>null}}};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{exports,__dirname:extensionDist(t),console:Object.assign(Object.create(console),{info(){},warn(){},error(){},log(){}}),process,Buffer,URL,setTimeout,clearTimeout,setInterval,clearInterval,
  require:Object.assign(name=>name in stubs?stubs[name]:req(name),{cache:req.cache}),
  Editor:{Project:{path:project},Panel:{has:async()=>false},Message:{broadcast(){},request:async()=>undefined}}});
 exports.load();t.after(()=>exports.unload());
 return {call:async(name,args)=>{await new Promise(resolve=>setImmediate(resolve));return debug(name,args);},project};
}
function win(title,size,panels){
 const shots=[];
 return {shots,isDestroyed:()=>false,isVisible:()=>true,getSize:()=>size,getTitle:()=>title,webContents:{getZoomFactor:()=>2,
  executeJavaScript:async()=>panels.map(name=>({name,x:10,y:20,width:300,height:200,visible:true,shown:true})),
  capturePage:async rect=>{shots.push(rect);return {toPNG:()=>Buffer.from('png:'+title),getSize:()=>({width:rect?rect.width:size[0],height:rect?rect.height:size[1]})};}}};
}
test('a panel in a floating window is captured from that window, in content pixels',async t=>{
 const main=win('main.scene - demo - Cocos Creator 3.8.8',[1400,900],['scene','hierarchy']),floating=win('Git Desk',[1200,760],['cocos-git-desk.default']);
 const f=load(t,[main,floating]);
 const shot=await f.call('creator_screenshot',{panel:'cocos-git-desk.default',fileName:'floating.png'});
 assert.equal(shot.title,'Git Desk');assert.deepEqual(JSON.parse(JSON.stringify(shot.bounds)),{x:20,y:40,width:600,height:400},'CSS box times the zoom factor');assert.equal(main.shots.length,0);assert.equal(floating.shots.length,1);
 assert.equal(fs.readFileSync(shot.file,'utf8'),'png:Git Desk');
 const whole=await f.call('creator_screenshot',{fileName:'whole.png'});assert.equal(whole.title,'main.scene - demo - Cocos Creator 3.8.8','no panel: the main editor window');
 await assert.rejects(f.call('creator_screenshot',{panel:'missing.panel',fileName:'none.png'}),/missing\.panel/);
});
