// Semantic difference between two versions of a Creator serialized asset (.prefab / .scene): nodes by
// path, components by type, properties with node and asset references resolved to readable labels.
import { t, MessageError } from './i18n';
export interface SerializedObject { __type__?: string; [key: string]: unknown; }
interface Ref { __id__: number; }
export interface PrefabDiffOptions { limit?: number; labelAsset?: (uuid: string) => string | undefined; labelType?: (type: string) => string | undefined; }
export interface NodeChange { kind: 'added' | 'removed' | 'moved' | 'renamed'; path: string; from?: string; }
export interface ComponentChange { kind: 'added' | 'removed'; node: string; type: string; }
export interface PropertyChange { node: string; component?: string; property: string; before: unknown; after: unknown; }
export interface AssetUse { uuid: string; label?: string; before: number; after: number; }
export interface PrefabDiff { left: { nodes: number; components: number }; right: { nodes: number; components: number }; nodes: NodeChange[]; components: ComponentChange[]; properties: PropertyChange[]; assets: AssetUse[]; truncated: boolean; summary: string; }

interface NodeEntry { index: number; name: string; parent: string | null; stableId: string; components: { index: number; type: string; key: string }[]; mounted: { index: number; type: string; key: string; node: string }[]; }
interface Model { objects: SerializedObject[]; nodes: Map<string, NodeEntry>; pathOf: Map<number, string>; componentOf: Map<number, { node: string; key: string }>; uuids: Map<string, number>; types: Set<string>; }

const NODE_TYPES = new Set(['cc.Node', 'cc.Scene']);
const SKIP_NODE = new Set(['__type__', '_children', '_components', '_parent', '_prefab', '_id', '_objFlags', '__editorExtras__']);
const SKIP_COMPONENT = new Set(['__type__', 'node', '_id', '_objFlags', '__editorExtras__', '__prefab']);
const TEXT_LIMIT = 300, UUID_LIMIT = 200;
const isRef = (value: unknown): value is Ref => !!value && typeof value === 'object' && typeof (value as Ref).__id__ === 'number';
const isAssetRef = (value: unknown): value is { __uuid__: string } => !!value && typeof value === 'object' && typeof (value as { __uuid__?: unknown }).__uuid__ === 'string';

export function parseSerialized(text: string): SerializedObject[] {
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new MessageError('common.prefabNotJson'); }
    if (!Array.isArray(value) || !value.every(item => item && typeof item === 'object' && !Array.isArray(item))) throw new MessageError('common.prefabNotSerialized');
    return value as SerializedObject[];
}
// Creator's compressed uuid: a hex head (5 characters for component class ids in serialized files, 2 for
// the short form) followed by the remaining hex digits packed three at a time into two base64 characters.
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function compressUuid(uuid: string, min = false): string {
    const hex = uuid.replace(/-/g, '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(hex)) return uuid;
    const head = min ? 2 : 5;
    let out = hex.slice(0, head);
    for (let i = head; i < 32; i += 3) { const a = parseInt(hex[i]!, 16), b = parseInt(hex[i + 1]!, 16), c = parseInt(hex[i + 2]!, 16); out += BASE64[(a << 2) | (b >> 2)]! + BASE64[((b & 3) << 4) | c]!; }
    return out;
}
export function decompressUuid(value: string): string | null {
    const head = value.length === 23 ? 5 : value.length === 22 ? 2 : 0;
    if (!head || !/^[0-9a-f]+$/.test(value.slice(0, head)) || !/^[A-Za-z0-9+/]+$/.test(value.slice(head))) return null;
    let hex = value.slice(0, head);
    for (let i = head; i < value.length; i += 2) { const a = BASE64.indexOf(value[i]!), b = BASE64.indexOf(value[i + 1]!); if (a < 0 || b < 0) return null; hex += (a >> 2).toString(16) + (((a & 3) << 2) | (b >> 4)).toString(16) + (b & 15).toString(16); }
    return hex.length === 32 ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : null;
}
export function collectReferences(sides: SerializedObject[][]): { uuids: string[]; types: string[] } {
    const uuids = new Set<string>(), types = new Set<string>();
    for (const objects of sides) { const model = buildModel(objects); for (const uuid of model.uuids.keys()) uuids.add(uuid); for (const type of model.types) if (!type.startsWith('cc.')) types.add(type); }
    return { uuids: [...uuids].slice(0, UUID_LIMIT), types: [...types].slice(0, UUID_LIMIT) };
}

export function buildModel(objects: SerializedObject[], options: PrefabDiffOptions = {}): Model {
    const model: Model = { objects, nodes: new Map(), pathOf: new Map(), componentOf: new Map(), uuids: new Map(), types: new Set() };
    const stableId = (object: SerializedObject): string => {
        if (typeof object._id === 'string' && object._id) return 'id:' + object._id;
        const info = isRef(object._prefab) ? objects[object._prefab.__id__] : undefined;
        return info && typeof info.fileId === 'string' && info.fileId ? 'file:' + info.fileId : '';
    };
    const visit = (index: number, parentPath: string | null, siblings: Map<string, number>) => {
        const object = objects[index];
        if (!object || model.pathOf.has(index)) return;
        // A prefab instance root keeps its name in the prefab asset, not in this file: name it after the asset.
        const prefabInfo = isRef(object._prefab) ? objects[object._prefab.__id__] : undefined;
        const assetName = () => { const asset = prefabInfo?.asset; if (!isAssetRef(asset)) return ''; const label = options.labelAsset?.(asset.__uuid__); return label ? label.split('/').pop()!.replace(/\.prefab$/i, '') : ''; };
        const base = typeof object._name === 'string' ? object._name : prefabInfo && isRef(prefabInfo.instance) ? assetName() : '', count = (siblings.get(base) ?? 0) + 1;
        siblings.set(base, count);
        const path = (parentPath === null ? '' : parentPath + '/') + (count > 1 ? base + '#' + count : base);
        model.pathOf.set(index, path);
        const components: NodeEntry['components'] = [], typeCounts = new Map<string, number>();
        for (const ref of Array.isArray(object._components) ? object._components : []) {
            if (!isRef(ref) || !objects[ref.__id__]) continue;
            const type = String(objects[ref.__id__]!.__type__ ?? '?'), n = (typeCounts.get(type) ?? 0) + 1;
            typeCounts.set(type, n);
            const key = n > 1 ? type + '#' + n : type;
            components.push({ index: ref.__id__, type, key }); model.componentOf.set(ref.__id__, { node: path, key }); model.types.add(type);
        }
        // Components added to a prefab instance in the scene live in its PrefabInstance.mountedComponents, not in
        // _components. They are keyed by the target node inside the prefab: the instance root is this node, any other
        // target is shown as <node>/[<localID>] because the prefab's own children are not in this file.
        const mounted: NodeEntry['mounted'] = [], info = isRef(object._prefab) ? objects[object._prefab.__id__] : undefined;
        const instance = info && isRef(info.instance) ? objects[info.instance.__id__] : undefined;
        for (const mountRef of Array.isArray(instance?.mountedComponents) ? instance!.mountedComponents as unknown[] : []) {
            const mount = isRef(mountRef) ? objects[mountRef.__id__] : undefined, targetInfo = mount && isRef(mount.targetInfo) ? objects[mount.targetInfo.__id__] : undefined;
            const target = Array.isArray(targetInfo?.localID) ? (targetInfo!.localID as unknown[]).map(String).join('/') : '?';
            const node = target === info!.fileId ? path : path + '/[' + target + ']', counts = new Map<string, number>();
            for (const ref of Array.isArray(mount?.components) ? mount!.components as unknown[] : []) {
                if (!isRef(ref) || !objects[ref.__id__]) continue;
                const type = String(objects[ref.__id__]!.__type__ ?? '?'), n = (counts.get(type) ?? 0) + 1;
                counts.set(type, n);
                const key = n > 1 ? type + '#' + n : type;
                mounted.push({ index: ref.__id__, type, key, node }); model.componentOf.set(ref.__id__, { node, key }); model.types.add(type);
            }
        }
        model.nodes.set(path, { index, name: base, parent: parentPath, stableId: stableId(object), components, mounted });
        const childSiblings = new Map<string, number>();
        for (const ref of Array.isArray(object._children) ? object._children : []) if (isRef(ref)) visit(ref.__id__, path, childSiblings);
    };
    const rootSiblings = new Map<string, number>();
    objects.forEach((object, index) => { if (object.__type__ && NODE_TYPES.has(object.__type__) && (object._parent === null || object._parent === undefined)) visit(index, null, rootSiblings); });
    const walk = (value: unknown, depth: number) => {
        if (depth > 16 || !value || typeof value !== 'object') return;
        if (isAssetRef(value)) { model.uuids.set(value.__uuid__, (model.uuids.get(value.__uuid__) ?? 0) + 1); return; }
        for (const item of Array.isArray(value) ? value : Object.values(value as object)) walk(item, depth + 1);
    };
    for (const object of objects) walk(object, 0);
    return model;
}

function normalize(model: Model, value: unknown, options: PrefabDiffOptions, depth = 0): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (isRef(value)) {
        const nodePath = model.pathOf.get(value.__id__);
        if (nodePath !== undefined) return 'node:' + nodePath;
        const component = model.componentOf.get(value.__id__);
        if (component) return 'component:' + component.node + '#' + (options.labelType?.(component.key) ?? component.key);
        const target = model.objects[value.__id__];
        return target && depth < 8 ? normalize(model, target, options, depth + 1) : '#' + value.__id__;
    }
    if (isAssetRef(value)) return 'asset:' + (options.labelAsset?.(value.__uuid__) ?? value.__uuid__);
    if (depth > 8) return t('common.prefabDeepObject');
    if (Array.isArray(value)) return value.map(item => normalize(model, item, options, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) if (key !== '__id__' && key !== '__editorExtras__') out[key] = normalize(model, item, options, depth + 1);
    return out;
}
// Prefab instance overrides and mounted children are flattened to one entry per target so a changed
// override reads as a property change instead of one opaque blob.
function prefabEntries(model: Model, object: SerializedObject, options: PrefabDiffOptions): Map<string, unknown> {
    const entries = new Map<string, unknown>();
    const info = isRef(object._prefab) ? model.objects[object._prefab.__id__] : undefined;
    if (!info) return entries;
    if (isAssetRef(info.asset)) entries.set('prefab.asset', normalize(model, info.asset, options));
    if (typeof info.fileId === 'string') entries.set('prefab.fileId', info.fileId);
    const instance = isRef(info.instance) ? model.objects[info.instance.__id__] : undefined;
    if (!instance) return entries;
    const target = (ref: unknown) => { const target = isRef(ref) ? model.objects[ref.__id__] : undefined; return Array.isArray(target?.localID) ? (target!.localID as unknown[]).map(String).join('/') : '?'; };
    for (const ref of Array.isArray(instance.propertyOverrides) ? instance.propertyOverrides : []) {
        const override = isRef(ref) ? model.objects[ref.__id__] : undefined;
        if (!override) continue;
        entries.set('override:' + target(override.targetInfo) + ':' + (Array.isArray(override.propertyPath) ? override.propertyPath.join('.') : '?'), normalize(model, override.value, options));
    }
    for (const ref of Array.isArray(instance.mountedChildren) ? instance.mountedChildren : []) {
        const mounted = isRef(ref) ? model.objects[ref.__id__] : undefined;
        if (!mounted) continue;
        entries.set('mounted:' + target(mounted.targetInfo), normalize(model, mounted.nodes, options));
    }
    return entries;
}
const clip = (value: unknown): unknown => { const text = JSON.stringify(value) ?? 'undefined'; return text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) + '…' : value; };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function diffSerialized(leftObjects: SerializedObject[], rightObjects: SerializedObject[], options: PrefabDiffOptions = {}): PrefabDiff {
    const left = buildModel(leftObjects, options), right = buildModel(rightObjects, options), limit = Math.max(1, options.limit ?? 200);
    const label = (type: string) => options.labelType?.(type) ?? type;
    const nodes: NodeChange[] = [], components: ComponentChange[] = [], properties: PropertyChange[] = [];
    let truncated = false;
    const push = (change: PropertyChange) => { if (properties.length >= limit) { truncated = true; return; } properties.push(change); };
    // Pair nodes by path first, then by stable id (scene node id or prefab fileId) for moved or renamed nodes.
    const pairs = new Map<string, string>(), usedLeft = new Set<string>();
    for (const path of right.nodes.keys()) if (left.nodes.has(path)) { pairs.set(path, path); usedLeft.add(path); }
    const leftById = new Map<string, string>();
    for (const [path, entry] of left.nodes) if (entry.stableId && !usedLeft.has(path)) leftById.set(entry.stableId, path);
    for (const [path, entry] of right.nodes) {
        if (pairs.has(path) || !entry.stableId) continue;
        const from = leftById.get(entry.stableId);
        if (from === undefined || usedLeft.has(from)) continue;
        pairs.set(path, from); usedLeft.add(from);
        const fromEntry = left.nodes.get(from)!;
        nodes.push({ kind: fromEntry.parent === entry.parent || (fromEntry.parent !== null && entry.parent !== null && pairs.get(entry.parent) === fromEntry.parent) ? 'renamed' : 'moved', path, from });
    }
    for (const path of right.nodes.keys()) if (!pairs.has(path)) { nodes.push({ kind: 'added', path }); const entry = right.nodes.get(path)!; for (const component of [...entry.components.map(item => ({ ...item, node: path })), ...entry.mounted]) components.push({ kind: 'added', node: component.node, type: label(component.type) }); }
    for (const path of left.nodes.keys()) if (!usedLeft.has(path)) { nodes.push({ kind: 'removed', path }); const entry = left.nodes.get(path)!; for (const component of [...entry.components.map(item => ({ ...item, node: path })), ...entry.mounted]) components.push({ kind: 'removed', node: component.node, type: label(component.type) }); }
    for (const [rightPath, leftPath] of pairs) {
        const a = left.objects[left.nodes.get(leftPath)!.index]!, b = right.objects[right.nodes.get(rightPath)!.index]!;
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
            if (SKIP_NODE.has(key)) continue;
            const before = normalize(left, a[key], options), after = normalize(right, b[key], options);
            if (!same(before, after)) push({ node: rightPath, property: key, before: clip(before), after: clip(after) });
        }
        const prefabBefore = prefabEntries(left, a, options), prefabAfter = prefabEntries(right, b, options);
        for (const key of new Set([...prefabBefore.keys(), ...prefabAfter.keys()])) if (!same(prefabBefore.get(key), prefabAfter.get(key))) push({ node: rightPath, property: key, before: clip(prefabBefore.get(key)), after: clip(prefabAfter.get(key)) });
        const leftComponents = new Map(left.nodes.get(leftPath)!.components.map(item => [item.key, item])), rightComponents = new Map(right.nodes.get(rightPath)!.components.map(item => [item.key, item]));
        for (const [key, component] of rightComponents) if (!leftComponents.has(key)) components.push({ kind: 'added', node: rightPath, type: label(component.type) });
        for (const [key, component] of leftComponents) if (!rightComponents.has(key)) components.push({ kind: 'removed', node: rightPath, type: label(component.type) });
        const compare = (c: SerializedObject, d: SerializedObject, node: string, key: string) => {
            for (const field of new Set([...Object.keys(c), ...Object.keys(d)])) {
                if (SKIP_COMPONENT.has(field)) continue;
                const before = normalize(left, c[field], options), after = normalize(right, d[field], options);
                if (!same(before, after)) push({ node, component: label(key), property: field, before: clip(before), after: clip(after) });
            }
        };
        for (const [key, component] of rightComponents) {
            const other = leftComponents.get(key); if (!other) continue;
            compare(left.objects[other.index]!, right.objects[component.index]!, rightPath, component.key);
        }
        // Mounted components pair by target node and type; the target is relative to the instance, so it survives a rename.
        const mountKey = (path: string, item: NodeEntry['mounted'][number]) => (item.node === path ? '' : item.node.slice(path.length)) + '|' + item.key;
        const leftMounted = new Map(left.nodes.get(leftPath)!.mounted.map(item => [mountKey(leftPath, item), item])), rightMounted = new Map(right.nodes.get(rightPath)!.mounted.map(item => [mountKey(rightPath, item), item]));
        for (const [key, item] of rightMounted) {
            const other = leftMounted.get(key);
            if (!other) components.push({ kind: 'added', node: item.node, type: label(item.type) });
            else compare(left.objects[other.index]!, right.objects[item.index]!, item.node, item.key);
        }
        for (const [key, item] of leftMounted) if (!rightMounted.has(key)) components.push({ kind: 'removed', node: rightPath + item.node.slice(leftPath.length), type: label(item.type) });
    }
    const assets: AssetUse[] = [];
    for (const uuid of new Set([...left.uuids.keys(), ...right.uuids.keys()])) {
        const before = left.uuids.get(uuid) ?? 0, after = right.uuids.get(uuid) ?? 0;
        if (before !== after) assets.push({ uuid, ...(options.labelAsset?.(uuid) ? { label: options.labelAsset(uuid) } : {}), before, after });
    }
    assets.sort((a, b) => a.uuid.localeCompare(b.uuid));
    const count = (kind: NodeChange['kind']) => nodes.filter(item => item.kind === kind).length;
    const summary = t('common.prefabDiffSummary', { added: count('added'), removed: count('removed'), moved: count('moved'), renamed: count('renamed'),
        componentsAdded: components.filter(item => item.kind === 'added').length, componentsRemoved: components.filter(item => item.kind === 'removed').length,
        properties: properties.length, more: truncated ? '+' : '', assets: assets.length });
    return { left: { nodes: left.nodes.size, components: left.componentOf.size }, right: { nodes: right.nodes.size, components: right.componentOf.size }, nodes, components, properties, assets, truncated, summary };
}
