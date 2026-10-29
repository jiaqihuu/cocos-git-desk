import type { HubState, HubChange, Method, Snapshot, RuntimeNode } from './runtime-inspector-hub';
import { reason, reportRequestBroadcast } from './runtime-inspector-hub';
import { PanelTooltips } from './panel-tooltips';
import { t } from './i18n';
import { attr } from './panel-i18n';
import type { Reply } from './types';
export type { HubState, HubChange, Method, Snapshot } from './runtime-inspector-hub';

export const pickTemplate=`<button id="inspector-pick" type="button" title="${attr('panel.inspector.pickTitle')}" aria-label="${attr('panel.inspector.pick')}" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/><circle cx="12" cy="12" r="1.5"/></svg></button>`;
export const linkTemplate=`<button id="inspector-link" type="button" title="${attr('panel.inspector.linkTitle')}" aria-label="${attr('panel.inspector.link')}" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5"/></svg></button>`;
const svg=(body:string)=>`<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
export const icons={
    undo:svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
    capture:svg('<path d="M4 20V10m6 10V4m6 16v-7m4 7H2"/>'),
    print:svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M13 15h4"/>'),
    destroy:svg('<path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
    prefab:svg('<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>'),
    code:svg('<path d="m8 8-4 4 4 4m8-8 4 4-4 4m-6 2 4-12"/>'),
    locate:svg('<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>'),
    open:svg('<path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7"/>'),
    asset:svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 16 5-5 4 4 3-3 6 6"/><circle cx="16" cy="9" r="1.5"/>'),
    node:svg('<path d="M5 4h6v5H5zM13 15h6v5h-6zM8 9v9h5"/>'),
    search:svg('<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>'),
};
// Hierarchy row glyphs keyed by the node kind reported by the page; drawn like Creator's own node icons.
export const nodeIcons:Record<string,string>={
    node:svg('<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>'),
    canvas:svg('<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3 9h18"/>'),
    camera:svg('<path d="M4 8h4l2-2h4l2 2h4v10H4z"/><circle cx="12" cy="13" r="3"/>'),
    sprite:svg('<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="m3 16 5-5 4 4 3-3 6 6"/><circle cx="16" cy="9" r="1.5"/>'),
    label:svg('<path d="M5 6h14M12 6v13M8 19h8"/>'),
    button:svg('<rect x="3" y="7" width="18" height="10" rx="3"/><path d="M8 12h8"/>'),
    scroll:svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M17 8v8m-9-6 4-3 4 3m-8 6 4 3 4-3"/>'),
    edit:svg('<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 11v2"/>'),
    toggle:svg('<rect x="3" y="8" width="18" height="8" rx="4"/><circle cx="16" cy="12" r="2.5"/>'),
    progress:svg('<rect x="3" y="9" width="18" height="6" rx="3"/><path d="M3 12h10"/>'),
    slider:svg('<path d="M3 12h18"/><circle cx="10" cy="12" r="3"/>'),
    layout:svg('<rect x="3" y="3" width="8" height="8"/><rect x="13" y="3" width="8" height="8"/><rect x="3" y="13" width="8" height="8"/><rect x="13" y="13" width="8" height="8"/>'),
    mask:svg('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>'),
    widget:svg('<rect x="5" y="5" width="14" height="14"/><path d="M5 12H2m20 0h-3M12 5V2m0 20v-3"/>'),
    animation:svg('<circle cx="12" cy="12" r="8"/><path d="m10 9 5 3-5 3z"/>'),
    audio:svg('<path d="M4 10v4h3l5 4V6L7 10z"/><path d="M16 9a4 4 0 0 1 0 6m2.5-9a8 8 0 0 1 0 12"/>'),
    particle:svg('<circle cx="7" cy="8" r="1.5"/><circle cx="14" cy="5" r="1.5"/><circle cx="18" cy="12" r="1.5"/><circle cx="10" cy="15" r="1.5"/><circle cx="16" cy="19" r="1.5"/><circle cx="6" cy="18" r="1.5"/>'),
    mesh:svg('<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9M4 16.5l8-4.5"/>'),
    light:svg('<circle cx="12" cy="10" r="5"/><path d="M9 17h6m-5 3h4"/>'),
};
export const inspectorActionsTemplate=`<button id="inspector-capture" type="button" title="${attr('panel.inspector.captureTitle')}" aria-label="${attr('panel.inspector.capture')}">${icons.capture}</button>`;
export const renderTemplate=`<div id="inspector-render"></div>`;
export const toolbarTemplate=`<div class="inspector-toolbar"><div class="inspector-controls">${pickTemplate}${linkTemplate}${inspectorActionsTemplate}</div>${renderTemplate}<div class="inspector-message" role="status"></div></div>`;
export const hierarchyTemplate=`<section class="inspector-hierarchy" aria-label="${attr('panel.inspector.hierarchyAria')}"><div class="inspector-message" role="status"></div><div class="inspector-search-bar"><span class="inspector-search-icon">${icons.search}</span><input id="inspector-search" type="search" placeholder="${attr('panel.inspector.searchPlaceholder')}" aria-label="${attr('panel.inspector.searchAria')}"></div><div id="inspector-candidates"></div><div id="inspector-tree" tabindex="0" role="tree" aria-label="${attr('panel.inspector.treeAria')}"></div><div class="inspector-pages"><button id="inspector-prev" type="button" title="${attr('panel.inspector.prevPage')}" aria-label="${attr('panel.inspector.prevPage')}">‹</button><span id="inspector-count"></span><button id="inspector-next" type="button" title="${attr('panel.inspector.nextPage')}" aria-label="${attr('panel.inspector.nextPage')}">›</button></div></section>`;
export const propertiesTemplate=`<section class="inspector-properties" aria-label="${attr('panel.inspector.propertiesAria')}"><div class="inspector-message" role="status"></div><div id="inspector-detail"></div></section>`;

// Chrome shared by every inspector surface: the embedded toolbar, the two docked panels and the floating window.
// Colours come from Creator's theme variables so the runtime panels sit beside the Hierarchy and
// Inspector panels without a visible seam; the fallbacks are the 3.8 dark theme values. Selection and hover
// are fixed: the editor's active/hover fill variables resolve to light tones that swallow the text.
export const inspectorTheme=`:host{--gd-bg:var(--color-default-fill,#333);--gd-bg-weak:var(--color-default-fill-weaker,#2b2b2b);--gd-bg-weaker:var(--color-default-fill-weakest,#262626);--gd-field:var(--color-default-fill-weakest,#262626);--gd-border:var(--color-default-border-weaker,#1f1f1f);--gd-line:var(--color-default-border,#444);--gd-text:var(--color-default-contrast,#ccc);--gd-text-weak:var(--color-default-contrast-weaker,#999);--gd-text-strong:var(--color-default-contrast-emphasis,#eee);--gd-hover:rgba(255,255,255,.07);--gd-active:#2d6bc4;--gd-focus:var(--color-focus-border,#5a9bef);--gd-accent:var(--color-primary-fill,#4f8ee5);--gd-warn:var(--color-warn-fill,#e8a93b);--gd-danger:var(--color-danger-fill,#d9534f);--gd-section:var(--color-default-fill-emphasis,#3b3b3b);--gd-ts:var(--color-info-fill,#3f6fb3)}`;
export const inspectorChromeStyle=inspectorTheme+`button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:24px;background:var(--gd-bg-weak);color:var(--gd-text);border:1px solid var(--gd-border);border-radius:2px;padding:3px;cursor:pointer;font:inherit}button svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.gd-tooltip{position:absolute;z-index:1000;pointer-events:none;width:max-content;max-width:calc(100% - 16px);padding:6px 9px;border:1px solid var(--gd-line);border-radius:3px;background:var(--gd-bg-weaker);color:var(--gd-text-strong);white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 sans-serif;box-shadow:0 4px 14px #0007}.gd-tooltip[hidden]{display:none}button:hover{background:var(--gd-hover);color:var(--gd-text-strong)}button:focus-visible{outline:1px solid var(--gd-focus);outline-offset:1px}button:disabled{opacity:.5;cursor:wait}button[hidden]{display:none}input,select{font:inherit}
input[type=checkbox]{appearance:none;-webkit-appearance:none;width:14px;height:14px;margin:0;flex:none;border:1px solid var(--gd-line);border-radius:2px;background:var(--gd-field);cursor:pointer;position:relative;vertical-align:middle}input[type=checkbox]:checked{background:var(--gd-accent);border-color:var(--gd-accent)}input[type=checkbox]:checked::after{content:'';position:absolute;left:4px;top:1px;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}input[type=checkbox]:focus-visible{outline:1px solid var(--gd-focus)}input[type=checkbox]:disabled{opacity:.5}`;
export const inspectorStyle=`.inspector-message{color:var(--gd-warn);white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;padding:4px 10px}.inspector-message:empty{display:none}.inspector-message.waiting{color:var(--gd-text-weak)}
.inspector-toolbar{flex:none;padding:4px 8px;border-bottom:1px solid var(--gd-border);max-height:40%;overflow:auto}.inspector-controls{display:flex;gap:6px;flex-wrap:wrap;align-items:center}button.inspector-action{width:auto;height:24px;padding:3px 8px;font-size:11px;white-space:nowrap}
#inspector-render{max-height:320px;overflow:auto;font-size:11px}#inspector-render:empty{display:none}.inspector-render-bar{display:flex;align-items:center;gap:8px;padding:4px 0}.inspector-render-bar strong{flex:1}#inspector-render p{margin:4px 0}#inspector-render details{padding:4px;border-bottom:1px solid var(--gd-border)}#inspector-render summary{cursor:pointer}
.inspector-hierarchy,.inspector-properties{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;overflow:hidden;font-size:12px;color:var(--gd-text)}
.inspector-search-bar{position:relative;flex:none;margin:6px 8px 4px}.inspector-search-icon{position:absolute;left:7px;top:50%;transform:translateY(-50%);width:14px;height:14px;color:var(--gd-text-weak);pointer-events:none}.inspector-search-icon svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
#inspector-search{box-sizing:border-box;width:100%;height:24px;padding:3px 8px 3px 26px;color:var(--gd-text-strong);background:var(--gd-field);border:1px solid var(--gd-border);border-radius:2px}#inspector-search::placeholder{color:var(--gd-text-weak);font-style:italic}#inspector-search:focus{outline:none;border-color:var(--gd-focus)}#inspector-search::-webkit-search-cancel-button{filter:invert(.7)}
#inspector-candidates{padding:0 8px 6px;font-size:10px;color:var(--gd-text-weak)}#inspector-candidates:empty{display:none}#inspector-candidates select{width:100%;height:22px;background:var(--gd-field);color:var(--gd-text);border:1px solid var(--gd-border);padding:2px 4px;border-radius:2px;margin-bottom:3px}
#inspector-tree{flex:1;min-height:0;overflow:auto;padding:0 0 8px;scrollbar-gutter:stable;background:var(--gd-bg-weak)}#inspector-tree:focus{outline:none}
button.inspector-node{display:flex;align-items:center;gap:4px;width:100%;height:22px;text-align:left;border:0;border-radius:0;background:transparent;white-space:nowrap;font-size:12px;padding:0 6px 0 0;color:var(--gd-text)}
button.inspector-node .inspector-arrow{flex:none;width:16px;text-align:center;color:var(--gd-text-weak);font-size:9px;line-height:22px}button.inspector-node .inspector-arrow:empty{pointer-events:none}button.inspector-node .inspector-arrow:hover{color:var(--gd-text-strong)}
button.inspector-node .inspector-glyph{flex:none;width:14px;height:14px;color:var(--gd-text-weak)}button.inspector-node .inspector-glyph svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}button.inspector-node[data-prefab="true"] .inspector-glyph{color:var(--gd-accent)}
button.inspector-node .inspector-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}button.inspector-node[data-prefab="true"] .inspector-name{color:var(--gd-accent)}
button.inspector-node .inspector-ts{flex:none;font-size:10px;font-weight:600;letter-spacing:.3px;color:var(--gd-accent);padding:0 2px}
button.inspector-node:hover{background:var(--gd-hover);color:var(--gd-text-strong)}button.inspector-node[aria-selected="true"]{background:var(--gd-active);color:#fff}button.inspector-node[aria-selected="true"] .inspector-name,button.inspector-node[aria-selected="true"] .inspector-glyph,button.inspector-node[aria-selected="true"] .inspector-arrow,button.inspector-node[aria-selected="true"] .inspector-ts{color:#fff}button.inspector-node[data-inactive="true"] .inspector-name,button.inspector-node[data-inactive="true"] .inspector-glyph{opacity:.45}button.inspector-node[data-hovered="true"]{box-shadow:inset 0 0 0 1px var(--gd-warn)}
.inspector-pages{display:flex;align-items:center;gap:6px;padding:3px 8px;border-top:1px solid var(--gd-border);font-size:11px;color:var(--gd-text-weak);flex:none;background:var(--gd-bg)}.inspector-pages button{height:20px;width:22px}#inspector-count{flex:1;text-align:center}
#inspector-detail{flex:1;min-height:0;overflow:auto;padding:0 0 12px;overflow-wrap:anywhere;scrollbar-gutter:stable}
.inspector-selection{position:sticky;top:0;z-index:1;background:var(--gd-bg);padding:6px 10px 6px;border-bottom:1px solid var(--gd-border)}
#inspector-detail h4{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:400;margin:0;height:24px;padding:0 6px;border:1px solid var(--gd-border);border-radius:2px;background:var(--gd-field);color:var(--gd-text-strong);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#inspector-detail h4 .inspector-active{margin:0}#inspector-detail h4 #inspector-undo[hidden]{display:none}
#inspector-detail .inspector-path{font-size:11px;color:var(--gd-text-weak);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:4px 0 0}#inspector-detail p{margin:4px 10px;font-size:11px;color:var(--gd-text-weak)}
.inspector-link{width:auto;height:auto;min-height:22px;padding:2px 8px;max-width:100%;overflow-wrap:anywhere;font-size:11px}
.inspector-group{margin-top:2px}.inspector-resources>:not(.inspector-group-head){margin-left:10px;margin-right:10px}.inspector-resources>small{display:block;color:var(--gd-text-weak);font-size:11px;margin-top:4px}.inspector-group-head{display:flex;align-items:center;gap:6px;height:24px;padding:0 10px 0 8px;background:var(--gd-section);color:var(--gd-text-strong);font-size:12px;font-weight:600;border-top:1px solid var(--gd-border);border-bottom:1px solid var(--gd-border)}.inspector-group-head::before{content:'▾';font-size:9px;color:var(--gd-text-weak)}.inspector-group-body{padding:4px 10px 6px}
.inspector-edit{display:grid;grid-template-columns:minmax(80px,36%) minmax(0,1fr);gap:4px 8px;font-size:12px;align-items:center;min-height:24px;margin:2px 0;color:var(--gd-text)}.inspector-edit>input,.inspector-edit>select,.inspector-edit>.inspector-vector{grid-column:2}
.inspector-edit input:not([type=checkbox]){box-sizing:border-box;width:100%;min-width:0;height:22px;padding:2px 6px;border-radius:2px;background:var(--gd-field);color:var(--gd-text-strong);border:1px solid var(--gd-border);font:inherit}.inspector-edit input[type=number]{appearance:textfield;-moz-appearance:textfield}.inspector-edit input::-webkit-outer-spin-button,.inspector-edit input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}.inspector-edit input:not([type=checkbox]):hover{border-color:var(--gd-line)}.inspector-edit input:focus{outline:none;border-color:var(--gd-focus)}.inspector-edit select{min-width:0;height:22px;background:var(--gd-field);color:var(--gd-text-strong);border:1px solid var(--gd-border);border-radius:2px;padding:1px 4px}
.inspector-edit input[type=checkbox]{justify-self:start}.inspector-edit input[type=color]{grid-column:auto;width:28px;height:22px;padding:1px;border:1px solid var(--gd-border);background:var(--gd-field);cursor:pointer}
.inspector-vector{display:flex;gap:4px;min-width:0}.inspector-axis{position:relative;flex:1;min-width:0}.inspector-axis input{padding-right:18px!important}.inspector-axis::after{content:attr(data-axis);position:absolute;right:6px;top:50%;transform:translateY(-50%);font-size:10px;color:var(--gd-text-weak);pointer-events:none;text-transform:uppercase}
.inspector-field{display:grid;grid-template-columns:minmax(80px,36%) minmax(0,1fr);gap:4px 8px;align-items:center;min-height:24px;margin:2px 0;color:var(--gd-text)}.inspector-field>.inspector-edit{grid-column:1 / -1}.inspector-field>pre{grid-column:2;margin:0;box-sizing:border-box;min-height:22px;padding:2px 6px;border-radius:2px;background:var(--gd-field);border:1px solid var(--gd-border);color:var(--gd-text);white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}.inspector-field>button,.inspector-field>div{grid-column:2}
.inspector-danger{color:var(--gd-danger)}.inspector-title-actions{margin-left:auto;display:flex;gap:2px;flex:none}.inspector-title-actions button{border:0;background:transparent;width:22px;height:20px;padding:2px}.inspector-title-actions button:hover{background:var(--gd-hover)}
.inspector-origin{display:flex;align-items:center;gap:6px;margin:6px 0 2px;font-size:12px;color:var(--gd-text)}.inspector-origin>svg{width:14px;height:14px;flex:none;color:var(--gd-accent)}.inspector-muted{color:var(--gd-text-weak)}
.inspector-subtitle{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--gd-text-weak);margin:6px 0 2px;min-height:22px}.inspector-subtitle .inspector-subtitle-action{margin-left:auto;width:22px;height:20px;padding:2px}.inspector-subtitle .inspector-subtitle-action svg{width:14px;height:14px}
.inspector-resource{display:flex;align-items:center;gap:6px;padding:1px 0;font-size:12px;min-height:22px}.inspector-resource>svg{width:14px;height:14px;flex:none;color:var(--gd-text-weak)}.inspector-resource-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.inspector-resource-type{font-size:10px;color:var(--gd-text-weak);flex:none}
button.inspector-icon{width:22px;height:20px;padding:2px;border:0;background:transparent}button.inspector-icon svg{width:14px;height:14px}button.inspector-icon:hover{background:var(--gd-hover)}button.inspector-prefab{width:auto;height:auto;min-height:22px;padding:2px 8px;gap:6px;max-width:100%;font-size:11px;text-align:left}button.inspector-prefab svg{flex:none;width:14px;height:14px}
#inspector-detail details{border:0;border-top:1px solid var(--gd-border);border-bottom:1px solid var(--gd-border);border-radius:0;padding:0;margin-top:2px;overflow:hidden;background:transparent}#inspector-detail summary{height:24px;box-sizing:border-box;padding:0 8px;background:var(--gd-section);font-weight:600;font-size:12px;color:var(--gd-text-strong);cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px;white-space:nowrap}#inspector-detail summary::-webkit-details-marker{display:none}#inspector-detail summary::before{content:'▸';color:var(--gd-text-weak);font-size:9px;flex:none}#inspector-detail details[open]>summary::before{content:'▾'}#inspector-detail summary .inspector-component-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}#inspector-detail summary .inspector-component-state{font-size:10px;font-weight:400;color:var(--gd-text-weak)}#inspector-detail summary .inspector-title-actions{margin-left:auto}
#inspector-detail details> :not(summary){margin:2px 10px}#inspector-detail details>.inspector-field:first-of-type{margin-top:4px}#inspector-detail details>p{margin:4px 10px}#inspector-detail>small{display:block;color:var(--gd-text-weak);font-size:10px;line-height:1.6;margin:12px 10px 0}#inspector-detail pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;margin:0}
#inspector-pick[aria-pressed="true"],#inspector-link[aria-pressed="true"],#detach-inspector[aria-pressed="true"]{background:var(--gd-active);border-color:var(--gd-focus);color:#fff}`;

export interface InspectorClient {
    view(visible:boolean):Promise<unknown>;
    state():Promise<HubState>;
    update(change:HubChange):Promise<unknown>;
    action(method:Method,args:unknown[]):Promise<boolean>;
    hover(frame:string,uuid:string,session:string):Promise<unknown>;
    read(uuid:string,id:string,key:string):Promise<unknown>;
    navigate(uuid:string,action:'reveal'|'open'|'prefab',fileId?:string):Promise<string>;
}
type NavigateAction='reveal'|'open'|'prefab';
const scriptPattern=/^(?:[0-9a-f]{8}-[0-9a-f-]{27}|[0-9a-f]{2}[A-Za-z0-9+/]{20})$/i;
// Renders whichever inspector sections exist under root; a passive view (the
// preview toolbar) follows published states without keeping the page polled.
export class RuntimeInspectorView {
    private latest?:HubState;
    private visible=true;
    private closed=false;
    private registered=false;
    private dirty=false;
    private hoverTimer?:ReturnType<typeof setTimeout>;
    private hoverSent='';
    private dragCleanup?:()=>void;
    private searchTimer?:ReturnType<typeof setTimeout>;
    private treeKey='';
    private detailKey='';
    private candidatesKey='';
    private readonly shortcuts={pick:'p',print:'c',active:' ',destroy:'Delete'};
    private listeners:Array<()=>void>=[];
    constructor(private root:HTMLElement, private client:InspectorClient, private passive=false) {
        const search=this.optional('inspector-search') as HTMLInputElement|null;
        if(search)this.on(search,'input',()=>{clearTimeout(this.searchTimer);this.searchTimer=setTimeout(()=>void this.send({contains:search.value}),200);});
        const tree=this.optional('inspector-tree');
        if(tree){const keyboard=(event:Event)=>this.keyboard(event as KeyboardEvent);tree.addEventListener('keydown',keyboard);this.listeners.push(()=>tree.removeEventListener('keydown',keyboard));}
        this.bind('inspector-prev',()=>{const offset=this.latest?.options.offset||0;void this.send({offset:Math.max(0,offset-200)});});
        this.bind('inspector-next',()=>{const offset=this.latest?.options.offset||0;void this.send({offset:offset+200});});
        this.bind('inspector-link',()=>void this.send({link:!this.latest?.options.link}));
        this.bind('inspector-capture',()=>void this.act('capture',[]));
        this.bind('inspector-pick',()=>{const state=this.latest?.snapshot;if(state)void this.act('pick',[!state.picking,state.sessionId]);});
        const focusout=()=>{if(this.dirty&&!this.editing()){this.dirty=false;this.render();}};
        root.addEventListener('focusout',focusout);this.listeners.push(()=>root.removeEventListener('focusout',focusout));
    }
    private optional(id:string):HTMLElement|null {return this.root.querySelector<HTMLElement>('#'+id);}
    private element(id:string):HTMLElement {const element=this.optional(id);if(!element)throw Error(t('panel.inspector.missingElement',{id}));return element;}
    private bind(id:string,handler:()=>void):void {const element=this.optional(id);if(element)this.on(element,'click',handler);}
    private on(target:EventTarget,event:string,handler:()=>void):void {target.addEventListener(event,handler);this.listeners.push(()=>target.removeEventListener(event,handler));}
    // Waiting messages (the page or engine still loading) are shown quietly, not in the warning color.
    message(text:string,waiting=false):void {if(this.closed)return;const element=this.root.querySelector<HTMLElement>('.inspector-message');if(element){element.textContent=text;element.classList?.toggle?.('waiting',waiting);}}
    private notice='';
    // Operation results stay visible until the next operation instead of being overwritten by the next state broadcast.
    private status(text:string):void {const element=this.optional('status');if(element)element.textContent=text;else{this.notice=text;this.message(text);}}
    private async send(change:HubChange):Promise<void> {
        if(this.closed)return;
        this.notice='';
        try { await this.client.update(change); } catch(error){ this.message(reason(error)); }
    }
    private async act(method:Method,args:unknown[]):Promise<boolean> {
        if(this.closed)return false;
        this.notice='';
        try { return await this.client.action(method,args); } catch(error){ this.status(reason(error)); return false; }
    }
    private retryTimer?:ReturnType<typeof setTimeout>;
    private async register():Promise<void> {
        if(this.passive||this.closed)return;
        clearTimeout(this.retryTimer);this.retryTimer=undefined;
        this.registered=true;
        try { await this.client.view(this.visible); }
        catch(error){
            this.registered=false; if(this.closed)return; this.message(reason(error));
            // The preview may still be binding; keep trying instead of waiting for a broadcast that can be missed.
            if(this.visible)this.retryTimer=setTimeout(()=>{this.retryTimer=undefined;if(!this.closed&&this.visible&&!this.registered)void this.register().then(()=>this.fetch());},2000);
        }
    }
    private async fetch():Promise<void> {
        try { const state=await this.client.state(); if(!this.closed&&this.visible)this.update(state); }
        catch(error){ if(!this.closed&&!this.passive)this.message(reason(error)); }
    }
    setVisible(value:boolean):void {
        if(this.closed||this.visible===value)return;
        this.visible=value;
        if(value){ void this.register().then(()=>this.fetch()); }
        else { this.reset(); clearTimeout(this.retryTimer); this.retryTimer=undefined; if(this.registered)void this.client.view(false).catch(()=>{}); }
    }
    start():void { void this.register().then(()=>this.fetch()); }
    private reset():void {
        this.dragCleanup?.();clearTimeout(this.hoverTimer);this.hoverSent='';this.dirty=false;this.treeKey='';this.detailKey='';this.candidatesKey='';
        for(const id of ['inspector-tree','inspector-detail','inspector-candidates','inspector-count','inspector-render'])this.optional(id)?.replaceChildren();
        const render=this.optional('inspector-render');if(render)render.dataset.result='';
    }
    update(state:HubState):void {
        if(this.closed)return;
        if(state.closed)this.registered=false;
        else if(!this.registered&&this.visible&&!this.passive)void this.register();
        if(this.latest&&(this.latest.snapshot?.sessionId!==state.snapshot?.sessionId||this.latest.frame!==state.frame))this.reset();
        this.latest=state;
        if(this.visible)this.render();
    }
    private render():void {
        const state=this.latest;if(!state||this.closed)return;
        this.message(state.message||this.notice,!!state.message&&state.waiting===true);
        this.renderToolbar(state);
        this.renderHierarchy(state);
        this.renderDetail(state);
    }
    private renderToolbar(state:HubState):void {
        // Controls that cannot act right now disappear instead of sitting disabled.
        const capture=this.optional('inspector-capture');if(capture)capture.hidden=!state.frame||state.closed;
        const pick=this.optional('inspector-pick');if(pick)pick.setAttribute('aria-pressed',String(!!state.snapshot?.picking));
        const link=this.optional('inspector-link');if(link)link.setAttribute('aria-pressed',String(!!state.options.link));
        if(this.optional('inspector-render'))this.renderAnalysis(state.capture);
    }
    private text(tag:string,text:string,parent:HTMLElement):HTMLElement {const el=this.root.ownerDocument.createElement(tag);el.textContent=text;parent.append(el);return el;}
    private scheduleHover(uuid:string):void {
        clearTimeout(this.hoverTimer);
        this.hoverTimer=setTimeout(()=>{const state=this.latest;if(this.closed||!state?.snapshot||uuid===this.hoverSent)return;this.hoverSent=uuid;void this.client.hover(state.frame,uuid,state.snapshot.sessionId).catch(e=>{if(uuid)this.message(reason(e));});},80);
    }
    private nodeButton(node:RuntimeNode,parent:HTMLElement,state:Snapshot,collapsed:Set<string>):void {
        const button=this.text('button','',parent) as HTMLButtonElement;button.type='button';button.className='inspector-node';
        const arrow=this.text('span',node.childCount?(collapsed.has(node.uuid)?'▸':'▾'):'',button);arrow.className='inspector-arrow';
        if(node.childCount)arrow.addEventListener('click',event=>{event.stopPropagation();this.fold(node.uuid);});
        const glyph=this.text('span','',button);glyph.className='inspector-glyph';glyph.innerHTML=nodeIcons[node.kind||'node']||nodeIcons.node!;
        const label=this.text('span',node.name||t('panel.inspector.unnamed'),button);label.className='inspector-name';
        if(node.scripts)this.text('span','TS',button).className='inspector-ts';
        button.title=node.path+(node.isPrefab?' · Prefab':'')+(node.scripts?t('panel.inspector.hasScripts'):'');button.dataset.prefab=String(!!node.isPrefab);button.dataset.uuid=node.uuid;button.dataset.hovered=String(node.uuid===state.hovered);if(node.uuid===state.hovered)button.title=t('panel.inspector.hovered',{title:button.title});button.setAttribute('aria-selected',String(node.uuid===state.selected));button.setAttribute('data-inactive',String(!node.activeInHierarchy));
        button.style.paddingLeft=`${6+Math.min(node.depth,16)*12}px`;button.setAttribute('role','treeitem');button.setAttribute('aria-level',String(node.depth+1));
        button.addEventListener('click',event=>{parent.focus();if(event.altKey&&node.childCount){this.fold(node.uuid);return;}void this.act('select',[node.uuid,state.sessionId]);});
        button.addEventListener('dblclick',()=>{if(node.childCount)this.fold(node.uuid);});
        button.addEventListener('mouseenter',()=>this.scheduleHover(node.uuid));
        button.addEventListener('mouseleave',()=>this.scheduleHover(''));
    }
    private renderHierarchy(hub:HubState):void {
        const tree=this.optional('inspector-tree');if(!tree)return;
        const state=hub.snapshot,candidates=this.element('inspector-candidates'),search=this.optional('inspector-search') as HTMLInputElement|null;
        if(search&&search!==this.activeElement()&&search.value!==hub.options.contains)search.value=hub.options.contains;
        if(!state){tree.replaceChildren();candidates.replaceChildren();this.element('inspector-count').textContent='';this.treeKey='';this.candidatesKey='';return;}
        const collapsed=new Set(hub.options.collapsed);
        const hoverChanged=!!state.hovered&&tree.dataset.hovered!==state.hovered;tree.dataset.hovered=state.hovered||'';
        const selectionChanged=tree.dataset.selected!==state.selected;tree.dataset.selected=state.selected;
        const scroll=tree.scrollTop;
        const treeKey=JSON.stringify([state.sessionId,state.nodes,[...collapsed]]);
        if(treeKey!==this.treeKey){tree.replaceChildren();for(const node of state.nodes)this.nodeButton(node,tree,state,collapsed);tree.scrollTop=scroll;this.treeKey=treeKey;}
        for(const row of Array.from(tree.children) as HTMLElement[]){row.setAttribute('aria-selected',String(row.dataset.uuid===state.selected));row.dataset.hovered=String(row.dataset.uuid===state.hovered);}
        if(selectionChanged||hoverChanged){const target=hoverChanged?state.hovered:state.selected;const selected=Array.from(tree.children).find(el=>(el as HTMLElement).dataset.uuid===target) as HTMLElement|undefined;if(selected)tree.scrollTop=Math.max(0,tree.scrollTop+selected.getBoundingClientRect().top-tree.getBoundingClientRect().top-tree.clientHeight/2);}
        this.element('inspector-count').textContent=`${state.total?state.offset+1:0}–${state.offset+state.nodes.length} / ${state.total}`;
        (this.element('inspector-prev') as HTMLButtonElement).disabled=!state.offset;
        (this.element('inspector-next') as HTMLButtonElement).disabled=state.offset+state.nodes.length>=state.total;
        const candidatesKey=JSON.stringify([state.sessionId,state.candidates,state.candidateCount,state.selected]);
        if(candidatesKey!==this.candidatesKey){candidates.replaceChildren();this.candidatesKey=candidatesKey;
            if(state.candidates.length){const select=this.root.ownerDocument.createElement('select');select.setAttribute('aria-label',t('panel.inspector.candidatesAria'));for(const node of state.candidates){const option=this.root.ownerDocument.createElement('option');option.value=node.uuid;option.textContent=node.path;option.selected=node.uuid===state.selected;select.append(option);}select.addEventListener('change',()=>void this.act('select',[select.value,state.sessionId]));candidates.append(select);this.text('small',t('panel.inspector.candidates',{count:state.candidateCount}),candidates);}
        }
    }
    // The active flag sits before the node name, as in Creator's inspector, instead of taking a property row.
    private activeToggle(uuid:string,active:boolean,session:string):HTMLInputElement {
        const input=this.toggle(uuid,'','active',active,session,t('panel.inspector.activeToggle'));input.className='inspector-active';return input;
    }
    private toggle(uuid:string,id:string,field:string,current:boolean,session:string,title:string):HTMLInputElement {
        const input=this.root.ownerDocument.createElement('input');input.type='checkbox';input.checked=current;input.title=title;input.setAttribute('aria-label',title.split(/[：:]/)[0]!);
        let pending=false;
        input.addEventListener('change',async()=>{if(pending)return;pending=true;input.disabled=true;try{if(await this.act('edit',[{...(id?{uuid,id}:{uuid}),field,value:input.checked,expected:current},session]))current=input.checked;else input.checked=current;}finally{pending=false;if(!this.closed)input.disabled=false;}});
        return input;
    }
    private async navigateTo(uuid:string,action:NavigateAction,fileId?:string,button?:HTMLButtonElement):Promise<void> {
        if(button)button.disabled=true;
        this.status(action==='prefab'?t('panel.inspector.openingPrefab'):action==='open'?t('panel.inspector.openingScript'):t('panel.inspector.revealing'));
        try{const message=await this.client.navigate(uuid,action,fileId);if(!this.closed)this.status(message);}catch(error){if(!this.closed)this.status(reason(error));}finally{if(button&&!this.closed)button.disabled=false;}
    }
    private iconButton(parent:HTMLElement,icon:string,title:string,action:(button:HTMLButtonElement)=>void):HTMLButtonElement {
        const button=this.text('button','',parent) as HTMLButtonElement;button.type='button';button.className='inspector-icon';button.title=title;button.setAttribute('aria-label',title);button.innerHTML=icon;
        button.addEventListener('click',()=>action(button));return button;
    }
    private assetButton(uuid:string,label:string,parent:HTMLElement,action:NavigateAction='reveal',fileId?:string):void {
        if(!uuid){this.text('span',t('panel.inspector.noSource',{label}),parent);return;}
        const button=this.text('button',label,parent) as HTMLButtonElement;button.type='button';button.className='inspector-link';button.title=action==='prefab'?t('panel.inspector.prefabLinkTitle'):action==='open'?t('panel.inspector.scriptLinkTitle'):t('panel.inspector.revealLinkTitle');
        button.addEventListener('click',()=>void this.navigateTo(uuid,action,fileId,button));
    }
    private value(value:unknown,parent:HTMLElement,session:string):void {
        if(value&&typeof value==='object'){
            const item=value as Record<string,unknown>;
            if(item.kind==='asset'){this.assetButton(String(item.uuid||''),String(item.name||item.type||t('panel.inspector.asset')),parent);return;}
            if((item.kind==='node'||item.kind==='component')&&typeof item.uuid==='string'&&item.uuid){
                const button=this.text('button',String(item.name||t('panel.inspector.nodeRef')),parent) as HTMLButtonElement;button.type='button';button.className='inspector-link';button.addEventListener('click',()=>void this.act('select',[item.uuid,session]));return;
            }
            if(item.kind==='array'&&Array.isArray(item.items)){for(const [index,child]of item.items.entries()){const row=this.text('div',`[${index}] `,parent);this.value(child,row,session);}if(Number(item.count)>item.items.length)this.text('p',t('panel.inspector.arrayLimited',{count:String(item.count),shown:item.items.length}),parent);return;}
        }
        this.text('pre',JSON.stringify(value)??'null',parent);
    }
    private undoButton?:HTMLButtonElement;
    private renderDetail(hub:HubState):void {
        const detail=this.optional('inspector-detail');if(!detail)return;
        const state=hub.snapshot;
        if(this.undoButton)this.undoButton.hidden=!state?.undoCount;
        if(!state){detail.replaceChildren();detail.dataset.node='';this.detailKey='';this.undoButton=undefined;return;}
        if(this.editing()){this.dirty=true;return;}
        const selectionChanged=detail.dataset.node!==state.selected;
        const expanded=detail.dataset.node===state.selected?Array.from(detail.querySelectorAll('details')).map(el=>el.open):[];
        detail.dataset.node=state.selected;
        const detailScroll=selectionChanged?0:detail.scrollTop;
        const detailKey=JSON.stringify([state.sessionId,state.detail,state.highlightMessage]);
        if(detailKey===this.detailKey)return;this.detailKey=detailKey;detail.replaceChildren();
        const item=state.detail;if(!item){this.text('p',t('panel.inspector.selectNode'),detail);return;}
        const heading=this.text('div','',detail);heading.className='inspector-selection';
        const title=this.text('h4',item.name,heading);title.prepend(this.activeToggle(item.uuid,item.active,state.sessionId));
        const tools=this.text('span','',title);tools.className='inspector-title-actions';
        this.iconButton(tools,icons.print,t('panel.inspector.printNode'),()=>void this.act('print',[item.uuid,'',state.sessionId]));
        this.undoButton=this.iconButton(tools,icons.undo,t('panel.inspector.undo'),()=>{const session=this.latest?.snapshot?.sessionId;if(session)void this.act('undo',[session]);});this.undoButton.id='inspector-undo';this.undoButton.hidden=!state.undoCount;
        if(item.parent)this.iconButton(tools,icons.destroy,t('panel.inspector.destroy'),()=>this.destroySelected()).classList.add('inspector-danger');
        const breadcrumb=this.text('p',item.path,heading);breadcrumb.className='inspector-path';breadcrumb.title=item.path;
        const origin=this.text('div','',heading);origin.className='inspector-origin';origin.insertAdjacentHTML('afterbegin',icons.prefab);
        if(item.prefab){
            const name=item.prefab.name||item.prefab.uuid;this.text('span','Prefab · '+name,origin).className='inspector-resource-name';
            const prefabUuid=item.prefab.uuid,fileId=item.prefabFileId;
            this.iconButton(origin,icons.open,t('panel.inspector.openPrefabNamed',{name}),button=>void this.navigateTo(prefabUuid,'prefab',fileId,button)).classList.add('inspector-prefab');
        } else this.text('span',t('panel.inspector.noPrefabSource'),origin).className='inspector-resource-name inspector-muted';
        if(state.highlightMessage)this.text('p',state.highlightMessage,detail);
        // Node transform group first, like Creator's inspector; components follow, project references close the panel.
        const group=this.text('div','',detail);group.className='inspector-group';this.text('div','Node',group).className='inspector-group-head';const body=this.text('div','',group);body.className='inspector-group-body';
        this.editor('Name',item.name,body,item.uuid,'',state.sessionId,undefined,'name');
        for(const [label,field,value]of [['Position','position',item.position],['Rotation','rotation',item.rotation],['Scale','scale',item.scale]] as const)this.editor(label,value,body,item.uuid,'',state.sessionId,undefined,field);
        const components=new Set(hub.options.components);
        for(const [index,component] of item.components.entries()){const section=this.root.ownerDocument.createElement('details');section.open=expanded[index]??components.has(component.id);section.dataset.component=component.id;section.addEventListener('toggle',()=>{if(!section.isConnected||this.closed)return;const open=!!section.open;if(open!==(this.latest?.options.components.includes(component.id)??false))void this.send({component:{id:component.id,open}});});detail.append(section);
            const summary=this.text('summary','',section);summary.append(this.toggle(item.uuid,component.id,'enabled',component.enabled,state.sessionId,t('panel.inspector.enabledToggle')));
            const name=this.text('span',component.type,summary);name.className='inspector-component-name';name.title=component.type;if(!component.enabledInHierarchy)this.text('span',t('panel.inspector.inactive'),summary).className='inspector-component-state';
            const tools=this.text('span','',summary);tools.className='inspector-title-actions';
            const script=scriptPattern.test(component.script)?component.script:component.type.startsWith('cc.')?'':component.type;
            if(script)this.iconButton(tools,icons.code,t('panel.inspector.openScript',{type:component.type}),button=>void this.navigateTo(script,'open',undefined,button));
            this.iconButton(tools,icons.print,t('panel.inspector.printComponent'),()=>void this.act('print',[item.uuid,component.id,state.sessionId]));
            this.populateOnExpand(section,()=>{
            for(const field of component.fields){const row=this.text('div',field.editable?'':field.name,section);row.className='inspector-field';const read=async()=>{try{await this.client.read(item.uuid,component.id,field.name);}catch(e){this.message(reason(e));}};if(field.getter)this.control(t('panel.inspector.readAccessor'),row,()=>void read());else if(field.editable)this.editor(field.name,field.value,row,item.uuid,component.id,state.sessionId,field.enumList);else this.value(field.value,row,state.sessionId);if(field.accessor)this.control(t('panel.inspector.reread'),row,()=>void read());}if(component.fieldsLimited)this.text('p',t('panel.inspector.fieldsLimited'),section);
            });
        }
        if(item.componentsLimited)this.text('p',t('panel.inspector.componentsLimited'),detail);
        const resources=this.text('div','',detail);resources.className='inspector-resources';this.text('div',t('panel.inspector.resources'),resources).className='inspector-group-head';
        // Project components without a usable class id are still listed; the editor resolves them by file name.
        const scriptOf=(component:{type:string;script:string})=>scriptPattern.test(component.script)?component.script:component.type.startsWith('cc.')?'':component.type;
        const scriptRow=(component:{type:string;script:string})=>{const script=scriptOf(component);if(!script)return;const row=this.text('div','',resources);row.className='inspector-resource';row.insertAdjacentHTML('afterbegin',icons.code);this.text('span',component.type,row).className='inspector-resource-name';this.iconButton(row,icons.open,t('panel.inspector.openScriptExternal',{type:component.type}),button=>void this.navigateTo(script,'open',undefined,button));this.iconButton(row,icons.locate,t('panel.inspector.revealScript',{type:component.type}),button=>void this.navigateTo(script,'reveal',undefined,button));};
        const subtitle=(text:string)=>{const el=this.text('div',text,resources);el.className='inspector-subtitle';return el;};
        const scripts=item.components.filter(component=>scriptOf(component)),assets=(item.assets||[]).filter(asset=>asset.uuid);
        if(scripts.length){subtitle(t('panel.inspector.scripts'));for(const component of scripts)scriptRow(component);}
        if(assets.length){subtitle(t('panel.inspector.assets'));for(const asset of assets){const row=this.text('div','',resources);row.className='inspector-resource';row.insertAdjacentHTML('afterbegin',icons.asset);const name=asset.name||asset.uuid;this.text('span',name,row).className='inspector-resource-name';this.text('span',asset.type.replace(/^cc\./,''),row).className='inspector-resource-type';this.iconButton(row,icons.locate,t('panel.inspector.revealNamed',{name}),button=>void this.navigateTo(asset.uuid,'reveal',undefined,button));}}
        if(item.owner){
            const owner=item.owner;const head=subtitle(t('panel.inspector.ownerView',{name:owner.name}));head.title=owner.path;
            this.iconButton(head,icons.node,t('panel.inspector.selectOwner',{path:owner.path}),()=>void this.act('select',[owner.uuid,state.sessionId])).classList.add('inspector-subtitle-action');
            for(const component of owner.components)scriptRow(component);
        }
        if(!scripts.length&&!assets.length&&!item.owner)this.text('small',t('panel.inspector.noResources'),resources);
        this.text('small',t('panel.inspector.detailNote'),detail);
        detail.scrollTop=detailScroll;
    }
    private activeElement():Element|null {const focused=this.root.getRootNode?.() as ShadowRoot|undefined;return focused?.activeElement||this.root.ownerDocument.activeElement;}
    private editing():boolean {const el=this.activeElement();const detail=this.optional('inspector-detail');return !!el&&!!detail&&detail.contains(el)&&['INPUT','SELECT','TEXTAREA'].includes(el.tagName);}
    private control(label:string,parent:HTMLElement,action:()=>void):HTMLButtonElement {const button=this.text('button',label,parent) as HTMLButtonElement;button.type='button';button.className='inspector-link';button.title=label;button.addEventListener('click',action);return button;}
    private editor(label:string,value:unknown,parent:HTMLElement,uuid:string,id:string,session:string,enums?:Array<{name:string;value:number}>,field=label):void {
        const row=this.text('label',label+' ',parent);row.className='inspector-edit';row.title=field;
        let pending=false;
        const apply=async(next:unknown)=>{
            if(pending)return;pending=true;
            const controls=Array.from(row.querySelectorAll<HTMLInputElement|HTMLSelectElement>('input,select'));for(const control of controls)control.disabled=true;
            try {
                if(await this.act('edit',[{uuid,id,field,value:next,expected:value},session]))value=next;
                else for(const control of controls)if(control.tagName==='INPUT' && control.type==='checkbox')(control as HTMLInputElement).checked=Boolean(value);
            } finally {pending=false;for(const control of controls)control.disabled=false;}
        };
        if(enums?.length){const select=this.root.ownerDocument.createElement('select');for(const item of enums){const option=this.root.ownerDocument.createElement('option');option.value=String(item.value);option.textContent=item.name;option.selected=item.value===value;select.append(option);}select.addEventListener('change',()=>apply(Number(select.value)));row.append(select);return;}
        if(value&&typeof value==='object'){
            const vector=value as Record<string,unknown>;
            if(['r','g','b','a'].every(key=>typeof vector[key]==='number')){const color=this.root.ownerDocument.createElement('input');color.type='color';color.value='#'+['r','g','b'].map(key=>Math.round(Number(vector[key])).toString(16).padStart(2,'0')).join('');color.title=t('panel.inspector.pickColor');color.addEventListener('change',()=>apply({r:parseInt(color.value.slice(1,3),16),g:parseInt(color.value.slice(3,5),16),b:parseInt(color.value.slice(5,7),16),a:vector.a}));row.append(color);}
            const axes=this.root.ownerDocument.createElement('div');axes.className='inspector-vector';
            for(const key of Object.keys(vector)){if(typeof vector[key]!=='number')continue;const axis=this.root.ownerDocument.createElement('span');axis.className='inspector-axis';axis.dataset.axis=key;const input=this.root.ownerDocument.createElement('input');input.type='number';input.step='any';input.value=String(vector[key]);input.title=field+'.'+key;input.setAttribute('aria-label',field+'.'+key);input.addEventListener('keydown',event=>{if(event.key==='Enter')input.blur();});input.addEventListener('change',()=>{if(input.value.trim()&&Number.isFinite(Number(input.value)))apply({...value as Record<string,unknown>,[key]:Number(input.value)});});this.draggable(input,Number(vector[key]),number=>apply({...value as Record<string,unknown>,[key]:number}));axis.append(input);axes.append(axis);}
            row.append(axes);return;
        }
        const input=this.root.ownerDocument.createElement('input');input.title=field;input.setAttribute('aria-label',field);
        if(typeof value==='boolean'){input.type='checkbox';input.checked=value;}else{input.type=typeof value==='number'?'number':'text';input.step='any';input.value=String(value??'');}
        input.addEventListener('keydown',event=>{if(event.key==='Enter')input.blur();});
        input.addEventListener('change',()=>{if(typeof value==='number'&&(!input.value.trim()||!Number.isFinite(Number(input.value)))){this.message(t('panel.inspector.invalidNumber'));return;}apply(typeof value==='boolean'?input.checked:typeof value==='number'?Number(input.value):input.value);});if(typeof value==='number')this.draggable(input,value,apply);row.append(input);
    }
    private draggable(input:HTMLInputElement,initial:number,apply:(value:number)=>void):void {
        input.title+=t('panel.inspector.dragHint');
        input.addEventListener('pointerdown',event=>{
            if(!event.altKey || event.button!==0)return;event.preventDefault();this.dragCleanup?.();
            const win=this.root.ownerDocument.defaultView!;const start=event.clientX;let value=initial;
            input.focus();
            const move=(e:PointerEvent)=>{value=Number((initial+(e.clientX-start)*(e.shiftKey?0.1:1)).toFixed(4));input.value=String(value);};
            const end=()=>{cleanup();if(value!==initial)apply(value);};const cancel=()=>{input.value=String(initial);cleanup();};
            const cleanup=()=>{win.removeEventListener('pointermove',move);win.removeEventListener('pointerup',end);win.removeEventListener('pointercancel',cancel);this.dragCleanup=undefined;};
            this.dragCleanup=cancel;win.addEventListener('pointermove',move);win.addEventListener('pointerup',end);win.addEventListener('pointercancel',cancel);
        });
    }
    private fold(uuid:string):void {void this.send({fold:uuid});}
    private destroySelected():void {const state=this.latest?.snapshot;if(!state?.detail)return;if(this.root.ownerDocument.defaultView?.confirm(t('panel.inspector.destroyConfirm')))void this.act('destroy',[state.selected,state.sessionId]);}
    private keyboard(event:KeyboardEvent):void {
        if(event.target instanceof this.root.ownerDocument.defaultView!.HTMLInputElement || event.ctrlKey||event.metaKey||event.altKey)return;
        const state=this.latest?.snapshot;if(!state)return;const collapsed=new Set(this.latest?.options.collapsed);const index=state.nodes.findIndex(n=>n.uuid===state.selected),node=state.nodes[index];let handled=true;
        if(event.key==='ArrowDown'||event.key==='ArrowUp'){const next=state.nodes[Math.max(0,Math.min(state.nodes.length-1,index+(event.key==='ArrowDown'?1:-1)))];if(next)void this.act('select',[next.uuid,state.sessionId]);}
        else if(event.key==='ArrowLeft'&&node){if(node.childCount&&!collapsed.has(node.uuid))this.fold(node.uuid);else if(node.parent)void this.act('select',[node.parent,state.sessionId]);}
        else if(event.key==='ArrowRight'&&node){if(collapsed.has(node.uuid))this.fold(node.uuid);else if(state.nodes[index+1]?.parent===node.uuid)void this.act('select',[state.nodes[index+1]!.uuid,state.sessionId]);}
        else if(event.key===this.shortcuts.pick)void this.act('pick',[!state.picking,state.sessionId]);
        else if(event.key===this.shortcuts.print&&node)void this.act('print',[node.uuid,'',state.sessionId]);
        else if(event.key===this.shortcuts.active&&node)void this.act('edit',[{uuid:node.uuid,field:'active',value:!node.active,expected:node.active},state.sessionId]);
        else if(event.key===this.shortcuts.destroy)this.destroySelected();else handled=false;
        if(handled)event.preventDefault();
    }
    private populateOnExpand(section:HTMLDetailsElement,populate:()=>void):void {
        let populated=false;
        const expand=()=>{if(populated||!section.open||this.closed||section.isConnected===false)return;populated=true;populate();};
        section.addEventListener('toggle',expand);expand();
    }
    renderAnalysis(data:unknown):void {
        const panel=this.element('inspector-render'),state=data as null|{pending:boolean;error:string;result:null|{frame:number;drawCalls:number;triangles:number;limited:boolean;note:string;gpuCalls?:Array<{index:number;method:string;args:number[];program:number;framebuffer:number;activeTextureUnit:number;activeTexture:number;blend:boolean;stencil:boolean;depth:boolean}>;uiBatches:Array<{index:number;nodes:string[];texture:number;sampler:number;indices:number;model:boolean}>;submissions:Array<{node:string;path:string;component:string;texture:string;reasons:string[]}>}};
        const key=JSON.stringify(state);if(panel.dataset.result===key)return;panel.dataset.result=key;panel.replaceChildren();
        if(!state)return;
        const bar=this.text('div','',panel);bar.className='inspector-render-bar';this.text('strong',t('panel.inspector.capture'),bar);this.control(state.pending?t('panel.html.cancel'):t('panel.inspector.close'),bar,()=>void this.send({capture:false})).id='inspector-render-close';
        if(state.pending){this.text('p',t('panel.inspector.waitingFrame'),panel);return;}if(state.error)this.text('p',state.error,panel);const result=state.result;if(!result)return;
        const session=()=>this.latest?.snapshot?.sessionId;
        const section=this.root.ownerDocument.createElement('details');section.open=true;panel.append(section);this.text('summary',t('panel.inspector.frameSummary',{frame:result.frame,drawCalls:result.drawCalls,triangles:result.triangles}),section);this.text('p',result.note,section);
        if(result.limited)this.text('p',t('panel.inspector.captureLimited'),section);
        const gpu=this.root.ownerDocument.createElement('details');section.append(gpu);this.text('summary',t('panel.inspector.gpuCalls',{count:result.gpuCalls?.length||0}),gpu);
        this.populateOnExpand(gpu,()=>{for(const call of result.gpuCalls||[]){this.text('p',t('panel.inspector.gpuCall',{index:call.index,method:call.method,args:call.args.join(', '),program:call.program,framebuffer:call.framebuffer??t('panel.inspector.defaultFramebuffer'),unit:call.activeTextureUnit,texture:call.activeTexture,blend:call.blend,stencil:call.stencil,depth:call.depth}),gpu);}});
        const submissions=new Map(result.submissions.map(item=>[item.node,item]));
        for(const batch of result.uiBatches){const row=this.root.ownerDocument.createElement('details');section.append(row);this.text('summary',t('panel.inspector.uiBatch',{index:batch.index+1,texture:batch.texture,indices:batch.indices??'?',model:batch.model?' · Model':''}),row);this.populateOnExpand(row,()=>{if(!batch.nodes.length)this.text('small',t('panel.inspector.specialSubmission'),row);for(const uuid of batch.nodes){const entry=submissions.get(uuid);this.control(entry?.path||uuid,row,()=>{const id=session();if(id)void this.act('select',[uuid,id]);});}});}
        const entries=this.root.ownerDocument.createElement('details');section.append(entries);this.text('summary',t('panel.inspector.submissions',{count:result.submissions.length}),entries);this.text('small',t('panel.inspector.submissionsNote'),entries);
        this.populateOnExpand(entries,()=>{for(const item of result.submissions){this.control(item.path,entries,()=>{const id=session();if(id)void this.act('select',[item.node,id]);});this.text('p',item.reasons.join(t('panel.inspector.listSeparator'))||t('panel.inspector.sameAsPrevious'),entries);}});
    }
    // What this surface currently shows, in words: enough for an AI to confirm a render without a screenshot.
    report():Record<string,unknown> {
        const text=(id:string)=>{const element=this.optional(id);return element?element.textContent??'':null;};
        const children=(element:HTMLElement|null)=>element?Array.from(element.children as unknown as HTMLElement[]):[];
        const tree=this.optional('inspector-tree'),rows=children(tree);
        const detail=this.optional('inspector-detail'),blocks=children(detail),sections=blocks.filter(el=>el.tagName==='DETAILS') as HTMLDetailsElement[];
        const state=this.latest;
        return {visible:this.visible,registered:this.registered,passive:this.passive,serial:state?.serial??null,closedHub:state?.closed??null,sessionId:state?.snapshot?.sessionId??null,
            message:this.root.querySelector<HTMLElement>('.inspector-message')?.textContent??null,notice:this.notice,
            hierarchy:tree?{rows:rows.length,names:rows.slice(0,20).map(row=>String((row.children as unknown as HTMLElement[])?.[2]?.textContent??row.textContent??'')),selected:tree.dataset.selected||'',hovered:tree.dataset.hovered||'',count:text('inspector-count'),search:(this.optional('inspector-search') as HTMLInputElement|null)?.value??null,candidates:children(this.optional('inspector-candidates')).length}:null,
            properties:detail?{node:detail.dataset.node||'',title:String((blocks[0]?.children as unknown as HTMLElement[])?.[0]?.textContent??''),blocks:blocks.length,components:sections.length,expanded:sections.filter(section=>section.open).length,undoVisible:!!this.undoButton&&!this.undoButton.hidden}:null,
            toolbar:this.optional('inspector-pick')?{picking:!!state?.snapshot?.picking,link:!!state?.options.link,capturePending:!!state?.capturePending}:null,
            status:text('status'),connection:text('connection'),gameVersion:text('game-version')};
    }
    close():void {
        if(this.closed)return;this.closed=true;clearTimeout(this.searchTimer);clearTimeout(this.hoverTimer);clearTimeout(this.retryTimer);this.dragCleanup?.();
        for(const remove of this.listeners)remove();this.listeners=[];
        if(this.registered)void this.client.view(false).catch(()=>{});
    }
}
async function request<T>(method:string,...args:unknown[]):Promise<T> {
    const reply=await Editor.Message.request<Reply<T>>('cocos-git-desk',method,...args);
    if(!reply.ok)throw Error(reply.error);return reply.data;
}
export function inspectorClient(viewer:string):InspectorClient {
    return {
        view:visible=>request('runtime-inspector-view',viewer,visible),
        state:()=>request('runtime-inspector-state'),
        update:change=>request('runtime-inspector-update',change),
        action:(method,args)=>request('runtime-inspector-action',method,args),
        hover:(frame,uuid,session)=>request('runtime-inspector-call',frame,'hover',[uuid,session]),
        read:(uuid,id,key)=>request('runtime-inspector-read',uuid,id,key),
        navigate:(uuid,action,fileId)=>request('runtime-inspector-asset',uuid,action,fileId),
    };
}
export const stateBroadcast='cocos-git-desk:runtime-inspector';
export interface InspectorMount { view:RuntimeInspectorView; setVisible(value:boolean):void; dispose():void; }
// Wires a view to the hub through Creator messages; the window document's own
// visibility and the panel's show/hide both gate polling.
// Creator's theme variables live on the editor document. A panel root that cannot see them (a shadow
// root reset with all: initial, or a detached window) copies the editor's current values so light and
// dark themes both match instead of falling back to the dark defaults.
export const editorThemeVariables=['--color-default-fill','--color-default-fill-weaker','--color-default-fill-weakest','--color-default-fill-emphasis','--color-default-border','--color-default-border-weaker','--color-default-contrast','--color-default-contrast-weaker','--color-default-contrast-emphasis','--color-focus-border','--color-primary-fill','--color-warn-fill','--color-danger-fill','--color-info-fill'];
export function adoptEditorTheme(root:HTMLElement):number {
    const win=root.ownerDocument.defaultView;if(!win||typeof win.getComputedStyle!=='function')return 0;
    let copied=0;
    try {
        if(win.getComputedStyle(root).getPropertyValue(editorThemeVariables[0]!).trim())return 0;
        const source=win.getComputedStyle(root.ownerDocument.documentElement);
        for(const name of editorThemeVariables){const value=source.getPropertyValue(name).trim();if(value){root.style.setProperty(name,value);copied++;}}
    } catch { /* theme adoption is cosmetic */ }
    return copied;
}
export function mountInspector(root:HTMLElement, options:{passive?:boolean;viewer:string;tooltips?:boolean}):InspectorMount {
    const view=new RuntimeInspectorView(root,inspectorClient(options.viewer),options.passive===true);
    const tooltips=options.tooltips?new PanelTooltips(root):undefined;
    const document=root.ownerDocument;
    adoptEditorTheme(root);
    let shown=true;
    const onState=(...args:unknown[])=>{const state=args[0] as HubState|undefined;if(state&&typeof state==='object')view.update(state);};
    const apply=()=>view.setVisible(shown&&!document.hidden);
    // Self-check support: answer the main process with what is rendered, and report renderer errors.
    const send=(payload:Record<string,unknown>)=>void Editor.Message.request('cocos-git-desk','runtime-inspector-report',options.viewer,payload).catch(()=>{});
    const onReport=(...args:unknown[])=>{send({kind:'report',requestId:args[0]??null,...view.report()});};
    const onError=(event:Event)=>{const detail=event as ErrorEvent;send({kind:'issue',message:String(detail.message||detail.error||t('panel.inspector.unknownError')).slice(0,500)});};
    const win=document.defaultView;
    Editor.Message.addBroadcastListener(stateBroadcast,onState);
    Editor.Message.addBroadcastListener(reportRequestBroadcast,onReport);
    document.addEventListener('visibilitychange',apply);
    win?.addEventListener('error',onError);
    if(!document.hidden)view.start();else view.setVisible(false);
    return {
        view,
        setVisible(value){shown=value;apply();},
        dispose(){Editor.Message.removeBroadcastListener(stateBroadcast,onState);Editor.Message.removeBroadcastListener(reportRequestBroadcast,onReport);document.removeEventListener('visibilitychange',apply);win?.removeEventListener('error',onError);view.close();tooltips?.close();},
    };
}
