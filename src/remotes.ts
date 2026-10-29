import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { OperationRequest, RemoteEntry, RemotePage, RemoteQuery, RemoteStateChangedError } from './types';
import { t, MessageError } from './i18n';

type Run = (args: string[]) => Promise<Buffer>;
interface Entry { scope: string; origin: string; key: string; value?: string; }
interface Context { file: string; bytes: Buffer; mode: number; identity: string; version: string; entries: Entry[]; names: string[]; blocked?: string; }
const LIMIT = 8 * 1024 * 1024;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const identity = (stat: { dev: number; ino: number; mode: number; nlink: number }) => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}`;
function utf8(bytes: Buffer): string {
    const value = bytes.toString('utf8');
    if (!Buffer.from(value).equals(bytes)) throw new MessageError('git.remotes.configNotUtf8');
    return value;
}
async function boundedRead(file: string): Promise<Buffer> {
    const handle = await fs.open(file, 'r');
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > LIMIT) throw new MessageError('git.remotes.configPlainFile');
        const buffer = Buffer.alloc(stat.size + 1);
        let size = 0;
        while (size < buffer.length) {
            const read = await handle.read(buffer, size, buffer.length - size, size);
            if (!read.bytesRead) break;
            size += read.bytesRead;
        }
        if (size !== stat.size) throw new RemoteStateChangedError(t('git.remotes.configSizeChanged'));
        return buffer.subarray(0, size);
    } finally { await handle.close(); }
}
export function remoteName(value: unknown): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)) throw new MessageError('git.remotes.nameFormat');
    return value;
}
export function remoteUrl(value: unknown): string {
    if (typeof value !== 'string' || !value || value.length > 1024 || /[\s\x00-\x1f\x7f?#\\]/.test(value) || value.startsWith('-')) throw new MessageError('git.remotes.urlFormat');
    if (/^(?:https?|ssh):\/\//.test(value)) {
        let url: URL;
        try { url = new URL(value); } catch { throw new MessageError('git.remotes.urlInvalid'); }
        if (!url.hostname || url.hostname.startsWith('-') || url.password || (url.protocol !== 'ssh:' && url.username) || /%0[ad]/i.test(value)) throw new MessageError('git.remotes.urlCredentials');
        return value;
    }
    if (!value.includes('://') && (/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._-]*:[^:]+$/.test(value) || (path.isAbsolute(value) && !value.startsWith('//')))) return value;
    throw new MessageError('git.remotes.urlUnsupported');
}
function display(value: string | undefined): string {
    try { return remoteUrl(value); } catch { return t('git.remotes.urlHidden'); }
}

export class RemoteStore {
    constructor(private root: string, private cache: string, private run: Run) {}

    private async context(): Promise<Context> {
        const file = path.resolve(this.root, utf8(await this.run(['rev-parse', '--git-path', 'config'])).trim());
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > LIMIT) throw new MessageError('git.remotes.repoConfigPlainFile');
        const bytes = await boundedRead(file), real = await fs.realpath(file);
        utf8(bytes);
        const raw = await this.run(['config', '--null', '--show-origin', '--show-scope', '--list']);
        const fields = utf8(raw).split('\0');
        if (fields.pop() !== '' || fields.length % 3) throw new MessageError('git.remotes.configOriginUnparsed');
        const entries: Entry[] = [];
        for (let i = 0; i < fields.length; i += 3) {
            const record = fields[i + 2]!, split = record.indexOf('\n');
            entries.push({ scope: fields[i]!, origin: fields[i + 1]!, key: split < 0 ? record : record.slice(0, split), value: split < 0 ? undefined : record.slice(split + 1) });
        }
        const names = utf8(await this.run(['remote'])).split('\n').filter(Boolean).sort();
        if (names.length > 1000) throw new MessageError('git.remotes.tooManyRemotes');
        let blocked: string | undefined;
        for (const entry of entries) {
            if (/^url\..*\.(?:insteadof|pushinsteadof)$/.test(entry.key)) blocked = t('git.remotes.blockedUrlRewrite');
            if (/^include(?:if\..*)?\.path$/.test(entry.key)) blocked = t('git.remotes.blockedInclude');
            if (entry.key.startsWith('remote.') && (entry.scope !== 'local' || !entry.origin.startsWith('file:') || path.resolve(this.root, entry.origin.slice(5)) !== real)) blocked = t('git.remotes.blockedScope');
        }
        const after = await fs.lstat(file);
        if (bytes.length > LIMIT || identity(stat) !== identity(after) || stat.mtimeMs !== after.mtimeMs || stat.size !== after.size || !bytes.equals(await boundedRead(file))) throw new RemoteStateChangedError(t('git.remotes.repoConfigChanged'));
        return { file, bytes, mode: stat.mode & 0o777, identity: identity(stat), entries, names, blocked,
            version: hash(JSON.stringify([file, identity(stat), hash(bytes), hash(raw), names])) };
    }

    private entry(context: Context, name: string): RemoteEntry {
        const values = context.entries.filter(entry => entry.key.startsWith(`remote.${name}.`));
        const fetch = values.filter(entry => entry.key === `remote.${name}.url`).map(entry => entry.value);
        const push = values.filter(entry => entry.key === `remote.${name}.pushurl`).map(entry => entry.value);
        let reason = context.blocked;
        try { remoteName(name); for (const value of [...fetch, ...push]) remoteUrl(value); } catch { reason ||= t('git.remotes.reasonFormat'); }
        if (fetch.length !== 1 || push.length > 1) reason ||= t('git.remotes.reasonMultipleUrls');
        if (values.some(entry => !['url', 'pushurl', 'fetch'].some(key => entry.key === `remote.${name}.${key}`))) reason ||= t('git.remotes.reasonCustomOptions');
        const mappings = values.filter(entry => entry.key === `remote.${name}.fetch`).map(entry => entry.value);
        const standard = `refs/heads/*:refs/remotes/${name}/*`;
        if (mappings.length !== 1 || ![standard, '+' + standard].includes(mappings[0] || '')) reason ||= t('git.remotes.reasonFetchMapping');
        return { name: name.slice(0, 512), fetchUrls: fetch.slice(0, 4).map(display), pushUrls: push.slice(0, 4).map(display), fetchCount: fetch.length, pushCount: push.length,
            pushUsesFetch: push.length === 0, editable: !reason, reason };
    }

    async page(repo: string, repoVersion: string, query: RemoteQuery): Promise<RemotePage> {
        if (!query || query.kind !== 'remotes' || Object.keys(query).some(key => !['kind', 'offset', 'limit', 'version', 'text'].includes(key))) throw new MessageError('git.remotes.invalidQuery');
        const { offset = 0, limit = 20, version, text = '' } = query;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50 || typeof text !== 'string' || text.length > 512 || text.includes('\0') || (version !== undefined && (typeof version !== 'string' || version.length !== 64))) throw new MessageError('git.remotes.queryParams');
        const context = await this.context(), current = hash(JSON.stringify([context.version, text.toLowerCase()]));
        if ((offset > 0 && !version) || (version !== undefined && version !== current)) throw new RemoteStateChangedError(t('git.remotes.pagingStale'));
        const names = context.names.filter(name => name.toLowerCase().includes(text.toLowerCase()));
        const result: RemotePage = { repo, repoVersion, version: current, remoteVersion: context.version, entries: names.slice(offset, offset + limit).map(name => this.entry(context, name)),
            total: names.length, offset, limit, nextOffset: offset + limit < names.length ? offset + limit : undefined, canAdd: !context.blocked, reason: context.blocked };
        if (Buffer.byteLength(JSON.stringify(result)) > 192 * 1024) throw new MessageError('git.remotes.pageTooLarge');
        return result;
    }

    private select(context: Context, request: OperationRequest): { name: string; key: string; value?: string; before: string; after: string } {
        if (request.remoteVersion !== context.version) throw new RemoteStateChangedError(t('git.remotes.changedPreviewAgain'));
        if (context.blocked) throw new Error(context.blocked);
        const name = remoteName(request.remote);
        if (Object.keys(request).some(key => request[key as keyof OperationRequest] !== undefined && !['repo', 'version', 'action', 'remoteVersion', 'remote', 'url'].includes(key))) throw new MessageError('git.remotes.noPaths');
        if (request.action === 'addRemote') {
            const lower = name.toLowerCase();
            if (context.names.some(value => value.toLowerCase() === lower || value.toLowerCase().startsWith(lower + '/') || lower.startsWith(value.toLowerCase() + '/')) || context.entries.some(entry => entry.key.startsWith(`remote.${name}.`))) throw new MessageError('git.remotes.alreadyExists');
            if (context.names.length >= 1000) throw new MessageError('git.remotes.limitReached');
            const value = remoteUrl(request.url);
            return { name, key: `remote.${name}.url`, value, before: t('git.remotes.notConfigured'), after: value };
        }
        if (!context.names.includes(name)) throw new MessageError('git.remotes.notFound');
        const entry = this.entry(context, name);
        if (!entry.editable) throw new Error(entry.reason);
        const push = request.action === 'setRemotePushUrl' || request.action === 'resetRemotePushUrl';
        if (!push && request.action !== 'setRemoteUrl') throw new MessageError('git.remotes.unsupportedOperation');
        const before = push ? entry.pushUrls[0] : entry.fetchUrls[0];
        if (request.action === 'resetRemotePushUrl') {
            if (!before || request.url !== undefined) throw new MessageError('git.remotes.resetPushOnly');
            return { name, key: `remote.${name}.pushurl`, before, after: t('git.remotes.followFetchUrl', { url: entry.fetchUrls[0] }) };
        }
        const value = remoteUrl(request.url);
        if (before === value) throw new MessageError('git.remotes.urlUnchanged');
        return { name, key: `remote.${name}.${push ? 'pushurl' : 'url'}`, value, before: before || t('git.remotes.followFetch'), after: value };
    }

    async preview(request: OperationRequest): Promise<string> {
        const context = await this.context(), selected = this.select(context, request);
        if (request.action === 'addRemote') await this.assertNoReferences(selected.name);
        return t('git.remotes.preview', { name: selected.name, key: selected.key, before: selected.before, after: selected.after, mapping: request.action === 'addRemote' ? t('git.remotes.previewMapping', { name: selected.name }) : '' });
    }

    private async assertNoReferences(name: string): Promise<void> {
        const refs = await this.run(['for-each-ref', '--count=1', '--format=%(refname)', `refs/remotes/${name}`]);
        if (refs.length) throw new MessageError('git.remotes.trackingRefsExist');
    }

    async execute(request: OperationRequest): Promise<void> {
        const before = await this.context(); this.select(before, request);
        const lockPath = before.file + '.lock';
        const lock = await fs.open(lockPath, 'wx', before.mode);
        const lockStat = await lock.stat();
        const ownsLock = (stat: { dev: number; ino: number }) => stat.dev === lockStat.dev && stat.ino === lockStat.ino;
        let temporary: string | undefined, installed = false;
        try {
            const current = await this.context(), selected = this.select(current, request);
            if (current.version !== before.version) throw new RemoteStateChangedError(t('git.remotes.changedWhileLocking'));
            if (request.action === 'addRemote') await this.assertNoReferences(selected.name);
            await fs.mkdir(this.cache, { recursive: true });
            temporary = path.join(this.cache, 'remote-config-' + randomUUID());
            await fs.writeFile(temporary, current.bytes, { flag: 'wx', mode: 0o600 });
            const config = ['config', '--file', temporary, '--no-includes'];
            await this.run([...config, ...(selected.value === undefined ? ['--unset', selected.key] : [selected.key, selected.value])]);
            if (request.action === 'addRemote') await this.run([...config, `remote.${selected.name}.fetch`, `+refs/heads/*:refs/remotes/${selected.name}/*`]);
            const next = await boundedRead(temporary);
            if (next.length > LIMIT) throw new MessageError('git.remotes.configTooLarge');
            await this.run([...config, '--null', '--list']);
            const latest = await this.context();
            if (latest.version !== current.version || !ownsLock(await fs.lstat(lockPath))) throw new RemoteStateChangedError(t('git.remotes.changedBeforeWrite'));
            await lock.chmod(current.mode); await lock.writeFile(next); await lock.sync();
            if (!(await boundedRead(current.file)).equals(current.bytes) || identity(await fs.lstat(current.file)) !== current.identity) throw new RemoteStateChangedError(t('git.remotes.modifiedBeforeWrite'));
            if (!ownsLock(await fs.lstat(lockPath))) throw new RemoteStateChangedError(t('git.remotes.lockReplaced'));
            await lock.close();
            await fs.rename(lockPath, current.file); installed = true;
            const after = await this.context();
            if (!after.bytes.equals(next)) throw new MessageError('git.remotes.readBackMismatch');
            const entry = this.entry(after, selected.name);
            const actual = request.action === 'setRemoteUrl' || request.action === 'addRemote' ? entry.fetchUrls[0] : entry.pushUrls[0];
            if (!entry.editable || actual !== selected.value) throw new MessageError('git.remotes.readBackUnexpected');
        } catch (error) {
            if (installed) throw new MessageError('git.remotes.mayHaveWritten');
            throw error;
        } finally {
            await lock.close().catch(() => undefined);
            if (!installed) {
                const stat = await fs.lstat(lockPath).catch(() => undefined);
                if (stat && ownsLock(stat)) await fs.unlink(lockPath);
            }
            if (temporary) {
                await fs.rm(temporary, { force: true });
                await fs.rm(temporary + '.lock', { force: true });
            }
        }
    }
}
