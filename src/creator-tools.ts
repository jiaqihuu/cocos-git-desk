import { execFile } from 'child_process';
import path from 'path';
import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import { assetUuid, locateRuntimeAsset } from './runtime-inspector-assets';
import { readEditorState } from './editor-preparation';
import { validateToolArgs } from './preview-debug';
import type { LogQuery } from './extension-log';
import { SceneTools, sceneToolNames } from './scene-tools';
import { parseSerialized, diffSerialized, collectReferences, decompressUuid, compressUuid } from './prefab-diff';
import { t, MessageError } from './i18n';
export { compressUuid };

export interface TypecheckResult { command: string; exitCode: number | null; output: string; elapsedMs: number; timedOut: boolean; }
export interface CreatorHost {
    project: string;
    request<T = unknown>(channel: string, message: string, ...args: unknown[]): Promise<T>;
    selectAsset(uuid: string): void;
    // Throws while a Git operation runs: editor navigation and asset-db refreshes must not race it.
    assertIdle(): void;
    gitRunning(): boolean;
    profile(pkg: string, key: string, scope: string): Promise<unknown>;
    hasPanel(name: string): Promise<boolean>;
    openDebugPreview(): Promise<string>;
    typecheck?(): Promise<TypecheckResult>;
    log(query: LogQuery): unknown;
    // Paths recorded for a Git Desk task (project-relative, POSIX); null when the task is unknown.
    taskPaths(taskId: string): Promise<string[] | null>;
    // PNG of the editor window, or of one panel (by panel name) when the host can locate it.
    capture?(options: { panel?: string }): Promise<CaptureResult>;
    // Asks Creator to reload an extension package; the reload happens after the reply is sent.
    reloadExtension?(name: string): Promise<{ name: string; scheduled: boolean; delayMs: number }>;
    // Asset/.meta consistency of the staged (index) or on-disk (worktree) changes, from Git Desk.
    metaCheck?(options: { scope: 'index' | 'worktree'; paths?: string[] }): Promise<unknown>;
    // Text of a project file on disk ('worktree'), in the index ('index') or at a Git revision; null when absent.
    fileAt?(name: string, revision: string): Promise<string | null>;
    // Language-key audit from Git Desk (usages, fallback json coverage, history, CSV draft).
    languageKeys?(options: Record<string, unknown>): Promise<unknown>;
}
export interface CaptureResult { png: Buffer; title: string; bounds: { x: number; y: number; width: number; height: number }; scale: number; }
const writeLimit = 8 * 1024 * 1024, hashLimit = 32 * 1024 * 1024;
// Read-only Creator messages reachable through creator_message, by channel (Creator 3.8 names).
export const messageAllowlist: Record<string, string[]> = {
    'asset-db': ['query-ready', 'query-uuid', 'query-path', 'query-url', 'query-asset-info', 'query-asset-meta', 'query-assets', 'query-asset-users', 'query-asset-mtime', 'refresh-asset', 'open-asset'],
    scene: ['query-is-ready', 'query-dirty', 'query-current-scene', 'multi-scene-query', 'query-node', 'query-node-tree', 'query-nodes-by-asset-uuid', 'query-component', 'query-components', 'query-classes', 'query-component-has-script'],
    preview: ['query-preview-url'],
    project: ['query-config'],
    engine: ['query-info', 'query-engine-info'],
    assets: ['twinkle'],
};
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
// Creator stores some references in the 22-character compressed form; both spellings are searched.
// compressUuid lives in prefab-diff.ts; creator_asset_users searches both Creator forms.
interface ToolSchema { name: string; inputSchema: { properties: Record<string, any>; required?: string[] }; }
interface AssetInfo { uuid: string; url: string; file?: string; type?: string; name?: string; invalid?: boolean; isDirectory?: boolean; importer?: string; }
const infoFields = ['uuid', 'url', 'file', 'type', 'name', 'invalid', 'isDirectory', 'importer'];
const diagnosticLine = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;

// Editor-side basics the AI needs around Git and runtime debugging, hosted in the same MCP so
// the workflow does not depend on a second editor MCP being online. Reads use the asset-db and
// scene queries the extension already relies on; writes are narrow and never save or discard edits.
export class CreatorTools {
    private scene: SceneTools;
    constructor(private host: CreatorHost, private schemas: ToolSchema[]) { this.scene = new SceneTools(host, schemas); }
    async call(name: string, input: unknown): Promise<unknown> {
        if (sceneToolNames.has(name)) return this.scene.call(name, input);
        const args = validateToolArgs(this.schemas.find(tool => tool.name === name), input);
        switch (name) {
            case 'creator_asset_query': return this.assetQuery(args);
            case 'creator_asset_open': return this.assetOpen(args);
            case 'creator_asset_reveal': return this.assetReveal(args);
            case 'creator_assets_refresh': return this.refresh(args);
            case 'creator_editor_state': return this.editorState();
            case 'creator_script_diagnostics': return this.diagnostics(args);
            case 'creator_preview': return this.preview(args);
            case 'creator_extension_log': return this.host.log(args as LogQuery);
            case 'creator_asset_write': return this.assetWrite(args);
            case 'creator_asset_delete': return this.assetDelete(args);
            case 'creator_asset_meta': return this.assetMeta(args);
            case 'creator_asset_users': return this.assetUsers(args);
            case 'creator_project_log': return this.projectLog(args);
            case 'creator_screenshot': return this.screenshot(args);
            case 'creator_reload_extension': return this.reload(args);
            case 'creator_message': return this.message(args);
            case 'creator_meta_check': return this.metaCheck(args);
            case 'creator_prefab_diff': return this.prefabDiff(args);
            case 'creator_language_keys': return this.languageKeys(args);
            default: throw new MessageError('creator.tools.unknownTool', { name });
        }
    }
    // uuid, db:// url or a file path all resolve through asset-db; names go through a bounded glob search.
    private async resolveUuid(args: Record<string, unknown>): Promise<string> {
        if (typeof args.uuid === 'string') return assetUuid(args.uuid);
        const locator = typeof args.url === 'string' ? args.url : typeof args.path === 'string' ? args.path : '';
        if (!locator) throw new MessageError('creator.tools.needLocator');
        if (locator.startsWith('db://') === false && !path.isAbsolute(locator) && locator.includes('..')) throw new MessageError('creator.tools.noDotDot');
        const target = locator.startsWith('db://') || path.isAbsolute(locator) ? locator : path.join(this.host.project, locator);
        const uuid = await this.host.request<unknown>('asset-db', 'query-uuid', target);
        if (typeof uuid !== 'string' || !uuid) throw new MessageError('creator.tools.assetNotFound', { locator });
        return assetUuid(uuid);
    }
    private async info(uuid: string): Promise<AssetInfo> {
        const info = await this.host.request<AssetInfo | null>('asset-db', 'query-asset-info', uuid, infoFields);
        if (!info || typeof info.uuid !== 'string' || typeof info.url !== 'string') throw new MessageError('creator.tools.assetNotFound', { locator: uuid });
        return info;
    }
    private async assetQuery(args: Record<string, unknown>): Promise<unknown> {
        if (typeof args.name === 'string') {
            const limit = typeof args.limit === 'number' ? args.limit : 50;
            const options: Record<string, unknown> = { pattern: 'db://assets/**/*' + args.name + '*' };
            if (typeof args.type === 'string') options.ccType = args.type;
            const list = await this.host.request<AssetInfo[] | null>('asset-db', 'query-assets', options);
            const assets = (Array.isArray(list) ? list : []).filter(item => item && typeof item.uuid === 'string' && typeof item.url === 'string');
            return { query: options, total: assets.length, truncated: assets.length > limit,
                assets: assets.slice(0, limit).map(item => ({ uuid: item.uuid, url: item.url, type: item.type ?? null, name: item.name ?? path.basename(item.url) })) };
        }
        const uuid = await this.resolveUuid(args);
        const info = await this.info(uuid);
        return { uuid: info.uuid, url: info.url, file: info.file ?? null, type: info.type ?? null, name: info.name ?? path.basename(info.url), importer: info.importer ?? null, invalid: info.invalid === true, isDirectory: info.isDirectory === true,
            sha256: info.isDirectory ? null : await this.fileHash(info.url) };
    }
    private async assetOpen(args: Record<string, unknown>): Promise<unknown> {
        this.host.assertIdle();
        const uuid = await this.resolveUuid(args);
        const info = await this.info(uuid);
        if (info.invalid) throw new MessageError('creator.tools.assetInvalid', { url: info.url });
        if (info.isDirectory) throw new MessageError('creator.tools.cannotOpenDirectory', { url: info.url });
        // Scripts open in the external editor, scenes and prefabs in the scene editor; Creator owns any unsaved-change prompt.
        await this.host.request('asset-db', 'open-asset', info.uuid);
        const kind = /\.(ts|js)$/i.test(info.url) ? 'script' : /\.prefab$/i.test(info.url) ? 'prefab' : /\.scene$/i.test(info.url) ? 'scene' : 'asset';
        return { uuid: info.uuid, url: info.url, kind, message: kind === 'script' ? t('creator.tools.openedScript') : kind === 'asset' ? t('creator.tools.openedAsset') : t('creator.tools.openedScene') };
    }
    private async assetReveal(args: Record<string, unknown>): Promise<unknown> {
        this.host.assertIdle();
        const uuid = await this.resolveUuid(args);
        const message = await locateRuntimeAsset(uuid, 'reveal', (channel, msg, ...rest) => this.host.request(channel, msg, ...rest), id => this.host.selectAsset(id));
        return { uuid, message };
    }
    // db://assets/... <-> assets/... (POSIX, project-relative); absolute paths must lie inside the project.
    private relative(url: string): string {
        let rel = url;
        if (url.startsWith('db://')) rel = url.slice('db://'.length);
        else if (path.isAbsolute(url)) { rel = path.relative(this.host.project, url).split(path.sep).join('/'); if (rel.startsWith('..')) throw new MessageError('creator.tools.pathOutsideProject', { url }); }
        rel = rel.replace(/\\/g, '/').replace(/^\.\//, '');
        if (rel.includes('..') || !/^(assets|internal)(\/|$)/.test(rel)) throw new MessageError('creator.tools.pathNotAssets', { url });
        return rel;
    }
    private dbUrl(url: string): string { return 'db://' + this.relative(url); }
    private async fileHash(url: string): Promise<string | null> {
        try {
            const file = path.join(this.host.project, this.relative(url));
            const stat = await fs.stat(file);
            if (!stat.isFile() || stat.size > hashLimit) return null;
            return sha256(await fs.readFile(file));
        } catch { return null; }
    }
    private async requireScope(taskId: unknown, rel: string): Promise<void> {
        if (typeof taskId !== 'string' || !taskId) throw new MessageError('creator.tools.taskIdRequired');
        const paths = await this.host.taskPaths(taskId);
        if (!paths) throw new MessageError('creator.tools.taskNotFound', { taskId });
        if (!paths.includes(rel)) throw new MessageError('creator.tools.outsideTaskScope', { rel });
    }
    // Serialized scenes and prefabs must parse and may only reference assets that exist; nothing is written otherwise.
    private async validateSerialized(rel: string, content: string): Promise<{ references: number }> {
        if (!/\.(prefab|scene)$/i.test(rel)) return { references: 0 };
        let data: unknown;
        try { data = JSON.parse(content); } catch (error) { throw new MessageError('creator.tools.invalidJson', { message: (error instanceof Error ? error.message : String(error)) }); }
        if (!Array.isArray(data) || !data.length || typeof (data[0] as { __type__?: unknown })?.__type__ !== 'string') throw new MessageError('creator.tools.notSerialized');
        const refs = new Set<string>();
        for (const match of content.matchAll(/"__uuid__"\s*:\s*"([^"]+)"/g)) refs.add(match[1]!);
        if (refs.size > 500) throw new MessageError('creator.tools.tooManyReferences');
        const missing: string[] = [];
        for (const ref of refs) {
            let id: string;
            try { id = assetUuid(ref); } catch { missing.push(ref); continue; }
            const info = await this.host.request<AssetInfo | null>('asset-db', 'query-asset-info', id.split('@')[0]!, ['uuid', 'url']);
            if (!info || typeof info.uuid !== 'string') missing.push(ref);
        }
        if (missing.length) throw new MessageError('creator.tools.missingReferences', { count: missing.length, list: missing.slice(0, 10).join(t('creator.tools.listSeparator')) });
        return { references: refs.size };
    }
    private async assetWrite(args: Record<string, unknown>): Promise<unknown> {
        this.host.assertIdle();
        const url = this.dbUrl(String(args.url)), rel = this.relative(url);
        if (/\.meta$/i.test(rel)) throw new MessageError('creator.tools.metaUseMetaTool');
        const content = String(args.content ?? '');
        if (Buffer.byteLength(content) > writeLimit) throw new MessageError('creator.tools.contentTooLarge');
        await this.requireScope(args.taskId, rel);
        const existing = await this.host.request<unknown>('asset-db', 'query-uuid', url);
        const exists = typeof existing === 'string' && !!existing;
        if (exists && args.create === true) throw new MessageError('creator.tools.assetExists', { url });
        if (!exists && args.create !== true) throw new MessageError('creator.tools.assetMissingCreate', { url });
        if (exists) {
            const current = await this.fileHash(url);
            if (typeof args.expectedSha256 !== 'string') throw new MessageError('creator.tools.expectedShaRequired');
            if (current !== args.expectedSha256) throw new MessageError('creator.tools.fileModified', { current });
        }
        const validation = await this.validateSerialized(rel, content);
        await this.host.request('asset-db', exists ? 'save-asset' : 'create-asset', url, content);
        const info = await this.host.request<AssetInfo | null>('asset-db', 'query-asset-info', url, infoFields);
        return { url, uuid: info?.uuid ?? null, created: !exists, bytes: Buffer.byteLength(content), sha256: await this.fileHash(url), references: validation.references, invalid: info?.invalid === true,
            note: t('creator.tools.reimportedNote') };
    }
    private async assetDelete(args: Record<string, unknown>): Promise<unknown> {
        this.host.assertIdle();
        const url = this.dbUrl(String(args.url)), rel = this.relative(url);
        await this.requireScope(args.taskId, rel);
        const uuid = await this.resolveUuid({ url });
        const info = await this.info(uuid);
        if (info.isDirectory) throw new MessageError('creator.tools.cannotDeleteDirectory', { url: info.url });
        await this.host.request('asset-db', 'delete-asset', info.url);
        return { url: info.url, uuid: info.uuid, deleted: true, note: t('creator.tools.deletedNote') };
    }
    private async assetMeta(args: Record<string, unknown>): Promise<unknown> {
        const url = this.dbUrl(String(args.url)), rel = this.relative(url);
        const uuid = await this.resolveUuid({ url });
        if (args.meta === undefined) return { url, uuid, meta: await this.host.request<unknown>('asset-db', 'query-asset-meta', uuid) };
        this.host.assertIdle();
        await this.requireScope(args.taskId, rel);
        if (!args.meta || typeof args.meta !== 'object' || Array.isArray(args.meta)) throw new MessageError('creator.tools.metaMustBeObject');
        await this.host.request('asset-db', 'save-asset-meta', uuid, JSON.stringify(args.meta, null, 2));
        return { url, uuid, meta: await this.host.request<unknown>('asset-db', 'query-asset-meta', uuid), saved: true };
    }
    // Who references an asset: Creator's query first, else a bounded text scan of scenes and prefabs.
    private async assetUsers(args: Record<string, unknown>): Promise<unknown> {
        const uuid = await this.resolveUuid(args);
        const limit = typeof args.limit === 'number' ? args.limit : 100;
        const plain = uuid.split('@')[0]!;
        try {
            const users = await this.host.request<unknown>('asset-db', 'query-asset-users', plain, 'all');
            if (Array.isArray(users)) return { uuid, source: 'asset-db', total: users.length, users: users.slice(0, limit) };
        } catch { /* fall through to the scan */ }
        const needles = [plain, compressUuid(plain), compressUuid(plain, true)];
        const users: Array<{ url: string; count: number }> = [];
        let scanned = 0;
        const root = path.join(this.host.project, 'assets');
        const walk = async (directory: string): Promise<void> => {
            for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
                if (scanned >= 5000 || users.length >= limit) return;
                const full = path.join(directory, entry.name);
                if (entry.isDirectory()) { await walk(full); continue; }
                if (!/\.(prefab|scene|anim|mtl|fire)$/i.test(entry.name)) continue;
                scanned++;
                const stat = await fs.stat(full); if (stat.size > 16 * 1024 * 1024) continue;
                const text = await fs.readFile(full, 'utf8');
                const count = needles.reduce((sum, needle) => sum + text.split(needle).length - 1, 0);
                if (count) users.push({ url: 'db://' + path.relative(this.host.project, full).split(path.sep).join('/'), count });
            }
        };
        await walk(root);
        return { uuid, source: 'scan', scanned, truncated: scanned >= 5000 || users.length >= limit, total: users.length, users };
    }
    private async projectLog(args: Record<string, unknown>): Promise<unknown> {
        const file = path.join(this.host.project, 'temp', 'logs', 'project.log');
        let stat; try { stat = await fs.stat(file); } catch { throw new MessageError('creator.tools.projectLogMissing', { file }); }
        const window = 4 * 1024 * 1024, start = Math.max(0, stat.size - window);
        const handle = await fs.open(file, 'r');
        let text: string;
        try { const buffer = Buffer.alloc(stat.size - start); await handle.read(buffer, 0, buffer.length, start); text = buffer.toString('utf8'); } finally { await handle.close(); }
        const lines = text.split(/\r?\n/); if (start > 0) lines.shift(); if (lines.length && lines[lines.length - 1] === '') lines.pop();
        const limit = typeof args.limit === 'number' ? args.limit : 50;
        const query = typeof args.query === 'string' ? args.query : '';
        let matcher: (line: string) => boolean = () => true;
        if (query) {
            if (args.regex === true) { let re: RegExp; try { re = new RegExp(query, 'i'); } catch (error) { throw new MessageError('creator.tools.invalidRegex', { message: (error instanceof Error ? error.message : String(error)) }); } matcher = line => re.test(line); }
            else { const needle = query.toLowerCase(); matcher = line => line.toLowerCase().includes(needle); }
        }
        const matches: Array<{ line: number; text: string }> = [];
        const offset = start > 0 ? -1 : 0;
        lines.forEach((line, index) => { if (matcher(line)) matches.push({ line: index + 1 + offset, text: line.slice(0, 1000) }); });
        return { file, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), windowBytes: Math.min(window, stat.size), matching: matches.length, truncated: matches.length > limit, entries: matches.slice(-limit),
            note: start > 0 ? t('creator.tools.logTailNote') : '' };
    }
    private async refresh(args: Record<string, unknown>): Promise<unknown> {
        this.host.assertIdle();
        const url = typeof args.url === 'string' ? this.dbUrl(args.url) : 'db://assets';
        if (!/^db:\/\/(assets|internal)(\/|$)/.test(url)) throw new MessageError('creator.tools.refreshPathScope');
        await this.host.request('asset-db', 'refresh-asset', url);
        const ready = await this.host.request<unknown>('asset-db', 'query-ready');
        return { refreshed: url, ready: ready === true };
    }
    private async editorState(): Promise<unknown> {
        const state = await readEditorState((channel, message, ...args) => this.host.request(channel, message, ...args));
        const current = await this.host.request<unknown>('scene', 'query-current-scene');
        const ready = await this.host.request<unknown>('asset-db', 'query-ready');
        let currentUrl: string | null = null;
        if (typeof current === 'string' && current) { try { currentUrl = (await this.info(assetUuid(current))).url; } catch { currentUrl = null; } }
        return { project: this.host.project, dirty: state.dirty, prefabMode: state.scenes.some(scene => scene.type === 'prefab'),
            current: typeof current === 'string' ? current : null, currentUrl, scenes: state.scenes, assetDbReady: ready === true, gitRunning: this.host.gitRunning(),
            note: t('creator.tools.editorStateNote') };
    }
    private async diagnostics(args: Record<string, unknown>): Promise<unknown> {
        const limit = typeof args.limit === 'number' ? args.limit : 50;
        const result = await (this.host.typecheck ?? (() => runTsc(this.host.project)))();
        const diagnostics: Array<{ file: string; line: number; column: number; severity: string; code: string; message: string }> = [];
        for (const line of result.output.split(/\r?\n/)) {
            const match = diagnosticLine.exec(line.trim());
            if (match) diagnostics.push({ file: match[1]!, line: Number(match[2]), column: Number(match[3]), severity: match[4]!, code: match[5]!, message: match[6]!.slice(0, 500) });
        }
        const errors = diagnostics.filter(item => item.severity === 'error');
        return { command: result.command, exitCode: result.exitCode, timedOut: result.timedOut, elapsedMs: result.elapsedMs, errorCount: errors.length, diagnosticCount: diagnostics.length,
            truncated: diagnostics.length > limit, diagnostics: diagnostics.slice(0, limit),
            unparsed: result.exitCode !== 0 && diagnostics.length === 0 ? result.output.slice(0, 2000) : '',
            note: t('creator.tools.diagnosticsNote') };
    }
    private async preview(args: Record<string, unknown>): Promise<unknown> {
        const action = typeof args.action === 'string' ? args.action : 'status';
        if (action === 'open') { this.host.assertIdle(); return { opened: true, message: await this.host.openDebugPreview(), ...(await this.previewStatus()) }; }
        return this.previewStatus();
    }
    private async previewStatus(): Promise<Record<string, unknown>> {
        let mode: string | null = null, modeError = '';
        try { const value = await this.host.profile('preview', 'preview.current.platform', 'local'); mode = typeof value === 'string' && value ? value : 'browser'; }
        catch (error) { modeError = error instanceof Error ? error.message : String(error); }
        let url: string | null = null, urlError = '';
        try { const value = await this.host.request<unknown>('preview', 'query-preview-url'); url = typeof value === 'string' && value ? value : null; }
        catch (error) { urlError = error instanceof Error ? error.message : String(error); }
        return { mode, modeError, url, urlError, debugPreviewOpen: await this.host.hasPanel('cocos-git-desk.debug-preview'),
            note: t('creator.tools.previewNote') };
    }
    // Screenshots go under the extension's own .cache (ignored by Git), never into temp/ or assets/.
    private async screenshot(args: Record<string, unknown>): Promise<unknown> {
        if (!this.host.capture) throw new MessageError('creator.tools.screenshotUnsupported');
        const panel = typeof args.panel === 'string' ? args.panel : undefined;
        const name = typeof args.fileName === 'string' ? args.fileName : (panel ? 'panel-' + panel.replace(/[^\w.-]+/g, '_') : 'editor') + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png';
        if (!/^[\w.-]+\.png$/i.test(name) || name.startsWith('.')) throw new MessageError('creator.tools.pngFileName');
        const shot = await this.host.capture({ panel });
        const directory = path.join(this.host.project, 'extensions', 'cocos-git-desk', '.cache', 'captures');
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const file = path.join(directory, name);
        await fs.writeFile(file, shot.png, { mode: 0o600 });
        return { file, bytes: shot.png.length, title: shot.title, bounds: shot.bounds, scale: shot.scale, panel: panel ?? null,
            note: t('creator.tools.screenshotNote') };
    }
    // The general read channel into Creator: only query-style messages that cannot change the project.
    // Writes keep going through the dedicated tools, which carry task scope and validation.
    private async message(args: Record<string, unknown>): Promise<unknown> {
        const channel = String(args.channel), message = String(args.message);
        const allowed = messageAllowlist[channel];
        if (!allowed) throw new MessageError('creator.tools.unsupportedChannel', { channel, channels: Object.keys(messageAllowlist).join(t('creator.tools.listSeparator')) });
        if (!allowed.includes(message)) throw new MessageError('creator.tools.messageNotAllowed', { channel, message, allowed: allowed.join(t('creator.tools.listSeparator')) });
        const list = Array.isArray(args.args) ? args.args : [];
        if (list.length > 8) throw new MessageError('creator.tools.argsLimit');
        if (channel === 'asset-db' && message === 'refresh-asset') this.host.assertIdle();
        const started = Date.now();
        const result = await this.host.request<unknown>(channel, message, ...list);
        const text = JSON.stringify(result ?? null);
        const limit = 64 * 1024;
        if (text.length <= limit) return { channel, message, elapsedMs: Date.now() - started, result: result ?? null, truncated: false };
        return { channel, message, elapsedMs: Date.now() - started, result: null, resultText: text.slice(0, limit) + '…', truncated: true, bytes: text.length, note: t('creator.tools.resultTruncated') };
    }
    private projectRelative(value: string): string {
        if (value.startsWith('db://')) return value.slice('db://'.length);
        const relativeName = path.isAbsolute(value) ? path.relative(this.host.project, value) : value;
        return relativeName.split(path.sep).join('/').replace(/^\.\//, '');
    }
    // Node, component and property level difference of a prefab or scene between two versions, with
    // references resolved to node paths and asset urls so a review does not have to read raw JSON.
    private async prefabDiff(args: Record<string, unknown>): Promise<unknown> {
        if (!this.host.fileAt) throw new MessageError('creator.tools.fileVersionUnsupported');
        const name = this.projectRelative(String(args.path));
        if (name.startsWith('../') || name === '..' || !/\.(prefab|scene)$/i.test(name)) throw new MessageError('creator.tools.prefabSceneOnly', { name });
        const revision = (value: unknown, fallback: string) => { if (value === undefined) return fallback; const text = String(value); if (!/^[A-Za-z0-9_./~^@{}:-]{1,64}$/.test(text) || text.startsWith('-')) throw new MessageError('creator.tools.invalidRevision', { revision: text }); return text; };
        const left = revision(args.left, 'HEAD'), right = revision(args.right, 'worktree');
        const limit = typeof args.limit === 'number' ? args.limit : 200;
        const [before, after] = await Promise.all([this.host.fileAt(name, left), this.host.fileAt(name, right)]);
        if (before === null && after === null) throw new MessageError('creator.tools.fileInNeither', { name });
        const leftObjects = before === null ? [] : parseSerialized(before), rightObjects = after === null ? [] : parseSerialized(after);
        const references = collectReferences([leftObjects, rightObjects]);
        const assetLabels = new Map<string, string>(), typeLabels = new Map<string, string>();
        const lookup = async (uuid: string) => { try { return await this.host.request<AssetInfo | null>('asset-db', 'query-asset-info', uuid, ['url', 'name']); } catch { return null; } };
        for (const uuid of references.uuids.slice(0, 80)) { const info = await lookup(uuid); if (info?.url) assetLabels.set(uuid, info.url.replace(/^db:\/\/assets\//, '')); }
        for (const type of references.types.slice(0, 80)) { const uuid = decompressUuid(type); const info = uuid ? await lookup(uuid) : null; if (info?.name) typeLabels.set(type, info.name.replace(/\.(ts|js)$/i, '')); }
        const diff = diffSerialized(leftObjects, rightObjects, { limit, labelAsset: uuid => assetLabels.get(uuid), labelType: type => typeLabels.get(type) });
        return { path: name, leftRevision: left, rightRevision: right, leftMissing: before === null, rightMissing: after === null, ...diff,
            note: t('creator.tools.prefabDiffNote') };
    }
    private async languageKeys(args: Record<string, unknown>): Promise<unknown> {
        if (!this.host.languageKeys) throw new MessageError('creator.tools.languageKeysUnsupported');
        const keys = Array.isArray(args.keys) ? args.keys.map(String) : undefined;
        const paths = Array.isArray(args.paths) ? args.paths.map(item => this.projectRelative(String(item))) : undefined;
        const since = typeof args.since === 'string' ? args.since : undefined;
        if (since !== undefined && (!/^[A-Za-z0-9_./~^@{}-]{1,64}$/.test(since) || since.startsWith('-'))) throw new MessageError('creator.tools.invalidRevision', { revision: since });
        const csv = args.csv === 'all' ? 'all' : args.csv === 'missing' || args.csv === true;
        return this.host.languageKeys({ ...(keys?.length ? { keys } : {}), ...(paths?.length ? { paths } : {}), ...(since ? { since } : {}), history: args.history !== false, csv, ...(typeof args.limit === 'number' ? { limit: args.limit } : {}) });
    }
    private async metaCheck(args: Record<string, unknown>): Promise<unknown> {
        if (!this.host.metaCheck) throw new MessageError('creator.tools.metaCheckUnsupported');
        const scope = args.scope === 'index' ? 'index' : 'worktree';
        const paths = Array.isArray(args.paths) ? args.paths.map(item => this.projectRelative(String(item))) : undefined;
        if (paths?.some(item => item.startsWith('../') || item === '..')) throw new MessageError('creator.tools.pathsInProject');
        return this.host.metaCheck({ scope, ...(paths?.length ? { paths } : {}) });
    }
    private async reload(args: Record<string, unknown>): Promise<unknown> {
        if (!this.host.reloadExtension) throw new MessageError('creator.tools.reloadUnsupported');
        this.host.assertIdle();
        const name = typeof args.name === 'string' ? args.name : 'cocos-git-desk';
        const result = await this.host.reloadExtension(name);
        return { ...result, note: name === 'cocos-git-desk' ? t('creator.tools.reloadSelfNote') : t('creator.tools.reloadScheduled', { name }) };
    }

}

// The project's own no-emit check: root tsconfig with the TypeScript the repository installs.
export async function runTsc(project: string, timeoutMs = 180000): Promise<TypecheckResult> {
    const binary = path.join(project, 'node_modules', '.bin', 'tsc');
    try { await fs.access(binary); } catch { throw new MessageError('creator.tools.tscMissing'); }
    const args = ['-p', 'tsconfig.json', '--noEmit', '--pretty', 'false'];
    const started = Date.now();
    return new Promise(resolve => {
        execFile(binary, args, { cwd: project, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, FORCE_COLOR: '0' } }, (error, stdout, stderr) => {
            const killed = !!error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
            resolve({ command: 'tsc ' + args.join(' '), exitCode: error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? null : 0,
                output: String(stdout) + (stderr ? '\n' + String(stderr) : ''), elapsedMs: Date.now() - started, timedOut: killed });
        });
    });
}
