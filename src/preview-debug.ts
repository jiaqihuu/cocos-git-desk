import { promises as fs } from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { PreviewCapture, CaptureOptions } from './preview-capture';
import { sourceRevision, projectRoot, defaultRevisionRoots } from './preview-revision';
import { t, MessageError } from './i18n';
import type { ToolSchema } from './config';

export interface PreviewPage {
    options: { url: string; root: string };
    status(): { present: boolean; connected: boolean; targetId: string | null; generation: number };
    evaluate(expression: string, options?: { awaitPromise?: boolean }): Promise<unknown>;
    screenshot(): Promise<Buffer>;
    onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void;
}
// Everything project-dependent the service needs: the project identity the page bridge must report,
// the bridge object names and api version, the fingerprint roots and the per-machine directories.
export interface PreviewDebugSettings {
    projectId: string;
    bridge: { controlName: string; debugName: string; apiVersion: string };
    revisionRoots?: readonly string[];
    stateDir: string;
    outputDir: string;
}
interface Identity { apiVersion: string; projectId?: string; projectUuid?: string; preview: boolean; sessionId: string; loadedRevision?: { scope?: string; digest?: string } | null; injectionOnly?: boolean; integration?: string; }
interface BridgeResult { identity: Identity; data: any; }
export type { ToolSchema };
const bridgeMethods = new Set(['identity', 'hierarchy', 'inspect', 'state', 'events', 'stats', 'uiList', 'uiOpen', 'uiClose', 'language', 'mockSet', 'mockList', 'mockClear', 'captureBodies']);
const objectLimit = 16384;
export const bridgeGraceMs = 15000;

export function validateToolArgs(schema: ToolSchema | undefined, args: unknown): Record<string, unknown> {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new MessageError('preview.argsNotObject');
    const record = args as Record<string, unknown>;
    if (!schema) return record;
    for (const key of schema.inputSchema.required ?? []) if (!Object.prototype.hasOwnProperty.call(record, key)) throw new MessageError('preview.argMissing', { key });
    for (const [key, value] of Object.entries(record)) {
        const field = schema.inputSchema.properties[key];
        if (!field) throw new MessageError('preview.argUnknown', { key });
        if (field.type === 'boolean' && typeof value !== 'boolean') throw new MessageError('preview.argBoolean', { key });
        if (field.type === 'string' && (typeof value !== 'string' || value.length < (field.minLength ?? 0) || value.length > (field.maxLength ?? 4096) || (field.enum && !field.enum.includes(value)))) throw new MessageError('preview.argInvalid', { key });
        if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || (field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum))) throw new MessageError('preview.argNumber', { key });
        if (field.type === 'integer' && (!Number.isSafeInteger(value) || (value as number) < (field.minimum ?? -Infinity) || (value as number) > (field.maximum ?? Infinity))) throw new MessageError('preview.argInteger', { key });
        const anyItems = field.type === 'array' && field.items && typeof field.items === 'object' && !('type' in field.items);
        if (anyItems && (!Array.isArray(value) || value.length > 200 || JSON.stringify(value).length > 64 * 1024)) throw new MessageError('preview.argJsonArray', { key });
        if (field.type === 'array' && !anyItems && (!Array.isArray(value) || value.length > 200 || value.some(item => typeof item !== 'string'))) throw new MessageError('preview.argStringArray', { key });
        if (field.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > objectLimit)) throw new MessageError('preview.argObject', { key });
    }
    return record;
}

// In-process replacement for the former standalone browser-debug MCP: the page observer switch,
// the redacted event capture, bridge queries and evidence export, all over the bound preview page.
export class PreviewDebugService {
    readonly capture: PreviewCapture;
    private desired: boolean | null = null;
    private lastError: string | null = null;
    private navigatedAt = Date.now();
    private applied: string | null = null;
    private detach?: () => void;
    private readonly preferenceFile: string;
    private readonly outputRoot: string;
    constructor(private page: PreviewPage, private runtime: (name: string, args: Record<string, unknown>) => Promise<unknown>, private schemas: ToolSchema[], private settings: PreviewDebugSettings) {
        this.capture = new PreviewCapture(page.options.url);
        const url = new URL(page.options.url);
        const key = createHash('sha256').update(page.options.root + '\0' + url.origin + url.pathname).digest('hex');
        this.preferenceFile = path.join(settings.stateDir, 'observer-' + key + '.json');
        this.outputRoot = settings.outputDir;
        this.detach = page.onEvent((method, params) => {
            this.capture.handle(method, params);
            if (method === 'Page.frameNavigated' && !(params as { frame?: { parentId?: string } }).frame?.parentId) { this.applied = null; this.navigatedAt = Date.now(); }
        });
    }
    close(): void { this.detach?.(); this.detach = undefined; this.capture.stop(); }

    private async readPreference(): Promise<{ enabled: boolean; updatedAt: number }> {
        let data: { schema?: number; enabled?: unknown; updatedAt?: unknown };
        try { data = JSON.parse(await fs.readFile(this.preferenceFile, 'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { enabled: false, updatedAt: 0 }; throw error; }
        if (data.schema !== 1 || typeof data.enabled !== 'boolean') throw new MessageError('preview.preferenceInvalid');
        const updatedAt = typeof data.updatedAt === 'number' && Number.isSafeInteger(data.updatedAt) && data.updatedAt >= 0 ? data.updatedAt : 0;
        return { enabled: data.enabled, updatedAt };
    }
    private async writePreference(enabled: boolean, timestamp?: number): Promise<number> {
        const updatedAt = timestamp ?? Math.max(Date.now(), (await this.readPreference()).updatedAt + 1);
        await fs.mkdir(path.dirname(this.preferenceFile), { recursive: true, mode: 0o700 });
        const temporary = this.preferenceFile + '.' + randomUUID();
        await fs.writeFile(temporary, JSON.stringify({ schema: 1, enabled, updatedAt }) + '\n', { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, this.preferenceFile);
        return updatedAt;
    }
    private guard(): string {
        const url = new URL(this.page.options.url);
        return `if (location.origin !== ${JSON.stringify(url.origin)} || location.pathname !== ${JSON.stringify(url.pathname)}) throw new Error('Preview page changed');`;
    }
    // The page bridge reports the project it was built for; it must be the project Creator has open.
    private identityCheck(): string {
        return `(identity.projectId ?? identity.projectUuid) !== ${JSON.stringify(this.settings.projectId)} || identity.apiVersion !== ${JSON.stringify(this.settings.bridge.apiVersion)}`;
    }
    private async control(enabled: boolean, updatedAt: number): Promise<Record<string, unknown>> {
        const value = await this.page.evaluate(`(() => { ${this.guard()}
            const control = window[${JSON.stringify(this.settings.bridge.controlName)}];
            if (!control) throw Error(${JSON.stringify(t('preview.bridgeControlMissing', { name: this.settings.bridge.controlName }))});
            const identity = control.identity();
            if (${this.identityCheck()}) throw Error(${JSON.stringify(t('preview.bridgeMismatch'))});
            const result = control.setEnabled(${JSON.stringify(enabled)}, ${JSON.stringify(updatedAt)});
            if (${JSON.stringify(enabled)} && !result.applied) throw Error(${JSON.stringify(t('preview.bridgeWaitingGame'))});
            return result.cleanup || result;
        })()`, { awaitPromise: false });
        return (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    }
    status(): Record<string, unknown> {
        const page = this.page.status(), waiting = this.startupWait(this.lastError);
        // Past the grace period a page without the bridge is a project that does not install one: a state, not an error.
        const noBridge = !waiting && this.lastError !== null && this.lastError === t('preview.bridgeControlMissing', { name: this.settings.bridge.controlName });
        return { enabled: this.desired === true, applied: this.applied === page.targetId && page.connected, lastError: waiting || noBridge ? null : this.lastError, waiting: waiting ? this.lastError : null, noBridge };
    }
    // While the page connects and the game boots, "not applied yet" is expected for a few seconds and is reported
    // as waiting, not as an error. Matched against the localized texts of the message ids, so it works in every
    // language. A missing bridge only counts as waiting shortly after a page load: a project that never installs
    // one must still see why bridge tools fail.
    private startupWait(error: string | null): boolean {
        if (!error) return false;
        if (error === t('preview.waitingConnection') || error === t('preview.bridgeWaitingGame')) return true;
        return error === t('preview.bridgeControlMissing', { name: this.settings.bridge.controlName }) && Date.now() - this.navigatedAt < bridgeGraceMs;
    }
    // Pushes the saved choice to the page; called after bind, on reload and from the panel's status poll.
    // A newer choice made inside the page (its own debug panel) wins over the saved one, as before.
    async reconcile(explicit = false, page?: { enabled?: unknown; updatedAt?: unknown } | null): Promise<Record<string, unknown>> {
        const state = this.page.status();
        try {
            const saved = await this.readPreference();
            if (this.desired === null) this.desired = saved.enabled;
            if (!state.connected) { this.applied = null; this.lastError = this.desired ? t('preview.waitingConnection') : null; return this.status(); }
            if (!explicit && page && typeof page.enabled === 'boolean' && typeof page.updatedAt === 'number' && Number.isSafeInteger(page.updatedAt) && page.updatedAt > saved.updatedAt) {
                await this.writePreference(page.enabled, page.updatedAt);
                this.desired = page.enabled;
                if (page.enabled) this.applied = state.targetId;
            }
            if (!this.desired) {
                if (this.applied !== null || explicit) { await this.control(false, (await this.readPreference()).updatedAt); this.applied = null; }
                this.lastError = null; return this.status();
            }
            if (this.applied !== state.targetId) {
                await this.control(true, (await this.readPreference()).updatedAt);
                this.applied = state.targetId;
            }
            this.lastError = null;
        } catch (error) { this.applied = null; this.lastError = error instanceof Error ? error.message : String(error); }
        return this.status();
    }
    async setEnabled(enabled: boolean): Promise<string> {
        if (typeof enabled !== 'boolean') throw new MessageError('preview.switchBoolean');
        await this.writePreference(enabled);
        this.desired = enabled;
        const result = await this.reconcile(true);
        if (result.lastError) return t('preview.switchSavedPending', { state: t(enabled ? 'preview.switchOn' : 'preview.switchOff'), error: String(result.lastError) });
        return enabled ? (result.applied ? t('preview.switchEnabledApplied') : t('preview.switchEnabledPending')) : t('preview.switchDisabledSynced');
    }
    private async bridge(method: string, args: unknown[] = []): Promise<BridgeResult> {
        if (!bridgeMethods.has(method)) throw new MessageError('preview.bridgeMethodUnknown');
        // Commands may resolve asynchronously (view loading, language reload); a bounded wait keeps the MCP call from hanging.
        const value = await this.page.evaluate(`(async () => { ${this.guard()}
            const api = window[${JSON.stringify(this.settings.bridge.debugName)}];
            // No control object either means the project installs no page bridge at all; say so instead of asking to enable.
            if (!api) throw new Error(window[${JSON.stringify(this.settings.bridge.controlName)}] ? ${JSON.stringify(t('preview.bridgeNotEnabled'))} : ${JSON.stringify(t('preview.bridgeControlMissing', { name: this.settings.bridge.controlName }))});
            const identity = api.identity();
            if (${this.identityCheck()} || identity.preview !== true) throw new Error(${JSON.stringify(t('preview.bridgeMismatch'))});
            if (typeof api[${JSON.stringify(method)}] !== 'function') throw new Error(${JSON.stringify(t('preview.bridgeMethodMissing', { method }))});
            const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(${JSON.stringify(t('preview.bridgeTimeout'))})), 20000));
            return { identity, data: await Promise.race([Promise.resolve(api[${JSON.stringify(method)}](...${JSON.stringify(args)})), timeout]) };
        })()`, { awaitPromise: true }) as BridgeResult | undefined;
        if (!value?.identity?.sessionId) throw new MessageError('preview.bridgeInvalidResult');
        if (JSON.stringify(value).length > 4 * 1024 * 1024) throw new MessageError('preview.bridgeResultTooLarge');
        return value;
    }
    private async identity({ compareDisk = false }: { compareDisk?: boolean } = {}): Promise<Record<string, unknown>> {
        const result: Record<string, unknown> = { ...await this.bridge('identity') };
        if (compareDisk) {
            const disk = await sourceRevision(this.page.options.root, this.settings.revisionRoots ?? defaultRevisionRoots);
            const again = await this.bridge('identity');
            const identity = result.identity as Identity;
            if (again.identity.sessionId !== identity.sessionId) throw new MessageError('preview.reloadedDuringCompare');
            result.disk = disk;
            result.stampMatchesDisk = identity.loadedRevision?.scope === disk.scope && identity.loadedRevision?.digest === disk.digest;
            result.freshness = (identity.injectionOnly || identity.integration === 'project-preview') ? 'disk-snapshot-only; runtime-session-does-not-assert-compiled-freshness' : result.stampMatchesDisk ? 'stamp-matches-scoped-disk-snapshot; compiled-modules-and-live-assets-not-proven' : 'stamp-differs-or-missing; restamp-compile-reload-required';
        }
        return { ...result, preference: this.status() };
    }
    private async evidenceDirectory(): Promise<string> {
        await projectRoot(this.page.options.root);
        if (!path.isAbsolute(this.outputRoot)) throw new MessageError('preview.outputDirRelative', { directory: this.outputRoot });
        await fs.mkdir(this.outputRoot, { recursive: true, mode: 0o700 });
        const actual = await fs.realpath(this.outputRoot);
        const directory = path.join(actual, 'evidence-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
        await fs.mkdir(directory, { mode: 0o700 });
        return directory;
    }
    async exportEvidence({ screenshot = true, compareDisk = false }: { screenshot?: boolean; compareDisk?: boolean } = {}): Promise<Record<string, unknown>> {
        const startedAt = new Date().toISOString();
        const captureId = this.capture.sessionId, generation = this.page.status().generation;
        const identity = await this.identity({ compareDisk });
        const sessionId = (identity.identity as Identity).sessionId;
        const hierarchy = await this.bridge('hierarchy', [{ activeOnly: true, limit: 500, maxDepth: 30, includeText: false }]);
        const state = await this.bridge('state');
        const trace = await this.bridge('events', [0, 1000]);
        let pixels: Buffer | undefined;
        if (screenshot) { pixels = await this.page.screenshot(); if (pixels.length > 20 * 1024 * 1024) throw new MessageError('preview.screenshotTooLarge'); }
        const final = await this.bridge('identity');
        if ([hierarchy, state, trace, final].some(item => item.identity.sessionId !== sessionId) || this.capture.sessionId !== captureId || this.page.status().generation !== generation) throw new MessageError('preview.sessionChangedDuringExport');
        const recent = this.capture.eventsBuffer.slice(-1000);
        const browserEvents = recent.map(event => ({ id: event.id, time: event.time, category: event.category, level: event.level, ...(event.category === 'marker' ? { label: event.message } : {}),
            requestId: event.requestId, status: event.status, method: event.method, url: event.url, source: event.source, browserTimestamp: event.browserTimestamp, opcode: event.opcode, encodedPayloadLength: event.encodedPayloadLength }));
        const timeline = [...(trace.data.entries as Array<{ time: number }>).map(event => ({ source: 'bridge', time: event.time, event })), ...browserEvents.map(event => ({ source: 'browser', time: Date.parse(event.time), event }))].sort((a, b) => a.time - b.time);
        const report = { schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(), identity, hierarchy: hierarchy.data, state: state.data, trace: trace.data, timeline,
            browserCapture: { ...this.capture.status(), exportedEvents: browserEvents.length, omittedEarlierEvents: Math.max(0, this.capture.eventsBuffer.length - recent.length) },
            notes: ['Observation spans several queries; it is not an atomic game-state snapshot.', 'Browser console text and payloads are omitted. Screenshot pixels can still contain personal information.',
                'HTTP/unary RPC completion is client-side evidence; stream messages and server-side acceptance are outside this bridge.', 'Stamp equality does not prove that all compiled modules or live prefab instances are current.'] };
        const directory = await this.evidenceDirectory();
        const files: Array<{ name: string; sha256: string }> = [];
        const save = async (name: string, bytes: Buffer | string) => { await fs.writeFile(path.join(directory, name), bytes, { flag: 'wx', mode: 0o600 }); files.push({ name, sha256: createHash('sha256').update(bytes).digest('hex') }); };
        try {
            await save('evidence.json', JSON.stringify(report, null, 2) + '\n');
            if (pixels) await save('screenshot.png', pixels);
            await save('README.md', t('preview.evidenceReadme', { sessionId }));
            await save('manifest.json', JSON.stringify({ complete: true, sessionId, files }, null, 2) + '\n');
        } catch (error) { throw new MessageError('preview.evidenceWriteFailed', { directory, error: error instanceof Error ? error.message : String(error) }); }
        return { directory, sessionId, complete: true, files, screenshotIncluded: !!pixels };
    }
    // Tool dispatch for the MCP bridge; names are the ones the former standalone server exposed.
    async call(name: string, input: unknown): Promise<unknown> {
        const args = validateToolArgs(this.schemas.find(tool => tool.name === name), input);
        if (name.startsWith('runtime_inspector_')) return this.runtime(name, args);
        switch (name) {
            case 'browser_debug_enable': return { message: await this.setEnabled(true), ...this.status() };
            case 'browser_debug_disable': return { message: await this.setEnabled(false), ...this.status() };
            case 'browser_debug_connect': return { ...this.page.status(), ...this.capture.status(), preference: await this.reconcile() };
            case 'browser_debug_identity': return this.identity(args as { compareDisk?: boolean });
            case 'browser_debug_hierarchy': return this.bridge('hierarchy', [args]);
            case 'browser_debug_inspect_node': return this.bridge('inspect', [args.uuid, args.sessionId, args.includeText ?? false]);
            case 'browser_debug_state': return this.bridge('state');
            case 'browser_debug_timeline': return this.bridge('events', [args.afterSequence ?? 0, args.limit ?? 200]);
            case 'browser_debug_export': return this.exportEvidence(args as { screenshot?: boolean; compareDisk?: boolean });
            case 'browser_debug_start': return { ...this.capture.start(args as CaptureOptions), ...this.page.status() };
            case 'browser_debug_status': return { ...this.page.status(), ...this.capture.status(), preference: this.status() };
            case 'browser_debug_events': return this.capture.events(args as Parameters<PreviewCapture['events']>[0]);
            case 'browser_debug_summary': return this.capture.summary(args as { sinceId?: number });
            case 'browser_debug_mark': return this.capture.mark(String(args.label));
            case 'browser_debug_wait_for_reload': return this.capture.waitForReload(args as unknown as { afterId: number; timeoutMs?: number });
            case 'browser_debug_compare': return this.capture.compare(args as unknown as { beforeStartId: number; beforeEndId: number; afterStartId: number; afterEndId?: number });
            case 'browser_debug_stop': { const message = await this.setEnabled(false); return { ...this.capture.stop(), preference: this.status(), message }; }
            // Commands: they change the running preview, so each one is also written to the page timeline.
            case 'browser_debug_ui_list': return this.bridge('uiList');
            case 'browser_debug_ui_open': return this.bridge('uiOpen', [args.name ?? args.uiid, ...(args.args === undefined ? [] : [args.args])]);
            case 'browser_debug_ui_close': return this.bridge('uiClose', [args.name ?? args.uiid]);
            case 'browser_debug_language': return this.bridge('language', args.code === undefined ? [] : [args.code]);
            case 'browser_debug_mock_set': return this.bridge('mockSet', [args]);
            case 'browser_debug_mock_list': return this.bridge('mockList');
            case 'browser_debug_mock_clear': return this.bridge('mockClear', args.name === undefined ? [] : [args.transport, args.name]);
            case 'browser_debug_stats': return this.bridge('stats');
            case 'browser_debug_capture_bodies': return this.bridge('captureBodies', [args.enabled === true]);
            default: throw new MessageError('preview.unknownTool', { name });
        }
    }
}
