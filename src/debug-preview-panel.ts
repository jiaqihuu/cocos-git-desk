import { pickTemplate, linkTemplate, inspectorActionsTemplate, renderTemplate, inspectorTheme, inspectorStyle, mountInspector, InspectorMount } from './runtime-inspector-panel';
import { PreviewDockSize } from './preview-dock-size';
import { PanelTooltips, setTooltipTitle } from './panel-tooltips';
import { BrowserDebugFeedback } from './browser-debug-feedback';
import type { Reply } from './types';
import { t } from './i18n';
import { attr, html } from './panel-i18n';
// "Configure AI client" result: the main process report (what was written) plus the .mcp.json / config.toml snippets.
const clientConfigTemplate = `<section id="client-config" class="client-config" aria-labelledby="client-config-title" hidden><div class="client-config-head"><strong id="client-config-title">${html('panel.preview.clientConfigTitle')}</strong><span id="client-config-note" role="status" aria-live="polite"></span><button id="client-config-copy" class="text" type="button">${html('panel.preview.clientConfigCopy')}</button><button id="client-config-close" type="button" aria-label="${attr('panel.preview.clientConfigClose')}" title="${attr('panel.preview.clientConfigClose')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button></div><pre id="client-config-text" tabindex="0"></pre></section>`;
export const template = `<div id="preview"><header><div class="actions" role="group" aria-label="${attr('panel.preview.actionsAria')}">
<button id="reload" type="button" aria-label="${attr('panel.preview.reload')}" title="${attr('panel.preview.reload')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7"/></svg></button>
<button id="export" type="button" aria-label="${attr('panel.preview.export')}" title="${attr('panel.preview.exportTitle')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></svg></button>
<button id="external" type="button" aria-label="${attr('panel.html.browser-debug-external')}" title="${attr('panel.preview.externalTitle')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7"/></svg></button>
<button id="devtools" type="button" aria-label="${attr('panel.preview.devtools')}" title="${attr('panel.preview.devtoolsTitle')}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/></svg></button>
<span class="sep" aria-hidden="true"></span><button id="zoom-out" type="button" aria-label="${attr('panel.preview.zoomOut')}" title="${attr('panel.preview.zoomOutTitle')}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5M8 11h6"/></svg></button><button id="zoom-in" type="button" aria-label="${attr('panel.preview.zoomIn')}" title="${attr('panel.preview.zoomInTitle')}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5M8 11h6m-3-3v6"/></svg></button><button id="zoom-fit" type="button" aria-pressed="false" aria-label="${attr('panel.preview.fit')}" title="${attr('panel.preview.fitTitle')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><rect x="8" y="8" width="8" height="8" rx="1"/></svg></button><span class="sep" aria-hidden="true"></span>
${pickTemplate}${linkTemplate}${inspectorActionsTemplate}<span class="sep" aria-hidden="true"></span>
<button id="detach-inspector" type="button" aria-pressed="false" title="${attr('panel.preview.detachTitle')}" aria-label="${attr('panel.preview.detach')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7m0-7L10 14"/><path d="M19 14v6H5V6h6"/></svg></button>
<button id="audio" type="button" aria-label="${attr('panel.preview.mute')}" aria-pressed="false" title="${attr('panel.preview.soundOn')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4 6 8H3v8h3l5 4Z"/><path class="sound-on" d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/><path class="sound-off" d="m16 9 6 6m0-6-6 6"/></svg></button>
<button id="codex" type="button" aria-label="${attr('panel.preview.configureClient')}" title="${attr('panel.preview.configureClient')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 20"/></svg></button>
</div><div class="messages"><span id="status" role="status" aria-live="polite">${html('panel.preview.connecting')}…</span><span id="connection" role="status"></span><span class="inspector-message" role="status"></span></div><span id="game-version" title="${attr('panel.preview.gameVersion')}"></span></header>${clientConfigTemplate}${renderTemplate}<div id="preview-body"><div id="host"></div></div></div>`;
export const style = inspectorTheme+`:host{display:flex;height:100%;background:var(--gd-bg);color:var(--gd-text);font-family:var(--font-family,system-ui,sans-serif)}#preview{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:0}header{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:4px 8px;border-bottom:1px solid var(--gd-border);background:var(--gd-bg-weak)}.actions{display:flex;flex-wrap:wrap;align-items:center;gap:4px;flex-shrink:0}.actions .sep{width:1px;height:16px;background:var(--gd-line);margin:0 3px}button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:24px;background:transparent;color:var(--gd-text);border:1px solid transparent;border-radius:2px;padding:3px;cursor:pointer;font:inherit}button:hover{background:var(--gd-hover);color:var(--gd-text-strong)}button:focus-visible{outline:1px solid var(--gd-focus);outline-offset:1px}button:disabled{opacity:.5;cursor:wait}button[hidden]{display:none}button[aria-pressed="true"]{background:var(--gd-active);color:#fff}#audio .sound-off{display:none}#audio[aria-pressed="true"] .sound-off{display:block}#audio[aria-pressed="true"] .sound-on{display:none}svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.messages{flex:1 1 0;min-width:0;margin-left:auto;display:flex;justify-content:flex-end;align-items:center;gap:10px;font-size:11px;line-height:16px;overflow:hidden;white-space:nowrap}.messages span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.messages span:empty{display:none}#connection{color:var(--gd-warn)}#connection.waiting{color:var(--gd-text-weak)}#game-version{flex-shrink:0;font-size:11px;color:var(--gd-text-weak);white-space:nowrap}#game-version:empty{display:none}#preview-body{display:flex;flex:1;min-height:0;min-width:0}#host{flex:1;min-height:0;display:flex;background:#000}webview{flex:1;width:100%;height:100%}.gd-tooltip{position:absolute;z-index:1000;pointer-events:none;width:max-content;max-width:calc(100% - 16px);padding:6px 9px;border:1px solid var(--gd-line);border-radius:3px;background:var(--gd-bg-weaker);color:var(--gd-text-strong);white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 sans-serif;box-shadow:0 4px 14px #0007}.gd-tooltip[hidden]{display:none}`+inspectorStyle+`
#preview .inspector-message{color:#efbc79}#preview .inspector-message.waiting{color:var(--gd-text-weak)}#preview #inspector-render{flex:none;max-height:40vh;overflow:auto;padding:4px 8px;border-bottom:1px solid #465264}#preview .client-config{flex:none;display:flex;flex-direction:column;max-height:45vh;min-height:0;border-bottom:1px solid var(--gd-border);background:var(--gd-bg-weak)}#preview .client-config[hidden]{display:none}#preview .client-config-head{display:flex;align-items:center;gap:8px;padding:4px 8px}#preview .client-config-head strong{font-size:12px;white-space:nowrap}#preview #client-config-note{flex:1;min-width:0;font-size:11px;color:var(--gd-text-weak);text-align:right;overflow-wrap:anywhere}#preview .client-config button.text{width:auto;padding:0 8px;white-space:nowrap;border-color:var(--gd-line)}#preview #client-config-text{flex:1;min-height:0;margin:0;padding:6px 8px;overflow:auto;white-space:pre;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;color:var(--gd-text-strong);user-select:text;-webkit-user-select:text}`;
export const $ = {preview:'#preview'};
interface Guest extends HTMLElement { getWebContentsId(): number; loadURL(url: string): Promise<void>; reload(): void; openDevTools(): void; setAudioMuted(muted:boolean):void; setZoomFactor(factor:number):void; }
interface PageMetrics { width:number; height:number; toolbar:number; }
const zoomRange=[0.25,3] as const;
// Fit keeps the device frame plus the page toolbar inside the host, never upscaling beyond the zoom range.
export function fitZoom(host:{width:number;height:number},metrics:PageMetrics):number {
    if(!(metrics.width>0&&metrics.height>0)||!(host.width>0&&host.height>0))return 1;
    const factor=Math.min(host.width/metrics.width,host.height/(metrics.height+metrics.toolbar));
    return Math.round(Math.max(zoomRange[0],Math.min(zoomRange[1],factor))*100)/100;
}
interface Instance { $: {preview:HTMLElement}; dispose?:()=>void; dockSize?:PreviewDockSize; visibility?:(value:boolean)=>void; }
async function request<T>(method:string,...args:unknown[]):Promise<T> {
    const reply = await Editor.Message.request<Reply<T>>('cocos-git-desk',method,...args);
    if (!reply.ok) throw Error(reply.error); return reply.data;
}
export async function ready(this:Instance):Promise<void> {
    const root=this.$.preview, status=root.querySelector<HTMLElement>('#status')!;
    // Messages stay on one line; the full text (long errors included) is in the tooltip.
    const Observer=(root.ownerDocument?.defaultView as (Window & typeof globalThis)|null)?.MutationObserver;
    const messageTitles=Observer?new Observer(()=>{for(const span of root.querySelectorAll<HTMLElement>('.messages span'))span.title=span.textContent||'';}):null;
    const messages=root.querySelector('.messages');if(messageTitles&&messages)messageTitles.observe(messages,{subtree:true,childList:true,characterData:true});
    const tooltips=new PanelTooltips(root);
    this.dockSize=new PreviewDockSize(root);
    this.dockSize.show();
    let closed=false, id:number|undefined, bound=false, muted=false, audioPreferenceKey='', zoomKey='', zoom=1, fit=false, fitting=false;
    const audio=root.querySelector<HTMLButtonElement>('#audio')!;
    const updateAudioButton=()=>{audio.setAttribute('aria-pressed',String(muted));setTooltipTitle(audio,muted?t('panel.preview.soundOff'):t('panel.preview.soundOn'));};
    const feedback=new BrowserDebugFeedback((message,pending)=>{if(closed)return;status.textContent=message;for(const b of root.querySelectorAll<HTMLButtonElement>('.actions button'))b.disabled=pending;});
    const guest=root.ownerDocument.createElement('webview') as Guest;
    const host=root.querySelector<HTMLElement>('#host')!,fitButton=root.querySelector<HTMLButtonElement>('#zoom-fit')!;
    const saveZoom=()=>{try{root.ownerDocument.defaultView?.localStorage.setItem(zoomKey,JSON.stringify({zoom,fit}));}catch{}};
    const applyZoom=(factor:number,persist=true)=>{
        zoom=Math.round(Math.max(zoomRange[0],Math.min(zoomRange[1],factor))*100)/100;
        if(bound)try{guest.setZoomFactor(zoom);}catch(error){status.textContent=t('panel.preview.zoomFailed',{error:String(error)});}
        setTooltipTitle(root.querySelector<HTMLElement>('#zoom-in')!,t('panel.preview.zoomInCurrent',{percent:Math.round(zoom*100)}));setTooltipTitle(root.querySelector<HTMLElement>('#zoom-out')!,t('panel.preview.zoomOutCurrent',{percent:Math.round(zoom*100)}));
        if(persist)saveZoom();
    };
    const refit=async()=>{
        if(closed||!fit||!bound||fitting)return;fitting=true;
        try { const metrics=await request<PageMetrics|null>('debug-preview-metrics');const rect=host.getBoundingClientRect();if(closed||!fit||!metrics)return;const factor=fitZoom({width:rect.width,height:rect.height},metrics);if(Math.abs(factor-zoom)>=0.01)applyZoom(factor,false); }
        catch(error){ if(!closed)status.textContent=t('panel.preview.metricsFailed',{error:String(error)}); }
        finally{ fitting=false; }
    };
    const showZoom=()=>{for(const id of ['#zoom-in','#zoom-out'])root.querySelector<HTMLElement>(id)!.hidden=fit;};
    const setFit=(value:boolean)=>{fit=value;fitButton.setAttribute('aria-pressed',String(fit));showZoom();saveZoom();if(fit)void refit();};
    root.querySelector('#zoom-in')!.addEventListener('click',()=>{if(fit)setFit(false);applyZoom(zoom*1.25);});
    root.querySelector('#zoom-out')!.addEventListener('click',()=>{if(fit)setFit(false);applyZoom(zoom/1.25);});
    fitButton.addEventListener('click',()=>setFit(!fit));
    const observer=typeof ResizeObserver==='function'?new ResizeObserver(()=>void refit()):undefined;observer?.observe(host);
    // The toolbar follows the shared inspector state without keeping the page polled on its own.
    const inspector:InspectorMount=mountInspector(root,{passive:true,viewer:'preview'});
    let visible=true;
    // Showing the preview tab brings the runtime panels forward in their dock groups; hiding it restores Creator's own.
    const arrange=(value:boolean)=>void request<string>(value?'runtime-inspector-dock':'runtime-inspector-restore').catch(error=>{if(!closed&&value)status.textContent=String(error);});
    this.visibility=value=>{visible=value;inspector.setVisible(value);arrange(value);};
    arrange(true);
    root.querySelector('#detach-inspector')!.addEventListener('click',()=>void feedback.run(t('panel.preview.openingDetached'),()=>request<string>('runtime-inspector-open')));
    // Configuring an AI client does not need a running preview, so the entry is always available. The main process writes
    // only the clients named in git-desk.config.json and returns a report with both snippets, shown here for copying.
    const clientConfig=root.querySelector<HTMLElement>('#client-config')!,clientText=root.querySelector<HTMLElement>('#client-config-text')!,clientNote=root.querySelector<HTMLElement>('#client-config-note')!;
    const selectClientText=()=>{try{const selection=root.ownerDocument.defaultView?.getSelection?.(),range=root.ownerDocument.createRange?.();if(!selection||!range)return;range.selectNodeContents(clientText);selection.removeAllRanges();selection.addRange(range);}catch{}};
    const copyClientConfig=async()=>{
        const clipboard=root.ownerDocument.defaultView?.navigator?.clipboard;
        try { if(!clipboard)throw Error(t('panel.clipboardUnavailable')); await clipboard.writeText(clientText.textContent||''); if(!closed)clientNote.textContent=t('panel.preview.clientConfigCopied'); }
        catch { if(!closed){clientNote.textContent=t('panel.preview.clientConfigCopyFailed');selectClientText();} }
    };
    root.querySelector('#codex')!.addEventListener('click',()=>void feedback.run(t('panel.preview.configuringClient'),async()=>{
        const report=await request<string>('browser-debug-connect-codex');
        if(closed)return t('panel.preview.closed');
        clientText.textContent=report;clientNote.textContent='';clientConfig.hidden=false;
        return t('panel.preview.clientConfigShown');
    }));
    root.querySelector('#client-config-copy')!.addEventListener('click',()=>void copyClientConfig());
    root.querySelector('#client-config-close')!.addEventListener('click',()=>{clientConfig.hidden=true;});
    const listeners:Array<[string,EventListener]>=[];
    const listen=(name:string,fn:EventListener)=>{guest.addEventListener(name,fn);listeners.push([name,fn]);};
    let polling=false;
    const poll=setInterval(async()=>{
        if(closed||!bound||polling||!visible)return;polling=true;
        try {
            const state=await request<{floating:boolean;connected:boolean;recording:{enabled:boolean;applied:boolean;lastError?:string|null;waiting?:string|null;noBridge?:boolean;gameVersion?:string}|null}>('debug-preview-status');
            if(closed)return;
            root.querySelector('#detach-inspector')!.setAttribute('aria-pressed',String(state.floating));
            if(fit&&state.connected)void refit();
            root.querySelector('#game-version')!.textContent=state.connected ? state.recording?.gameVersion || '' : '';
            const connection=root.querySelector<HTMLElement>('#connection')!, waiting=state.connected&&!!state.recording?.waiting, noBridge=state.connected&&state.recording?.noBridge===true;
            connection.classList.toggle('waiting',waiting||noBridge);
            connection.textContent=!state.connected?t('panel.preview.disconnected'):!state.recording?'':waiting?t('panel.preview.waitingGame'):noBridge?t('panel.preview.noBridge'):state.recording.lastError || (state.recording.enabled?'':t('panel.preview.recordingOff'));
        } catch(error){if(!closed)root.querySelector('#connection')!.textContent=t('panel.preview.statusFailed',{error:String(error)});}
        finally{polling=false;}
    },2000);
    const startup=setTimeout(()=>{if(!closed&&!bound)status.textContent=t('panel.preview.notReady');},10000);
    this.dispose=()=>{closed=true;this.visibility=undefined;observer?.disconnect();messageTitles?.disconnect();void request('runtime-inspector-restore').catch(()=>{});inspector.dispose();this.dockSize?.close();this.dockSize=undefined;tooltips.close();clearInterval(poll);clearTimeout(startup);feedback.dispose();for(const [name,fn]of listeners)guest.removeEventListener(name,fn);guest.remove();if(id!==undefined)void request('debug-preview-release',id).catch(console.error);};
    try {
        const config=await request<{url:string;partition:string}>('debug-preview-config');
        if(closed)return;
        audioPreferenceKey='gitdesk-preview-muted:'+config.partition;zoomKey='gitdesk-preview-zoom:'+config.partition;
        try { muted=root.ownerDocument.defaultView?.localStorage.getItem(audioPreferenceKey)==='true'; } catch {}
        try { const saved=JSON.parse(root.ownerDocument.defaultView?.localStorage.getItem(zoomKey)||'{}'); if(Number.isFinite(saved.zoom))zoom=Math.max(zoomRange[0],Math.min(zoomRange[1],saved.zoom)); fit=saved.fit===true; } catch {}
        fitButton.setAttribute('aria-pressed',String(fit));showZoom();applyZoom(zoom,false);
        updateAudioButton();
        const url=new URL(config.url);url.searchParams.set('gitDeskEmbedded','1');
        config.url=url.toString();
        await request<string>('browser-debug-set-enabled',true);
        if(closed)return;
        guest.setAttribute('partition',config.partition);
        guest.setAttribute('webpreferences','contextIsolation=yes,nodeIntegration=no,sandbox=yes');
        listen('dom-ready',()=>{
            if(closed)return;
            try { guest.setAudioMuted(muted); } catch(error) { status.textContent=t('panel.preview.audioFailed',{error:String(error)}); }
            try { guest.setZoomFactor(zoom); } catch(error) { status.textContent=t('panel.preview.zoomFailed',{error:String(error)}); }
            if(bound)return;
            bound=true;clearTimeout(startup);id=guest.getWebContentsId();
            void feedback.run(t('panel.preview.connecting'),async()=>{
                try { await request('debug-preview-bind',id); } catch (error) { bound=false; throw error; }
                if(closed)return t('panel.preview.closed');
                await guest.loadURL(config.url);
                return '';
            });
        });
        listen('did-finish-load',()=>{if(!closed&&fit)void refit();});
        listen('did-start-loading',()=>{if(!closed)root.querySelector('#game-version')!.textContent='';});
        listen('did-fail-load',event=>{const failure=event as Event & {errorCode:number;errorDescription:string;isMainFrame:boolean};if(!closed&&failure.isMainFrame&&failure.errorCode!==-3)status.textContent=t('panel.preview.loadFailed',{error:failure.errorDescription});});
        listen('render-process-gone',()=>{if(!closed)status.textContent=t('panel.preview.processGone');});
        root.querySelector('#reload')!.addEventListener('click',()=>{status.textContent=t('panel.preview.reloading');void feedback.run(t('panel.preview.reload'),async()=>{if(!bound){id=guest.getWebContentsId();await request('debug-preview-bind',id);bound=true;}if(closed)return t('panel.preview.closed');await guest.loadURL(config.url);return '';});});
        root.querySelector('#devtools')!.addEventListener('click',()=>void feedback.run(t('panel.preview.openingDevtools'),async()=>{if(!bound)throw Error(t('panel.preview.notBound'));guest.openDevTools();return t('panel.preview.devtoolsRequested');}));
        audio.addEventListener('click',()=>void feedback.run(t('panel.preview.togglingAudio'),async()=>{
            if(closed)return '';
            if(!bound)throw Error(t('panel.preview.notBound'));
            guest.setAudioMuted(!muted);
            muted=!muted;
            updateAudioButton();
            try { root.ownerDocument.defaultView?.localStorage.setItem(audioPreferenceKey,String(muted)); } catch { return t('panel.preview.audioNotSaved'); }
            return muted?t('panel.preview.audioMuted'):t('panel.preview.audioUnmuted');
        }));
        root.querySelector('#export')!.addEventListener('click',()=>void feedback.run(t('panel.preview.exporting'),()=>request<string>('browser-debug-export-open')));
        root.querySelector('#external')!.addEventListener('click',()=>void feedback.run(t('panel.debug.openingExternal'),()=>request<string>('browser-debug-external')));
        guest.setAttribute('src','about:blank');root.querySelector('#host')!.appendChild(guest);
    } catch(error){if(!closed)status.textContent=t('panel.preview.startFailed',{error:String(error)});}
}
export function close(this:Instance):void {this.dispose?.();this.dispose=undefined;}

export const listeners = {
    show(this:Instance):void { this.dockSize?.show(); this.visibility?.(true); },
    hide(this:Instance):void { this.dockSize?.hide(); this.visibility?.(false); },
};
