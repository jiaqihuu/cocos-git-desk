import { FileContent, FileDiff, RepositoryUpdate } from './types';
import { t } from './i18n';

export function emptyDiffSide(content: FileContent): boolean {
    return content.exists === false || (!content.text && !content.image && !content.notice);
}
export function sameDisplayedDiff(a: FileDiff | undefined, b: FileDiff): boolean {
    const sameContent = (x: FileContent, y: FileContent) => x.exists === y.exists && x.text === y.text && x.image === y.image && x.notice === y.notice && x.lfs === y.lfs;
    return !!a && sameContent(a.before, b.before) && sameContent(a.after, b.after) && a.patch === b.patch && a.patchNotice === b.patchNotice && a.summary === b.summary && a.partial?.version === b.partial?.version && a.partialReason === b.partialReason && a.conflict?.version === b.conflict?.version;
}
export type HelpAction = 'working' | 'sync' | 'stash' | 'branches' | 'remotes' | 'repreview';
// Guidance kinds in priority order; the first kind that applies wins.
const KINDS = ['stash', 'sync', 'conflict', 'lock', 'disk', 'localWrite', 'auth', 'network', 'stale', 'changed', 'branches', 'extension'] as const;
type Kind = typeof KINDS[number] | 'unknown';
const ACTIONS: Record<Kind, HelpAction> = { stash: 'stash', sync: 'sync', conflict: 'working', lock: 'working', disk: 'working', localWrite: 'working', auth: 'remotes', network: 'remotes', stale: 'repreview', changed: 'working', branches: 'branches', extension: 'working', unknown: 'working' };
// Error codes sent by the update scripts. Codes whose details carry raw Git output are classified from
// the text first (Git runs with LC_ALL=C, so its English output matches below) and fall back to the kind here.
const CODE_KINDS: Record<string, Kind> = {
    stashConflict: 'stash', stashRetained: 'stash', stashNotDropped: 'stash',
    diverged: 'sync',
    unmergedIndex: 'conflict', operationInProgress: 'conflict', submodulePointerConflict: 'conflict', stashFailed: 'conflict',
    stateChanged: 'stale', scopeChanged: 'stale',
    headChanged: 'changed', worktreeChanged: 'changed', indexChanged: 'changed', fileChanged: 'changed', gitmodulesChanged: 'changed',
    noBranches: 'branches', ambiguousLatest: 'branches', invalidUpstream: 'branches', upstreamIncomplete: 'branches', ambiguousUpstream: 'branches',
    upstreamUnavailable: 'branches', remoteBranchMissing: 'branches', detachedUnreferenced: 'branches', stillDetached: 'branches',
    branchMismatch: 'unknown', localRefMissing: 'unknown', branchInOtherWorktree: 'unknown', badUpstream: 'unknown', fileGrew: 'unknown',
    invalidRepoPath: 'unknown', submoduleInvalid: 'unknown', tooManyRepos: 'unknown', rootMismatch: 'unknown', submoduleElsewhere: 'unknown', submoduleOutside: 'unknown',
    badAssignment: 'unknown', duplicateAssignment: 'unknown', unknownPaths: 'unknown', outputLimit: 'unknown', outputTooLarge: 'unknown', pathThroughSymlink: 'unknown', changesTooLarge: 'unknown',
};
const RAW_CODES: Record<string, Kind> = { gitFailed: 'unknown', ancestryFailed: 'unknown', remoteQueryFailed: 'auth', refreshFailed: 'auth', fetchFailed: 'auth', submoduleUninitialized: 'unknown', previewUnreadable: 'unknown' };
// Raw Git output (English) and texts of rows that carry no codes, such as results saved by older versions.
function textKind(text: string): Kind | undefined {
    if (/(?:恢复|还原|应用|保留).{0,24}(?:stash|冲突)|stash.{0,24}(?:冲突|conflict|apply|pop|恢复|还原)|(?:apply|pop).{0,12}stash|暂存.*恢复/i.test(text)) return 'stash';
    if (/分叉|不能快进|无法快进|non.fast.forward|diverg|not possible to fast.forward/i.test(text)) return 'sync';
    if (/conflict|unmerged|冲突|MERGE_HEAD|rebase|cherry.pick/i.test(text)) return 'conflict';
    if (/index\.lock|config\.lock|packed-refs\.lock|cannot lock ref|another git process|存在.*锁|锁文件/i.test(text)) return 'lock';
    if (/no space left|disk full|磁盘.*满|空间不足/i.test(text)) return 'disk';
    if (/(?:(?:unable|failed) to|cannot|could not) (?:create|open|write|unlink)|unable to unlink|insufficient permission.*(?:object|database)|read.only file system/i.test(text)) return 'localWrite';
    if (/publickey|permission denied|authentication|could not read username|repository not found|access denied|认证|权限/i.test(text)) return 'auth';
    if (/timed? out|resolve host(?:name)?|unable to access|connection (?:refused|reset|closed)|failed to connect|network is unreachable|remote end hung up|ssl certificate|网络|连接失败/i.test(text)) return 'network';
    if (/预览后.*变化|编辑器准备期间.*变化|等待期间.*变化|获取期间.*变化|预览后项目仓库范围变化/i.test(text)) return 'stale';
    if (/变化|changed|overwritten|local changes|覆盖|本地改动/i.test(text)) return 'changed';
    if (/上游|远端分支|游离|多个.*分支/i.test(text)) return 'branches';
    if (/LFS|filter|hook|钩子|过滤器/i.test(text)) return 'extension';
    return undefined;
}
function first(kinds: Kind[]): Kind | undefined {
    for (const kind of KINDS) if (kinds.includes(kind)) return kind;
    return kinds.includes('unknown') ? 'unknown' : undefined;
}
export function updateFailureHelp(row: RepositoryUpdate): { title: string; steps: string; action: HelpAction } {
    const text = row.phase + '\n' + row.detail, codes = row.codes ?? [];
    let kind: Kind | undefined;
    if (codes.length && codes.every(code => code in CODE_KINDS)) kind = first(codes.map(code => CODE_KINDS[code] as Kind));
    else if (codes.length && codes.every(code => code in CODE_KINDS || code in RAW_CODES)) kind = first([...codes.filter(code => code in CODE_KINDS).map(code => CODE_KINDS[code] as Kind), ...[textKind(text)].filter((value): value is Kind => !!value)])
        ?? first(codes.map(code => RAW_CODES[code] as Kind).filter(Boolean));
    else kind = textKind(text);
    kind ??= 'unknown';
    return { title: t('misc.help.' + kind + 'Title'), steps: t('misc.help.' + kind + 'Steps'), action: ACTIONS[kind] };
}
