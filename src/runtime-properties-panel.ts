import { propertiesTemplate, inspectorChromeStyle, inspectorStyle, mountInspector, InspectorMount } from './runtime-inspector-panel';
export const template=`<div id="runtime-properties">${propertiesTemplate}</div>`;
export const style=`:host{display:flex;height:100%;background:var(--color-default-fill,#333);color:var(--color-default-contrast,#ccc);font-size:12px;font-family:var(--font-family,system-ui,sans-serif)}#runtime-properties{display:flex;flex-direction:column;width:100%;height:100%;min-height:0}`+inspectorChromeStyle+inspectorStyle;
export const $={root:'#runtime-properties'};
interface Instance {$:{root:HTMLElement};mount?:InspectorMount;}
export function ready(this:Instance):void {this.mount?.dispose();this.mount=mountInspector(this.$.root,{viewer:'properties',tooltips:true});}
export function close(this:Instance):void {this.mount?.dispose();this.mount=undefined;}
export const listeners={show(this:Instance):void{this.mount?.setVisible(true);},hide(this:Instance):void{this.mount?.setVisible(false);}};
