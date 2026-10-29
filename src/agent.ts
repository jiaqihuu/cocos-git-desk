import { FileStateChangedError } from './types';
import { ReflogQuery, ReflogPage, ReflogStateChangedError } from './types';
import { FileCompareQuery, FileComparePage, FileRevision, FileComparisonStateChangedError } from './types';
import { WorktreeCompareQuery, WorktreeComparePage } from './types';
import { IndexCompareQuery, IndexComparePage } from './types';
import { StashStateChangedError } from './types';
import { RemoteQuery, RemotePage, RemoteStateChangedError } from './types';
import { createHash } from 'crypto';
import { headState } from './branch-actions';
import { Action, OperationRequest, Plan, Repository, Snapshot, Task, TagPage, TagQuery, TagStateChangedError } from './types';
import { EditorFileAction, EditorFileResult } from './editor-files';
import { TreePage, TreeQuery, TreeStateChangedError, MergeState, MergeStateChangedError } from './types';
import { ScopeReview } from './task-scope';
import { MetaCheckOptions, MetaCheckResult } from './meta-check';
import { HistoryQuery, HistoryPage, DiffRequest, CommitDetails, ChangedFile, SyncQuery, SyncPage } from './types';
import { t } from './i18n';

export type AgentQuery = { kind: 'agent'; protocol: 1 } & (
    { op: 'capabilities' } |
    { op: 'repositories'; force?: boolean; version?: string; offset?: number; limit?: number } |
    { op: 'status'; force?: boolean } |
    { op: 'files'; force?: boolean; version?: string; offset?: number; limit?: number; text?: string } |
    { op: 'tags'; version?: string; offset?: number; limit?: number; text?: string } |
    { op: 'tree'; revision: string; directory?: string; version?: string; offset?: number; limit?: number; text?: string } |
    { op: 'remotes'; version?: string; offset?: number; limit?: number; text?: string } |
    ({ op: 'fileCompare' } & FileCompareQuery) |
    ({ op: 'worktreeCompare' } & WorktreeCompareQuery) |
    ({ op: 'indexCompare' } & IndexCompareQuery) |
    { op: 'reflog'; ref?: string; text?: string; offset?: number; limit?: number; version?: string } |
    { op: 'merge' } |
    { op: 'branches' | 'remoteBranches' | 'stashes'; offset?: number; limit?: number; text?: string; version?: string } |
    ({ op: 'history' } & Partial<HistoryQuery>) |
    { op: 'commitDetails' | 'commitFiles'; revision: string; offset?: number; limit?: number } |
    { op: 'sync'; direction?: 'incoming' | 'outgoing'; snapshot?: string; start?: number } |
    { op: 'diff'; path: string; area?: 'worktree' | 'index' | 'commit' | 'stash' | 'conflict'; revision?: string; stashPart?: ChangedFile['stashPart']; view?: 'summary' | 'patch' | 'before' | 'after' | 'lines'; offset?: number; limit?: number; version?: string } |
    { op: 'scopeStart'; title: string; paths: string[] } |
    { op: 'scopeList' } |
    { op: 'scopeExtend'; id: string; paths: string[] } |
    { op: 'scopeChanges' | 'commitCheck'; id: string; includePointers?: boolean } |
    { op: 'prepare'; operation: Omit<OperationRequest, 'repo'>; taskId?: string } |
    { op: 'execute'; token: string; digest: string } |
    { op: 'task'; taskId?: string; logLimit?: number } |
    { op: 'navigate'; path: string; action: EditorFileAction }
);
export type AgentReply = { ok: true; data: { protocol: 1; op: string; result: unknown; context?: { id: string; root: string; isolated: boolean } } } |
    { ok: false; protocol: 1; op: string; code: string; error: string; refreshRequired: boolean; mayHaveSideEffects: boolean };
interface AgentService {
    snapshot(force?: boolean): Promise<Snapshot>;
    supportedActions(): Action[];
    tags(repo: string, query: TagQuery): Promise<TagPage>;
    tree(repo: string, query: TreeQuery): Promise<TreePage>;
    compareFilePage(repo: string, query: FileCompareQuery): Promise<FileComparePage>;
    compareWorktreePage(repo: string, query: WorktreeCompareQuery): Promise<WorktreeComparePage>;
    compareIndexPage(repo: string, query: IndexCompareQuery): Promise<IndexComparePage>;
    reflog(repo: string, query: ReflogQuery): Promise<ReflogPage>;
    remotePage(repo: string, query: RemoteQuery): Promise<RemotePage>;
    mergeState(repo: string): Promise<MergeState>;
    prepare(operation: OperationRequest): Promise<Plan>;
    prepareValidated?(operation: OperationRequest): Promise<Plan>;
    execute(token: string, scopeTaskId?: string): Task;
    task(): Task | null;
    metaCheck?(repo: string, options: MetaCheckOptions): Promise<MetaCheckResult>;
    scopeStart?(repo: string, title: string, paths: string[]): Promise<unknown>;
    scopeList?(repo: string): Promise<unknown>;
    scopeExtend?(repo: string, id: string, paths: string[]): Promise<unknown>;
    scopePolicy?(): Promise<{ required: boolean; source: ScopeReview['reviewPolicySource'] }>;
    scopeReview?(repo: string, id: string, paths?: string[], includePointers?: boolean): Promise<ScopeReview>;
    historyPage?(repo: string, query: HistoryQuery): Promise<HistoryPage>;
    commitDetails?(repo: string, revision: string): Promise<CommitDetails>;
    commitFiles?(repo: string, revision: string): Promise<ChangedFile[]>;
    syncPage?(repo: string, query: SyncQuery): Promise<SyncPage>;
    agentReferencePage?(repo: string, kind: 'branches' | 'remoteBranches' | 'stashes', query: { offset: number; limit: number; text?: string; version?: string }): Promise<unknown>;
    agentDiffPage?(repo: string, query: { path: string; area: 'worktree' | 'index' | 'commit' | 'stash' | 'conflict'; revision?: string; stashPart?: ChangedFile['stashPart']; view: 'summary' | 'patch' | 'before' | 'after' | 'lines'; offset: number; limit: number; version?: string }): Promise<unknown>;
}
type Navigate = (repo: string, name: string, action: EditorFileAction) => Promise<EditorFileResult>;
const RESPONSE_LIMIT = 256 * 1024;
const INPUT_LIMIT = 128 * 1024;
const PLAN_LIMIT = 32;
const queryKeys: Record<string, string[]> = {
    branches: ['offset', 'limit', 'text', 'version'], remoteBranches: ['offset', 'limit', 'text', 'version'], stashes: ['offset', 'limit', 'text', 'version'],
    history: ['scope', 'cursor', 'search', 'path'], commitDetails: ['revision'], commitFiles: ['revision', 'offset', 'limit'], sync: ['direction', 'snapshot', 'start'],
    diff: ['path', 'area', 'revision', 'stashPart', 'view', 'offset', 'limit', 'version'],
    capabilities: [], repositories: ['force', 'version', 'offset', 'limit'], status: ['force'],
    files: ['force', 'version', 'offset', 'limit', 'text'], tags: ['version', 'offset', 'limit', 'text'], prepare: ['operation', 'taskId', 'verbose'],
    scopeStart: ['title', 'paths'], scopeList: [], scopeExtend: ['id', 'paths'], scopeChanges: ['id', 'verbose'], commitCheck: ['id', 'includePointers', 'verbose'],
    tree: ['revision', 'directory', 'version', 'offset', 'limit', 'text'],
    fileCompare: ['left', 'right', 'view', 'offset', 'limit', 'version', 'force'],
    worktreeCompare: ['left', 'path', 'view', 'offset', 'limit', 'version'],
    indexCompare: ['left', 'path', 'view', 'offset', 'limit', 'version'],
    remotes: ['version', 'offset', 'limit', 'text'], reflog: ['ref', 'text', 'offset', 'limit', 'version'], merge: [],
    execute: ['token', 'digest', 'wait', 'waitMs'], task: ['taskId', 'logLimit', 'waitMs'], navigate: ['path', 'action'],
};
class AgentError extends Error {
    constructor(readonly code: string, message: string, readonly refreshRequired = false) { super(message); }
}
function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentError('INVALID_REQUEST', t('agent.requestMustBeJsonObject'));
    return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max = 4096): string {
    if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw new AgentError('INVALID_REQUEST', name + t('agent.mustBeNonEmptyString'));
    return value;
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new AgentError('INVALID_REQUEST', t('agent.integerRange', { min, max }));
    return value;
}
function choice<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
    if (value === undefined) return fallback;
    const found = values.find(item => item === value);
    if (found === undefined) throw new AgentError('INVALID_REQUEST', t('agent.unsupportedEnum'));
    return found;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
    if (Object.keys(value).some(key => !allowed.includes(key))) throw new AgentError('INVALID_REQUEST', t('agent.unknownFields'));
}
function summary(repo: Repository): unknown {
    return {
        id: repo.id, path: repo.path, name: repo.name, parent: repo.parent, initialized: repo.initialized,
        branch: repo.branch, head: repo.head, headState: headState(repo), upstream: repo.upstream, ahead: repo.ahead, behind: repo.behind,
        version: repo.version, operation: repo.operation, error: repo.error,
        counts: {
            files: repo.files.length, conflicts: repo.files.filter(file => file.conflict).length,
            worktree: repo.files.filter(file => !file.conflict && file.worktree !== ' ').length,
            index: repo.files.filter(file => !file.conflict && file.index !== ' ' && file.index !== '?').length,
        }, remoteCacheOnly: true,
    };
}
function verbose(query: Record<string, unknown>): boolean {
    if (query.verbose !== undefined && typeof query.verbose !== 'boolean') throw new AgentError('INVALID_REQUEST', t('agent.verboseBoolean'));
    return query.verbose === true;
}
// MCP replies default to what an agent acts on: paths, classifications and blockers. Fingerprints,
// object ids and patch bodies stay available with verbose: true (the panel keeps using the full data).
function compactReview(review: ScopeReview, full: boolean): unknown {
    if (full) return review;
    const counts: Record<string, number> = {};
    for (const file of review.files) counts[file.classification] = (counts[file.classification] ?? 0) + 1;
    return { ...review, files: review.files.map(file => ({ path: file.path, index: file.index, worktree: file.worktree, classification: file.classification, inScope: file.inScope, humanReviewed: file.humanReviewed, ...(file.submodule ? { submodule: true } : {}), ...(file.conflict ? { conflict: true } : {}) })),
        summary: { files: review.files.length, inScope: review.files.filter(file => file.inScope).length, byClassification: counts, blockers: review.blockers.length }, compact: true, note: t('agent.verboseNoteFingerprints') };
}
function compactPlan(plan: Plan, full: boolean): unknown {
    if (full || plan.patch === undefined) return plan;
    const { patch, ...rest } = plan;
    return { ...rest, patchBytes: Buffer.byteLength(patch), compact: true, note: t('agent.verboseNotePatch') };
}
// Bounded waits keep one MCP call under the adapter's 120-second HTTP timeout even when a call first
// queues behind another operation (up to queueMs) and then waits for its own task.
const EXECUTE_WAIT_LIMIT = 60000, STATUS_WAIT_LIMIT = 100000;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.max(1, ms)));
export interface AgentOptions { queueMs?: number; waitMs?: number; pollMs?: number; }
function taskView(task: Task | null, limit: number): unknown {
    return task && { ...task, repositories: task.repositories?.map(row => ({ ...row, detail: row.detail.slice(0, 150), detailTruncated: row.detail.length > 150 })), log: limit ? task.log.slice(-limit) : '', logTruncated: task.log.length > limit, requiresPolling: task.status === 'running' };
}

export class AgentBridge {
    private plans = new Map<string, { repo: string; digest: string; expires: number; scope?: { id: string; version: string; paths: string[]; includePointers: boolean } }>();
    private preparing = false;

    constructor(private service: AgentService, private navigate: Navigate, private options: AgentOptions = {}) {}
    // Callers that arrive while a preview or task is running wait their turn for a bounded time instead
    // of being refused at once; agents that fire calls in parallel otherwise just retry in a loop.
    private async idle(message: string, preparingCounts = true): Promise<void> {
        const busy = () => (preparingCounts && this.preparing) || this.service.task()?.status === 'running';
        if (!busy()) return;
        const deadline = Date.now() + (this.options.queueMs ?? 45000);
        while (busy() && Date.now() < deadline) await sleep(Math.min(100, deadline - Date.now()));
        if (busy()) throw new AgentError('BUSY', message);
    }
    // Asset/.meta pairing, staging consistency and uuid checks join the task review of a commit, so a
    // commit that would leave an asset without its .meta is blocked before it reaches Git.
    private async withMeta(repo: string, review: ScopeReview, options: MetaCheckOptions): Promise<ScopeReview & { meta?: MetaCheckResult }> {
        if (!this.service.metaCheck) return review;
        const meta = await this.service.metaCheck(repo, options);
        const blockers = meta.blockers.map(issue => ({ code: issue.code, path: issue.path, message: issue.message + (issue.related ? t('agent.relatedSuffix', { related: issue.related }) : '') }));
        return { ...review, meta, blockers: [...review.blockers, ...blockers], canProceed: review.canProceed && blockers.length === 0 };
    }
    private async settle(taskId: string, waitMs: number): Promise<Task | null> {
        const deadline = Date.now() + waitMs;
        let current = this.service.task();
        while (current?.status === 'running' && current.id === taskId && Date.now() < deadline) { await sleep(Math.min(100, deadline - Date.now())); current = this.service.task(); }
        return current;
    }

    private operation(repo: string, value: unknown): OperationRequest {
        const input = object(value);
        const strings = ['version', 'action', 'message', 'branch', 'newBranch', 'remote', 'revision', 'remoteBranch', 'upstreamRevision', 'stashRef', 'stashPart', 'tag', 'tagKind', 'tagObject', 'mergeVersion', 'remoteVersion', 'url'];
        const booleans = ['includePointers', 'includeUntracked', 'restoreIndex'];
        keys(input, [...strings, ...booleans, 'paths', 'lines', 'resolution']);
        text(input.version, 'version', 256);
        const action = text(input.action, 'action', 64);
        if (!this.service.supportedActions().some(item => item === action)) throw new AgentError('UNSUPPORTED_ACTION', t('agent.actionUnsupported'));
        for (const key of strings) if (input[key] !== undefined) text(input[key], key, key === 'message' ? 5000 : 4096);
        for (const key of booleans) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new AgentError('INVALID_REQUEST', key + t('agent.mustBeBoolean'));
        if (input.tagKind !== undefined && input.tagKind !== 'lightweight' && input.tagKind !== 'annotated') throw new AgentError('INVALID_REQUEST', t('agent.tagKindValues'));
        if (input.stashPart !== undefined && input.stashPart !== 'tracked' && input.stashPart !== 'index' && input.stashPart !== 'untracked') throw new AgentError('INVALID_REQUEST', t('agent.stashPartValues'));
        if (input.paths !== undefined) {
            if (!Array.isArray(input.paths) || input.paths.length > 5000) throw new AgentError('INVALID_REQUEST', t('agent.pathsLimit5000'));
            for (const item of input.paths) text(item, 'path');
        }
        if (input.lines !== undefined) {
            const lines = object(input.lines); keys(lines, ['path', 'version', 'ids']);
            text(lines.path, 'lines.path'); text(lines.version, 'lines.version', 256);
            if (!Array.isArray(lines.ids) || !lines.ids.length || lines.ids.length > 15000) throw new AgentError('INVALID_REQUEST', t('agent.lineIdsInvalid'));
            for (const id of lines.ids) text(id, 'line id', 128);
        }
        if (input.resolution !== undefined) {
            const resolution = object(input.resolution); keys(resolution, ['path', 'version', 'mode']);
            text(resolution.path, 'resolution.path'); text(resolution.version, 'resolution.version', 256);
            if (resolution.mode !== 'content' && resolution.mode !== 'delete') throw new AgentError('INVALID_REQUEST', t('agent.invalidResolution'));
        }
        // The JSON round trip freezes caller-owned arrays before any asynchronous preparation.
        return { ...JSON.parse(JSON.stringify(input)), repo };
    }

    async handle(repo: string, value: unknown): Promise<AgentReply> {
        let op = 'unknown', mayHaveSideEffects = false;
        try {
            text(repo, 'repo');
            let encoded: string;
            try { encoded = JSON.stringify(value); } catch { throw new AgentError('INVALID_REQUEST', t('agent.requestNotSerializable')); }
            if (!encoded || Buffer.byteLength(encoded) > INPUT_LIMIT) throw new AgentError('INVALID_REQUEST', t('agent.requestTooLarge'));
            const query = object(JSON.parse(encoded));
            if (query.kind !== 'agent' || query.protocol !== 1) throw new AgentError('UNSUPPORTED_PROTOCOL', t('agent.kindProtocol'));
            op = text(query.op, 'op', 64);
            const allowed = Object.prototype.hasOwnProperty.call(queryKeys, op) ? queryKeys[op] : undefined;
            if (!allowed) throw new AgentError('UNSUPPORTED_OPERATION', t('agent.unknownOp'));
            keys(query, ['kind', 'protocol', 'op', ...allowed]);
            if (query.force !== undefined && typeof query.force !== 'boolean') throw new AgentError('INVALID_REQUEST', t('agent.forceBoolean'));
            for (const [token, plan] of this.plans) if (plan.expires <= Date.now()) this.plans.delete(token);
            let result: unknown;
            if (op === 'capabilities') {
                result = {
                    protocol: 1, entry: "Editor.Message.request('cocos-git-desk', 'details', repo, query)",
                    operations: Object.keys(queryKeys), actions: this.service.supportedActions(),
                    limits: { requestBytes: INPUT_LIMIT, responseBytes: RESPONSE_LIMIT, pageSize: 200, treeDirectoryEntries: 20000, reflogPageSize: 100, reflogRecentEntries: 1000, remotePageSize: 50, fileComparisonCharacters: 16000, fileComparisonCacheBytes: 8388608, fileComparisonCacheMs: 10000, fileComparisonConcurrentReads: 2, worktreeComparisonFileBytes: 5242880, worktreeComparisonPatchTextBytes: 2097152, worktreeComparisonCacheMs: 0, indexComparisonFileBytes: 5242880, indexComparisonPatchTextBytes: 2097152, indexComparisonCacheMs: 0, remoteCount: 1000, tagReferences: 10000, pendingPlans: PLAN_LIMIT, taskLogCharacters: 8000 },
                    headStates: { attached: 'HEAD is on a local branch', detached: 'HEAD is a commit without a current branch; createBranchAt can preserve a pinned commit without switching', unborn: 'no current commit; do not infer detached from an empty branch name', unavailable: 'uninitialized or failed repository read; refresh before planning' },
                    writeFlow: ['status: read version', 'prepare: inspect full plan, paths and warnings', 'execute: echo token and digest after review', 'execute waits for its task by default (wait, waitMs); task: taskId with waitMs long-polls instead of looping'],
                    taskScopes: { persistedLocally: true, perRepository: true, exactPaths: true, maximumTasks: 32, taskLimitScope: 'continuable tasks per repository per context', staleTasks: 'incompatible tasks archived on scopeStart; original baseline retained', continuation: 'same branch, unrelated fast-forward commits or verified scoped commits; original baseline retained', extendTool: 'git_desk_task_extend', reviewPolicy: this.service.scopePolicy ? await this.service.scopePolicy() : undefined, maximumDirtyFiles: 500, maximumFileBytes: 16777216, maximumTotalBytes: 134217728, ownershipInferred: false, protectedActions: ['stage', 'stageLines', 'commit', 'commitSelected'], mcpRequiresTaskId: true, legacyIpcTaskIdOptional: true, mixedChanges: 'human review follows effective reviewPolicy; when required only exact approved content passes; baseline remains unchanged', mcpTransport: 'Python 3 stdio to authenticated loopback RPC; not remote HTTP MCP', mcpTokensSeparateFromIpc: true },
                    actionParameters: {
                        merge: { required: ['version','revision'], optional: ['message','includePointers'], fastForward: true, automaticCommit: 'when conflict-free', conflicts: 'leave pending merge', previewContentLimits: false },
                        commitSelected: { required: ['version','paths','message'], taskIdRequired: true, wholeFiles: true, rejectsStagedOutsideSelection: true, previewUsesTemporaryIndex: true },
                        projectTools: { actions: this.service.supportedActions().filter(action => action.startsWith('fork')), required: ['version', 'branch'], optional: ['remote'], platform: 'native Git / Python 3 discovery', scope: 'entire Creator project initialized repositories', previewRemote: 'local cache only', executeFetchesAndPinsTarget: true, executeOpensTerminal: false, resetsDiscardTrackedChanges: true, cleanVariantRemovesUntracked: true, requiresSavedEditor: true },
                        ...(this.service.supportedActions().includes('updateAll') ? {updateAll:{required:['version'],acceptsPaths:false,scope:'entire Creator project including initialized nested submodules',prepareFetches:false,executeFetches:true,fastForwardOnly:true,detachedHead:'select latest remote branch using migrated Fork rules; ambiguous selection fails',temporaryStash:'overlapping edits and staged paths; restore index; retain on conflict',pushes:false,initializesSubmodules:false,automaticRetry:false,progress:'task.repositories: id,status,phase,detail,branch,head',requiresSavedEditor:true}} : {}),
                        ...(this.service.supportedActions().includes('beginMerge')?{beginMerge:{required:['version','revision'],fullCommitShaOnly:true,minimumGit:'2.34',requiresCleanTree:true,strategy:'ort',fastForward:false,automaticCommit:false,autoStash:false,renameDetection:false,rerereReuse:false,recordsCleanStart:true,maxPaths:50}}:{}),
                        ...(this.service.supportedActions().includes('abortMerge')?{abortMerge:{required:['version','mergeVersion'],reads:'merge.abortVersion',requiresRecordedCleanStart:true,alwaysBacksUp:false,automaticRetry:false}}:{}),
                        ...Object.fromEntries(['discardFiles','restoreFiles'].filter(action=>this.service.supportedActions().some(value=>value===action)).map(action=>[action,{required:['version','paths',...(action==='restoreFiles'?['revision']:[])],worktreeOnly:true,preservesIndex:true,alwaysBacksUp:false,maxPaths:50,fileBytes:10485760,totalBytes:52428800,requiresSavedEditor:true,restoreSource:action==='discardFiles'?'index':'full commit SHA',runsCustomFilters:false,postCheckoutHooks:true}])),
                        ...(this.service.supportedActions().includes('restoreStashFiles') ? {restoreStashFiles:{required:['version','paths','stashRef','revision','stashPart'],stashParts:['tracked','index','untracked'],revision:'full retained stash commit SHA matching stashRef',worktreeOnly:true,preservesIndex:true,preservesStash:true,alwaysBacksUp:false,maxPaths:50,fileBytes:10485760,totalBytes:52428800,requiresSavedEditor:true,expandsAssetMeta:true,requiresExistingParents:true,rejectsDeletionEntries:true,rejectsUntrackedCollisions:true,runsCustomFilters:false,postCheckoutHooks:true,automaticRetry:false}} : {}),
                        ...(this.service.supportedActions().includes('discardLines') ? {discardLines:{required:['version','lines'],reads:'diff worktree -> partial.version and hunk line ids',worktreeOnly:true,preservesIndex:true,preservesUnselectedContent:true,alwaysBacksUp:false,maxPaths:1,fileBytes:5242880,patchJsonBytes:131072,maxLineIds:15000,encoding:'UTF-8 LF only',expandsAssetMeta:false,requiresSavedEditor:true,runsCustomFilters:false,automaticRetry:false}} : {}),
                        ...(this.service.supportedActions().includes('createBranchAt') ? { createBranchAt: { required: ['version', 'branch', 'revision'], fullCommitShaOnly: true, minimumGit: '2.54', createsRefOnly: true, switchesBranch: false, acceptsPaths: false, runsReferenceTransactionHooks: true, setsUpstream: false, pushes: false } } : {}),
                        ...Object.fromEntries(['addRemote', 'setRemoteUrl', 'setRemotePushUrl', 'resetRemotePushUrl'].filter(action => this.service.supportedActions().some(value => value === action)).map(action => [action, { required: ['version', 'remoteVersion', 'remote', ...(action === 'resetRemotePushUrl' ? [] : ['url'])], reads: 'remotes', changesLocalConfig: true, atomicConfigFile: true, connectsRemote: false, rejectsInheritedOrRewrittenConfig: true }])),
                        ...(this.service.supportedActions().includes('stashSelected') ? { stashSelected: { required: ['version', 'paths'], optional: ['message', 'includeUntracked'], maximumPaths: 5000, wholeFiles: true, includesIndexAndWorktree: true, expandsRelatedAssetsAndMeta: true, rejectsStagedOutsideScope: true, changesWorktree: true, requiresSavedEditor: true } } : {}),
                        ...(this.service.supportedActions().includes('finishMerge') ? { finishMerge: { required: ['version', 'mergeVersion', 'message'], optional: ['includePointers'], reads: 'merge', entireIndex: true, acceptsPaths: false, ordinaryTwoParentMergeOnly: true, requiresSavedEditor: true, preservesHooksAndSigning: true, pushes: false } } : {}),
                    },
                    rules: ['Same GitDesk service and editor protections as the panel; MCP uses authenticated loopback RPC, no arbitrary shell or eval.', 'A prepared plan is not user authorization. Follow the human instruction scope.', 'All commits include the whole index; staging can expand related asset/meta paths.', 'Never retry a failed or uncertain write automatically. Refresh and inspect task status.', 'Remote references are cached; read queries do not fetch.'],
                    reads: {
                        merge: 'op=merge -> canFinish/version are for finishing; canAbort/abortVersion/abortReason are separate and require a matching clean-start journal; beginMerge task success means pending merge, possibly conflicts, not a created commit',
                        reflog: 'op=reflog -> local HEAD, refs/heads or refs/remotes log entries (remote-tracking events on this machine only; no network); recent readable window, versioned pages, event dates; selectors are display only, recovery uses pinned commit SHA',
                        fileCompare: 'op=fileCompare -> two pinned commit/path snapshots, metadata or bounded text fragments; image bytes omitted; no worktree writes or implicit LFS fetch',
                        worktreeCompare: 'op=worktreeCompare -> left pinned commit/path versus path on saved disk; raw bytes, no editor buffers/filters/LFS expansion; always rereads disk, cachedUpToMs=0; pagination requires comparison.version, STATE_CHANGED on edit; image bytes omitted; read-only',
                        indexCompare: 'op=indexCompare -> left pinned commit/path versus exact current index stage-0 path, excluding disk edits; raw objects, no LFS expansion; missing distinct from empty; conflicts and intent-to-add rejected; no completed cache; pagination binds comparison.version for this entry only; image bytes omitted; read-only',
                        remotes: 'op=remotes -> raw local configuration pages; remoteVersion binds writes, version binds pagination; inherited/rewrite/multivalue configurations are read-only',
                        details: 'Use op=branches/remoteBranches/stashes for bounded versioned pages; no network fetch', tags: 'op=tags -> versioned local metadata pages; object is the ref OID, commit is the direct commit target when available; no annotation text or signature verification', history: 'op=history, scope=current|all, optional search={field:message|author,text}, path, cursor; op=sync direction=incoming|outgoing snapshot/start',
                        diff: 'op=diff path/area/revision/stashPart view=summary|patch|before|after|lines; offset/limit/version, image bytes omitted; partialVersion and line IDs support protected line writes', commitFiles: "commit-files(repo, revision, 'commit' | 'stash')",
                        tree: "op=tree -> one directory at a pinned commit; diff({repo,path,area:'tree',revision}) reads its historical snapshot, including unchanged files",
                    }, navigation: ['describe', 'reveal', 'open'],
                };
            } else if (['branches', 'remoteBranches', 'stashes', 'history', 'diff', 'sync', 'commitDetails', 'commitFiles'].includes(op)) {
                await this.idle(t('agent.waitForGitBeforeRead'));
                if (op === 'branches' || op === 'remoteBranches' || op === 'stashes') {
                    if (!this.service.agentReferencePage) throw new AgentError('UNSUPPORTED_OPERATION', t('agent.noRefPaging'));
                    result = await this.service.agentReferencePage(repo, op, { offset: integer(query.offset, 0, 0, 100000), limit: integer(query.limit, 100, 1, 200), text: query.text === undefined ? undefined : text(query.text, 'text', 500), version: query.version === undefined ? undefined : text(query.version, 'version', 256) });
                } else if (op === 'history') {
                    if (!this.service.historyPage) throw new AgentError('UNSUPPORTED_OPERATION', t('agent.noHistoryPaging'));
                    let search: HistoryQuery['search'];
                    if (query.search !== undefined) { const item = object(query.search); keys(item, ['field', 'text']); search = { field: choice(item.field, ['author', 'message'], 'message'), text: text(item.text, 'search.text', 500) }; }
                    result = await this.service.historyPage(repo, { scope: choice(query.scope, ['current', 'all'], 'current'), cursor: query.cursor === undefined ? undefined : text(query.cursor, 'cursor', 256), path: query.path === undefined ? undefined : text(query.path, 'path'), search });
                } else if (op === 'sync') {
                    if (!this.service.syncPage) throw new AgentError('UNSUPPORTED_OPERATION', t('agent.noSyncOverview'));
                    result = await this.service.syncPage(repo, { kind: 'sync', direction: choice<SyncQuery['direction'] & string>(query.direction, ['incoming', 'outgoing'], 'outgoing'), snapshot: query.snapshot === undefined ? undefined : text(query.snapshot, 'snapshot', 256), start: integer(query.start, 0, 0, 100000) });
                } else if (op === 'diff') {
                    if (!this.service.agentDiffPage) throw new AgentError('UNSUPPORTED_OPERATION', t('agent.noDiffPaging'));
                    const area = choice(query.area, ['worktree', 'index', 'commit', 'stash', 'conflict'], 'worktree');
                    const revision = query.revision === undefined ? undefined : text(query.revision, 'revision', 64);
                    if ((area === 'commit' || area === 'stash') && (!revision || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision))) throw new AgentError('INVALID_REQUEST', t('agent.historyDiffNeedsSha'));
                    if (area !== 'commit' && area !== 'stash' && revision !== undefined) throw new AgentError('INVALID_REQUEST', t('agent.worktreeDiffNoRevision'));
                    result = await this.service.agentDiffPage(repo, { path: text(query.path, 'path'), area, revision, stashPart: query.stashPart === undefined ? undefined : choice<'tracked' | 'index' | 'untracked'>(query.stashPart, ['tracked', 'index', 'untracked'], 'tracked'), view: choice(query.view, ['summary', 'patch', 'before', 'after', 'lines'], 'summary'), offset: integer(query.offset, 0, 0, 10000000), limit: integer(query.limit, 8000, 1, 16000), version: query.version === undefined ? undefined : text(query.version, 'version', 256) });
                } else {
                    const revision = text(query.revision, 'revision', 64);
                    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) throw new AgentError('INVALID_REQUEST', t('agent.useFullSha'));
                    if (op === 'commitDetails') { if (!this.service.commitDetails) throw new AgentError('UNSUPPORTED_OPERATION', t('agent.noCommitDetails')); result = await this.service.commitDetails(repo, revision); }
                    else { if (!this.service.commitFiles) throw new AgentError('UNSUPPORTED_OPERATION', t('agent.noCommitFiles')); const files = await this.service.commitFiles(repo, revision), offset = integer(query.offset, 0, 0, 100000), limit = integer(query.limit, 100, 1, 200); result = { revision, files: files.slice(offset, offset + limit), total: files.length, offset, nextOffset: offset + limit < files.length ? offset + limit : undefined }; }
                }
            } else if (op === 'reflog') {
                const offset = integer(query.offset, 0, 0, Number.MAX_SAFE_INTEGER), limit = integer(query.limit, 20, 1, 100);
                if (query.ref !== undefined) text(query.ref, 'ref', 512);
                if (query.text !== undefined && (typeof query.text !== 'string' || query.text.length > 512 || query.text.includes('\0'))) throw new AgentError('INVALID_REQUEST', t('agent.textLiteral512'));
                if (query.version !== undefined && !/^[a-f0-9]{64}$/.test(text(query.version, 'version', 64))) throw new AgentError('INVALID_REQUEST', t('agent.versionNeedsReflogDigest'));
                if (offset > 0 && !query.version) throw new AgentError('STATE_CHANGED', t('agent.reflogPagingNeedsVersion'), true);
                await this.idle(t('agent.taskRunningReflog'), false);
                result = await this.service.reflog(repo, { kind: 'reflog', ref: typeof query.ref === 'string' ? query.ref : 'HEAD', text: typeof query.text === 'string' ? query.text : '', offset, limit, version: typeof query.version === 'string' ? query.version : undefined });
            } else if (op === 'fileCompare' || op === 'worktreeCompare' || op === 'indexCompare') {
                const edge = (value: unknown): FileRevision => {
                    const item = object(value); keys(item, ['revision', 'path']);
                    const revision = text(item.revision, 'revision', 64), path = text(item.path, 'path');
                    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) throw new AgentError('INVALID_REQUEST', t('agent.revisionNeedsSha'));
                    return { revision, path };
                };
                const left = edge(query.left), view = query.view === undefined ? 'summary' : query.view;
                if (view !== 'summary' && view !== 'patch' && view !== 'before' && view !== 'after') throw new AgentError('INVALID_REQUEST', t('agent.viewValues'));
                const offset = integer(query.offset, 0, 0, Number.MAX_SAFE_INTEGER), limit = integer(query.limit, 8000, 1, 16000);
                if (query.version !== undefined && !/^[a-f0-9]{64}$/.test(text(query.version, 'version', 64))) throw new AgentError('INVALID_REQUEST', t('agent.versionNeedsCompareDigest'));
                if (view === 'summary' && offset !== 0) throw new AgentError('INVALID_REQUEST', t('agent.summaryNoOffset'));
                if (offset > 0 && !query.version) throw new AgentError('STATE_CHANGED', t('agent.laterChunkNeedsVersion'), true);
                await this.idle(t('agent.taskRunningCompare'), false);
                const version = typeof query.version === 'string' ? query.version : undefined;
                if (op === 'fileCompare') result = await this.service.compareFilePage(repo, { left, right: edge(query.right), view, offset, limit, version, force: query.force === true });
                else if (op === 'worktreeCompare') result = await this.service.compareWorktreePage(repo, { left, path: text(query.path, 'path'), view, offset, limit, version });
                else result = await this.service.compareIndexPage(repo, { left, path: text(query.path, 'path'), view, offset, limit, version });
            } else if (op === 'remotes') {
                const offset = integer(query.offset, 0, 0, Number.MAX_SAFE_INTEGER), limit = integer(query.limit, 20, 1, 50);
                if (query.version !== undefined) text(query.version, 'version', 64);
                if (query.text !== undefined && (typeof query.text !== 'string' || query.text.length > 512 || query.text.includes('\0'))) throw new AgentError('INVALID_REQUEST', t('agent.textKeyword512'));
                await this.idle(t('agent.taskRunningRemotes'), false);
                result = await this.service.remotePage(repo, { kind: 'remotes', offset, limit, text: typeof query.text === 'string' ? query.text : '', version: typeof query.version === 'string' ? query.version : undefined });
            } else if (op === 'merge') {
                await this.idle(t('agent.taskRunningMerge'), false);
                result = await this.service.mergeState(repo);
            } else if (op === 'tree') {
                const revision = text(query.revision, 'revision', 64);
                if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) throw new AgentError('INVALID_REQUEST', t('agent.treeRevisionNeedsSha'));
                const offset = integer(query.offset, 0, 0, Number.MAX_SAFE_INTEGER), limit = integer(query.limit, 100, 1, 200);
                for (const key of ['directory', 'text']) if (query[key] !== undefined && (typeof query[key] !== 'string' || query[key].length > 4096 || query[key].includes('\0'))) throw new AgentError('INVALID_REQUEST', key + t('agent.mustBeString4096'));
                if (query.version !== undefined) text(query.version, 'version', 256);
                if (offset > 0 && !query.version) throw new AgentError('STATE_CHANGED', t('agent.treePagingNeedsVersion'), true);
                await this.idle(t('agent.taskRunningTree'), false);
                result = await this.service.tree(repo, { kind: 'tree', revision, directory: typeof query.directory === 'string' ? query.directory : '', text: typeof query.text === 'string' ? query.text : '', offset, limit, version: typeof query.version === 'string' ? query.version : undefined });
            } else if (op === 'tags') {
                const offset = integer(query.offset, 0, 0, Number.MAX_SAFE_INTEGER), limit = integer(query.limit, 100, 1, 200);
                if (query.version !== undefined) text(query.version, 'version', 256);
                if (offset > 0 && !query.version) throw new AgentError('STATE_CHANGED', t('agent.tagPagingNeedsVersion'), true);
                if (query.text !== undefined && (typeof query.text !== 'string' || query.text.length > 4096 || query.text.includes('\0'))) throw new AgentError('INVALID_REQUEST', t('agent.textLiteral4096'));
                await this.idle(t('agent.taskRunningTags'), false);
                result = await this.service.tags(repo, { kind: 'tags', offset, limit, text: typeof query.text === 'string' ? query.text : '', version: typeof query.version === 'string' ? query.version : undefined });
            } else if (op === 'task') {
                const limit = integer(query.logLimit, 4000, 0, 8000), waitMs = integer(query.waitMs, this.options.pollMs ?? 5000, 0, STATUS_WAIT_LIMIT);
                let current = this.service.task();
                if (query.taskId !== undefined && text(query.taskId, 'taskId', 128) !== current?.id) throw new AgentError('TASK_NOT_FOUND', t('agent.taskNotRetained'), true);
                const started = Date.now();
                if (current?.status === 'running' && waitMs > 0) current = await this.settle(current.id, waitMs);
                result = current ? { ...(taskView(current, limit) as Record<string, unknown>), requiresPolling: current.status === 'running', waitedMs: Date.now() - started, ...(current.status === 'running' ? { note: t('agent.taskStillRunningWait') } : {}) } : null;
            } else if (op === 'scopeStart' || op === 'scopeList' || op === 'scopeExtend' || op === 'scopeChanges' || op === 'commitCheck') {
                await this.idle(t('agent.waitForExistingTask'));
                this.preparing = true;
                try {
                    if (!this.service.scopeStart || !this.service.scopeList || !this.service.scopeReview) throw new AgentError('UNSUPPORTED_OPERATION', t('agent.noTaskScope'));
                    if (op === 'scopeList') result = await this.service.scopeList(repo);
                    else if (op === 'scopeExtend') {
                        if (!this.service.scopeExtend) throw new AgentError('UNSUPPORTED_OPERATION', t('agent.noTaskExtend'));
                        if (!Array.isArray(query.paths) || !query.paths.length || query.paths.length > 500) throw new AgentError('INVALID_REQUEST', t('agent.pathsExplicit500'));
                        mayHaveSideEffects = true;
                        result = await this.service.scopeExtend(repo, text(query.id, 'id', 128), query.paths.map(item => text(item, 'path')));
                    } else if (op === 'scopeStart') {
                        const title = text(query.title, 'title', 200);
                        if (!Array.isArray(query.paths) || !query.paths.length || query.paths.length > 500) throw new AgentError('INVALID_REQUEST', t('agent.pathsExplicit500'));
                        mayHaveSideEffects = true;
                        result = await this.service.scopeStart(repo, title, query.paths.map(item => text(item, 'path')));
                    } else {
                        if (query.includePointers !== undefined && typeof query.includePointers !== 'boolean') throw new AgentError('INVALID_REQUEST', t('agent.includePointersBoolean'));
                        let review = await this.service.scopeReview(repo, text(query.id, 'id', 128), op === 'scopeChanges' ? [] : undefined, query.includePointers === true);
                        if (op === 'commitCheck') review = await this.withMeta(repo, review, { scope: 'index' });
                        result = compactReview(review, verbose(query));
                    }
                } finally { this.preparing = false; }
            } else if (op === 'prepare') {
                await this.idle(t('agent.busyReadTaskLater'));
                const operation = this.operation(repo, query.operation);
                if (!this.service.prepareValidated) {
                    const snapshot = await this.service.snapshot(true), current = snapshot.repositories.find(item => item.id === repo);
                    if (!current || !current.initialized || current.error) throw new AgentError('REPOSITORY_UNAVAILABLE', current?.error || t('agent.repositoryUnavailable'), true);
                    if (current.version !== operation.version) throw new AgentError('STATE_CHANGED', t('agent.repositoryVersionChanged'), true);
                }
                await this.idle(t('agent.busyPreview'));
                this.preparing = true;
                try {
                    const plan = await (this.service.prepareValidated ? this.service.prepareValidated(operation) : this.service.prepare(operation));
                    let scope: { id: string; version: string; paths: string[]; includePointers: boolean } | undefined;
                    let scopeReview: ScopeReview | undefined;
                    if (query.taskId !== undefined) {
                        if (!this.service.scopeReview || !['stage', 'stageLines', 'commit', 'commitSelected'].includes(operation.action)) throw new AgentError('INVALID_REQUEST', t('agent.taskIdActions'));
                        const id = text(query.taskId, 'taskId', 128);
                        scopeReview = await this.service.scopeReview(repo, id, plan.paths, operation.includePointers === true);
                        if (!scopeReview.canProceed) throw new AgentError('SCOPE_BLOCKED', JSON.stringify(scopeReview.blockers), true);
                        if (operation.action === 'commit' || operation.action === 'commitSelected') {
                            scopeReview = await this.withMeta(repo, scopeReview, operation.action === 'commit' ? { scope: 'index' } : { scope: 'worktree', paths: plan.paths });
                            if (!scopeReview.canProceed) throw new AgentError('META_BLOCKED', JSON.stringify(scopeReview.blockers), true);
                        }
                        scope = { id, version: scopeReview.snapshotVersion, paths: [...plan.paths], includePointers: operation.includePointers === true };
                    }
                    const digest = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
                    if (Buffer.byteLength(JSON.stringify(plan)) > RESPONSE_LIMIT - 1024) throw new AgentError('RESPONSE_TOO_LARGE', t('agent.previewTooLarge'));
                    while (this.plans.size >= PLAN_LIMIT) this.plans.delete(this.plans.keys().next().value!);
                    this.plans.set(plan.token, { repo, digest, expires: plan.expiresAt, scope });
                    // The digest covers the full plan; a compact reply only leaves out the patch body and file fingerprints.
                    result = { plan: compactPlan(plan, verbose(query)), digest, scopeReview: scopeReview && compactReview(scopeReview, verbose(query)), requiresReview: true, reviewMode: 'agentPlanReview', authorizationPolicy: 'reuse existing human authorization within its scope; ask only for new scope or destructive effects', executed: false };
                } finally { this.preparing = false; }
            } else if (op === 'execute') {
                if (query.wait !== undefined && typeof query.wait !== 'boolean') throw new AgentError('INVALID_REQUEST', t('agent.waitBoolean'));
                const wait = query.wait !== false, waitMs = integer(query.waitMs, this.options.waitMs ?? 45000, 0, EXECUTE_WAIT_LIMIT);
                const token = text(query.token, 'token', 128), digest = text(query.digest, 'digest', 64), plan = this.plans.get(token);
                if (!plan || plan.repo !== repo || plan.digest !== digest || plan.expires <= Date.now()) throw new AgentError('PLAN_INVALID', t('agent.previewInvalid'), true);
                await this.idle(t('agent.busyReadTaskFirst'));
                this.preparing = true;
                let started: Task | undefined;
                try {
                    if (plan.scope) {
                        if (!this.service.scopeReview) throw new AgentError('SCOPE_BLOCKED', t('agent.taskScopeBackendUnavailable'));
                        const review = await this.service.scopeReview(repo, plan.scope.id, plan.scope.paths, plan.scope.includePointers);
                        if (!review.canProceed || review.snapshotVersion !== plan.scope.version) { this.plans.delete(token); throw new AgentError('SCOPE_CHANGED', t('agent.scopeChangedAfterPreview'), true); }
                    }
                    this.plans.delete(token); mayHaveSideEffects = true;
                    started = this.service.execute(token, plan.scope?.id);
                } finally { this.preparing = false; }
                // The reply carries the final status when the task ends within the wait budget; otherwise the
                // caller continues with task_status and waitMs rather than a polling loop.
                const since = Date.now();
                const current = wait && waitMs > 0 && started.status === 'running' ? await this.settle(started.id, waitMs) : this.service.task();
                const final = current?.id === started.id ? current : started;
                result = { ...(taskView(final, 4000) as Record<string, unknown>), completed: final.status !== 'running', requiresPolling: final.status === 'running', waitedMs: Date.now() - since,
                    ...(final.status === 'running' ? { note: t('agent.taskStillRunningStatus') } : {}) };
            } else if (op === 'navigate') {
                const name = text(query.path, 'path'), action = query.action;
                if (action !== 'describe' && action !== 'reveal' && action !== 'open') throw new AgentError('INVALID_REQUEST', t('agent.navigateActionValues'));
                if (action !== 'describe') await this.idle(t('agent.taskRunningOpenAsset'), false);
                mayHaveSideEffects = action !== 'describe'; result = await this.navigate(repo, name, action);
            } else {
                const snapshot = await this.service.snapshot(query.force === true);
                const duringTask = snapshot.task?.status === 'running';
                const observation = { respondedAt: new Date().toISOString(), cachedUpToMs: duringTask ? null : 4000, duringTask, frozenDuringTask: duringTask, task: taskView(snapshot.task, 0) };
                if (op === 'repositories') {
                    const offset = integer(query.offset, 0, 0, Number.MAX_SAFE_INTEGER), limit = integer(query.limit, 50, 1, 200);
                    const repos = snapshot.repositories;
                    const version = createHash('sha256').update(JSON.stringify(repos.map(item => [item.id, item.path, item.version, item.initialized, item.error]))).digest('hex');
                    if (query.version !== undefined) text(query.version, 'version', 256);
                    if ((offset > 0 && !query.version) || (query.version !== undefined && query.version !== version)) throw new AgentError('STATE_CHANGED', t('agent.repositoryListChanged'), true);
                    result = { ...observation, version, project: snapshot.project, root: snapshot.root, repositories: repos.slice(offset, offset + limit).map(summary), total: repos.length, offset, nextOffset: offset + limit < repos.length ? offset + limit : undefined };
                } else {
                    const current = snapshot.repositories.find(item => item.id === repo);
                    if (!current) throw new AgentError('REPOSITORY_NOT_FOUND', t('agent.repositoryOutOfScope'), true);
                    if (op === 'status') result = { ...observation, repository: summary(current), fetchedAt: snapshot.fetchedAt[repo] };
                    else {
                        if (!current.initialized || current.error) throw new AgentError('REPOSITORY_UNAVAILABLE', current.error || t('agent.repositoryUninitialized'), true);
                        const offset = integer(query.offset, 0, 0, Number.MAX_SAFE_INTEGER), limit = integer(query.limit, 100, 1, 200);
                        if (query.version !== undefined) text(query.version, 'version', 256);
                        if ((offset > 0 && !query.version) || (query.version !== undefined && query.version !== current.version)) throw new AgentError('STATE_CHANGED', t('agent.pagingVersionMismatch'), true);
                        if (query.text !== undefined && (typeof query.text !== 'string' || query.text.length > 4096 || query.text.includes('\0'))) throw new AgentError('INVALID_REQUEST', t('agent.textPathKeyword4096'));
                        const needle = typeof query.text === 'string' ? query.text.toLowerCase() : '';
                        const files = current.files.filter(file => file.path.toLowerCase().includes(needle) || file.oldPath?.toLowerCase().includes(needle));
                        result = { ...observation, repo, version: current.version, files: files.slice(offset, offset + limit).map(file => ({ ...file })), total: files.length, offset, nextOffset: offset + limit < files.length ? offset + limit : undefined };
                    }
                }
            }
            const response: AgentReply = { ok: true, data: { protocol: 1, op, result } };
            if (Buffer.byteLength(JSON.stringify(response)) > RESPONSE_LIMIT) throw new AgentError('RESPONSE_TOO_LARGE', t('agent.resultTooLarge'));
            return response;
        } catch (error) {
            return { ok: false, protocol: 1, op, code: error instanceof StashStateChangedError || error instanceof FileStateChangedError || error instanceof ReflogStateChangedError || error instanceof FileComparisonStateChangedError || error instanceof RemoteStateChangedError || error instanceof TagStateChangedError || error instanceof TreeStateChangedError || error instanceof MergeStateChangedError ? 'STATE_CHANGED' : error instanceof AgentError ? error.code : 'OPERATION_FAILED',
                error: (error instanceof Error ? error.message : String(error)).slice(0, 8000),
                refreshRequired: error instanceof AgentError ? error.refreshRequired : true, mayHaveSideEffects };
        }
    }
}
