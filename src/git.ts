import { AsyncLocalStorage } from 'async_hooks';
import type { OperationMetrics } from './types';
import { ForkToolPreview, previewForkTool, executeForkTool, forkToolNames } from './fork-tools';
import { ProjectUpdatePreview, previewProjectUpdate, executeProjectUpdate, ProjectUpdateStateChangedError } from './project-update';
import { RecoveryStore, RECOVERY_FILE_BYTES, RECOVERY_TOTAL_BYTES, RECOVERY_PATHS } from './recovery';
import { FileStateChangedError } from './types';
import { ReflogEntry, ReflogPage, ReflogQuery, ReflogStateChangedError } from './types';
import { FileRevision, FileSnapshot, FileComparisonInfo, FileCompareQuery, FileComparePage, FileComparisonStateChangedError } from './types';
import { WorktreeComparisonInfo, WorktreeCompareQuery, WorktreeComparePage } from './types';
import { IndexSnapshot, IndexComparisonInfo, IndexCompareQuery, IndexComparePage } from './types';
import { StashStateChangedError } from './types';
import { RemoteStore } from './remotes';
import { RemotePage, RemoteQuery } from './types';
import { spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { promises as fs, createReadStream, constants } from 'fs';
import path from 'path';
import { Action, BlameQuery, Branch, BranchTracking, ChangedFile, Commit, CommitDetails, CommitDraft, CompareQuery, Comparison, ConflictStage, ConflictView, DiffRequest, DraftQuery, FileBlame, FileContent, FileDiff, HistoryPage, HistoryQuery, HistorySearch, Host, OperationRequest, Plan, RemoteBranch, RepoDetails, Repository, Snapshot, Stash, SyncPage, SyncQuery, Task } from './types';
import { parsePatch, ParsedPatch, selectPatch, applyPatchText } from './patch';
import { parseBlame } from './blame';
import { DraftStore } from './drafts';
import { UpdateResultStore } from './update-results';
import { TaskScopeStore, TaskState, TaskFile, taskPath } from './task-scope';
import { TagEntry, TagPage, TagQuery, TagStateChangedError } from './types';
import { TreeEntry, TreePage, TreeQuery, TreeStateChangedError, MergeState, MergeStateChangedError } from './types';

const READ_LIMIT = 8 * 1024 * 1024;
const CONTENT_LIMIT = 5 * 1024 * 1024;
const DISCARD_LINE_APPLY = ['--no-replace-objects','-c','apply.ignoreWhitespace=no','-c','core.autocrlf=false','-c','core.eol=lf','apply','--whitespace=nowarn','--unidiff-zero','-p1'];
const ACTIONS = new Set<Action>(['forkResetPreferred', 'forkSmartGit', 'forkResetDev', 'merge', 'beginMerge', 'abortMerge', 'discardLines', 'discardFiles', 'restoreFiles', 'restoreStashFiles', 'stage', 'unstage', 'stageLines', 'unstageLines', 'resolveConflict', 'commitSelected', 'commit', 'amendCommit', 'finishMerge', 'addRemote', 'setRemoteUrl', 'setRemotePushUrl', 'resetRemotePushUrl', 'fetch', 'fetchAll', 'updateAll', 'push', 'pull', 'switch', 'createBranch', 'createBranchAt', 'renameBranch', 'deleteBranch', 'setUpstream', 'unsetUpstream', 'checkoutRemote', 'createTag', 'deleteTag', 'stashPush', 'stashSelected', 'stashApply', 'stashDrop', 'syncSubmodules', 'lfsFetch']);
const WORKTREE_ACTIONS = new Set(['forkResetPreferred', 'forkSmartGit', 'forkResetDev', 'updateAll', 'merge', 'beginMerge', 'abortMerge', 'discardLines', 'discardFiles', 'restoreFiles', 'restoreStashFiles', 'pull', 'switch', 'createBranch', 'checkoutRemote', 'stashPush', 'stashSelected', 'stashApply', 'syncSubmodules']);
const HASH = /^[a-f0-9]{40,64}$/;
const STAGED = (f: ChangedFile) => f.index !== ' ' && f.index !== '?';
const UNSTAGED = (f: ChangedFile) => f.worktree !== ' ' && f.worktree !== '!';

function redact(s: string): string {
    return s.replace(/(https?:\/\/)[^\s/]+@/g, '$1***@').replace(/([?&](?:token|access_token|password)=)[^\s&]+/gi, '$1***');
}
function message(e: unknown): string { return e instanceof Error ? e.message : String(e); }
interface ContentVariant { lfs?: 'history' | 'compare'; plainUtf8Notice?: boolean; }
function inside(root: string, value: string): boolean {
    const rel = path.relative(root, value);
    return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
function sha(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }

export function parseStatus(raw: string, gitlinks = new Set<string>()): ChangedFile[] {
    const fields = raw.split('\0');
    const files: ChangedFile[] = [];
    for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        if (!field) continue;
        const index = field[0] || ' ', worktree = field[1] || ' ';
        const file: ChangedFile = { path: field.slice(3), index, worktree, conflict: index === 'U' || worktree === 'U' || ['AA', 'DD'].includes(index + worktree), submodule: gitlinks.has(field.slice(3)) };
        if ('RC'.includes(index) || 'RC'.includes(worktree)) file.oldPath = fields[++i];
        files.push(file);
    }
    return files;
}

interface CommandResult { code: number; stdout: Buffer; stderr: string; }
interface MergeSession { native?: true; schema: 1; phase: 'prepared' | 'active'; nonce: string; head: string; target: string; base: string; branch: string; index: string; policy: string; paths: string; }
interface StoredPlan { expectedTree?: string; forkTool?: ForkToolPreview; projectUpdate?: ProjectUpdatePreview; public: Plan; request: OperationRequest; root: string; fingerprint: string; scope: string; remote?: string; target?: string; destination?: string; stashVersion?: string; branchState?: string; amendState?: string; tagPayload?: string; mergeState?: string; recoveryState?: string; bytes: number; }
interface HistorySession { root: string; scope: HistoryQuery['scope']; tips: string[]; labels: Record<string, string[]>; skip: number; expires: number; shallow: string; filters: string; search?: HistorySearch; path?: string; }
interface LinePatch { version: string; parsed?: ParsedPatch; reason?: string; }
interface TreeChange extends ChangedFile { beforeMode: string; afterMode: string; beforeObject: string; afterObject: string; }
type SyncReferences = Pick<SyncPage, 'state' | 'branch' | 'head' | 'upstreamRef' | 'upstreamHead' | 'remote'>;
interface SyncSession { root: string; expires: number; boundary: string; metadata: Omit<SyncPage, 'direction' | 'start' | 'nextStart' | 'commits'>; }

import { checkMeta, MetaCheckOptions, MetaCheckResult } from './meta-check';
import { auditLanguageKeys, LanguageKeyOptions, LanguageKeyAudit } from './language-keys';
import { t, MessageError } from './i18n';
export class GitDesk {
    private root = '';
    private repositories: Repository[] = [];
    private plans = new Map<string, StoredPlan>();
    private taskState: Task | null = null;
    private readonly updateResults: UpdateResultStore;
    private lastProjectUpdate?: Task;
    private fetchedAt: Record<string, string> = {};
    private scanPromise: Promise<Repository[]> | null = null;
    private scanScope?: string;
    private scopedReadTimes = new Map<string, number>();
    private lastScan = 0;
    private indexVersions = new WeakMap<Repository, string>();
    private diffPairTail: Promise<void> = Promise.resolve();
    private histories = new Map<string, HistorySession>();
    private syncSessions = new Map<string, SyncSession>();
    private mergeReads = new Map<string, Promise<MergeState>>();
    private reflogReads = new Map<string, Promise<{ raw: string; available: boolean }>>();
    private tagReads = new Map<string, Promise<string>>();
    private fileComparisons = new Map<string, { value: FileDiff & { comparison: FileComparisonInfo }; bytes: number; expires: number }>();
    private fileComparisonTimer?: ReturnType<typeof setTimeout>;
    private fileComparisonReads = new Map<string, Promise<FileDiff & { comparison: FileComparisonInfo }>>();
    private worktreeComparisonReads = new Map<string, Promise<FileDiff & { worktreeComparison: WorktreeComparisonInfo }>>();
    private indexComparisonReads = new Map<string, Promise<FileDiff & { indexComparison: IndexComparisonInfo }>>();
    private remoteReads = new Map<string, Promise<RemotePage>>();
    private mergeSessions: DraftStore;
    private drafts: DraftStore;
    private recovery: RecoveryStore;

    constructor(readonly project: string, readonly cache: string, readonly host: Host, readonly settingsCache = cache) {
        this.mergeSessions=new DraftStore(path.join(cache,'merge-sessions')); this.drafts = new DraftStore(cache); this.recovery = new RecoveryStore();
        this.updateResults = new UpdateResultStore(cache, project); this.lastProjectUpdate = this.updateResults.read();
    }

    private metricsContext = new AsyncLocalStorage<OperationMetrics>();

    private async git(cwd: string, args: string[], options: { allowed?: number[]; input?: string | Buffer; timeout?: number; log?: boolean; indexFile?: string } = {}): Promise<CommandResult> {
        const gitPath = process.env.COCOS_GIT_DESK_GIT || 'git';
        const searchPath = process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || ''].join(path.delimiter) : process.env.PATH;
        const environment = { ...process.env };
        // Creator may be launched from a shell with Git variables for a different checkout.
        for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_GRAFT_FILE', 'GIT_SHALLOW_FILE']) delete environment[key];
        const metrics = this.metricsContext.getStore(), started = Date.now();
        if (metrics) metrics.gitCalls++;
        let commandIndex = 0;
        while (args[commandIndex]?.startsWith('-')) commandIndex += args[commandIndex] === '-c' ? 2 : 1;
        const networkCommand = ['fetch', 'push', 'ls-remote'].includes(args[commandIndex] || '') || args[commandIndex] === 'lfs' && args[commandIndex + 1] === 'fetch';
        return new Promise<CommandResult>((resolve, reject) => {
            const child = spawn(gitPath, ['--no-pager', '--literal-pathspecs', '-c', 'color.ui=false', '-c', 'core.quotepath=false', ...args], {
                cwd, shell: false, windowsHide: true,
                env: { ...environment, PATH: searchPath, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', LC_ALL: 'C', ...(options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}) },
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            const chunks: Buffer[] = [];
            let stderr = '', size = 0, failure = '';
            let killTimer: ReturnType<typeof setTimeout> | undefined;
            const terminate = (reason: string) => {
                if (failure) return;
                failure = reason;
                child.kill('SIGTERM');
                killTimer = setTimeout(() => child.kill('SIGKILL'), 2500);
            };
            const timer = setTimeout(() => terminate(t('git.timeout')), options.timeout || 30000);
            child.stdout.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > READ_LIMIT) terminate(t('git.outputTooLarge'));
                else chunks.push(chunk);
                if (options.log) this.log(chunk.toString('utf8'));
            });
            child.stderr.on('data', (chunk: Buffer) => {
                stderr = (stderr + chunk.toString('utf8')).slice(-50000);
                if (options.log) this.log(chunk.toString('utf8'));
            });
            child.on('error', e => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); reject(new MessageError('git.cannotRun', { error: message(e) })); });
            child.stdin.on('error', e => { if ((e as NodeJS.ErrnoException).code !== 'EPIPE') terminate(message(e)); });
            child.on('close', code => {
                clearTimeout(timer);
                if (killTimer) clearTimeout(killTimer);
                const result = { code: code ?? -1, stdout: Buffer.concat(chunks), stderr: redact(stderr) };
                if (failure) reject(new Error(failure));
                else if (!(options.allowed || [0]).includes(result.code)) reject(new Error(result.stderr.trim() || t('git.exitCode', { command: args[0], code: result.code })));
                else resolve(result);
            });
            child.stdin.end(options.input);
        }).finally(() => { if (metrics) { const elapsed = Date.now() - started; metrics.gitMs += elapsed; if (networkCommand) metrics.networkGitMs += elapsed; } });
    }

    private async text(cwd: string, args: string[], allowed?: number[]): Promise<string> {
        return (await this.git(cwd, args, { allowed })).stdout.toString('utf8').trimEnd();
    }

    private log(value: string): void {
        if (this.taskState) this.taskState.log = (this.taskState.log + redact(value)).slice(-100000);
    }

    private async links(repo: string): Promise<Map<string, string>> {
        const result = await this.git(repo, ['ls-files', '--stage', '-z']);
        const links = new Map<string, string>();
        for (const record of result.stdout.toString('utf8').split('\0')) {
            const m = /^160000 ([a-f0-9]+) 0\t([\s\S]+)$/.exec(record);
            if (m?.[1] && m[2]) links.set(m[2], m[1]);
        }
        return links;
    }

    private async readRepo(repo: string, parent?: string, expected?: string, collectedLinks?: Map<string, string>): Promise<Repository> {
        const id = path.relative(this.root, repo).split(path.sep).join('/') || '.';
        const result: Repository = { id, path: repo, name: id === '.' ? path.basename(repo) : path.basename(repo), parent, expected, head: '', branch: '', upstream: '', ahead: 0, behind: 0, initialized: false, files: [], version: '', operation: '' };
        try {
            const exists = await fs.lstat(path.join(repo, '.git')).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
            if (!exists) return result;
            const real = await fs.realpath(repo);
            if (!inside(this.root, real) || real !== repo) throw new MessageError('git.externalSymlink');
            const top = await this.text(repo, ['rev-parse', '--show-toplevel']);
            if (await fs.realpath(top) !== repo) throw new MessageError('git.submoduleNotInitialized');
            result.initialized = true;
            // Older supported Git versions can ignore GIT_NO_LAZY_FETCH. Reject
            // partial clones before reading objects or status to keep reads local.
            const partial = await this.git(repo, ['config', '--get', 'extensions.partialClone'], { allowed: [0, 1] });
            const promisors = await this.text(repo, ['config', '--type=bool', '--get-regexp', '^remote\\..*\\.promisor$'], [0, 1]);
            if (partial.code === 0 || /\s+true$/m.test(promisors)) throw new MessageError('git.partialClone');
            const gitDir = await this.text(repo, ['rev-parse', '--absolute-git-dir']);
            const readIndex = () => fs.readFile(path.join(gitDir, 'index')).catch(e => { if (e.code === 'ENOENT') return Buffer.alloc(0); throw e; });
            const initialIndex = await readIndex();
            const links = await this.links(repo);
            for (const [child, target] of links) collectedLinks?.set(child, target);
            const status = await this.git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']);
            result.files = parseStatus(status.stdout.toString('utf8'), new Set(links.keys()));
            const headRef = await this.text(repo, ['symbolic-ref', '--quiet', 'HEAD'], [0, 1]);
            result.branch = headRef.startsWith('refs/heads/') ? headRef.slice(11) : '';
            result.head = await this.text(repo, ['rev-parse', '--verify', 'HEAD'], [0, 128]);
            const upstream = await this.git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { allowed: [0, 128] });
            if (upstream.code === 0) {
                result.upstream = upstream.stdout.toString('utf8').trim();
                const counts = await this.text(repo, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
                const [ahead, behind] = counts.split(/\s+/).map(Number);
                result.ahead = ahead || 0; result.behind = behind || 0;
            }
            result.remoteVersion = sha(await this.text(repo, ['for-each-ref', '--format=%(refname) %(objectname) %(symref)', 'refs/remotes']));
            for (const state of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG']) {
                if (await fs.stat(path.join(gitDir, state)).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) result.operation = state;
            }
            const index = await readIndex();
            if (!index.equals(initialIndex)) throw new MessageError('git.indexChangedWhileReading');
            const config = await this.git(repo, ['config', '--local', '--null', '--list']);
            result.version = sha(status.stdout.toString('utf8') + result.head + result.branch + result.upstream + result.operation + sha(index) + sha(config.stdout));
            this.indexVersions.set(result, sha(result.head + result.branch + result.operation + sha(index) + sha(config.stdout)));
        } catch (error) { result.error = message(error); }
        return result;
    }

    private async readRepositoryChain(id: string): Promise<Repository[] | undefined> {
        if (!this.repositories.some(repo => repo.id === id)) return undefined;
        let current: Repository | undefined = await this.remoteProbeRepo(id);
        const refreshed = new Map<string, Repository>();
        while (current) {
            const links = new Map<string, string>();
            const fresh = await this.readRepo(current.path, current.parent, current.expected, links);
            if (!fresh.initialized || fresh.error) return undefined;
            const ancestor = current;
            const children = this.repositories.filter(repo => repo.parent === ancestor.id);
            if (links.size !== children.length || [...links].some(([name, target]) => !children.some(child => child.path === path.resolve(ancestor.path, name) && child.expected === target))) return undefined;
            refreshed.set(current.id, fresh);
            const parent: string | undefined = current.parent;
            current = parent === undefined ? undefined : this.repositories.find(repo => repo.id === parent);
            if (parent !== undefined && !current) return undefined;
        }
        for (const key of refreshed.keys()) this.scopedReadTimes.set(key, Date.now());
        return this.repositories.map(repo => refreshed.get(repo.id) || repo);
    }

    private async scan(force = false, changedRepo?: string): Promise<Repository[]> {
        if (this.scanPromise) {
            if (this.scanScope && this.scanScope !== changedRepo) { await this.scanPromise; return this.scan(force, changedRepo); }
            return this.scanPromise;
        }
        if (!force && !changedRepo && this.repositories.length && Date.now() - this.lastScan < 4000) return this.repositories;
        this.scanScope = changedRepo;
        this.scanPromise = (async () => {
            if (changedRepo) {
                const refreshed = await this.readRepositoryChain(changedRepo);
                // A scoped read must not postpone the next complete project scan.
                if (refreshed) { this.repositories = refreshed; return refreshed; }
            }
            this.scanScope = undefined;
            const top = await this.text(this.project, ['rev-parse', '--show-toplevel']);
            this.root = await fs.realpath(top);
            let count = 0, active = 0;
            const waiting: Array<() => void> = [];
            const visit = async (repo: string, parent?: string, expected?: string): Promise<Repository[]> => {
                if (++count > 100) throw new MessageError('git.tooManyRepos');
                if (!inside(this.root, repo)) throw new MessageError('git.submoduleOutside');
                if (active >= 2) await new Promise<void>(resolve => waiting.push(resolve)); else active++;
                let current: Repository;
                const links = new Map<string, string>();
                try {
                    current = await this.readRepo(repo, parent, expected, links);
                    if (!current.initialized || current.error) links.clear();
                } finally {
                    const next = waiting.shift();
                    if (next) next(); else active--;
                }
                // Drain every sibling before releasing scanPromise, even if one subtree fails.
                const children = await Promise.allSettled([...links].map(([child, target]) => visit(path.resolve(repo, child), current.id, target)));
                const failed = children.find((child): child is PromiseRejectedResult => child.status === 'rejected');
                if (failed) throw failed.reason;
                return [current, ...children.flatMap(child => child.status === 'fulfilled' ? child.value : [])];
            };
            const results = await visit(this.root);
            this.repositories = results;
            this.scopedReadTimes.clear();
            this.lastScan = Date.now();
            return results;
        })();
        try { return await this.scanPromise; } finally { this.scanPromise = null; this.scanScope = undefined; }
    }

    async snapshot(force = false, changedRepo?: string): Promise<Snapshot> {
        const repositories = this.taskState?.status === 'running' && this.repositories.length ? this.repositories : await this.scan(force, changedRepo);
        const lastProjectUpdate = this.lastProjectUpdate ? { ...this.lastProjectUpdate, repositories: this.lastProjectUpdate.repositories?.map(row => ({ ...row })) } : undefined;
        return { project: this.project, root: this.root, repositories, task: this.task(), lastProjectUpdate, fetchedAt: { ...this.fetchedAt } };
    }

    private async repo(id: string, fresh = false): Promise<Repository> {
        const recent = !fresh && !this.scanPromise && Date.now() - (this.scopedReadTimes.get(id) || 0) < 4000;
        const repo = (recent ? this.repositories : await this.scan(fresh)).find(r => r.id === id);
        if (!repo?.initialized || repo.error) throw new Error(repo?.error || t('git.notInitializedSync'));
        return repo;
    }

    private localIndexAction(action?: Action): boolean {
        return action === 'stage' || action === 'unstage' || action === 'commit' || action === 'commitSelected';
    }

    private async scopedRepo(id: string): Promise<Repository> {
        const repo = (await this.scan(true, id)).find(item => item.id === id);
        if (!repo?.initialized || repo.error) throw new Error(repo?.error || t('git.notInitialized'));
        return repo;
    }

    private operationRepo(id: string, action: Action): Promise<Repository> {
        return this.localIndexAction(action) ? this.scopedRepo(id) : this.repo(id, true);
    }

    // AgentBridge delegates validation here so prepare owns a single fresh snapshot.
    async prepareValidated(request: OperationRequest): Promise<Plan> { return this.prepare(request); }

    private async repoForDiff(id: string): Promise<Repository> {
        const recent = Date.now() - Math.max(this.lastScan, this.scopedReadTimes.get(id) || 0) < 4000;
        const known = this.repositories.find(repo => repo.id === id);
        if ((!this.scanPromise && recent) || !known?.initialized || known.error) return this.repo(id);
        const repo = (await this.scan(false, id)).find(repo => repo.id === id);
        if (!repo?.initialized || repo.error) throw new Error(repo?.error || t('git.notInitializedSync'));
        return repo;
    }

    private treePath(repo: Repository, value: unknown, root = false): string {
        if (typeof value !== 'string' || value.length > 4096 || (!value && !root) || value.includes('\0')) throw new MessageError('git.tree.invalidPath');
        if (!value && root) return '';
        if (value.split('/').some(part => !part || part === '.' || part === '..')) throw new MessageError('git.tree.pathNotNormalized');
        this.safePath(repo, value);
        return value;
    }

    private treeEntries(raw: Buffer, directory = ''): TreeEntry[] {
        const fields = this.utf8(raw).split('\0').filter(Boolean);
        if (fields.length > 20000) throw new MessageError('git.tree.tooManyEntries');
        return fields.map(field => {
            const match = /^(040000|100644|100755|120000|160000) (tree|blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/.exec(field);
            if (!match) throw new MessageError('git.tree.unparsable');
            const mode = match[1]!, type = match[2]!, object = match[3]!, name = match[4]!;
            if ((mode === '040000' ? type !== 'tree' : mode === '160000' ? type !== 'commit' : type !== 'blob') || name === '.' || name === '..' || name.includes('/')) throw new MessageError('git.tree.invalidEntry');
            return { name, path: directory ? directory + '/' + name : name, mode, object,
                type: mode === '040000' ? 'tree' : mode === '160000' ? 'commit' : 'blob',
                kind: mode === '040000' ? 'directory' : mode === '160000' ? 'submodule' : mode === '120000' ? 'symlink' : mode === '100755' ? 'executable' : 'file' };
        });
    }

    async tree(id: string, query: TreeQuery): Promise<TreePage> {
        if (!query || query.kind !== 'tree' || Object.keys(query).some(key => !['kind', 'revision', 'directory', 'text', 'offset', 'limit', 'version'].includes(key))) throw new MessageError('git.tree.invalidQuery');
        const { offset = 0, limit = 100, text = '', version } = query;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200 || typeof text !== 'string' || text.length > 4096 || text.includes('\0') || (version !== undefined && (typeof version !== 'string' || !version || version.length > 256))) throw new MessageError('git.tree.invalidPaging');
        if (this.task()?.status === 'running') throw new MessageError('git.tree.taskRunning');
        const repo = await this.repo(id), revision = await this.revision(repo, query.revision, true);
        const directory = this.treePath(repo, query.directory === undefined ? '' : query.directory, true);
        const tree = await this.text(repo.path, ['--no-replace-objects', 'rev-parse', '--verify', '--end-of-options', directory ? `${revision}:${directory}` : revision + '^{tree}']);
        if (!HASH.test(tree) || await this.text(repo.path, ['--no-replace-objects', 'cat-file', '-t', tree]) !== 'tree') throw new MessageError('git.tree.notDirectory');
        const raw = (await this.git(repo.path, ['--no-replace-objects', 'ls-tree', '-z', tree])).stdout;
        const entries = this.treeEntries(raw, directory), needle = text.toLowerCase();
        const matches = entries.filter(entry => entry.name.toLowerCase().includes(needle));
        matches.sort((left, right) => Number(right.kind === 'directory') - Number(left.kind === 'directory') || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
        const currentVersion = sha(JSON.stringify([repo.id, repo.path, revision, directory, tree, needle]));
        if ((offset > 0 && !version) || (version !== undefined && version !== currentVersion)) throw new TreeStateChangedError(t('git.tree.changed'));
        if (this.task()?.status === 'running') throw new MessageError('git.taskStartedWhileReading');
        return { repo: id, revision, directory, tree, version: currentVersion, offset, limit, entries: matches.slice(offset, offset + limit), total: matches.length, nextOffset: offset + limit < matches.length ? offset + limit : undefined };
    }

    private fileRevision(value: FileRevision): FileRevision {
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['revision', 'path'].includes(key)) || typeof value.revision !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.revision) || typeof value.path !== 'string' || !value.path || value.path.length > 4096 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value.path)) throw new MessageError('git.history.invalidRevisionPath');
        return { revision: value.revision, path: value.path };
    }

    private async historicalFile(repo: Repository, source: FileRevision, rawContent = false): Promise<{ snapshot: FileSnapshot; content: FileContent }> {
        const revision = await this.revision(repo, source.revision, true), name = this.treePath(repo, source.path);
        const slash = name.lastIndexOf('/'), directory = slash < 0 ? '' : name.slice(0, slash), leaf = name.slice(slash + 1);
        const parent = await this.text(repo.path, ['--no-replace-objects', 'rev-parse', '--verify', '--end-of-options', directory ? `${revision}:${directory}` : revision + '^{tree}']);
        if (!HASH.test(parent) || await this.text(repo.path, ['--no-replace-objects', 'cat-file', '-t', parent]) !== 'tree') throw new MessageError('git.history.parentUnavailable');
        const raw = (await this.git(repo.path, ['--no-replace-objects', 'ls-tree', '-z', parent, '--', leaf])).stdout;
        const entry = this.treeEntries(raw, directory).find(entry => entry.path === name);
        if (!entry) throw new MessageError('git.history.pathNotInCommit');
        if (entry.kind === 'directory') throw new MessageError('git.history.chooseFile');
        let after: FileContent;
        if (entry.kind === 'submodule') after = { notice: t('git.history.submodulePointer', { object: entry.object }) };
        else {
            const size = Number(await this.text(repo.path, ['--no-replace-objects', 'cat-file', '-s', entry.object]));
            if (!Number.isSafeInteger(size) || size < 0) throw new MessageError('git.history.invalidSize');
            if (size > CONTENT_LIMIT) after = { notice: t('git.history.tooLarge', { size }) };
            else {
                const buffer = (await this.git(repo.path, ['--no-replace-objects', 'cat-file', 'blob', entry.object])).stdout;
                after = entry.kind === 'symlink' ? { text: this.utf8(buffer) } : rawContent ? await this.rawComparisonContent(repo, name, buffer, 'history') : await this.content(repo, name, buffer, true, undefined, { lfs: 'history' });
            }
        }
        return { snapshot: { revision, path: name, object: entry.object, mode: entry.mode, kind: entry.kind }, content: after };
    }

    private async treeFile(repo: Repository, request: DiffRequest): Promise<FileDiff> {
        const { snapshot, content } = await this.historicalFile(repo, { revision: request.revision || '', path: request.path });
        return { path: snapshot.path, before: { notice: t('git.history.snapshotNotice') }, after: content, patch: '', summary: t('git.history.snapshotSummary', { revision: snapshot.revision, object: snapshot.object, mode: snapshot.mode, symlink: snapshot.kind === 'symlink' ? t('git.history.symlinkNote') : '' }) };
    }

    private expireFileComparisons(): void {
        if (this.fileComparisonTimer) clearTimeout(this.fileComparisonTimer);
        this.fileComparisonTimer = undefined;
        for (const [key, item] of this.fileComparisons) if (item.expires <= Date.now()) this.fileComparisons.delete(key);
        if (this.fileComparisons.size) {
            const due = Math.min(...[...this.fileComparisons.values()].map(item => item.expires));
            this.fileComparisonTimer = setTimeout(() => this.expireFileComparisons(), Math.max(1, due - Date.now()));
            this.fileComparisonTimer.unref();
        }
    }

    private async fileComparison(repo: Repository, leftValue: FileRevision, rightValue: FileRevision, force = false): Promise<FileDiff & { comparison: FileComparisonInfo }> {
        const left = this.fileRevision(leftValue), right = this.fileRevision(rightValue);
        this.treePath(repo, left.path); this.treePath(repo, right.path);
        if (this.task()?.status === 'running') throw new MessageError('git.compare.taskRunning');
        const key = sha(JSON.stringify([repo.path, left, right]));
        this.expireFileComparisons();
        const copy = (value: FileDiff & { comparison: FileComparisonInfo }): FileDiff & { comparison: FileComparisonInfo } => ({ ...value, before: { ...value.before }, after: { ...value.after }, comparison: { ...value.comparison, left: { ...value.comparison.left }, right: { ...value.comparison.right } } });
        if (force) this.fileComparisons.delete(key);
        const cached = this.fileComparisons.get(key);
        if (cached) return copy(cached.value);
        let reading = this.fileComparisonReads.get(key);
        if (!reading) {
            if (this.fileComparisonReads.size + this.worktreeComparisonReads.size + this.indexComparisonReads.size >= 2) throw new MessageError('git.compare.tooManyQueries');
            reading = this.readFileComparison(repo, left, right);
            this.fileComparisonReads.set(key, reading);
        }
        try {
            const value = await reading;
            if (this.task()?.status === 'running') throw new MessageError('git.compare.taskStartedRereadFile');
            const bytes = 2 * [value.before.text, value.before.image, value.before.notice, value.after.text, value.after.image, value.after.notice, value.patch, value.summary].reduce<number>((sum, text) => sum + (text?.length || 0), 2048 + JSON.stringify(value.comparison).length);
            if (bytes <= READ_LIMIT && !this.fileComparisons.has(key)) {
                let retained = [...this.fileComparisons.values()].reduce((sum, item) => sum + item.bytes, 0);
                while (this.fileComparisons.size >= 4 || retained + bytes > READ_LIMIT) {
                    const oldest = this.fileComparisons.keys().next().value!;
                    retained -= this.fileComparisons.get(oldest)!.bytes; this.fileComparisons.delete(oldest);
                }
                this.fileComparisons.set(key, { value, bytes, expires: Date.now() + 10000 });
                this.expireFileComparisons();
            }
            return copy(value);
        } finally { if (this.fileComparisonReads.get(key) === reading) this.fileComparisonReads.delete(key); }
    }

    private async readFileComparison(repo: Repository, left: FileRevision, right: FileRevision): Promise<FileDiff & { comparison: FileComparisonInfo }> {
        const before = await this.historicalFile(repo, left);
        const after = left.revision === right.revision && left.path === right.path ? before : await this.historicalFile(repo, right);
        const summary = t('git.compare.revisionsSummary', { revision: before.snapshot.revision, path: before.snapshot.path, object: before.snapshot.object, mode: before.snapshot.mode, revision2: after.snapshot.revision, path2: after.snapshot.path, object2: after.snapshot.object, mode2: after.snapshot.mode });
        const size = Buffer.byteLength(before.content.text || '') + Buffer.byteLength(after.content.text || '');
        let diff: FileDiff;
        if (size > 2 * 1024 * 1024) diff = { path: right.path, before: before.content, after: after.content, patch: '', summary, patchNotice: t('git.compare.textTooLargeSeparately') };
        else if (before.content.text !== undefined && before.content.text === after.content.text) diff = { path: right.path, before: before.content, after: after.content, patch: '', summary };
        else diff = await this.renderFileDiff(repo, right.path, before.content, after.content, summary, left.path);
        if (before.content.text === undefined || after.content.text === undefined) diff.patchNotice = t('git.compare.notTextSide');
        const contentKey = (content: FileContent) => [content.lfs === true, sha(content.text ?? content.image ?? content.notice ?? '')];
        const version = sha(JSON.stringify([before.snapshot, after.snapshot, contentKey(diff.before), contentKey(diff.after), sha(diff.patch), diff.patchNotice]));
        return { ...diff, comparison: { version, left: before.snapshot, right: after.snapshot } };
    }

    async compareFilePage(id: string, query: FileCompareQuery): Promise<FileComparePage> {
        if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key => !['left', 'right', 'view', 'offset', 'limit', 'version', 'force'].includes(key))) throw new MessageError('git.compare.invalidQuery');
        const { view = 'summary', offset = 0, limit = 8000, version, force = false } = query;
        if (!['summary', 'patch', 'before', 'after'].includes(view) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 16000 || typeof force !== 'boolean' || (version !== undefined && (typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version)))) throw new MessageError('git.compare.invalidRange');
        if (view === 'summary' && offset !== 0) throw new MessageError('agent.summaryNoOffset');
        if (offset > 0 && !version) throw new FileComparisonStateChangedError(t('git.compare.needFirstVersion'));
        const repo = await this.repo(id), result = await this.fileComparison(repo, query.left, query.right, force);
        if ((offset > 0 && !version) || (version !== undefined && version !== result.comparison.version)) throw new FileComparisonStateChangedError(t('git.compare.contentChanged'));
        const content = view === 'before' ? result.before : result.after;
        const text = view === 'summary' ? '' : view === 'patch' ? result.patchNotice || result.patch : content.text || '';
        const metadata = (content: FileContent): FileComparePage['before'] => ({ kind: content.text !== undefined ? 'text' : content.image !== undefined ? 'image' : 'notice', characters: content.text?.length || 0, lfs: content.lfs === true, notice: content.notice });
        return { repo: id, comparison: result.comparison, summary: result.summary || '', view, before: metadata(result.before), after: metadata(result.after),
            patchAvailable: !result.patchNotice, patchNotice: result.patchNotice, text: text.slice(offset, offset + limit), offset, limit, total: text.length, nextOffset: offset + limit < text.length ? offset + limit : undefined, cachedUpToMs: 10000 };
    }

    private async rawComparisonContent(repo: Repository, name: string, buffer: Buffer, lfs?: ContentVariant['lfs']): Promise<FileContent> {
        if (/^version https:\/\/git-lfs.github.com\/spec\/v1\r?\n/.test(buffer.subarray(0, 128).toString('utf8'))) return { lfs: true, notice: t('git.compare.lfsPointerRaw') };
        return this.content(repo, name, buffer, true, undefined, { lfs, plainUtf8Notice: true });
    }

    private async readWorktreeComparison(repo: Repository, left: FileRevision, name: string): Promise<FileDiff & { worktreeComparison: WorktreeComparisonInfo }> {
        const disk = await this.recovery.readDisk(repo.path, name, CONTENT_LIMIT);
        const before = await this.historicalFile(repo, left, true);
        if (before.snapshot.kind !== 'file' && before.snapshot.kind !== 'executable') throw new MessageError('git.compare.worktreePlainOnly');
        const after = disk.bytes === undefined ? { text: '' } : await this.rawComparisonContent(repo, name, disk.bytes);
        const right = { path: name, kind: disk.stamp.exists ? 'file' as const : 'missing' as const, hash: disk.stamp.hash, mode: disk.stamp.mode, size: disk.stamp.size };
        const summary = t('git.compare.worktreeSummary', { revision: before.snapshot.revision, path: left.path, object: before.snapshot.object, mode: before.snapshot.mode, name, value: right.kind === 'missing' ? t('git.compare.pathMissing') : t('git.compare.diskSizeMode', { size: right.size, mode: right.mode.toString(8) }), hash: right.hash });
        const size = Buffer.byteLength(before.content.text || '') + Buffer.byteLength(after.text || '');
        let diff: FileDiff;
        if (size > 2 * 1024 * 1024) diff = { path: name, before: before.content, after, patch: '', summary, patchNotice: t('git.compare.textTooLarge') };
        else if (before.content.text !== undefined && before.content.text === after.text) diff = { path: name, before: before.content, after, patch: '', summary };
        else diff = await this.renderFileDiff(repo, name, before.content, after, summary, left.path);
        if (before.content.text === undefined || after.text === undefined) diff.patchNotice = t('git.compare.notTextSideLfs');
        const contentKey = (value: FileContent) => [value.lfs === true, sha(value.text ?? value.image ?? value.notice ?? '')];
        const version = sha(JSON.stringify([before.snapshot, right, contentKey(diff.before), contentKey(diff.after), sha(diff.patch), diff.patchNotice]));
        return { ...diff, worktreeComparison: { version, left: before.snapshot, right, diskOnly: true, normalization: 'raw' } };
    }

    private async worktreeComparison(repo: Repository, leftValue: FileRevision, pathValue: string): Promise<FileDiff & { worktreeComparison: WorktreeComparisonInfo }> {
        const left = this.fileRevision(leftValue);
        const name = this.treePath(repo, this.fileRevision({ revision: left.revision, path: pathValue }).path);
        this.treePath(repo, left.path);
        if (this.task()?.status === 'running') throw new MessageError('git.compare.taskRunningWorktree');
        const key = sha(JSON.stringify([repo.path, left, name]));
        let reading = this.worktreeComparisonReads.get(key);
        if (!reading) {
            if (this.fileComparisonReads.size + this.worktreeComparisonReads.size + this.indexComparisonReads.size >= 2) throw new MessageError('git.compare.tooManyQueries');
            reading = this.readWorktreeComparison(repo, left, name);
            this.worktreeComparisonReads.set(key, reading);
        }
        try {
            const value = await reading, disk = await this.recovery.readDisk(repo.path, name, CONTENT_LIMIT), right = value.worktreeComparison.right;
            if (this.task()?.status === 'running') throw new FileComparisonStateChangedError(t('git.compare.taskStartedReread'));
            if (disk.stamp.hash !== right.hash || disk.stamp.mode !== right.mode || disk.stamp.size !== right.size || disk.stamp.exists !== (right.kind === 'file')) throw new FileComparisonStateChangedError(t('git.compare.diskChanged'));
            return { ...value, before: { ...value.before }, after: { ...value.after }, worktreeComparison: { ...value.worktreeComparison, left: { ...value.worktreeComparison.left }, right: { ...right } } };
        } finally { if (this.worktreeComparisonReads.get(key) === reading) this.worktreeComparisonReads.delete(key); }
    }

    async compareWorktreePage(id: string, query: WorktreeCompareQuery): Promise<WorktreeComparePage> {
        if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key => !['left', 'path', 'view', 'offset', 'limit', 'version'].includes(key))) throw new MessageError('git.compare.invalidWorktreeQuery');
        const { view = 'summary', offset = 0, limit = 8000, version } = query;
        if (!['summary', 'patch', 'before', 'after'].includes(view) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 16000 || (version !== undefined && (typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version)))) throw new MessageError('git.compare.invalidWorktreeRange');
        if (view === 'summary' && offset !== 0) throw new MessageError('agent.summaryNoOffset');
        if (offset > 0 && !version) throw new FileComparisonStateChangedError(t('git.compare.needFirstVersion'));
        const repo = await this.repo(id), result = await this.worktreeComparison(repo, query.left, query.path);
        if (version !== undefined && version !== result.worktreeComparison.version) throw new FileComparisonStateChangedError(t('git.compare.diskOrResultChanged'));
        const content = view === 'before' ? result.before : result.after;
        const text = view === 'summary' ? '' : view === 'patch' ? result.patchNotice || result.patch : content.text || '';
        const metadata = (value: FileContent): FileComparePage['before'] => ({ kind: value.text !== undefined ? 'text' : value.image !== undefined ? 'image' : 'notice', characters: value.text?.length || 0, lfs: value.lfs === true, notice: value.notice });
        return { repo: id, comparison: result.worktreeComparison, summary: result.summary || '', view, before: metadata(result.before), after: metadata(result.after),
            patchAvailable: !result.patchNotice, patchNotice: result.patchNotice, text: text.slice(offset, offset + limit), offset, limit, total: text.length, nextOffset: offset + limit < text.length ? offset + limit : undefined, cachedUpToMs: 0 };
    }


    private async indexComparisonState(repo: Repository, name: string) {
        const state = await this.conflictIndex(repo, name);
        if (state.entries.some(entry => entry.path === name && entry.stage !== 0)) throw new MessageError('git.compare.indexConflict');
        if ((state.raw && !state.raw.endsWith('\0')) || state.entries.length > 1 || state.entries.some(entry => entry.path !== name)) throw new MessageError('git.compare.indexAmbiguous');
        const entry = state.entries[0];
        if (entry) {
            if (!['100644', '100755'].includes(entry.mode) || /^0+$/.test(entry.object)) throw new MessageError('git.compare.indexPlainOnly');
            const empty = createHash(entry.object.length === 40 ? 'sha1' : 'sha256').update('blob 0\0').digest('hex');
            if (entry.object === empty) {
                const args = ['--no-replace-objects', 'diff', '--cached', '--raw', '--no-abbrev', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-relative', '--ignore-submodules=none', '-z'];
                const visible = (await this.git(repo.path, [...args, '--ita-visible-in-index', '--', name])).stdout;
                const invisible = (await this.git(repo.path, [...args, '--ita-invisible-in-index', '--', name])).stdout;
                if (!visible.equals(invisible)) throw new MessageError('git.compare.intentToAdd');
            }
        }
        return { entry, version: sha(state.raw) };
    }

    private async readIndexComparison(repo: Repository, left: FileRevision, name: string): Promise<FileDiff & { indexComparison: IndexComparisonInfo }> {
        const state = await this.indexComparisonState(repo, name), before = await this.historicalFile(repo, left, true);
        if (!['file', 'executable'].includes(before.snapshot.kind)) throw new MessageError('git.compare.indexHistoryPlainOnly');
        let after: FileContent = { text: '' }, size = 0;
        if (state.entry) {
            const metadata = (await this.git(repo.path, ['--no-replace-objects', 'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: state.entry.object + '\n' })).stdout.toString('utf8').trim();
            const parsed = /^([a-f0-9]+) blob ([0-9]+)$/.exec(metadata);
            size = Number(parsed?.[2]);
            if (!parsed || parsed[1] !== state.entry.object || !Number.isSafeInteger(size) || size < 0) throw new MessageError('git.compare.indexObjectInvalid');
            if (size > CONTENT_LIMIT) after = { notice: t('git.compare.indexTooLarge', { size }) };
            else {
                const bytes = (await this.git(repo.path, ['--no-replace-objects', 'cat-file', 'blob', state.entry.object])).stdout;
                if (bytes.length !== size) throw new MessageError('git.compare.indexObjectIncomplete');
                after = await this.rawComparisonContent(repo, name, bytes);
            }
        }
        const right: IndexSnapshot = { path: name, kind: state.entry ? 'file' : 'missing', object: state.entry?.object, mode: state.entry?.mode || '000000', stage: 0, entryVersion: state.version, size };
        const summary = t('git.compare.indexSummary', { revision: before.snapshot.revision, path: left.path, object: before.snapshot.object, mode: before.snapshot.mode, name, value: right.kind === 'missing' ? t('git.compare.notInIndex') : t('git.compare.indexObjectMode', { object: right.object, mode: right.mode, size }) });
        const textSize = Buffer.byteLength(before.content.text || '') + Buffer.byteLength(after.text || '');
        let diff: FileDiff;
        if (textSize > 2 * 1024 * 1024) diff = { path: name, before: before.content, after, patch: '', summary, patchNotice: t('git.compare.textTooLarge') };
        else if (before.content.text !== undefined && before.content.text === after.text) diff = { path: name, before: before.content, after, patch: '', summary };
        else diff = await this.renderFileDiff(repo, name, before.content, after, summary, left.path);
        if (before.content.text === undefined || after.text === undefined) diff.patchNotice = t('git.compare.notTextSideLfs');
        const contentKey = (value: FileContent) => [value.lfs === true, sha(value.text ?? value.image ?? value.notice ?? '')];
        const version = sha(JSON.stringify([before.snapshot, right, contentKey(diff.before), contentKey(diff.after), sha(diff.patch), diff.patchNotice]));
        return { ...diff, indexComparison: { version, left: before.snapshot, right, indexOnly: true, normalization: 'raw' } };
    }

    private async indexComparison(repo: Repository, leftValue: FileRevision, pathValue: string): Promise<FileDiff & { indexComparison: IndexComparisonInfo }> {
        const left = this.fileRevision(leftValue), name = this.treePath(repo, this.fileRevision({ revision: left.revision, path: pathValue }).path);
        this.treePath(repo, left.path);
        if (this.task()?.status === 'running') throw new MessageError('git.compare.taskRunningIndex');
        const key = sha(JSON.stringify([repo.path, left, name]));
        let reading = this.indexComparisonReads.get(key);
        if (!reading) {
            if (this.fileComparisonReads.size + this.worktreeComparisonReads.size + this.indexComparisonReads.size >= 2) throw new MessageError('git.compare.tooManyQueries');
            reading = this.readIndexComparison(repo, left, name); this.indexComparisonReads.set(key, reading);
        }
        try {
            const value = await reading, state = await this.indexComparisonState(repo, name);
            if (this.task()?.status === 'running' || state.version !== value.indexComparison.right.entryVersion) throw new FileComparisonStateChangedError(t('git.compare.indexChangedOrTask'));
            return { ...value, before: { ...value.before }, after: { ...value.after }, indexComparison: { ...value.indexComparison, left: { ...value.indexComparison.left }, right: { ...value.indexComparison.right } } };
        } finally { if (this.indexComparisonReads.get(key) === reading) this.indexComparisonReads.delete(key); }
    }

    async compareIndexPage(id: string, query: IndexCompareQuery): Promise<IndexComparePage> {
        if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key => !['left', 'path', 'view', 'offset', 'limit', 'version'].includes(key))) throw new MessageError('git.compare.invalidIndexQuery');
        const { view = 'summary', offset = 0, limit = 8000, version } = query;
        if (!['summary', 'patch', 'before', 'after'].includes(view) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 16000 || (version !== undefined && (typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version)))) throw new MessageError('git.compare.invalidIndexRange');
        if (view === 'summary' && offset !== 0) throw new MessageError('agent.summaryNoOffset');
        if (offset > 0 && !version) throw new FileComparisonStateChangedError(t('git.compare.needFirstVersion'));
        const result = await this.indexComparison(await this.repo(id), query.left, query.path);
        if (version !== undefined && version !== result.indexComparison.version) throw new FileComparisonStateChangedError(t('git.compare.indexOrResultChanged'));
        const content = view === 'before' ? result.before : result.after, text = view === 'summary' ? '' : view === 'patch' ? result.patchNotice || result.patch : content.text || '';
        const metadata = (value: FileContent): FileComparePage['before'] => ({ kind: value.text !== undefined ? 'text' : value.image !== undefined ? 'image' : 'notice', characters: value.text?.length || 0, lfs: value.lfs === true, notice: value.notice });
        return { repo: id, comparison: result.indexComparison, summary: result.summary || '', view, before: metadata(result.before), after: metadata(result.after),
            patchAvailable: !result.patchNotice, patchNotice: result.patchNotice, text: text.slice(offset, offset + limit), offset, limit, total: text.length, nextOffset: offset + limit < text.length ? offset + limit : undefined, cachedUpToMs: 0 };
    }

    async tags(id: string, query: TagQuery): Promise<TagPage> {
        if (!query || query.kind !== 'tags' || Object.keys(query).some(key => !['kind', 'text', 'offset', 'limit', 'version'].includes(key))) throw new MessageError('git.tags.invalidQuery');
        const { offset = 0, limit = 100, text = '', version } = query;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new MessageError('git.tags.invalidPaging');
        if (typeof text !== 'string' || text.length > 4096 || text.includes('\0') || (version !== undefined && (typeof version !== 'string' || !version || version.length > 256))) throw new MessageError('git.tags.invalidFilter');
        if (this.taskState?.status === 'running') throw new MessageError('agent.taskRunningTags');
        const repo = await this.repo(id);
        let reading = this.tagReads.get(repo.path);
        if (!reading) {
            reading = this.text(repo.path, ['--no-replace-objects', 'for-each-ref', '--sort=refname', '--count=10001', '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(symref)', 'refs/tags/']);
            this.tagReads.set(repo.path, reading);
        }
        let raw: string;
        try { raw = await reading; }
        finally { if (this.tagReads.get(repo.path) === reading) this.tagReads.delete(repo.path); }
        const lines = raw ? raw.split('\n') : [];
        if (lines.length > 10000) throw new MessageError('git.tags.tooMany');
        const currentVersion = sha(JSON.stringify([repo.id, repo.path, text.toLowerCase(), raw]));
        if ((offset > 0 && !version) || (version !== undefined && version !== currentVersion)) throw new TagStateChangedError(t('git.tags.changed'));
        const entries: TagEntry[] = lines.map(line => {
            const [ref = '', object = '', objectType = '', peeled = '', peeledType = '', symbolic = ''] = line.split('\0');
            if (!ref.startsWith('refs/tags/') || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(object) || !['commit', 'tag', 'tree', 'blob'].includes(objectType)) throw new MessageError('git.tags.invalidRefData');
            const target = objectType === 'tag' ? peeled : object, targetType = objectType === 'tag' ? peeledType : objectType;
            return { ref, name: ref.slice(10), object, objectType, kind: symbolic ? 'symbolic' : objectType === 'tag' ? 'annotated' : 'lightweight',
                target, targetType, commit: !symbolic && targetType === 'commit' && HASH.test(target) ? target : undefined, symbolic: symbolic || undefined };
        });
        const needle = text.toLowerCase();
        const matches = entries.filter(tag => [tag.name, tag.ref, tag.object, tag.target].some(value => value.toLowerCase().includes(needle)));
        if (this.task()?.status === 'running') throw new MessageError('git.tags.taskStarted');
        return { repo: id, version: currentVersion, tags: matches.slice(offset, offset + limit), offset, limit, total: matches.length, tagCount: entries.length,
            nextOffset: offset + limit < matches.length ? offset + limit : undefined, capturedAt: new Date().toISOString() };
    }

    private async tagRef(repo: Repository, name: unknown): Promise<string> {
        if (typeof name !== 'string' || !name || name.length > 512 || name.startsWith('-') || name.startsWith('refs/') || /[\x00-\x20\x7f]/.test(name)) throw new MessageError('git.tags.invalidName');
        const ref = 'refs/tags/' + name;
        await this.git(repo.path, ['check-ref-format', ref]);
        return ref;
    }

    private async tagObject(repo: Repository, ref: string): Promise<string | undefined> {
        const symbolic = await this.git(repo.path, ['symbolic-ref', '-q', ref], { allowed: [0, 1] });
        if (!symbolic.code) throw new MessageError('git.tags.symbolicRef');
        const result = await this.git(repo.path, ['--no-replace-objects', 'rev-parse', '--verify', '--quiet', '--end-of-options', ref], { allowed: [0, 1] });
        if (result.code === 1) return undefined;
        const object = result.stdout.toString('utf8').trim();
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(object)) throw new MessageError('git.tags.invalidObjectId');
        return object;
    }

    private async tagCommit(repo: Repository, revision: unknown): Promise<string> {
        if (typeof revision !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) throw new MessageError('git.tags.targetNeedsSha');
        const object = await this.text(repo.path, ['--no-replace-objects', 'rev-parse', '--verify', '--end-of-options', revision + '^{commit}']);
        if (object !== revision) throw new MessageError('git.tags.targetMustBeCommit');
        return object;
    }

    private remoteStore(repo: Repository): RemoteStore {
        return new RemoteStore(repo.path, this.cache, async args => (await this.git(repo.path, args)).stdout);
    }

    async remotePage(id: string, query: RemoteQuery): Promise<RemotePage> {
        if (this.task()?.status === 'running') throw new MessageError('agent.taskRunningRemotes');
        const repo = await this.repo(id, true);
        const key = sha(JSON.stringify([repo.path, repo.version, query]));
        let reading = this.remoteReads.get(key);
        if (!reading) {
            if (this.remoteReads.size >= 16) throw new MessageError('git.remotesTooManyQueries');
            reading = this.remoteStore(repo).page(id, repo.version, query);
            this.remoteReads.set(key, reading);
        }
        try {
            const page = await reading;
            if (this.task()?.status === 'running') throw new MessageError('git.taskStartedRereadAgain');
            return page;
        } finally { if (this.remoteReads.get(key) === reading) this.remoteReads.delete(key); }
    }

    async reflog(id: string, query: ReflogQuery): Promise<ReflogPage> {
        if (!query || query.kind !== 'reflog' || Object.keys(query).some(key => !['kind', 'ref', 'text', 'offset', 'limit', 'version'].includes(key))) throw new MessageError('git.reflog.invalidQuery');
        const { ref = 'HEAD', text = '', offset = 0, limit = 20, version } = query;
        if (typeof ref !== 'string' || ref.length > 512 || typeof text !== 'string' || text.length > 512 || text.includes('\0') || !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100 || (version !== undefined && (typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version)))) throw new MessageError('git.reflog.invalidParams');
        if (this.task()?.status === 'running') throw new MessageError('agent.taskRunningReflog');
        const repo = await this.repo(id, true);
        if (ref !== 'HEAD') {
            if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/remotes/')) throw new MessageError('git.reflog.refScope');
            await this.git(repo.path, ['check-ref-format', ref]);
            if ((await this.git(repo.path, ['symbolic-ref', '--quiet', ref], { allowed: [0, 1] })).code === 0) throw new MessageError('git.reflog.symbolicRef');
        }
        const key = sha(JSON.stringify([repo.path, ref]));
        let reading = this.reflogReads.get(key);
        if (!reading) {
            if (this.reflogReads.size >= 4) throw new MessageError('git.reflog.tooManyQueries');
            reading = this.readReflog(repo, ref); this.reflogReads.set(key, reading);
        }
        let source: { raw: string; available: boolean };
        try { source = await reading; }
        finally { if (this.reflogReads.get(key) === reading) this.reflogReads.delete(key); }
        const fields = source.raw.split('\0');
        if (fields.pop() !== '' || fields.length % 5) throw new MessageError('git.reflog.incomplete');
        if (fields.length > 1001 * 5) throw new MessageError('git.reflog.overLimit');
        const needle = text.toLowerCase();
        const shorten = (value: string, limit: number) => value.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '');
        const current = sha(JSON.stringify([repo.path, ref, source.available, sha(source.raw), needle]));
        if ((offset > 0 && !version) || (version !== undefined && version !== current)) throw new ReflogStateChangedError(t('git.reflog.changed'));
        const entries: ReflogEntry[] = [];
        for (let i = 0; i < Math.min(fields.length, 1000 * 5); i += 5) {
            const revision = fields[i]!, selector = fields[i + 1]!, actor = fields[i + 2]!, email = fields[i + 3]!, subject = fields[i + 4]!;
            if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision) || !selector.startsWith(ref + '@{') || !selector.endsWith('}')) throw new MessageError('git.reflog.invalidEntry');
            const date = selector.slice(ref.length + 2, -1);
            if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(date) || !Number.isFinite(Date.parse(date))) throw new MessageError('git.reflog.noEventDate');
            if (![revision, selector, actor, email, subject].some(value => value.toLowerCase().includes(needle))) continue;
            entries.push({ index: i / 5, revision, selector, date, actor: shorten(actor, 256), email: shorten(email, 256), subject: shorten(subject, 1000), subjectTruncated: subject.length > 1000, identityTruncated: actor.length > 256 || email.length > 256 });
        }
        if (this.task()?.status === 'running') throw new MessageError('git.reflog.taskStarted');
        const page: ReflogPage = { repo: id, repoVersion: repo.version, ref, version: current, entries: entries.slice(offset, offset + limit), total: entries.length, sampled: Math.min(fields.length / 5, 1000), truncated: fields.length / 5 > 1000, available: source.available, offset, limit, nextOffset: offset + limit < entries.length ? offset + limit : undefined, capturedAt: new Date().toISOString(), notice: t('git.reflog.notice') };
        if (Buffer.byteLength(JSON.stringify(page)) > 192 * 1024) throw new MessageError('git.reflog.pageTooLarge');
        return page;
    }

    private async readReflog(repo: Repository, ref: string): Promise<{ raw: string; available: boolean }> {
        const exists = await this.git(repo.path, ['reflog', 'exists', ref], { allowed: [0, 1] });
        if (exists.code !== 0) return { raw: '', available: false };
        const result = await this.git(repo.path, ['--no-replace-objects', 'log', '--walk-reflogs', '--max-count=1001', '--no-abbrev', '--no-decorate', '--no-show-signature', '--no-notes', '--no-patch', '--date=iso-strict', '--format=tformat:%H%x00%gD%x00%gn%x00%ge%x00%gs', '-z', '--end-of-options', ref, '--']);
        return { raw: this.utf8(result.stdout), available: true };
    }

    private async branchAt(repo: Repository, request: OperationRequest): Promise<{ name: string; target: string }> {
        if (Object.keys(request).some(key => request[key as keyof OperationRequest] !== undefined && !['repo', 'version', 'action', 'branch', 'revision'].includes(key))) throw new MessageError('git.branches.createNoSwitchArgs');
        const gitVersion = (await this.text(repo.path, ['--version'])).match(/^git version (\d+)\.(\d+)(?:\.|\s|$)/);
        if (!gitVersion || Number(gitVersion[1]) < 2 || (Number(gitVersion[1]) === 2 && Number(gitVersion[2]) < 54)) throw new MessageError('git.branches.needsGit254');
        const name = await this.newBranchName(repo, request.branch), ref = 'refs/heads/' + name;
        if (repo.branch === name) throw new MessageError('git.branches.currentUnborn');
        const worktrees = this.utf8((await this.git(repo.path, ['worktree', 'list', '--porcelain', '-z'])).stdout).split('\0');
        if (worktrees.includes('branch ' + ref)) throw new MessageError('git.branches.usedByWorktree');
        const target = await this.revision(repo, request.revision || '', true);
        await this.text(repo.path, ['var', 'GIT_COMMITTER_IDENT']);
        return { name, target };
    }

    async details(id: string): Promise<RepoDetails> {
        const repo = await this.repo(id);
        const branches = await this.localBranches(repo);
        const remotes = (await this.text(repo.path, ['remote'])).split('\n').filter(Boolean);
        const remoteRefs = await this.text(repo.path, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', 'refs/remotes/']);
        const remoteBranches: RemoteBranch[] = [];
        for (const line of remoteRefs.split('\n')) {
            const [ref = '', hash = '', symbolic] = line.split('\0');
            if (symbolic || !ref.startsWith('refs/remotes/') || !HASH.test(hash)) continue;
            const name = ref.slice('refs/remotes/'.length);
            const remote = [...remotes].sort((a, b) => b.length - a.length).find(r => name.startsWith(r + '/'));
            if (remote) remoteBranches.push({ ref, name, remote, branch: name.slice(remote.length + 1), sha: hash });
        }
        const tagRefs = await this.text(repo.path, ['for-each-ref', '--format=%(refname)', 'refs/tags/']);
        const tags = tagRefs.split('\n').filter(ref => ref.startsWith('refs/tags/')).map(ref => ({ ref, name: ref.slice(10) }));
        return { repo, branches, remotes, remoteBranches, stashes: await this.stashes(id), tags };
    }

    private async localBranches(repo: Repository): Promise<Branch[]> {
        const raw = await this.git(repo.path, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(HEAD)%00%(upstream)%00%(worktreepath)%00%(symref)%00%(upstream:track,nobracket)%00', 'refs/heads/']);
        const config = (await this.branchConfiguration(repo)).split('\0').filter(Boolean).map(record => {
            const split = record.indexOf('\n');
            return { key: split < 0 ? record : record.slice(0, split), value: split < 0 ? undefined : record.slice(split + 1) };
        });
        // Worktree paths can contain newlines, so only the fixed NUL fields delimit records.
        const fields = raw.stdout.toString('utf8').split('\0'), branches: Branch[] = [];
        for (let i = 0; i + 6 < fields.length; i += 7) {
            const ref = (fields[i] || '').replace(/^\n/, ''), hash = fields[i + 1] || '', upstreamRef = fields[i + 3] || '';
            if (!ref.startsWith('refs/heads/') || !HASH.test(hash)) throw new MessageError('git.branches.cannotList');
            if (fields[i + 5]) continue;
            const name = ref.slice(11), remotes = config.filter(entry => entry.key === `branch.${name}.remote`), merges = config.filter(entry => entry.key === `branch.${name}.merge`);
            const tracking: BranchTracking = { state: 'none', remote: remotes.length === 1 ? remotes[0]!.value : undefined, merge: merges.length === 1 ? merges[0]!.value : undefined };
            if (remotes.length || merges.length) {
                const track = fields[i + 6] || '';
                tracking.state = remotes.length !== 1 || merges.length !== 1 || !tracking.remote || !tracking.merge?.startsWith('refs/heads/') || !upstreamRef ? 'invalid' : track === 'gone' ? 'gone' : 'tracked';
                if (tracking.state === 'tracked') {
                    if (!/^(?:ahead \d+(?:, behind \d+)?|behind \d+)?$/.test(track)) tracking.state = 'invalid';
                    else { tracking.ahead = Number(/ahead (\d+)/.exec(track)?.[1] || 0); tracking.behind = Number(/behind (\d+)/.exec(track)?.[1] || 0); }
                }
            }
            branches.push({ name, sha: hash, current: fields[i + 2] === '*', upstream: upstreamRef.replace(/^refs\/(heads|remotes)\//, ''), upstreamRef: upstreamRef || undefined, worktree: fields[i + 4] ? path.resolve(fields[i + 4]!) : undefined, tracking });
        }
        return branches;
    }

    private async branchName(repo: Repository, name: string | undefined): Promise<string> {
        if (typeof name !== 'string' || !name || name === 'HEAD' || name.startsWith('-') || name.length > 200 || name.includes('\0')) throw new MessageError('git.branches.invalidName');
        await this.git(repo.path, ['check-ref-format', `refs/heads/${name}`]);
        return name;
    }

    private async branchConfiguration(repo: Repository): Promise<string> {
        return (await this.git(repo.path, ['config', '--null', '--get-regexp', '^branch\\.'], { allowed: [0, 1] })).stdout.toString('utf8');
    }

    private async newBranchName(repo: Repository, name: string | undefined): Promise<string> {
        const valid = await this.branchName(repo, name);
        const symbolic = await this.git(repo.path, ['symbolic-ref', '--quiet', `refs/heads/${valid}`], { allowed: [0, 1] });
        if (symbolic.code === 0) throw new MessageError('git.branches.symbolicTarget');
        const exists = await this.git(repo.path, ['show-ref', '--verify', '--quiet', `refs/heads/${valid}`], { allowed: [0, 1] });
        if (exists.code === 0) throw new MessageError('git.branches.exists');
        const branches = await this.localBranches(repo);
        if (branches.some(branch => branch.name.startsWith(valid + '/') || valid.startsWith(branch.name + '/'))) throw new MessageError('git.branches.hierarchyConflict');
        const config = await this.branchConfiguration(repo);
        if (config.split('\0').some(record => {
            const key = record.slice(0, record.indexOf('\n'));
            return key.slice(0, key.lastIndexOf('.')) === `branch.${valid}`;
        })) throw new MessageError('git.branches.configExists');
        return valid;
    }

    private async branchManagement(repo: Repository, request: OperationRequest): Promise<{ source: Branch; state: string; upstreamSha?: string }> {
        const name = await this.branchName(repo, request.branch);
        const source = (await this.localBranches(repo)).find(branch => branch.name === name);
        if (!source || !HASH.test(request.revision || '') || source.sha !== request.revision) throw new MessageError('git.branches.sourceChanged');
        if (source.current || source.worktree) throw new MessageError('git.branches.inUse', { path: source.worktree || repo.path });
        const config = await this.branchConfiguration(repo);
        let upstreamSha: string | undefined;
        if (source.upstreamRef) {
            const upstream = await this.git(repo.path, ['rev-parse', '--verify', `${source.upstreamRef}^{commit}`], { allowed: [0, 128] });
            const hash = upstream.stdout.toString('utf8').trim();
            if (upstream.code === 0 && HASH.test(hash)) upstreamSha = hash;
        }
        if (request.action === 'renameBranch') {
            await this.newBranchName(repo, request.newBranch);
        } else if (request.action === 'deleteBranch') {
            if (!repo.branch || !repo.head) throw new MessageError('git.branches.switchToKeeper');
            if ((await this.git(repo.path, ['merge-base', '--is-ancestor', source.sha, repo.head], { allowed: [0, 1] })).code !== 0) throw new MessageError('git.branches.notMergedCurrent');
            const keys = config.split('\0').map(record => record.slice(0, record.indexOf('\n')));
            if (source.upstreamRef || keys.includes(`branch.${name}.merge`) || keys.includes(`branch.${name}.remote`)) {
                if (!source.upstreamRef) throw new MessageError('git.branches.upstreamUnparsable');
                if (!upstreamSha) throw new MessageError('git.branches.upstreamMissing');
                if ((await this.git(repo.path, ['merge-base', '--is-ancestor', source.sha, upstreamSha], { allowed: [0, 1] })).code !== 0) throw new MessageError('git.branches.notMergedUpstream');
            }
        } else throw new MessageError('git.branches.unsupportedAction');
        return { source, upstreamSha, state: sha(JSON.stringify({ source, config, upstreamSha })) };
    }

    private async upstreamConfiguration(repo: Repository, name: string): Promise<{ snapshot: string; remote?: string; merge?: string; entries: { key: string; value?: string }[] }> {
        const result = await this.git(repo.path, ['config', '--null', '--show-origin', '--show-scope', '--get-regexp', '^(branch\\.|remote\\.)'], { allowed: [0, 1] });
        const snapshot = this.utf8(result.stdout), fields = snapshot.split('\0');
        if (fields.pop() !== '' || fields.length % 3) throw new MessageError('git.upstream.cannotReadOrigin');
        const configPath = path.resolve(repo.path, await this.text(repo.path, ['rev-parse', '--git-path', 'config']));
        if ((await fs.lstat(configPath)).isSymbolicLink()) throw new MessageError('git.upstream.configSymlink');
        const directConfig = await fs.realpath(configPath), entries: { key: string; value?: string }[] = [];
        const remoteKey = `branch.${name}.remote`, mergeKey = `branch.${name}.merge`;
        for (let i = 0; i < fields.length; i += 3) {
            const scope = fields[i]!, origin = fields[i + 1]!, record = fields[i + 2]!, split = record.indexOf('\n');
            const key = split < 0 ? record : record.slice(0, split), value = split < 0 ? undefined : record.slice(split + 1);
            entries.push({ key, value });
            if (key === remoteKey || key === mergeKey) {
                if (scope !== 'local' || !origin.startsWith('file:') || await fs.realpath(path.resolve(repo.path, origin.slice(5))) !== directConfig) throw new MessageError('git.upstream.foreignScope');
            }
        }
        const remotes = entries.filter(entry => entry.key === remoteKey), merges = entries.filter(entry => entry.key === mergeKey);
        if ((remotes.length || merges.length) && (remotes.length !== 1 || merges.length !== 1 || !remotes[0]!.value || !merges[0]!.value?.startsWith('refs/heads/'))) throw new MessageError('git.upstream.multiValued');
        return { snapshot, entries, remote: remotes[0]?.value, merge: merges[0]?.value };
    }

    private async upstreamManagement(repo: Repository, request: OperationRequest): Promise<{ source: Branch; target?: RemoteBranch; previous: string; state: string }> {
        const name = await this.branchName(repo, request.branch), details = await this.details(repo.id);
        const source = details.branches.find(branch => branch.name === name);
        if (!source || !HASH.test(request.revision || '') || source.sha !== request.revision) throw new MessageError('git.upstream.localChanged');
        if (source.worktree && path.resolve(source.worktree) !== repo.path) throw new MessageError('git.upstream.otherWorktree', { worktree: source.worktree });
        const config = await this.upstreamConfiguration(repo, name);
        const previousSha = source.upstreamRef ? await this.text(repo.path, ['rev-parse', '--verify', `${source.upstreamRef}^{commit}`], [0, 128]) : '';
        let target: RemoteBranch | undefined;
        if (request.action === 'setUpstream') {
            target = details.remoteBranches.find(branch => branch.ref === request.remoteBranch);
            if (!target || !HASH.test(request.upstreamRevision || '') || target.sha !== request.upstreamRevision) throw new MessageError('git.upstream.trackingChanged');
            const matches: string[] = [];
            for (const remote of details.remotes) {
                const fetch = config.entries.filter(entry => entry.key === `remote.${remote}.fetch`);
                const standard = `refs/heads/*:refs/remotes/${remote}/*`;
                if (fetch.length !== 1 || (fetch[0]!.value !== standard && fetch[0]!.value !== '+' + standard)) throw new MessageError('git.upstream.nonStandardFetch');
                if (target.ref.startsWith(`refs/remotes/${remote}/`)) matches.push(remote);
            }
            if (matches.length !== 1 || matches[0] !== target.remote) throw new MessageError('git.upstream.ambiguousRemote');
            if (config.remote === target.remote && config.merge === 'refs/heads/' + target.branch) throw new MessageError('git.upstream.alreadyTracking');
        } else if (request.action === 'unsetUpstream') {
            if (!config.remote || !config.merge) throw new MessageError('git.upstream.notSet');
        } else throw new MessageError('git.upstream.unsupportedAction');
        return { source, target, previous: config.remote ? `${config.remote} · ${config.merge}${previousSha ? ' · ' + previousSha : t('git.upstream.localRefUnavailable')}` : t('git.upstream.unset'), state: sha(JSON.stringify({ source, target, previousSha, config: config.snapshot })) };
    }

    async stashes(id: string): Promise<Stash[]> {
        const repo = await this.repo(id);
        const raw = await this.text(repo.path, ['stash', 'list', '--max-count=200', '--format=%H%x00%aI%x00%gs%x00']);
        const fields = raw.split('\0'), result: Stash[] = [];
        for (let i = 0; i + 2 < fields.length; i += 3) {
            const hash = (fields[i] || '').trim();
            if (!HASH.test(hash)) throw new MessageError('git.stash.cannotParse');
            result.push({ ref: `stash@{${result.length}}`, sha: hash, date: fields[i + 1] || '', subject: fields[i + 2] || '' });
        }
        return result;
    }

    async stashFiles(id: string, revision: string): Promise<ChangedFile[]> {
        const repo = await this.repo(id), rev = await this.revision(repo, revision);
        if (!(await this.stashes(id)).some(s => s.sha === rev)) throw new MessageError('git.stash.changed');
        const result: ChangedFile[] = [];
        for (const part of ['tracked', 'index'] as const) {
            const fields = (await this.git(repo.path, ['diff', '--raw', '--no-renames', '--no-ext-diff', '--no-textconv', '-z', rev + '^1', part === 'index' ? rev + '^2' : rev, '--'])).stdout.toString('utf8').split('\0');
            for (let i = 0; i + 1 < fields.length; i += 2) {
                const meta = (fields[i] || '').split(' '), name = fields[i + 1];
                if (!name) continue;
                result.push({ path: name, index: meta[4] || 'M', worktree: ' ', conflict: false, submodule: meta[0] === ':160000' || meta[1] === '160000', stashPart: part });
            }
        }
        const untracked = await this.text(repo.path, ['rev-parse', '--verify', rev + '^3'], [0, 128]);
        if (!untracked) return result;
        const names = (await this.git(repo.path, ['ls-tree', '-r', '--name-only', '-z', untracked])).stdout.toString('utf8').split('\0').filter(Boolean);
        return [...result, ...names.map(name => ({ path: name, index: 'A', worktree: ' ', conflict: false, submodule: false, stashPart: 'untracked' as const }))];
    }

    async history(id: string, skip = 0): Promise<Commit[]> {
        const repo = await this.repo(id);
        if (!repo.head) return [];
        if (!Number.isInteger(skip) || skip < 0 || skip > 100000) throw new MessageError('git.history.invalidPage');
        const raw = await this.text(repo.path, ['--no-replace-objects', 'log', '--topo-order', '--date=iso-strict', '--max-count=60', `--skip=${skip}`, '--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%D%x00%P%x00', 'HEAD']);
        return this.parseCommits(raw);
    }

    private parseCommits(raw: string): Commit[] {
        const fields = raw.split('\0'), commits: Commit[] = [];
        for (let i = 0; i + 6 < fields.length; i += 7) commits.push({ sha: (fields[i] || '').trim(), short: fields[i + 1] || '', author: fields[i + 2] || '', date: fields[i + 3] || '', subject: fields[i + 4] || '', refs: fields[i + 5] || '', parents: (fields[i + 6] || '').split(' ').filter(Boolean) });
        return commits;
    }

    private async syncReferences(repo: Repository): Promise<{ values: SyncReferences; stamp: string }> {
        const config = (await this.git(repo.path, ['config', '--null', '--list'])).stdout;
        const ref = await this.text(repo.path, ['symbolic-ref', '--quiet', 'HEAD'], [0, 1]);
        const head = await this.text(repo.path, ['--no-replace-objects', 'rev-parse', '--verify', 'HEAD^{commit}'], [0, 128]);
        const values: SyncReferences = { state: 'unborn', branch: ref.startsWith('refs/heads/') ? ref.slice(11) : '', head, upstreamRef: '', upstreamHead: '' };
        if (head) {
            if (!HASH.test(head)) throw new MessageError('git.cannotReadHead');
            if (!values.branch) values.state = 'detached';
            else {
                const branch = (await this.localBranches(repo)).find(value => value.name === values.branch);
                if (!branch || !branch.current || branch.sha !== head) throw new MessageError('git.sync.branchChanged');
                values.remote = branch.tracking?.remote;
                values.upstreamRef = branch.upstreamRef || '';
                values.state = branch.tracking?.state === 'none' ? 'no-upstream' : branch.tracking?.state === 'gone' ? 'gone' : 'invalid';
                if (branch.tracking?.state === 'tracked' && /^refs\/(heads|remotes)\//.test(values.upstreamRef)) {
                    const raw = await this.text(repo.path, ['--no-replace-objects', 'for-each-ref', '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)', values.upstreamRef]);
                    const records = raw.split('\n').filter(Boolean).map(record => record.split('\0')).filter(fields => fields[0] === values.upstreamRef);
                    if (!records.length) values.state = 'gone';
                    else if (records.length === 1 && records[0]![2] === 'commit' && !records[0]![3] && HASH.test(records[0]![1]!)) {
                        values.state = 'ready'; values.upstreamHead = records[0]![1]!;
                    }
                }
            }
        }
        return { values, stamp: sha(JSON.stringify(values) + sha(config)) };
    }

    async syncPage(id: string, query: SyncQuery): Promise<SyncPage> {
        if (!query || query.kind !== 'sync' || (query.direction !== undefined && !['outgoing', 'incoming'].includes(query.direction))) throw new MessageError('git.sync.invalidDirection');
        const direction = query.direction || 'outgoing', start = query.start === undefined ? 0 : query.start;
        if (!Number.isSafeInteger(start) || start < 0 || start % 60 !== 0 || (start > 0 && !query.snapshot)) throw new MessageError('git.sync.invalidStart');
        if (query.snapshot !== undefined && (typeof query.snapshot !== 'string' || !query.snapshot)) throw new MessageError('git.sync.invalidSnapshot');
        const repo = await this.repo(id, !query.snapshot), boundary = await this.inspectionBoundary(repo);
        let session: SyncSession, sourceStamp = '';
        if (query.snapshot) {
            const saved = this.syncSessions.get(query.snapshot);
            if (!saved || saved.root !== repo.path || saved.expires < Date.now()) throw new MessageError('git.sync.snapshotExpired');
            if (saved.boundary !== boundary.boundary) throw new MessageError('git.sync.shallowChanged');
            session = saved;
        } else {
            const source = await this.syncReferences(repo); sourceStamp = source.stamp;
            const metadata: SyncSession['metadata'] = { ...source.values, snapshot: randomUUID(), shallow: boundary.shallow, capturedAt: new Date().toISOString(), fetchedAt: this.fetchedAt[id], notice: '' };
            const notes = [t('git.sync.noteScope')];
            if (metadata.remote === '.') notes.push(t('git.sync.noteLocalUpstream'));
            else notes.push(t('git.sync.noteMaybeNewer'));
            if (metadata.state === 'ready') {
                const counts = (await this.text(repo.path, ['--no-replace-objects', 'rev-list', '--left-right', '--count', metadata.head + '...' + metadata.upstreamHead, '--'])).split(/\s+/).map(Number);
                if (counts.length !== 2 || counts.some(value => !Number.isSafeInteger(value) || value < 0)) throw new MessageError('git.sync.cannotCount');
                metadata.ahead = counts[0]!; metadata.behind = counts[1]!;
                if (metadata.head === metadata.upstreamHead) metadata.relation = 'equal';
                else if (boundary.shallow) metadata.relation = 'unknown';
                else {
                    const common = await this.git(repo.path, ['--no-replace-objects', 'merge-base', metadata.head, metadata.upstreamHead], { allowed: [0, 1] });
                    if (common.code === 1) metadata.relation = 'unrelated';
                    else {
                        if (!HASH.test(common.stdout.toString('utf8').trim())) throw new MessageError('git.sync.cannotParseBase');
                        metadata.relation = metadata.ahead && metadata.behind ? 'diverged' : metadata.ahead ? 'ahead' : metadata.behind ? 'behind' : 'equal';
                    }
                }
                if (metadata.relation === 'diverged') notes.push(t('git.sync.diverged'));
                if (metadata.relation === 'unrelated') notes.push(t('git.sync.noCommonAncestor'));
            } else {
                const reasons = { unborn: t('git.sync.reasonUnborn'), detached: t('git.sync.reasonDetached'), 'no-upstream': t('git.sync.reasonNoUpstream'), gone: t('git.sync.reasonGone'), invalid: t('git.sync.reasonInvalid') };
                notes.push(reasons[metadata.state]);
            }
            if (boundary.shallow) notes.push(t('git.sync.shallowNote'));
            metadata.notice = notes.join('\n');
            session = { root: repo.path, expires: Date.now() + 30 * 60 * 1000, boundary: boundary.boundary, metadata };
        }
        const metadata = session.metadata, count = direction === 'outgoing' ? metadata.ahead : metadata.behind;
        if (start > (count || 0)) throw new MessageError('git.sync.startOutOfRange');
        let commits: Commit[] = [], nextStart: number | undefined;
        if (metadata.state === 'ready') {
            const tip = direction === 'outgoing' ? metadata.head : metadata.upstreamHead, excluded = direction === 'outgoing' ? metadata.upstreamHead : metadata.head;
            const raw = this.utf8((await this.git(repo.path, ['--no-replace-objects', '-c', 'log.follow=false', 'log', '--topo-order', '--encoding=UTF-8', '--no-use-mailmap', '--no-patch', '--no-decorate', '--no-show-signature', '--no-notes', '--no-color', '--max-count=61', '--skip=' + start, '--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%x00%P%x00', tip, '^' + excluded, '--'])).stdout);
            const fields = raw.split('\0');
            if (raw && (fields.length % 7 !== 1 || !/^\n?$/.test(fields[fields.length - 1]!))) throw new MessageError('git.sync.cannotParseList');
            const all = this.parseCommits(raw);
            if (all.length > 61 || all.some(commit => !HASH.test(commit.sha) || commit.parents.some(parent => !HASH.test(parent)))) throw new MessageError('git.sync.invalidObject');
            if (Math.min(61, count! - start) !== all.length) throw new MessageError('git.sync.countMismatch');
            commits = all.slice(0, 60);
            if (all.length > 60) nextStart = start + commits.length;
        }
        if (!query.snapshot && (await this.syncReferences(repo)).stamp !== sourceStamp) throw new MessageError('git.sync.stateChanged');
        if ((await this.inspectionBoundary(repo)).boundary !== session.boundary) throw new MessageError('git.sync.shallowChangedWhileReading');
        if (!query.snapshot) {
            for (const [key, value] of this.syncSessions) if (value.expires < Date.now()) this.syncSessions.delete(key);
            while (this.syncSessions.size >= 32) this.syncSessions.delete(this.syncSessions.keys().next().value!);
            this.syncSessions.set(metadata.snapshot, session);
        }
        return { ...metadata, direction, start, nextStart, commits };
    }

    async historyPage(id: string, query: HistoryQuery): Promise<HistoryPage> {
        if (!query || !['current', 'all'].includes(query.scope)) throw new MessageError('git.history.invalidScope');
        const repo = await this.repo(id, !query.cursor);
        let search: HistorySearch | undefined;
        if (query.search !== undefined) {
            if (!query.search || !['message', 'author'].includes(query.search.field) || typeof query.search.text !== 'string' || query.search.text.length > 500 || /[\0\r\n]/.test(query.search.text)) throw new MessageError('git.history.searchText');
            const text = query.search.text.trim();
            if (text) search = { field: query.search.field, text };
        }
        if (query.path !== undefined && (typeof query.path !== 'string' || query.path.length > 4096)) throw new MessageError('git.history.pathRelative');
        const historyPath = query.path || undefined;
        if (historyPath) this.safePath(repo, historyPath);
        const filters = JSON.stringify({ search, path: historyPath }), filtered = !!(search || historyPath);
        const shallowPath = await this.text(repo.path, ['rev-parse', '--git-path', 'shallow']);
        const shallow = await fs.readFile(path.resolve(repo.path, shallowPath), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
        let session: HistorySession;
        if (query.cursor) {
            const saved = this.histories.get(query.cursor);
            if (!saved || saved.expires < Date.now() || saved.root !== repo.path || saved.scope !== query.scope || saved.filters !== filters) throw new MessageError('git.history.pagingExpired');
            if (shallow !== saved.shallow) throw new MessageError('git.history.shallowChanged');
            session = saved;
        } else {
            const raw = await this.text(repo.path, ['--no-replace-objects', 'for-each-ref', '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(*objecttype)', 'refs/heads/', 'refs/remotes/', 'refs/tags/']);
            const labels: Record<string, string[]> = {}, tips = new Set<string>();
            for (const record of raw.split('\n').filter(Boolean)) {
                const [name = '', object = '', peeled = '', type = '', peeledType = ''] = record.split('\0');
                let tip = type === 'commit' ? object : peeledType === 'commit' ? peeled : '';
                if (!tip && type === 'tag') {
                    const result = await this.git(repo.path, ['--no-replace-objects', 'rev-parse', '--verify', `${name}^{commit}`], { allowed: [0, 128] });
                    if (result.code === 0) tip = result.stdout.toString('utf8').trim();
                }
                if (!HASH.test(tip)) continue;
                const label = name.startsWith('refs/tags/') ? 'tag: ' + name.slice(10) : name.replace(/^refs\/(heads|remotes)\//, '');
                (labels[tip] ||= []).push(label); tips.add(tip);
            }
            if (repo.head) { (labels[repo.head] ||= []).unshift(repo.branch ? 'HEAD → ' + repo.branch : 'HEAD'); tips.add(repo.head); }
            session = { root: repo.path, scope: query.scope, tips: query.scope === 'current' ? (repo.head ? [repo.head] : []) : [...tips].sort(), labels, skip: 0, expires: Date.now() + 30 * 60 * 1000, shallow, filters, search, path: historyPath };
        }
        const metadata = { scope: query.scope, tipCount: session.tips.length, shallow: !!shallow, filtered, search: session.search ? { ...session.search } : undefined, path: session.path };
        if (!session.tips.length) return { commits: [], ...metadata };
        const args = ['--no-replace-objects', '-c', 'log.follow=false', 'log', '--topo-order', '--no-decorate', '--no-show-signature', '--no-notes', '--no-color', '--max-count=61', `--skip=${session.skip}`, '--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%x00%P%x00'];
        if (session.search) args.push('--fixed-strings', '--regexp-ignore-case', `${session.search.field === 'author' ? '--author' : '--grep'}=${session.search.text}`);
        if (session.path) args.push('--full-history');
        args.push('--stdin', '--', ...(session.path ? [session.path] : []));
        const result = await this.git(repo.path, args, { input: session.tips.join('\n') + '\n' });
        const all = this.parseCommits(result.stdout.toString('utf8'));
        const boundaries = new Set(shallow.trim().split('\n'));
        const commits = all.slice(0, 60).map(commit => ({ ...commit, refs: (session.labels[commit.sha] || []).join(', '), boundary: boundaries.has(commit.sha) }));
        let cursor: string | undefined;
        if (all.length > 60) {
            cursor = randomUUID();
            for (const [key, value] of this.histories) if (value.expires < Date.now()) this.histories.delete(key);
            while (this.histories.size >= 32) this.histories.delete(this.histories.keys().next().value!);
            this.histories.set(cursor, { ...session, skip: session.skip + commits.length });
        }
        return { commits, cursor, ...metadata };
    }

    private async comparisonRevision(repo: Repository, value: string): Promise<string> {
        if (typeof value !== 'string' || !value || value.length > 1024 || /[\0\r\n]/.test(value)) throw new MessageError('git.compare.chooseRevision');
        if (/^refs\/(heads|remotes|tags)\//.test(value)) await this.git(repo.path, ['check-ref-format', value]);
        else if (value !== 'HEAD' && !/^[a-fA-F0-9]{7,64}$/.test(value)) throw new MessageError('git.compare.baseFormat');
        const ref = /^[a-fA-F0-9]{7,64}$/.test(value) ? value.toLowerCase() : value;
        const result = await this.git(repo.path, ['--no-replace-objects', 'rev-parse', '--verify', `${ref}^{commit}`], { allowed: [0, 128] });
        const revision = result.stdout.toString('utf8').trim();
        if (result.code !== 0 || !HASH.test(revision)) throw new MessageError('git.compare.ambiguousCommit', { value });
        return revision;
    }

    private async treeChanges(repo: Repository, before: string, after: string): Promise<TreeChange[]> {
        const raw = await this.git(repo.path, ['--no-replace-objects', 'diff', '--raw', '--no-abbrev', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-relative', '--ignore-submodules=none', '-z', before, after, '--']);
        const fields = raw.stdout.toString('utf8').split('\0'), result: TreeChange[] = [];
        for (let i = 0; i + 1 < fields.length; i += 2) {
            const match = /^:(\d{6}) (\d{6}) ([a-f0-9]{40,64}) ([a-f0-9]{40,64}) ([A-Z])(?:\d+)?$/.exec(fields[i] || ''), name = fields[i + 1];
            if (!match || !name) throw new MessageError('git.compare.cannotParseDiff');
            this.safePath(repo, name);
            result.push({ path: name, index: match[5]!, worktree: ' ', conflict: false, submodule: match[1] === '160000' || match[2] === '160000', beforeMode: match[1]!, afterMode: match[2]!, beforeObject: match[3]!, afterObject: match[4]! });
        }
        return result;
    }

    async compare(id: string, query: CompareQuery): Promise<Comparison> {
        if (!query || !['direct', 'merge-base'].includes(query.mode)) throw new MessageError('git.compare.chooseMode');
        const repo = await this.repo(id);
        // Resolve user references once; all subsequent reads use these immutable object IDs.
        const base = await this.comparisonRevision(repo, query.base), target = query.base === query.target ? base : await this.comparisonRevision(repo, query.target);
        let effectiveBase = base;
        if (query.mode === 'merge-base') {
            const result = await this.git(repo.path, ['--no-replace-objects', 'merge-base', '--all', base, target], { allowed: [0, 1] });
            const ancestors = result.stdout.toString('utf8').trim().split('\n').filter(Boolean);
            if (result.code === 1 || !ancestors.length) throw new MessageError('git.compare.noMergeBase');
            if (ancestors.length !== 1 || !HASH.test(ancestors[0]!)) throw new MessageError('git.compare.multipleMergeBases');
            effectiveBase = ancestors[0]!;
        }
        const counts = (await this.text(repo.path, ['--no-replace-objects', 'rev-list', '--left-right', '--count', `${base}...${target}`])).split(/\s+/).map(Number);
        if (counts.length !== 2 || counts.some(count => !Number.isSafeInteger(count) || count < 0)) throw new MessageError('git.compare.cannotCountUnique');
        const files = await this.treeChanges(repo, effectiveBase, target);
        const shallow = await this.text(repo.path, ['rev-parse', '--is-shallow-repository']);
        return { base, target, baseLabel: query.base, targetLabel: query.target, effectiveBase, mode: query.mode, files, leftOnly: counts[0]!, rightOnly: counts[1]!, shallow: shallow === 'true' };
    }

    private async comparisonDiff(repo: Repository, request: DiffRequest): Promise<FileDiff> {
        const base = await this.revision(repo, request.baseRevision || '', true), target = await this.revision(repo, request.revision || '', true);
        this.safePath(repo, request.path);
        const file = (await this.treeChanges(repo, base, target)).find(f => f.path === request.path);
        if (!file) throw new MessageError('git.compare.fileNotInDiff');
        const side = async (revision: string, mode: string, object: string): Promise<FileContent> => {
            if (mode === '160000') return { notice: t('git.compare.submodulePointer', { object }) };
            if (mode === '000000') return { text: '' };
            const size = Number(await this.text(repo.path, ['--no-replace-objects', 'cat-file', '-s', object]));
            if (!Number.isSafeInteger(size) || size < 0) throw new MessageError('git.compare.cannotReadSize');
            if (size > CONTENT_LIMIT) return { notice: t('git.compare.sideTooLarge', { size }) };
            const buffer = (await this.git(repo.path, ['--no-replace-objects', 'cat-file', 'blob', object])).stdout;
            const content = mode === '120000' ? { text: buffer.toString('utf8') } : await this.content(repo, request.path, buffer, false, undefined, { lfs: 'compare' });
            if (content.lfs && content.notice) return { ...content, notice: content.notice + t('git.compareSideLfsSuffix', { revision }) };
            return content;
        };
        const left = await side(base, file.beforeMode, file.beforeObject), right = await side(target, file.afterMode, file.afterObject);
        let summary = `${base.slice(0, 12)} → ${target.slice(0, 12)}`;
        if (file.beforeMode !== file.afterMode) summary += t('git.compare.modeChange', { beforeMode: file.beforeMode, afterMode: file.afterMode });
        if (file.beforeMode === '120000' || file.afterMode === '120000') summary += t('git.history.symlinkNote');
        return this.renderFileDiff(repo, request.path, left, right, summary);
    }

    private async revision(repo: Repository, revision: string, originalObjects = false): Promise<string> {
        if (!HASH.test(revision)) throw new MessageError('git.commit.needFullHash');
        const resolved = await this.text(repo.path, [...(originalObjects ? ['--no-replace-objects'] : []), 'rev-parse', '--verify', `${revision}^{commit}`]);
        if (!HASH.test(resolved) || resolved !== revision) throw new MessageError('git.commit.notFound');
        return resolved;
    }

    private utf8(buffer: Buffer): string {
        const value = buffer.toString('utf8');
        if (!Buffer.from(value, 'utf8').equals(buffer)) throw new MessageError('git.commit.notUtf8');
        return value;
    }

    private async originalParents(repo: Repository, revision: string): Promise<string[]> {
        const raw = (await this.git(repo.path, ['--no-replace-objects', 'cat-file', 'commit', revision])).stdout;
        const separator = raw.indexOf('\n\n');
        if (separator < 0) throw new MessageError('git.commit.cannotParseHeader');
        const parents = raw.subarray(0, separator).toString('utf8').split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7));
        if (parents.some(parent => !HASH.test(parent))) throw new MessageError('git.commit.invalidParent');
        return parents;
    }

    private async inspectionBoundary(repo: Repository): Promise<{ boundary: string; shallow: boolean }> {
        const shallowPath = await this.text(repo.path, ['rev-parse', '--git-path', 'shallow']);
        const graftPath = await this.text(repo.path, ['rev-parse', '--git-path', 'info/grafts']);
        const read = (name: string) => fs.readFile(path.resolve(repo.path, name)).catch(e => { if (e.code === 'ENOENT') return Buffer.alloc(0); throw e; });
        const shallow = await read(shallowPath), grafts = await read(graftPath);
        if (grafts.toString('utf8').trim()) throw new MessageError('git.commit.grafts');
        return { boundary: sha(shallow), shallow: !!shallow.length };
    }

    async commitDetails(id: string, revision: string): Promise<CommitDetails> {
        const repo = await this.repo(id), rev = await this.revision(repo, revision, true);
        const { shallow } = await this.inspectionBoundary(repo);
        const result = await this.git(repo.path, ['--no-replace-objects', 'show', '-s', '--no-notes', '--no-show-signature', '--no-decorate', '--no-color', '--no-use-mailmap', '--encoding=UTF-8', '--format=format:%H%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%B', rev, '--']);
        const fields = this.utf8(result.stdout).split('\0');
        if (fields.length !== 9 || fields[0] !== rev) throw new MessageError('git.commit.cannotParseDetails');
        // Pretty-format parents can be shortened at a shallow boundary; preserve the object's recorded parents.
        const parents = await this.originalParents(repo, rev);
        return { sha: rev, author: { name: fields[1]!, email: fields[2]!, date: fields[3]! }, committer: { name: fields[4]!, email: fields[5]!, date: fields[6]! }, subject: fields[7]!, message: fields[8]!, parents, shallow };
    }

    async blame(id: string, query: BlameQuery): Promise<FileBlame> {
        if (!query || typeof query.path !== 'string' || query.path.length > 4096 || (query.boundary !== undefined && typeof query.boundary !== 'string')) throw new MessageError('git.blame.invalidQuery');
        const start = query.start === undefined ? 1 : query.start;
        if (!Number.isSafeInteger(start) || start < 1 || start > 15000) throw new MessageError('git.blame.startRange');
        const repo = await this.repo(id), revision = await this.revision(repo, query.revision, true);
        this.safePath(repo, query.path);
        const boundary = await this.inspectionBoundary(repo);
        if (query.boundary !== undefined && query.boundary !== boundary.boundary) throw new MessageError('git.blame.shallowChanged');
        const result: FileBlame = { revision, path: query.path, start, totalLines: 0, lines: [], ...boundary };
        const notice = (message: string): FileBlame => ({ ...result, notice: message });
        const tree = await this.git(repo.path, ['--no-replace-objects', 'ls-tree', '--full-tree', '-z', revision, '--', query.path]);
        const entries = this.utf8(tree.stdout).split('\0').filter(Boolean);
        const entry = entries.length === 1 && /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(entries[0]!);
        if (!entry || entry[4] !== query.path) return notice(t('git.blame.notInCommit'));
        if (entry[1] === '160000') return notice(t('git.blame.submodule'));
        if (entry[1] === '120000') return notice(t('git.blame.symlink'));
        if (!['100644', '100755'].includes(entry[1]!) || entry[2] !== 'blob') return notice(t('git.blame.regularOnly'));
        const object = entry[3]!;
        const size = Number(await this.text(repo.path, ['--no-replace-objects', 'cat-file', '-s', object]));
        if (!Number.isSafeInteger(size) || size < 0) throw new MessageError('git.blame.cannotReadSize');
        if (size > CONTENT_LIMIT) return notice(t('git.blame.tooLarge'));
        const buffer = (await this.git(repo.path, ['--no-replace-objects', 'cat-file', 'blob', object])).stdout;
        if (/^version https:\/\/git-lfs.github.com\/spec\/v1\r?\n/.test(buffer.toString('utf8'))) return notice(t('git.blame.lfs'));
        if (buffer.includes(0) || /\.(png|jpe?g|webp|gif)$/i.test(query.path)) return notice(t('git.blame.binary'));
        const content = buffer.toString('utf8');
        if (!Buffer.from(content, 'utf8').equals(buffer)) return notice(t('git.blame.notUtf8'));
        if (!buffer.length) return notice(t('git.blame.empty'));
        const contents = content.split('\n');
        if (contents[contents.length - 1] === '') contents.pop();
        result.totalLines = contents.length;
        if (result.totalLines > 15000) return notice(t('git.blame.tooManyLines'));
        if (start > result.totalLines) throw new MessageError('git.blame.startOutOfRange');
        const end = Math.min(start + 199, result.totalLines);
        let raw: CommandResult;
        try {
            raw = await this.git(repo.path, ['--no-replace-objects', '-c', 'blame.blankBoundary=false', '-c', 'blame.showRoot=false', '-c', 'diff.indentHeuristic=false', 'blame', '--line-porcelain', '--encoding=UTF-8', '--no-textconv', '--no-ignore-revs-file', '-L', `${start},${end}`, revision, '--', query.path]);
        } catch (error) { throw new MessageError('git.blame.failed', { error: message(error) }); }
        const lines = parseBlame(this.utf8(raw.stdout));
        if (lines.length !== end - start + 1 || lines.some((line, index) => line.line !== start + index || line.text !== contents[line.line - 1])) throw new MessageError('git.blame.contentMismatch');
        // Blame always reads the working tree's mailmap. Fetch raw author metadata to keep this snapshot independent of it.
        const revisions = [...new Set(lines.map(line => line.sha))];
        const authors = await this.git(repo.path, ['--no-replace-objects', 'log', '--no-walk=unsorted', '--no-show-signature', '--no-notes', '--no-decorate', '--no-color', '--no-use-mailmap', '--encoding=UTF-8', '--format=%H%x00%an%x00%ae%x00%aI%x00%s%x00', '--stdin'], { input: revisions.join('\n') + '\n' });
        const fields = this.utf8(authors.stdout).split('\0'), people = new Map<string, { author: string; email: string; date: string; summary: string }>();
        for (let i = 0; i + 4 < fields.length; i += 5) {
            const hash = (fields[i] || '').replace(/^\n/, '');
            if (!HASH.test(hash) || !revisions.includes(hash)) throw new MessageError('git.blame.authorUnparsable');
            people.set(hash, { author: fields[i + 1]!, email: fields[i + 2]!, date: fields[i + 3]!, summary: fields[i + 4]! });
        }
        result.lines = lines.map(line => {
            const person = people.get(line.sha);
            if (!person) throw new MessageError('git.blame.commitIncomplete');
            this.safePath(repo, line.originalPath);
            return { ...line, ...person };
        });
        if ((await this.inspectionBoundary(repo)).boundary !== boundary.boundary) throw new MessageError('git.blame.shallowChangedWhileReading');
        if (end < result.totalLines) result.nextStart = end + 1;
        return result;
    }

    async commitFiles(id: string, revision: string): Promise<ChangedFile[]> {
        const repo = await this.repo(id), rev = await this.revision(repo, revision, true);
        return (await this.commitChanges(repo, rev)).files;
    }

    private async commitChanges(repo: Repository, rev: string): Promise<{ parent: string; files: ChangedFile[] }> {
        const parent = await this.text(repo.path, ['--no-replace-objects', 'rev-parse', '--verify', rev + '^'], [0, 128]);
        if (!parent && (await this.originalParents(repo, rev)).length) throw new MessageError('git.blame.firstParentUnavailable');
        const args = parent ? ['diff', '--name-status', '--no-renames', '-z', parent, rev] : ['diff-tree', '--root', '--no-commit-id', '--name-status', '--no-renames', '-z', '-r', rev];
        const fields = (await this.git(repo.path, ['--no-replace-objects', ...args])).stdout.toString('utf8').split('\0');
        const result: ChangedFile[] = [];
        for (let i = 0; i + 1 < fields.length; i += 2) if (fields[i + 1]) result.push({ path: fields[i + 1]!, index: fields[i] || 'M', worktree: ' ', conflict: false, submodule: false });
        return { parent, files: result };
    }

    private safePath(repo: Repository, name: string): string {
        if (!name || name.includes('\0') || name.split(/[\\/]/).includes('.git') || path.isAbsolute(name)) throw new MessageError('git.invalidFilePath');
        const absolute = path.resolve(repo.path, name);
        if (!inside(repo.path, absolute) || absolute === repo.path) throw new MessageError('git.fileOutsideRepo');
        return absolute;
    }

    private async disk(repo: Repository, name: string): Promise<Buffer> {
        const absolute = this.safePath(repo, name);
        const parent = await fs.realpath(path.dirname(absolute)).catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
        if (!parent) return Buffer.alloc(0);
        if (!inside(repo.path, parent)) throw new MessageError('git.fileSymlinkOutside');
        const stat = await fs.lstat(absolute).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
        if (!stat) return Buffer.alloc(0);
        if (stat.isSymbolicLink()) return Buffer.from(await fs.readlink(absolute));
        if (!stat.isFile()) return Buffer.from(t('git.placeholderDirectory'));
        if (stat.size > CONTENT_LIMIT) return Buffer.from(t('git.placeholderTooLarge', { size: stat.size }));
        return fs.readFile(absolute);
    }

    private async blob(repo: Repository, ref: string, name: string, originalObjects = false, presence?: { exists: boolean }): Promise<Buffer> {
        this.safePath(repo, name);
        const spec = `${ref}:${name}`;
        const options = originalObjects ? ['--no-replace-objects'] : [];
        const stat = await this.git(repo.path, [...options, 'cat-file', '-s', spec], { allowed: [0, 128] });
        if (presence) presence.exists = stat.code === 0;
        if (stat.code !== 0) return Buffer.alloc(0);
        if (Number(stat.stdout.toString()) > CONTENT_LIMIT) return Buffer.from(t('git.placeholderTooLargeShort'));
        return (await this.git(repo.path, [...options, 'show', spec])).stdout;
    }

    // `variant` picks the notice wording for the caller (history browser, two-revision compare) by id
    // instead of rewriting the default notice text afterwards.
    private async content(repo: Repository, name: string, buffer: Buffer, strictUtf8 = false, lfsEnvironment?: () => Promise<string>, variant: ContentVariant = {}): Promise<FileContent> {
        let lfs = false;
        const pointer = /^version https:\/\/git-lfs.github.com\/spec\/v1\r?\noid sha256:([a-f0-9]{64})\r?\nsize (\d+)\s*$/.exec(buffer.toString('utf8'));
        if (pointer?.[1]) {
            lfs = true;
            if (Number(pointer[2]) > CONTENT_LIMIT) return { lfs, notice: t('git.lfsTooLarge') };
            const env = await (lfsEnvironment ? lfsEnvironment() : this.text(repo.path, ['lfs', 'env']));
            const dir = /^LocalMediaDir=(.+)$/m.exec(env)?.[1];
            if (!dir) throw new MessageError('git.lfsNoMediaDir');
            const oid = pointer[1];
            const object = path.join(dir, oid.slice(0, 2), oid.slice(2, 4), oid);
            const stat = await fs.stat(object).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
            if (stat && stat.size > CONTENT_LIMIT) return { lfs, notice: t('git.lfsLocalTooLarge') };
            const actual = stat ? await fs.readFile(object) : null;
            if (!actual) return { lfs, notice: t(variant.lfs === 'history' ? 'git.lfsNotDownloadedHistory' : variant.lfs === 'compare' ? 'git.lfsNotDownloadedCompare' : 'git.lfsNotDownloaded') };
            if (sha(actual) !== oid) throw new MessageError('git.lfsChecksumFailed');
            buffer = actual;
        }
        const ext = path.extname(name).toLowerCase();
        const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
        if (buffer.length && mime[ext]) return { lfs, image: `data:${mime[ext]};base64,${buffer.toString('base64')}` };
        if (buffer.includes(0)) return { lfs, notice: t('git.binaryFile', { size: buffer.length }) };
        const text = buffer.toString('utf8');
        if (strictUtf8 && !Buffer.from(text).equals(buffer)) return { lfs, notice: t(variant.plainUtf8Notice ? 'git.fileNotUtf8' : 'git.historyFileNotUtf8') };
        return { lfs, text };
    }

    private conflictContent(name: string, buffer: Buffer): FileContent {
        if (buffer.length > CONTENT_LIMIT) return { notice: t('git.conflict.tooLarge') };
        if (/^version https:\/\/git-lfs.github.com\/spec\/v1(?:\r?\n|$)/.test(buffer.toString('utf8'))) return { lfs: true, notice: t('git.conflict.lfsPointer') };
        const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
        if (buffer.length && mime[path.extname(name).toLowerCase()]) return { image: `data:${mime[path.extname(name).toLowerCase()]};base64,${buffer.toString('base64')}` };
        if (buffer.includes(0)) return { notice: t('git.conflict.binary') };
        const text = buffer.toString('utf8');
        if (!Buffer.from(text, 'utf8').equals(buffer)) return { notice: t('git.conflict.notUtf8') };
        if (text.split('\n').length - (text.endsWith('\n') ? 1 : 0) > 15000) return { notice: t('git.conflict.tooManyLines') };
        return { text };
    }

    private async conflictIndex(repo: Repository, name: string): Promise<{ raw: string; entries: { path: string; mode: string; object: string; stage: number }[] }> {
        this.safePath(repo, name);
        const raw = this.utf8((await this.git(repo.path, ['ls-files', '--stage', '-z', '--', name])).stdout);
        const entries = raw.split('\0').filter(Boolean).map(record => {
            const match = /^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t([\s\S]+)$/.exec(record);
            if (!match) throw new MessageError('git.conflict.cannotParseIndex');
            return { path: match[4]!, mode: match[1]!, object: match[2]!, stage: Number(match[3]) };
        });
        return { raw, entries };
    }

    private async conflictOperation(repo: Repository): Promise<string> {
        const gitDir = await this.text(repo.path, ['rev-parse', '--absolute-git-dir']), digest = createHash('sha256');
        let count = 0, bytes = 0;
        const read = async (relative: string): Promise<void> => {
            const file = path.join(gitDir, relative), stat = await fs.lstat(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
            digest.update(relative + '\0');
            if (!stat) { digest.update('missing\0'); return; }
            if (++count > 2000 || stat.isSymbolicLink()) throw new MessageError('git.conflict.stateUnsafe');
            if (stat.isDirectory()) {
                digest.update('directory\0');
                for (const child of (await fs.readdir(file)).sort()) await read(path.join(relative, child));
            } else if (stat.isFile()) {
                bytes += stat.size;
                if (bytes > READ_LIMIT) throw new MessageError('git.conflict.stateOverLimit');
                const data = await fs.readFile(file);
                digest.update(String(data.length) + '\0').update(data);
            } else throw new MessageError('git.conflict.stateSpecialFile');
        };
        for (const name of ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'AUTO_MERGE', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'ORIG_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply', 'sequencer']) await read(name);
        return digest.digest('hex');
    }

    private async conflictView(repo: Repository, name: string): Promise<ConflictView> {
        const absolute = this.safePath(repo, name), file = repo.files.find(value => value.path === name && value.conflict);
        if (!file) throw new MessageError('git.conflict.notInList');
        const index = await this.conflictIndex(repo, name), entries = index.entries.filter(entry => entry.path === name && entry.stage !== 0);
        if (!entries.length || new Set(entries.map(entry => entry.stage)).size !== entries.length) throw new MessageError('git.conflict.noStages');
        const stages: ConflictStage[] = [];
        let blockedReason = index.entries.some(entry => entry.path !== name || entry.stage === 0) ? t('git.conflict.overlapping') : '';
        if (new Set(entries.map(entry => entry.mode)).size > 1) blockedReason ||= t('git.conflict.modesDiffer');
        for (const entry of entries) {
            if (entry.stage !== 1 && entry.stage !== 2 && entry.stage !== 3) throw new MessageError('git.conflict.invalidStage');
            let content: FileContent;
            if (!['100644', '100755'].includes(entry.mode)) content = { notice: entry.mode === '160000' ? t('git.conflict.submodulePointer', { object: entry.object }) : t('git.conflict.specialMode', { mode: entry.mode }) };
            else {
                const size = Number(await this.text(repo.path, ['--no-replace-objects', 'cat-file', '-s', entry.object]));
                if (!Number.isSafeInteger(size) || size < 0) throw new MessageError('git.conflict.cannotReadSize');
                content = size > CONTENT_LIMIT ? { notice: t('git.conflict.previewTooLarge') } : this.conflictContent(name, (await this.git(repo.path, ['--no-replace-objects', 'cat-file', 'blob', entry.object])).stdout);
            }
            if (content.text === undefined) blockedReason ||= t('git.conflict.unsupportedContent');
            stages.push({ stage: entry.stage, mode: entry.mode, object: entry.object, content });
        }
        let parent = path.dirname(absolute), unsafeParent = false;
        while (true) {
            const real = await fs.realpath(parent).catch(e => { if (e.code === 'ENOENT') return undefined; throw e; });
            if (real !== undefined) { unsafeParent = real !== parent || !inside(repo.path, real); break; }
            const next = path.dirname(parent);
            if (next === parent) throw new MessageError('git.conflict.parentUnknown');
            parent = next;
        }
        const stat = unsafeParent ? null : await fs.lstat(absolute).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
        let working: FileContent, workingHash: string;
        if (unsafeParent) { working = { notice: t('git.conflict.worktreeSymlink') }; workingHash = 'unsafe'; blockedReason ||= working.notice!; }
        else if (!stat) { working = { notice: t('git.conflict.worktreeMissing') }; workingHash = 'missing'; }
        else if (!stat.isFile() || stat.isSymbolicLink()) { working = { notice: t('git.conflict.worktreeSpecial') }; workingHash = `${stat.mode}:${stat.size}:${stat.mtimeMs}`; blockedReason ||= working.notice!; }
        else if (stat.size > CONTENT_LIMIT) { working = { notice: t('git.conflict.worktreeTooLarge') }; workingHash = `${stat.mode}:${stat.size}:${stat.mtimeMs}`; blockedReason ||= working.notice!; }
        else {
            const buffer = await fs.readFile(absolute); working = this.conflictContent(name, buffer); workingHash = sha(buffer) + ':' + stat.mode;
            if (working.text === undefined) blockedReason ||= t('git.conflict.worktreeNotText');
        }
        const attributes: string[] = [], markerSizes = new Set([7]);
        const attributeNames = ['filter', 'working-tree-encoding', 'ident', 'diff', 'merge', 'conflict-marker-size', 'text', 'eol', 'crlf'];
        for (const cached of [false, true]) {
            const raw = this.utf8((await this.git(repo.path, ['check-attr', ...(cached ? ['--cached'] : []), '-z', ...attributeNames, '--', name])).stdout);
            attributes.push(raw);
            const fields = raw.split('\0');
            if (fields.pop() !== '' || fields.length !== attributeNames.length * 3) throw new MessageError('git.conflict.cannotReadAttributes');
            for (let i = 0; i < fields.length; i += 3) {
                if (fields[i] !== name) throw new MessageError('git.conflict.attributePathMismatch');
                const attr = fields[i + 1]!, value = fields[i + 2]!;
                if (attr !== attributeNames[i / 3]) throw new MessageError('git.conflict.attributeOrderMismatch');
                if (attr === 'conflict-marker-size') { const size = parseInt(value, 10); if (Number.isSafeInteger(size) && size > 0) markerSizes.add(size); }
                else if (['text', 'eol', 'crlf'].includes(attr)) continue;
                else if (attr === 'diff' ? !['unspecified', 'set'].includes(value) : attr === 'merge' ? !['unspecified', 'set', 'text'].includes(value) : !['unspecified', 'unset'].includes(value)) blockedReason ||= t('git.conflict.filtered');
            }
        }
        if (working.text !== undefined && working.text.split('\n').some(line => {
            const match = /^(<{1,}|>{1,}|={1,}|\|{1,})(?:\s|$)/.exec(line);
            return !!match && [...markerSizes].some(size => match[1]!.length >= size);
        })) blockedReason ||= t('git.conflict.markersRemain');
        if (!['', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'].includes(repo.operation)) blockedReason ||= t('git.conflict.operationUnsupported');
        const operation = await this.conflictOperation(repo), config = (await this.git(repo.path, ['config', '--null', '--list'])).stdout;
        return { path: name, status: file.index + file.worktree, operation: repo.operation, stages, working, workingExists: !!stat || unsafeParent, blockedReason: blockedReason || undefined, resolution: blockedReason ? undefined : stat ? 'content' : 'delete', version: sha(JSON.stringify({ repo: repo.version, index: index.raw, workingHash, attributes, operation, config: sha(config) })) };
    }

    private async selectedResolution(repo: Repository, request: OperationRequest): Promise<ConflictView> {
        const selection = request.resolution;
        if (!selection || typeof selection.path !== 'string' || !/^[a-f0-9]{64}$/.test(selection.version) || !['content', 'delete'].includes(selection.mode)) throw new MessageError('git.conflict.readFirst');
        if (request.paths && (request.paths.length !== 1 || request.paths[0] !== selection.path)) throw new MessageError('git.conflict.onePath');
        const view = await this.conflictView(repo, selection.path);
        if (view.blockedReason || !view.resolution) throw new Error(view.blockedReason || t('git.conflict.cannotMarkHere'));
        if (view.version !== selection.version || view.resolution !== selection.mode) throw new MessageError('git.conflict.changed');
        return view;
    }

    private async diffPair<T>(left: () => Promise<T>, right: () => Promise<T>): Promise<[T, T]> {
        const previous = this.diffPairTail;
        let release!: () => void;
        this.diffPairTail = new Promise<void>(resolve => { release = resolve; });
        await previous;
        try {
            // Drain both sides before releasing the next pair, including on failure.
            const [before, after] = await Promise.allSettled([Promise.resolve().then(left), Promise.resolve().then(right)]);
            if (before.status === 'rejected') throw before.reason;
            if (after.status === 'rejected') throw after.reason;
            return [before.value, after.value];
        } finally { release(); }
    }

    async diff(request: DiffRequest): Promise<FileDiff> {
        const repo = await this.repoForDiff(request.repo);
        if (request.area === 'index-compare') {
            if (!request.left) throw new MessageError('git.compare.indexNeedsSnapshot');
            if (Object.keys(request).some(key => !['repo', 'path', 'area', 'left'].includes(key))) throw new MessageError('git.compare.indexExtraFields');
            return this.indexComparison(repo, request.left, request.path);
        }
        if (request.area === 'worktree-compare') {
            if (!request.left) throw new MessageError('git.compare.worktreeNeedsSnapshot');
            if (Object.keys(request).some(key => !['repo', 'path', 'area', 'left'].includes(key))) throw new MessageError('git.compare.worktreeExtraFields');
            return this.worktreeComparison(repo, request.left, request.path);
        }
        if (request.area === 'file-compare') {
            if (!request.left || !request.right || request.path !== request.right.path || typeof request.force !== 'undefined' && typeof request.force !== 'boolean') throw new MessageError('git.compare.needSides');
            if (Object.keys(request).some(key => !['repo', 'path', 'area', 'left', 'right', 'force'].includes(key))) throw new MessageError('git.compare.extraFields');
            return this.fileComparison(repo, request.left, request.right, request.force);
        }
        if (request.area === 'tree') return this.treeFile(repo, request);
        if (request.area === 'conflict') {
            const conflict = await this.conflictView(repo, request.path);
            return { path: request.path, before: { notice: t('git.diff.conflictView') }, after: conflict.working, patch: '', conflict };
        }
        if (request.area === 'compare') return this.comparisonDiff(repo, request);
        if (!['worktree', 'index', 'commit', 'stash'].includes(request.area)) throw new MessageError('git.diff.unsupportedArea');
        const beforeState = { exists: false };
        let before: Buffer, after: Buffer;
        if (request.area === 'stash') {
            const rev = await this.revision(repo, request.revision || '');
            const file = (await this.stashFiles(repo.id, rev)).find(f => f.path === request.path && f.stashPart === request.stashPart);
            if (!file) throw new MessageError('git.diff.notInStash');
            if (file.submodule) return { path: request.path, before: { notice: t('git.diff.stashSubmodule') }, after: { notice: t('git.diff.stashSubmoduleHint') }, patch: '' };
            before = request.stashPart === 'untracked' ? Buffer.alloc(0) : await this.blob(repo, rev + '^1', request.path, false, beforeState);
            after = await this.blob(repo, request.stashPart === 'untracked' ? rev + '^3' : request.stashPart === 'index' ? rev + '^2' : rev, request.path);
        } else if (request.area === 'commit') {
            const rev = await this.revision(repo, request.revision || '', true);
            const { parent, files } = await this.commitChanges(repo, rev);
            if (!files.some(f => f.path === request.path)) throw new MessageError('git.diff.notInCommit');
            [before, after] = await this.diffPair(
                () => parent ? this.blob(repo, parent, request.path, true, beforeState) : Promise.resolve(Buffer.alloc(0)),
                () => this.blob(repo, rev, request.path, true));
        } else {
            const file = repo.files.find(f => f.path === request.path);
            if (!file) throw new MessageError('git.diff.fileStateChanged');
            if (file.submodule) return { path: request.path, before: { notice: t('git.diff.parentSubmodulePointer') }, after: { notice: t('git.diff.parentSubmoduleHint') }, patch: '' };
            if (file.conflict) return { path: request.path, before: { notice: t('git.diff.mergeConflict') }, after: await this.content(repo, request.path, await this.disk(repo, request.path)), patch: '' };
            before = request.area === 'index' ? (repo.head ? await this.blob(repo, 'HEAD', file.oldPath || file.path, false, beforeState) : Buffer.alloc(0)) : await this.blob(repo, '', file.path, false, beforeState);
            after = request.area === 'index' ? await this.blob(repo, '', file.path) : await this.disk(repo, file.path);
        }
        let environment: Promise<string> | undefined;
        const lfsEnvironment = () => environment ||= this.text(repo.path, ['lfs', 'env']);
        const readBefore = () => this.content(repo, request.path, before, false, lfsEnvironment);
        const readAfter = () => this.content(repo, request.path, after, false, lfsEnvironment);
        const [left, right] = request.area === 'commit' ? await this.diffPair(readBefore, readAfter) : [await readBefore(), await readAfter()];
        left.exists = beforeState.exists;
        const result = await this.renderFileDiff(repo, request.path, left, right);
        if (request.area === 'worktree' || request.area === 'index') {
            const partial = await this.linePatch(repo, request.path, request.area);
            return { ...result, partial: partial.parsed ? { version: partial.version, hunks: partial.parsed.hunks } : undefined, partialReason: partial.reason };
        }
        return result;
    }

    private async renderFileDiff(repo: Repository, name: string, left: FileContent, right: FileContent, summary?: string, beforeName = name): Promise<FileDiff> {
        let patch = '';
        if (left.text !== undefined && right.text !== undefined) {
            await fs.mkdir(this.cache, { recursive: true });
            const temp = await fs.mkdtemp(path.join(this.cache, 'diff-'));
            try {
                const a = path.join(temp, 'before'), b = path.join(temp, 'after');
                await fs.writeFile(a, left.text); await fs.writeFile(b, right.text);
                patch = (await this.git(temp, ['diff', '--no-index', '--no-prefix', '--no-relative', '--no-ext-diff', '--no-textconv', '--', 'before', 'after'], { allowed: [0, 1] })).stdout.toString('utf8');
                const label = (value: string) => /[\s"\\]/.test(value) ? JSON.stringify(value) : value;
                const beforeLabel = label('before/' + beforeName), afterLabel = label('after/' + name);
                // Only headers are synthetic; replacing strings in hunks would corrupt source text.
                let body = false;
                patch = patch.split('\n').map(line => {
                    if (line.startsWith('@@')) body = true;
                    if (body) return line;
                    if (line === 'diff --git before after') return `diff --git ${beforeLabel} ${afterLabel}`;
                    if (line === '--- before') return '--- ' + beforeLabel;
                    if (line === '+++ after') return '+++ ' + afterLabel;
                    return line;
                }).join('\n');
            } finally { await fs.rm(temp, { recursive: true, force: true }); }
        }
        return { path: name, before: left, after: right, patch, summary };
    }

    private async linePatch(repo: Repository, name: string, area: 'worktree' | 'index'): Promise<LinePatch> {
        const unavailable = (reason: string): LinePatch => ({ version: '', reason });
        const file = repo.files.find(f => f.path === name);
        if (!file || file.conflict || file.submodule || file.oldPath || ![' ', 'M'].includes(file.index) || ![' ', 'M'].includes(file.worktree) || (area === 'index' ? file.index : file.worktree) !== 'M') return unavailable(t('git.lines.trackedOnly'));
        const absolute = this.safePath(repo, name), parent = await fs.realpath(path.dirname(absolute));
        if (!inside(repo.path, parent) || parent !== path.dirname(absolute)) return unavailable(t('git.lines.symlink'));
        const stat = await fs.lstat(absolute).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
        if (!stat?.isFile() || stat.size > CONTENT_LIMIT) return unavailable(t('git.lines.sizeLimit'));
        const attributes: string[] = [];
        for (const cached of [false, true]) {
            const raw = (await this.git(repo.path, ['check-attr', ...(cached ? ['--cached'] : []), '-z', 'filter', 'working-tree-encoding', 'ident', 'diff', '--', name])).stdout.toString('utf8');
            attributes.push(raw);
            const fields = raw.split('\0');
            for (let i = 0; i + 2 < fields.length; i += 3) {
                const attr = fields[i + 1], value = fields[i + 2];
                if (attr === 'diff' ? value !== 'unspecified' && value !== 'set' : value !== 'unspecified' && value !== 'unset') return unavailable(t('git.lines.filtered'));
            }
        }
        const entry = (await this.git(repo.path, ['ls-files', '--stage', '-z', '--', name])).stdout.toString('utf8');
        if (!/^100(?:644|755) [a-f0-9]+ 0\t/.test(entry)) return unavailable(t('git.lines.specialEntry'));
        for (const ref of area === 'index' ? ['HEAD', ''] : ['']) {
            const size = Number(await this.text(repo.path, ['cat-file', '-s', `${ref}:${name}`]));
            if (size > CONTENT_LIMIT) return unavailable(t('git.lines.versionTooLarge'));
        }
        const before = await this.blob(repo, area === 'index' ? 'HEAD' : '', name);
        let after: Buffer | undefined;
        if(area==='index')after=await this.blob(repo,'',name);
        else {
            try { after=(await this.recovery.readDisk(repo.path,name,CONTENT_LIMIT)).bytes; }
            catch(error){ return unavailable(t('git.lines.readStopped', { error: message(error) })); }
        }
        if (!after) return unavailable(t('git.lines.fileVanished'));
        if ([before, after].some(b => b.includes(0) || !Buffer.from(b.toString('utf8'), 'utf8').equals(b) || b.toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1'))) return unavailable(t('git.lines.binary'));
        const args = ['-c', 'diff.suppressBlankEmpty=false', 'diff', ...(area === 'index' ? ['--cached'] : []), '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/', '--diff-algorithm=myers', '--no-indent-heuristic', '--unified=3', '--inter-hunk-context=0', '--output-indicator-new=+', '--output-indicator-old=-', '--output-indicator-context= ', '--', name];
        const raw = (await this.git(repo.path, args)).stdout;
        if (!raw.length) return unavailable(t('git.lines.noTextDiff'));
        if (!Buffer.from(raw.toString('utf8')).equals(raw)) return unavailable(t('git.lines.diffNotUtf8'));
        try {
            const parsed = parsePatch(raw.toString('utf8'));
            return { parsed, version: sha(JSON.stringify([repo.path, repo.head, name, area, entry, attributes, sha(before), sha(after), sha(raw)])) };
        } catch (error) { return unavailable(message(error)); }
    }

    private async selectedPatch(repo: Repository, request: OperationRequest): Promise<string> {
        const selection = request.lines;
        if (!selection || typeof selection.path !== 'string' || typeof selection.version !== 'string') throw new MessageError('git.lines.selectionMissing');
        const current = await this.linePatch(repo, selection.path, request.action === 'unstageLines' ? 'index' : 'worktree');
        if (!current.parsed) throw new Error(current.reason || t('git.lines.unsupported'));
        if (selection.version !== current.version) throw new MessageError('git.lines.diffChanged');
        return selectPatch(current.parsed, selection.ids, request.action === 'unstageLines');
    }

    private async discardLinePolicy(repo: Repository, name: string): Promise<string> {
        const policy = await this.recoveryPolicy(repo,[name]), eol: string[] = [];
        for (const cached of [false,true]) {
            const value = this.utf8((await this.git(repo.path,['check-attr',...(cached?['--cached']:[]),'--stdin','-z','eol'],{input:name+'\0'})).stdout);
            const fields = value.split('\0');
            if (fields.length !== 4 || fields[0] !== name || fields[1] !== 'eol' || fields[3] !== '' || !['unspecified','unset','lf'].includes(fields[2]!)) throw new MessageError('git.lines.discardLfOnly');
            eol.push(value);
        }
        return sha(JSON.stringify([policy,eol]));
    }

    private async discardLineState(repo: Repository, request: OperationRequest) {
        if (Object.entries(request).some(([key,value]) => value !== undefined && !['repo','version','action','lines'].includes(key))) throw new MessageError('git.lines.discardLinesOnly');
        const selection = request.lines;
        if (!selection || typeof selection !== 'object' || Array.isArray(selection) || Object.keys(selection).some(key => !['path','version','ids'].includes(key)) || typeof selection.path !== 'string' || typeof selection.version !== 'string') throw new MessageError('git.lines.selectUnstaged');
        const name = selection.path;
        await this.recovery.filename(repo.path, name);
        if (['.gitattributes','.gitmodules','.lfsconfig'].includes(path.posix.basename(name).toLowerCase())) throw new MessageError('git.lines.discardConfigFiles');
        if (await this.text(repo.path,['rev-parse','--shared-index-path'])) throw new MessageError('git.lines.splitIndex');
        const flags = (await this.git(repo.path,['ls-files','-v','-z','--',name])).stdout;
        if (this.utf8(flags) !== 'H '+name+'\0') throw new MessageError('git.lines.specialIndexPaths');
        const policy = await this.discardLinePolicy(repo,name);
        const disk = await this.recovery.readDisk(repo.path,name,CONTENT_LIMIT);
        if (!disk.bytes || disk.bytes.includes(0) || disk.bytes.includes(13) || !Buffer.from(disk.bytes.toString('utf8')).equals(disk.bytes)) throw new MessageError('git.lines.discardLfFilesOnly');
        if(process.platform!=='win32' && ![0o644,0o755].includes(disk.stamp.mode))throw new MessageError('git.lines.discardModes');
        const current = await this.linePatch(repo,name,'worktree');
        if (!current.parsed) throw new Error(current.reason || t('git.lines.discardUnsupported'));
        if (selection.version !== current.version) throw new FileStateChangedError(t('git.lines.diffChanged'));
        const patch = selectPatch(current.parsed,selection.ids,true);
        if (Buffer.byteLength(JSON.stringify(patch)) > 128*1024) throw new MessageError('git.lines.discardPatchTooLarge');
        const parsed = parsePatch(patch);
        if (parsed.hunks.some(hunk => hunk.lines.some(line => line.text.includes('\r')))) throw new MessageError('git.lines.discardCr');
        const expected = Buffer.from(applyPatchText(disk.bytes.toString('utf8'),parsed));
        if (expected.length > CONTENT_LIMIT) throw new MessageError('git.lines.discardResultTooLarge');
        if (expected.equals(disk.bytes)) throw new MessageError('git.lines.nothingToDiscard');
        const indexHash = sha(await this.mergeFile(repo,'index',READ_LIMIT));
        if (JSON.stringify((await this.recovery.readDisk(repo.path,name,CONTENT_LIMIT)).stamp) !== JSON.stringify(disk.stamp)) throw new FileStateChangedError(t('git.lines.diskChanged'));
        return { name, patch, expected, stamp: disk.stamp, indexHash, policy,
            version: sha(JSON.stringify([repo.version,name,current.version,patch,disk.stamp,indexHash,policy,sha(expected)])) };
    }

    private async fingerprints(repo: Repository, paths: string[], action?: Action): Promise<string> {
        const local = this.localIndexAction(action);
        const hash = createHash('sha256').update(local ? this.indexVersions.get(repo) || repo.version : repo.version);
        if (local) {
            const related = new Set(paths);
            for (const name of paths) {
                related.add(name.endsWith('.meta') ? name.slice(0, -5) : name + '.meta');
                let dir = path.posix.dirname(name); while (dir !== '.') { related.add(dir + '.meta'); dir = path.posix.dirname(dir); }
            }
            hash.update(JSON.stringify(repo.files.filter(file => file.conflict || related.has(file.path) || !!file.oldPath && related.has(file.oldPath))));
        }
        const contentPaths = new Set(paths);
        if (local && (action === 'stage' || action === 'commitSelected')) {
            // Attribute edits can change Git's clean filters without changing selected source bytes.
            for (const name of paths) {
                let dir = path.posix.dirname(name);
                while (true) {
                    contentPaths.add(dir === '.' ? '.gitattributes' : dir + '/.gitattributes');
                    if (dir === '.') break;
                    dir = path.posix.dirname(dir);
                }
            }
        }
        for (const name of contentPaths) {
            hash.update(name);
            const absolute = this.safePath(repo, name);
            if (local && repo.files.some(file => file.path === name && file.submodule)) {
                hash.update(await this.text(absolute, ['rev-parse', '--verify', 'HEAD']));
            }
            const stat = await fs.lstat(absolute).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
            if (!stat) { hash.update('deleted'); continue; }
            if (stat.isSymbolicLink()) { hash.update(await fs.readlink(absolute)); continue; }
            if (stat.isFile()) {
                const parent = await fs.realpath(path.dirname(absolute));
                if (!inside(repo.path, parent)) throw new MessageError('git.filePointsOutside');
                for await (const chunk of createReadStream(absolute)) hash.update(chunk);
            } else hash.update(String(stat.mtimeMs));
        }
        return hash.digest('hex');
    }

    private scopeVersion(repo: Repository, action?: Action): string {
        if (this.localIndexAction(action)) return this.indexVersions.get(repo) || repo.version;
        return sha(this.repositories.filter(r => inside(repo.path, r.path)).map(r => r.id + r.version + r.error + r.initialized).join('\n'));
    }

    private requiresEditorForCommit(repo: Repository): boolean {
        return repo.files.filter(STAGED).some(file => file.submodule || !/\.(?:[cm]?[jt]sx?|json|md|txt|csv|css|html|proto|ya?ml)$/i.test(file.path)
            || !!file.oldPath && !/\.(?:[cm]?[jt]sx?|json|md|txt|csv|css|html|proto|ya?ml)$/i.test(file.oldPath));
    }

    // A merge only needs the paths it touches to be clean: Git itself refuses to overwrite local edits, so
    // unrelated unstaged files (and their .meta pairs) stay as they are. Staged changes still block, because
    // a non-fast-forward merge cannot run with an index that differs from HEAD.
    private assertMergeable(repo: Repository, touched: string[], allowPointerChanges = false): string[] {
        const set = new Set(touched);
        const pair = (name: string) => name.endsWith('.meta') ? name.slice(0, -5) : name + '.meta';
        const overlaps = (name: string) => set.has(name) || set.has(pair(name)) || touched.some(item => item.startsWith(name + '/') || name.startsWith(item + '/'));
        const kept: string[] = [], blocked: string[] = [];
        for (const r of this.repositories.filter(r => inside(repo.path, r.path))) {
            if (r.error || r.operation) throw new MessageError('git.repoError', { name: r.name, detail: r.error || t('git.unfinishedOperation', { operation: r.operation }) });
            if (r.id !== repo.id) { if (r.files.length) throw new MessageError('git.submodules.localChanges', { name: r.name }); continue; }
            for (const f of r.files) {
                if (f.conflict) throw new MessageError('git.merge.conflictFile', { name: r.name, path: f.path });
                if (f.submodule) { if (allowPointerChanges && !STAGED(f) && f.worktree === 'M') { kept.push(f.path); continue; } throw new MessageError('git.merge.pointerChange', { name: r.name, path: f.path }); }
                if (STAGED(f)) throw new MessageError('git.merge.stagedChanges', { name: r.name, path: f.path });
                if (overlaps(f.path)) blocked.push(f.path); else kept.push(f.path);
            }
        }
        if (blocked.length) throw new MessageError('git.merge.overlap', { name: repo.name, paths: blocked.slice(0, 10).join(t('git.listSeparator')), more: blocked.length > 10 ? t('git.andMore', { count: blocked.length }) : '' });
        return kept;
    }
    private selectedSubmodules(repo: Repository, request: OperationRequest): { children: Repository[]; named: string[] } {
        const children = this.repositories.filter(r => r.id !== repo.id && inside(repo.path, r.path));
        if (!children.length) throw new MessageError('git.submodules.none');
        if (request.paths === undefined) return { children, named: [] };
        if (!Array.isArray(request.paths) || !request.paths.length || request.paths.length > 50) throw new MessageError('git.submodules.pathCount');
        const rel = (r: Repository) => path.relative(repo.path, r.path).split(path.sep).join('/');
        const chosen = request.paths.map(name => { const found = children.find(r => rel(r) === name); if (!found) throw new MessageError('git.submodules.notSubmodule', { name }); return found; });
        // Nested modules inside a chosen one come along: submodule update --recursive descends into it.
        return { children: children.filter(r => chosen.some(c => inside(c.path, r.path))), named: chosen.map(rel) };
    }
    // Named submodule sync only needs those modules clean and pushed; other edits in the parent are untouched.
    private assertSubmodulesSyncable(repo: Repository, selected: { children: Repository[]; named: string[] }): void {
        if (!selected.named.length) { this.assertClean(repo, true); return; }
        if (repo.error || repo.operation) throw new MessageError('git.repoError', { name: repo.name, detail: repo.error || t('git.unfinishedOperation', { operation: repo.operation }) });
        for (const r of selected.children) {
            if (r.error || r.operation) throw new MessageError('git.repoError', { name: r.name, detail: r.error || t('git.unfinishedOperation', { operation: r.operation }) });
            if (r.files.length) throw new MessageError('git.submodules.localChanges', { name: r.name });
            if (r.ahead) throw new MessageError('git.submodules.unpushed', { name: r.name });
        }
        for (const f of repo.files) if (f.submodule && selected.named.includes(f.path) && STAGED(f)) throw new MessageError('git.submodules.parentStagedPointer', { path: f.path });
    }
    private assertClean(repo: Repository, allowPointerChanges = false): void {
        for (const r of this.repositories.filter(r => inside(repo.path, r.path))) {
            if (r.error || r.operation) throw new MessageError('git.repoError', { name: r.name, detail: r.error || t('git.unfinishedOperation', { operation: r.operation }) });
            if (r.files.some(f => !allowPointerChanges || !f.submodule || STAGED(f) || f.worktree !== 'M')) throw new MessageError('git.submodules.localChangesNoStash', { name: r.name });
            if (allowPointerChanges && r.ahead) throw new MessageError('git.submodules.unpushed', { name: r.name });
        }
    }

    private async selectedStashPaths(repo: Repository, request: OperationRequest): Promise<string[]> {
        await this.assertStashable(repo);
        if (!Array.isArray(request.paths) || !request.paths.length || request.paths.length > 5000) throw new MessageError('git.stash.selectFiles');
        const files = new Map(repo.files.map(file => [file.path, file]));
        const included = new Set<string>(), queued = new Set(request.paths), pending = [...queued];
        for (const name of pending) if (typeof name !== 'string' || !files.has(name)) throw new MessageError('git.stash.selectionChanged');
        for (let i = 0; i < pending.length; i++) {
            const name = pending[i]!;
            if (included.has(name)) continue;
            if (name === '.gitmodules') throw new MessageError('git.stash.noGitmodules');
            const file = files.get(name);
            if (file?.submodule || file?.conflict) throw new MessageError('git.stash.noPointersOrConflicts');
            if (file?.index === '?' && request.includeUntracked !== true) throw new MessageError('git.stash.needUntracked');
            this.treePath(repo, name);
            included.add(name);
            if (file) {
                const related = [file.oldPath, name.endsWith('.meta') ? name.slice(0, -5) : name + '.meta'];
                if (file.oldPath) related.push(file.oldPath.endsWith('.meta') ? file.oldPath.slice(0, -5) : file.oldPath + '.meta');
                for (const pathName of [name, file.oldPath]) {
                    if (!pathName) continue;
                    let directory = path.posix.dirname(pathName);
                    while (directory !== '.') { related.push(directory + '.meta'); directory = path.posix.dirname(directory); }
                }
                for (const sibling of related) {
                    if (sibling && (files.has(sibling) || sibling === file.oldPath) && !queued.has(sibling)) {
                        queued.add(sibling); pending.push(sibling);
                        if (queued.size > 5000) throw new MessageError('git.stash.scopeTooLarge');
                    }
                }
            }
            if (included.size > 5000) throw new MessageError('git.stash.scopeTooLarge');
        }
        for (const file of repo.files) if (STAGED(file) && !included.has(file.path)) throw new MessageError('git.stash.stagedOutside', { path: file.path });
        // A file pathspec can also match descendants if that path became a directory.
        for (const file of repo.files) {
            const segments = file.path.split('/');
            let ancestor = '';
            for (const part of segments.slice(0, -1)) {
                ancestor = ancestor ? ancestor + '/' + part : part;
                if (included.has(ancestor)) throw new MessageError('git.stash.directoryReplacement', { path: file.path });
            }
        }
        for (const name of included) {
            const absolute = this.safePath(repo, name);
            const stat = await fs.lstat(absolute).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
            if (stat && !stat.isFile() && !stat.isSymbolicLink()) throw new MessageError('git.stash.filesOnly', { name });
            const parent = await fs.realpath(path.dirname(absolute)).catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
            if (parent && !inside(repo.path, parent)) throw new MessageError('git.stash.linkOutside', { name });
        }
        return [...included].sort();
    }

    private async assertStashable(repo: Repository): Promise<void> {
        if (!repo.head) throw new MessageError('git.stash.needCommit');
        if (repo.operation || repo.files.some(f => f.conflict)) throw new MessageError('git.handleConflictsFirst');
        if (repo.files.some(f => f.submodule)) throw new MessageError('git.stash.noSubmoduleChanges');
        const previousTree = (await this.git(repo.path, ['ls-tree', '-r', '-z', 'HEAD'])).stdout.toString('utf8').split('\0');
        const previousLinks = previousTree.filter(entry => entry.startsWith('160000 ')).map(entry => entry.slice(entry.indexOf('\t') + 1));
        if (repo.files.some(file => previousLinks.some(name => file.path === name || file.path.startsWith(name + '/')))) throw new MessageError('git.stash.noRemovedPointers');
        for (const child of this.repositories.filter(r => r.id !== repo.id && inside(repo.path, r.path))) {
            if (child.error || child.operation || child.files.length) throw new MessageError('git.stash.submoduleIssue', { name: child.name });
        }
    }

    private async assertStashRestorePaths(repo: Repository, files: ChangedFile[]): Promise<void> {
        if (files.some(f => f.submodule)) throw new MessageError('git.stash.containsPointers');
        const links = await this.links(repo.path);
        const tracked = new Set((await this.git(repo.path, ['ls-files', '-z'])).stdout.toString('utf8').split('\0').filter(Boolean));
        for (const file of files) {
            if ([...links.keys()].some(name => file.path === name || file.path.startsWith(name + '/'))) throw new MessageError('git.stash.overlapsSubmodule', { path: file.path });
            const absolute = this.safePath(repo, file.path);
            const exists = await fs.lstat(absolute).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
            if (exists && (file.stashPart === 'untracked' || !tracked.has(file.path))) throw new MessageError('git.stash.collidesUntracked', { path: file.path });
            let parent = path.dirname(absolute);
            while (parent !== repo.path) {
                const stat = await fs.lstat(parent).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
                if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new MessageError('git.stash.targetThroughLink', { path: file.path });
                if (stat && await fs.lstat(path.join(parent, '.git')).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) throw new MessageError('git.stash.targetNested', { path: file.path });
                parent = path.dirname(parent);
            }
        }
    }

    private async pushTarget(repo: Repository, requested?: string): Promise<{ remote: string; target: string }> {
        if (!repo.branch || !repo.head) throw new MessageError('git.needLocalBranch');
        const remotes = (await this.details(repo.id)).remotes;
        const configured = await this.text(repo.path, ['config', '--get', `branch.${repo.branch}.remote`], [0, 1]);
        const merge = await this.text(repo.path, ['config', '--get', `branch.${repo.branch}.merge`], [0, 1]);
        const remote = configured || requested || (remotes.length === 1 ? remotes[0] : '');
        if (!remote || remote.startsWith('-') || !remotes.includes(remote)) throw new MessageError('git.chooseRemote');
        const target = configured && merge.startsWith('refs/heads/') ? merge : `refs/heads/${repo.branch}`;
        return { remote, target };
    }

    async commitDraft(id: string, query: DraftQuery): Promise<CommitDraft> {
        if (!query || query.kind !== 'draft' || !['read', 'save'].includes(query.action)) throw new MessageError('git.invalidDraftRequest');
        const repo = await this.repo(id);
        return query.action === 'read' ? this.drafts.read(repo.path) : this.drafts.save(repo.path, query.message, query.version);
    }

    private async mergeContext(repo: Repository): Promise<{ view: MergeState; staged: Buffer; paths: string[] }> {
        const view: MergeState = { repo: repo.id, repoVersion: repo.version, version: '', active: repo.operation === 'MERGE_HEAD', canFinish: false,
            head: repo.head, branch: repo.branch, conflicts: repo.files.filter(file => file.conflict).length, staged: null, pointers: false, message: '' };
        const empty = (reason: string) => ({ view: { ...view, reason, version: sha(JSON.stringify(view)) }, staged: Buffer.alloc(0), paths: [] });
        if (!view.active) return empty(t('git.merge.noPlainMerge'));
        const gitDir = await this.text(repo.path, ['rev-parse', '--absolute-git-dir']);
        for (const name of ['CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG', 'MERGE_AUTOSTASH', 'SQUASH_MSG']) {
            if (await fs.lstat(path.join(gitDir, name)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) return empty(t('git.merge.unsupportedState', { name }));
        }
        const metadata: Record<string, Buffer | null> = {};
        for (const name of ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE']) {
            const file = path.join(gitDir, name), stat = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
            if (!stat) { metadata[name] = null; continue; }
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536) throw new MessageError('git.merge.stateFileInvalid', { name });
            const data = await fs.readFile(file), after = await fs.lstat(file);
            if (data.length > 65536 || after.ino !== stat.ino || after.dev !== stat.dev || after.mtimeMs !== stat.mtimeMs || after.size !== stat.size) throw new MergeStateChangedError(t('git.merge.stateFilesChanged'));
            metadata[name] = data;
        }
        const mergeHead = metadata.MERGE_HEAD && /^([a-f0-9]{40}|[a-f0-9]{64})\n?$/.exec(this.utf8(metadata.MERGE_HEAD));
        if (!mergeHead || mergeHead[1] === repo.head) return empty(t('git.merge.twoParentsOnly'));
        if (await this.text(repo.path, ['--no-replace-objects', 'cat-file', '-t', mergeHead[1]!]) !== 'commit') return empty(t('git.merge.mergeHeadNotCommit'));
        view.mergeHead = await this.revision(repo, mergeHead[1]!, true);
        if (!repo.branch || !repo.head) return empty(t('git.merge.namedBranch'));
        await this.revision(repo, repo.head, true);
        const mode = metadata.MERGE_MODE ? this.utf8(metadata.MERGE_MODE) : '';
        if (mode && mode !== 'no-ff') return empty(t('git.merge.unsupportedMode'));
        if (await this.text(repo.path, ['rev-parse', '--is-shallow-repository']) === 'true') return empty(t('git.merge.shallow'));
        if (!mode) {
            const options = { allowed: [0, 1] };
            const left = await this.git(repo.path, ['--no-replace-objects', 'merge-base', '--is-ancestor', repo.head, view.mergeHead], options);
            const right = await this.git(repo.path, ['--no-replace-objects', 'merge-base', '--is-ancestor', view.mergeHead, repo.head], options);
            if (!left.code || !right.code) return empty(t('git.merge.ancestorNoFf'));
        }
        const encoding = await this.text(repo.path, ['config', '--get', 'i18n.commitEncoding'], [0, 1]);
        if (encoding && !/^utf-?8$/i.test(encoding)) return empty(t('git.merge.utf8Only'));
        const message = metadata.MERGE_MSG ? this.utf8(metadata.MERGE_MSG) : '';
        if (message.includes('\0')) throw new MessageError('git.merge.templateNul');
        if (message.length <= 5000) view.message = message;
        else view.messageNotice = t('git.merge.defaultTooLong');
        const config = (await this.git(repo.path, ['config', '--null', '--list'])).stdout;
        const operation = await this.conflictOperation(repo);
        const unmerged = (await this.git(repo.path, ['ls-files', '--unmerged', '-z'])).stdout;
        if (unmerged.length || view.conflicts) return empty(t('git.merge.unresolved'));
        const staged = (await this.git(repo.path, ['--no-replace-objects', 'diff', '--cached', '--raw', '--no-abbrev', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '-z', repo.head, '--'])).stdout;
        const records = this.utf8(staged).split('\0'), paths: string[] = [];
        if (records.pop() !== '' || records.length % 2 !== 0) throw new MessageError('git.merge.cannotReadStaged');
        if (records.length / 2 > 5000) return empty(t('git.merge.stagedTooLarge'));
        for (let i = 0; i < records.length; i += 2) {
            const match = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) [AMDTUXB]$/.exec(records[i]!);
            if (!match || !records[i + 1]) throw new MessageError('git.merge.cannotParseStaged');
            this.safePath(repo, records[i + 1]!); paths.push(records[i + 1]!);
            if (match[1] === '160000' || match[2] === '160000') view.pointers = true;
        }
        view.staged = paths.length; view.canFinish = true;
        view.version = sha(JSON.stringify({ repo: repo.version, metadata: Object.entries(metadata).map(([key, value]) => [key, value && sha(value)]), config: sha(config), operation, staged: sha(staged) }));
        return { view, staged, paths };
    }

    private async mergeFile(repo: Repository, name: string, limit = 65536): Promise<Buffer> {
        const directory=await this.text(repo.path,['rev-parse','--absolute-git-dir']);
        const filename=path.join(directory,name),file=await fs.open(filename,constants.O_RDONLY | constants.O_NOFOLLOW);
        try{
            const before=await file.stat();
            if(!before.isFile() || before.nlink!==1 || before.size>limit)throw new MessageError('git.merge.fileInvalid', { name });
            const bytes=Buffer.alloc(before.size+1);let length=0;
            while(length<bytes.length){const r=await file.read(bytes,length,bytes.length-length,length);if(!r.bytesRead)break;length+=r.bytesRead;}
            const after=await file.stat();
            if(length!==before.size || after.size!==before.size || after.mtimeMs!==before.mtimeMs || after.ctimeMs!==before.ctimeMs)throw new MergeStateChangedError(t('git.merge.fileChanged', { name }));
            return bytes.subarray(0,length);
        }finally{await file.close();}
    }

    private async mergeJournal(repo: Repository): Promise<{ draft: CommitDraft; session?: MergeSession }> {
        const draft=await this.mergeSessions.read(repo.path);
        if(!draft.message)return {draft};
        const value: MergeSession=JSON.parse(draft.message);
        if(!value || Object.keys(value).filter(key=>key!=='native').sort().join(',')!=='base,branch,head,index,nonce,paths,phase,policy,schema,target' || (value.native!==undefined && value.native!==true) || value.schema!==1 || !['prepared','active'].includes(value.phase) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.nonce) || typeof value.branch!=='string' || !value.branch || value.branch.length>200 || [value.head,value.target,value.base].some(v=>typeof v!=='string'||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v)) || [value.index,value.policy,value.paths].some(v=>typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v)))throw new MessageError('git.merge.sessionCorrupt');
        return {draft,session:value};
    }

    private async mergeGuard(repo: Repository): Promise<void> {
        if(!repo.branch || !repo.head)throw new MessageError('git.merge.needLocalBranch');
        if(await this.text(repo.path,['rev-parse','--is-shallow-repository'])==='true')throw new MessageError('git.merge.noShallow');
        const directory=await this.text(repo.path,['rev-parse','--absolute-git-dir']);
        for(const name of ['MERGE_AUTOSTASH','CHERRY_PICK_HEAD','REVERT_HEAD','REBASE_HEAD','rebase-merge','rebase-apply','sequencer','BISECT_LOG','SQUASH_MSG']){
            if(await fs.lstat(path.join(directory,name)).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))throw new MessageError('git.merge.unsupportedStateShort', { name });
        }
        for(const key of ['core.sparseCheckout','index.sparse'])if(await this.text(repo.path,['config','--type=bool','--get',key],[0,1])==='true')throw new MessageError('git.merge.noSparse');
        if(await this.text(repo.path,['rev-parse','--shared-index-path']))throw new MessageError('git.merge.noSplitIndex');
        const options=await this.text(repo.path,['config','--get-all','branch.'+repo.branch+'.mergeOptions'],[0,1]);
        if(options)throw new MessageError('git.merge.mergeOptions');
        if(await this.text(repo.path,['config','--get-regexp','^merge\\..*\\.driver$'],[0,1]))throw new MessageError('git.merge.noCustomDriver');
        const fallback=await this.text(repo.path,['config','--get','merge.default'],[0,1]);
        if(fallback && !['text','binary'].includes(fallback))throw new MessageError('git.merge.noDefaultDriver');
        for(const child of this.repositories.filter(r=>r.id!==repo.id && inside(repo.path,r.path)))if(child.error || child.operation || child.files.length)throw new MessageError('git.merge.submoduleNotReady', { id: child.id });
    }

    private async mergePaths(repo: Repository, head: string, target: string, base: string): Promise<string[]> {
        const paths=new Set<string>();
        for(const tip of [head,target]){
            const bytes=(await this.git(repo.path,['--no-replace-objects','diff','--name-only','--no-renames','--no-ext-diff','--no-textconv','--no-relative','--ignore-submodules=none','-z',base,tip,'--'])).stdout;
            if(bytes.length && bytes[bytes.length-1]!==0)throw new MessageError('git.merge.scopeIncomplete');
            for(const name of this.utf8(bytes).split('\0').filter(Boolean))paths.add(name);
        }
        const result=[...paths].sort();
        if(!result.length || result.length>RECOVERY_PATHS || result.reduce((n,p)=>n+Buffer.byteLength(p),0)>96*1024)throw new MessageError('git.merge.fileCount');
        return result;
    }

    private async mergePolicy(repo: Repository, paths: string[]): Promise<string> {
        const policy=await this.recoveryPolicy(repo,paths);
        const raw=(await this.git(repo.path,['check-attr','--stdin','-z','merge'],{input:paths.join('\0')+'\0'})).stdout;
        const fields=this.utf8(raw).split('\0');
        if(fields.pop()!=='' || fields.length!==paths.length*3)throw new MessageError('git.merge.attributesIncomplete');
        const seen=new Set<string>();
        for(let i=0;i<fields.length;i+=3){
            if(!paths.includes(fields[i]!) || seen.has(fields[i]!) || fields[i+1]!=='merge' || !['unspecified','set','unset','text','binary'].includes(fields[i+2]!))throw new MessageError('git.merge.unsupportedAttributes');
            seen.add(fields[i]!);
        }
        return sha(JSON.stringify([policy,sha(raw)]));
    }

    private async beginMergeState(repo: Repository, request: OperationRequest) {
        if(Object.entries(request).some(([k,v])=>v!==undefined && !['repo','version','action','revision'].includes(k)))throw new MessageError('git.merge.beginArgs');
        await this.mergeGuard(repo);this.assertClean(repo);
        const version=await this.text(repo.path,['--version']),match=/^git version ([0-9]+)\.([0-9]+)/.exec(version);
        if(!match || Number(match[1])<2 || (Number(match[1])===2 && Number(match[2])<34))throw new MessageError('git.merge.needGit234');
        const target=await this.revision(repo,request.revision || '',true);
        if(!(await this.git(repo.path,['--no-replace-objects','merge-base','--is-ancestor',target,repo.head],{allowed:[0,1]})).code)throw new MessageError('git.merge.alreadyContained');
        const bases=(await this.text(repo.path,['--no-replace-objects','merge-base','--all',repo.head,target],[0,1])).split('\n').filter(Boolean);
        if(bases.length!==1)throw new MessageError('git.merge.uniqueBase');
        const base=bases[0]!,paths=await this.mergePaths(repo,repo.head,target,base),objects=new Map<string,number>();
        const headPaths=new Set<string>(),headObjects=new Map<string,{oid:string;mode:string}>();
        for(const tip of [repo.head,target,base]){
            const raw=(await this.git(repo.path,['--no-replace-objects','ls-tree','-z',tip,'--',...paths])).stdout;
            if(raw.length && raw[raw.length-1]!==0)throw new MessageError('git.merge.sourceTreeIncomplete');
            for(const row of this.utf8(raw).split('\0').filter(Boolean)){
                const entry=/^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/.exec(row);
                if(!entry || !paths.includes(entry[3]!))throw new MessageError('git.merge.unsupportedEntries');
                objects.set(entry[2]!,0);if(tip===repo.head){headPaths.add(entry[3]!);headObjects.set(entry[3]!,{oid:entry[2]!,mode:entry[1]!});}
            }
        }
        for(const name of paths){
            if(['.gitattributes','.gitmodules','.lfsconfig'].includes(path.posix.basename(name).toLowerCase()))throw new MessageError('git.merge.configChange', { name });
            await this.recovery.filename(repo.path,name);
            const disk=await this.recovery.readDisk(repo.path,name);
            if(!headPaths.has(name) && disk.stamp.exists)throw new MessageError('git.merge.overwritesUntracked', { name });
        }
        const flags=(await this.git(repo.path,['ls-files','-v','-z'])).stdout;
        if(flags.length && (flags[flags.length-1]!==0 || this.utf8(flags).split('\0').filter(Boolean).some(row=>!row.startsWith('H '))))throw new MessageError('git.merge.specialFlags');
        const ids=[...objects.keys()],raw=(await this.git(repo.path,['--no-replace-objects','cat-file','--batch-check=%(objectname) %(objecttype) %(objectsize)'],{input:ids.join('\n')+'\n'})).stdout.toString('utf8');
        const rows=raw.split('\n');if(rows.pop()!=='' || rows.length!==ids.length)throw new MessageError('git.merge.objectMetadataIncomplete');
        let bytes=0;
        rows.forEach((row,i)=>{const entry=/^([a-f0-9]+) blob ([0-9]+)$/.exec(row),size=Number(entry?.[2]);if(!entry || entry[1]!==ids[i] || !Number.isSafeInteger(size) || size>CONTENT_LIMIT)throw new MessageError('git.merge.sourceTooLarge');bytes+=size;});
        if(bytes>30*1024*1024)throw new MessageError('git.merge.sourcesTooLarge');
        const policy=await this.mergePolicy(repo,paths),index=(await this.git(repo.path,['ls-files','--stage','-z'])).stdout,journal=await this.mergeJournal(repo);
        for(const [name,expected] of headObjects){
            const disk=await this.recovery.readDisk(repo.path,name);
            if(!disk.bytes)throw new MessageError('git.merge.cleanFileMissing', { name });
            const oid=(await this.git(repo.path,['hash-object','--stdin','--path='+name],{input:disk.bytes})).stdout.toString('utf8').trim();
            if(oid!==expected.oid || (process.platform!=='win32' && !!(disk.stamp.mode & 0o111)!==(expected.mode==='100755')))throw new MessageError('git.merge.cleanMismatch', { name });
        }
        const session: MergeSession={schema:1,phase:'prepared',nonce:randomUUID(),head:repo.head,target,base,branch:repo.branch,index:sha(index),policy,paths:sha(JSON.stringify(paths))};
        return {paths,session,journal,version:sha(JSON.stringify([repo.version,session.head,target,base,session.index,policy,session.paths,journal.draft.version,await this.conflictOperation(repo)]))};
    }

    private async abortMergeState(repo: Repository) {
        const journal=await this.mergeJournal(repo),session=journal.session;
        if (session?.native) {
            if (session.phase !== 'active' || repo.operation !== 'MERGE_HEAD' || repo.head !== session.head || repo.branch !== session.branch
                || this.utf8(await this.mergeFile(repo, 'MERGE_HEAD')).trim() !== session.target
                || this.utf8(await this.mergeFile(repo, 'ORIG_HEAD')).trim() !== session.head) throw new MergeStateChangedError(t('git.merge.startChanged'));
            const paths = [...new Set(repo.files.flatMap(file => file.oldPath ? [file.path, file.oldPath] : [file.path]))];
            return { session, journal, paths, version: sha(JSON.stringify([repo.version, journal.draft.version, await this.fingerprints(repo, paths), await this.conflictOperation(repo)])) };
        }
        await this.mergeGuard(repo);
        if(!session || session.phase!=='active')throw new MessageError('git.merge.noSession');
        if(repo.operation!=='MERGE_HEAD' || repo.head!==session.head || repo.branch!==session.branch)throw new MergeStateChangedError(t('git.merge.headMismatch'));
        const mergeHead=this.utf8(await this.mergeFile(repo,'MERGE_HEAD')).trim(),original=this.utf8(await this.mergeFile(repo,'ORIG_HEAD')).trim(),mode=this.utf8(await this.mergeFile(repo,'MERGE_MODE')).trim();
        if(mergeHead!==session.target || original!==session.head || mode!=='no-ff')throw new MergeStateChangedError(t('git.merge.targetChanged'));
        const baseline=await this.mergePaths(repo,session.head,session.target,session.base);
        if(sha(JSON.stringify(baseline))!==session.paths)throw new MergeStateChangedError(t('git.merge.baseMismatch'));
        const flags=(await this.git(repo.path,['ls-files','-v','-z'])).stdout;
        if(flags.length && (flags[flags.length-1]!==0 || this.utf8(flags).split('\0').filter(Boolean).some(row=>!row.startsWith('H ')&&!row.startsWith('M '))))throw new MessageError('git.merge.specialFlagsAfter');
        const names=new Set(baseline);
        for(const file of repo.files){
            if(file.index==='?' || file.submodule)throw new MessageError('git.merge.untrackedOrSubmodule');
            names.add(file.path);if(file.oldPath)names.add(file.oldPath);
        }
        const paths=[...names].sort();
        if(paths.length>RECOVERY_PATHS)throw new MessageError('git.merge.tooManyFiles');
        const stamps=await this.recovery.stamps(repo.path,paths),policy=await this.mergePolicy(repo,paths);
        if(await this.mergePolicy(repo,baseline)!==session.policy)throw new MergeStateChangedError(t('git.merge.attributesChanged'));
        const index=await this.mergeFile(repo,'index',READ_LIMIT),rows=(await this.git(repo.path,['ls-files','--stage','-z','--',...paths])).stdout;
        if(rows.length && rows[rows.length-1]!==0)throw new MessageError('git.merge.stagedObjectsIncomplete');
        const objects=new Map<string,number>();
        for(const row of this.utf8(rows).split('\0').filter(Boolean)){
            const entry=/^100(?:644|755) ([a-f0-9]{40}|[a-f0-9]{64}) [0-3]\t([\s\S]+)$/.exec(row);
            if(!entry || !names.has(entry[2]!))throw new MessageError('git.merge.unsupportedIndexType');objects.set(entry[1]!,0);
        }
        if(objects.size>150)throw new MessageError('git.merge.tooManyStagedObjects');
        return {session,journal,paths,version:sha(JSON.stringify([repo.version,journal.draft.version,sha(index),sha(rows),policy,stamps,await this.conflictOperation(repo)]))};
    }

    async mergeState(id: string): Promise<MergeState> {
        if(this.task()?.status==='running')throw new MessageError('agent.taskRunningMerge');
        const repo=await this.repo(id,true),key=repo.path+'\0'+repo.version;
        let pending=this.mergeReads.get(key);
        if(!pending){
            if(this.mergeReads.size>=4)throw new MessageError('git.merge.tooManyQueries');
            pending=(async()=>{
                const context=await this.mergeContext(repo),view: MergeState={...context.view,canAbort:false,abortReason:t('git.merge.noMerge')};
                if(view.active){
                    try{const abort=await this.abortMergeState(repo);view.canAbort=true;view.abortReason=t('git.merge.abortWarning');view.abortVersion=abort.version;}
                    catch(error){view.abortReason=message(error);}
                }
                return view;
            })();
            this.mergeReads.set(key,pending);
        }
        try{
            const view=await pending;
            if(this.task()?.status==='running')throw new MessageError('git.compare.taskStartedReread');
            return {...view};
        }finally{if(this.mergeReads.get(key)===pending)this.mergeReads.delete(key);}
    }

    private async selectedMerge(repo: Repository, request: OperationRequest) {
        const checked = await this.mergeContext(repo);
        if (!checked.view.canFinish) throw new Error(checked.view.reason || t('git.merge.cannotComplete'));
        if (request.mergeVersion !== checked.view.version) throw new MergeStateChangedError(t('git.merge.stateChanged'));
        if (request.paths !== undefined) throw new MessageError('git.merge.noPaths');
        if (checked.view.pointers && request.includePointers !== true) throw new MessageError('git.merge.stagedPointers');
        if (typeof request.message !== 'string' || !request.message.trim() || request.message.length > 5000 || request.message.includes('\0') || Buffer.from(request.message, 'utf8').toString('utf8') !== request.message) throw new MessageError('git.merge.messageInvalid');
        return checked;
    }

    private async amendState(repo: Repository, request: OperationRequest): Promise<{ commit: CommitDetails; state: string; staged: Buffer; pointers: boolean; paths: string[] }> {
        if (!repo.head || !repo.branch || request.revision !== repo.head || !HASH.test(request.revision)) throw new MessageError('git.amend.latestOnly');
        if (repo.operation || repo.files.some(file => file.conflict)) throw new MessageError('git.amend.finishOperation');
        const gitDir = await this.text(repo.path, ['rev-parse', '--absolute-git-dir']);
        if (await fs.lstat(path.join(gitDir, 'sequencer')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new MessageError('git.amend.sequencer');
        if (typeof request.message !== 'string' || !request.message.trim() || request.message.length > 5000 || request.message.includes('\0')) throw new MessageError('git.amend.messageInvalid');
        if (Buffer.from(request.message, 'utf8').toString('utf8') !== request.message) throw new MessageError('git.amend.messageNotUtf8');
        const encoding = await this.text(repo.path, ['config', '--get', 'i18n.commitEncoding'], [0, 1]);
        if (encoding && !/^utf-?8$/i.test(encoding)) throw new MessageError('git.amend.utf8Only');
        const object = this.utf8((await this.git(repo.path, ['--no-replace-objects', 'cat-file', 'commit', repo.head])).stdout);
        const headerEnd = object.indexOf('\n\n');
        if (headerEnd < 0 || object.slice(0, headerEnd).split('\n').some(line => line.startsWith('encoding ') && !/^encoding utf-?8$/i.test(line))) throw new MessageError('git.amend.originalNotUtf8');
        const commit = await this.commitDetails(repo.id, repo.head);
        if (commit.shallow) throw new MessageError('git.amend.shallow');
        if (commit.parents.length > 1) throw new MessageError('git.amend.plainOnly');
        const published = await this.text(repo.path, ['--no-replace-objects', 'for-each-ref', '--contains=' + repo.head, '--format=%(refname)', 'refs/remotes/']);
        if (published) throw new MessageError('git.amend.published', { published });
        const config = (await this.git(repo.path, ['config', '--null', '--list'])).stdout;
        const refs = (await this.git(repo.path, ['--no-replace-objects', 'for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', 'refs/remotes/'])).stdout;
        const staged = (await this.git(repo.path, ['--no-replace-objects', 'diff', '--cached', '--raw', '--no-abbrev', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '-z', repo.head, '--'])).stdout;
        const records = this.utf8(staged).split('\0'), paths: string[] = [];
        if (records.pop() !== '' || records.length % 2 !== 0) throw new MessageError('git.amend.cannotReadStaged');
        let pointers = false;
        for (let i = 0; i < records.length; i += 2) {
            const match = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) [AMDTUXB]$/.exec(records[i]!);
            if (!match || !records[i + 1]) throw new MessageError('git.amend.cannotParseStaged');
            if (match[1] === '160000' || match[2] === '160000') pointers = true;
            this.safePath(repo, records[i + 1]!); paths.push(records[i + 1]!);
        }
        if (pointers && request.includePointers !== true) throw new MessageError('git.amend.stagedPointers');
        if (!staged.length && commit.message === request.message) throw new MessageError('git.amend.nothingChanged');
        const operation = await this.conflictOperation(repo);
        return { commit, staged, pointers, paths, state: sha(JSON.stringify({ head: repo.head, branch: repo.branch, config: sha(config), refs: sha(refs), staged: sha(staged), operation })) };
    }

    private async recoveryPolicy(repo: Repository, paths: string[]): Promise<string> {
        const names=new Set(paths),metadata=[await this.text(repo.path,['config','--null','--list','--show-origin'])];
        for(const cached of [false,true]){
            const output=(await this.git(repo.path,['check-attr',...(cached?['--cached']:[]),'--stdin','-z','filter','working-tree-encoding','ident'],{input:paths.join('\0')+'\0'})).stdout;
            if(!output.length || output[output.length-1]!==0 || !Buffer.from(output.toString('utf8'),'utf8').equals(output))throw new MessageError('git.restore.attributesIncomplete');
            const parts=output.toString('utf8').slice(0,-1).split('\0');
            if(parts.length!==paths.length*9)throw new MessageError('git.restore.cannotReadAttributes');
            const seen=new Set<string>();
            for(let i=0;i<parts.length;i+=3){
                const name=parts[i]!,attribute=parts[i+1]!,value=parts[i+2]!,key=name+'\0'+attribute;
                if(!names.has(name)||!['filter','working-tree-encoding','ident'].includes(attribute)||seen.has(key))throw new MessageError('git.restore.attributesInvalid');
                if(!['unspecified','unset'].includes(value))throw new MessageError('git.restore.filtered', { name });
                seen.add(key);
            }
            metadata.push(parts.join('\0'));
        }
        return sha(JSON.stringify(metadata));
    }

    private async stashRecoverySource(repo: Repository, request: OperationRequest): Promise<{ target: string; version: string; listVersion: string }> {
        if (typeof request.stashRef !== 'string' || !/^stash@\{(?:0|[1-9][0-9]{0,2})\}$/.test(request.stashRef) || !['tracked','index','untracked'].includes(request.stashPart || '')) throw new MessageError('git.restore.chooseStash');
        const revision = await this.revision(repo, request.revision || '', true), stashes = await this.stashes(repo.id);
        if (!stashes.some(stash => stash.ref === request.stashRef && stash.sha === revision)) throw new StashStateChangedError(t('git.restore.stashMismatch'));
        const parents = async (oid: string) => {
            const fields = (await this.text(repo.path, ['--no-replace-objects','rev-list','--parents','-n','1',oid])).split(' ');
            if (fields[0] !== oid || fields.some(field => !HASH.test(field))) throw new MessageError('git.restore.stashAncestry');
            return fields.slice(1);
        };
        const chain = await parents(revision);
        if (chain.length !== 2 && chain.length !== 3) throw new MessageError('git.restore.stashShape');
        const indexParents = await parents(chain[1]!);
        if (indexParents.length !== 1 || indexParents[0] !== chain[0]) throw new MessageError('git.restore.stashIndexBase');
        if (chain[2] && (await parents(chain[2])).length) throw new MessageError('git.restore.stashUntrackedShape');
        if (request.stashPart === 'untracked' && !chain[2]) throw new MessageError('git.restore.noUntracked');
        const target = request.stashPart === 'tracked' ? revision : request.stashPart === 'index' ? chain[1]! : chain[2]!;
        const listVersion = sha(JSON.stringify(stashes));
        return { target, listVersion, version: sha(JSON.stringify([listVersion,request.stashRef,revision,request.stashPart,target])) };
    }

    private async recoverySelection(repo: Repository, request: OperationRequest): Promise<{ paths: string[]; target?: string; version: string; stashVersion?: string; bytes: number; policy: string; objects: { path: string; oid: string; mode: string }[] }> {
        const stash = request.action === 'restoreStashFiles', historical = request.action === 'restoreFiles' || stash;
        const allowed = ['repo','version','action', 'paths', ...(historical ? ['revision'] : []), ...(stash ? ['stashRef','stashPart'] : [])];
        if (Object.entries(request).some(([key,value]) => value !== undefined && !allowed.includes(key))) throw new MessageError('git.restore.formOnly');
        let paths: string[], target: string | undefined, stashVersion: string | undefined, sourceVersion = '';
        {
            if (!Array.isArray(request.paths) || !request.paths.length || request.paths.length > RECOVERY_PATHS || request.paths.some(n=>typeof n!=='string')) throw new MessageError('git.restore.fileCount');
            if (stash) { const source = await this.stashRecoverySource(repo,request); target=source.target; sourceVersion=source.version; stashVersion=source.listVersion; }
            else if (historical) target = await this.revision(repo,request.revision || '',true);
            const expanded = new Set(request.paths), candidates = new Set<string>();
            for (const name of request.paths) {
                await this.recovery.filename(repo.path,name);
                candidates.add(name.endsWith('.meta') ? name.slice(0,-5) : name+'.meta');
                let parent = path.posix.dirname(name);
                while (parent !== '.') {
                    candidates.add(parent+'.meta');
                    if(candidates.size>200)throw new MessageError('git.restore.tooManyCandidates');
                    parent=path.posix.dirname(parent);
                }
            }
            if(candidates.size>200)throw new MessageError('git.restore.tooManyCandidates');
            if(historical && candidates.size){
                const raw=(await this.git(repo.path,['--no-replace-objects','ls-tree','-z',target!,'--',...candidates])).stdout;
                if(raw.length && (raw[raw.length-1]!==0 || !Buffer.from(raw.toString('utf8'),'utf8').equals(raw)))throw new MessageError('git.restore.relatedIncomplete');
                for(const row of raw.toString('utf8').split('\0').filter(Boolean)){
                    const match=/^([0-9]{6}) (?:blob|tree|commit) [a-f0-9]+\t([\s\S]+)$/.exec(row);
                    if(!match || !candidates.has(match[2]!))throw new MessageError('git.restore.relatedInvalid');
                    if(match[1]!=='040000')expanded.add(match[2]!);
                }
            }else for(const file of repo.files)if(candidates.has(file.path) && UNSTAGED(file))expanded.add(file.path);
            paths = [...expanded].sort();
        }
        if (paths.length > RECOVERY_PATHS || paths.reduce((n,p)=>n+Buffer.byteLength(p,'utf8'),0)>96*1024) throw new MessageError('git.restore.relatedTooMany');
        const names=new Set(paths),metadata: string[] = [],objects: {path:string;oid:string;mode:string}[] = [];
        const zeroFields=(raw: Buffer):string[]=>{
            if(raw.length && (raw[raw.length-1]!==0 || !Buffer.from(raw.toString('utf8'),'utf8').equals(raw)))throw new MessageError('git.restore.metadataIncomplete');
            return raw.length?raw.toString('utf8').slice(0,-1).split('\0'):[];
        };
        const indexRows=zeroFields((await this.git(repo.path,['ls-files','--stage','-z','--',...paths])).stdout),indexed=new Map<string,{mode:string;oid:string}>();
        for(const row of indexRows){
            const entry=/^(100644|100755) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t([\s\S]+)$/.exec(row);
            if(!entry || !names.has(entry[3]!) || indexed.has(entry[3]!))throw new MessageError('git.restore.specialEntry');
            indexed.set(entry[3]!,{mode:entry[1]!,oid:entry[2]!});
        }
        metadata.push(...indexRows);
        const flagRows=zeroFields((await this.git(repo.path,['ls-files','-v','-z','--',...paths])).stdout),seenFlags=new Set<string>();
        for(const row of flagRows){
            const name=row.slice(2);
            if(!row.startsWith('H ') || !indexed.has(name) || seenFlags.has(name))throw new MessageError('git.restore.specialPaths');
            seenFlags.add(name);
        }
        if(seenFlags.size!==indexed.size)throw new MessageError('git.restore.flagsMismatch');
        metadata.push(...flagRows);
        const policy=await this.recoveryPolicy(repo,paths);metadata.push(policy);
        const sources=new Map(indexed);
        if(historical){
            sources.clear();
            const rows=zeroFields((await this.git(repo.path,['--no-replace-objects','ls-tree','-z',target!,'--',...paths])).stdout);
            for(const row of rows){
                const entry=/^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/.exec(row);
                if(!entry || !names.has(entry[3]!) || sources.has(entry[3]!))throw new MessageError('git.restore.sourceNotRegular');
                sources.set(entry[3]!,{mode:entry[1]!,oid:entry[2]!});
            }
            metadata.push(...rows);
        }
        for (const name of paths) {
            await this.recovery.filename(repo.path,name);
            if(['.gitattributes','.gitmodules'].includes(path.posix.basename(name).toLowerCase()))throw new MessageError('git.restore.configFiles', { name });
            const changed=repo.files.find(f=>f.path===name);
            if(changed?.conflict || changed?.submodule || changed?.oldPath || (changed && /[RCTU]/.test(changed.index+changed.worktree)))throw new MessageError('git.restore.unsupportedChange', { name });
            if(!historical && (!changed || !['M','D'].includes(changed.worktree)))throw new MessageError('git.restore.discardScope', { name });
            if(!indexed.has(name) && (await this.recovery.readDisk(repo.path,name)).stamp.exists)throw new MessageError('git.restore.notIndexed', { name });
            {const source=sources.get(name);if(!source)throw new MessageError('git.restore.sourceMissing', { name });objects.push({path:name,...source});}
        }
        if(objects.length){
            const raw=(await this.git(repo.path,['--no-replace-objects','cat-file','--batch-check=%(objectname) %(objecttype) %(objectsize)'],{input:objects.map(o=>o.oid).join('\n')+'\n'})).stdout.toString('utf8');
            const rows=raw.split('\n');if(rows.pop()!=='' || rows.length!==objects.length)throw new MessageError('git.restore.sourceSizeIncomplete');
            let total=0;
            for(let i=0;i<rows.length;i++){
                const entry=/^([a-f0-9]{40}|[a-f0-9]{64}) blob ([0-9]+)$/.exec(rows[i]!);const size=Number(entry?.[2]);
                if(!entry || entry[1]!==objects[i]!.oid || !Number.isSafeInteger(size) || size>RECOVERY_FILE_BYTES)throw new MessageError('git.restore.sourceInvalid');
                total+=size;
            }
            if(total>RECOVERY_TOTAL_BYTES)throw new MessageError('git.restore.sourceTooLarge');
        }
        const stamps=await this.recovery.stamps(repo.path,paths);
        return { paths,target,stashVersion,objects,policy,bytes:stamps.reduce((n,s)=>n+s.size,0),version:sha(JSON.stringify([paths,target,metadata,stamps,sourceVersion])) };
    }

    private async selectedCommitTree(repo: Repository, paths: string[]): Promise<string> {
        await fs.mkdir(this.cache, { recursive: true });
        const dir = await fs.mkdtemp(path.join(this.cache, 'commit-preview-')), indexFile = path.join(dir, 'index');
        try {
            await this.git(repo.path, repo.head ? ['read-tree', repo.head] : ['read-tree', '--empty'], { indexFile });
            await this.git(repo.path, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { indexFile, input: paths.join('\0') + '\0' });
            return (await this.git(repo.path, ['write-tree'], { indexFile })).stdout.toString('utf8').trim();
        } finally { await fs.rm(dir, { recursive: true, force: true }); }
    }

    private async nativeMergeState(repo: Repository, request: OperationRequest) {
        if (Object.entries(request).some(([key, value]) => value !== undefined && !['repo','version','action','revision','message','includePointers'].includes(key))) throw new MessageError('git.merge.normalArgs');
        if (!repo.head || !repo.branch || repo.operation) throw new MessageError('git.merge.cleanLocalBranch');
        if (!repo.head || !repo.branch) throw new MessageError('git.merge.localBranch');
        const target = await this.revision(repo, request.revision || '', true);
        const raw = await this.git(repo.path, ['--no-replace-objects','diff','--name-only','--no-renames','-z',repo.head,target,'--']);
        const paths = this.utf8(raw.stdout).split('\0').filter(Boolean);
        if (paths.length > 5000) throw new MessageError('git.merge.previewTooLarge');
        const pointers = (await this.git(repo.path, ['diff','--raw','--no-abbrev','--no-renames',repo.head,target,'--'])).stdout.toString('utf8');
        if (/^:(?:160000 |[0-7]+ 160000 )/m.test(pointers) && !request.includePointers) throw new MessageError('git.merge.includePointers');
        const kept = this.assertMergeable(repo, paths, request.includePointers === true);
        const index = (await this.git(repo.path, ['ls-files','--stage','-z'])).stdout;
        const policy = sha((await this.git(repo.path, ['config','--null','--list'])).stdout);
        const journal = await this.mergeJournal(repo);
        const session: MergeSession = { native: true, schema: 1, phase: 'prepared', nonce: randomUUID(), head: repo.head, target, base: repo.head, branch: repo.branch, index: sha(index), policy, paths: sha(JSON.stringify(paths)) };
        return { paths, kept, session, journal, version: sha(JSON.stringify([repo.version, target, policy, session.index, session.paths, journal.draft.version])) };
    }

    async prepare(request: OperationRequest): Promise<Plan> {
        const metrics: OperationMetrics = { elapsedMs: 0, gitCalls: 0, gitMs: 0, networkGitMs: 0 }, started = Date.now();
        return this.metricsContext.run(metrics, async () => {
            const plan = await this.prepareImpl(request);
            metrics.elapsedMs = Date.now() - started;
            return { ...plan, metrics: { ...metrics } };
        });
    }

    private async prepareImpl(request: OperationRequest): Promise<Plan> {
        this.host.assertAvailable?.();
        if (this.taskState?.status === 'running') throw new MessageError('git.taskAlreadyRunning');
        if (!ACTIONS.has(request.action)) throw new MessageError('git.unsupportedOperation');
        const repo = await this.operationRepo(request.repo, request.action);
        if (request.version !== repo.version) throw new FileStateChangedError(t('git.repoStateChanged'));
        if (repo.operation && !['fetch', 'fetchAll', 'lfsFetch', 'resolveConflict', 'finishMerge', 'abortMerge'].includes(request.action)) throw new MessageError('git.finishOperationFirst', { operation: repo.operation });
        if (repo.files.some(f => f.conflict) && !['stage', 'unstage', 'fetch', 'fetchAll', 'lfsFetch', 'resolveConflict', 'abortMerge'].includes(request.action)) throw new MessageError('git.resolveConflictsFirst');
        const paths: string[] = [], warnings: string[] = [], generalWarnings: string[] = [];
        const guidance = (text: string) => { warnings.push(text); generalWarnings.push(text); };
        let expectedTree: string | undefined;
        let directIndexAction: Plan['directIndexAction'];
        let title = '', description = '', remote: string | undefined, target: string | undefined, stashVersion: string | undefined, branchState: string | undefined, amendState: string | undefined, patch: string | undefined, tagPayload: string | undefined, mergeState: string | undefined, recoveryState: string | undefined;
        let projectUpdate: ProjectUpdatePreview | undefined;
        let descriptionSummary: string | undefined, repositories: string[] | undefined, repeatConfirmationKey: string | undefined;
        let forkTool: ForkToolPreview | undefined;
        if (request.action === 'forkResetPreferred' || request.action === 'forkSmartGit' || request.action === 'forkResetDev') {
            if (Object.entries(request).some(([key, value]) => value !== undefined && !['repo', 'version', 'action', 'branch', 'remote'].includes(key))) throw new MessageError('git.fork.argsOnly');
            await this.host.checkEditor(true);
            forkTool = await previewForkTool(this.root, this.cache, request.action, { branch: request.branch || '', remote: request.remote },
                (cwd, args, allowed) => this.git(cwd, args, { allowed, timeout: 180000 }));
            title = forkToolNames[request.action];
            descriptionSummary = t('git.fork.scopeSummary', { branch: forkTool.branch });
            repositories = forkTool.targets.map(entry => entry.id + ' → ' + entry.branch + ' · ' + entry.revision + (entry.remote ? ' · ' + entry.remote : t('git.fork.localBranch')));
            description = descriptionSummary + '\n' + repositories.join('\n');
            paths.push(...forkTool.targets.flatMap(entry => [...entry.affected, ...entry.clean].map(name => (entry.id === '.' ? '' : entry.id + '/') + name)));
            for (const entry of forkTool.skipped) warnings.push(t('git.fork.skipped', { id: entry.id, detail: entry.detail }));
            if (request.action !== 'forkSmartGit') warnings.push(t('git.fork.overwriteWarning'));
            if (request.action === 'forkResetDev') warnings.push(t('git.fork.cleanWarning'));
            guidance(t('git.fork.nativeNote'));
            guidance(t('git.fork.fixedTargetNote'));
            guidance(t('git.fork.independentNote'));
        } else if (request.action === 'updateAll') {
            if (Object.entries(request).some(([key, value]) => value !== undefined && !['repo', 'version', 'action'].includes(key))) throw new MessageError('git.update.argsOnly');
            await this.host.checkEditor(true);
            projectUpdate = await previewProjectUpdate(this.root, this.cache);
            title = t('git.updateAllTitle');
            descriptionSummary = t('git.update.summary');
            repositories = projectUpdate.entries.map(entry => entry.id + ' · ' + (entry.branch || t('git.update.detachedUnavailable')) + (entry.detail ? ' · ' + entry.detail : ''));
            for (const entry of projectUpdate.entries) {
                if (entry.detail || !entry.branch) warnings.push(t('git.update.repoState', { id: entry.id, detail: (entry.detail || t('git.update.detachedRecheck')) }));
            }
            description = t('git.update.description', { repositories: projectUpdate.entries.map(entry => entry.id + ' · ' + (entry.branch || t('git.update.detachedUnavailable')) + (entry.detail ? ' · ' + entry.detail : '')).join('\n') });
            guidance(t('git.update.networkNote'));
            guidance(t('git.update.rulesNote'));
            guidance(t('git.update.stashNote'));
            guidance(t('git.update.pointerNote'));
        } else if (request.action === 'merge') {
            await this.host.checkEditor(true);
            const state = await this.nativeMergeState(repo, request);
            paths.push(...state.paths); target = state.session.target; mergeState = state.version;
            title = t('git.merge.title');
            description = t('git.merge.preview', { name: repo.name, branch: repo.branch, head: repo.head, target });
            warnings.push(t('git.merge.nativeNote'));
            if (request.includePointers) warnings.push(t('git.merge.pointersAllowed'));
            if (state.kept.length) warnings.push(t('git.merge.keptChanges', { count: state.kept.length, paths: state.kept.slice(0, 10).join(t('git.listSeparator')), more: state.kept.length > 10 ? t('git.andOthers') : '' }));
        } else if(request.action==='beginMerge'  || request.action==='abortMerge'){
            await this.host.checkEditor(true);
            if(request.action==='beginMerge'){
                const state=await this.beginMergeState(repo,request);paths.push(...state.paths);target=state.session.target;mergeState=state.version;
                title=t('git.merge.beginTitle');
                description=t('git.merge.beginPreview', { name: repo.name, branch: repo.branch, head: repo.head, target, base: state.session.base });
                guidance(t('git.merge.beginCleanNote'));
                guidance(t('git.merge.beginRenameNote'));
                guidance(t('git.merge.beginConflictNote'));
            }else{
                if(Object.entries(request).some(([k,v])=>v!==undefined && !['repo','version','action','mergeVersion'].includes(k)))throw new MessageError('git.merge.abortArgs');
                const state=await this.abortMergeState(repo);
                if(request.mergeVersion!==state.version)throw new MergeStateChangedError(t('git.merge.abortSnapshotChanged'));
                paths.push(...state.paths);target=state.session.target;mergeState=state.version;
                title=t('git.merge.abortTitle');
                description=t('git.merge.abortPreview', { name: repo.name, branch: state.session.branch, head: state.session.head, target });
                guidance(t('git.merge.abortScopeNote'));
            }
            warnings.push(t('git.merge.abortNoBackupNote'));
            guidance(t('git.merge.abortSaveNote'));
        } else if (request.action==='discardLines') {
            await this.host.checkEditor(true);
            const state=await this.discardLineState(repo,request);paths.push(state.name);patch=state.patch;recoveryState=state.version;
            title=t('git.lines.discardTitle');
            description=t('git.lines.discardPreview', { name: repo.name, name2: state.name, idsCount: request.lines!.ids.length });
            guidance(t('git.lines.discardBaseNote'));
            guidance(t('git.lines.discardScopeNote'));
            guidance(t('git.lines.discardSaveNote'));
            guidance(t('git.lines.discardApplyNote'));
            await this.git(repo.path,[...DISCARD_LINE_APPLY,'--check','-'],{input:patch});
        } else if (['discardFiles','restoreFiles','restoreStashFiles'].includes(request.action)) {
            await this.host.checkEditor(true);
            const selected=await this.recoverySelection(repo,request); paths.push(...selected.paths);target=selected.target;recoveryState=selected.version;
            title=request.action==='discardFiles'?t('git.restore.discardTitle'):request.action==='restoreStashFiles'?t('git.restore.stashTitle'):t('git.restore.historyTitle');
            if(request.action==='restoreStashFiles'){
                stashVersion=selected.stashVersion;
                warnings.push(t('git.restore.stashWarning', { stashRef: request.stashRef, revision: request.revision, part: (request.stashPart==='tracked'?t('git.restore.partTracked'):request.stashPart==='index'?t('git.restore.partIndex'):t('git.restore.partUntracked')) }));
                guidance(t('git.restore.stashPartNote'));
            }
            description=t('git.restore.preview', { name: repo.name, source: target || t('git.restore.sourceIndex') });
            warnings.push(t('git.restore.overwriteNote'));
            guidance(t('git.restore.scopeNote'));
            guidance(t('git.restore.hooksNote'));
            guidance(t('git.restore.limitsNote'));
        } else if (['addRemote', 'setRemoteUrl', 'setRemotePushUrl', 'resetRemotePushUrl'].includes(request.action)) {
            description = repo.name + '\n' + await this.remoteStore(repo).preview(request);
            title = request.action === 'addRemote' ? t('git.remotes.addTitle') : request.action === 'resetRemotePushUrl' ? t('git.remotes.resetPushTitle') : request.action === 'setRemotePushUrl' ? t('git.remotes.setPushTitle') : t('git.remotes.setUrlTitle');
            guidance(t('git.remotes.configNote'));
            guidance(t('git.remotes.sameRepoNote'));
            guidance(t('git.remotes.lockNote'));
        } else if (request.action === 'createTag' || request.action === 'deleteTag') {
            const ref = await this.tagRef(repo, request.tag), existing = await this.tagObject(repo, ref);
            if (request.action === 'createTag') {
                if (existing) throw new MessageError('git.tags.exists');
                target = await this.tagCommit(repo, request.revision);
                if (request.tagKind !== 'lightweight' && request.tagKind !== 'annotated') throw new MessageError('git.tags.chooseKind');
                if (request.tagKind === 'annotated') {
                    if (typeof request.message !== 'string' || !request.message.trim() || request.message.length > 5000 || request.message.includes('\0')) throw new MessageError('git.tags.messageInvalid');
                    const ident = await this.text(repo.path, ['var', 'GIT_COMMITTER_IDENT']);
                    if (!/^[^\n\r\0]+ <[^\n\r\0<>]+> \d+ [+-]\d{4}$/.test(ident)) throw new MessageError('git.tags.noIdent');
                    tagPayload = `object ${target}\ntype commit\ntag ${request.tag}\ntagger ${ident}\n\n${request.message}`;
                    description = t('git.tags.annotatedPreview', { name: repo.name, tag: request.tag, ref, target, ident, message: request.message });
                } else {
                    if (request.message) throw new MessageError('git.tags.lightweightNoMessage');
                    description = t('git.tags.lightweightPreview', { name: repo.name, tag: request.tag, ref, target });
                }
                title = t('git.tags.createTitle');
                guidance(t('git.tags.createNote'));
                guidance(t('git.tags.unsignedNote'));
            } else {
                if (!existing || request.tagObject !== existing) throw new MessageError('git.tags.tagChanged');
                target = existing;
                const type = await this.text(repo.path, ['--no-replace-objects', 'cat-file', '-t', existing]);
                const commit = await this.git(repo.path, ['--no-replace-objects', 'rev-parse', '--verify', '--quiet', '--end-of-options', existing + '^{commit}'], { allowed: [0, 1] });
                title = t('git.tags.deleteTitle');
                description = t('git.tags.deletePreview', { name: repo.name, tag: request.tag, ref, existing, type, commit: commit.code ? t('git.tags.noCommit') : commit.stdout.toString('utf8').trim() });
                guidance(t('git.tags.deleteNote'));
                warnings.push(t('git.tags.lastRefNote'));
            }
            guidance(t('git.tags.atomicNote'));
            guidance(t('git.tags.hooksNote'));
        } else if (request.action === 'resolveConflict') {
            await this.host.checkEditor();
            const view = await this.selectedResolution(repo, request);
            paths.push(view.path);
            title = view.resolution === 'delete' ? t('git.conflict.markDeletedTitle') : t('git.conflict.markResolvedTitle');
            description = t('git.conflict.resolvePreview', { name: repo.name, path: view.path, status: view.status, operation: view.operation || t('git.conflict.noOperation'), result: view.resolution === 'delete' ? t('git.conflict.resultDelete') : t('git.conflict.resultStage'), version: view.version });
            guidance(t('git.conflict.reviewNote'));
            guidance(t('git.conflict.indexOnlyNote'));
            guidance(t('git.conflict.othersNote'));
            if (view.resolution === 'content') warnings.push(t('git.conflict.eolNote'));
        } else if (request.action === 'stageLines' || request.action === 'unstageLines') {
            patch = await this.selectedPatch(repo, request);
            paths.push(request.lines!.path);
            title = request.action === 'stageLines' ? t('git.lines.stageTitle') : t('git.lines.unstageTitle');
            description = t('git.lines.stagePreview', { name: repo.name, path: request.lines!.path, idsCount: request.lines!.ids.length });
            guidance(t('git.lines.indexOnlyNote'));
            guidance(t('git.lines.noRelatedNote'));
            await this.git(repo.path, ['-c', 'apply.ignoreWhitespace=no', 'apply', '--cached', '--check', '--whitespace=nowarn', '-p1', '-'], { input: patch });
        } else if (request.action === 'stage' || request.action === 'unstage' || request.action === 'commitSelected') {
            if (!request.paths?.length || request.paths.length > 5000) throw new MessageError('git.stage.fileCount');
            const selected = new Set(request.paths);
            let ordinary = !repo.operation && !repo.files.some(file => file.conflict);
            for (const name of request.paths) {
                const file = repo.files.find(f => f.path === name);
                if (!file) throw new MessageError('git.stage.fileChanged', { name });
                if (file.submodule || file.oldPath || ![' ', 'M', 'A', 'D', '?'].includes(file.index) || ![' ', 'M', 'A', 'D', '?'].includes(file.worktree)) ordinary = false;
                if (!file.submodule) {
                    const embedded = await fs.lstat(path.join(this.safePath(repo, name), '.git')).then(() => true, e => { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false; throw e; });
                    if (embedded) throw new MessageError('git.stage.unregisteredNested', { name });
                }
                if (file.submodule && !request.includePointers) throw new MessageError('git.stage.pointerNeedsAllow');
                if (request.action === 'commitSelected' ? !UNSTAGED(file) && !STAGED(file) : request.action === 'stage' ? !UNSTAGED(file) : !STAGED(file)) throw new MessageError('git.stage.notInArea', { name });
                paths.push(name);
                if (file.oldPath) paths.push(file.oldPath);
                if (!file.submodule && request.action !== 'unstage') {
                    const candidates = [name.endsWith('.meta') ? name.slice(0, -5) : name + '.meta'];
                    if (file.oldPath) candidates.push(file.oldPath + '.meta');
                    let dir = path.posix.dirname(name);
                    while (dir !== '.') { candidates.push(dir + '.meta'); dir = path.posix.dirname(dir); }
                    for (const sibling of candidates) if (repo.files.some(f => f.path === sibling && UNSTAGED(f))) paths.push(sibling);
                }
            }
            title = request.action === 'stage' ? t('git.stage.stageTitle') : t('git.stage.unstageTitle');
            if (paths.some(name => repo.files.some(file => file.path === name && file.conflict))) throw new MessageError('git.stage.conflictInScope');
            description = `${repo.name} · ${repo.branch || t('git.stage.noBranch')}`;
            if (paths.some(name => !selected.has(name))) warnings.push(t('git.stage.relatedWarning'));
            if (paths.some(name => repo.files.some(file => file.path === name && file.submodule))) warnings.push(t('git.stage.pointerWarning'));
            if (request.action === 'commitSelected') {
                if (!request.message?.trim() || request.message.length > 5000) throw new MessageError('git.commit.messageRequired');
                const outside = repo.files.filter(file => STAGED(file) && !paths.includes(file.path));
                if (outside.length) throw new MessageError('git.commit.stagedOutside', { paths: outside.map(file => file.path).join(', ') });
                if (this.requiresEditorForCommit({ ...repo, files: repo.files.filter(file => paths.includes(file.path)).map(file => ({ ...file, index: 'M' })) })) await this.host.checkEditor();
                expectedTree = await this.selectedCommitTree(repo, [...new Set(paths)]);
                title = t('git.commit.stageAndCommitTitle'); description = `${repo.name} · ${repo.branch}\n${request.message.trim()}`;
                warnings.push(t('git.commit.wholeFileNote'));
            } else if (ordinary && !warnings.length) directIndexAction = request.action;
        } else if (request.action === 'finishMerge') {
            await this.host.checkEditor(true);
            const checked = await this.selectedMerge(repo, request); mergeState = checked.view.version;
            paths.push(...checked.paths); target = checked.view.mergeHead;
            title = t('git.merge.completeTitle');
            description = t('git.merge.completePreview', { name: repo.name, branch: repo.branch, head: repo.head, target, pathsCount: paths.length, message: request.message });
            warnings.push(t('git.merge.wholeIndexNote'));
            guidance(t('git.merge.completeScopeNote'));
            if (checked.view.pointers) warnings.push(t('git.merge.pointersIncluded'));
            guidance(t('git.merge.hooksNote'));
        } else if (request.action === 'amendCommit') {
            await this.host.checkEditor();
            const checked = await this.amendState(repo, request); amendState = checked.state;
            paths.push(...checked.paths);
            title = t('git.amend.title');
            description = t('git.amend.preview', { name: repo.name, branch: repo.branch, sha: checked.commit.sha, name2: checked.commit.author.name, email: checked.commit.author.email, message: checked.commit.message, message2: request.message });
            warnings.push(t('git.amend.rewriteNote'));
            warnings.push(paths.length ? t('git.amend.stagedChanges') : t('git.amend.messageOnly'));
            if (checked.pointers) warnings.push(t('git.amend.pointersIncluded'));
            guidance(t('git.amend.publishedNote'));
            guidance(t('git.amend.hooksNote'));
        } else if (request.action === 'commit') {
            if (this.requiresEditorForCommit(repo)) await this.host.checkEditor();
            if (!request.message?.trim() || request.message.length > 5000) throw new MessageError('git.commit.messageLength');
            paths.push(...repo.files.filter(STAGED).map(f => f.path));
            if (!paths.length) throw new MessageError('git.commit.indexEmpty');
            title = t('git.commit.title'); description = `${repo.name} · ${repo.branch || t('git.detachedHead')}\n\n${request.message.trim()}`;
            warnings.push(t('git.commit.wholeIndexNote'));
        } else if (request.action === 'fetch' || request.action === 'fetchAll') {
            title = request.action === 'fetchAll' ? t('git.fetch.allTitle') : t('git.fetch.title');
            description = t('git.fetch.description');
        } else if (request.action === 'push' || request.action === 'pull') {
            ({ remote, target } = await this.pushTarget(repo, request.remote));
            if (request.action === 'pull') {
                await this.host.checkEditor(true); this.assertClean(repo);
                if (!repo.upstream) throw new MessageError('git.pull.noUpstream');
                title = t('git.pull.title');
                description = `${repo.name}\n${remote}/${target.replace('refs/heads/', '')} → ${repo.branch}`;
                guidance(t('git.pull.ffOnlyNote'));
            } else {
                title = t('git.push.title'); description = `${repo.name}\n${repo.branch} → ${remote}/${target.replace('refs/heads/', '')}`;
                warnings.push(repo.upstream ? t('git.push.aheadWarning', { ahead: repo.ahead }) : t('git.push.firstPush'));
                guidance(t('git.push.scopeNote'));
            }
        } else if (request.action === 'setUpstream' || request.action === 'unsetUpstream') {
            const checked = await this.upstreamManagement(repo, request);
            branchState = checked.state;
            title = request.action === 'setUpstream' ? t('git.upstream.setTitle') : t('git.upstream.unsetTitle');
            description = t('git.upstream.preview', { name: repo.name, name2: checked.source.name, sha: checked.source.sha, previous: checked.previous, next: checked.target ? t('git.upstream.target', { name: checked.target.name, sha: checked.target.sha, ref: checked.target.ref }) : t('git.upstream.unset') });
            guidance(t('git.upstream.configOnlyNote'));
            guidance(t('git.upstream.cacheNote'));
            guidance(t('git.upstream.laterNote'));
        } else if (request.action === 'renameBranch' || request.action === 'deleteBranch') {
            const checked = await this.branchManagement(repo, request);
            branchState = checked.state; target = checked.source.sha;
            title = request.action === 'renameBranch' ? t('git.branches.renameTitle') : t('git.branches.deleteTitle');
            description = t('git.branches.preview', { name: repo.name, name2: checked.source.name, sha: checked.source.sha });
            if (request.action === 'renameBranch') {
                description += t('git.branches.renamePreview', { newBranch: request.newBranch, upstream: checked.source.upstream || t('git.upstream.unset') });
                guidance(t('git.branches.renameNote'));
            } else {
                description += t('git.branches.deletePreview', { branch: repo.branch, head: repo.head, upstream: checked.source.upstream || t('git.upstream.unset'), upstreamSha: checked.upstreamSha ? ' · ' + checked.upstreamSha : '' });
                guidance(t('git.branches.mergedNote'));
                warnings.push(t('git.branches.deleteNote'));
            }
            guidance(t('git.branches.noSwitchNote'));
            guidance(t('git.branches.dependentsNote'));
        } else if (request.action === 'createBranchAt') {
            const checked = await this.branchAt(repo, request); target = checked.target;
            title = t('git.branches.createKeepTitle');
            description = t('git.branches.createKeepPreview', { name: repo.name, name2: checked.name, target, branch: repo.branch || t('git.detachedHead'), head: repo.head || t('git.noCommitsYet') });
            guidance(t('git.branches.createKeepNote'));
            guidance(t('git.branches.hooksNote'));
            guidance(t('git.branches.gitVersionNote'));
        } else if (request.action === 'switch' || request.action === 'createBranch' || request.action === 'checkoutRemote') {
            await this.host.checkEditor(true); this.assertClean(repo);
            await this.branchName(repo, request.branch);
            const details = await this.details(repo.id);
            if (request.action === 'switch') {
                const source = details.branches.find(branch => branch.name === request.branch);
                if (!source) throw new MessageError('git.branches.chooseExisting');
                if (source.worktree && !source.current) throw new MessageError('git.branches.otherWorktree', { worktree: source.worktree });
                target = source.sha;
            } else await this.newBranchName(repo, request.branch);
            title = request.action === 'switch' ? t('git.switch.title') : t('git.switch.createTitle');
            description = `${repo.name}\n${repo.branch || t('git.detachedHead')} → ${request.branch}`;
            if (request.action === 'createBranch') {
                target = request.revision !== undefined ? await this.revision(repo, request.revision) : repo.head || undefined;
                description += t('git.switch.startPoint', { start: target || t('git.switch.noCommits') });
                guidance(t('git.switch.createNote'));
            } else if (request.action === 'checkoutRemote') {
                const source = details.remoteBranches.find(b => b.ref === request.remoteBranch);
                if (!source || source.sha !== request.revision) throw new MessageError('git.switch.trackingChanged');
                remote = source.remote; target = source.sha;
                title = t('git.switch.fromRemoteTitle');
                description += t('git.switch.fromRemotePoint', { name: source.name, sha: source.sha.slice(0, 12) });
                guidance(t('git.switch.cacheNote'));
            }
            guidance(t('git.switch.refreshNote'));
        } else if (request.action === 'stashSelected') {
            await this.host.checkEditor(true);
            paths.push(...await this.selectedStashPaths(repo, request));
            if (request.message && (request.message.length > 5000 || request.message.includes('\0'))) throw new MessageError('git.stash.messageInvalid');
            stashVersion = sha(JSON.stringify(await this.stashes(repo.id))); target = repo.head;
            title = t('git.stash.saveSelectedTitle');
            description = t('git.stash.saveSelectedPreview', { name: repo.name, branch: repo.branch || t('git.detachedHead'), head: repo.head, selected: new Set(request.paths).size, total: paths.length, message: request.message?.trim() || t('git.stash.selectedMessage'), untracked: request.includeUntracked === true ? t('git.yes') : t('git.no') });
            guidance(t('git.stash.wholeFileNote'));
            guidance(t('git.stash.outsideNote'));
            guidance(t('git.stash.checkNote'));
            guidance(t('git.stash.failureNote'));
        } else if (request.action === 'stashPush') {
            await this.host.checkEditor(true); await this.assertStashable(repo);
            if (request.message && (request.message.length > 5000 || request.message.includes('\0'))) throw new MessageError('git.stash.messageInvalid');
            for (const file of repo.files.filter(f => f.index !== '?' || request.includeUntracked === true)) {
                const embedded = await fs.lstat(path.join(this.safePath(repo, file.path), '.git')).then(() => true, e => { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false; throw e; });
                if (embedded) throw new MessageError('git.stash.unregisteredNested', { path: file.path });
                paths.push(file.path);
                if (file.oldPath) paths.push(file.oldPath);
            }
            if (!paths.length) throw new MessageError('git.stash.nothingToSave');
            title = t('git.stash.saveTitle');
            description = t('git.stash.savePreview', { name: repo.name, branch: repo.branch || t('git.detachedHead'), message: request.message?.trim() || t('git.stash.defaultMessage'), untracked: request.includeUntracked === true ? t('git.yes') : t('git.no') });
            guidance(t('git.stash.trackedNote'));
            warnings.push(request.includeUntracked === true ? t('git.stash.untrackedNote') : t('git.stash.untrackedKeptNote'));
        } else if (request.action === 'stashApply' || request.action === 'stashDrop') {
            const stashes = await this.stashes(repo.id);
            const stash = stashes.find(s => s.ref === request.stashRef && s.sha === request.revision);
            if (!stash) throw new MessageError('git.stash.selectedChanged');
            target = stash.sha; stashVersion = sha(JSON.stringify(stashes));
            const files = await this.stashFiles(repo.id, stash.sha);
            paths.push(...files.map(f => f.path));
            description = `${repo.name}\n${stash.ref} · ${stash.sha.slice(0, 12)}\n${stash.subject}`;
            if (request.action === 'stashApply') {
                await this.host.checkEditor(true); this.assertClean(repo);
                await this.assertStashRestorePaths(repo, files);
                if (!repo.head) throw new MessageError('git.stash.noCommits');
                title = t('git.stash.applyTitle');
                description += t('git.stash.restoreIndex', { answer: request.restoreIndex === true ? t('git.yes') : t('git.no') });
                guidance(t('git.stash.applyCleanNote'));
                guidance(t('git.stash.applyConflictNote'));
            } else {
                title = t('git.stash.dropTitle');
                warnings.push(t('git.stash.dropNote'));
            }
        } else if (request.action === 'syncSubmodules') {
            await this.host.checkEditor(true);
            const selected = this.selectedSubmodules(repo, request); this.assertSubmodulesSyncable(repo, selected);
            for (const r of selected.children) {
                if (r.initialized && r.head && r.head !== r.expected) {
                    const local = await this.text(r.path, ['rev-list', '--max-count=1', r.head, '--not', '--remotes']);
                    if (local) throw new MessageError('git.submodules.noRemoteRef', { name: r.name });
                }
            }
            paths.push(...selected.named);
            title = selected.named.length ? t('git.submodules.syncSelectedTitle') : t('git.submodules.syncTitle');
            description = selected.children.map(r => `${r.id}: ${(r.head || t('git.submodules.uninitialized')).slice(0, 10)} → ${r.expected?.slice(0, 10)}`).join('\n');
            if (selected.named.length) guidance(t('git.submodules.selectedNote'));
            guidance(t('git.submodules.syncNote'));
        } else if (request.action === 'lfsFetch') {
            const remotes = (await this.details(repo.id)).remotes;
            remote = request.remote || (remotes.length === 1 ? remotes[0] : undefined);
            if (!remote || remote.startsWith('-') || !remotes.includes(remote)) throw new MessageError('git.lfs.chooseRemote');
            target = request.revision ? await this.revision(repo, request.revision) : repo.head;
            if (!target) throw new MessageError('git.lfs.noCommits');
            title = t('git.lfs.title'); description = t('git.lfs.preview', { name: repo.name, remote, target: target.slice(0, 12) });
        }
        let destination: string | undefined;
        if (remote) {
            destination = await this.text(repo.path, ['remote', 'get-url', ...(request.action === 'push' ? ['--push', '--all'] : []), remote]);
            description += t('git.remoteUrlLine', { destination: redact(destination) });
        }
        const unique = [...new Set(paths)];
        if (projectUpdate) {
            const configuration = await Promise.all(projectUpdate.entries.map(async entry => entry.detail ? ''
                : this.text(path.resolve(this.root, entry.id), ['config', '--null', '--list'])));
            repeatConfirmationKey = sha(JSON.stringify(['updateAll-v1', this.root, projectUpdate.scripts,
                projectUpdate.entries.map(entry => [entry.id, entry.branch]), configuration, generalWarnings]));
        }
        const plan: Plan = { token: randomUUID(), title, description, paths: unique, warnings, generalWarnings, descriptionSummary, repositories, repeatConfirmationKey, expiresAt: Date.now() + 120000, patch };
        if (directIndexAction) plan.directIndexAction = directIndexAction;
        const fingerprint = await this.fingerprints(repo, forkTool ? [] : unique, request.action);
        for (const [key, value] of this.plans) if (value.public.expiresAt <= Date.now()) this.plans.delete(key);
        const stored: StoredPlan = { expectedTree, forkTool, projectUpdate, public: { ...plan, paths: [...plan.paths], warnings: [...plan.warnings], generalWarnings: [...generalWarnings], repositories: repositories ? [...repositories] : undefined }, request: { ...request, paths: request.paths ? [...request.paths] : undefined, lines: request.lines ? { ...request.lines, ids: [...request.lines.ids] } : undefined, resolution: request.resolution ? { ...request.resolution } : undefined }, root: repo.path, fingerprint, scope: this.scopeVersion(repo, request.action), remote, target, destination, stashVersion, branchState, amendState, tagPayload, mergeState, recoveryState, bytes: 0 };
        stored.bytes = Buffer.byteLength(JSON.stringify(stored));
        if (stored.bytes > 2 * 1024 * 1024) throw new MessageError('git.previewTooLarge');
        let retained = [...this.plans.values()].reduce((sum, value) => sum + value.bytes, 0);
        while (this.plans.size >= 32 || retained + stored.bytes > 8 * 1024 * 1024) {
            const oldest = this.plans.keys().next().value!;
            retained -= this.plans.get(oldest)!.bytes; this.plans.delete(oldest);
        }
        this.plans.set(plan.token, stored);
        return plan;
    }

    async taskScopeState(id: string, requiredPaths?: string[]): Promise<TaskState> {
        if (this.taskState?.status === 'running') throw new MessageError('git.scope.taskRunning');
        const repo = await this.scopedRepo(id);
        if (!repo.initialized || repo.error || repo.files.length > 5000) throw new MessageError('git.scope.unreadable');
        const required = (file: ChangedFile) => !requiredPaths || requiredPaths.includes(file.path) || !!file.oldPath && requiredPaths.includes(file.oldPath) || STAGED(file);
        if (repo.files.filter(required).length > 500) throw new MessageError('git.scope.tooManyFiles');
        const index = await this.text(repo.path, ['ls-files', '--stage', '-z']);
        const entries = index.split('\0').filter(Boolean);
        const byPath = new Map<string, string[]>();
        for (const row of entries) {
            const name = row.slice(row.indexOf('\t') + 1);
            const rows = byPath.get(name) || []; rows.push(row); byPath.set(name, rows);
        }
        const fileMode = await this.text(repo.path, ['config', '--bool', 'core.fileMode'], [0, 1]);
        const files: TaskFile[] = []; let total = 0;
        for (const file of repo.files) {
            const name = taskPath(file.path), absolute = this.safePath(repo, name);
            const hash = createHash('sha256').update(JSON.stringify(file));
            const working = createHash('sha256');
            const stage = byPath.get(name)?.find(row => row.slice(0, row.indexOf('\t')).split(' ')[2] === '0')?.split('\t')[0]?.split(' ');
            const indexMode = stage?.[0], indexObject = stage?.[1];
            let workingObject: string | undefined, workingMode: string | undefined;
            for (const row of [...(byPath.get(name) || []), ...(file.oldPath ? byPath.get(file.oldPath) || [] : [])]) hash.update(row);
            let stat;
            try { stat = await fs.lstat(absolute); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
            if (!stat) { hash.update('missing'); working.update('missing'); }
            else if (stat.isSymbolicLink()) {
                const bytes = await fs.readlink(absolute, { encoding: 'buffer' }); hash.update(bytes); working.update('symlink').update(bytes);
                workingObject = createHash(repo.head.length === 64 ? 'sha256' : 'sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex'); workingMode = '120000';
            }
            else if (stat.isFile()) {
                if (!inside(repo.path, await fs.realpath(path.dirname(absolute)))) throw new MessageError('git.scope.outsideRepo');
                total += stat.size;
                if (stat.size > 16 * 1024 * 1024 || total > 128 * 1024 * 1024) {
                    if (required(file)) throw new MessageError('git.scope.snapshotTooLarge');
                    total -= stat.size;
                    hash.update(JSON.stringify([stat.size, stat.mtimeMs, stat.mode]));
                    files.push({ ...file, fingerprint: hash.digest('hex'), indexObject, indexMode });
                    continue;
                }
                let read = 0;
                const object = createHash(repo.head.length === 64 ? 'sha256' : 'sha1').update('blob ' + stat.size + '\0');
                working.update('file').update(String(stat.mode));
                for await (const chunk of createReadStream(absolute)) { read += chunk.length; if (read > stat.size) throw new MessageError('git.scope.fileChanged'); hash.update(chunk); working.update(chunk); object.update(chunk); }
                const after = await fs.lstat(absolute);
                if (read !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino || after.mode !== stat.mode) throw new MessageError('git.scope.fileChanged');
                hash.update(String(stat.mode));
                workingObject = object.digest('hex'); workingMode = fileMode === 'false' ? (indexMode || '100644') : stat.mode & 0o111 ? '100755' : '100644';
            } else if (file.submodule) { workingObject = await this.text(absolute, ['rev-parse', 'HEAD']); workingMode = '160000'; hash.update(workingObject); working.update(workingObject); }
            else throw new MessageError('git.scope.specialEntry', { name });
            files.push({ ...file, fingerprint: hash.digest('hex'), workingFingerprint: working.digest('hex'), workingObject, workingMode, indexObject, indexMode });
        }
        if ((await this.scopedRepo(id)).version !== repo.version) throw new MessageError('git.scope.stateChanged');
        return { repo: id, head: repo.head, branch: repo.branch, version: repo.version, operation: repo.operation, files };
    }
    private taskScopes(): TaskScopeStore {
        return new TaskScopeStore(this.cache, path.resolve(this.project), this.settingsCache, async (id, from, to, paths) => {
            if (!HASH.test(from) || !HASH.test(to)) return false;
            const repo = await this.scopedRepo(id);
            const ancestor = await this.git(repo.path, ['--no-replace-objects', 'merge-base', '--is-ancestor', from, to], { allowed: [0, 1, 128] });
            if (ancestor.code !== 0) return false;
            const related = new Set(paths);
            for (const name of paths) {
                related.add(name.endsWith('.meta') ? name.slice(0, -5) : name + '.meta');
                let dir = path.posix.dirname(name); while (dir !== '.') { related.add(dir + '.meta'); dir = path.posix.dirname(dir); }
            }
            return (await this.git(repo.path, ['--no-replace-objects', 'diff', '--quiet', '--no-ext-diff', '--no-textconv', from, to, '--', ...related], { allowed: [0, 1, 128] })).code === 0;
        });
    }
    async scopePolicy() { return this.taskScopes().reviewPolicy(); }
    async scopeStart(repo: string, title: string, paths: string[]) {
        paths.forEach(taskPath);
        return this.taskScopes().start(await this.taskScopeState(repo, paths), title, paths);
    }
    async scopeExtend(repo: string, id: string, paths: string[]) {
        const store = this.taskScopes();
        paths.forEach(taskPath);
        return store.extend(await this.taskScopeState(repo, [...await store.paths(id), ...paths]), id, paths);
    }
    async scopeList(repo: string) { const current = await this.scopedRepo(repo); return this.taskScopes().list(repo, current); }
    async scopeReview(repo: string, id: string, paths?: string[], includePointers = false) {
        const store = this.taskScopes();
        return store.review(await this.taskScopeState(repo, [...await store.paths(id), ...(paths || [])]), id, paths, includePointers);
    }
    async scopeApprove(repo: string, id: string, paths: string[], reviewId: string, expectedState: string) {
        const state = await this.taskScopeState(repo, [...await this.taskScopes().paths(id), ...paths]);
        if ((await this.taskScopes().review(state, id, paths)).snapshotVersion !== expectedState) throw new MessageError('git.scope.reviewChanged');
        await this.taskScopes().approve(state, id, paths, reviewId);
    }
    async agentReferencePage(id: string, kind: 'branches' | 'remoteBranches' | 'stashes', query: { offset: number; limit: number; text?: string; version?: string }) {
        const repo = await this.repo(id, true);
        const values = kind === 'branches' ? await this.localBranches(repo) : kind === 'stashes' ? await this.stashes(id) : (await this.details(id)).remoteBranches;
        const filtered = values.filter(item => !query.text || JSON.stringify(item).toLowerCase().includes(query.text.toLowerCase()));
        const version = sha(JSON.stringify([id, kind, query.text || '', values]));
        if ((query.offset > 0 && !query.version) || query.version && query.version !== version) throw new FileStateChangedError(t('git.refsChanged'));
        return { repo: id, repoVersion: repo.version, version, entries: filtered.slice(query.offset, query.offset + query.limit), total: filtered.length, offset: query.offset, nextOffset: query.offset + query.limit < filtered.length ? query.offset + query.limit : undefined, remoteCacheOnly: true };
    }
    async agentDiffPage(id: string, query: { path: string; area: 'worktree' | 'index' | 'commit' | 'stash' | 'conflict'; revision?: string; stashPart?: ChangedFile['stashPart']; view: 'summary' | 'patch' | 'before' | 'after' | 'lines'; offset: number; limit: number; version?: string }) {
        await this.repo(id, true);
        const diff = await this.diff({ repo: id, path: query.path, area: query.area, revision: query.revision, stashPart: query.stashPart });
        // Historical comparisons may contain a fresh temporary filename in their headers.
        // Stable virtual headers keep versioned fragments bound to content rather than temp paths.
        let body = false;
        const patch = diff.patch.split('\n').map(line => {
            if (line.startsWith('@@')) body = true;
            if (!body && line.startsWith('diff --git ')) return 'diff --git ' + JSON.stringify('a/' + query.path) + ' ' + JSON.stringify('b/' + query.path);
            if (!body && line.startsWith('--- ')) return '--- ' + (diff.before.exists ? JSON.stringify('a/' + query.path) : '/dev/null');
            if (!body && line.startsWith('+++ ')) return '+++ ' + (diff.after.exists ? JSON.stringify('b/' + query.path) : '/dev/null');
            return line;
        }).join('\n');
        const key = (c: FileContent) => [c.exists, c.lfs, sha(c.text ?? c.image ?? c.notice ?? '')];
        const version = sha(JSON.stringify([id, query.path, query.area, query.revision, key(diff.before), key(diff.after), sha(patch), diff.partial?.version, diff.conflict?.version]));
        if ((query.offset > 0 && !query.version) || query.version && query.version !== version) throw new FileStateChangedError(t('git.diffChanged'));
        const metadata = (c: FileContent) => ({ exists: c.exists, kind: c.image ? 'image' : c.notice ? 'notice' : 'text', characters: c.text?.length || 0, notice: c.notice, lfs: c.lfs });
        const common = { repo: id, path: query.path, area: query.area, version, before: metadata(diff.before), after: metadata(diff.after), partialVersion: diff.partial?.version, partialReason: diff.partialReason, conflict: diff.conflict ? { path: diff.conflict.path, version: diff.conflict.version, status: diff.conflict.status, operation: diff.conflict.operation, resolution: diff.conflict.resolution, blockedReason: diff.conflict.blockedReason } : undefined, summary: diff.summary, patchNotice: diff.patchNotice, offset: query.offset, unit: query.view === 'lines' ? 'lines' : 'UTF-16 characters' };
        if (query.view === 'lines') {
            const lines = diff.partial?.hunks.flatMap(hunk => hunk.lines.map(line => ({ ...line, hunk: hunk.header, text: line.text.slice(0, 1600), truncated: line.text.length > 1600 }))) || [];
            const limit = Math.min(200, query.limit);
            return { ...common, total: lines.length, lines: lines.slice(query.offset, query.offset + limit), nextOffset: query.offset + limit < lines.length ? query.offset + limit : undefined };
        }
        const text = query.view === 'patch' ? patch : query.view === 'before' ? diff.before.text || '' : query.view === 'after' ? diff.after.text || '' : '';
        return { ...common, total: text.length, text: text.slice(query.offset, query.offset + query.limit), nextOffset: query.offset + query.limit < text.length ? query.offset + query.limit : undefined };
    }

    async workspaceCommand(directory: string, args: string[]) {
        return this.git(directory, args, { timeout: 180000 });
    }
    async workspaceIdentity(directory: string) {
        const actual = await fs.realpath(directory);
        if (await this.text(actual, ['rev-parse', '--is-inside-work-tree']) !== 'true') throw new MessageError('git.nonBareOnly');
        const root = await fs.realpath(await this.text(actual, ['rev-parse', '--show-toplevel']));
        const common = await fs.realpath(path.resolve(actual, await this.text(actual, ['rev-parse', '--git-common-dir'])));
        const gitDir = await fs.realpath(await this.text(actual, ['rev-parse', '--absolute-git-dir']));
        const head = await this.text(actual, ['rev-parse', 'HEAD']);
        const branch = (await this.git(actual, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowed: [0, 1] })).stdout.toString('utf8').trim();
        return { root, common, gitDir, head, branch };
    }

    supportedActions(): Action[] { return [...ACTIONS]; }

    private async remoteProbeRepo(id: string): Promise<Repository> {
        const repo = this.repositories.find(value => value.id === id) || await this.repo(id, true);
        if (!repo.initialized || repo.error) throw new Error(repo.error || t('git.currentUnreadable'));
        if (await fs.realpath(await this.text(this.project, ['rev-parse', '--show-toplevel'])) !== this.root) throw new MessageError('git.projectChanged');
        let current = repo;
        while (true) {
            if (!inside(this.root, current.path) || await fs.realpath(current.path) !== current.path) throw new MessageError('git.externalSymlink');
            await fs.lstat(path.join(current.path, '.git'));
            if (current.path !== this.root && await fs.realpath(await this.text(current.path, ['rev-parse', '--show-toplevel'])) !== current.path) throw new MessageError('git.submoduleNotInitialized');
            const partial = await this.git(current.path, ['config', '--get', 'extensions.partialClone'], { allowed: [0, 1] });
            const promisors = await this.text(current.path, ['config', '--type=bool', '--get-regexp', '^remote\\..*\\.promisor$'], [0, 1]);
            if (partial.code === 0 || /\s+true$/m.test(promisors)) throw new MessageError('git.partialClone');
            if (current.parent === undefined) break;
            const parent = this.repositories.find(value => value.id === current.parent);
            if (!parent || !(await this.links(parent.path)).has(path.relative(parent.path, current.path).split(path.sep).join('/'))) throw new MessageError('git.submoduleOwnerChanged');
            current = parent;
        }
        return repo;
    }

    async remoteChanged(id: string): Promise<boolean> {
        if (this.taskState?.status === 'running') throw new MessageError('git.remoteProbe.taskRunning');
        const repo = await this.remoteProbeRepo(id);
        const remotes = (await this.text(repo.path, ['remote'])).split('\n').filter(Boolean);
        const advertised = new Map<string, string>();
        const urls = new Map<string, string>();
        for (const remote of remotes) {
            await this.git(repo.path, ['check-ref-format', 'refs/remotes/' + remote + '/probe']);
            urls.set(remote, await this.text(repo.path, ['remote', 'get-url', '--all', remote]));
            const heads = await this.text(repo.path, ['ls-remote', '--heads', '--', remote]);
            for (const line of heads.split('\n').filter(Boolean)) {
                const match = /^(?:([a-f0-9]{40}|[a-f0-9]{64}))\trefs\/heads\/(.+)$/.exec(line);
                if (!match?.[1] || !match[2]) throw new MessageError('git.remoteProbe.invalidResponse');
                advertised.set('refs/remotes/' + remote + '/' + match[2], match[1]);
            }
        }
        // Another Git client may have fetched during the network request; compare against fresh local refs.
        const local = new Map<string, string>();
        for (const remote of remotes) {
            if (await this.text(repo.path, ['remote', 'get-url', '--all', remote]) !== urls.get(remote)) throw new MessageError('git.remoteProbe.configChanged');
            const prefix = 'refs/remotes/' + remote + '/';
            const refs = await this.text(repo.path, ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(symref)', prefix]);
            for (const line of refs.split('\n').filter(Boolean)) {
                const [ref, object, symbolic] = line.split('\t');
                if (ref?.startsWith(prefix) && object && !symbolic) local.set(ref, object);
            }
        }
        if ((await this.text(repo.path, ['remote'])).split('\n').filter(Boolean).join('\n') !== remotes.join('\n')) throw new MessageError('git.remoteProbe.listChanged');
        return advertised.size !== local.size || [...advertised].some(([ref, object]) => local.get(ref) !== object);
    }

    private async fetchRemoteRefs(repo: Repository, selected?: string): Promise<void> {
        const remotes = (await this.text(repo.path, ['remote'])).split('\n').filter(Boolean);
        if (selected && !remotes.includes(selected)) throw new MessageError('git.remoteProbe.notFound');
        if (!remotes.length) throw new MessageError('git.remoteProbe.none');
        for (const remote of selected ? [selected] : remotes) {
            await this.git(repo.path, ['check-ref-format', 'refs/remotes/' + remote + '/probe']);
            // Explicit destination/refmap isolates this fetch from mirror/local-branch refspecs.
            await this.git(repo.path, ['fetch', '--no-tags', '--no-prune-tags', '--prune', '--no-recurse-submodules', '--refmap=', '--', remote, '+refs/heads/*:refs/remotes/' + remote + '/*'], { timeout: 180000, log: true });
        }
        this.fetchedAt[repo.id] = new Date().toISOString();
    }

    task(): Task | null { return this.taskState ? { ...this.taskState, repositories: this.taskState.repositories?.map(row => ({ ...row })) } : null; }
    // Text of one file at a revision (`HEAD:path`) or in the index (`:path`); null when it is not there.
    // An LFS pointer is resolved from the local object store without any network access.
    async fileAt(repoId: string, spec: string, limit = 16 * 1024 * 1024): Promise<string | null> {
        const repo = await this.repo(repoId);
        if (!/^[A-Za-z0-9_./~^@{}:\u4e00-\u9fff-]{1,4200}$/.test(spec) || spec.startsWith('-')) throw new MessageError('git.read.invalidRevisionPath');
        const result = await this.git(repo.path, ['--no-replace-objects', 'cat-file', 'blob', spec], { allowed: [0, 128] });
        if (result.code !== 0) return null;
        if (result.stdout.length > limit) throw new MessageError('git.read.tooLarge');
        const pointer = result.stdout.length < 1024 && /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n/.test(this.utf8(result.stdout)) ? /^oid sha256:([0-9a-f]{64})$/m.exec(this.utf8(result.stdout)) : null;
        if (!pointer) return this.utf8(result.stdout);
        const oid = pointer[1]!, common = path.resolve(repo.path, await this.text(repo.path, ['rev-parse', '--git-common-dir']));
        const object = path.join(common, 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid);
        let bytes: Buffer;
        try { bytes = await fs.readFile(object); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; throw new MessageError('git.read.lfsMissing', { spec, oid: oid.slice(0, 12) }); }
        if (bytes.length > limit) throw new MessageError('git.read.tooLarge');
        return this.utf8(bytes);
    }
    // Language keys touched by a change: usages, fallback coverage, placeholders, first commit and a CSV draft.
    async languageKeys(repoId: string, options: LanguageKeyOptions = {}): Promise<LanguageKeyAudit> {
        const repo = await this.repo(repoId);
        return auditLanguageKeys(repo.path, async (args, allowed) => this.utf8((await this.git(repo.path, args, { allowed: allowed ?? [0] })).stdout), options);
    }
    // Asset/.meta consistency of what would be committed (index) or of the files on disk (worktree).
    async metaCheck(repoId: string, options: MetaCheckOptions = {}): Promise<MetaCheckResult> {
        const repo = await this.repo(repoId, true);
        return checkMeta(repo.path, repo.files, async (args, allowed) => this.utf8((await this.git(repo.path, args, { allowed: allowed ?? [0] })).stdout), options);
    }

    execute(token: string, scopeTaskId?: string): Task {
        this.host.assertAvailable?.();
        if (this.taskState?.status === 'running') throw new MessageError('git.taskRunning');
        const plan = this.plans.get(token);
        this.plans.delete(token);
        if (!plan || plan.public.expiresAt < Date.now()) throw new MessageError('git.previewExpired');
        this.taskState = { id: randomUUID(), title: plan.public.title, status: 'running', log: '', startedAt: new Date().toISOString(), ...(['fetch', 'fetchAll'].includes(plan.request.action) ? { remoteOnly: true } : {}), ...(plan.projectUpdate ? { kind: 'updateAll' as const } : {}) };
        if (plan.projectUpdate) this.taskState.repositories = plan.projectUpdate.entries.map(entry => ({ id: entry.id, status: 'queued', phase: t('misc.update.phase.waiting'), phaseId: 'waiting', detail: entry.detail, branch: entry.branch }));
        if (plan.forkTool) this.taskState.repositories = [...plan.forkTool.targets.map(entry => ({ id: entry.id, status: 'queued' as const, phase: t('misc.fork.phaseWaiting'), phaseId: 'waitingRun' as const, detail: '', branch: entry.branch })), ...plan.forkTool.skipped.map(entry => ({ id: entry.id, status: 'skipped' as const, phase: t('misc.fork.phaseSkipped'), phaseId: 'skipped' as const, detail: entry.detail }))];
        const metrics: OperationMetrics = { elapsedMs: 0, gitCalls: 0, gitMs: 0, networkGitMs: 0 }, started = Date.now();
        void this.metricsContext.run(metrics, () => this.run(plan, scopeTaskId)).then(() => {
            if (this.taskState) this.taskState.status = 'success';
            this.log(t('git.log.done'));
        }, error => {
            if (this.taskState) {
                this.taskState.status = 'failed';
                if (error instanceof ProjectUpdateStateChangedError) this.taskState.recovery = 'repreview';
                for (const row of this.taskState.repositories || []) {
                    if (row.status === 'queued') { row.status = 'skipped'; row.phase = t('misc.update.phase.notRun'); row.phaseId = 'notRun'; row.detail = t('git.update.notStarted'); }
                    else if (row.status === 'running') { row.status = 'failed'; row.phase = t('misc.update.phase.stopped'); row.phaseId = 'stopped'; row.detail = redact(message(error)).slice(0, 1000); }
                }
            }
            this.log(t('git.log.stopped', { error: message(error) }));
        }).finally(() => {
            if (this.taskState) { this.taskState.finishedAt = new Date().toISOString(); this.taskState.metrics = { ...metrics, elapsedMs: Date.now() - started }; }
            if (this.taskState?.repositories) {
                if (!this.updateResults.save(this.taskState)) this.log(t('git.log.resultNotSaved'));
                this.lastProjectUpdate = { ...this.taskState, repositories: this.taskState.repositories.map(row => ({ ...row })) };
            }
            this.lastScan = 0;
        });
        return { ...this.taskState };
    }

    private async run(plan: StoredPlan, scopeTaskId?: string): Promise<void> {
        const request = plan.request, repo = await this.operationRepo(request.repo, request.action);
        // Project updates validate every repository's semantic state in the runner before fetch.
        // Raw index cache refreshes must not invalidate an otherwise unchanged update preview.
        if (repo.path !== plan.root || (!plan.projectUpdate && (await this.fingerprints(repo, plan.forkTool ? [] : plan.public.paths, request.action) !== plan.fingerprint || this.scopeVersion(repo, request.action) !== plan.scope))) throw new MessageError('git.repoChangedAfterPreview');
        if (plan.remote) {
            const destination = await this.text(repo.path, ['remote', 'get-url', ...(request.action === 'push' ? ['--push', '--all'] : []), plan.remote]);
            if (destination !== plan.destination) throw new MessageError('git.remoteUrlChanged');
        }
        if (plan.stashVersion && sha(JSON.stringify(await this.stashes(repo.id))) !== plan.stashVersion) throw new StashStateChangedError(t('git.stash.listChanged'));
        if (request.action === 'checkoutRemote') {
            const source = (await this.details(repo.id)).remoteBranches.find(b => b.ref === request.remoteBranch);
            if (!source || source.sha !== plan.target) throw new MessageError('git.trackingChangedAfterPreview');
        }
        this.log(`${plan.public.title}\n${plan.public.description}\n`);
        const cmd = (args: string[], input?: string) => this.git(repo.path, args, { input, timeout: 180000, log: true });
        const worktree = WORKTREE_ACTIONS.has(request.action);
        if (request.action === 'pull') {
            await cmd(['fetch', '--no-tags', '--', plan.remote!, plan.target!]);
            this.fetchedAt[repo.id] = new Date().toISOString();
            const refreshed = await this.repo(repo.id, true);
            if (refreshed.version !== repo.version) throw new MessageError('git.fetchStateChanged');
        }
        if (worktree || (request.action === 'commit' || request.action === 'commitSelected') && this.requiresEditorForCommit(request.action === 'commitSelected' ? { ...repo, files: repo.files.filter(file => plan.public.paths.includes(file.path)).map(file => ({ ...file, index: 'M' })) } : repo) || request.action === 'amendCommit' || request.action === 'finishMerge') await this.host.checkEditor(worktree || request.action === 'finishMerge');
        if (worktree) {
            if (request.action === 'stashPush' || request.action === 'stashSelected') await this.assertStashable(repo);
            else if (request.action === 'syncSubmodules') this.assertSubmodulesSyncable(repo, this.selectedSubmodules(repo, request));
            // merge re-runs its own overlap check inside nativeMergeState.
            else if (!['forkResetPreferred','forkSmartGit','forkResetDev','updateAll','discardLines','discardFiles','restoreFiles','restoreStashFiles','abortMerge','merge'].includes(request.action)) this.assertClean(repo);
            if (request.action === 'stashApply') await this.assertStashRestorePaths(repo, await this.stashFiles(repo.id, plan.target!));
            await this.host.beforeWorktreeChange();
        }
        let operationError: unknown;
        try {
            if (worktree) {
                const latest = await this.repo(repo.id, true);
                if (latest.path !== plan.root || (!plan.projectUpdate && (await this.fingerprints(latest, plan.forkTool ? [] : plan.public.paths, request.action) !== plan.fingerprint || this.scopeVersion(latest, request.action) !== plan.scope))) throw new MessageError('git.editorPreparationChanged');
                if (request.action === 'stashApply') await this.assertStashRestorePaths(latest, await this.stashFiles(latest.id, plan.target!));
            }
            switch (request.action) {
                case 'merge': {
                    const latest = await this.repo(repo.id, true), state = await this.nativeMergeState(latest, request);
                    if (state.version !== plan.mergeState) throw new MergeStateChangedError(t('git.merge.previewChanged'));
                    const prepared = await this.mergeSessions.save(repo.path, JSON.stringify(state.session), state.journal.draft.version);
                    const result = await this.git(repo.path, ['--no-replace-objects','-c','submodule.recurse=false','merge','--ff','--no-autostash','--no-overwrite-ignore','--no-edit',...(request.message ? ['-m',request.message] : []), state.session.target], { allowed: [0,1], timeout: 180000, log: true });
                    const after = await this.repo(repo.id, true);
                    if (after.branch !== state.session.branch) throw new MessageError('git.merge.branchChanged');
                    if (after.operation === 'MERGE_HEAD' && after.head === state.session.head && this.utf8(await this.mergeFile(after, 'MERGE_HEAD')).trim() === state.session.target) {
                        await this.mergeSessions.save(repo.path, JSON.stringify({ ...state.session, phase: 'active' }), prepared.version);
                        if (result.code && !after.files.some(file => file.conflict)) throw new MessageError('git.merge.commitNotCreated');
                        this.log(t('git.log.mergePending'));
                    } else {
                        if (result.code || after.operation || (await this.git(repo.path, ['merge-base','--is-ancestor',state.session.target,after.head], { allowed: [0,1] })).code) throw new MessageError('git.merge.unexpectedResult');
                        this.log(t('git.log.mergeDone', { head: state.session.head, head2: after.head }));
                    }
                    break;
                }
                case 'beginMerge': {
                    const latest=await this.repo(repo.id,true),state=await this.beginMergeState(latest,request);
                    if(state.version!==plan.mergeState || JSON.stringify(state.paths)!==JSON.stringify(plan.public.paths))throw new MergeStateChangedError(t('git.merge.beginChanged'));
                    const prepared=await this.mergeSessions.save(repo.path,JSON.stringify(state.session),state.journal.draft.version);
                    const checked=await this.repo(repo.id,true),again=await this.beginMergeState(checked,request);
                    if(checked.version!==latest.version || (await this.mergeJournal(checked)).draft.version!==prepared.version || again.session.policy!==state.session.policy || again.session.paths!==state.session.paths)throw new MergeStateChangedError(t('git.merge.recordChanged'));
                    const result=await this.git(repo.path,['--no-replace-objects','-c','submodule.recurse=false','-c','merge.renormalize=false','-c','merge.directoryRenames=false','-c','rerere.enabled=false','-c','rerere.autoupdate=false','merge','--no-ff','--no-commit','--no-autostash','--no-overwrite-ignore','--no-edit','--no-rerere-autoupdate','--no-stat','--strategy=ort','-Xno-renames',state.session.target],{allowed:[0,1],timeout:180000,log:true});
                    const after=await this.repo(repo.id,true);
                    if(after.head!==state.session.head || after.branch!==state.session.branch || after.operation!=='MERGE_HEAD' || this.utf8(await this.mergeFile(after,'MERGE_HEAD')).trim()!==state.session.target || this.utf8(await this.mergeFile(after,'ORIG_HEAD')).trim()!==state.session.head)throw new MessageError('git.merge.noPendingMerge');
                    await this.mergeSessions.save(repo.path,JSON.stringify({...state.session,phase:'active'}),prepared.version);
                    this.log(t('git.log.mergeStarted', { next: after.files.some(f=>f.conflict)?t('git.log.mergeStartedConflicts'):t('git.log.mergeStartedClean'), code: result.code }));
                    break;
                }
                case 'abortMerge': {
                    const latest=await this.repo(repo.id,true),state=await this.abortMergeState(latest);
                    if(state.version!==request.mergeVersion || state.version!==plan.mergeState || JSON.stringify(state.paths)!==JSON.stringify(plan.public.paths))throw new MergeStateChangedError(t('git.merge.abortScopeChanged'));
                    await (async()=>{
                        const current=await this.repo(repo.id,true),again=await this.abortMergeState(current);
                        if(again.version!==state.version)throw new MergeStateChangedError(t('git.merge.abortStateChanged'));
                        // The confirmed abort discards both index-only resolutions and disk edits; merge --abort alone refuses that combination.
                        const resolvedEdits=current.files.filter(file=>!file.conflict && UNSTAGED(file) && file.index!=='D').map(file=>file.path);
                        if(!state.session.native && resolvedEdits.length)await cmd(['-c','submodule.recurse=false','restore','--worktree','--',...resolvedEdits]);
                        await cmd(['--no-replace-objects','-c','submodule.recurse=false','-c','merge.autostash=false','merge','--abort']);
                        const after=await this.repo(repo.id,true),index=(await this.git(repo.path,['ls-files','--stage','-z'])).stdout;
                        if(after.head!==state.session.head || after.branch!==state.session.branch || after.operation || (!state.session.native && after.files.length) || sha(index)!==state.session.index)throw new MessageError('git.merge.abortUnexpected');
                        this.log(t('git.log.mergeAborted'));
                    })();
                    break;
                }
                case 'discardLines': {
                    const latest=await this.repo(repo.id,true),state=await this.discardLineState(latest,request);
                    if(state.version!==plan.recoveryState || state.patch!==plan.public.patch || JSON.stringify([state.name])!==JSON.stringify(plan.public.paths))throw new FileStateChangedError(t('git.lines.discardScopeChanged'));
                    await (async()=>{
                        const checked=await this.repo(repo.id,true),again=await this.discardLineState(checked,request);
                        if(checked.version!==latest.version || again.version!==state.version)throw new FileStateChangedError(t('git.lines.discardStateChanged'));
                        await this.git(repo.path,[...DISCARD_LINE_APPLY,'--check','-'],{input:state.patch});
                        if(JSON.stringify((await this.recovery.readDisk(repo.path,state.name,CONTENT_LIMIT)).stamp)!==JSON.stringify(state.stamp) || sha(await this.mergeFile(repo,'index',READ_LIMIT))!==state.indexHash)throw new FileStateChangedError(t('git.lines.discardBeforeApply'));
                        await cmd([...DISCARD_LINE_APPLY,'-'],state.patch);
                        const disk=await this.recovery.readDisk(repo.path,state.name,CONTENT_LIMIT),after=await this.repo(repo.id,true);
                        if(!disk.bytes?.equals(state.expected) || disk.stamp.mode!==state.stamp.mode || after.head!==latest.head || after.branch!==latest.branch || sha(await this.mergeFile(repo,'index',READ_LIMIT))!==state.indexHash || await this.discardLinePolicy(repo,state.name)!==state.policy)throw new MessageError('git.lines.discardUnexpected');
                        this.log(t('git.log.linesDiscarded'));
                    })();
                    break;
                }
                case 'discardFiles':
                case 'restoreFiles':
                case 'restoreStashFiles': {
                    const latest=await this.repo(repo.id,true),selected=await this.recoverySelection(latest,request);
                    if(selected.version!==plan.recoveryState || JSON.stringify(selected.paths)!==JSON.stringify(plan.public.paths))throw new MessageError('git.restore.stateChanged');
                    const beforeHead=latest.head, beforeBranch=latest.branch;
                    const indexBytes=(await this.git(repo.path,['ls-files','--stage','-z'])).stdout;
                    await (async()=>{
                        const checked=await this.repo(repo.id,true),again=await this.recoverySelection(checked,request);
                        if(again.version!==selected.version || checked.version!==latest.version)throw new MessageError('git.restore.sourceChanged');
                        await cmd(['--no-replace-objects','-c','submodule.recurse=false','restore','--worktree','--no-recurse-submodules','--overlay',...(selected.target?['--source='+selected.target]:[]),'--pathspec-from-file=-','--pathspec-file-nul'],selected.paths.join('\0')+'\0');
                        if(await this.recoveryPolicy(repo,selected.paths)!==selected.policy)throw new MessageError('git.restore.attributesChanged');
                        for(const object of selected.objects){
                            const disk=await this.recovery.readDisk(repo.path,object.path);
                            if(!disk.bytes)throw new MessageError('git.restore.fileMissing', { path: object.path });
                            const oid=(await this.git(repo.path,['hash-object','--stdin','--path='+object.path],{input:disk.bytes})).stdout.toString('utf8').trim();
                            if(oid!==object.oid || (process.platform!=='win32' && !!(disk.stamp.mode & 0o111)!==(object.mode==='100755')))throw new MessageError('git.restore.contentMismatch', { path: object.path });
                        }
                        const after=await this.repo(repo.id,true),afterIndex=(await this.git(repo.path,['ls-files','--stage','-z'])).stdout;
                        if(after.head!==beforeHead||after.branch!==beforeBranch||!afterIndex.equals(indexBytes))throw new MessageError('git.restore.headChanged');
                        if(request.action==='restoreStashFiles' && sha(JSON.stringify(await this.stashes(repo.id)))!==plan.stashVersion)throw new StashStateChangedError(t('git.restore.stashChanged'));
                    })();
                    break;
                }
                case 'addRemote':
                case 'setRemoteUrl':
                case 'setRemotePushUrl':
                case 'resetRemotePushUrl':
                    await this.remoteStore(repo).execute(request);
                    break;
                case 'resolveConflict': {
                    await this.host.checkEditor();
                    const latest = await this.repo(repo.id, true);
                    if (await this.fingerprints(latest, plan.public.paths) !== plan.fingerprint || this.scopeVersion(latest) !== plan.scope) throw new MessageError('git.conflict.editorCheckChanged');
                    const view = await this.selectedResolution(latest, request);
                    const before = await this.fingerprints(latest, [view.path]);
                    try {
                        await cmd(view.resolution === 'delete'
                            ? ['rm', '--cached', '--pathspec-from-file=-', '--pathspec-file-nul']
                            : ['-c', 'add.ignoreErrors=false', '-c', 'add.ignore-errors=false', 'add', '--pathspec-from-file=-', '--pathspec-file-nul'], view.path + '\0');
                        const after = await this.conflictIndex(latest, view.path);
                        if (view.resolution === 'delete' ? after.entries.length !== 0 : after.entries.length !== 1 || after.entries[0]!.path !== view.path || after.entries[0]!.stage !== 0) throw new MessageError('git.conflict.indexMismatch');
                        if (await this.fingerprints(latest, [view.path]) !== before) throw new MessageError('git.conflict.fileChangedWhileMarking');
                        this.log(view.resolution === 'delete' ? t('git.log.conflictDeleted') : t('git.log.conflictStaged'));
                        this.log(t('git.log.conflictNext'));
                    } catch (error) { throw new MessageError('git.conflict.partialIndex', { error: message(error) }); }
                    break;
                }
                case 'stageLines':
                case 'unstageLines': {
                    const patch = await this.selectedPatch(repo, request);
                    if (patch !== plan.public.patch) throw new MessageError('git.lines.patchChanged');
                    const args = ['-c', 'apply.ignoreWhitespace=no', 'apply', '--cached', '--whitespace=nowarn', '-p1'];
                    await this.git(repo.path, [...args, '--check', '-'], { input: patch });
                    const latest = await this.repo(repo.id, true);
                    if (await this.fingerprints(latest, plan.public.paths) !== plan.fingerprint || this.scopeVersion(latest) !== plan.scope) throw new MessageError('git.lines.repoChanged');
                    await cmd([...args, '-'], patch);
                    break;
                }
                case 'stage': await cmd(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], plan.public.paths.join('\0') + '\0'); break;
                case 'unstage':
                    if (repo.head) await cmd(['reset', '-q', 'HEAD', '--pathspec-from-file=-', '--pathspec-file-nul'], plan.public.paths.join('\0') + '\0');
                    else await cmd(['rm', '--cached', '-r', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], plan.public.paths.join('\0') + '\0');
                    break;
                case 'amendCommit': {
                    const latest = await this.repo(repo.id, true);
                    if (latest.path !== plan.root || await this.fingerprints(latest, plan.public.paths) !== plan.fingerprint || this.scopeVersion(latest) !== plan.scope) throw new MessageError('git.amend.editorCheckChanged');
                    const checked = await this.amendState(latest, request);
                    if (checked.state !== plan.amendState) throw new MessageError('git.amend.stateChanged');
                    const disk = await this.fingerprints(latest, plan.public.paths);
                    try {
                        await cmd(['--no-replace-objects', 'commit', '--amend', '--allow-empty', '--no-edit', '--cleanup=verbatim', '--file=-'], request.message!);
                        const next = await this.text(latest.path, ['--no-replace-objects', 'rev-parse', '--verify', 'HEAD']);
                        const branch = await this.text(latest.path, ['symbolic-ref', '--quiet', 'HEAD'], [0, 1]);
                        if (branch !== 'refs/heads/' + latest.branch || !HASH.test(next)) throw new MessageError('git.amend.headMismatch');
                        const actual = await this.commitDetails(latest.id, next);
                        if (JSON.stringify(actual.parents) !== JSON.stringify(checked.commit.parents) || JSON.stringify(actual.author) !== JSON.stringify(checked.commit.author) || actual.message !== request.message) throw new MessageError('git.amend.metadataMismatch');
                        const delta = (await this.git(latest.path, ['--no-replace-objects', 'diff-tree', '--no-commit-id', '-r', '--raw', '--no-abbrev', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '-z', latest.head, next, '--'])).stdout;
                        if (!delta.equals(checked.staged)) throw new MessageError('git.amend.treeMismatch');
                        const index = await this.git(latest.path, ['--no-replace-objects', 'diff', '--cached', '--quiet', '--ignore-submodules=none', next, '--'], { allowed: [0, 1] });
                        if (index.code !== 0 || await this.fingerprints(latest, plan.public.paths) !== disk) throw new MessageError('git.amend.changedAgain');
                        this.log(t('git.log.amended', { head: latest.head, next }));
                    } catch (error) { throw new MessageError('git.amend.mayHaveCommitted', { error: message(error) }); }
                    break;
                }
                case 'finishMerge': {
                    const latest = await this.repo(repo.id, true);
                    const checked = await this.selectedMerge(latest, request);
                    if (latest.path !== plan.root || checked.view.version !== plan.mergeState || await this.fingerprints(latest, plan.public.paths) !== plan.fingerprint || this.scopeVersion(latest) !== plan.scope) throw new MergeStateChangedError(t('git.merge.editorCheckChanged'));
                    const disk = await this.fingerprints(latest, plan.public.paths);
                    try {
                        await cmd(['--no-replace-objects', 'commit', '--no-edit', '--cleanup=verbatim', '--file=-'], request.message!);
                        const next = await this.text(latest.path, ['--no-replace-objects', 'rev-parse', '--verify', 'HEAD']);
                        this.log(t('git.log.mergeCommitHead', { next }));
                        const actual = await this.commitDetails(latest.id, next);
                        if (JSON.stringify(actual.parents) !== JSON.stringify([latest.head, plan.target]) || actual.message !== request.message || await this.text(latest.path, ['symbolic-ref', '--quiet', 'HEAD'], [0, 1]) !== 'refs/heads/' + latest.branch) throw new MessageError('git.merge.commitMetadataMismatch');
                        const delta = (await this.git(latest.path, ['--no-replace-objects', 'diff-tree', '--no-commit-id', '-r', '--raw', '--no-abbrev', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '-z', latest.head, next, '--'])).stdout;
                        const index = await this.git(latest.path, ['--no-replace-objects', 'diff', '--cached', '--quiet', '--ignore-submodules=none', next, '--'], { allowed: [0, 1] });
                        const current = await this.repo(latest.id, true);
                        if (!delta.equals(checked.staged) || index.code !== 0 || current.operation || await this.fingerprints(latest, plan.public.paths) !== disk) throw new MessageError('git.merge.commitTreeMismatch');
                        this.log(t('git.log.mergeCompleted', { head: latest.head, target: plan.target, next }));
                    } catch (error) { throw new MessageError('git.merge.mayHaveCommitted', { error: message(error) }); }
                    break;
                }
                case 'commitSelected': {
                    if (!plan.expectedTree) throw new MessageError('git.commit.treeMissing');
                    const current = await this.repo(repo.id, true);
                    if (await this.fingerprints(current, plan.public.paths, request.action) !== plan.fingerprint || this.scopeVersion(current, request.action) !== plan.scope) throw new MessageError('git.commit.contentChanged');
                    if (await this.selectedCommitTree(current, plan.public.paths) !== plan.expectedTree) throw new MessageError('git.commit.previewChanged');
                    await cmd(['add','-A','--pathspec-from-file=-','--pathspec-file-nul'], plan.public.paths.join('\0') + '\0');
                    if (await this.text(repo.path, ['write-tree']) !== plan.expectedTree) throw new MessageError('git.commit.stageMismatch');
                    await cmd(['commit','--file=-'], request.message!.trim() + '\n');
                    const after = await this.repo(repo.id, true), parents = await this.originalParents(repo, after.head);
                    if (after.branch !== repo.branch || after.head === repo.head || parents.length !== (repo.head ? 1 : 0) || repo.head && parents[0] !== repo.head || await this.text(repo.path, ['rev-parse', after.head + '^{tree}']) !== plan.expectedTree) throw new MessageError('git.commit.resultMismatch');
                    if (scopeTaskId) await this.taskScopes().recordCommit(scopeTaskId, repo.id, repo.head, after.head, after.branch, plan.public.paths);
                    break;
                }
                case 'commit': {
                    const latest = await this.operationRepo(repo.id, request.action);
                    if (await this.fingerprints(latest, plan.public.paths, request.action) !== plan.fingerprint || this.scopeVersion(latest, request.action) !== plan.scope) throw new MessageError('git.commit.editorCheckChanged');
                    const indexTree = await this.text(repo.path, ['write-tree']);
                    await cmd(['commit', '--file=-'], request.message!.trim() + '\n');
                    const current = await this.operationRepo(repo.id, request.action);
                    const parents = await this.originalParents(repo, current.head);
                    const tree = await this.text(repo.path, ['--no-replace-objects', 'rev-parse', current.head + '^{tree}']);
                    if (current.head === repo.head || current.branch !== repo.branch || parents.length !== (repo.head ? 1 : 0) || repo.head && parents[0] !== repo.head || tree !== indexTree) throw new MessageError('git.commit.indexResultMismatch');
                    if (scopeTaskId) await this.taskScopes().recordCommit(scopeTaskId, repo.id, repo.head, current.head, current.branch, plan.public.paths);
                    break;
                }
                case 'fetch': await this.fetchRemoteRefs(repo, request.remote); break;
                case 'forkResetPreferred': case 'forkSmartGit': case 'forkResetDev': {
                    if (!plan.forkTool) throw new MessageError('git.fork.snapshotMissing');
                    await executeForkTool(plan.forkTool, this.cache, value => this.log(value),
                        (cwd, args, allowed) => this.git(cwd, args, { allowed, timeout: 180000, log: true }), row => {
                            const index = this.taskState?.repositories?.findIndex(value => value.id === row.id) ?? -1;
                            if (index >= 0 && this.taskState?.repositories) this.taskState.repositories[index] = { ...row, detail: redact(row.detail) };
                            this.log('[' + row.phase + '] ' + row.id + ': ' + row.detail + '\n');
                        });
                    break;
                }
                case 'updateAll': {
                    if (!plan.projectUpdate) throw new MessageError('git.update.snapshotMissing');
                    await executeProjectUpdate(plan.projectUpdate, this.cache, row => {
                        const index = this.taskState?.repositories?.findIndex(value => value.id === row.id) ?? -1;
                        if (index >= 0 && this.taskState?.repositories) this.taskState.repositories[index] = { ...row, detail: redact(row.detail) };
                        this.log('[' + row.phase + '] ' + row.id + ': ' + row.detail + '\n');
                    }, value => this.log(value));
                    break;
                }
                case 'fetchAll': {
                    const errors: string[] = [];
                    for (const r of this.repositories.filter(r => r.initialized && !r.error)) {
                        this.log(t('git.log.fetchingRemote', { id: r.id }));
                        try { await this.fetchRemoteRefs(r); }
                        catch (error) { errors.push(`${r.id}: ${message(error)}`); this.log(errors[errors.length - 1]! + '\n'); }
                    }
                    if (errors.length) throw new Error(errors.join('\n'));
                    break;
                }
                case 'createTag': {
                    const ref = await this.tagRef(repo, request.tag);
                    if (await this.tagObject(repo, ref)) throw new MessageError('git.tags.existsAfterPreview');
                    await this.tagCommit(repo, plan.target);
                    let object = plan.target!;
                    if (plan.tagPayload) {
                        object = (await this.git(repo.path, ['--no-replace-objects', 'mktag'], { input: plan.tagPayload })).stdout.toString('utf8').trim();
                        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(object)) throw new MessageError('git.tags.invalidCreatedObject');
                    }
                    try {
                        await cmd(['update-ref', '--no-deref', '-m', 'Git Desk: create local tag', ref, object, '0'.repeat(object.length)]);
                        if (await this.tagObject(repo, ref) !== object) throw new MessageError('git.tags.createReadBack');
                    } catch (error) { throw new MessageError('git.tags.mayHaveCreated', { error: message(error) }); }
                    this.log(t('git.log.tagCreated', { ref, object }));
                    break;
                }
                case 'deleteTag': {
                    const ref = await this.tagRef(repo, request.tag);
                    if (await this.tagObject(repo, ref) !== plan.target) throw new MessageError('git.tags.changedAfterPreview');
                    try {
                        await cmd(['update-ref', '--no-deref', '-d', ref, plan.target!]);
                        if (await this.tagObject(repo, ref)) throw new MessageError('git.tags.stillExists');
                    } catch (error) { throw new MessageError('git.tags.deleteUncertain', { error: message(error) }); }
                    this.log(t('git.log.tagDeleted', { ref, target: plan.target }));
                    break;
                }
                case 'push': await cmd(['push', '--porcelain', '--no-follow-tags', '--recurse-submodules=check', ...(repo.upstream ? [] : ['--set-upstream']), '--', plan.remote!, `HEAD:${plan.target}`]); break;
                case 'pull':
                    await cmd(['-c', 'submodule.recurse=false', 'merge', '--ff-only', '--no-edit', '--no-autostash', 'FETCH_HEAD']);
                    break;
                case 'switch': {
                    const source = (await this.localBranches(repo)).find(branch => branch.name === request.branch);
                    if (!source || source.sha !== plan.target) throw new MessageError('git.branches.targetChanged');
                    await cmd(['-c', 'submodule.recurse=false', 'switch', '--no-guess', '--no-overwrite-ignore', request.branch!]);
                    break;
                }
                case 'createBranchAt': {
                    const checked = await this.branchAt(repo, request);
                    if (checked.target !== plan.target) throw new MessageError('git.branches.newTargetMismatch');
                    const ref = 'refs/heads/' + checked.name;
                    try {
                        await cmd(['update-ref', '--no-deref', '--create-reflog', '-m', 'Git Desk: create branch at pinned commit', ref, checked.target, '0'.repeat(checked.target.length)]);
                        const symbolic = await this.git(repo.path, ['symbolic-ref', '--quiet', ref], { allowed: [0, 1] });
                        const actual = await this.text(repo.path, ['--no-replace-objects', 'rev-parse', '--verify', '--end-of-options', ref]);
                        if (symbolic.code === 0 || actual !== checked.target) throw new MessageError('git.branches.createReadBack');
                        this.log(t('git.log.branchCreated', { ref, actual }));
                        const latest = await this.repo(repo.id, true);
                        if (latest.head !== repo.head || latest.branch !== repo.branch || latest.version !== repo.version || this.scopeVersion(latest) !== plan.scope) throw new MessageError('git.branches.stateChangedDuring');
                    } catch (error) { throw new MessageError('git.branches.mayHaveCreated', { error: message(error) }); }
                    break;
                }
                case 'createBranch':
                    await this.newBranchName(repo, request.branch);
                    if (plan.target) await this.revision(repo, plan.target);
                    await cmd(['-c', 'submodule.recurse=false', 'switch', '--no-track', '--no-overwrite-ignore', '-c', request.branch!, ...(plan.target ? [plan.target + '^{commit}'] : [])]);
                    if (plan.target && await this.text(repo.path, ['rev-parse', '--verify', 'HEAD']) !== plan.target) throw new MessageError('git.branches.startMismatch');
                    break;
                case 'renameBranch':
                case 'deleteBranch': {
                    const checked = await this.branchManagement(repo, request);
                    if (checked.state !== plan.branchState) throw new MessageError('git.branches.changedAfterPreview');
                    await cmd(request.action === 'renameBranch' ? ['branch', '-m', '--', request.branch!, request.newBranch!] : ['branch', '-d', '--', request.branch!]);
                    break;
                }
                case 'setUpstream':
                case 'unsetUpstream': {
                    const checked = await this.upstreamManagement(repo, request);
                    if (checked.state !== plan.branchState) throw new MessageError('git.upstream.changedAfterPreview');
                    try {
                        await cmd(request.action === 'setUpstream'
                            ? ['-c', 'branch.autoSetupRebase=never', 'branch', `--set-upstream-to=${checked.target!.ref}`, '--', checked.source.name]
                            : ['branch', '--unset-upstream', '--', checked.source.name]);
                        // Git writes the two keys separately; even a successful exit is followed by a read-back.
                        const config = await this.upstreamConfiguration(repo, checked.source.name);
                        if (checked.target ? config.remote !== checked.target.remote || config.merge !== 'refs/heads/' + checked.target.branch : config.remote !== undefined || config.merge !== undefined) throw new MessageError('git.upstream.readBack');
                        const latest = await this.repo(repo.id, true), branches = await this.localBranches(latest);
                        const branch = branches.find(value => value.name === checked.source.name);
                        if (latest.head !== repo.head || latest.branch !== repo.branch || branch?.sha !== checked.source.sha) throw new MessageError('git.upstream.headChanged');
                        if (checked.target && branch.upstreamRef !== checked.target.ref) throw new MessageError('git.upstream.refMismatch');
                        if (!checked.target && branch.tracking?.state !== 'none') throw new MessageError('git.upstream.stillConfigured');
                    } catch (error) { throw new MessageError('git.upstream.mayHaveChanged', { error: message(error) }); }
                    break;
                }
                case 'checkoutRemote': {
                    await this.newBranchName(repo, request.branch);
                    const currentTarget = await this.text(repo.path, ['rev-parse', '--verify', request.remoteBranch!]);
                    if (currentTarget !== plan.target) throw new MessageError('git.trackingChangedPreviewAgain');
                    await cmd(['-c', 'submodule.recurse=false', 'switch', '--no-guess', '--no-overwrite-ignore', '--track', '-c', request.branch!, request.remoteBranch!]);
                    break;
                }
                case 'stashSelected': {
                    const latest = await this.repo(repo.id, true), paths = await this.selectedStashPaths(latest, request);
                    if (JSON.stringify(paths) !== JSON.stringify(plan.public.paths) || await this.fingerprints(latest, paths) !== plan.fingerprint || this.scopeVersion(latest) !== plan.scope) throw new MessageError('git.stash.scopeChangedBeforeRun');
                    const indexed = new Set((await this.git(repo.path, ['ls-files', '-z'])).stdout.toString('utf8').split('\0').filter(Boolean));
                    const removed: string[] = [];
                    for (const name of paths) {
                        if (!indexed.has(name) && !await fs.lstat(this.safePath(repo, name)).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) removed.push(name);
                    }
                    const pathspecs = paths.filter(name => !removed.includes(name));
                    const before = await this.stashes(repo.id);
                    if (sha(JSON.stringify(before)) !== plan.stashVersion) throw new MessageError('git.stash.listChangedBeforeRun');
                    try {
                        // Stash always saves the full index (all staged paths were checked above), but rejects deleted index paths as pathspecs.
                        // Explicit literal magic protects user filenames without leaking literal mode into Git's internal cleanup commands.
                        await cmd(['--no-literal-pathspecs', '-c', 'submodule.recurse=false', 'stash', 'push', '--no-keep-index',
                            ...(pathspecs.length ? (request.includeUntracked === true ? ['--include-untracked'] : []) : ['--staged']),
                            '--message', request.message?.trim() || t('git.stash.selectedMessage'),
                            ...(pathspecs.length ? ['--pathspec-from-file=-', '--pathspec-file-nul'] : [])],
                            pathspecs.length ? pathspecs.map(name => ':(top,literal)' + name).join('\0') + '\0' : undefined);
                        const after = await this.stashes(repo.id), saved = after[0];
                        if (!saved || saved.sha === before[0]?.sha || after.length !== Math.min(before.length + 1, 200) || after.slice(1).some((item, i) => item.sha !== before[i]?.sha)) throw new MessageError('git.stash.chainMismatch');
                        this.log(t('git.log.stashRead', { ref: saved.ref, sha: saved.sha }));
                        if ((await this.originalParents(repo, saved.sha))[0] !== plan.target) throw new MessageError('git.stash.baseMismatch');
                        const allowed = new Set(paths), savedFiles = await this.stashFiles(repo.id, saved.sha);
                        if (!savedFiles.length || savedFiles.some(file => !allowed.has(file.path) || (file.oldPath && !allowed.has(file.oldPath)))) throw new MessageError('git.stash.filesMismatch');
                        if (removed.length && pathspecs.length) {
                            const current = await this.repo(repo.id, true);
                            if (current.head !== plan.target || current.branch !== latest.branch || current.operation) throw new MessageError('git.stash.stateChangedAfterSave');
                            const remainingIndex = new Set((await this.git(repo.path, ['ls-files', '-z'])).stdout.toString('utf8').split('\0').filter(Boolean));
                            for (const name of removed) {
                                await this.recovery.filename(repo.path, name, true);
                                if (remainingIndex.has(name) || await fs.lstat(this.safePath(repo, name)).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) throw new MessageError('git.stash.pathRewritten', { name });
                                if (!savedFiles.some(file => file.path === name || file.oldPath === name)) throw new MessageError('git.stash.pathMissing', { name });
                            }
                            await cmd(['-c', 'submodule.recurse=false', 'restore', '--source='+plan.target, '--staged', '--worktree', '--', ...removed]);
                        }
                        const current = await this.repo(repo.id, true);
                        if (current.head !== plan.target || current.files.some(file => allowed.has(file.path) || (file.oldPath && allowed.has(file.oldPath)))) throw new MessageError('git.stash.stateMismatchAfterSave');
                        this.log(t('git.log.stashSaved', { ref: saved.ref }));
                    } catch (error) { throw new MessageError('git.stash.mayHaveSaved', { error: message(error) }); }
                    break;
                }
                case 'stashPush': {
                    // Whole-repository stash has no user pathspecs; literal mode breaks Git's untracked cleanup for newline names.
                    await cmd(['--no-literal-pathspecs', '-c', 'submodule.recurse=false', 'stash', 'push', '--no-keep-index', ...(request.includeUntracked === true ? ['--include-untracked'] : []), '--message', request.message?.trim() || t('git.stash.defaultMessage')]);
                    const remaining = await this.repo(repo.id, true);
                    if (remaining.files.some(file => file.index !== '?' || request.includeUntracked === true)) throw new MessageError('git.stash.changesRemain');
                    break;
                }
                case 'stashApply':
                    try { await cmd(['-c', 'submodule.recurse=false', '-c', 'stash.index=false', 'stash', 'apply', ...(request.restoreIndex === true ? ['--index'] : []), plan.target!]); }
                    catch (error) { throw new MessageError('git.stash.applyFailed', { error: message(error) }); }
                    break;
                case 'stashDrop': {
                    if (sha(JSON.stringify(await this.stashes(repo.id))) !== plan.stashVersion) throw new MessageError('git.stash.listChangedDrop');
                    await cmd(['stash', 'drop', request.stashRef!]);
                    break;
                }
                case 'syncSubmodules': await cmd(['submodule', 'update', '--init', '--recursive', '--checkout', ...(request.paths?.length ? ['--', ...request.paths] : [])]); break;
                case 'lfsFetch': {
                    const parent = await this.text(repo.path, ['rev-parse', '--verify', plan.target! + '^'], [0, 128]);
                    await cmd(['lfs', 'fetch', plan.remote!, plan.target!, ...(parent ? [parent] : [])]);
                    break;
                }
            }
        } catch (error) { operationError = error; }
        if (worktree) {
            try { await this.host.afterWorktreeChange(); }
            catch (error) { this.log(t('git.log.assetRefreshFailed', { error: message(error) })); if (!operationError) operationError = new MessageError('git.assetRefreshFailed'); }
        }
        if (operationError) throw operationError;
    }

    async fileTarget(id: string, name: string): Promise<string> {
        return this.safePath(await this.repo(id), name);
    }

    async reveal(id: string, name: string): Promise<string> {
        const repo = await this.repo(id);
        if (!repo.files.some(f => f.path === name)) throw new MessageError('git.revealChangedOnly');
        return this.safePath(repo, name);
    }
}
