import type { EditorRequest } from './editor-files';
import { t } from './i18n';

export function assetUuid(value:string):string {
    if(typeof value!=='string'||value.length>160)throw Error(t('inspector.invalidAssetUuid'));
    const parts=value.split('@');let id=parts[0]!;
    if(parts.length>2||(parts.length===2&&!/^[a-z0-9_-]{1,80}$/i.test(parts[1]!)))throw Error(t('inspector.invalidSubAssetUuid'));
    if(/^[0-9a-f]{2}[A-Za-z0-9+/]{20}$/i.test(id)) {
        const hex=id.slice(0,2)+Buffer.from(id.slice(2),'base64').toString('hex');
        id=[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
    }
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw Error(t('inspector.noSourceUuid'));
    return id.toLowerCase()+(parts[1]?'@'+parts[1]:'');
}
const wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
// Components whose class id is not a script UUID are resolved by their class name, one class per file in this project.
async function scriptByName(request:EditorRequest,name:string):Promise<string> {
    const found:Array<{uuid?:string;url?:string}>=[];
    for(const extension of ['ts','js']){
        const list=await request<Array<{uuid?:string;url?:string}>|null>('asset-db','query-assets',{pattern:'db://assets/**/'+name+'.'+extension});
        if(Array.isArray(list))found.push(...list.filter(item=>item&&typeof item.uuid==='string'&&typeof item.url==='string'));
    }
    if(!found.length)throw Error(t('inspector.scriptNotFound', { name }));
    if(found.length>1)throw Error(t('inspector.scriptAmbiguous', { list: found.map(item=>item.url).join(t('inspector.listSeparator')) }));
    return assetUuid(found[0]!.uuid!);
}
// The assets panel may not answer a twinkle for every asset kind; selection still goes through after the wait.
async function reveal(request:EditorRequest,select:(uuid:string)=>void,uuid:string):Promise<boolean> {
    const file=uuid.split('@')[0]!;
    const answered=await Promise.race([request('assets','twinkle',file).then(()=>true,()=>false),wait(3000).then(()=>false)]);
    select(file);
    return answered;
}
export async function locateRuntimeAsset(uuid:string, action:'reveal'|'open'|'prefab', request:EditorRequest, select:(uuid:string)=>void, fileId?:string, selectNode:(uuid:string)=>boolean=()=>{throw Error(t('inspector.selectUnsupported'));}):Promise<string> {
    if(action!=='reveal'&&action!=='open'&&action!=='prefab')throw Error(t('inspector.unsupportedAssetAction'));
    const id=/^[A-Za-z_$][\w$]*$/.test(uuid)?await scriptByName(request,uuid):assetUuid(uuid);
    const info=await request<{uuid:string;url:string;file:string;invalid:boolean}|null>('asset-db','query-asset-info',id,['uuid','url','file','invalid']);
    if(!info||typeof info.uuid!=='string'||assetUuid(info.uuid)!==id||typeof info.url!=='string'||!/^db:\/\/(assets|internal)\//.test(info.url)||info.invalid)throw Error(t('inspector.sourceAssetMissing'));
    if(action==='prefab') {
        if(!info.url.endsWith('.prefab'))throw Error(t('inspector.notPrefab'));
        if(typeof fileId!=='string'||!fileId||fileId.length>160)throw Error(t('inspector.noSourceNodeId'));
        // Delegate navigation and unsaved-change prompts to Creator. Never save
        // or discard the user's edits automatically, nor retry the open request.
        // The assets panel highlights the prefab file first; the node selection below then takes over the inspector.
        await reveal(request,select,info.uuid);
        // Creator 3.8.8 answers open-asset with a value rather than undefined, so only a rejection counts as failure.
        await request('asset-db','open-asset',info.uuid);
        for(let attempt=0;attempt<40;attempt++) {
            const result=await request<{state:string;uuid?:string}>('scene','execute-scene-script',{
                name:'cocos-git-desk',method:'selectPrefabNode',args:[id,fileId],
            });
            if(result?.state==='found'&&typeof result.uuid==='string'&&result.uuid)return selectNode(result.uuid)?t('inspector.prefabOpenedSelected', { url: info.url }):t('inspector.prefabOpenedUnconfirmed', { url: info.url });
            if(result?.state==='missing')throw Error(t('inspector.sourceNodeGone'));
            if(result?.state!=='pending')throw Error(t('inspector.noLocateResult'));
            await wait(250);
        }
        throw Error(t('inspector.prefabNotOpened'));
    }
    if(action==='open') {
        if(!/\.(ts|js)$/i.test(info.url))throw Error(t('inspector.onlyScriptsOpen'));
        await request('asset-db','open-asset',info.uuid);
        return t('inspector.openedScript', { url: info.url });
    }
    const answered=await reveal(request,select,info.uuid);
    return (answered?t('inspector.located'):t('inspector.selectedNoFlash'))+info.url;
}
