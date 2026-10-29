import { assetUuid } from './runtime-inspector-assets';
import { validateToolArgs } from './preview-debug';
import { t, MessageError } from './i18n';

export interface SceneHost {
    request<T = unknown>(channel: string, message: string, ...args: unknown[]): Promise<T>;
    assertIdle(): void;
    taskPaths(taskId: string): Promise<string[] | null>;
}
interface ToolSchema { name: string; inputSchema: { properties: Record<string, any>; required?: string[] }; }
interface TreeNode { uuid?: string; name?: string; active?: boolean; type?: string; prefab?: { assetUuid?: string; uuid?: string } | null; children?: TreeNode[]; [key: string]: unknown; }
export const sceneToolNames = new Set(['creator_scene_tree', 'creator_node_inspect', 'creator_node_create', 'creator_node_remove', 'creator_component_add', 'creator_component_remove', 'creator_property_set', 'creator_scene_save', 'creator_scene_open', 'creator_prefab_instantiate']);
const textLimit = 500, arrayLimit = 50;

// Editor-side scene and prefab editing through Creator's scene messages, as the 3.8.8 editor itself
// does it. Every write takes a Git Desk task: the scene or prefab currently open must be inside that
// task, an undo snapshot is taken first, and nothing is saved unless creator_scene_save is called.
export class SceneTools {
    constructor(private host: SceneHost, private schemas: ToolSchema[]) {}
    async call(name: string, input: unknown): Promise<unknown> {
        const args = validateToolArgs(this.schemas.find(tool => tool.name === name), input);
        switch (name) {
            case 'creator_scene_tree': return this.tree(args);
            case 'creator_node_inspect': return this.inspect(args);
            case 'creator_node_create': return this.createNode(args);
            case 'creator_node_remove': return this.write(args, 'remove-node', { uuid: args.uuid }, { removed: args.uuid });
            case 'creator_component_add': return this.write(args, 'create-component', { uuid: args.uuid, component: args.component }, { node: args.uuid, component: args.component });
            case 'creator_component_remove': return this.write(args, 'remove-component', { uuid: args.uuid, component: args.component }, { node: args.uuid, component: args.component });
            case 'creator_property_set': return this.write(args, 'set-property', { uuid: args.uuid, path: args.path, dump: { value: args.value, type: args.type } }, { node: args.uuid, path: args.path });
            case 'creator_scene_save': return this.save(args);
            case 'creator_scene_open': return this.open(args);
            case 'creator_prefab_instantiate': return this.instantiate(args);
            default: throw new MessageError('creator.tools.unknownTool', { name });
        }
    }
    // The open scene or prefab, as an asset url; writes are only allowed when it lies inside the task.
    private async current(): Promise<{ uuid: string; url: string; rel: string }> {
        const uuid = await this.host.request<unknown>('scene', 'query-current-scene');
        if (typeof uuid !== 'string' || !uuid) throw new MessageError('creator.tools.noOpenScene');
        const info = await this.host.request<{ url?: string } | null>('asset-db', 'query-asset-info', uuid, ['uuid', 'url']);
        if (!info || typeof info.url !== 'string' || !info.url.startsWith('db://')) throw new MessageError('creator.tools.sceneAssetUnknown', { uuid });
        return { uuid, url: info.url, rel: info.url.slice('db://'.length) };
    }
    private async guard(taskId: unknown): Promise<{ uuid: string; url: string; rel: string }> {
        this.host.assertIdle();
        if (typeof taskId !== 'string' || !taskId) throw new MessageError('creator.tools.taskIdRequired');
        const scene = await this.current();
        const paths = await this.host.taskPaths(taskId);
        if (!paths) throw new MessageError('creator.tools.taskNotFound', { taskId });
        if (!paths.includes(scene.rel)) throw new MessageError('creator.tools.sceneOutsideTask', { url: scene.url });
        return scene;
    }
    private async write(args: Record<string, unknown>, message: string, payload: Record<string, unknown>, summary: Record<string, unknown>): Promise<unknown> {
        const scene = await this.guard(args.taskId);
        // Removing a node changes its parent, so the parent is the node recorded for undo.
        const target = message === 'remove-node' ? await this.parentOf(payload.uuid) : payload.uuid;
        const result = await this.recorded(target, () => this.host.request<unknown>('scene', message, payload));
        return { ...summary, result: result ?? null, scene: scene.url, dirty: await this.dirty(), note: t('creator.tools.unsavedInMemory') };
    }
    private async snapshot(): Promise<void> { try { await this.host.request('scene', 'snapshot'); } catch { /* snapshots are best effort */ } }
    // Creator 3.8.8 records an undo step, and marks the scene dirty, between begin-recording(node) and
    // end-recording(undoID); an edit made without it changes the scene in memory while the scene stays clean, so
    // creator_scene_save would find nothing to save. Builds without the recording messages fall back to a snapshot.
    private async recorded<T>(node: unknown, edit: () => Promise<T>): Promise<T> {
        let undo: unknown;
        if (typeof node === 'string' && node) { try { undo = await this.host.request<unknown>('scene', 'begin-recording', node); } catch { undo = undefined; } }
        let result: T;
        try { result = await edit(); }
        catch (error) {
            if (undo !== undefined && undo !== null) { try { await this.host.request('scene', 'cancel-recording', undo); } catch { /* nothing was recorded */ } }
            throw error;
        }
        if (undo !== undefined && undo !== null) { try { await this.host.request('scene', 'end-recording', undo); } catch { await this.snapshot(); } }
        else await this.snapshot();
        return result;
    }
    private async parentOf(uuid: unknown): Promise<unknown> {
        try { const dump = await this.host.request<{ parent?: { value?: { uuid?: unknown } } } | null>('scene', 'query-node', uuid); return dump?.parent?.value?.uuid ?? uuid; }
        catch { return uuid; }
    }
    private async dirty(): Promise<boolean | null> { try { const value = await this.host.request<unknown>('scene', 'query-dirty'); return typeof value === 'boolean' ? value : null; } catch { return null; } }
    private async tree(args: Record<string, unknown>): Promise<unknown> {
        const depthLimit = typeof args.depth === 'number' ? args.depth : 30, limit = typeof args.limit === 'number' ? args.limit : 500;
        const root = await this.host.request<TreeNode | TreeNode[] | null>('scene', 'query-node-tree', ...(typeof args.uuid === 'string' ? [args.uuid] : []));
        if (!root) throw new MessageError('creator.tools.noSceneTree');
        const nodes: Array<{ uuid: string; name: string; path: string; depth: number; active: boolean; type: string; prefab: boolean; prefabAsset?: string; childCount: number }> = [];
        let truncated = false;
        const visit = (node: TreeNode, path: string, depth: number) => {
            if (nodes.length >= limit) { truncated = true; return; }
            const name = String(node.name ?? ''), full = path ? path + '/' + name : name;
            const children = Array.isArray(node.children) ? node.children : [];
            // Creator 3.8.8 attaches a prefab block to every node; only a non-empty asset uuid marks an instance.
            const prefabAsset = node.prefab && typeof node.prefab === 'object' ? String(node.prefab.assetUuid || node.prefab.uuid || '') : '';
            nodes.push({ uuid: String(node.uuid ?? ''), name, path: full, depth, active: node.active !== false, type: String(node.type ?? ''), prefab: !!prefabAsset, ...(prefabAsset ? { prefabAsset } : {}), childCount: children.length });
            if (depth >= depthLimit) { if (children.length) truncated = true; return; }
            for (const child of children) visit(child, full, depth + 1);
        };
        for (const node of Array.isArray(root) ? root : [root]) visit(node, '', 0);
        return { scene: await this.current().catch(() => null), total: nodes.length, truncated, nodes };
    }
    // Creator answers with property dumps ({value, type, ...}); the tool returns plain values plus the
    // paths needed for creator_property_set.
    private async inspect(args: Record<string, unknown>): Promise<unknown> {
        const dump = await this.host.request<Record<string, any> | null>('scene', 'query-node', args.uuid);
        if (!dump) throw new MessageError('creator.tools.nodeNotFound', { uuid: String(args.uuid) });
        const plain = (value: unknown, depth = 0): unknown => {
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                const record = value as Record<string, unknown>;
                if ('value' in record && ('type' in record || 'default' in record || 'readonly' in record)) return plain(record.value, depth);
                if (depth >= 3) return t('creator.tools.objectPlaceholder');
                const out: Record<string, unknown> = {};
                for (const [key, item] of Object.entries(record).slice(0, 80)) out[key] = plain(item, depth + 1);
                return out;
            }
            if (Array.isArray(value)) return value.slice(0, arrayLimit).map(item => plain(item, depth + 1));
            if (typeof value === 'string') return value.length > textLimit ? value.slice(0, textLimit) + '…' : value;
            return value;
        };
        const components = (Array.isArray(dump.__comps__) ? dump.__comps__ : []).map((component: Record<string, any>, index: number) => {
            const value = component?.value && typeof component.value === 'object' ? component.value : {};
            const properties: Record<string, unknown> = {};
            for (const [key, item] of Object.entries(value).slice(0, 120)) properties[key] = plain(item);
            return { index, type: String(component?.type ?? ''), uuid: String(value?.uuid?.value ?? component?.value?.uuid ?? ''), enabled: value?.enabled?.value ?? null, pathPrefix: '__comps__.' + index + '.', properties };
        });
        const node: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(dump)) if (key !== '__comps__' && key !== 'children' && key !== 'parent' && key !== '__prefab__') node[key] = plain(item);
        return { uuid: String(args.uuid), node, prefab: dump.__prefab__ ? plain(dump.__prefab__) : null, components,
            note: t('creator.tools.propertyPathNote') };
    }
    private async createNode(args: Record<string, unknown>): Promise<unknown> {
        const scene = await this.guard(args.taskId);
        const payload: Record<string, unknown> = { parent: args.parent, name: args.name };
        const uuid = await this.recorded(args.parent, () => this.host.request<unknown>('scene', 'create-node', payload));
        return { created: Array.isArray(uuid) ? uuid[0] : uuid, parent: args.parent, name: args.name, scene: scene.url, dirty: await this.dirty(), note: t('creator.tools.unsavedInMemory') };
    }
    private async instantiate(args: Record<string, unknown>): Promise<unknown> {
        const scene = await this.guard(args.taskId);
        const id = typeof args.prefab === 'string' && args.prefab.startsWith('db://') ? await this.host.request<unknown>('asset-db', 'query-uuid', args.prefab) : args.prefab;
        if (typeof id !== 'string' || !id) throw new MessageError('creator.tools.prefabNotFound', { prefab: String(args.prefab) });
        const uuid = assetUuid(id);
        const info = await this.host.request<{ url?: string } | null>('asset-db', 'query-asset-info', uuid, ['uuid', 'url']);
        if (!info || typeof info.url !== 'string' || !/\.prefab$/i.test(info.url)) throw new MessageError('creator.tools.notPrefab', { prefab: String(args.prefab) });
        const payload: Record<string, unknown> = { parent: args.parent, assetUuid: uuid };
        if (typeof args.name === 'string') payload.name = args.name;
        const created = await this.recorded(args.parent, () => this.host.request<unknown>('scene', 'create-node', payload));
        return { created: Array.isArray(created) ? created[0] : created, prefab: info.url, parent: args.parent, scene: scene.url, dirty: await this.dirty(), note: t('creator.tools.unsavedInMemory') };
    }
    private async save(args: Record<string, unknown>): Promise<unknown> {
        const scene = await this.guard(args.taskId);
        if ((await this.dirty()) === false) return { saved: false, scene: scene.url, note: t('creator.tools.nothingToSave') };
        await this.host.request('scene', 'save-scene');
        const dirty = await this.dirty();
        if (dirty === true) throw new MessageError('creator.tools.saveIncomplete');
        return { saved: true, scene: scene.url, note: t('creator.tools.savedNote', { url: scene.url }) };
    }
    private async open(args: Record<string, unknown>): Promise<unknown> {
        this.host.assertIdle();
        const id = typeof args.url === 'string' ? await this.host.request<unknown>('asset-db', 'query-uuid', args.url) : args.uuid;
        if (typeof id !== 'string' || !id) throw new MessageError('creator.tools.assetMissing', { asset: String(args.url ?? args.uuid) });
        const uuid = assetUuid(id);
        const info = await this.host.request<{ url?: string } | null>('asset-db', 'query-asset-info', uuid, ['uuid', 'url']);
        if (!info || typeof info.url !== 'string' || !/\.(scene|prefab)$/i.test(info.url)) throw new MessageError('creator.tools.openSceneOnly', { asset: String(args.url ?? args.uuid) });
        // Creator owns the unsaved-changes prompt; a refused open leaves the current scene in place.
        await this.host.request('scene', 'open-scene', uuid);
        const current = await this.host.request<unknown>('scene', 'query-current-scene');
        return { opened: current === uuid, url: info.url, current: typeof current === 'string' ? current : null, note: current === uuid ? '' : t('creator.tools.notSwitched') };
    }
}
