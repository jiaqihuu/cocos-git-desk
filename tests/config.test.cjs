const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const config=require('../dist/config');
const {sourceRevision}=require('../dist/preview-revision');
const {MessageError}=require('../dist/i18n');
function temp(t,prefix='gd-config-'){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),prefix)));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
test('a missing git-desk.config.json means the documented defaults',t=>{
 const root=temp(t);
 assert.deepEqual(config.loadConfig(root),{
  preview:{url:null,engineVersions:['3.8.x']},
  bridge:{controlName:'__COCOS_GIT_DESK_PREVIEW_CONTROL__',debugName:'__COCOS_GIT_DESK_DEBUG__',apiVersion:'cocos-git-desk-preview-bridge/1',environmentField:'environment',testEnvironments:['dev','test','staging']},
  revision:{roots:['assets','extensions/*/assets']},
  i18n:{keyPattern:null,directory:'assets/resources/language/json',languages:[],csvLayout:'perKey',csvColumns:['key','en','zh'],csvStatus:{missing:'missing',present:'present'}},
  clients:[]});
 assert.notEqual(config.defaultConfig(),config.defaultConfig(),'each call returns a fresh object');
 assert.deepEqual(config.validateConfig({}),config.defaultConfig());assert.deepEqual(config.validateConfig(null),config.defaultConfig());
});
test('given fields replace the defaults section by section; the rest keeps its default',t=>{
 const root=temp(t);
 write(path.join(root,'git-desk.config.json'),{preview:{url:'http://127.0.0.1:7457/'},bridge:{controlName:'__MY_CONTROL__'},revision:{roots:['assets/','packages/*/assets']},i18n:{keyPattern:'\\btxt_[a-z0-9_]+\\b',languages:['en','th'],csvColumns:['key','usage','th']},clients:['claude-code','codex','codex']});
 const loaded=config.loadConfig(root);
 assert.equal(loaded.preview.url,'http://127.0.0.1:7457/');assert.deepEqual(loaded.preview.engineVersions,['3.8.x']);
 assert.deepEqual(loaded.bridge,{controlName:'__MY_CONTROL__',debugName:'__COCOS_GIT_DESK_DEBUG__',apiVersion:'cocos-git-desk-preview-bridge/1',environmentField:'environment',testEnvironments:['dev','test','staging']});
 assert.deepEqual(loaded.revision.roots,['assets','packages/*/assets'],'trailing slashes are dropped');
 assert.equal(loaded.i18n.keyPattern,'\\btxt_[a-z0-9_]+\\b');assert.equal(loaded.i18n.directory,'assets/resources/language/json');assert.deepEqual(loaded.i18n.languages,['en','th']);
 assert.deepEqual(loaded.clients,['claude-code','codex'],'duplicates are dropped');
});
test('invalid files and fields are refused with a MessageError naming the key',t=>{
 const root=temp(t),file=path.join(root,'git-desk.config.json');
 write(file,'{not json');assert.throws(()=>config.loadConfig(root),error=>error instanceof MessageError&&error.id==='main.configInvalidJson');
 write(file,'[]');assert.throws(()=>config.loadConfig(root),error=>error.id==='main.configNotObject');
 const refuse=(raw,id,key)=>assert.throws(()=>config.validateConfig(raw),error=>error instanceof MessageError&&error.id===id&&(!key||error.message.includes(key)),JSON.stringify(raw));
 refuse({extra:1},'main.configUnknownKey','extra');
 refuse({preview:{port:1}},'main.configUnknownKey','preview.port');
 refuse({preview:[]},'main.configFieldInvalid','preview');
 refuse({preview:{url:'file:///etc/passwd'}},'main.configFieldInvalid','preview.url');
 refuse({preview:{url:'not a url'}},'main.configFieldInvalid','preview.url');
 refuse({preview:{engineVersions:[]}},'main.configFieldInvalid','preview.engineVersions');
 refuse({preview:{engineVersions:['latest']}},'main.configFieldInvalid','preview.engineVersions');
 refuse({bridge:{controlName:'window.x'}},'main.configFieldInvalid','bridge.controlName');
 refuse({bridge:{apiVersion:''}},'main.configFieldInvalid','bridge.apiVersion');
 refuse({bridge:{environmentField:'identity.env'}},'main.configFieldInvalid','bridge.environmentField');
 refuse({bridge:{testEnvironments:[]}},'main.configFieldInvalid','bridge.testEnvironments');
 refuse({bridge:{testEnvironments:['dev','']}},'main.configFieldInvalid','bridge.testEnvironments');
 assert.deepEqual(config.validateConfig({bridge:{environmentField:'runEnv',testEnvironments:['dev','pre']}}).bridge,{controlName:'__COCOS_GIT_DESK_PREVIEW_CONTROL__',debugName:'__COCOS_GIT_DESK_DEBUG__',apiVersion:'cocos-git-desk-preview-bridge/1',environmentField:'runEnv',testEnvironments:['dev','pre']});
 for(const root of ['/abs','../up','a/../b','a\\b','as*ets','C:/x'])refuse({revision:{roots:[root]}},'main.configFieldInvalid','revision.roots');
 refuse({i18n:{keyPattern:'('}},'creator.languageKeyPatternInvalid');
 refuse({i18n:{keyPattern:5}},'main.configFieldInvalid','i18n.keyPattern');
 refuse({i18n:{directory:'a/*'}},'main.configFieldInvalid','i18n.directory');
 refuse({i18n:{csvColumns:[]}},'main.configFieldInvalid','i18n.csvColumns');
 refuse({clients:['cursor']},'main.configFieldInvalid','clients');
 refuse({clients:'codex'},'main.configFieldInvalid','clients');
 assert.equal(config.validateConfig({preview:{url:null},i18n:{keyPattern:null}}).i18n.keyPattern,null,'null keeps the default');
});
test('a per-language CSV layout gets its own default columns and accepts headers and status texts',()=>{
 const plain=config.validateConfig({i18n:{csvLayout:'perLanguage'}}).i18n;
 assert.equal(plain.csvLayout,'perLanguage');assert.deepEqual(plain.csvColumns,['key','usage','language','text','status']);
 const custom=config.validateConfig({i18n:{csvLayout:'perLanguage',csvColumns:['key',{field:'usage',header:'使用场景'},{field:'status'}],csvStatus:{missing:'待翻译'}}}).i18n;
 assert.deepEqual(custom.csvColumns,['key',{field:'usage',header:'使用场景'},{field:'status'}]);assert.deepEqual(custom.csvStatus,{missing:'待翻译',present:'present'});
 assert.deepEqual(config.validateConfig({i18n:{csvColumns:['key','th']}}).i18n.csvColumns,['key','th'],'explicit columns win for either layout');
 const refuse=(raw,key)=>assert.throws(()=>config.validateConfig(raw),error=>error.id==='main.configFieldInvalid'&&error.message.includes(key),JSON.stringify(raw));
 refuse({i18n:{csvLayout:'wide'}},'i18n.csvLayout');
 for(const column of [{header:'x'},{field:'key',extra:1},{field:'key',header:''},'',3])refuse({i18n:{csvColumns:[column]}},'i18n.csvColumns');
 refuse({i18n:{csvStatus:{done:'x'}}},'i18n.csvStatus');refuse({i18n:{csvStatus:{missing:''}}},'i18n.csvStatus.missing');refuse({i18n:{csvStatus:'x'}},'i18n.csvStatus');
});
test('key patterns compile global; a /body/flags form keeps its flags',()=>{
 const plain=config.keyRegExp('\\btxt_[a-z]+\\b');assert.equal(plain.flags,'g');assert.deepEqual('a txt_one TXT_two'.match(plain),['txt_one']);
 const flagged=config.keyRegExp('/\\btxt_[a-z]+\\b/i');assert.equal(flagged.flags,'gi');assert.deepEqual('a txt_one TXT_two'.match(flagged),['txt_one','TXT_two']);
 assert.throws(()=>config.keyRegExp('['),error=>error.id==='creator.languageKeyPatternInvalid');
});
test('projectId is the Creator package.json uuid, or the first 12 hex digits of the project path hash',t=>{
 const root=temp(t);
 assert.equal(config.projectId(root),crypto.createHash('sha256').update(root).digest('hex').slice(0,12),'no package.json');
 write(path.join(root,'package.json'),{name:'x'});assert.equal(config.projectId(root).length,12,'no uuid');
 write(path.join(root,'package.json'),'{oops');assert.equal(config.projectId(root).length,12,'unreadable package.json');
 write(path.join(root,'package.json'),{uuid:'../../escape'});assert.equal(config.projectId(root).length,12,'a uuid that is not path-safe is ignored');
 write(path.join(root,'package.json'),{uuid:'1b2c3d4e-0000-4000-8000-123456789abc'});assert.equal(config.projectId(root),'1b2c3d4e-0000-4000-8000-123456789abc');
 assert.equal(config.dataDir('abc','/home/me'),path.join('/home/me','.cocos-git-desk','abc'));
 // browser-debug/setup.cjs keeps its own copy (CommonJS, no build step); both must name the same directories.
 const setup=require('../browser-debug/setup.cjs');
 assert.equal(setup.projectId(root),config.projectId(root));fs.rmSync(path.join(root,'package.json'));assert.equal(setup.projectId(root),config.projectId(root));
 assert.equal(setup.dataDir('abc','/home/me'),config.dataDir('abc','/home/me'));assert.equal(setup.serverName,config.extensionName);assert.equal(setup.defaultUrl,config.defaultPreviewUrl);
});
test('agent-settings.json debug directories default under ~/.cocos-git-desk/<projectId> and accept absolute or ~ paths',t=>{
 const cache=temp(t),home=temp(t,'gd-home-');
 assert.deepEqual(config.loadLocalSettings(cache,'pid',home),{debug:{stateDir:path.join(home,'.cocos-git-desk','pid','state'),outputDir:path.join(home,'.cocos-git-desk','pid','exports')}});
 write(path.join(cache,'agent-settings.json'),{requireHumanReview:true,debug:{stateDir:'~/state-here',outputDir:path.join(home,'out','..','exports2')}});
 assert.deepEqual(config.loadLocalSettings(cache,'pid',home),{requireHumanReview:true,debug:{stateDir:path.join(home,'state-here'),outputDir:path.join(home,'exports2')}});
 write(path.join(cache,'agent-settings.json'),{debug:{outputDir:'relative/dir'}});assert.throws(()=>config.loadLocalSettings(cache,'pid',home),error=>error.id==='main.configFieldInvalid'&&error.message.includes('debug.outputDir'));
 write(path.join(cache,'agent-settings.json'),{requireHumanReview:'yes'});assert.throws(()=>config.loadLocalSettings(cache,'pid',home),error=>error.id==='main.configFieldInvalid');
 write(path.join(cache,'agent-settings.json'),'[1]');assert.throws(()=>config.loadLocalSettings(cache,'pid',home),error=>error.id==='main.settingsNotObject');
});
test('the four tool catalogues hold the documented groups and merge by configuration',()=>{
 const dir=path.resolve(__dirname,'../static'),read=name=>JSON.parse(fs.readFileSync(path.join(dir,'mcp-tools.'+name+'.json'),'utf8')).map(tool=>tool.name);
 assert.equal(fs.existsSync(path.join(dir,'mcp-tools.json')),false,'the single catalogue is gone');
 const core=read('core'),inspector=read('inspector'),bridge=read('bridge'),i18n=read('i18n');
 assert.equal(core.filter(name=>name.startsWith('git_desk_')).length,15);assert.equal(core.filter(name=>name.startsWith('creator_')).length,28);assert.equal(core.length,43);
 assert.equal(inspector.filter(name=>name.startsWith('runtime_inspector_')).length,7);
 assert.deepEqual(inspector.filter(name=>name.startsWith('browser_debug_')).sort(),['browser_debug_compare','browser_debug_events','browser_debug_export','browser_debug_mark','browser_debug_start','browser_debug_status','browser_debug_stop','browser_debug_summary','browser_debug_wait_for_reload']);
 assert.equal(bridge.length,17);assert.ok(bridge.every(name=>name.startsWith('browser_debug_')));
 assert.deepEqual(i18n,['creator_language_keys']);
 assert.deepEqual(config.enabledCatalogues(config.defaultConfig()),['core','inspector','bridge']);
 assert.deepEqual(config.enabledCatalogues(config.validateConfig({i18n:{keyPattern:'x'}})),['core','inspector','bridge','i18n']);
 assert.deepEqual(config.enabledCatalogues(),['core','inspector','bridge','i18n'],'no configuration (tests, tooling) lists everything');
 assert.equal(config.toolCatalogue(config.defaultConfig()).length,76);assert.deepEqual(config.toolCatalogue().map(tool=>tool.name),[...core,...inspector,...bridge,...i18n]);
 const text=['core','inspector','bridge','i18n'].map(name=>fs.readFileSync(path.join(dir,'mcp-tools.'+name+'.json'),'utf8')).join('\n');
 assert.doesNotMatch(text,/amsa|AMSAChess|oops\.|lab_|svc\.|~\/Codex|Lanhu|[\u4e00-\u9fff]/i,'descriptions carry no project-specific words');
});
test('a duplicated tool name across catalogues is refused',t=>{
 const dir=temp(t);for(const name of config.catalogueNames)write(path.join(dir,'mcp-tools.'+name+'.json'),[{name:name==='bridge'?'dup':'tool_'+name,inputSchema:{properties:{}}}]);
 assert.equal(config.toolCatalogue(undefined,dir).length,4);
 write(path.join(dir,'mcp-tools.i18n.json'),[{name:'dup',inputSchema:{properties:{}}}]);assert.throws(()=>config.toolCatalogue(undefined,dir),/duplicate/);
});
test('engine version patterns match whole segments with x as a wildcard',()=>{
 assert.equal(config.matchesEngineVersion('3.8.8',['3.8.x']),true);assert.equal(config.matchesEngineVersion('3.8.10',['3.8.1']),false);
 assert.equal(config.matchesEngineVersion('3.9.0',['3.8.x']),false);assert.equal(config.matchesEngineVersion('3.9.0',['3.x']),true);
});
test('revision roots expand "*" segments and skip roots that do not exist',async t=>{
 const root=temp(t);write(path.join(root,'package.json'),{uuid:'p'});
 write(path.join(root,'assets/a.ts'),'a');write(path.join(root,'extensions/one/assets/b.ts'),'b');write(path.join(root,'extensions/two/assets/c.prefab'),'c');write(path.join(root,'extensions/three/src/d.ts'),'d');write(path.join(root,'extensions/.hidden/assets/e.ts'),'e');
 const scanned=await sourceRevision(root);
 assert.deepEqual(scanned.roots,['assets','extensions/one/assets','extensions/two/assets']);assert.equal(scanned.fileCount,4,'package.json plus three sources; a missing tsconfig.json is skipped');
 assert.equal(scanned.scope,'cocos-git-desk-script-layout-v1');
 const only=await sourceRevision(root,['assets','missing/*/x']);assert.deepEqual(only.roots,['assets']);assert.notEqual(only.digest,scanned.digest);
 write(path.join(root,'extensions/one/assets/b.ts'),'changed');assert.notEqual((await sourceRevision(root)).digest,scanned.digest);
});
