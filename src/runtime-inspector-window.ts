import { toolbarTemplate, hierarchyTemplate, propertiesTemplate, inspectorChromeStyle, inspectorStyle, mountInspector, InspectorMount } from './runtime-inspector-panel';
export const template=`<div id="inspector-window"><div id="status" role="status"></div>${toolbarTemplate}<div class="inspector-workspace">${hierarchyTemplate}${propertiesTemplate}</div></div>`;
export const style=`:host{display:flex;height:100%;background:var(--color-default-fill,#333);color:var(--color-default-contrast,#ccc);font-size:12px;font-family:var(--font-family,system-ui,sans-serif)}`+inspectorChromeStyle+inspectorStyle+`
#inspector-window{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:0}
#status{white-space:pre-wrap;overflow-wrap:anywhere;padding:6px 12px;color:var(--gd-warn);max-height:72px;overflow:auto}#status:empty{display:none}
.inspector-toolbar{padding:6px 10px;border-bottom:1px solid var(--gd-border);background:var(--gd-bg-weak)}.inspector-controls{gap:6px}
.inspector-workspace{display:grid;grid-template-columns:minmax(220px,38%) minmax(0,1fr);flex:1;min-height:0;overflow:hidden}
.inspector-hierarchy{border-right:1px solid var(--gd-border);background:var(--gd-bg-weak)}
@media(max-width:620px){.inspector-workspace{grid-template-columns:1fr;grid-template-rows:minmax(150px,42%) minmax(0,1fr)}.inspector-hierarchy{border-right:0;border-bottom:1px solid var(--gd-border)}}
`;
export const $={root:'#inspector-window'};
interface Instance {$:{root:HTMLElement};mount?:InspectorMount;}
export function ready(this:Instance):void {this.mount?.dispose();this.mount=mountInspector(this.$.root,{viewer:'window',tooltips:true});}
export function close(this:Instance):void {this.mount?.dispose();this.mount=undefined;}
export const listeners={show(this:Instance):void{this.mount?.setVisible(true);},hide(this:Instance):void{this.mount?.setVisible(false);}};
