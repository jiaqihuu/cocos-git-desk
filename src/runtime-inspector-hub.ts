import { t } from './i18n';
export interface RuntimeNode { uuid:string; parent:string; name:string; path:string; depth:number; active:boolean; activeInHierarchy:boolean; isPrefab?:boolean; childCount?:number; kind?:string; scripts?:boolean; }
export interface AssetReference { uuid:string; name:string; type:string; }
export interface RuntimeField { name:string; value:unknown; editable?:boolean; getter?:boolean; accessor?:boolean; enumList?:Array<{name:string;value:number}>; }
export interface RuntimeComponent { id:string; type:string; script:string; enabled:boolean; enabledInHierarchy:boolean; fields:RuntimeField[]; fieldsLimited:boolean; }
export interface RuntimeOwner { uuid:string; name:string; path:string; components:Array<{type:string;script:string}>; }
export interface RuntimeDetail extends RuntimeNode { prefab:AssetReference|null; prefabFileId:string; assets?:AssetReference[]; owner?:RuntimeOwner|null; position:unknown; rotation:unknown; scale:unknown; components:RuntimeComponent[]; componentsLimited:boolean; }
export interface Snapshot { digest?:string; unchanged?:boolean; picks?:number; hovered?:string; revealHover?:boolean; highlightMessage?:string; sessionId:string; picking:boolean; selected:string; nodes:RuntimeNode[]; candidates:RuntimeNode[]; candidateCount:number; detail:RuntimeDetail|null; offset:number; total:number; scanLimitReached:boolean; undoCount?:number; ancestors?:string[]; }
export type Method='snapshot'|'select'|'pick'|'close'|'hover'|'edit'|'undo'|'read'|'print'|'destroy'|'capture'|'captureCancel'|'renderSnapshot'|'hierarchy'|'inspect'|'layout';
export type Query='hierarchy'|'inspect'|'layout';
export interface Frame { id:string; name:string; url:string; }
export interface InspectorTransport { frames():Promise<Frame[]>; call(id:string,method:Method,args:unknown[]):Promise<unknown>; }
export interface HubOptions { contains:string; offset:number; link:boolean; collapsed:string[]; components:string[]; }
export interface HubChange { contains?:string; offset?:number; link?:boolean; capture?:false; fold?:string; component?:{id:string;open:boolean}; }
export interface CaptureState { pending:boolean; error:string; result:unknown; }
export interface HubState { serial:number; closed:boolean; frame:string; options:HubOptions; snapshot:Snapshot|null; message:string; waiting:boolean; capture:CaptureState|null; capturePending:boolean; }
const methods=new Set<Method>(['select','pick','edit','undo','print','destroy','capture']);
// Main asks every inspector surface for a semantic snapshot of what it renders; surfaces answer over runtime-inspector-report.
export const reportRequestBroadcast='cocos-git-desk:runtime-inspector-report-request';
// Errors can come from another realm (scene script, vm), so the message is read structurally.
// Failures while the page or engine is still loading (codes set by browser-debug/embedded.cjs and inspector-frames.cjs).
const loadingCodes=new Set(['ENGINE_NOT_LOADED','FRAME_REMOVED','PREVIEW_NOT_CONNECTED']);
export function loadingFailure(error:unknown):boolean { return !!error&&typeof error==='object'&&loadingCodes.has(String((error as {code?:unknown}).code)); }
export function reason(error:unknown):string { return error&&typeof error==='object'&&typeof (error as {message?:unknown}).message==='string'?(error as {message:string}).message:String(error); }
// Creator's console only shows text, so a print becomes a labelled, indented JSON block there.
export function formatPrint(record:unknown):string {
    const data=record&&typeof record==='object'?record as Record<string,unknown>:{};
    const text=JSON.stringify(data.data??record,null,2)??String(record);
    const body=text.length>60000?t('inspector.printTruncated', { text: text.slice(0,60000) }):text;
    return t('inspector.printHeader', { kind: String(data.kind||t('inspector.printResult')), name: String(data.name||''), path: String(data.path||''), body });
}
// One collector per preview: panels subscribe as viewers and receive published
// states; the page is polled only while a viewer is visible or a capture runs.
export class RuntimeInspectorHub {
    private viewers=new Map<string,boolean>();
    private options:HubOptions={contains:'',offset:0,link:true,collapsed:[],components:[]};
    private frame='';
    private lastFrames=0;
    private snapshot:Snapshot|null=null;
    private digest='';
    private reveal=false;
    private actionError='';
    // Set when a poll failed (for example before the engine finished loading); the next good poll clears it.
    private refreshFailed=false;
    // The current message is the loading-phase wait, shown quietly by the panels.
    private loading=false;
    private capture:CaptureState|null=null;
    private capturePending=false;
    private renderTimer=-Infinity;
    private timer?:ReturnType<typeof setInterval>;
    private busy=false;
    private epoch=0;
    private activeAt=0;
    private lastRefresh=0;
    private closed=false;
    private serial=0;
    private picks?:number;
    private printed:unknown=null;
    constructor(private transport:InspectorTransport, private publish:(state:HubState)=>void, private output:(record:unknown)=>void, private picked?:()=>void) {}
    state():HubState {
        const message=this.actionError||(this.snapshot?.scanLimitReached?t('inspector.scanLimit'):this.snapshot?.picking?t('inspector.picking'):'');
        return {serial:this.serial,closed:this.closed,frame:this.frame,options:{...this.options,collapsed:[...this.options.collapsed],components:[...this.options.components]},snapshot:this.snapshot,message,waiting:this.loading&&message===t('inspector.waitingGameLoad'),capture:this.capture,capturePending:this.capturePending};
    }
    private emit():void { this.serial++; this.publish(this.state()); }
    // Surfaces opened before the preview was bound learn about the hub from this broadcast and register.
    announce():void { if(!this.closed)this.emit(); }
    get isClosed():boolean { return this.closed; }
    lastPrint():unknown { return this.printed; }
    private active():boolean { for(const visible of this.viewers.values())if(visible)return true; return false; }
    // A viewer that has not reported yet (still registering) is treated as visible so it is not re-docked needlessly.
    viewerVisible(id:string):boolean { return this.viewers.get(id)!==false; }
    viewerStates():Record<string,boolean> { return Object.fromEntries(this.viewers); }
    setViewer(id:string,visible:boolean):void {
        if(this.closed)throw Error(t('inspector.previewClosed'));
        if(typeof id!=='string'||!id||id.length>64)throw Error(t('inspector.invalidView'));
        const wasActive=this.active();
        this.viewers.set(id,visible===true);
        if(this.active()){ if(!wasActive)this.activeAt=Date.now(); this.ensureTimer(); void this.refresh(true); }
        else if(wasActive&&!this.capturePending){ this.stopTimer(); this.stopRuntime(); }
    }
    private ensureTimer():void { if(!this.timer&&!this.closed)this.timer=setInterval(()=>void this.refresh(),300); }
    private stopTimer():void { if(this.timer)clearInterval(this.timer); this.timer=undefined; }
    private stopRuntime():void {
        if(!this.frame)return;
        void Promise.resolve().then(()=>this.transport.call(this.frame,'close',[])).catch(error=>{ if(!this.closed){ this.actionError=t('inspector.exitPickFailed', { error: reason(error) }); this.emit(); } });
    }
    private reset(message=''):void {
        this.picks=undefined;this.epoch++;this.snapshot=null;this.digest='';this.options.collapsed=[];this.options.components=[];this.options.offset=0;this.capture=null;this.capturePending=false;this.actionError=message;this.loading=false;this.activeAt=Date.now();
    }
    update(change:HubChange):boolean {
        if(this.closed)throw Error(t('inspector.previewClosed'));
        if(!change||typeof change!=='object')throw Error(t('inspector.invalidArgs'));
        if(typeof change.offset==='number'&&Number.isSafeInteger(change.offset))this.options.offset=Math.max(0,change.offset);
        if(typeof change.contains==='string'){ const value=change.contains.slice(0,200); if(value!==this.options.contains){this.options.contains=value;this.options.offset=0;} }
        if(change.capture===false){ this.capture=null; this.capturePending=false; if(this.frame)void Promise.resolve().then(()=>this.transport.call(this.frame,'captureCancel',[])).catch(()=>{}); }
        if(typeof change.link==='boolean')this.options.link=change.link;
        if(typeof change.fold==='string'&&change.fold){ const index=this.options.collapsed.indexOf(change.fold); if(index>=0)this.options.collapsed.splice(index,1); else this.options.collapsed.push(change.fold); }
        if(change.component&&typeof change.component.id==='string'){ const index=this.options.components.indexOf(change.component.id); if(change.component.open&&index<0)this.options.components.push(change.component.id); if(!change.component.open&&index>=0)this.options.components.splice(index,1); }
        this.epoch++;this.emit();void this.refresh(true);return true;
    }
    async action(method:Method,args:unknown[]):Promise<boolean> {
        if(this.closed)throw Error(t('inspector.previewClosed'));
        if(!methods.has(method)||!Array.isArray(args))throw Error(t('inspector.unsupportedAction'));
        // Tools may act before any panel polled the page, so the frame is discovered on demand.
        await this.loadFrames();
        if(!this.frame)throw Error(t('inspector.pageNotLoaded'));
        const epoch=++this.epoch;this.actionError='';this.digest='';
        try {
            const result=await this.transport.call(this.frame,method,method==='print'?[...args,{snapshot:true}]:args);
            if(epoch!==this.epoch||this.closed)return false;
            if(method==='capture'){this.capturePending=true;this.capture={pending:true,error:'',result:null};this.renderTimer=-Infinity;this.ensureTimer();}
            if(method==='print'){this.printed=result;this.output(result);}
            if(method==='select'){this.reveal=true;this.options.contains='';this.options.components=[];}
            await this.refresh(true);return true;
        } catch(error){ if(epoch===this.epoch&&!this.closed){this.actionError=reason(error);await this.refresh(true);this.emit();} return false; }
    }
    async read(uuid:string,id:string,key:string):Promise<unknown> {
        if(this.closed)throw Error(t('inspector.previewClosed'));
        if(!this.frame||!this.snapshot)throw Error(t('inspector.selectNodeFirst'));
        const value=await this.transport.call(this.frame,'read',[uuid,id,key,this.snapshot.sessionId]);
        this.digest='';await this.refresh(true);return value;
    }
    // Read-only page queries for AI tools; they never touch selection, polling or the overlay.
    async query(method:Query,args:unknown[]):Promise<unknown> {
        if(this.closed)throw Error(t('inspector.previewClosed'));
        if(method!=='hierarchy'&&method!=='inspect'&&method!=='layout')throw Error(t('inspector.unsupportedQuery'));
        await this.loadFrames();
        if(!this.frame)throw Error(t('inspector.pageNotLoaded'));
        return this.transport.call(this.frame,method,args);
    }
    private async loadFrames():Promise<void> {
        if(this.frame&&Date.now()-this.lastFrames<5000)return;
        const frames=await this.transport.frames();this.lastFrames=Date.now();
        if(!frames.some(frame=>frame.id===this.frame)){ this.frame=frames[0]?.id||''; this.reset(); }
    }
    async refresh(force=false):Promise<void> {
        const now=Date.now();
        if(force)this.activeAt=now;
        if(this.closed||this.busy)return;
        if(!this.active()&&!this.capturePending){this.stopTimer();return;}
        // An idle scene only needs a slow heartbeat; any change or interaction restores the fast cadence.
        if(!force&&now-this.activeAt>2000&&now-this.lastRefresh<1000&&!this.snapshot?.picking&&!this.capturePending)return;
        this.busy=true;this.lastRefresh=now;
        try {
            await this.loadFrames();
            // Frame discovery may reset state; the snapshot request reads the options after it.
            const epoch=this.epoch;
            if(this.closed||!this.frame)return;
            const state=await this.transport.call(this.frame,'snapshot',[{contains:this.options.contains,offset:this.options.offset,collapsed:[...this.options.collapsed],components:[...this.options.components],reveal:this.reveal,selected:this.snapshot?.selected||'',hovered:this.snapshot?.hovered||'',digest:this.digest,link:this.options.link}]) as Snapshot;
            if(this.closed||epoch!==this.epoch)return;
            let changed=false;
            if(this.refreshFailed){this.refreshFailed=false;this.loading=false;this.actionError='';changed=true;}
            if(!state.unchanged){
                if(this.snapshot&&this.snapshot.sessionId!==state.sessionId)this.reset();
                if(state.revealHover)this.options.contains='';
                this.snapshot=state;this.options.offset=state.offset;this.reveal=false;this.digest=state.digest||'';this.activeAt=Date.now();
                // Canvas picks bring the runtime tabs forward only while click linking is on.
                if(typeof state.picks==='number'){ if(this.picks!==undefined&&state.picks>this.picks&&this.options.link)this.picked?.(); this.picks=state.picks; }
                for(const id of state.ancestors||[]){const index=this.options.collapsed.indexOf(id);if(index>=0)this.options.collapsed.splice(index,1);}
                changed=true;
            }
            if(this.capturePending&&Date.now()-this.renderTimer>1000){
                this.renderTimer=Date.now();
                const data=await this.transport.call(this.frame,'renderSnapshot',[]) as CaptureState;
                if(this.closed||epoch!==this.epoch)return;
                this.capturePending=data?.pending===true;this.capture=data;changed=true;
            }
            if(changed)this.emit();
        } catch(error){ if(!this.closed){ const loading=loadingFailure(error); this.reset(loading?t('inspector.waitingGameLoad'):reason(error)); this.loading=loading; this.refreshFailed=true; this.emit(); } }
        finally{ this.busy=false; }
    }
    close():void {
        if(this.closed)return;
        this.closed=true;this.epoch++;this.stopTimer();this.viewers.clear();
        // The page may already be gone; releasing its hooks is best effort.
        if(this.frame)try{ void Promise.resolve(this.transport.call(this.frame,'close',[])).catch(()=>{}); }catch{}
        this.snapshot=null;this.capture=null;this.capturePending=false;this.actionError=t('inspector.previewClosed');this.serial++;this.publish(this.state());
    }
}
