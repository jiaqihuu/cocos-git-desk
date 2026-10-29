import { locateRuntimeAsset } from './runtime-inspector-assets';
import { RuntimeInspectorHub, HubChange, Method, Frame, formatPrint, reason, reportRequestBroadcast } from './runtime-inspector-hub';
import { ExtensionLog } from './extension-log';
import { EmbeddedPreview } from '../browser-debug/embedded.cjs';
import * as browserDebug from '../browser-debug/actions.cjs';
import { PreviewDebugService } from './preview-debug';
import { CreatorTools, CaptureResult } from './creator-tools';
import { compareLayout, DesignItem, RuntimeItem } from './layout-compare';
import { checkEditorState, EditorPreparationRequiredError, prepareEditorForGit } from './editor-preparation';
import { ReflogQuery, ReflogPage } from './types';
import { RemoteQuery, RemotePage } from './types';
import path from 'path';
import os from 'os';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import type { Task, RemoteCheckResult } from './types';
import { WorkspaceContexts } from './contexts';
import { t, MessageError } from './i18n';
import { loadConfig, defaultConfig, projectId, loadLocalSettings, toolCatalogue, GitDeskConfig, ToolSchema } from './config';
let embedded: EmbeddedPreview | undefined;
let debugService: PreviewDebugService | undefined;
let creator: CreatorTools | undefined;
// Everything the extension says or fails at is kept here for runtime_inspector_status and creator_extension_log.
const extensionLog = new ExtensionLog(console);
const latestReports = new Map<string, { time: string; report: unknown }>();
let hub: RuntimeInspectorHub | undefined;
let config: GitDeskConfig | undefined, configError: string | null = null;
let creatorPreviewUrl: Promise<string | null> | undefined, resolvedPreviewUrl: string | null | undefined;
let catalogue: ToolSchema[] | undefined;
const cacheDir = () => path.resolve(__dirname, '../.cache');
// git-desk.config.json at the project root; an invalid file is reported once and the defaults are used.
function projectConfig(): GitDeskConfig {
    if (!config) {
        try { config = loadConfig(Editor.Project.path); configError = null; }
        catch (error) { configError = reason(error); extensionLog.issue('config', configError); extensionLog.console.error(t('main.configLoadFailed', { error: configError })); config = defaultConfig(); }
    }
    return config;
}
// preview.url unset: follow the URL this Creator serves its preview on. A second Creator instance or a changed port does
// not use 7456, and two checkouts of one project share a project id, so guessing could inspect the other game. The
// answer is kept for the session; a missing answer is retried next time and 7456 stays the fallback meanwhile.
function previewUrl(): Promise<string | null> {
    const configured = projectConfig().preview.url;
    if (configured) return Promise.resolve(configured);
    if (!creatorPreviewUrl) {
        let request: Promise<unknown>;
        try { request = Promise.resolve(Editor.Message.request<unknown>('preview', 'query-preview-url')); } catch (error) { request = Promise.reject(error); }
        creatorPreviewUrl = request.then(value => typeof value === 'string' && /^https?:\/\//i.test(value) ? localPreview(value) : null,
            error => { extensionLog.issue('preview-url', reason(error)); return null; });
    }
    const pending = creatorPreviewUrl;
    return pending.then(url => { if (creatorPreviewUrl === pending) { resolvedPreviewUrl = url; if (!url) creatorPreviewUrl = undefined; } return url; });
}
// Creator reports its preview on a LAN address (for phones). Inside the editor the page is loaded through localhost when
// that address is this machine, keeping it a secure context (crypto.randomUUID, getGamepads, clipboard) as in Creator's
// own browser preview; the port, which differs per Creator instance, is kept.
function localPreview(value: string): string {
    try {
        const url = new URL(value), local = new Set(['localhost', '127.0.0.1', '::1']);
        for (const list of Object.values(os.networkInterfaces())) for (const item of list ?? []) local.add(item.address);
        if (url.hostname !== 'localhost' && local.has(url.hostname.replace(/^\[|\]$/g, ''))) url.hostname = 'localhost';
        return url.toString();
    } catch { return value; }
}
const sameUrl = (a: string, b: string): boolean => { try { const x = new URL(a), y = new URL(b); return x.origin === y.origin && x.pathname === y.pathname; } catch { return a === b; } };
function tools(): ToolSchema[] { return catalogue ||= toolCatalogue(projectConfig()); }
function debugSettings() {
    const cfg = projectConfig(), id = projectId(Editor.Project.path), local = loadLocalSettings(cacheDir(), id);
    // The defaults stand in for an unusable file everywhere except the environment allow-list: page commands are
    // refused until the file is fixed, so a broken file never widens the environments a project narrowed.
    return { projectId: id, bridge: cfg.bridge, configError, revisionRoots: cfg.revision.roots, stateDir: local.debug.stateDir, outputDir: local.debug.outputDir };
}
const inspectorPanels=['cocos-git-desk.runtime-hierarchy','cocos-git-desk.runtime-properties','cocos-git-desk.runtime-inspector'] as const;
function inspectorPreview():EmbeddedPreview {
    if(!embedded?.status().present)throw new MessageError('main.openPreviewFirst');
    return embedded;
}
// One hub per bound preview; it is the only poller and publishes to every inspector surface.
function inspectorHub():RuntimeInspectorHub {
    inspectorPreview();
    // Async wrappers turn a vanished preview into a rejection the hub can handle instead of a synchronous throw.
    if(!hub||hub.isClosed)hub=new RuntimeInspectorHub(
        {frames:async()=>inspectorPreview().inspectorFrames() as Promise<Frame[]>,call:async(id,method,args)=>inspectorPreview().inspectorCall(id,method,args) as Promise<unknown>},
        state=>Editor.Message.broadcast('cocos-git-desk:runtime-inspector',state),
        record=>{ extensionLog.console.info(formatPrint(record)); void Editor.Panel.focus('console').catch(()=>{}); },
        // A canvas pick brings both runtime panels forward, like selecting an object in Unity's scene view.
        ()=>void methods.runtimeInspectorDock().catch(()=>{}));
    return hub;
}
function closeHub():void { try { hub?.close(); } finally { hub=undefined; } }
// AI tools over the runtime inspector: read-only queries plus the two actions a person would also
// trigger from the panels (select, print). They share the hub, so the panels reflect the result.
async function runtimeTool(name:string,args:Record<string,unknown>):Promise<unknown> {
    if(name==='runtime_inspector_status')return inspectorStatus();
    const current=inspectorHub();
    const uuid=String(args.uuid||''),session=String(args.sessionId||'');
    switch(name){
        case 'runtime_inspector_hierarchy': return current.query('hierarchy',[args]);
        case 'runtime_inspector_layout': return current.query('layout',[args]);
        case 'runtime_inspector_layout_compare': {
            const design=Array.isArray(args.design)?args.design as unknown[]:[];
            if(!design.length||design.length>500)throw new MessageError('main.designCount');
            for(const item of design){ const box=item as Record<string,unknown>; if(!box||typeof box!=='object'||typeof box.name!=='string'||!box.name||['x','y','width','height'].some(key=>typeof box[key]!=='number'||!Number.isFinite(box[key] as number)))throw new MessageError('main.designItemShape'); }
            const layout=await current.query('layout',[{includeText:true,limit:1000,...(typeof args.root==='string'?{root:args.root}:{}),...(typeof args.contains==='string'?{contains:args.contains}:{})}]) as {nodes:RuntimeItem[];design:unknown;visible:unknown};
            const number=(value:unknown)=>typeof value==='number'?value:undefined;
            return { ...compareLayout(layout.nodes,design as DesignItem[],{tolerance:number(args.tolerance),scale:number(args.scale),offsetX:number(args.offsetX),offsetY:number(args.offsetY),matchBy:args.matchBy==='path'?'path':'name',ignoreCase:args.ignoreCase!==false}), runtimeDesign:layout.design, runtimeVisible:layout.visible };
        }
        case 'runtime_inspector_inspect': return current.query('inspect',[uuid,session,{componentId:args.componentId,all:args.all===true}]);
        case 'runtime_inspector_select': {
            if(!await current.action('select',[uuid,session]))throw Error(current.state().message||t('main.selectNodeFailed'));
            await methods.runtimeInspectorDock();
            return {selected:uuid,sessionId:session};
        }
        case 'runtime_inspector_print': {
            if(!await current.action('print',[uuid,String(args.componentId||''),session]))throw Error(current.state().message||t('main.printFailed'));
            return current.lastPrint();
        }
        default: throw new MessageError('main.unknownTool',{name});
    }
}
// One call that replaces "reload and look": preview binding, hub, panels, what each surface renders, recent failures.
async function inspectorStatus():Promise<unknown> {
    Editor.Message.broadcast(reportRequestBroadcast,Date.now());
    await new Promise<void>(resolve=>setTimeout(resolve,300));
    const panels:Record<string,boolean>={};
    for(const name of [...inspectorPanels,'cocos-git-desk.debug-preview','cocos-git-desk.default'])panels[name]=await Editor.Panel.has(name);
    const state=hub&&!hub.isClosed?hub.state():null;
    return { preview:embedded?.status()??{present:false,connected:false,targetId:null,generation:0}, observer:debugService?.status()??null,
        hub:state&&hub?{frame:state.frame,sessionId:state.snapshot?.sessionId??null,nodes:state.snapshot?.total??0,selected:state.snapshot?.selected??'',picking:!!state.snapshot?.picking,link:state.options.link,capturePending:state.capturePending,message:state.message,viewers:hub.viewerStates()}:null,
        panels, reports:Object.fromEntries(latestReports), issues:extensionLog.recentIssues(20),
        note:t('main.statusNote') };
}
function previewDebug():PreviewDebugService {
    const page=preview();
    if(!debugService)debugService=new PreviewDebugService(page,runtimeTool,tools(),debugSettings());
    return debugService;
}
function closePreviewDebug():void { try { debugService?.close(); } finally { debugService=undefined; } }
// Editor basics for the AI (asset lookup, open, refresh, editor state, type check, preview status) on the same MCP.
function creatorTools():CreatorTools {
    const gitRunning=()=>!!(contexts?.running()||desk().task()?.status==='running');
    if(!creator)creator=new CreatorTools({
        project:Editor.Project.path,
        request:(channel,message,...args)=>Editor.Message.request(channel,message,...args),
        selectAsset:id=>{ Editor.Selection.update('asset',[id]); const selected=Editor.Selection.getSelected('asset'); if(selected.length!==1||selected[0]!==id)throw new MessageError('main.assetSelectionUnconfirmed'); },
        assertIdle:()=>{ if(gitRunning())throw new MessageError('main.gitRunningEditor'); },
        gitRunning,
        profile:(pkg,key,scope)=>{ const profile=(Editor as unknown as {Profile?:{getConfig?:(pkg:string,key:string,scope:string)=>Promise<unknown>}}).Profile; if(!profile?.getConfig)return Promise.reject(new MessageError('main.noProfileApi')); return profile.getConfig(pkg,key,scope); },
        hasPanel:name=>Editor.Panel.has(name),
        openDebugPreview:async()=>{ const result=await methods.browserDebugOpen(); if(!result.ok)throw Error(result.error); return result.data; },
        log:query=>extensionLog.tail(query),
        taskPaths:async id=>{ const list=await desk().scopeList('.') as Array<{id:string;paths:string[]}>; return list.find(item=>item.id===id)?.paths??null; },
        capture:options=>captureEditor(options),
        metaCheck:options=>desk().metaCheck('.',options),
        languageKeys:options=>{ const i18n=projectConfig().i18n; return desk().languageKeys('.',{keyPattern:i18n.keyPattern,directory:i18n.directory,languages:i18n.languages,csvColumns:i18n.csvColumns,csvLayout:i18n.csvLayout,csvStatus:i18n.csvStatus,...options}); },
        fileAt:async(name,revision)=>{
            if(revision==='worktree'){ try { return await require('fs').promises.readFile(path.join(Editor.Project.path,name),'utf8') as string; } catch(error){ if((error as NodeJS.ErrnoException).code==='ENOENT')return null; throw error; } }
            return desk().fileAt('.',(revision==='index'?':':revision+':')+name);
        },
        // Creator 3.8.8 has no Editor.Package.reload; its extension manager reloads a package by sending
        // the extension package the reload message with the package directory, which is what we send.
        reloadExtension:async name=>{
            let target=name==='cocos-git-desk'?path.resolve(__dirname,'..'):'';
            if(!target){
                const pkg=(Editor as unknown as {Package?:{getPackages?:(options?:unknown)=>Array<{name?:string;path?:string;info?:{name?:string;path?:string}}>}}).Package;
                const list=typeof pkg?.getPackages==='function'?pkg.getPackages():[];
                const found=list.find(item=>item?.name===name||item?.info?.name===name);
                target=found?.path||found?.info?.path||'';
                if(!target)throw new MessageError('main.extensionNotFound',{name,loaded:list.map(item=>item?.name||item?.info?.name).filter(Boolean).slice(0,20).join(t('main.listSeparator'))});
            }
            const delayMs=400;
            setTimeout(()=>{ if(name==='cocos-git-desk')selfReload=true; Editor.Message.request('extension','reload',target).catch(error=>{ if(name==='cocos-git-desk')selfReload=false; extensionLog.console.error(t('main.reloadFailed',{error:String((error as Error)?.message??error)})); }); },delayMs);
            return {name,path:target,scheduled:true,delayMs};
        },
    },tools());
    return creator;
}
// The editor window is Creator's main BrowserWindow; a panel is located by its dock frame in the DOM
// and captured in content pixels (DOM bounds are CSS pixels, so the zoom factor is applied). A panel that is not
// docked lives in its own floating window, so every visible editor window is searched, the main one first.
async function captureEditor(options:{panel?:string}):Promise<CaptureResult> {
    interface Win { id:number; isDestroyed():boolean; isVisible():boolean; getSize():[number,number]; getTitle():string; webContents:{ getZoomFactor():number; executeJavaScript(code:string):Promise<unknown>; capturePage(rect?:{x:number;y:number;width:number;height:number}):Promise<{ toPNG():Buffer; getSize():{width:number;height:number} }> }; }
    const {BrowserWindow}=require('electron') as { BrowserWindow:{ getAllWindows():Win[] } };
    const windows=BrowserWindow.getAllWindows().filter(window=>!window.isDestroyed()&&window.isVisible());
    const area=(window:Win)=>{ const [w,h]=window.getSize(); return w*h; };
    const main=windows.find(window=>/cocos creator/i.test(window.getTitle()))??windows.sort((a,b)=>area(b)-area(a))[0];
    if(!main)throw new MessageError('main.noWindowToCapture');
    let target=main,scale=main.webContents.getZoomFactor();
    let rect:{x:number;y:number;width:number;height:number}|undefined;
    if(options.panel){
        // Every panel-frame in the window (through shadow roots) with its box, whether it is laid out, and
        // whether the point at its centre actually hits it: a panel behind another dock tab is not shown.
        const script='(()=>{const found=[];const walk=root=>{for(const node of root.querySelectorAll("*")){const tag=(node.tagName||"").toLowerCase();'+
            'if(tag==="panel-frame"||tag==="ui-panel"||tag==="dock-panel"){const r=node.getBoundingClientRect();const visible=r.width>0&&r.height>0&&node.getClientRects().length>0&&getComputedStyle(node).visibility!=="hidden";'+
            'let shown=false;if(visible){try{const hit=node.getRootNode().elementFromPoint(r.left+r.width/2,r.top+r.height/2);shown=!!hit&&(hit===node||node.contains(hit));}catch(e){shown=true;}}'+
            'found.push({name:node.getAttribute("name")||node.getAttribute("panel")||"",x:r.left,y:r.top,width:r.width,height:r.height,visible,shown});}'+
            'if(node.shadowRoot)walk(node.shadowRoot);}};walk(document);return found;})()';
        type Frame={name:string;x:number;y:number;width:number;height:number;visible:boolean;shown:boolean};
        let frames:Frame[]=[],matches:Frame[]=[],found:Frame|undefined;
        for(const window of [main,...windows.filter(item=>item!==main)]){
            let list:Frame[];
            try { list=await window.webContents.executeJavaScript(script) as Frame[]; } catch { continue; }
            frames=frames.concat(list);
            const here=list.filter(frame=>frame.name===options.panel),hit=here.find(frame=>frame.shown)??here.find(frame=>frame.visible);
            matches=matches.concat(here);
            if(hit){found=hit;target=window;scale=window.webContents.getZoomFactor();break;}
        }
        if(!found){
            const others=[...new Set(frames.filter(frame=>frame.name).map(frame=>frame.name+(frame.shown?'':t('main.panelHiddenSuffix'))))].slice(0,30).join(t('main.listSeparator'));
            throw Error((matches.length?t('main.panelNotShown',{panel:options.panel}):t('main.panelNotFound',{panel:options.panel}))+t('main.panelsAvailable',{panels:others||t('main.none')}));
        }
        rect={x:Math.round(found.x*scale),y:Math.round(found.y*scale),width:Math.round(found.width*scale),height:Math.round(found.height*scale)};
    }
    const image=await target.webContents.capturePage(rect);
    const size=image.getSize();
    return {png:image.toPNG(),title:target.getTitle(),bounds:rect??{x:0,y:0,width:size.width,height:size.height},scale};
}
// Results also go to the console: Creator's bottom status bar shows the latest console line, and the
// notification area is used when the Task API is available.
function notice(type:'info'|'success'|'warn'|'error',message:string):void {
    (type==='warn'||type==='error'?extensionLog.console.warn:extensionLog.console.info)(t('main.noticePrefix')+message);
    const task=(Editor as unknown as {Task?:{addNotice?:(options:{title:string;message:string;type:string;source:string;timeout:number})=>unknown}}).Task;
    try { task?.addNotice?.({title:t('main.noticeTitle'),message,type,source:'Git Desk',timeout:type==='warn'||type==='error'?8000:4000}); } catch {}
}
// Preview actions report through the same channels as resource navigation: the panel's own status
// text, the Creator console and the bottom notification area.
function announced<T>(work: () => Promise<T> | T, type: 'success' | 'info' = 'success'): Promise<Reply<T>> {
    return reply(work).then(result => { if (result.ok) { if (typeof result.data === 'string' && result.data) notice(type, result.data); } else notice('warn', result.error); return result; });
}
// Creator 3.8.8: open on an already docked extension panel brings its tab forward, but open on a
// built-in panel such as inspector spawns another floating instance, so built-ins are never opened here.
// A docked tab that is present but hidden behind Creator's own panel only comes forward by re-docking it;
// open/focus on an existing panel do not switch tabs reliably in 3.8.8.
async function dockPanel(anchor:string,name:string,viewer:string):Promise<void> {
    if(await Editor.Panel.has(name)){
        if(!hub||hub.viewerVisible(viewer))return;
        await Editor.Panel.close(name);
    }
    if(!await Editor.Panel.has(anchor)||!await Editor.Panel.openBeside(anchor,name)){
        if(!await Editor.Panel.open(name))throw new MessageError('main.panelOpenFailed',{name});
    }
    if(!await Editor.Panel.has(name))throw new MessageError('main.panelOpenFailed',{name});
}
function preview(url?: string | null): EmbeddedPreview {
    if (!embedded) { const cfg = projectConfig(); embedded = new EmbeddedPreview(Editor.Project.path, require('electron'), extensionLog.console, { url: url ?? cfg.preview.url ?? resolvedPreviewUrl ?? null, controlName: cfg.bridge.controlName, engineVersions: cfg.preview.engineVersions, projectId: projectId(Editor.Project.path) }); }
    return embedded;
}
let enabled = false;
let contexts: WorkspaceContexts | undefined;
function workspaceContexts(): WorkspaceContexts { return contexts ||= new WorkspaceContexts(desk(), navigateFile, async id => {
    // Creator 3.8.8 can return false after focusing an existing docked panel.
    await Editor.Panel.open('cocos-git-desk.default');
    if (!await Editor.Panel.has('cocos-git-desk.default')) throw new MessageError('main.openDeskForReview');
    Editor.Message.broadcast('cocos-git-desk:scope-review-requested', id);
}); }
import { GitDesk } from './git';
import { AgentBridge, AgentQuery } from './agent';
import { startMcpBridge } from './mcp-bridge';
import { editorFile, EditorFileAction } from './editor-files';
import { TagPage, TagQuery, TreePage, TreeQuery, MergeQuery, MergeState } from './types';
import { Commit, CommitDetails, CommitDraft, CompareQuery, Comparison, DiffRequest, DraftQuery, FileBlame, HistoryPage, HistoryQuery, InspectQuery, OperationRequest, Reply, RepoDetails, SyncPage, SyncQuery } from './types';

let service: GitDesk | undefined;
let agent: AgentBridge | undefined;
let paused = false;
let editorPreparing = false;
let mcpStartup: Promise<{ close(): Promise<void> } | undefined> | undefined;
function agentBridge(): AgentBridge { if (!agent) agent = new AgentBridge(desk(), navigateFile); return agent; }

let remoteProbePending = false;
async function startRemoteRefresh(repo: string): Promise<Task | null> {
    if (editorPreparing || workspaceContexts().externallyBusy('remote-refresh')) return null;
    if (typeof repo !== 'string' || !repo || repo.length > 4096) throw new MessageError('main.invalidRepo');
    const current = (await desk().snapshot(true)).repositories.find(r => r.id === repo);
    if (!current?.initialized || current.error) throw new MessageError('main.repoUnreadable');
    const plan = await desk().prepare({ repo, version: current.version, action: 'fetch' });
    return desk().execute(plan.token);
}

async function checkEditor(requireScene = false): Promise<void> {
    if (contexts?.externallyBusy('creator')) throw new MessageError('main.worktreeBusy');
    if (editorPreparing) throw new MessageError('main.editorPreparing');
    await checkEditorState(Editor.Message.request, requireScene);
}

function desk(): GitDesk {
    if (!service) service = new GitDesk(Editor.Project.path, path.resolve(__dirname, '../.cache'), {
        checkEditor,
        assertAvailable() { if (contexts?.externallyBusy('creator')) throw new MessageError('main.worktreeBusy');
            if (editorPreparing) throw new MessageError('main.editorPreparingGit'); },
        async beforeWorktreeChange() {
            if (await Editor.Message.request('asset-db', 'query-ready') !== true) throw new MessageError('main.assetDbBusy');
            await checkEditor(true);
            // The 3.8.8 pause argument is an operation label; resume must run even on Git failure.
            paused = true;
            try {
                if (await Editor.Message.request('asset-db', 'pause', 'Git Desk') !== true) throw new MessageError('main.assetDbPauseFailed');
            } catch (error) {
                await Editor.Message.request('asset-db', 'resume');
                paused = false;
                throw error;
            }
        },
        async afterWorktreeChange() {
            if (paused) {
                await Editor.Message.request('asset-db', 'resume');
                paused = false;
            }
            await Editor.Message.request('asset-db', 'refresh-asset', 'db://assets');
            await checkEditor(true);
            await Editor.Message.request('scene', 'soft-reload');
        },
    });
    return service;
}

async function reply<T>(work: () => Promise<T> | T): Promise<Reply<T>> {
    try { if (!enabled) throw new MessageError('main.notEnabled'); return { ok: true, data: await work() }; }
    catch (error) { return { ok: false, error: reason(error), ...(error instanceof EditorPreparationRequiredError ? { code: 'EDITOR_PREPARATION_REQUIRED' as const, worktreeChange: error.worktreeChange } : {}) }; }
}

async function navigateFile(repo: string, name: string, action: EditorFileAction) {
    if ((contexts?.running() || desk().task()?.status === 'running') && action !== 'describe') throw new MessageError('main.gitRunningNavigate');
    const result = await editorFile(Editor.Project.path, await desk().fileTarget(repo, name), action, <T>(channel: string, message: string, ...args: unknown[]): Promise<T> => {
        if (((channel === 'asset-db' && message === 'open-asset') || (channel === 'assets' && message === 'twinkle')) && (contexts?.running() || desk().task()?.status === 'running')) throw new MessageError('main.gitStartedDuringNavigate');
        return Editor.Message.request<T>(channel, message, ...args);
    });
    if (result.revealRequested || result.openRequested) {
        if (!result.uuid) throw new MessageError('main.navigateNoUuid');
        if ((contexts?.running() || desk().task()?.status === 'running')) throw new MessageError('main.gitStartedAfterNavigate');
        Editor.Selection.update('asset', [result.uuid]);
        const selected = Editor.Selection.getSelected('asset');
        if (selected.length !== 1 || selected[0] !== result.uuid) throw new MessageError('main.navigateSelectionUnconfirmed');
        await Editor.Panel.focus('assets');
    }
    return result;
}

// Creator's extension reload keeps an open debug preview tab on its old panel code, with nothing bound in the new
// main process. Unload closes the tab and leaves this marker; the next load reopens the tab once if it is fresh.
const previewPanel = 'cocos-git-desk.debug-preview';
// One marker per project: a global install shared by several projects must not reopen the tab in another one.
const reopenMarker = () => { let id = ''; try { id = projectId(Editor.Project.path); } catch {} return path.join(cacheDir(), 'debug-preview-reopen' + (id ? '-' + id : '')); };
let reopenTimer: ReturnType<typeof setTimeout> | undefined;
// An unload during quit leaves the tab to Creator's saved layout. Quitting through the editor window's close button
// reaches before-quit only after the window has closed, so that close counts as quitting too. A reload this extension
// requested itself (creator_reload_extension) always reopens, even after a cancelled window close.
let quitting = false, selfReload = false;
type Closable = { on(event: string, fn: () => void): unknown; removeListener(event: string, fn: () => void): unknown; isDestroyed?(): boolean };
let editorWindow: Closable | undefined;
const onQuit = () => { quitting = true; };
function watchQuit(on: boolean): void {
    try {
        const { app, BrowserWindow } = require('electron') as { app: Closable; BrowserWindow?: { getAllWindows?(): Array<Closable & { getTitle(): string }> } };
        app.removeListener('before-quit', onQuit); if (editorWindow && !editorWindow.isDestroyed?.()) editorWindow.removeListener('close', onQuit); editorWindow = undefined;
        if (!on) return;
        app.on('before-quit', onQuit);
        const windows = BrowserWindow?.getAllWindows?.() ?? [];
        editorWindow = windows.find(window => /cocos creator/i.test(window.getTitle())) ?? windows[0]; editorWindow?.on('close', onQuit);
    } catch {}
}
// Reads and consumes the marker; should this load run before the old unload wrote it, it looks once more.
function reopenFromMarker(retry: boolean): void {
    let closedAt = NaN;
    try { closedAt = Number(readFileSync(reopenMarker(), 'utf8')); rmSync(reopenMarker(), { force: true }); } catch {}
    const age = Date.now() - closedAt;
    if (age >= 0 && age < 120000) reopenTimer = setTimeout(() => {
        reopenTimer = undefined;
        void methods.browserDebugOpen().then(result => {
            if (!result.ok) { notice('warn', t('main.previewReopenFailed', { error: result.error })); return; }
            // The closed tab's own clean-up asks to restore Creator's panels and can arrive after the new tab docked the
            // runtime panels, closing them again; dock once more after it has settled.
            reopenTimer = setTimeout(() => { reopenTimer = undefined; void methods.runtimeInspectorDock(); }, 1500);
        });
    }, 500);
    else if (retry) reopenTimer = setTimeout(() => { reopenTimer = undefined; reopenFromMarker(false); }, 2000);
}
export function load(): void {
    startServices();
    quitting = false; selfReload = false;
    watchQuit(true);
    reopenFromMarker(true);
}
function startServices(): void {
    if (enabled) return;
    enabled = true;
    desk();
    workspaceContexts();
    void previewUrl();
    mcpStartup = workspaceContexts().worktrees.ready.then(() => startMcpBridge(cacheDir(), Editor.Project.path,
        (repo, query, context) => workspaceContexts().handle(repo, query, context),
        async (name, args) => {
            if (!enabled) throw new MessageError('main.notEnabledShort');
            try { return await (name.startsWith('creator_') ? creatorTools().call(name, args) : previewDebug().call(name, args)); }
            catch (error) { extensionLog.issue('mcp:' + name, reason(error)); throw error; }
        })).catch(error => { extensionLog.console.error(t('main.mcpNotStarted'), error); return undefined; });
}
export async function unload(): Promise<void> {
    clearTimeout(reopenTimer); reopenTimer = undefined;
    // The MCP port is released first, so a load that does not wait for this unload can bind it again.
    await (await mcpStartup)?.close(); mcpStartup = undefined;
    // Closed before the services stop, so the tab releases its page the usual way. The quit check follows an
    // await, so a before-quit emitted along with this unload has been seen.
    try {
        if (await Editor.Panel.has(previewPanel) && (selfReload || !quitting)) {
            mkdirSync(path.dirname(reopenMarker()), { recursive: true }); writeFileSync(reopenMarker(), String(Date.now()));
            await Editor.Panel.close(previewPanel);
        }
    } catch (error) { extensionLog.console.warn(t('main.previewCloseOnUnloadFailed', { error: reason(error) })); }
    watchQuit(false); selfReload = false;
    enabled = false;
    while (editorPreparing || remoteProbePending || contexts?.running() || service?.task()?.status === 'running') await new Promise<void>(resolve => setTimeout(resolve, 200));
    if (paused) { await Editor.Message.request('asset-db', 'resume'); paused = false; }
    closeHub();
    for(const name of inspectorPanels)if(await Editor.Panel.has(name))await Editor.Panel.close(name);
    closePreviewDebug();
    await embedded?.close(); embedded = undefined; creatorPreviewUrl = undefined; resolvedPreviewUrl = undefined;
    contexts = undefined; service = undefined; agent = undefined; creator = undefined; config = undefined; catalogue = undefined; latestReports.clear();
    // Creator 3.8.8 clears by registration path; symlink installs have real paths in Node's cache.
    const moduleRoot = path.resolve(__dirname) + path.sep;
    for (const filename of Object.keys(require.cache)) {
        if (filename.startsWith(moduleRoot) || filename.startsWith(path.resolve(__dirname, '../browser-debug') + path.sep)) delete require.cache[filename];
    }
}

export const methods = {
    browserDebugOpen: () => reply(async () => {
        const name = 'cocos-git-desk.debug-preview';
        if (await Editor.Panel.has(name)) await Editor.Panel.focus(name);
        else {
            const anchor = await Editor.Panel.has('cocos-git-desk.default') ? 'cocos-git-desk.default' : 'scene';
            if (!await Editor.Panel.has(anchor) || !await Editor.Panel.openBeside(anchor, name)) throw new MessageError('main.previewDockFailed');
        }
        if (!await Editor.Panel.has(name)) throw new MessageError('main.previewOpenFailed');
        return t('main.previewOpened');
    }),
    browserDebugExternal: () => announced(async () => browserDebug.openBrowser(Editor.Project.path, { url: await previewUrl(), projectId: projectId(Editor.Project.path) })),
    // The panel still reads codexConfigured: true when every client listed in git-desk.config.json is current.
    debugPreviewConfig: () => reply(async () => {
        const url = await previewUrl();
        // An instance an earlier MCP call created before the URL was known is replaced while no page is bound to it.
        if (embedded && url && !sameUrl(embedded.options.url, url) && !embedded.status().present) { closePreviewDebug(); await embedded.close(); embedded = undefined; }
        const p = preview(url), clients = projectConfig().clients; return {url:p.options.url,partition:p.partition,clients,codexConfigured:browserDebug.clientsConfigured(Editor.Project.path,{clients})}; }),
    // Every binding starts a fresh hub so stale viewers or frames from an earlier page never linger;
    // the saved debug preference is pushed to the page as soon as it connects.
    debugPreviewBind: (id: number) => reply(async () => { await preview().bind(id); closeHub(); inspectorHub().announce(); void previewDebug().reconcile(); return true; }),
    runtimeInspectorOpen: () => reply(async () => {
        inspectorHub();
        await Editor.Panel.open('cocos-git-desk.runtime-inspector');
        await Editor.Panel.focus('cocos-git-desk.runtime-inspector');
        return t('main.inspectorOpened');
    }),
    // The panels do not need the hub yet: they register once the preview binds and the hub announces itself.
    runtimeInspectorDock: () => reply(async () => {
        await dockPanel('hierarchy','cocos-git-desk.runtime-hierarchy','hierarchy');
        await dockPanel('inspector','cocos-git-desk.runtime-properties','properties');
        return '';
    }),
    runtimeInspectorRestore: () => reply(async () => {
        // Closing the runtime tabs is the only reliable way back to Creator's own hierarchy and inspector.
        for(const name of ['cocos-git-desk.runtime-hierarchy','cocos-git-desk.runtime-properties'])if(await Editor.Panel.has(name))await Editor.Panel.close(name);
        return '';
    }),
    runtimeInspectorState: () => reply(() => inspectorHub().state()),
    runtimeInspectorView: (viewer:string,visible:boolean) => reply(() => { inspectorHub().setViewer(viewer,visible); return true; }),
    runtimeInspectorUpdate: (change:HubChange) => reply(() => inspectorHub().update(change)),
    runtimeInspectorAction: (method:Method,args:unknown[]) => reply(() => inspectorHub().action(method,args)),
    runtimeInspectorRead: (uuid:string,id:string,key:string) => reply(() => inspectorHub().read(uuid,id,key)),
    // Panels answer the status broadcast here, and report renderer errors the same way.
    runtimeInspectorReport: (viewer:string, report:{kind?:string;message?:string}) => reply(() => {
        if(typeof viewer!=='string'||!viewer||viewer.length>64||!report||typeof report!=='object')throw new MessageError('main.invalidPanelReport');
        if(report.kind==='issue')extensionLog.issue('panel:'+viewer,String(report.message||t('main.unknownError')));
        else latestReports.set(viewer,{time:new Date().toISOString(),report});
        return true;
    }),
    runtimeInspectorCall: (id:string,method:string,args:unknown[]) => reply(() => inspectorPreview().inspectorCall(id,method,args)),
    runtimeInspectorAsset: (uuid:string, action:'reveal'|'open'|'prefab', fileId?:string) => reply(async () => {
        const checkNavigation = () => { if(contexts?.running() || desk().task()?.status === 'running') throw new MessageError('main.gitRunningLocate'); };
        checkNavigation();
        const message = await locateRuntimeAsset(uuid,action,async <T>(channel:string,message:string,...args:unknown[]):Promise<T> => {
            checkNavigation();return Editor.Message.request<T>(channel,message,...args);
        },id=>{checkNavigation();Editor.Selection.update('asset',[id]);
            const selected=Editor.Selection.getSelected('asset');if(selected.length!==1||selected[0]!==id)throw new MessageError('main.assetSelectionUnconfirmed');
        },fileId,id=>{checkNavigation();Editor.Selection.update('node',[id]);return Editor.Selection.getSelected('node').includes(id);});
        if(action==='reveal')await Editor.Panel.focus('assets');
        // Source navigation hands over to editor mode: scene editor plus Creator's own hierarchy and inspector.
        if(action==='prefab'){ await Editor.Panel.open('scene'); await Editor.Panel.focus('scene'); await methods.runtimeInspectorRestore(); }
        notice('success',message);
        return message;
    }).then(result=>{ if(!result.ok)notice('warn',result.error); return result; }),
    debugPreviewMetrics: () => reply(() => embedded?.pageMetrics() ?? null),
    // The panel's 2 s status poll doubles as the preference reconciliation tick (page reloads, late page bridge).
    debugPreviewStatus: () => reply(async () => {
        const page = await embedded?.pageStatus() as {present:boolean;connected:boolean;recording:Record<string,unknown>|null} | undefined;
        const preference = page && embedded ? await previewDebug().reconcile(false, page.recording) : null;
        return {...(page || {present:false,connected:false}),recording:page?.recording || preference ? {...(page?.recording || {}),...(preference || {})} : null,
            floating:await Editor.Panel.has('cocos-git-desk.runtime-inspector')};
    }),
    browserDebugExport: () => announced(async () => {
        const { directory } = await previewDebug().exportEvidence({ screenshot: true }) as { directory: string };
        try {
            const error = await require('electron').shell.openPath(directory);
            if (error) return t('main.exportedOpenFailed', { directory, error });
        }
        catch (error) { return t('main.exportedOpenFailed', { directory, error: String(error) }); }
        return t('main.exportedOpened', { directory });
    }),
    debugPreviewRelease: (id: number) => reply(async () => {
        embedded?.release(id);
        if (!embedded?.status().present) {
            closeHub();
            for(const name of inspectorPanels)if(await Editor.Panel.has(name))await Editor.Panel.close(name);
        }
        return true;
    }),
    // Kept under its historical message name: shows the MCP configuration for AI clients and writes the
    // files for the clients listed in git-desk.config.json (codex: .codex/config.toml, claude-code: .mcp.json).
    browserDebugConnectCodex: () => announced(() => {
        const result = browserDebug.configureClients(Editor.Project.path, { clients: projectConfig().clients });
        const written = result.written.length ? t('main.clientsWritten', { files: result.written.join(t('main.listSeparator')) }) : t('main.clientsNoneWritten');
        return written + '\n\n' + t('main.clientsSnippets', { codex: result.snippets.codex.trim(), claude: result.snippets.claudeCode.trim() });
    }, 'info'),
    // The observer switch runs on every preview open, so only a failure is worth a notification.
    browserDebugSetEnabled: (value: boolean) => reply(() => previewDebug().setEnabled(value)).then(result => { if (!result.ok) notice('warn', result.error); return result; }),
    prepareEditor: (requireScene: boolean) => reply(async () => {
        if (typeof requireScene !== 'boolean') throw new MessageError('main.prepareArgInvalid');
        if (editorPreparing || (contexts?.running() || desk().task()?.status === 'running')) throw new MessageError('main.prepareBusy');
        editorPreparing = true;
        const project = Editor.Project.path;
        try {
            return await prepareEditorForGit(requireScene, {
                request: Editor.Message.request,
                assertIdle() {
                    if (Editor.Project.path !== project || (contexts?.running() || desk().task()?.status === 'running')) throw new MessageError('main.prepareStateChanged');
                },
                async confirm(detail) {
                    const answer = await Editor.Dialog.warn(t('main.unsavedQuestion'), { title: t('main.unsavedTitle'), detail, buttons: [t('main.cancel'), t('main.saveAndContinue'), t('main.discardAndContinue')], default: 0, cancel: 0 });
                    return answer.response === 1 ? 'save' : answer.response === 2 ? 'discard' : false;
                },
            });
        } finally { editorPreparing = false; }
    }),
    open: async (): Promise<boolean> => {
        startServices();
        const name = 'cocos-git-desk.default';
        if (await Editor.Panel.has(name)) return Editor.Panel.open(name);
        for (const anchor of ['scene', 'assets']) {
            if (!await Editor.Panel.has(anchor)) continue;
            if (await Editor.Panel.openBeside(anchor, name)) return true;
            throw new MessageError('main.deskDockFailed');
        }
        throw new MessageError('main.deskNeedsAnchor');
    },
    snapshot: (force = false, changedRepo?: string) => reply(async () => {
        if (changedRepo !== undefined && (typeof changedRepo !== 'string' || !changedRepo || changedRepo.length > 4096)) throw new MessageError('main.invalidRepo');
        return { ...await desk().snapshot(force, changedRepo), task: workspaceContexts().displayTask() };
    }),
    scopeReviews: () => reply(() => workspaceContexts().reviews.list()),
    scopeReviewView: (id: string) => reply(() => workspaceContexts().reviews.view(id)),
    scopeReviewDecision: (id: string, digest: string, approve: boolean) => reply(() => { if (typeof approve !== 'boolean') throw new MessageError('main.reviewDecisionInvalid'); return workspaceContexts().reviewDecision(id, digest, approve); }),
    details: (repo: string, query?: CompareQuery | DraftQuery | AgentQuery | TagQuery | TreeQuery | MergeQuery | RemoteQuery | ReflogQuery) => {
        if (!enabled) return reply(() => undefined);
        if (query && typeof query === 'object' && 'kind' in query && query.kind === 'agent') {
            return agentBridge().handle(repo, query);
        }
        return reply<RepoDetails | Comparison | CommitDraft | TagPage | TreePage | MergeState | RemotePage | ReflogPage>(() => {
            if (query && 'kind' in query) {
                if (query.kind === 'reflog') return desk().reflog(repo, query);
                if (query.kind === 'remotes') return desk().remotePage(repo, query);
                if (query.kind === 'merge') {
                    if (Object.keys(query).some(key => key !== 'kind')) throw new MessageError('main.mergeQueryArgs');
                    return desk().mergeState(repo);
                }
                if (query.kind === 'tree') return desk().tree(repo, query);
                if (query.kind === 'tags') return desk().tags(repo, query);
                if (query.kind === 'draft') return desk().commitDraft(repo, query);
                throw new MessageError('main.detailsKindUnsupported');
            }
            return query ? desk().compare(repo, query) : desk().details(repo);
        });
    },
    diff: (request: DiffRequest) => reply(() => desk().diff(request)),
    history: (repo: string, skip = 0, query?: HistoryQuery | InspectQuery | SyncQuery) => reply<HistoryPage | Commit[] | CommitDetails | FileBlame | SyncPage>(() => {
        if (query && 'kind' in query) {
            if (query.kind === 'sync') return desk().syncPage(repo, query);
            if (query.kind === 'commit') return desk().commitDetails(repo, query.revision);
            if (query.kind === 'blame') return desk().blame(repo, query);
            throw new MessageError('main.historyKindUnsupported');
        }
        return query ? desk().historyPage(repo, query) : desk().history(repo, skip);
    }),
    commitFiles: (repo: string, revision: string, kind: 'commit' | 'stash' = 'commit') => reply(() => {
        if (kind !== 'commit' && kind !== 'stash') throw new MessageError('main.commitKindUnsupported');
        return kind === 'stash' ? desk().stashFiles(repo, revision) : desk().commitFiles(repo, revision);
    }),
    refreshRemote: (repo: string) => reply(() => startRemoteRefresh(repo)),
    checkRemote: (repo: string) => reply<RemoteCheckResult>(async () => {
        if (typeof repo !== 'string' || !repo || repo.length > 4096) throw new MessageError('main.invalidRepo');
        if (remoteProbePending || editorPreparing || workspaceContexts().externallyBusy('remote-check')) return { state: 'busy' };
        remoteProbePending = true;
        try {
            const changed = await desk().remoteChanged(repo), checkedAt = new Date().toISOString();
            if (editorPreparing || workspaceContexts().externallyBusy('remote-check')) return { state: 'busy' };
            if (!changed) return { state: 'unchanged', checkedAt };
            const task = await startRemoteRefresh(repo);
            return task ? { state: 'changed', checkedAt, task } : { state: 'busy' };
        } finally { remoteProbePending = false; }
    }),
    prepare: (request: OperationRequest) => reply(() => desk().prepare(request)),
    execute: (token: string) => reply(() => desk().execute(token)),
    task: () => reply(() => workspaceContexts().displayTask()),
    reveal: (repo: string, name: string, action?: EditorFileAction) => reply(async () => {
        if (action !== undefined) return navigateFile(repo, name, action);
        const file = await desk().reveal(repo, name);
        const asset = file.endsWith('.meta') ? file.slice(0, -5) : file;
        const uuid = await Editor.Message.request<unknown>('asset-db', 'query-uuid', asset);
        if (typeof uuid !== 'string' || !uuid) throw new MessageError('main.fileNotInAssetDb');
        await Editor.Message.request('assets', 'twinkle', uuid);
        return file;
    }),
};
// Every failed reply is remembered for runtime_inspector_status, so a panel error can be read without the Creator console.
for (const [name, fn] of Object.entries(methods) as Array<[string, (...args: unknown[]) => unknown]>) {
    (methods as Record<string, unknown>)[name] = async (...args: unknown[]) => {
        const result = await fn(...args);
        if (result && typeof result === 'object' && (result as { ok?: unknown }).ok === false && typeof (result as { error?: unknown }).error === 'string') extensionLog.issue(name, (result as { error: string }).error);
        return result;
    };
}
