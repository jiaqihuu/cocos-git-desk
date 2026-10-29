const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),{createRequire}=require('node:module');
// main.js runs inside Creator; a vm with stub Editor, Git and MCP modules is enough to exercise how the preview URL is chosen.
function load(t,{config,previewUrl,urlError}={}){
 const filename=path.resolve(__dirname,'../dist/main.js'),req=createRequire(filename),exports={},requests=[];
 const project=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'gd-preview-url-')));t.after(()=>fs.rmSync(project,{recursive:true,force:true}));
 fs.writeFileSync(path.join(project,'package.json'),JSON.stringify({uuid:'test-preview-url'}));
 if(config)fs.writeFileSync(path.join(project,'git-desk.config.json'),JSON.stringify(config));
 const stubs={'./git':{GitDesk:class{task(){return undefined;}}},'./contexts':{WorkspaceContexts:class{constructor(){this.worktrees={ready:Promise.resolve()};}running(){return false;}}},'./mcp-bridge':{startMcpBridge:async()=>({close:async()=>{}})},electron:{session:{fromPartition:()=>({})},webContents:{fromId:()=>null}}};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{exports,__dirname:path.dirname(filename),console:Object.assign(Object.create(console),{info(){},warn(){},error(){},log(){}}),process,Buffer,URL,setTimeout,clearTimeout,setInterval,clearInterval,
  require:Object.assign(name=>name in stubs?stubs[name]:req(name),{cache:req.cache}),
  Editor:{Project:{path:project},Panel:{has:async()=>false,open:async()=>true,focus:async()=>true,close:async()=>{},openBeside:async()=>true},
   Message:{broadcast(){},request:async(channel,message)=>{requests.push(channel+'/'+message);if(channel==='preview'&&message==='query-preview-url'){if(urlError)throw Error(urlError);return previewUrl;}return undefined;}}}});
 exports.load();t.after(()=>exports.unload());
 return {exports,requests};
}
const asked=requests=>requests.filter(item=>item==='preview/query-preview-url').length;
test('with preview.url unset the embedded preview follows the URL Creator serves its preview on',async t=>{
 const {exports,requests}=load(t,{previewUrl:'http://localhost:7457'});
 const reply=await exports.methods.debugPreviewConfig();
 assert.equal(reply.ok,true,reply.error);assert.equal(reply.data.url,'http://localhost:7457/','a second Creator instance does not serve on 7456');
 await exports.methods.debugPreviewConfig();assert.equal(asked(requests),1,'a good answer is kept for the session');
});
test('a configured preview.url wins and Creator is not asked',async t=>{
 const {exports,requests}=load(t,{config:{preview:{url:'http://127.0.0.1:9000/game/'}},previewUrl:'http://localhost:7457'});
 const reply=await exports.methods.debugPreviewConfig();
 assert.equal(reply.data.url,'http://127.0.0.1:9000/game/');assert.equal(asked(requests),0);
});
test('without an answer from Creator the default 7456 is used and Creator is asked again next time',async t=>{
 const {exports,requests}=load(t,{urlError:'preview not ready'});
 assert.equal((await exports.methods.debugPreviewConfig()).data.url,'http://localhost:7456/');
 await exports.methods.debugPreviewConfig();assert.ok(asked(requests)>=2,'a failed answer is not cached');
});
test('a LAN address of this machine is loaded through localhost so the page stays a secure context; the port is kept',async t=>{
 const {exports}=load(t,{previewUrl:'http://127.0.0.1:7458'});
 assert.equal((await exports.methods.debugPreviewConfig()).data.url,'http://localhost:7458/');
});
test('an address that is not this machine is kept as Creator reports it',async t=>{
 const {exports}=load(t,{previewUrl:'http://203.0.113.5:7456'});
 assert.equal((await exports.methods.debugPreviewConfig()).data.url,'http://203.0.113.5:7456/');
});
