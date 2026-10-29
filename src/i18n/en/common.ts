import { register } from '../registry';
// Domain: common. English texts; every key in ../zh/common.ts must exist here.
register('en', {
    'common.reflogHead': 'HEAD · this worktree',
    'common.reflogCurrentBranch': 'Current branch · {name}',
    'common.reflogLocalBranch': 'Local · {name}',
    'common.reflogRemoteBranch': 'Remote-tracking (local) · {name}',
    'common.repoStateUnavailable': 'Repository state is unavailable; refresh and try again.',
    'common.fullShaRequired': 'Choose a full commit SHA that has already been read.',
    'common.autoFetchFileInvalid': 'The auto-fetch settings file is invalid.',
    'common.autoFetchCorrupted': 'The auto-fetch settings are corrupted.',
    'common.prefabNotJson': 'Not valid JSON',
    'common.prefabNotSerialized': 'Not a Creator serialized array (.prefab/.scene)',
    'common.prefabDeepObject': '[deep object]',
    'common.prefabDiffSummary': 'Nodes +{added} −{removed}, moved {moved}, renamed {renamed}; components +{componentsAdded} −{componentsRemoved}; property changes {properties}{more}; asset reference changes {assets}',
});
