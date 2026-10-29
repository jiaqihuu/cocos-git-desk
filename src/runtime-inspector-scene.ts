import { assetUuid } from './runtime-inspector-assets';
import { t } from './i18n';

interface SourceNode {
    uuid:string;
    children:SourceNode[];
    prefab?:{asset?:{uuid?:string;_uuid?:string};fileId?:string}|null;
}
function prefabUuid(node:SourceNode):string {
    try{return assetUuid(node.prefab?.asset?.uuid || node.prefab?.asset?._uuid || '');}catch{return '';}
}
export function findPrefabNode(root:SourceNode|null, uuid:string, fileId:string):{state:'pending'|'missing'|'found';uuid?:string} {
    const id=assetUuid(uuid);
    if(typeof fileId!=='string'||!fileId||fileId.length>160)throw Error(t('inspector.noSourceNodeId'));
    if(!root||prefabUuid(root)!==id)return {state:'pending'};
    const stack=[root],matches:string[]=[];let visited=0;
    while(stack.length) {
        if(++visited>50000)throw Error(t('inspector.prefabTooManyNodes'));
        const node=stack.pop()!;
        if(prefabUuid(node)===id&&node.prefab?.fileId===fileId)matches.push(node.uuid);
        stack.push(...node.children);
    }
    if(matches.length>1)throw Error(t('inspector.sourceNodeAmbiguous'));
    return matches.length?{state:'found',uuid:matches[0]}:{state:'missing'};
}
export function load():void {}
export function unload():void {}
export const methods={
    selectPrefabNode(uuid:string,fileId:string) {
        // Creator 3.8.8 exposes the active editing root; normal scenes must not
        // match a prefab instance before the prefab editor finishes opening.
        const context=globalThis as unknown as {cce?:{Scene?:{rootNode?:SourceNode}}};
        // Selection happens in the main process: the scene process does not report selection state reliably.
        return findPrefabNode(context.cce?.Scene?.rootNode||null,uuid,fileId);
    },
};
