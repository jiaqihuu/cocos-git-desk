import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { BigIntStats } from 'node:fs';
import { t, MessageError } from './i18n';

export type EditorFileAction = 'describe' | 'reveal' | 'open';
export interface EditorFileResult {
    file: string;
    asset: string;
    uuid?: string;
    url?: string;
    canReveal: boolean;
    canOpen: boolean;
    reason?: string;
    revealRequested?: boolean;
    openRequested?: boolean;
}
export type EditorRequest = <T = unknown>(channel: string, message: string, ...args: unknown[]) => Promise<T>;

interface LocalAsset {
    asset: string;
    directory: boolean;
    identity: string;
}
interface AssetInfo {
    uuid: string;
    url: string;
    file: string;
    isDirectory: boolean;
    imported: boolean;
    invalid: boolean;
}

function inside(root: string, file: string): boolean {
    const relative = path.relative(root, file);
    return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function localAsset(project: string, file: string): Promise<LocalAsset> {
    if (typeof project !== 'string' || typeof file !== 'string' || !path.isAbsolute(project) || !path.isAbsolute(file) || project.includes('\0') || file.includes('\0')) {
        throw new MessageError('creator.tools.invalidFilePath');
    }
    const projectRoot = await fs.realpath(project), lexicalAssets = path.join(path.resolve(project), 'assets');
    const projectAssets = path.join(projectRoot, 'assets');
    const root = await fs.realpath(projectAssets);
    if (root !== projectAssets || !(await fs.stat(root)).isDirectory()) throw new MessageError('creator.tools.assetsDirInvalid');
    const resolvedFile = path.resolve(file);
    if (!inside(lexicalAssets, resolvedFile) && !inside(projectAssets, resolvedFile)) throw new MessageError('creator.tools.assetsOnly');
    const realFile = await fs.realpath(resolvedFile), fileStat = await fs.stat(realFile, { bigint: true });
    if (!inside(root, realFile) || (!fileStat.isFile() && !fileStat.isDirectory())) throw new MessageError('creator.tools.notAssetFile');
    const mapped = resolvedFile.endsWith('.meta') ? resolvedFile.slice(0, -5) : resolvedFile;
    let asset: string;
    try { asset = await fs.realpath(mapped); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && mapped !== resolvedFile) throw new MessageError('creator.tools.metaAssetGone');
        throw error;
    }
    const stat = await fs.stat(asset, { bigint: true });
    if (!inside(root, asset) || (!stat.isFile() && !stat.isDirectory())) throw new MessageError('creator.tools.metaAssetNotFile');
    // dev + ino identify a file on POSIX; some Windows volumes (ReFS, Dev Drive) report file ids that repeat, so a
    // replaced file is also recognised by its creation time, modification time and size.
    const mark = (s: BigIntStats) => s.isFile() ? [s.dev, s.ino, s.birthtimeNs, s.mtimeNs, s.size] : [s.dev, s.ino];
    return { asset, directory: stat.isDirectory(), identity: [realFile, ...mark(fileStat), asset, ...mark(stat)].join('\0') };
}

function assetInfo(value: unknown): value is AssetInfo {
    if (!value || typeof value !== 'object') return false;
    const item = value as Record<string, unknown>;
    return typeof item.uuid === 'string' && !!item.uuid && !item.uuid.includes('\0')
        && typeof item.url === 'string' && item.url.startsWith('db://assets/') && !item.url.includes('\0')
        && typeof item.file === 'string' && path.isAbsolute(item.file) && !item.file.includes('\0')
        && typeof item.isDirectory === 'boolean' && typeof item.imported === 'boolean' && typeof item.invalid === 'boolean';
}

async function openBlocker(request: EditorRequest): Promise<string | undefined> {
    try {
        const dirty = await request('scene', 'query-dirty');
        if (typeof dirty !== 'boolean') return t('creator.tools.sceneStateUnknown');
        if (dirty) return t('creator.tools.sceneUnsaved');
        const scenes = await request('scene', 'multi-scene-query');
        if (!Array.isArray(scenes)) return t('creator.tools.tabsStateUnknown');
        if (scenes.some(scene => !scene || typeof scene !== 'object' || typeof scene.dirty !== 'boolean' || scene.dirty)) {
            return t('creator.tools.tabsUnsaved');
        }
        // Prefab mode can hide a dirty underlying scene from both queries in Creator 3.8.8.
        if (scenes.some(scene => scene.type !== 'scene')) return t('creator.tools.exitPrefabFirst');
        return undefined;
    } catch (error) { return t('creator.tools.editorStateFailed', { error: errorText(error) }); }
}

export async function editorFile(project: string, file: string, action: EditorFileAction, request: EditorRequest): Promise<EditorFileResult> {
    if (!['describe', 'reveal', 'open'].includes(action)) throw new MessageError('creator.tools.unsupportedFileAction');
    if (typeof file !== 'string') throw new MessageError('creator.tools.invalidFilePath');
    const result: EditorFileResult = { file, asset: file.endsWith('.meta') ? file.slice(0, -5) : file, canReveal: false, canOpen: false };
    let local: LocalAsset;
    try { local = await localAsset(project, file); result.asset = local.asset; }
    catch (error) { result.reason = t('creator.tools.cannotLocateWorktreeAsset', { error: errorText(error) }); return result; }
    let info: unknown;
    try {
        info = await request('asset-db', 'query-asset-info', local.asset, ['uuid', 'url', 'file', 'isDirectory', 'imported', 'invalid']);
    } catch (error) { result.reason = t('creator.tools.assetDbReadFailed', { error: errorText(error) }); return result; }
    if (info === null) { result.reason = t('creator.tools.notInAssetDb'); return result; }
    if (!assetInfo(info)) { result.reason = t('creator.tools.assetInfoIncomplete'); return result; }
    try {
        const infoLocal = await localAsset(project, info.file);
        if (await fs.realpath(info.file) !== local.asset || infoLocal.asset !== local.asset || infoLocal.directory !== local.directory || info.isDirectory !== local.directory) {
            result.reason = t('creator.tools.assetDbMismatch'); return result;
        }
    } catch (error) { result.reason = t('creator.tools.assetDbFileInvalid', { error: errorText(error) }); return result; }
    result.uuid = info.uuid; result.url = info.url; result.canReveal = true;
    if (local.directory) result.reason = t('creator.tools.folderRevealOnly');
    else if (!info.imported || info.invalid) result.reason = t('creator.tools.notImported');
    else result.reason = await openBlocker(request);
    result.canOpen = !result.reason;
    if (action === 'describe' || (action === 'open' && !result.canOpen)) return result;
    try {
        const current = await localAsset(project, file);
        if (current.identity !== local.identity) {
            return { ...result, canReveal: false, canOpen: false, reason: t('creator.tools.fileReplaced') };
        }
        if (action === 'reveal') {
            const response = await request('assets', 'twinkle', info.uuid);
            if (response !== undefined) return { ...result, reason: t('creator.tools.revealUnconfirmed') };
            result.revealRequested = true;
        } else {
            // open-asset delegates scene, prefab and script handling to Creator's registered importers.
            const response = await request('asset-db', 'open-asset', info.uuid);
            if (response !== undefined) return { ...result, reason: t('creator.tools.openUnconfirmed') };
            result.openRequested = true;
        }
    } catch (error) { result.reason = t('creator.tools.requestUnconfirmed', { action: (action === 'reveal' ? t('creator.tools.actionReveal') : t('creator.tools.actionOpen')), error: errorText(error) }); }
    return result;
}
