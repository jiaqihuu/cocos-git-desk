import { RepoDetails } from './types';
import { t } from './i18n';

/** Build a bounded selector from already loaded metadata; never read every log. */
export function reflogSources(details: Pick<RepoDetails, 'repo' | 'branches' | 'remoteBranches'>, text: string): { options: { ref: string; label: string }[]; matched: number; truncated: boolean } {
    const needle = text.toLowerCase(), options = [{ ref: 'HEAD', label: t('common.reflogHead') }];
    let matched = 0;
    const add = (ref: string, label: string) => {
        if (!ref.toLowerCase().includes(needle) && !label.toLowerCase().includes(needle)) return;
        matched++;
        if (options.length < 201) options.push({ ref, label });
    };
    // Keep the current branch first even when the metadata order changes.
    const current = details.repo.branch;
    if (current) add('refs/heads/' + current, t('common.reflogCurrentBranch', { name: current }));
    for (const branch of details.branches) if (branch.name !== current) add('refs/heads/' + branch.name, t('common.reflogLocalBranch', { name: branch.name }));
    for (const branch of details.remoteBranches) add(branch.ref, t('common.reflogRemoteBranch', { name: branch.name }));
    return { options, matched, truncated: matched > 200 };
}
