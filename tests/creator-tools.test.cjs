const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {CreatorTools,runTsc}=require('../dist/creator-tools');
const tools=require('../dist/config').toolCatalogue();
const prefabId='11111111-1111-1111-1111-111111111111',scriptId='22222222-2222-2222-2222-222222222222',dirId='33333333-3333-3333-3333-333333333333',sceneId='44444444-4444-4444-4444-444444444444';
function fixture(over={}){
 const assets={
  'db://assets/hall/HallView.prefab':{uuid:prefabId,url:'db://assets/hall/HallView.prefab',file:'/p/assets/hall/HallView.prefab',type:'cc.Prefab',name:'HallView'},
  'db://assets/script/HallView.ts':{uuid:scriptId,url:'db://assets/script/HallView.ts',file:'/p/assets/script/HallView.ts',type:'cc.Script',name:'HallView'},
  'db://assets/hall':{uuid:dirId,url:'db://assets/hall',file:'/p/assets/hall',type:'cc.Asset',name:'hall',isDirectory:true},
  'db://assets/main.scene':{uuid:sceneId,url:'db://assets/main.scene',file:'/p/assets/main.scene',type:'cc.SceneAsset',name:'main'},
 };
 const byUuid=Object.fromEntries(Object.values(assets).map(a=>[a.uuid,a]));
 const calls=[],selected=[];
 const host={project:'/p',
  request:async(channel,message,...args)=>{calls.push([channel,message,...args]);
   if(channel==='asset-db'&&message==='query-uuid'){const key=String(args[0]).replace(/\\/g,'/');return assets[key]?.uuid??Object.values(assets).find(a=>a.file===key)?.uuid??null;}
   if(channel==='asset-db'&&message==='query-asset-info')return byUuid[args[0]]||null;
   if(channel==='asset-db'&&message==='query-assets'){const needle=args[0].pattern.replace('db://assets/**/*','').replace(/\*$/,'');return Object.values(assets).filter(a=>a.url.includes(needle)&&(!args[0].ccType||a.type===args[0].ccType));}
   if(channel==='asset-db'&&['open-asset','refresh-asset'].includes(message))return true;
   if(channel==='asset-db'&&message==='query-ready')return over.ready??true;
   if(channel==='assets'&&message==='twinkle')return true;
   if(channel==='scene'&&message==='query-dirty')return over.dirty??false;
   if(channel==='scene'&&message==='multi-scene-query')return over.scenes??[{uuid:sceneId,name:'main',dirty:false,type:'scene'}];
   if(channel==='scene'&&message==='query-current-scene')return over.current??sceneId;
   if(channel==='preview'&&message==='query-preview-url'){if(over.urlError)throw Error(over.urlError);return 'http://localhost:7456';}
   throw Error('unexpected '+channel+' '+message);},
  selectAsset:id=>selected.push(id),assertIdle:()=>{if(over.running)throw Error('Git 操作正在执行，请结束后再操作编辑器');},gitRunning:()=>!!over.running,
  profile:async(pkg,key,scope)=>{calls.push(['profile',pkg,key,scope]);if(over.modeError)throw Error(over.modeError);return over.mode??'browser';},
  hasPanel:async name=>{calls.push(['hasPanel',name]);return over.panel??true;},openDebugPreview:async()=>'已打开内嵌调试预览。',
  typecheck:async()=>over.typecheck??{command:'tsc -p tsconfig.json --noEmit',exitCode:0,output:'',elapsedMs:5,timedOut:false},
  log:query=>{calls.push(['log',query]);return {entries:[{id:1,level:'warn',text:'x'}],query};},
  taskPaths:async id=>id==='task-1'?['assets/hall/HallView.prefab','assets/script/HallView.ts','assets/new/config.json']:null};
 return {tools:new CreatorTools(host,tools),calls,selected};
}
test('asset query resolves uuid, db url and file path through asset-db, and searches by name with type and limit',async()=>{
 const f=fixture();
 const byUuid=await f.tools.call('creator_asset_query',{uuid:prefabId});assert.equal(byUuid.url,'db://assets/hall/HallView.prefab');assert.equal(byUuid.type,'cc.Prefab');assert.equal(byUuid.invalid,false);
 assert.equal((await f.tools.call('creator_asset_query',{url:'db://assets/script/HallView.ts'})).uuid,scriptId);
 assert.equal((await f.tools.call('creator_asset_query',{path:'assets/hall/HallView.prefab'})).uuid,prefabId);assert.ok(f.calls.some(c=>c[1]==='query-uuid'&&String(c[2]).replace(/\\/g,'/')==='/p/assets/hall/HallView.prefab'),'relative paths resolve under the project');
 const named=await f.tools.call('creator_asset_query',{name:'HallView'});assert.equal(named.total,2);assert.deepEqual(named.assets.map(a=>a.type).sort(),['cc.Prefab','cc.Script']);
 const typed=await f.tools.call('creator_asset_query',{name:'HallView',type:'cc.Prefab'});assert.equal(typed.total,1);assert.equal(typed.assets[0].uuid,prefabId);
 const limited=await f.tools.call('creator_asset_query',{name:'HallView',limit:1});assert.equal(limited.assets.length,1);assert.equal(limited.truncated,true);
 await assert.rejects(f.tools.call('creator_asset_query',{}),/需要 uuid、url 或 path/);
 await assert.rejects(f.tools.call('creator_asset_query',{url:'db://assets/missing.png'}),/没有这个资源/);
 await assert.rejects(f.tools.call('creator_asset_query',{path:'../outside.ts'}),/不能包含/);
 await assert.rejects(f.tools.call('creator_asset_query',{uuid:prefabId,extra:1}),/未知参数/);
});
test('open and reveal go through asset-db and the assets panel, refuse directories and wait for Git operations',async()=>{
 const f=fixture();
 const script=await f.tools.call('creator_asset_open',{url:'db://assets/script/HallView.ts'});assert.equal(script.kind,'script');assert.ok(f.calls.some(c=>c[1]==='open-asset'&&c[2]===scriptId));
 assert.equal((await f.tools.call('creator_asset_open',{uuid:prefabId})).kind,'prefab');
 assert.equal((await f.tools.call('creator_asset_open',{url:'db://assets/main.scene'})).kind,'scene');
 await assert.rejects(f.tools.call('creator_asset_open',{url:'db://assets/hall'}),/目录不能打开/);
 const reveal=await f.tools.call('creator_asset_reveal',{uuid:prefabId});assert.match(reveal.message,/已定位：db:\/\/assets\/hall\/HallView.prefab/);assert.deepEqual(f.selected,[prefabId]);
 const busy=fixture({running:true});
 await assert.rejects(busy.tools.call('creator_asset_open',{uuid:prefabId}),/Git 操作正在执行/);
 await assert.rejects(busy.tools.call('creator_asset_reveal',{uuid:prefabId}),/Git 操作正在执行/);
 await assert.rejects(busy.tools.call('creator_assets_refresh',{}),/Git 操作正在执行/);
 assert.equal(busy.calls.length,0,'nothing reaches the editor while Git runs');
});
test('refresh targets db://assets by default, validates the url and reports readiness',async()=>{
 const f=fixture();
 assert.deepEqual(await f.tools.call('creator_assets_refresh',{}),{refreshed:'db://assets',ready:true});assert.ok(f.calls.some(c=>c[1]==='refresh-asset'&&c[2]==='db://assets'));
 assert.equal((await f.tools.call('creator_assets_refresh',{url:'db://assets/hall'})).refreshed,'db://assets/hall');
 await assert.rejects(f.tools.call('creator_assets_refresh',{url:'db://other/x'}),/只支持 assets 或 internal/);
 assert.equal((await fixture({ready:false}).tools.call('creator_assets_refresh',{})).ready,false);
});
test('editor state is a read-only snapshot with tabs, prefab mode, current scene url and Git status',async()=>{
 const f=fixture();
 const state=await f.tools.call('creator_editor_state',{});
 assert.equal(state.dirty,false);assert.equal(state.prefabMode,false);assert.equal(state.current,sceneId);assert.equal(state.currentUrl,'db://assets/main.scene');assert.equal(state.assetDbReady,true);assert.equal(state.gitRunning,false);
 assert.equal(f.calls.some(c=>c[1]==='multi-save-all-scene'||c[1]==='close-scene'),false,'never saves or closes');
 const prefab=fixture({dirty:true,running:true,scenes:[{uuid:sceneId,name:'main',dirty:false,type:'scene'},{uuid:prefabId,name:'HallView',dirty:true,type:'prefab'}],current:prefabId});
 const inPrefab=await prefab.tools.call('creator_editor_state',{});assert.equal(inPrefab.prefabMode,true);assert.equal(inPrefab.dirty,true);assert.equal(inPrefab.gitRunning,true);assert.equal(inPrefab.currentUrl,'db://assets/hall/HallView.prefab');
 assert.equal((await fixture({current:'not-a-uuid'}).tools.call('creator_editor_state',{})).currentUrl,null);
});
test('script diagnostics parse tsc output into bounded structured entries',async()=>{
 const output=['assets/script/a.ts(12,5): error TS2322: Type string is not assignable to type number.','assets/script/b.ts(3,1): error TS2304: Cannot find name foo.','assets/script/c.ts(7,9): warning TS6133: unused.','noise line'].join('\n');
 const f=fixture({typecheck:{command:'tsc -p tsconfig.json --noEmit',exitCode:2,output,elapsedMs:4000,timedOut:false}});
 const result=await f.tools.call('creator_script_diagnostics',{});
 assert.equal(result.errorCount,2);assert.equal(result.diagnosticCount,3);assert.deepEqual(result.diagnostics[0],{file:'assets/script/a.ts',line:12,column:5,severity:'error',code:'TS2322',message:'Type string is not assignable to type number.'});assert.equal(result.unparsed,'');
 const limited=await f.tools.call('creator_script_diagnostics',{limit:1});assert.equal(limited.diagnostics.length,1);assert.equal(limited.truncated,true);
 const clean=await fixture().tools.call('creator_script_diagnostics',{});assert.equal(clean.errorCount,0);assert.equal(clean.exitCode,0);
 const broken=await fixture({typecheck:{command:'tsc',exitCode:1,output:'error TS5058: The specified path does not exist',elapsedMs:1,timedOut:false}}).tools.call('creator_script_diagnostics',{});assert.match(broken.unparsed,/TS5058/);
 await assert.rejects(runTsc('/nonexistent-project'),/缺少 node_modules\/\.bin\/tsc/);
});
test('preview status reads the mode and url, reports the embedded panel, and open goes through the panel entry',async()=>{
 const f=fixture();
 const status=await f.tools.call('creator_preview',{});assert.equal(status.mode,'browser');assert.equal(status.url,'http://localhost:7456');assert.equal(status.debugPreviewOpen,true);assert.equal(status.modeError,'');
 assert.ok(f.calls.some(c=>c[0]==='profile'&&c[2]==='preview.current.platform'&&c[3]==='local'));
 const opened=await f.tools.call('creator_preview',{action:'open'});assert.equal(opened.opened,true);assert.match(opened.message,/已打开/);
 const degraded=await fixture({modeError:'no profile',urlError:'no preview',panel:false}).tools.call('creator_preview',{action:'status'});assert.equal(degraded.mode,null);assert.equal(degraded.modeError,'no profile');assert.equal(degraded.url,null);assert.equal(degraded.urlError,'no preview');assert.equal(degraded.debugPreviewOpen,false);
 await assert.rejects(f.tools.call('creator_preview',{action:'start'}),/参数无效：action/);
 await assert.rejects(fixture({running:true}).tools.call('creator_preview',{action:'open'}),/Git 操作正在执行/);
});
test('the catalog declares the seven editor tools with the right read-only hints',()=>{
 const {sceneToolNames}=require('../dist/scene-tools');const names=tools.filter(t=>t.name.startsWith('creator_')&&!sceneToolNames.has(t.name)).map(t=>t.name);
 assert.deepEqual(names,['creator_asset_query','creator_asset_open','creator_asset_reveal','creator_assets_refresh','creator_editor_state','creator_script_diagnostics','creator_preview','creator_extension_log','creator_asset_write','creator_asset_delete','creator_asset_meta','creator_asset_users','creator_project_log','creator_screenshot','creator_reload_extension','creator_message','creator_meta_check','creator_prefab_diff','creator_language_keys']);
 for(const name of ['creator_asset_query','creator_editor_state','creator_script_diagnostics','creator_extension_log','creator_asset_users','creator_project_log','creator_asset_meta','creator_screenshot','creator_message','creator_meta_check','creator_prefab_diff','creator_language_keys'])assert.equal(tools.find(t=>t.name===name).annotations.readOnlyHint,true,name);
 for(const name of ['creator_asset_open','creator_asset_reveal','creator_assets_refresh','creator_preview','creator_asset_write','creator_asset_delete','creator_reload_extension'])assert.equal(tools.find(t=>t.name===name).annotations.readOnlyHint,false,name);
 assert.equal(tools.find(t=>t.name==='creator_asset_delete').annotations.destructiveHint,true);
});
test('the extension log reader validates its paging arguments and hands them to the host buffer',async()=>{
 const f=fixture();
 const result=await f.tools.call('creator_extension_log',{level:['warn','error'],sinceId:3,limit:10,query:'预览'});
 assert.deepEqual(result.query,{level:['warn','error'],sinceId:3,limit:10,query:'预览'});assert.equal(result.entries[0].text,'x');
 await assert.rejects(f.tools.call('creator_extension_log',{limit:0}),/整数：limit/);
 await assert.rejects(f.tools.call('creator_extension_log',{level:'warn'}),/字符串数组：level/);
});

// A project on disk plus a fake asset database that mirrors Creator's write messages onto the files.
function diskFixture(t,over={}){
 const os=require('node:os'),crypto=require('node:crypto');
 const project=fs.mkdtempSync(path.join(os.tmpdir(),'gd-assets-'));t.after(()=>fs.rmSync(project,{recursive:true,force:true}));
 const write=(rel,content)=>{fs.mkdirSync(path.dirname(path.join(project,rel)),{recursive:true});fs.writeFileSync(path.join(project,rel),content);};
 const spriteId='55555555-5555-5555-5555-555555555555';
 const prefab=JSON.stringify([{__type__:'cc.Prefab',_name:'HallView'},{__type__:'cc.Node',_name:'bg'},{__type__:'cc.Sprite',_spriteFrame:{__uuid__:spriteId+'@f9941'}}]);
 write('assets/hall/HallView.prefab',prefab);write('assets/hall/HallView.prefab.meta','{"uuid":"'+prefabId+'"}');write('assets/script/HallView.ts','export class HallView {}');
 write('assets/other/Scene.scene',JSON.stringify([{__type__:'cc.SceneAsset'},{__type__:'cc.Sprite',_spriteFrame:{__uuid__:require('../dist/creator-tools').compressUuid(spriteId)}}]));
 write('temp/logs/project.log',['10-28-2026 20:00:00 - info: [调试预览] 启动','10-28-2026 20:00:01 - error: Compile error TS2322 in assets/script/HallView.ts','10-28-2026 20:00:02 - warn: 其他','10-28-2026 20:00:03 - error: import failed sprite.png'].join('\n')+'\n');
 const byUrl={'db://assets/hall/HallView.prefab':{uuid:prefabId,type:'cc.Prefab'},'db://assets/script/HallView.ts':{uuid:scriptId,type:'cc.Script'},'db://assets/hall':{uuid:dirId,type:'cc.Asset',isDirectory:true},['db://assets/sprite.png']:{uuid:spriteId,type:'cc.ImageAsset'}};
 const metas={[prefabId]:{uuid:prefabId,ver:'1.1.50',userData:{}}};
 const calls=[];
 const host={project,
  request:async(channel,message,...args)=>{calls.push([channel,message,...args]);
   const fileOf=url=>path.join(project,String(url).replace(/^db:\/\//,''));
   if(channel==='asset-db'&&message==='query-uuid'){const url=args[0].startsWith('db://')?args[0]:'db://'+path.relative(project,args[0]).split(path.sep).join('/');return byUrl[url]?.uuid??(fs.existsSync(fileOf(url))?'99999999-9999-9999-9999-999999999999':null);}
   if(channel==='asset-db'&&message==='query-asset-info'){const key=args[0];const entry=Object.entries(byUrl).find(([url,info])=>info.uuid===key||url===key);if(!entry)return null;const [url,info]=entry;return {uuid:info.uuid,url,file:fileOf(url),type:info.type,name:path.basename(url),isDirectory:info.isDirectory===true};}
   if(channel==='asset-db'&&message==='save-asset'){fs.writeFileSync(fileOf(args[0]),args[1]);return true;}
   if(channel==='asset-db'&&message==='create-asset'){fs.mkdirSync(path.dirname(fileOf(args[0])),{recursive:true});fs.writeFileSync(fileOf(args[0]),args[1]);byUrl[args[0]]={uuid:'77777777-7777-7777-7777-777777777777',type:'cc.JsonAsset'};return true;}
   if(channel==='asset-db'&&message==='delete-asset'){fs.rmSync(fileOf(args[0]));fs.rmSync(fileOf(args[0])+'.meta',{force:true});delete byUrl[args[0]];return true;}
   if(channel==='asset-db'&&message==='query-asset-meta')return metas[args[0]]??null;
   if(channel==='asset-db'&&message==='save-asset-meta'){metas[args[0]]=JSON.parse(args[1]);return true;}
   if(channel==='asset-db'&&message==='query-asset-users'){if(over.users==='native')return [{uuid:prefabId,url:'db://assets/hall/HallView.prefab'}];throw Error('unknown message');}
   if(channel==='asset-db'&&['refresh-asset'].includes(message))return true;
   if(channel==='asset-db'&&message==='query-ready')return true;
   throw Error('unexpected '+channel+' '+message);},
  selectAsset(){},assertIdle:()=>{if(over.running)throw Error('Git 操作正在执行，请结束后再操作编辑器');},gitRunning:()=>!!over.running,profile:async()=>'browser',hasPanel:async()=>true,openDebugPreview:async()=>'',log:()=>({}),
  taskPaths:async id=>id==='task-1'?['assets/hall/HallView.prefab','assets/script/HallView.ts','assets/new/config.json']:null};
 const sha=rel=>crypto.createHash('sha256').update(fs.readFileSync(path.join(project,rel))).digest('hex');
 return {tools:new CreatorTools(host,tools),calls,project,sha,prefabId,spriteId,read:rel=>fs.readFileSync(path.join(project,rel),'utf8')};
}
test('asset writes are guarded by task scope, content hash and serialized-reference validation, then re-imported',async t=>{
 const f=diskFixture(t);
 const current=(await f.tools.call('creator_asset_query',{url:'db://assets/hall/HallView.prefab'})).sha256;assert.equal(current,f.sha('assets/hall/HallView.prefab'));
 const next=JSON.stringify([{__type__:'cc.Prefab',_name:'HallView'},{__type__:'cc.Sprite',_spriteFrame:{__uuid__:f.spriteId}}]);
 await assert.rejects(f.tools.call('creator_asset_write',{url:'db://assets/hall/HallView.prefab',content:next}),/缺少参数：taskId/);
 await assert.rejects(f.tools.call('creator_asset_write',{url:'db://assets/hall/HallView.prefab',content:next,taskId:'nope',expectedSha256:current}),/任务不存在/);
 await assert.rejects(f.tools.call('creator_asset_write',{url:'db://assets/other/Scene.scene',content:next,taskId:'task-1',expectedSha256:current}),/不在任务范围内/);
 await assert.rejects(f.tools.call('creator_asset_write',{url:'db://assets/hall/HallView.prefab',content:next,taskId:'task-1'}),/必须提供 expectedSha256/);
 await assert.rejects(f.tools.call('creator_asset_write',{url:'db://assets/hall/HallView.prefab',content:next,taskId:'task-1',expectedSha256:'0'.repeat(64)}),/已被其他改动修改/);
 await assert.rejects(f.tools.call('creator_asset_write',{url:'db://assets/hall/HallView.prefab',content:'{not json',taskId:'task-1',expectedSha256:current}),/不是合法 JSON/);
 await assert.rejects(f.tools.call('creator_asset_write',{url:'db://assets/hall/HallView.prefab',content:'{"a":1}',taskId:'task-1',expectedSha256:current}),/序列化格式/);
 await assert.rejects(f.tools.call('creator_asset_write',{url:'db://assets/hall/HallView.prefab',content:JSON.stringify([{__type__:'cc.Prefab'},{__type__:'cc.Sprite',_spriteFrame:{__uuid__:'12121212-1212-1212-1212-121212121212'}}]),taskId:'task-1',expectedSha256:current}),/引用的资源不存在（1 个）/);
 await assert.rejects(f.tools.call('creator_asset_write',{url:'db://assets/hall/HallView.prefab',content:next,taskId:'task-1',expectedSha256:current,create:true}),/已存在/);
 await assert.rejects(f.tools.call('creator_asset_write',{url:'db://assets/hall/HallView.prefab.meta',content:'{}',taskId:'task-1'}),/creator_asset_meta/);
 assert.equal(f.calls.some(c=>c[1]==='save-asset'),false,'nothing was written by the refused calls');
 const written=await f.tools.call('creator_asset_write',{url:'assets/hall/HallView.prefab',content:next,taskId:'task-1',expectedSha256:current});
 assert.equal(written.created,false);assert.equal(written.references,1);assert.equal(written.uuid,f.prefabId);assert.equal(f.read('assets/hall/HallView.prefab'),next);assert.equal(written.sha256,f.sha('assets/hall/HallView.prefab'));
 assert.ok(f.calls.some(c=>c[1]==='save-asset'&&c[2]==='db://assets/hall/HallView.prefab'),'relative paths are turned into db urls');
 await assert.rejects(f.tools.call('creator_asset_write',{url:'db://assets/new/config.json',content:'{"a":1}',taskId:'task-1'}),/要新建请传 create:true/);
 const created=await f.tools.call('creator_asset_write',{url:'db://assets/new/config.json',content:'{"a":1}',taskId:'task-1',create:true});
 assert.equal(created.created,true);assert.equal(f.read('assets/new/config.json'),'{"a":1}');assert.ok(f.calls.some(c=>c[1]==='create-asset'));
 await assert.rejects(diskFixture(t,{running:true}).tools.call('creator_asset_write',{url:'db://assets/hall/HallView.prefab',content:next,taskId:'task-1',expectedSha256:current}),/Git 操作正在执行/);
});
test('asset delete and meta respect the task scope; users come from Creator or a bounded scan',async t=>{
 const f=diskFixture(t);
 await assert.rejects(f.tools.call('creator_asset_delete',{url:'db://assets/other/Scene.scene',taskId:'task-1'}),/不在任务范围内/);
 await assert.rejects(f.tools.call('creator_asset_delete',{url:'db://assets/hall',taskId:'task-1'}),/不在任务范围内|目录/);
 const deleted=await f.tools.call('creator_asset_delete',{url:'db://assets/script/HallView.ts',taskId:'task-1'});assert.equal(deleted.deleted,true);assert.equal(fs.existsSync(path.join(f.project,'assets/script/HallView.ts')),false);
 const meta=await f.tools.call('creator_asset_meta',{url:'db://assets/hall/HallView.prefab'});assert.equal(meta.meta.ver,'1.1.50');
 await assert.rejects(f.tools.call('creator_asset_meta',{url:'db://assets/hall/HallView.prefab',meta:{uuid:f.prefabId,ver:'2'}}),/必须提供 Git Desk 任务 ID/);
 const saved=await f.tools.call('creator_asset_meta',{url:'db://assets/hall/HallView.prefab',meta:{uuid:f.prefabId,ver:'2'},taskId:'task-1'});assert.equal(saved.meta.ver,'2');assert.ok(f.calls.some(c=>c[1]==='save-asset-meta'&&c[2]===f.prefabId));
 const scanned=await f.tools.call('creator_asset_users',{uuid:f.spriteId});
 assert.equal(scanned.source,'scan');assert.deepEqual(scanned.users.map(u=>u.url).sort(),['db://assets/hall/HallView.prefab','db://assets/other/Scene.scene'],'full and compressed uuid spellings are both found');
 const native=await diskFixture(t,{users:'native'}).tools.call('creator_asset_users',{uuid:f.spriteId});assert.equal(native.source,'asset-db');assert.equal(native.total,1);
});
test('refresh accepts file paths and the project log is filtered by text or regex',async t=>{
 const f=diskFixture(t);
 await f.tools.call('creator_assets_refresh',{url:'assets/script/HallView.ts'});assert.deepEqual(f.calls.at(-2).slice(0,3),['asset-db','refresh-asset','db://assets/script/HallView.ts']);
 await f.tools.call('creator_assets_refresh',{url:path.join(f.project,'assets/hall')});assert.deepEqual(f.calls.at(-2).slice(0,3),['asset-db','refresh-asset','db://assets/hall']);
 await assert.rejects(f.tools.call('creator_assets_refresh',{url:'../outside'}),/只支持 assets 或 internal/);
 const errors=await f.tools.call('creator_project_log',{query:'error:'});assert.equal(errors.matching,2);assert.match(errors.entries[0].text,/TS2322/);assert.match(errors.entries[1].text,/import failed/);
 const re=await f.tools.call('creator_project_log',{query:'TS\\d{4}|import failed',regex:true,limit:1});assert.equal(re.matching,2);assert.equal(re.truncated,true);assert.match(re.entries[0].text,/import failed/,'the newest match is kept');
 await assert.rejects(f.tools.call('creator_project_log',{query:'(',regex:true}),/正则无效/);
 assert.equal((await f.tools.call('creator_project_log',{})).matching,4);
 await assert.rejects(fixture().tools.call('creator_project_log',{}),/没有找到 Creator 项目日志/);
});
test('screenshots land under the extension cache and extension reload is scheduled by the host',async()=>{
 const os=require('node:os');const project=fs.mkdtempSync(path.join(os.tmpdir(),'gd-shot-'));
 const calls=[];const png=Buffer.from('89504e470d0a1a0a','hex');
 const host={project,request:async()=>{throw Error('unused');},selectAsset(){},assertIdle:()=>{if(host.running)throw Error('Git 操作正在执行');},gitRunning:()=>false,profile:async()=>'browser',hasPanel:async()=>true,openDebugPreview:async()=>'',log:()=>({}),taskPaths:async()=>null,
  capture:async options=>{calls.push(['capture',options]);return {png,title:'Cocos Creator - SampleProject',bounds:{x:0,y:0,width:10,height:5},scale:1};},
  reloadExtension:async name=>{calls.push(['reload',name]);return {name,scheduled:true,delayMs:400};}};
 const t=new CreatorTools(host,tools);
 const shot=await t.call('creator_screenshot',{});
 assert.ok(shot.file.startsWith(path.join(project,'extensions','cocos-git-desk','.cache','captures')));assert.match(path.basename(shot.file),/^editor-.*\.png$/);assert.equal(fs.readFileSync(shot.file).toString('hex'),'89504e470d0a1a0a');assert.equal(shot.bytes,8);assert.deepEqual(calls[0],['capture',{panel:undefined}]);
 const panel=await t.call('creator_screenshot',{panel:'scene',fileName:'scene.png'});assert.equal(path.basename(panel.file),'scene.png');assert.equal(panel.panel,'scene');assert.deepEqual(calls[1],['capture',{panel:'scene'}]);
 await assert.rejects(t.call('creator_screenshot',{fileName:'../x.png'}),/文件名/);await assert.rejects(t.call('creator_screenshot',{fileName:'notes.txt'}),/文件名/);
 const reload=await t.call('creator_reload_extension',{});assert.deepEqual(calls[2],['reload','cocos-git-desk']);assert.equal(reload.scheduled,true);assert.match(reload.note,/MCP/);
 const other=await t.call('creator_reload_extension',{name:'my-helper-tools'});assert.equal(other.name,'my-helper-tools');assert.match(other.note,/my-helper-tools/);
 host.running=true;await assert.rejects(t.call('creator_reload_extension',{}),/Git 操作正在执行/);
 const bare=new CreatorTools({...host,capture:undefined,reloadExtension:undefined},tools);await assert.rejects(bare.call('creator_screenshot',{}),/不支持截图/);await assert.rejects(bare.call('creator_reload_extension',{}),/不支持重载扩展/);
 fs.rmSync(project,{recursive:true,force:true});
});
test('creator_message forwards allowlisted queries with positional args and refuses everything else',async()=>{
 const f=fixture();
 const out=await f.tools.call('creator_message',{channel:'asset-db',message:'query-asset-info',args:[prefabId]});
 assert.equal(out.result.url,'db://assets/hall/HallView.prefab');assert.equal(out.truncated,false);assert.ok(f.calls.some(c=>c[0]==='asset-db'&&c[1]==='query-asset-info'&&c[2]===prefabId));
 assert.equal((await f.tools.call('creator_message',{channel:'scene',message:'query-dirty'})).result,false);
 await assert.rejects(f.tools.call('creator_message',{channel:'asset-db',message:'save-asset',args:['db://assets/x.json','{}']}),/不允许的消息.*creator_asset_write/);
 await assert.rejects(f.tools.call('creator_message',{channel:'scene',message:'set-property'}),/不允许的消息/);
 await assert.rejects(f.tools.call('creator_message',{channel:'program',message:'execute'}),/不支持的频道/);
 await assert.rejects(f.tools.call('creator_message',{channel:'asset-db',message:'query-uuid',args:[1,2,3,4,5,6,7,8,9]}),/最多 8 个/);
 assert.ok(!f.calls.some(c=>c[1]==='save-asset'||c[1]==='set-property'),'refused messages never reach Creator');
 const busy=fixture({running:true});await assert.rejects(busy.tools.call('creator_message',{channel:'asset-db',message:'refresh-asset',args:['db://assets']}),/Git 操作正在执行/);
 const big=fixture();big.tools.host.request=async()=>({blob:'x'.repeat(70*1024)});
 const cut=await big.tools.call('creator_message',{channel:'scene',message:'query-node-tree'});assert.equal(cut.truncated,true);assert.equal(cut.result,null);assert.ok(cut.resultText.length<=64*1024+1);
});
test('creator_meta_check normalizes paths and hands scope to the host', async () => {
 const calls=[];const base=fixture();const host={...base.tools.host,metaCheck:async options=>{calls.push(options);return {scope:options.scope,blockers:[],issues:[]};}};
 const t=new CreatorTools(host,tools);
 assert.deepEqual((await t.call('creator_meta_check',{})).scope,'worktree');assert.deepEqual(calls[0],{scope:'worktree'});
 await t.call('creator_meta_check',{scope:'index',paths:['db://assets/hall','/p/assets/x.png','assets/y.meta']});assert.deepEqual(calls[1],{scope:'index',paths:['assets/hall','assets/x.png','assets/y.meta']});
 await assert.rejects(t.call('creator_meta_check',{paths:['../outside']}),/项目内/);
 await assert.rejects(new CreatorTools({...base.tools.host,metaCheck:undefined},tools).call('creator_meta_check',{}),/不支持/);
});
test('creator_prefab_diff reads both versions through the host and labels references through asset-db', async () => {
 const base=fixture();const reads=[];
 const node=(name,parent,children,components,prefab)=>({__type__:'cc.Node',_name:name,_parent:parent,_children:children,_components:components,_prefab:prefab,_id:''});
 const left=[{__type__:'cc.Prefab',data:{__id__:1}},node('Root',null,[],[{__id__:2}],{__id__:3}),{__type__:'cc.Sprite',node:{__id__:1},_spriteFrame:{__uuid__:prefabId,__expectedType__:'cc.SpriteFrame'}},{__type__:'cc.PrefabInfo',root:{__id__:1},asset:{__uuid__:scriptId},fileId:'r'}];
 const right=JSON.parse(JSON.stringify(left));right[2]._spriteFrame={__uuid__:sceneId,__expectedType__:'cc.SpriteFrame'};
 const host={...base.tools.host,fileAt:async(name,revision)=>{reads.push([name,revision]);return JSON.stringify(revision==='HEAD'?left:right);}};
 const t=new CreatorTools(host,tools);
 const out=await t.call('creator_prefab_diff',{path:'db://assets/hall/HallView.prefab'});
 assert.deepEqual(reads,[['assets/hall/HallView.prefab','HEAD'],['assets/hall/HallView.prefab','worktree']]);
 assert.equal(out.properties.length,1);assert.equal(out.properties[0].component,'cc.Sprite');assert.equal(out.properties[0].before,'asset:hall/HallView.prefab');assert.equal(out.properties[0].after,'asset:main.scene');
 assert.deepEqual(out.assets.map(a=>[a.label,a.before,a.after]),[['hall/HallView.prefab',1,0],['main.scene',0,1]]);assert.match(out.summary,/属性改动 1/);
 await assert.rejects(t.call('creator_prefab_diff',{path:'assets/x.png'}),/只支持/);await assert.rejects(t.call('creator_prefab_diff',{path:'assets/a.prefab',left:'-x'}),/无效的版本/);
 const missing=new CreatorTools({...host,fileAt:async()=>null},tools);await assert.rejects(missing.call('creator_prefab_diff',{path:'assets/a.prefab'}),/两个版本都没有/);
});
test('creator_language_keys normalizes its options before handing them to Git Desk', async () => {
 const base=fixture();const calls=[];const t=new CreatorTools({...base.tools.host,languageKeys:async options=>{calls.push(options);return {keys:[]};}},tools);
 await t.call('creator_language_keys',{});assert.deepEqual(calls[0],{history:true,csv:false});
 await t.call('creator_language_keys',{keys:['lab_a'],paths:['db://assets/hall'],since:'origin/dev',history:false,csv:'all',limit:5});assert.deepEqual(calls[1],{keys:['lab_a'],paths:['assets/hall'],since:'origin/dev',history:false,csv:'all',limit:5});
 await t.call('creator_language_keys',{csv:'missing'});assert.equal(calls[2].csv,true);
 await assert.rejects(t.call('creator_language_keys',{since:'-bad'}),/无效的版本/);
 await assert.rejects(new CreatorTools({...base.tools.host,languageKeys:undefined},tools).call('creator_language_keys',{}),/不支持/);
});
