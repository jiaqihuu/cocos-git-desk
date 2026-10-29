export interface ChangedFile {
    path: string;
    oldPath?: string;
    index: string;
    worktree: string;
    conflict: boolean;
    submodule: boolean;
    stashPart?: 'tracked' | 'index' | 'untracked';
}
export interface Repository {
    id: string;
    path: string;
    name: string;
    parent?: string;
    expected?: string;
    head: string;
    branch: string;
    upstream: string;
    ahead: number;
    behind: number;
    initialized: boolean;
    files: ChangedFile[];
    version: string;
    remoteVersion?: string;
    operation: string;
    error?: string;
}
export interface BranchTracking { state: 'none' | 'tracked' | 'gone' | 'invalid'; remote?: string; merge?: string; ahead?: number; behind?: number; }
export interface Branch { name: string; current: boolean; upstream: string; upstreamRef?: string; sha: string; worktree?: string; tracking?: BranchTracking; }
export interface RemoteBranch { ref: string; name: string; remote: string; branch: string; sha: string; }
export interface Stash { ref: string; sha: string; date: string; subject: string; }
export interface Tag { ref: string; name: string; }
export interface TagEntry extends Tag {
    object: string;
    objectType: string;
    kind: 'lightweight' | 'annotated' | 'symbolic';
    target: string;
    targetType: string;
    commit?: string;
    symbolic?: string;
}
export interface TagQuery { kind: 'tags'; text?: string; offset?: number; limit?: number; version?: string; }
export interface TagPage {
    repo: string; version: string; tags: TagEntry[]; offset: number; limit: number;
    total: number; tagCount: number; nextOffset?: number; capturedAt: string;
}
export class TagStateChangedError extends Error {}
export interface TreeEntry { path: string; name: string; mode: string; object: string; type: 'tree' | 'blob' | 'commit'; kind: 'directory' | 'file' | 'executable' | 'symlink' | 'submodule'; }
export interface TreeQuery { kind: 'tree'; revision: string; directory?: string; text?: string; offset?: number; limit?: number; version?: string; }
export interface TreePage { repo: string; revision: string; directory: string; tree: string; version: string; entries: TreeEntry[]; offset: number; limit: number; total: number; nextOffset?: number; }
export class TreeStateChangedError extends Error {}
export interface MergeQuery { kind: 'merge'; }
export interface MergeState {
    repo: string; repoVersion: string; version: string; active: boolean; canFinish: boolean;
    head: string; branch: string; mergeHead?: string; conflicts: number; staged: number | null;
    pointers: boolean; message: string; messageNotice?: string; reason?: string;
    canAbort?: boolean; abortVersion?: string; abortReason?: string;
}
export class MergeStateChangedError extends Error {}
export interface RemoteEntry { name: string; fetchUrls: string[]; pushUrls: string[]; fetchCount: number; pushCount: number; pushUsesFetch: boolean; editable: boolean; reason?: string; }
export interface RemoteQuery { kind: 'remotes'; offset?: number; limit?: number; version?: string; text?: string; }
export interface RemotePage { repo: string; repoVersion: string; version: string; remoteVersion: string; entries: RemoteEntry[]; total: number; offset: number; limit: number; nextOffset?: number; canAdd: boolean; reason?: string; }
export class RemoteStateChangedError extends Error {}
export interface ReflogEntry { index: number; revision: string; selector: string; date: string; actor: string; email: string; subject: string; subjectTruncated: boolean; identityTruncated: boolean; }
export interface ReflogQuery { kind: 'reflog'; ref?: string; text?: string; offset?: number; limit?: number; version?: string; }
export interface ReflogPage { repo: string; repoVersion: string; ref: string; version: string; entries: ReflogEntry[]; total: number; sampled: number; truncated: boolean; available: boolean; offset: number; limit: number; nextOffset?: number; capturedAt: string; notice: string; }
export class ReflogStateChangedError extends Error {}
export interface RepoDetails { repo: Repository; branches: Branch[]; remotes: string[]; remoteBranches: RemoteBranch[]; stashes: Stash[]; tags: Tag[]; }
export interface CommitDraft { message: string; version: string; updatedAt?: string; }
export type DraftQuery = { kind: 'draft'; action: 'read' } | { kind: 'draft'; action: 'save'; message: string; version: string };
export interface Commit { sha: string; short: string; author: string; date: string; subject: string; refs: string; parents: string[]; boundary?: boolean; }
export interface CommitPerson { name: string; email: string; date: string; }
export interface CommitDetails { sha: string; subject: string; message: string; parents: string[]; author: CommitPerson; committer: CommitPerson; shallow: boolean; }
export interface BlameLine { line: number; originalLine: number; sha: string; author: string; email: string; date: string; summary: string; originalPath: string; boundary: boolean; text: string; }
export interface BlameQuery { revision: string; path: string; start?: number; boundary?: string; }
export interface FileBlame { revision: string; path: string; start: number; totalLines: number; lines: BlameLine[]; nextStart?: number; boundary: string; shallow: boolean; notice?: string; }
export type InspectQuery = { kind: 'commit'; revision: string } | ({ kind: 'blame' } & BlameQuery);
export interface HistorySearch { field: 'message' | 'author'; text: string; }
export interface HistoryQuery { scope: 'current' | 'all'; cursor?: string; search?: HistorySearch; path?: string; }
export interface HistoryPage { commits: Commit[]; cursor?: string; scope: HistoryQuery['scope']; tipCount: number; shallow: boolean; filtered: boolean; search?: HistorySearch; path?: string; }
export type SyncDirection = 'outgoing' | 'incoming';
export interface SyncQuery { kind: 'sync'; direction?: SyncDirection; snapshot?: string; start?: number; }
export interface SyncPage {
    snapshot: string; direction: SyncDirection; start: number; nextStart?: number; commits: Commit[];
    state: 'ready' | 'unborn' | 'detached' | 'no-upstream' | 'gone' | 'invalid';
    relation?: 'equal' | 'ahead' | 'behind' | 'diverged' | 'unrelated' | 'unknown';
    branch: string; head: string; upstreamRef: string; upstreamHead: string; remote?: string;
    ahead?: number; behind?: number; shallow: boolean; capturedAt: string; fetchedAt?: string; notice: string;
}
export interface CompareQuery { base: string; target: string; mode: 'direct' | 'merge-base'; }
export interface Comparison { base: string; target: string; baseLabel: string; targetLabel: string; effectiveBase: string; mode: CompareQuery['mode']; files: ChangedFile[]; leftOnly: number; rightOnly: number; shallow: boolean; }
export type Action = 'forkResetPreferred' | 'forkSmartGit' | 'forkResetDev' | 'merge' | 'commitSelected' | 'beginMerge' | 'abortMerge' | 'discardLines' | 'discardFiles' | 'restoreFiles' | 'restoreStashFiles' | 'stage' | 'unstage' | 'stageLines' | 'unstageLines' | 'resolveConflict' | 'commit' | 'amendCommit' | 'finishMerge' | 'addRemote' | 'setRemoteUrl' | 'setRemotePushUrl' | 'resetRemotePushUrl' | 'fetch' | 'fetchAll' | 'updateAll' | 'push' | 'pull' | 'switch' | 'createBranch' | 'createBranchAt' | 'renameBranch' | 'deleteBranch' | 'setUpstream' | 'unsetUpstream' | 'checkoutRemote' | 'createTag' | 'deleteTag' | 'stashPush' | 'stashSelected' | 'stashApply' | 'stashDrop' | 'syncSubmodules' | 'lfsFetch';
export interface OperationRequest {
    repo: string;
    version: string;
    action: Action;
    paths?: string[];
    includePointers?: boolean;
    message?: string;
    branch?: string;
    newBranch?: string;
    remote?: string;
    revision?: string;
    remoteBranch?: string;
    upstreamRevision?: string;
    tag?: string;
    tagKind?: 'lightweight' | 'annotated';
    tagObject?: string;
    mergeVersion?: string;
    remoteVersion?: string;
    url?: string;
    stashRef?: string;
    stashPart?: ChangedFile['stashPart'];
    includeUntracked?: boolean;
    restoreIndex?: boolean;
    lines?: { path: string; version: string; ids: string[] };
    resolution?: { path: string; version: string; mode: 'content' | 'delete' };
}
export interface OperationMetrics { elapsedMs: number; gitCalls: number; gitMs: number; networkGitMs: number; }
export interface Plan {
    metrics?: OperationMetrics;
    token: string;
    title: string;
    description: string;
    paths: string[];
    warnings: string[];
    /** General guidance only; warnings remains the complete list for all clients. */
    generalWarnings?: string[];
    /** Optional structured presentation; description remains complete for older clients. */
    descriptionSummary?: string;
    repositories?: string[];
    /** Only updateAll may reuse an explicitly confirmed project/scope/rules key. */
    repeatConfirmationKey?: string;
    expiresAt: number;
    patch?: string;
    /** Panel hint only; the same one-time token and execution checks still apply. */
    directIndexAction?: 'stage' | 'unstage';
}
/** `phase` and `detail` are localized display text; `phaseId` and `codes` are the language-independent forms to compare. */
export interface RepositoryUpdate { id: string; status: 'queued' | 'running' | 'success' | 'failed' | 'skipped'; phase: string; phaseId?: UpdatePhase; detail: string; codes?: string[]; branch?: string; head?: string; }
export type UpdatePhase = 'waiting' | 'notRun' | 'stopped' | 'uninitialized' | 'fetchCheck' | 'notUpdated' | 'stashFastForward' | 'fastForward' | 'done' | 'unfinished' | 'waitingRun' | 'skipped' | 'running';
export interface Task {
    metrics?: OperationMetrics;
    recovery?: 'repreview';
    remoteOnly?: boolean;
    /** 'updateAll' for project-wide fast-forward updates, so callers need not compare the localized title. */
    kind?: 'updateAll';
    workspace?: { id: string; root: string; isolated: boolean };
    id: string;
    title: string;
    status: 'running' | 'success' | 'failed';
    log: string;
    startedAt: string;
    finishedAt?: string;
    repositories?: RepositoryUpdate[];
}
export interface Snapshot { project: string; root: string; repositories: Repository[]; task: Task | null; lastProjectUpdate?: Task; fetchedAt: Record<string, string>; }
export interface FileRevision { revision: string; path: string; }
export interface FileSnapshot extends FileRevision { object: string; mode: string; kind: TreeEntry['kind']; }
export interface FileComparisonInfo { version: string; left: FileSnapshot; right: FileSnapshot; }
export interface FileCompareQuery { left: FileRevision; right: FileRevision; view?: 'summary' | 'patch' | 'before' | 'after'; offset?: number; limit?: number; version?: string; force?: boolean; }
export interface FileComparePage {
    repo: string; comparison: FileComparisonInfo; summary: string; view: 'summary' | 'patch' | 'before' | 'after';
    before: { kind: 'text' | 'image' | 'notice'; characters: number; lfs: boolean; notice?: string };
    after: { kind: 'text' | 'image' | 'notice'; characters: number; lfs: boolean; notice?: string };
    patchAvailable: boolean; patchNotice?: string; text: string; offset: number; limit: number; total: number; nextOffset?: number; cachedUpToMs: number;
}
export class FileComparisonStateChangedError extends Error {}
export class StashStateChangedError extends Error {}
export interface WorktreeSnapshot { path: string; kind: 'file' | 'missing'; hash: string; mode: number; size: number; }
export interface WorktreeComparisonInfo { version: string; left: FileSnapshot; right: WorktreeSnapshot; diskOnly: true; normalization: 'raw'; }
export interface WorktreeCompareQuery { left: FileRevision; path: string; view?: FileCompareQuery['view']; offset?: number; limit?: number; version?: string; }
export interface WorktreeComparePage extends Omit<FileComparePage, 'comparison'> { comparison: WorktreeComparisonInfo; }
export interface IndexSnapshot { path: string; kind: 'file' | 'missing'; object?: string; mode: string; stage: 0; entryVersion: string; size: number; }
export interface IndexComparisonInfo { version: string; left: FileSnapshot; right: IndexSnapshot; indexOnly: true; normalization: 'raw'; }
export type IndexCompareQuery = WorktreeCompareQuery;
export interface IndexComparePage extends Omit<FileComparePage, 'comparison'> { comparison: IndexComparisonInfo; }
export interface DiffRequest { repo: string; path: string; area: 'worktree' | 'index' | 'commit' | 'stash' | 'compare' | 'conflict' | 'tree' | 'file-compare' | 'worktree-compare' | 'index-compare'; revision?: string; baseRevision?: string; stashPart?: ChangedFile['stashPart']; left?: FileRevision; right?: FileRevision; force?: boolean; }
export interface FileContent { exists?: boolean; text?: string; image?: string; notice?: string; lfs?: boolean; }
export interface PatchLine { id?: string; kind: ' ' | '+' | '-'; text: string; oldLine?: number; newLine?: number; noNewline?: boolean; }
export interface PatchHunk { header: string; oldStart: number; oldCount: number; newStart: number; newCount: number; lines: PatchLine[]; }
export interface PartialDiff { version: string; hunks: PatchHunk[]; }
export interface ConflictStage { stage: 1 | 2 | 3; mode: string; object: string; content: FileContent; }
export interface ConflictView { path: string; status: string; operation: string; version: string; stages: ConflictStage[]; working: FileContent; workingExists: boolean; resolution?: 'content' | 'delete'; blockedReason?: string; }
export interface FileDiff { path: string; before: FileContent; after: FileContent; patch: string; partial?: PartialDiff; partialReason?: string; summary?: string; conflict?: ConflictView; comparison?: FileComparisonInfo; worktreeComparison?: WorktreeComparisonInfo; indexComparison?: IndexComparisonInfo; patchNotice?: string; }
export interface Host {
    assertAvailable?(): void;
    checkEditor(worktreeChange?: boolean): Promise<void>;
    beforeWorktreeChange(): Promise<void>;
    afterWorktreeChange(): Promise<void>;
}
export type Reply<T> = { ok: true; data: T } | { ok: false; error: string; code?: 'EDITOR_PREPARATION_REQUIRED'; worktreeChange?: boolean };

export class FileStateChangedError extends Error {}

export interface RemoteCheckResult { state: 'busy' | 'unchanged' | 'changed'; checkedAt?: string; task?: Task; }
