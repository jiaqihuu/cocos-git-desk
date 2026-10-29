const test=require('node:test'),assert=require('node:assert/strict');
const tooltipModule=require('../dist/panel-tooltips');
const OriginalTooltips=tooltipModule.PanelTooltips;
let tooltipClosed=0;
tooltipModule.PanelTooltips=class {constructor(root){this.root=root;}close(){tooltipClosed++;}};
const dockModule=require('../dist/preview-dock-size');
const OriginalDockSize=dockModule.PreviewDockSize;
dockModule.PreviewDockSize=class {show(){}hide(){}close(){}};
test.after(()=>{dockModule.PreviewDockSize=OriginalDockSize;});
const inspectorModule=require('../dist/runtime-inspector-panel');
const OriginalMount=inspectorModule.mountInspector;
let mounts=[];
inspectorModule.mountInspector=(root,options)=>{const mount={options,visible:[],disposed:0,setVisible(v){this.visible.push(v);},dispose(){this.disposed++;}};mounts.push(mount);return mount;};
test.after(()=>{inspectorModule.mountInspector=OriginalMount;});
const panel=require('../dist/debug-preview-panel');
test.after(()=>{tooltipModule.PanelTooltips=OriginalTooltips;});
function fixture(t){
 const calls=[],elements=new Map();
 class Element extends EventTarget{constructor(){super();this.textContent='';this.attrs={};this.disabled=false;}setAttribute(k,v){this.attrs[k]=v;}remove(){this.removed=true;}appendChild(child){this.child=child;}}
 const guest=new Element();guest.getWebContentsId=()=>71;guest.setAudioMuted=value=>calls.push(['mute',value]);guest.setZoomFactor=value=>calls.push(['zoom',value]);guest.loadURL=async url=>{calls.push(['load',url]);};
 for(const name of ['status','connection','game-version','host','reload','external','export','codex','devtools','audio','detach-inspector','zoom-in','zoom-out','zoom-fit','client-config','client-config-text','client-config-note','client-config-copy','client-config-close'])elements.set('#'+name,new Element());
 elements.get('#host').getBoundingClientRect=()=>({width:800,height:600});
 const root={ownerDocument:{createElement:()=>guest},querySelector:name=>elements.get(name),querySelectorAll:()=>['reload','external','export','codex','devtools','audio','detach-inspector','zoom-in','zoom-out','zoom-fit'].map(n=>elements.get('#'+n))};
 const instance={$:{preview:root}};
 global.Editor={Message:{request:async(_pkg,method,...args)=>{calls.push([method,...args]);return {ok:true,data:method==='debug-preview-config'?{url:'http://localhost:7456/',partition:'test',codexConfigured:true}:'ok'};}}};
 t.after(()=>{panel.close.call(instance);delete global.Editor;});return{calls,elements,guest,instance};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('embedded panel binds blank sandboxed guest before navigation, exposes external entry, closes cleanly',async t=>{
 const f=fixture(t);await panel.ready.call(f.instance);assert.equal(f.guest.attrs.src,'about:blank');assert.ok(f.calls.some(c=>c[0]==='browser-debug-set-enabled'&&c[1]===true));assert.match(f.guest.attrs.webpreferences,/nodeIntegration=no/);assert.equal(f.calls.some(c=>c[0]==='load'),false);
 f.guest.dispatchEvent(new Event('dom-ready'));await flush();assert.ok(f.calls.findIndex(c=>c[0]==='debug-preview-bind')<f.calls.findIndex(c=>c[0]==='load'));
 assert.match(f.calls.find(c=>c[0]==='load')[1],/gitDeskEmbedded=1/);
 f.elements.get('#external').dispatchEvent(new Event('click'));await flush();assert.ok(f.calls.some(c=>c[0]==='browser-debug-external'));
 panel.close.call(f.instance);assert.ok(f.guest.removed);assert.ok(f.calls.some(c=>c[0]==='debug-preview-release'&&c[1]===71));
});
test('closing while backend bind is pending never navigates late or updates destroyed panel',async t=>{
 const f=fixture(t);await panel.ready.call(f.instance);let resolveBind;const old=Editor.Message.request;
 Editor.Message.request=(pkg,method,...args)=>method==='debug-preview-bind'?new Promise(resolve=>resolveBind=resolve):old(pkg,method,...args);
 f.guest.dispatchEvent(new Event('dom-ready'));panel.close.call(f.instance);const message=f.elements.get('#status').textContent;resolveBind({ok:true,data:true});await flush();assert.equal(f.calls.some(c=>c[0]==='load'),false);assert.equal(f.elements.get('#status').textContent,message);
});
test('binding failure is visible and refresh retries binding before loading',async t=>{
 const f=fixture(t);await panel.ready.call(f.instance);const old=Editor.Message.request;let fail=true;
 Editor.Message.request=(pkg,method,...args)=>method==='debug-preview-bind'&&fail?Promise.resolve({ok:false,error:'连接失败'}):old(pkg,method,...args);
 f.guest.dispatchEvent(new Event('dom-ready'));await flush();assert.match(f.elements.get('#status').textContent,/连接失败/);assert.equal(f.calls.some(c=>c[0]==='load'),false);
 fail=false;f.elements.get('#reload').dispatchEvent(new Event('click'));await flush();assert.ok(f.calls.some(c=>c[0]==='load'));
});

test('AI client setup stays available, shows the returned report and copies it',async t=>{
 const f=fixture(t);f.elements.get('#client-config').hidden=true;await panel.ready.call(f.instance);assert.notEqual(f.elements.get('#codex').hidden,true);
 const report='已写入 .mcp.json\n{"mcpServers":{}}\n[mcp_servers.cocos-git-desk]';
 const old=Editor.Message.request;Editor.Message.request=async(pkg,method,...args)=>method==='browser-debug-connect-codex'?(f.calls.push([method]),{ok:true,data:report}):old(pkg,method,...args);
 f.elements.get('#codex').dispatchEvent(new Event('click'));await flush();
 assert.ok(f.calls.some(c=>c[0]==='browser-debug-connect-codex'));assert.notEqual(f.elements.get('#codex').hidden,true);
 assert.equal(f.elements.get('#client-config').hidden,false);assert.equal(f.elements.get('#client-config-text').textContent,report);
 let copied;f.instance.$.preview.ownerDocument.defaultView={navigator:{clipboard:{writeText:async text=>{copied=text;}}}};
 f.elements.get('#client-config-copy').dispatchEvent(new Event('click'));await flush();
 assert.equal(copied,report);assert.match(f.elements.get('#client-config-note').textContent,/已复制/);
 f.instance.$.preview.ownerDocument.defaultView={navigator:{clipboard:{writeText:async()=>{throw Error('denied');}}}};
 f.elements.get('#client-config-copy').dispatchEvent(new Event('click'));await flush();
 assert.match(f.elements.get('#client-config-note').textContent,/手动复制/);
 f.elements.get('#client-config-close').dispatchEvent(new Event('click'));assert.equal(f.elements.get('#client-config').hidden,true);
});

test('export uses the versioned open-folder message and reports stale background',async t=>{
 const f=fixture(t);await panel.ready.call(f.instance);f.guest.dispatchEvent(new Event('dom-ready'));await flush();
 const old=Editor.Message.request;
 Editor.Message.request=(pkg,method,...args)=>{if(method==='browser-debug-export-open')throw Error('Message does not exist');return old(pkg,method,...args)};
 f.elements.get('#export').dispatchEvent(new Event('click'));await flush();
 assert.match(f.elements.get('#status').textContent,/重新加载 Git Desk/);
 assert.equal(f.calls.some(c=>c[0]==='browser-debug-export'),false);
 Editor.Message.request=old;f.elements.get('#export').dispatchEvent(new Event('click'));await flush();
 assert.ok(f.calls.some(c=>c[0]==='browser-debug-export-open'));
});

test('DevTools targets the preview guest and waits until it is bound',async t=>{
 const f=fixture(t);let opened=0;f.guest.openDevTools=()=>opened++;await panel.ready.call(f.instance);
 f.elements.get('#devtools').dispatchEvent(new Event('click'));await flush();assert.equal(opened,0);assert.match(f.elements.get('#status').textContent,/尚未就绪/);
 f.guest.dispatchEvent(new Event('dom-ready'));await flush();f.elements.get('#devtools').dispatchEvent(new Event('click'));await flush();assert.equal(opened,1);
});

test('preview disposes its shared tooltip controller on close',async t=>{
 const f=fixture(t);await panel.ready.call(f.instance);const before=tooltipClosed;
 panel.close.call(f.instance);assert.equal(tooltipClosed,before+1);
 panel.close.call(f.instance);assert.equal(tooltipClosed,before+1);
});

test('version follows current preview status and clears when disconnected or reloading',async t=>{
 t.mock.timers.enable({apis:['setInterval']});const f=fixture(t);await panel.ready.call(f.instance);
 f.guest.dispatchEvent(new Event('dom-ready'));await flush();const old=Editor.Message.request;
 let connected=true,gameVersion='1.0.16_0_build-in_0';
 Editor.Message.request=(pkg,method,...args)=>method==='debug-preview-status'?Promise.resolve({ok:true,data:{connected,recording:{enabled:true,applied:true,gameVersion}}}):old(pkg,method,...args);
 t.mock.timers.tick(2000);await flush();assert.equal(f.elements.get('#game-version').textContent,gameVersion);
 gameVersion='1.0.16_0_hallbundle_3';t.mock.timers.tick(2000);await flush();assert.equal(f.elements.get('#game-version').textContent,gameVersion);
 connected=false;t.mock.timers.tick(2000);await flush();assert.equal(f.elements.get('#game-version').textContent,'');
 f.elements.get('#game-version').textContent='old';f.guest.dispatchEvent(new Event('did-start-loading'));assert.equal(f.elements.get('#game-version').textContent,'');
});

test('audio toggles the guest only, keeps mute after reload and does not change state on failure',async t=>{
 const f=fixture(t);await panel.ready.call(f.instance);
 f.guest.dispatchEvent(new Event('dom-ready'));await flush();
 const audio=f.elements.get('#audio');audio.dispatchEvent(new Event('click'));await flush();
 assert.deepEqual(f.calls.filter(c=>c[0]==='mute').at(-1),['mute',true]);
 assert.equal(audio.attrs['aria-pressed'],'true');assert.match(audio.title,/开启页面声音/);
 f.guest.dispatchEvent(new Event('dom-ready'));await flush();
 assert.deepEqual(f.calls.filter(c=>c[0]==='mute').at(-1),['mute',true]);
 const setMuted=f.guest.setAudioMuted;f.guest.setAudioMuted=()=>{throw Error('guest unavailable');};
 audio.dispatchEvent(new Event('click'));await flush();assert.equal(audio.attrs['aria-pressed'],'true');
 f.guest.setAudioMuted=setMuted;audio.dispatchEvent(new Event('click'));await flush();
 assert.deepEqual(f.calls.filter(c=>c[0]==='mute').at(-1),['mute',false]);assert.equal(audio.attrs['aria-pressed'],'false');
});
test('the preview tab docks the runtime panels when shown, restores Creator panels when hidden, and mounts its toolbar passively',async t=>{
 mounts=[];const f=fixture(t);await panel.ready.call(f.instance);const loads=f.calls.filter(c=>c[0]==='load').length;
 assert.equal(mounts.length,1);assert.equal(mounts[0].options.passive,true);assert.equal(mounts[0].options.viewer,'preview');
 assert.deepEqual(f.calls.filter(c=>c[0]==='runtime-inspector-dock').length,1,'opening the preview docks the panels once');
 panel.listeners.hide.call(f.instance);panel.listeners.show.call(f.instance);await flush();
 assert.deepEqual(f.calls.filter(c=>c[0]==='runtime-inspector-restore').length,1);assert.deepEqual(f.calls.filter(c=>c[0]==='runtime-inspector-dock').length,2);assert.deepEqual(mounts[0].visible,[false,true]);
 f.elements.get('#detach-inspector').dispatchEvent(new Event('click'));await flush();assert.ok(f.calls.some(c=>c[0]==='runtime-inspector-open'));
 assert.equal(f.calls.filter(c=>c[0]==='load').length,loads);
 assert.match(panel.template,/id="inspector-pick"/);assert.match(panel.template,/id="inspector-link"/);assert.match(panel.template,/id="inspector-capture"/);assert.match(panel.template,/id="inspector-render"/);
 assert.doesNotMatch(panel.template,/inspector-frame|inspector-keys|inspector-all|inspector-tree|inspector-detail|inspector-output|preview-logs|id="inspect"/);
 const restores=f.calls.filter(c=>c[0]==='runtime-inspector-restore').length;panel.close.call(f.instance);assert.equal(mounts[0].disposed,1);assert.equal(f.calls.filter(c=>c[0]==='runtime-inspector-restore').length,restores+1,'closing the preview closes the runtime tabs even before the page is bound');
});
test('status polling reflects the floating inspector on its button',async t=>{
 t.mock.timers.enable({apis:['setInterval']});const f=fixture(t);await panel.ready.call(f.instance);
 f.guest.dispatchEvent(new Event('dom-ready'));await flush();const old=Editor.Message.request;
 Editor.Message.request=(pkg,method,...args)=>method==='debug-preview-status'?Promise.resolve({ok:true,data:{connected:true,floating:true,recording:{enabled:true,applied:true,gameVersion:'1'}}}):old(pkg,method,...args);
 t.mock.timers.tick(2000);await flush();assert.equal(f.elements.get('#detach-inspector').attrs['aria-pressed'],'true');
});
test('audio preference restores per project and only persists a successful mute change',async t=>{
 const f=fixture(t),stored=new Map([['gitdesk-preview-muted:test','true'],['gitdesk-preview-muted:other','false']]);
 f.instance.$.preview.ownerDocument.defaultView={localStorage:{getItem:k=>stored.get(k)??null,setItem:(k,v)=>stored.set(k,v)}};
 await panel.ready.call(f.instance);assert.equal(f.elements.get('#audio').attrs['aria-pressed'],'true');
 f.guest.dispatchEvent(new Event('dom-ready'));await flush();assert.ok(f.calls.some(c=>c[0]==='mute'&&c[1]===true));
 f.elements.get('#audio').dispatchEvent(new Event('click'));await flush();assert.equal(stored.get('gitdesk-preview-muted:test'),'false');assert.equal(stored.get('gitdesk-preview-muted:other'),'false');
 f.guest.setAudioMuted=()=>{throw Error('gone');};f.elements.get('#audio').dispatchEvent(new Event('click'));await flush();assert.equal(stored.get('gitdesk-preview-muted:test'),'false');
});
test('zoom buttons scale the guest within range, persist per project, and fit follows the page metrics',async t=>{
 const f=fixture(t),stored=new Map();f.instance.$.preview.ownerDocument.defaultView={localStorage:{getItem:k=>stored.get(k)??null,setItem:(k,v)=>stored.set(k,v)}};
 const old=Editor.Message.request;let metrics={width:400,height:900,toolbar:50};
 Editor.Message.request=(pkg,method,...args)=>method==='debug-preview-metrics'?Promise.resolve({ok:true,data:metrics}):old(pkg,method,...args);
 await panel.ready.call(f.instance);f.guest.dispatchEvent(new Event('dom-ready'));await flush();
 assert.deepEqual(f.calls.filter(c=>c[0]==='zoom').at(-1),['zoom',1],'the page starts at 100%');
 f.elements.get('#zoom-in').dispatchEvent(new Event('click'));assert.deepEqual(f.calls.filter(c=>c[0]==='zoom').at(-1),['zoom',1.25]);
 for(let i=0;i<10;i++)f.elements.get('#zoom-in').dispatchEvent(new Event('click'));assert.deepEqual(f.calls.filter(c=>c[0]==='zoom').at(-1),['zoom',3],'zoom is capped');
 assert.deepEqual(JSON.parse(stored.get('gitdesk-preview-zoom:test')),{zoom:3,fit:false});
 f.elements.get('#zoom-fit').dispatchEvent(new Event('click'));await flush();await flush();
 assert.equal(f.elements.get('#zoom-fit').attrs['aria-pressed'],'true');assert.equal(f.elements.get('#zoom-in').hidden,true,'fit hides manual zoom');assert.deepEqual(f.calls.filter(c=>c[0]==='zoom').at(-1),['zoom',0.63],'800×600 host around a 400×950 page');
 metrics={width:1920,height:1080,toolbar:50};f.elements.get('#zoom-fit').dispatchEvent(new Event('click'));f.elements.get('#zoom-fit').dispatchEvent(new Event('click'));await flush();await flush();
 assert.deepEqual(f.calls.filter(c=>c[0]==='zoom').at(-1),['zoom',0.42]);
 f.elements.get('#zoom-fit').dispatchEvent(new Event('click'));assert.equal(f.elements.get('#zoom-out').hidden,false,'leaving fit shows manual zoom again');f.elements.get('#zoom-out').dispatchEvent(new Event('click'));assert.equal(f.elements.get('#zoom-fit').attrs['aria-pressed'],'false');
 assert.deepEqual(f.calls.filter(c=>c[0]==='zoom').at(-1),['zoom',0.34]);assert.equal(JSON.parse(stored.get('gitdesk-preview-zoom:test')).fit,false);
});
test('a saved zoom and fit preference is restored when the page binds',async t=>{
 const f=fixture(t),stored=new Map([['gitdesk-preview-zoom:test',JSON.stringify({zoom:0.5,fit:true})]]);f.instance.$.preview.ownerDocument.defaultView={localStorage:{getItem:k=>stored.get(k)??null,setItem:(k,v)=>stored.set(k,v)}};
 const old=Editor.Message.request;Editor.Message.request=(pkg,method,...args)=>method==='debug-preview-metrics'?Promise.resolve({ok:true,data:null}):old(pkg,method,...args);
 await panel.ready.call(f.instance);assert.equal(f.elements.get('#zoom-fit').attrs['aria-pressed'],'true');assert.equal(f.elements.get('#zoom-in').hidden,true);
 f.guest.dispatchEvent(new Event('dom-ready'));await flush();assert.deepEqual(f.calls.filter(c=>c[0]==='zoom').at(-1),['zoom',0.5]);
 const {fitZoom}=panel;assert.equal(fitZoom({width:800,height:600},{width:0,height:0,toolbar:0}),1,'missing metrics keep 100%');assert.equal(fitZoom({width:100,height:100},{width:1000,height:1000,toolbar:0}),0.25,'fit never goes below the range');
});
