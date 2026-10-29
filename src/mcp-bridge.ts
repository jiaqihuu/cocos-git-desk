import http from 'http';
import { promises as fs } from 'fs';
import path from 'path';
import { randomBytes, timingSafeEqual } from 'crypto';
import { AgentReply } from './agent';
import { MessageError } from './i18n';

const reads = ['capabilities', 'repositories', 'status', 'files', 'tags', 'tree', 'remotes', 'reflog', 'merge', 'fileCompare', 'worktreeCompare', 'indexCompare', 'branches', 'remoteBranches', 'stashes', 'history', 'diff', 'sync', 'commitDetails', 'commitFiles'];
const fields: Record<string, string[]> = {
    git_desk_query: ['repo', 'op', 'arguments'], git_desk_task_start: ['repo', 'title', 'paths'],
    git_desk_task_list: ['repo'], git_desk_task_extend: ['repo', 'id', 'paths'], git_desk_task_changes: ['repo', 'id', 'verbose'], git_desk_commit_check: ['repo', 'id', 'includePointers', 'verbose'],
    git_desk_prepare: ['repo', 'operation', 'taskId', 'verbose'], git_desk_execute: ['repo', 'token', 'digest', 'wait', 'waitMs'], git_desk_task_status: ['repo', 'taskId', 'logLimit', 'waitMs'],
    git_desk_context_list: ['baseRepo'], git_desk_context_register: ['baseRepo', 'path'], git_desk_context_forget: [],
    git_desk_worktree_prepare: ['mode', 'baseRepo', 'path', 'branch', 'revision', 'targetContext'], git_desk_worktree_execute: ['token', 'digest'],
    git_desk_scope_review: ['mode', 'taskId', 'paths', 'id', 'review'],
};
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MessageError('main.mcpArgsNotObject');
    return value as Record<string, unknown>;
}
export function mcpQuery(name: string, input: unknown): { repo: string; query: unknown; context?: string } {
    const args = record(input), allowed = fields[name];
    if (!allowed || Object.keys(args).some(key => key !== 'context' && key !== 'repo' && !allowed.includes(key))) throw new MessageError('main.mcpUnknownTool');
    const { repo = '.', context, ...rest } = args;
    if (typeof repo !== 'string' || repo.length > 4096) throw new MessageError('main.mcpInvalidRepo');
    if (context !== undefined && (typeof context !== 'string' || !context || context.length > 128)) throw new MessageError('main.mcpInvalidContext');
    let op: string, params: Record<string, unknown> = rest;
    if (name === 'git_desk_query') {
        if (typeof args.op !== 'string' || !reads.includes(args.op)) throw new MessageError('main.mcpReadOnlyOp');
        op = args.op; params = args.arguments === undefined ? {} : record(args.arguments);
        if (['op', 'kind', 'protocol', 'repo', 'context'].some(key => key in params)) throw new MessageError('main.mcpProtocolFields');
    } else {
        op = ({ git_desk_task_start: 'scopeStart', git_desk_task_list: 'scopeList', git_desk_task_extend: 'scopeExtend', git_desk_task_changes: 'scopeChanges', git_desk_commit_check: 'commitCheck', git_desk_prepare: 'prepare', git_desk_execute: 'execute', git_desk_task_status: 'task', git_desk_context_list: 'contexts', git_desk_context_register: 'contextRegister', git_desk_context_forget: 'contextForget', git_desk_worktree_prepare: 'worktreePrepare', git_desk_worktree_execute: 'worktreeExecute' })[name] || '';
        if (name === 'git_desk_scope_review') {
            if (args.mode !== 'request' && args.mode !== 'status') throw new MessageError('main.mcpReviewModes');
            op = args.mode === 'request' ? 'scopeReviewRequest' : 'scopeReviewStatus';
            const { mode, ...review } = rest; params = review;
        }
        if (op === 'prepare') {
            const operation = record(args.operation);
            if (['stage', 'stageLines', 'commit', 'commitSelected'].includes(String(operation.action)) && typeof args.taskId !== 'string') throw new MessageError('main.mcpTaskIdRequired');
            // Index-wide history edits cannot use the ordinary task guard yet.
            if (['amendCommit'].includes(String(operation.action))) throw new MessageError('main.mcpAmendNotExposed');
        }
    }
    return { repo, context: typeof context === 'string' ? context : undefined, query: { ...params, kind: 'agent', protocol: 1, op } };
}
// Debug tools (runtime inspector, preview capture) share the transport; they are read-only
// observations of the embedded preview and never reach the Git service.
export type DebugToolHandler = (name: string, args: Record<string, unknown>) => Promise<unknown>;
export const debugToolPrefixes = ['runtime_inspector_', 'browser_debug_', 'creator_'];
export function isDebugTool(name: string): boolean { return debugToolPrefixes.some(prefix => name.startsWith(prefix)); }

export async function startMcpBridge(cache: string, project: string, handle: (repo: string, query: unknown, context?: string) => Promise<AgentReply>, debug?: DebugToolHandler): Promise<{ close(): Promise<void> }> {
    await fs.mkdir(cache, { recursive: true });
    if ((await fs.lstat(cache)).isSymbolicLink()) throw new MessageError('main.mcpCacheSymlink');
    const token = randomBytes(32).toString('hex'), filename = path.join(cache, 'agent-connection.json');
    let active = 0;
    const server = http.createServer((request, response) => {
        const finish = (status: number, data: unknown) => { if (!response.destroyed) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data)); } };
        const supplied = request.headers.authorization;
        const expected = 'Bearer ' + token;
        if (request.method !== 'POST' || request.url !== '/rpc' || request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined || request.headers.host !== '127.0.0.1:' + (server.address() as import('net').AddressInfo).port || typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) { finish(403, { error: 'Forbidden' }); request.resume(); return; }
        if (active >= 4) { finish(429, { error: 'Busy; do not retry uncertain writes' }); request.resume(); return; }
        active++; let released = false;
        const release = () => { if (!released) { released = true; active--; } };
        let length = 0, overflow = false; const chunks: Buffer[] = [];
        request.on('data', chunk => { length += chunk.length; if (length > 128 * 1024) { if (!overflow) finish(413, { error: 'Request too large' }); overflow = true; chunks.length = 0; } else if (!overflow) chunks.push(chunk); });
        request.on('end', () => { void (async () => {
            if (overflow) return;
            const call = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            if (Object.keys(call).some(key => key !== 'name' && key !== 'arguments') || typeof call.name !== 'string') throw new MessageError('main.mcpInvalidCall');
            let result: unknown;
            if (isDebugTool(call.name)) {
                if (!debug) throw new MessageError('main.mcpNoDebugTools');
                result = { ok: true, data: await debug(call.name, record(call.arguments ?? {})) };
            } else {
                const { repo, query, context } = mcpQuery(call.name, call.arguments ?? {});
                result = await handle(repo, query, context);
            }
            if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) throw new MessageError('main.mcpResultTooLarge');
            finish(200, result);
        })().catch(error => finish(400, { error: (error instanceof Error ? error.message : String(error)).slice(0, 2000), mayHaveSideEffects: true, retry: false })).finally(release); });
        request.on('aborted', release);
        request.on('error', () => { release(); response.destroy(); });
    });
    server.requestTimeout = 120000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxConnections = 8;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
    server.unref();
    server.on('error', error => console.error('Git Desk MCP transport error', error.message));
    try {
        const temporary = filename + '.' + randomBytes(8).toString('hex');
        await fs.writeFile(temporary, JSON.stringify({ schema: 1, project, port: (server.address() as import('net').AddressInfo).port, token, pid: process.pid }), { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, filename);
    } catch (error) { server.close(); server.closeAllConnections(); throw error; }
    return { async close() {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
        try { if (JSON.parse(await fs.readFile(filename, 'utf8')).token === token) await fs.unlink(filename); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    } };
}
