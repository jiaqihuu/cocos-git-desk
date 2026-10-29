import { t, MessageError } from './i18n';
export interface SceneTab { uuid: string; name: string; dirty: boolean; type: 'scene' | 'prefab'; }
export type SceneRequest = <T = unknown>(name: string, message: string, ...args: unknown[]) => Promise<T>;
export class EditorPreparationRequiredError extends Error {
    constructor(message: string, readonly worktreeChange: boolean) { super(message); }
}
interface EditorState { dirty: boolean; scenes: SceneTab[]; }
export async function state(request: SceneRequest): Promise<EditorState> {
    const dirty = await request('scene', 'query-dirty');
    if (typeof dirty !== 'boolean') throw new MessageError('creator.tools.prepSceneStateUnknown');
    const scenes = await request('scene', 'multi-scene-query');
    if (!Array.isArray(scenes) || scenes.some(s => !s || typeof s.dirty !== 'boolean' || typeof s.uuid !== 'string' || !['scene', 'prefab'].includes(s.type))) throw new MessageError('creator.tools.prepTabsStateUnknown');
    return { dirty, scenes };
}
function required(value: EditorState, requireScene: boolean): boolean {
    return value.dirty || value.scenes.some(s => s.dirty || (requireScene && s.type === 'prefab'));
}
export async function checkEditorState(request: SceneRequest, requireScene: boolean): Promise<void> {
    const value = await state(request);
    if (required(value, requireScene)) throw new EditorPreparationRequiredError(requireScene
        ? t('creator.tools.prepSaveAndExitPrefab')
        : t('creator.tools.prepSaveScenes'), requireScene);
}

export async function prepareEditorForGit(requireScene: boolean, host: {
    request: SceneRequest;
    confirm(detail: string): Promise<boolean | 'save' | 'discard'>;
    assertIdle(): void;
}): Promise<boolean> {
    host.assertIdle();
    const before = await state(host.request);
    if (!required(before, requireScene)) return true;
    const context = (value: EditorState) => JSON.stringify(value.scenes.map(s => [s.uuid, s.type]));
    const detail = [
        t('creator.tools.prepWillSave', { rest: (requireScene ? t('creator.tools.prepWillExitPrefab') : t('creator.tools.prepPeriod')) }),
        t('creator.tools.prepCurrentTabs', { tabs: (before.scenes.map(s => s.name || s.uuid || t('creator.tools.unnamed')).join(t('creator.tools.listSeparator')) || t('creator.tools.unnamedScene')) }),
        t('creator.tools.prepDiscardOption'),
        t('creator.tools.prepScopeNote'),
        t('creator.tools.prepSaveNote'),
    ].join('\n');
    const choice=await host.confirm(detail);
    if (!choice) return false;
    host.assertIdle();
    if (context(await state(host.request)) !== context(before)) throw new MessageError('creator.tools.prepTabsChanged');
    if(choice==='discard') {
        // Creator owns the unsaved-changes prompt. Never clear dirty flags,
        // auto-answer dialogs, reset Git files or silently save on this path.
        for(let count=0;count<100;count++) {
            host.assertIdle();
            const current=await state(host.request);
            if(!required(current,requireScene))return true;
            const active=await host.request('scene','query-current-scene');
            const tab=current.scenes.find(s=>s.dirty || (requireScene&&s.type==='prefab'))
                || current.scenes.find(s=>s.uuid===active);
            if(!tab)throw Error(t('creator.tools.prepCannotConfirmClose'));
            if(active!==tab.uuid) {
                await host.request('scene','multi-scene-focus',tab.uuid);
                if(await host.request('scene','query-current-scene')!==tab.uuid)throw Error(t('creator.tools.prepCannotFocus'));
            }
            host.assertIdle();
            if(await host.request('scene','close-scene')!==true)throw Error(t('creator.tools.prepCloseCancelled'));
            if((await state(host.request)).scenes.some(s=>s.uuid===tab.uuid&&s.type===tab.type))throw Error(t('creator.tools.prepNotClosed'));
        }
        throw Error(t('creator.tools.prepTooManyCloses'));
    }
    const saveAll = async () => {
        host.assertIdle();
        const current = await state(host.request);
        if (current.dirty || current.scenes.some(s => s.dirty)) {
            // Creator's multiSaveAllScene returns void; a read-back detects save-as cancellation.
            await host.request('scene', 'multi-save-all-scene');
            const saved = await state(host.request);
            if (saved.dirty || saved.scenes.some(s => s.dirty)) throw new MessageError('creator.tools.prepSaveIncomplete');
        }
    };
    await saveAll();
    if (requireScene) {
        const tabs = (await state(host.request)).scenes.filter(s => s.type === 'prefab');
        for (const tab of tabs) {
            host.assertIdle();
            if (await host.request('scene', 'query-current-scene') !== tab.uuid) {
                await host.request('scene', 'multi-scene-focus', tab.uuid);
                if (await host.request('scene', 'query-current-scene') !== tab.uuid) throw new MessageError('creator.tools.prepCannotFocusPrefab');
            }
            await saveAll();
            host.assertIdle();
            if (await host.request('scene', 'close-scene') !== true) throw new MessageError('creator.tools.prepExitPrefabIncomplete');
            if ((await state(host.request)).scenes.some(s => s.uuid === tab.uuid && s.type === 'prefab')) throw new MessageError('creator.tools.prepPrefabNotExited');
            // A dirty underlying scene may only become visible after the Prefab closes.
            await saveAll();
        }
    }
    host.assertIdle();
    await checkEditorState(host.request, requireScene);
    return true;
}
export { state as readEditorState };
