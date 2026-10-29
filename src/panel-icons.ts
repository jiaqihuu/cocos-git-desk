import { t, has, language } from './i18n';
import { tooltipTitle, setTooltipTitle } from './panel-tooltips';
// Shared silhouettes keep the same action recognizable across toolbars and menus.
const shapes = {
    autoFetch: 'M3 10a8 8 0 0 1 13-6m-1-3 2 4-4 1M21 14a8 8 0 0 1-13 6m1 3-2-4 4-1M12 8v4l3 2',
    humanReview: 'M9 3h6v3H9zM9 5H5v16h14V5h-4M8 11l2 2 5-5M8 17h8',
    updateResults: 'M5 3h14v18H5zM8 7h8M8 11h3m-3 4h3m2 1 2 2 4-5',
    updateRunning: 'M5 3h14v6M5 3v18h5M8 7h7M8 11h2M12 17a5 5 0 1 0 10 0 5 5 0 1 0-10 0M17 14v3l2 1',
    updateFailed: 'M5 3h14v6M5 3v18h5M8 7h7M8 11h2m3 2 8 8m0-8-8 8',
    refresh: 'M20 11a8 8 0 1 0-2 6M20 4v7h-7',
    reset: 'M3 4h16l-6 8v8l-4-2v-6zM17 15l5 6m-5 0 5-6',
    fetch: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
    pull: 'M6 3h5a6 6 0 0 1 6 6v11m-5-5 5 5 5-5',
    push: 'M6 21h5a6 6 0 0 0 6-6V4m-5 5 5-5 5 5',
    update: 'm3 5 8 7-8 7zm10 0 8 7-8 7z',
    fetchAll: 'M7 3v13m-4-4 4 4 4-4M17 3v13m-4-4 4 4 4-4M3 21h18',
    lfs: 'M3 8l7-5 7 5-7 5zM3 8v10l7 4 4-2M10 13v9M19 9v9m-3-3 3 3 3-3',
    branch: 'M6 7v10M4 5a2 2 0 1 0 4 0 2 2 0 1 0-4 0M4 19a2 2 0 1 0 4 0 2 2 0 1 0-4 0M16 5a2 2 0 1 0 4 0 2 2 0 1 0-4 0M18 7c0 7-12 3-12 10',
    branchPlus: 'M6 7v10M4 5a2 2 0 1 0 4 0 2 2 0 1 0-4 0M4 19a2 2 0 1 0 4 0 2 2 0 1 0-4 0M6 15c0-4 6-3 6-7M17 3v8m-4-4h8',
    branchCheckout: 'M5 7v10M3 5a2 2 0 1 0 4 0 2 2 0 1 0-4 0M3 19a2 2 0 1 0 4 0 2 2 0 1 0-4 0M5 14c0-5 8-1 8-7M18 2v6m-3-3h6M13 19h8m-3-3 3 3-3 3',
    remoteCheckout: 'M3 7a7 4 0 1 0 14 0 7 4 0 1 0-14 0M3 7v8c0 3 5 5 9 4M13 15h9m-4-4 4 4-4 4',
    checkout: 'M5 3v8m-2 8a2 2 0 1 0 4 0 2 2 0 1 0-4 0M5 17v-2c0-5 13-1 13-7V3m-4 4 4-4 4 4',
    merge: 'M6 7v10M4 5a2 2 0 1 0 4 0 2 2 0 1 0-4 0M4 19a2 2 0 1 0 4 0 2 2 0 1 0-4 0M18 3v4c0 6-12 3-12 8m8-12 4 4 4-4',
    tag: 'M3 3h8l10 10-8 8L3 11zM7 7h.01',
    tagPlus: 'M3 4h7l8 8-7 8-8-9zM7 8h.01M18 2v6m-3-3h6',
    trash: 'M4 7h16M9 7V3h6v4M6 7l1 14h10l1-14M10 10v7m4-7v7',
    rename: 'm4 16 12-12 4 4L8 20H4zm9-9 4 4M4 23h16',
    compare: 'M9 3H3v18h6m6-18h6v18h-6M7 9h10m-3-3 3 3-3 3M17 15H7m3-3-3 3 3 3',
    base: 'M7 3H3v18h4M7 12h13m-4-4 4 4-4 4',
    target: 'M17 3h4v18h-4M3 12h13m-4-4 4 4-4 4',
    history: 'M4 10a8 8 0 1 1 2 8M4 4v6h6M12 7v5l3 2',
    changes: 'M7 3h8l4 4v14H5V3zm8 0v5h4M8 12h8m-8 4h5',
    patch: 'M7 3h8l4 4v14H5V3zm8 0v5h4M8 12h6m-3-3v6m-3 3h6',
    sides: 'M3 4h18v16H3zM12 4v16M6 8h3m6 0h3M6 12h3m6 0h3',
    blame: 'M9 4h12M9 10h12M9 16h12M3 4h.01M3 10h.01M3 16h.01M2 21h20',
    folder: 'M3 6h6l2 2h10v12H3z',
    tree: 'M4 3v16h5M4 8h5m0-3h12v6H9zm0 11h12v6H9z',
    file: 'M7 3h7l4 4v14H7zM14 3v5h5M10 12h5m-5 4h5',
    search: 'M16 10a6 6 0 1 1-12 0 6 6 0 1 1 12 0m-1 5 6 6',
    save: 'M4 3h13l4 4v14H3V3zM7 3v6h10V3M7 21v-8h10v8',
    stash: 'M3 4h18v5H3zm2 5v12h14V9M9 13h6',
    restore: 'M3 4h18v5H3zm2 5v12h14V9M12 18v-6m-3 3 3-3 3 3',
    stage: 'M4 4h16v16H4zM8 12h8m-4-4v8',
    unstage: 'M4 4h16v16H4zM8 12h8',
    commit: 'M2 12h5m10 0h5M7 12a5 5 0 1 0 10 0 5 5 0 1 0-10 0',
    resolved: 'M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6zM7 12l3 3 7-7',
    stop: 'M8 2h8l6 6v8l-6 6H8l-6-6V8zM8 8h8v8H8z',
    discard: 'M8 3h7l5 5v13H8m7-18v5h5M3 10v6h6m-6 0a6 6 0 0 1 11 3',
    restoreFile: 'M8 3h7l5 5v13H8m7-18v5h5M3 15h11m-4-4 4 4-4 4',
    outgoing: 'M3 5h9M3 11h6M3 17h9M18 20V5m-4 4 4-4 4 4',
    incoming: 'M3 5h9M3 11h6M3 17h9M18 3v15m-4-4 4 4 4-4',
    eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12m7 0a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
    remoteAdd: 'M2 7a8 4 0 1 0 16 0 8 4 0 1 0-16 0M2 7v9c0 3 7 5 11 3M18 13v8m-4-4h8',
    remoteFetch: 'M2 7a7 4 0 1 0 14 0 7 4 0 1 0-14 0M2 7v9c0 3 5 5 9 4M19 11v10m-3-3 3 3 3-3',
    remotePush: 'M2 7a7 4 0 1 0 14 0 7 4 0 1 0-14 0M2 7v9c0 3 5 5 9 4M19 21V11m-3 3 3-3 3 3',
    leftOpen: 'M3 4h18v16H3zM12 4v16M5 13V7h5M5 7l5 5',
    rightOpen: 'M3 4h18v16H3zM12 4v16M14 7h5v6m0-6-5 5',
    check: 'm4 12 5 5L20 6',
    cancel: 'm6 6 12 12M6 18 18 6',
    clear: 'm3 14 9-11 9 8-8 10H9zm4-5 10 8M13 21h8',
    select: 'M4 3h16v18H4zM7 8l2 2 4-4m-6 9 2 2 4-4m2-6h3m-3 7h3',
    deselect: 'M4 3h16v18H4zM8 12h8',
    more: 'M4 12h.01M12 12h.01M20 12h.01',
    down: 'm5 9 7 7 7-7',
    back: 'M20 12H4m6-6-6 6 6 6',
    load: 'M3 4h18M3 8h18M3 12h18M8 17l4 4 4-4',
    upstream: 'm9 15-3 3a3 3 0 0 1-4-4l4-4a3 3 0 0 1 4 0m4-1 3-3a3 3 0 0 1 4 4l-4 4a3 3 0 0 1-4 0M8 16l8-8',
    unlink: 'm3 3 18 18M9 15l-3 3a3 3 0 0 1-4-4l3-3m10-2 3-3a3 3 0 0 1 4 4l-3 3M10 14l4-4',
    sync: 'M4 8h16m-4-4 4 4-4 4M20 16H4m4-4-4 4 4 4',
    network: 'M12 8V4M5 16v-4h14v4M9 1h6v6H9zM2 16h6v6H2zm14 0h6v6h-6z',
    settings: 'M3 6h18M3 18h18M8 3v6m8 6v6',
    log: 'M4 4h16v16H4zM7 8h10M7 12h10M7 16h6',
    terminal: 'M3 4h18v16H3zM7 8l4 4-4 4m6 0h4',
    resetPreferred: 'm10 5-7 7 7 7zm11 0-7 7 7 7z',
    resetDev: 'M12 3 2 21h20zM12 9v5m0 3h.01',
    reflog: 'M3 4h14M3 9h7M3 14h4M12 16a5 5 0 1 0 10 0 5 5 0 1 0-10 0M17 13v3l2 1',
    open: 'M14 3h7v7M21 3l-11 11M11 5H3v16h16v-8',
    locate: 'M12 3v4m0 10v4M3 12h4m10 0h4M6 12a6 6 0 1 0 12 0 6 6 0 1 0-12 0',
    copy: 'M8 8h12v12H8zM16 8V4H4v12h4',
    disk: 'M5 3h14l3 18H2zm0 13h14M6 19h.01M10 19h.01',
    index: 'M6 3h15v15H6zM3 6v15h15M10 7h7m-7 4h7',
    amend: 'M4 12h7m-4-4 4 4-4 4M18 3v4m0 10v4M15 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
};
type Icon = keyof typeof shapes;
const actions: Record<string, Icon> = {
    'fork-smart-git': 'branchCheckout', 'fork-reset-preferred': 'resetPreferred', 'fork-reset-dev': 'resetDev',
    'scope-reviews-open': 'humanReview', 'update-all': 'update', 'project-update-open': 'updateResults', fetch: 'fetch', pull: 'pull', push: 'push', refresh: 'refresh', 'auto-fetch-toggle': 'autoFetch',
    switch: 'checkout', 'new-branch': 'branchCheckout', 'checkout-remote': 'remoteCheckout', 'manage-branches': 'branch',
    'merge-start-preview': 'merge', 'compare-tab': 'compare', 'sync-tab': 'sync', 'tags-tab': 'tag',
    'manage-reflog': 'reflog', 'manage-remotes': 'settings', 'fetch-all': 'fetchAll', sync: 'network', lfs: 'lfs',
    'secondary-page-back': 'back', 'working-tab': 'changes', 'history-tab': 'history',
    'remote-add-mode': 'remoteAdd', 'remote-add': 'remoteAdd', 'remote-set-fetch': 'remoteFetch', 'remote-set-push': 'remotePush', 'remote-reset-push': 'unlink',
    'head-preserve': 'branchPlus', 'reflog-create': 'branchPlus',
    'tag-view': 'eye', 'tag-delete': 'trash', 'tag-use-head': 'locate', 'tag-create': 'tagPlus',
    'sync-outgoing': 'outgoing', 'sync-incoming': 'incoming', 'sync-retry': 'refresh', 'sync-more': 'load',
    'set-upstream': 'upstream', 'unset-upstream': 'unlink', 'rename-branch': 'rename', 'delete-branch': 'trash',
    'working-filter-clear': 'reset', 'working-selection-clear': 'deselect', 'history-search-clear': 'reset',
    'history-base': 'base', 'history-target': 'target', 'history-new-branch': 'branchCheckout',
    'history-preserve-branch': 'branchPlus', 'history-new-tag': 'tagPlus', 'history-tree': 'tree', 'more-history': 'load',
    'compare-run': 'compare', 'stash-save': 'stash', 'stash-apply': 'restore', 'stash-drop': 'trash', 'stash-restore-file': 'restoreFile',
    'merge-abort-preview': 'stop', 'merge-preview': 'merge', amend: 'amend',
    'draft-save': 'save', 'draft-reload': 'refresh', 'draft-clear': 'clear', 'draft-cancel': 'cancel', commit: 'commit',
    'commit-start-merge': 'merge', 'commit-preserve-branch': 'branchPlus', 'commit-actions-toggle': 'more',
    'patch-tab': 'patch', 'sides-tab': 'sides', 'blame-run': 'blame', 'blame-more': 'load',
    'conflict-resolve': 'resolved', 'line-action': 'stage', 'lines-all': 'select', 'lines-clear': 'deselect', 'line-discard': 'discard',
    'file-compare-show': 'compare', 'file-compare-clear': 'deselect', 'file-compare-worktree': 'disk', 'file-compare-index': 'index',
    'file-compare-open-left': 'leftOpen', 'file-compare-open-right': 'rightOpen', 'compact-commit-toggle': 'commit', 'toggle-log': 'log',
    'file-menu-submodule': 'network', stage: 'stage', unstage: 'unstage', 'discard-files': 'discard', 'stash-selected': 'stash',
    'file-menu-restore': 'restoreFile', 'file-menu-open': 'open', 'file-menu-reveal': 'locate', 'file-history': 'history', 'file-menu-copy': 'copy',
    'file-menu-worktree-compare': 'disk', 'file-menu-index-compare': 'index', 'file-menu-left': 'base', 'file-menu-right': 'target',
    'plan-amend-edit': 'rename', cancel: 'cancel', confirm: 'check', 'amend-cancel': 'cancel', 'amend-preview': 'amend',
};
const summaries: Record<string, [Icon, string]> = {
    '#more-menu > summary': ['more', 'panel.icons.summary.more'],
    '#merge-start-tools > summary': ['merge', 'panel.icons.summary.mergeStart'],
    '#history-selection-options > summary': ['more', 'panel.icons.summary.historySelection'],
    '#blame-controls > summary': ['blame', 'panel.icons.summary.blame'],
    '#file-menu-comparison > summary': ['compare', 'panel.icons.summary.fileComparison'],
    '.repo-details > summary': ['settings', 'panel.icons.summary.repoDetails'],
    '.tag-create > summary': ['tagPlus', 'panel.icons.summary.tagCreate'],
};
const destructive = new Set(['fork-reset-preferred', 'fork-reset-dev', 'tag-delete', 'delete-branch', 'stash-drop', 'discard-files', 'line-discard', 'merge-abort-preview']);
// Element ids with a fixed tooltip: `panel.icons.<id>.name` (optional, falls back to the label) and `panel.icons.<id>.note`.
const hinted = new Set([
    'fork-smart-git', 'fork-reset-preferred', 'fork-reset-dev', 'update-all', 'fetch', 'pull',
    'push', 'refresh', 'scope-reviews-open', 'project-update-open', 'auto-fetch-toggle', 'fetch-all',
    'sync', 'lfs', 'switch', 'new-branch', 'checkout-remote', 'manage-branches',
    'compare-tab', 'sync-tab', 'tags-tab', 'manage-reflog', 'manage-remotes', 'secondary-page-back',
    'working-tab', 'history-tab', 'remote-add-mode', 'remote-add', 'remote-set-fetch', 'remote-set-push',
    'remote-reset-push', 'head-preserve', 'reflog-create', 'tag-view', 'tag-use-head', 'tag-create',
    'tag-delete', 'sync-outgoing', 'sync-incoming', 'sync-retry', 'sync-more', 'set-upstream',
    'unset-upstream', 'rename-branch', 'delete-branch', 'working-filter-clear', 'history-search-clear', 'working-selection-clear',
    'stage', 'unstage', 'commit', 'line-action', 'history-base', 'history-target',
    'history-new-branch', 'history-preserve-branch', 'history-new-tag', 'more-history', 'compare-run', 'stash-save',
    'stash-selected', 'stash-apply', 'stash-drop', 'stash-restore-file', 'merge-start-preview', 'merge-abort-preview',
    'merge-preview', 'amend', 'amend-preview', 'plan-amend-edit', 'draft-save', 'draft-reload',
    'draft-clear', 'draft-cancel', 'commit-start-merge', 'commit-preserve-branch', 'commit-actions-toggle', 'patch-tab',
    'sides-tab', 'blame-run', 'blame-more', 'lines-all', 'lines-clear', 'line-discard',
    'discard-files', 'file-compare-show', 'file-compare-clear', 'file-compare-worktree', 'file-compare-index', 'file-compare-open-left',
    'file-compare-open-right', 'file-menu-submodule', 'file-menu-restore', 'file-menu-open', 'file-menu-reveal', 'file-history',
    'file-menu-copy', 'file-menu-worktree-compare', 'file-menu-index-compare', 'file-menu-left', 'file-menu-right', 'toggle-log',
]);
function hintFor(id: string): [string, string] | undefined {
    if (!hinted.has(id)) return undefined;
    const name = 'panel.icons.' + id + '.name';
    return [has(name) ? t(name) : '', t('panel.icons.' + id + '.note')];
}
const tooltipState = new WeakMap<HTMLElement, { detail: string; rendered: string; contextual: boolean }>();
// Chinese tooltips use full-width parentheses; other languages keep ASCII ones.
const normalize = (text: string): string => {
    const plain = text.trim().replace(/(?:…|\.{3})+$/u, '').replace(/[。；;]+$/u, '').replace(/\s+/gu, ' ');
    return language() === 'zh' ? plain.replace(/\(/gu, '（').replace(/\)/gu, '）').replace(/\s+（/gu, '（') : plain;
};
const loadingLabels = (): string[] => [t('panel.loadingMore'), t('panel.loadingShort')];
const confirmLabels = (): string[] => [t('panel.draft.confirmClearButton'), t('panel.draft.confirmReloadButton')];

function decorate(element: HTMLElement, icon: Icon, fallback?: string): void {
    const label = fallback || element.textContent?.trim() || element.getAttribute('aria-label') || '';
    const previous = tooltipState.get(element);
    const changed = !!previous && tooltipTitle(element) !== previous.rendered;
    const detail = previous && !changed ? previous.detail : tooltipTitle(element);
    const contextual = changed ? !!detail : previous?.contextual || false;
    const hint = hintFor(element.id);
    let name = normalize(hint?.[0] || label);
    if (element.id === 'commit-actions-toggle' && element.getAttribute('aria-expanded') === 'true') name = t('panel.icons.collapseCommitActions');
    if (element.id === 'refresh' && element.getAttribute('aria-busy') === 'true') name = t('panel.icons.refreshing');
    if (element.id === 'auto-fetch-toggle') name = element.getAttribute('aria-pressed') === 'true' ? t('panel.icons.autoFetchOn') : t('panel.icons.autoFetchOff');
    if (element.id === 'project-update-open') name = element.dataset.state === 'running' ? t('panel.icons.projectUpdating')
        : element.getAttribute('aria-expanded') === 'true' ? t('panel.icons.closeUpdateResults') : t('panel.html.project-update-open');
    if (element.id === 'conflict-resolve') name = label === t('panel.conflict.previewDeleted') ? t('panel.icons.markConflictDeleted') : t('panel.icons.markConflictResolved');
    if (hint?.[0] && loadingLabels().some(text => label.includes(text))) name += t('panel.icons.loadingSuffix');
    if (element.id === 'sync-outgoing' || element.id === 'sync-incoming') name += t('panel.icons.count', { count: normalize(label.split('·')[1] || t('panel.unavailable')) });
    let note = normalize(contextual ? detail : hint ? hint[1] : detail);
    if (element.id === 'project-update-open' && detail) note = detail.split('\n').map(normalize).filter(Boolean).join('\n');
    // While a draft button waits for its second click, its note drops the "asks again" part.
    if ((element.id === 'draft-clear' || element.id === 'draft-reload') && !contextual && confirmLabels().includes(label)) note = normalize(t('panel.icons.' + element.id + '.confirming'));
    if (note === name) note = '';
    else if (note.startsWith(name)) note = note.slice(name.length).replace(/^[：:，, ·]+/u, '');
    if (element.hasAttribute('data-write')) note = [note, t('panel.icons.previewThenConfirm')].filter(Boolean).join(t('panel.icons.separator'));
    const title = [name, note].filter(Boolean).join('\n');
    tooltipState.set(element, { detail, rendered: title, contextual });
    if (tooltipTitle(element) !== title) setTooltipTitle(element, title);
    if (element.getAttribute('aria-label') !== title) element.setAttribute('aria-label', title);
    if (!element.classList.contains('action-icon')) element.classList.add('action-icon');
    if (element.dataset.actionIcon === icon && element.querySelector('.action-label')?.textContent === label) return;
    const svg = element.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'gd-icon'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const path = element.ownerDocument.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', shapes[icon]); svg.append(path);
    const text = element.ownerDocument.createElement('span');
    text.className = element.id === 'working-tab' || element.id === 'history-tab' ? 'action-label' : 'action-label visually-hidden'; text.textContent = label;
    element.replaceChildren(svg, text);
    element.dataset.actionIcon = icon;
}

export function setActionHint(element: HTMLElement, detail: string): void {
    const previous = tooltipState.get(element);
    if (!previous || previous.detail !== detail || previous.contextual !== !!detail || tooltipTitle(element) !== previous.rendered) {
        tooltipState.set(element, { detail, rendered: tooltipTitle(element), contextual: !!detail });
    }
}

export function setActionLabel(element: HTMLElement, label: string): void {
    const text = element.dataset.actionIcon ? element.querySelector<HTMLElement>('.action-label') : undefined;
    if (text) { if (text.textContent !== label) text.textContent = label; }
    else if (element.textContent !== label) element.textContent = label;
}

export { decorate as decorateAction };

export function renderActionIcons(app: HTMLElement, elements?: Map<string, HTMLElement>): void {
    for (const [id, shape] of Object.entries(actions)) {
        let element = elements?.get(id);
        if (!element?.isConnected || !app.contains(element)) {
            element = app.querySelector<HTMLElement>('#' + id) || undefined;
            if (element) elements?.set(id, element);
        }
        if (!element) continue;
        const label = element.textContent || '';
        const icon = id === 'project-update-open' && element.dataset.state === 'running' ? 'updateRunning'
            : id === 'project-update-open' && element.dataset.state === 'failed' ? 'updateFailed'
            : id === 'line-action' && label === t('panel.lines.unstage') ? 'unstage'
            : id === 'history-tree' && label === t('panel.tree.backToChanges') ? 'back'
            : id === 'compact-commit-toggle' && label === t('panel.commit.handleMerge') ? 'merge'
            : (id === 'draft-clear' || id === 'draft-reload') && confirmLabels().includes(label) ? 'check' : shape;
        decorate(element, icon);
        element.classList.toggle('action-danger', destructive.has(id));
    }
    for (const [selector, [icon, label]] of Object.entries(summaries)) {
        const element = app.querySelector<HTMLElement>(selector);
        if (element) decorate(element, icon, t(label));
    }
    for (const element of app.querySelectorAll<HTMLElement>('button:not(.action-icon)')) {
        if (!element.querySelector('svg') || !tooltipTitle(element)) continue;
        const [name, ...notes] = tooltipTitle(element).split(/[\n，]/u).map(normalize).filter(Boolean);
        const title = [name, notes.join(t('panel.icons.separator'))].filter(Boolean).join('\n');
        if (tooltipTitle(element) !== title) setTooltipTitle(element, title);
        if (element.getAttribute('aria-label') !== title) element.setAttribute('aria-label', title);
    }
}
