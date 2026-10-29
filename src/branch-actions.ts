import type { OperationRequest, Repository } from './types';
import { MessageError } from './i18n';

export type HeadState = 'unavailable' | 'unborn' | 'attached' | 'detached';

/** Classify a snapshot without querying Git or mistaking a failed read for an empty repository. */
export function headState(repo: Repository): HeadState {
    if (!repo.initialized || repo.error) return 'unavailable';
    if (!repo.head) return 'unborn';
    return repo.branch ? 'attached' : 'detached';
}

/** Ref-only writes must never inherit a file selection, commit message or remote from the panel. */
export function branchAtRequest(repo: Repository, revision: string, branch: string): OperationRequest {
    if (headState(repo) === 'unavailable') throw new MessageError('common.repoStateUnavailable');
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision)) throw new MessageError('common.fullShaRequired');
    return { repo: repo.id, version: repo.version, action: 'createBranchAt', branch: branch.trim(), revision };
}
