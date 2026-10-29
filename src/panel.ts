import { BrowserDebugFeedback } from './browser-debug-feedback';
import { t } from './i18n';
import { localizeElement } from './panel-i18n';
import { LatestRead } from './latest-read';
import { PanelTooltips, tooltipTitle, setTooltipTitle } from './panel-tooltips';
import { ReflogEntry, ReflogPage } from './types';
import { reflogSources } from './reflog';
import { FileRevision } from './types';
import { RemotePage, RemoteEntry } from './types';
import type { ScopeApproval } from './scope-reviews';
import type { RemoteCheckResult } from './types';
import { AutoFetchSchedule } from './remote-refresh';
import fs from 'fs';
import path from 'path';
import { Action, Branch, ChangedFile, Commit, CommitDetails, CommitDraft, CompareQuery, Comparison, ConflictView, DiffRequest, FileBlame, FileContent, FileDiff, HistoryPage, HistoryQuery, OperationRequest, Plan, Reply, RepoDetails, Snapshot, Stash, SyncDirection, SyncPage, SyncQuery, Task } from './types';
import { layoutGraph } from './graph';
import { HISTORY_VIRTUAL_THRESHOLD, HistoryViewport } from './history-viewport';
import { PanelLayout } from './panel-layout';
import { PanelCopy } from './panel-copy';
import { DIFF_VIRTUAL_THRESHOLD, DiffViewport, DiffViewportRow } from './diff-viewport';
import type { PatchLine } from './types';
import { renderActionIcons, decorateAction, setActionLabel, setActionHint } from './panel-icons';
import { SelectedFileObserver } from './file-observer';
import { emptyDiffSide, sameDisplayedDiff, updateFailureHelp, HelpAction } from './update-help';
import type { RepositoryUpdate } from './types';
import { canRepeatUpdate, groupPlanWarnings, WarningPreferences } from './panel-warnings';
import { updateResultTime, updateResultForDisplay, updateResultCounts } from './update-results';
import { forkToolNames, ForkToolAction } from './fork-tools';
import { contextSelection } from './worklist';
import { branchAtRequest, headState } from './branch-actions';
import { TagEntry, TagPage } from './types';
import { TreePage, MergeState } from './types';
import type { EditorFileResult } from './editor-files';
import { canApplyIndexPlan, filterWorkingRows, reconcileSelection, selectedPaths, selectedWholeFiles, selectVisible, WorkingFilter, WorkingRow, workingRows } from './worklist';

const PACKAGE = 'cocos-git-desk';
const FILE_PAGE_SIZE = 200;
const SESSION_DRAFT_LIMIT = 32;
export const template = fs.readFileSync(path.resolve(__dirname, '../static/panel.html'), 'utf8');
export const style = fs.readFileSync(path.resolve(__dirname, '../static/panel.css'), 'utf8');
export const $ = { app: '#app' };


interface ScopeDiffRow extends DiffViewportRow { kind: 'add' | 'delete' | 'context' | 'hunk' | 'meta'; oldLine?: number; newLine?: number; }
export function scopeDiffRows(text: string): ScopeDiffRow[] {
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const patch = /^diff --git /m.test(text) && /^@@ -\d/m.test(text);
    let oldLine = 0, newLine = 0, oldRemaining = 0, newRemaining = 0;
    return lines.flatMap((line): ScopeDiffRow[] => {
        const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (hunk) {
            oldLine = Number(hunk[1]); newLine = Number(hunk[3]);
            oldRemaining = Number(hunk[2] ?? 1); newRemaining = Number(hunk[4] ?? 1);
            return [{ kind: 'hunk', text: line, height: 30 }];
        }
        if (oldRemaining > 0 || newRemaining > 0) {
            const prefix = line[0], kind = prefix === '+' ? 'add' : prefix === '-' ? 'delete' : prefix === ' ' ? 'context' : undefined;
            if (kind) {
                const before = kind !== 'add' && oldRemaining > 0 ? oldLine++ : undefined;
                const after = kind !== 'delete' && newRemaining > 0 ? newLine++ : undefined;
                if (before !== undefined) oldRemaining--;
                if (after !== undefined) newRemaining--;
                return [{ kind, text: line, code: line.slice(1), oldLine: before, newLine: after, height: 22 }];
            }
        }
        if (patch && /^(diff --git |index |--- |\+\+\+ )/.test(line)) return [];
        return [{ kind: 'meta', text: line, height: 22 }];
    });
}

export function scopeDiffSections(item: ScopeApproval): { path: string; area: string; text: string }[] {
    const valid = item.sections?.length && item.sections.every(section => Number.isInteger(section.file) && section.file >= 0 && section.file < item.paths.length
        && ['index', 'worktree', 'notice'].includes(section.area) && Number.isInteger(section.start) && Number.isInteger(section.length)
        && section.start >= 0 && section.length >= 0 && section.start + section.length <= item.patch.length);
    return valid ? item.sections!.map(section => ({ path: item.paths[section.file]!, area: section.area, text: item.patch.slice(section.start, section.start + section.length) }))
        : [{ path: t('panel.scopeReview.legacyPatch'), area: 'notice', text: item.patch }];
}

class EditorPreparationRequestError extends Error {
    constructor(message: string, readonly worktreeChange: boolean) { super(message); }
}

async function request<T>(method: string, ...args: unknown[]): Promise<T> {
    const response = await Editor.Message.request<Reply<T>>(PACKAGE, method, ...args);
    if (!response || !response.ok) {
        if (response && response.code === 'EDITOR_PREPARATION_REQUIRED' && typeof response.worktreeChange === 'boolean') throw new EditorPreparationRequestError(response.error, response.worktreeChange);
        throw new Error(response && 'error' in response ? response.error : t('panel.noValidResult'));
    }
    return response.data;
}

interface DraftState {
    message: string; savedMessage: string; version?: string; loaded: boolean;
    loading: boolean; saving: boolean; queued: boolean; edit: number; error: string;
    confirm?: 'reload' | 'clear'; timer?: ReturnType<typeof setTimeout>;
}

type Disableable = HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
function setControlValue<T extends HTMLElement, K extends keyof T>(element: T, key: K, value: T[K]): void {
    if (key === 'title' && typeof value === 'string') { setTooltipTitle(element, value); return; }
    if (element[key] !== value) element[key] = value;
}
function setControlAttribute(element: HTMLElement, name: string, value: string): void {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

class Controller {
    private listenerScope = new AbortController();
    private controlElements?: Map<string, HTMLElement>;
    private pendingDisabled?: Map<Disableable, boolean>;
    private setDisabled(element: Disableable, value: boolean): void {
        if (this.pendingDisabled) this.pendingDisabled.set(element, value);
        else if (element.disabled !== value) element.disabled = value;
    }
    private getDisabled(element: Disableable): boolean { return this.pendingDisabled?.get(element) ?? element.disabled; }

    private readonly remoteFetch = new AutoFetchSchedule();
    private remoteChecking = false;
    private remoteWakePending = false;
    private readonly remoteCheckTimes = new Map<string, string>();
    private remoteFetchPending?: { id: string; repo: string; automatic: boolean };
    private layout?: PanelLayout;
    private copyMenu?: PanelCopy;
    private tooltips?: PanelTooltips;
    private snapshot?: Snapshot;
    private details?: RepoDetails;
    private repoId = '.';
    private mode: 'working' | 'history' | 'stash' | 'compare' | 'branches' | 'sync' | 'tags' = 'working';
    private tagPage?: TagPage;
    private selectedTag?: TagEntry;
    private tagTarget?: { repo: string; sha: string };
    private tagLoading = false;
    private tagEpoch = 0;
    private tagError = '';
    private tagTimer?: ReturnType<typeof setTimeout>;
    private treeActive = false;
    private treePage?: TreePage;
    private treeDirectory = '';
    private treeLoading = false;
    private treeError = '';
    private treeEpoch = 0;
    private treeTimer?: ReturnType<typeof setTimeout>;
    private mergeView?: MergeState;
    private mergeLoading = false;
    private mergeError = '';
    private mergeEpoch = 0;
    private mergeKey = '';
    private mergeDrafts = new Map<string, { message: string; original: string }>();
    private reflogPage?: ReflogPage;
    private reflogSelected?: ReflogEntry;
    private reflogLoading = false;
    private reflogEpoch = 0;
    private reflogError = '';
    private reflogTimer?: ReturnType<typeof setTimeout>;
    private remotePage?: RemotePage;
    private remoteSelection?: RemoteEntry;
    private remoteAdding = false;
    private remoteLoading = false;
    private remoteEpoch = 0;
    private remoteError = '';
    private managedBranch?: { name: string; sha: string };
    private commits: Commit[] = [];
    private historyQuery: HistoryQuery = { scope: 'all' };
    private historyFiltered = false;
    private historyViewport?: HistoryViewport;
    private historyError = '';
    private comparison?: Comparison;
    private compareLoading = false;
    private compareEpoch = 0;
    private compareError = '';
    private compareAttempt?: CompareQuery;
    private compareRepo = '';
    private historyCursor?: string;
    private historyLoading = false;
    private historyScrollArmed = false;
    private historyPagingTop = 0;
    private historyEpoch = 0;
    private historyShallow = false;
    private historyTipCount = 0;
    private syncPage?: SyncPage;
    private syncCommits: Commit[] = [];
    private syncDirection: SyncDirection = 'outgoing';
    private syncNextStart?: number;
    private syncLoading = false;
    private syncEpoch = 0;
    private syncError = '';
    private syncSnapshotChanged = false;
    private stashes: Stash[] = [];
    private stashRef = '';
    private stashFileSelection?: ChangedFile;
    private historyFiles: ChangedFile[] = [];
    private revision = '';
    private commitDetails?: CommitDetails;
    private inspectRevision = '';
    private inspectPath?: string;
    private inspectError = '';
    private inspectFileNote = '';
    private inspectLoading = false;
    private inspectEpoch = 0;
    private blame?: FileBlame;
    private blameQuery?: { revision: string; path: string; label: string };
    private blameActive = false;
    private blameLoading = false;
    private blameError = '';
    private blameEpoch = 0;
    private selected = new Set<string>();
    private workingFilter: WorkingFilter = { text: '', area: 'all', status: 'all', kind: 'all' };
    private selectionEpoch = 0;
    private filePage = 0;
    private fileTotal = 0;
    private filterPending = false;
    private filterTimer?: ReturnType<typeof setTimeout>;
    private workingCache?: { files?: ChangedFile[]; filter: string; rows: WorkingRow[]; visible: WorkingRow[] };
    private fileCompareLeft?: FileRevision;
    private fileCompareRight?: FileRevision;
    private fileMenuEpoch = 0;
    private navigationEpoch = 0;
    private fileMenuTarget?: { repo: string; file: string; historical: boolean; origin: HTMLElement; x: number; y: number; source?: FileRevision; workingKey?: string; selection: number; version?: string };
    private fileMenuResult?: EditorFileResult;
    private fileMenuBusy = false;
    private readonly menuOutside = (event: Event): void => {
        const blame = this.el<HTMLDetailsElement>('blame-controls');
        if (blame.open && !event.composedPath().includes(blame)) blame.open = false;
        if (!this.el('file-menu').hidden && !event.composedPath().includes(this.el('file-menu'))) this.closeFileMenu();
        for (const menu of this.app.querySelectorAll<HTMLDetailsElement>('.toolbar-menu[open]')) {
            if (!event.composedPath().includes(menu)) menu.open = false;
        }
    };
    private backdropStart?: HTMLElement;
    private readonly modalBackdrop = (event: MouseEvent): void => {
        if (event.type === 'pointercancel') { this.backdropStart = undefined; return; }
        const target = event.target instanceof HTMLElement && event.target.matches('.modal') ? event.target : undefined;
        if (event.type === 'pointerdown') { this.backdropStart = event.button === 0 ? target : undefined; return; }
        const start = this.backdropStart; this.backdropStart = undefined;
        if (start && start === target) { this.dismissModal(target.id); event.preventDefault(); }
    };

    private dismissModal(id: string): void {
        if (id === 'log-dialog') this.toggleLog(false);
        else if (id === 'project-update-progress') this.closeProjectUpdate();
        else if (id === 'scope-review-modal' && !this.planning) {
            ++this.scopeReviewEpoch; this.scopeReview = undefined; this.el(id).hidden = true; this.updateButtons(); this.el('scope-reviews-open').focus();
            void this.guard(() => this.showPendingScopeReview());
        } else if ((id === 'modal' || id === 'amend-modal') && !this.busy && !this.planning) this.cancelDialog();
    }

    private readonly menuKeys = (event: KeyboardEvent): void => {
        if (event.defaultPrevented) return;
        if (event.key === 'Tab') {
            const overlay = !this.el('log-dialog').hidden ? this.el('log-dialog') : !this.el('project-update-progress').hidden ? this.el('project-update-progress') : undefined;
            if (overlay) {
                const controls = [...overlay.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter(node => node.getClientRects().length);
                const root = this.app.getRootNode(), focused = root instanceof ShadowRoot ? root.activeElement : this.app.ownerDocument.activeElement;
                const index = controls.indexOf(focused as HTMLElement);
                if (controls.length && (index < 0 || (!event.shiftKey && index === controls.length - 1) || (event.shiftKey && index === 0))) {
                    controls[event.shiftKey ? controls.length - 1 : 0]!.focus(); event.preventDefault(); event.stopImmediatePropagation(); return;
                }
            }
        }
        if (event.key === 'Escape') {
            const consume = () => { event.preventDefault(); event.stopImmediatePropagation(); };
            const popup = this.app.querySelector<HTMLDetailsElement>('.toolbar-menu[open], #blame-controls[open], .repo-details[open], #history-selection-options[open], #commit-draft-tools[open]');
            if (popup) { popup.open = false; popup.querySelector('summary')?.focus(); consume(); return; }
            if (!this.el('file-menu').hidden) { this.fileMenuKey(event); consume(); return; }
            if (!this.el('log-dialog').hidden) { this.dismissModal('log-dialog'); consume(); return; }
            if (!this.el('project-update-progress').hidden) { this.dismissModal('project-update-progress'); consume(); return; }
            if (!this.el('scope-review-modal').hidden) {
                this.dismissModal('scope-review-modal');
                consume(); return;
            }
            if (!this.el('modal').hidden || !this.el('amend-modal').hidden) {
                this.dismissModal(!this.el('modal').hidden ? 'modal' : 'amend-modal'); consume(); return;
            }
        }
        this.fileMenuKey(event);
    };
    private readonly visibilityChanged = (): void => { this.updateVisibility(); };
    private readonly windowFocused = (): void => { this.queueDiskRefresh(); this.wakeRemoteCheck(); };
    private diskRefreshPending = false;
    private diskRefreshAll = false;
    private diskRefreshTimer?: ReturnType<typeof setTimeout>;
    private readonly diskObserver = new SelectedFileObserver(() => this.queueDiskRefresh(false));
    private readonly menuViewportChanged = (event: Event): void => {
        if (!event.composedPath().includes(this.el('file-menu'))) this.closeFileMenu();
    };
    private repoLoading = false;
    private repoLoadError = '';
    private currentFile?: DiffRequest;
    private currentDiff?: FileDiff;
    private diffLoading = false;
    private diffRenderPending = false;
    private selectedLines = new Set<string>();
    private diffReads = new LatestRead<FileDiff>();
    private diffViewport?: DiffViewport;
    private sideViewports: DiffViewport[] = [];
    private sideScrollKey = '';
    private sides = false;
    private readonly fileLfs = new Map<string, string>();
    private epoch = 0;
    private diffEpoch = 0;
    private busy = false;
    private refreshing = false;
    private closed = false;
    private browserDebugFeedback?: BrowserDebugFeedback;
    private timer?: ReturnType<typeof setTimeout>;
    private plan?: Plan;
    private readonly warningPreferences = new WarningPreferences();
    private projectToolAction?: ForkToolAction;
    private projectToolConfirmation = false;
    private pendingUpdate?: { token: string; key: string };
    private pendingWarnings?: { token: string; action: Action; warnings: string[] };
    private inputAction?: 'createBranchAt' | 'createBranch' | 'checkoutRemote' | 'stashPush' | 'stashSelected' | 'renameBranch' | 'setUpstream';
    private inputStash?: { paths: string[]; selection: number };
    private inputRevision?: string;
    private inputBranch?: { name: string; sha: string };
    private inputUpstream?: { ref: string; name: string; sha: string };
    private planning = false;
    private dialogEpoch = 0;
    private projectUpdateTask = '';
    private projectUpdateHidden = '';
    private projectUpdateResult?: Task;
    private projectUpdateCompleted = '';
    private projectUpdateRows = new Map<string, HTMLElement>();
    private taskId = '';
    private drafts = new Map<string, DraftState>();
    private amendDrafts = new Map<string, { message: string; original: string }>();
    private amendTarget?: { repo: string; revision: string };
    private amendLoading = false;
    private amendBlocked = '';
    private amendEpoch = 0;

    constructor(private app: HTMLElement) {
        localizeElement(this.app);
        this.bind();
        Editor.Message.addBroadcastListener('cocos-git-desk:scope-review-requested', this.scopeReviewRequested);
        // An installed 0.1 build can share these assets until the next explicit build.
        for (const element of this.app.querySelectorAll<HTMLElement>('[data-line-discard-feature], [data-stash-recovery-feature], [data-index-compare-feature], [data-worktree-compare-feature], [data-merge-workflow-feature], [data-branch-context-feature], [data-next-feature], [data-daily-feature], [data-branch-feature], [data-upstream-feature], [data-sync-feature], [data-commit-feature], [data-worklist-feature]')) element.hidden = false;
        for (const element of this.app.querySelectorAll<HTMLElement>('[data-tag-feature]')) element.hidden = false;
        for (const element of this.app.querySelectorAll<HTMLElement>('[data-tree-feature]')) element.hidden = false;
        this.el('stash-selected').hidden = false;
        this.el('discard-files').hidden = false;
        this.bindCoreLayout();
        this.layout = new PanelLayout(this.app, this.visibilityChanged);
        this.tooltips = new PanelTooltips(this.app);
        this.copyMenu = new PanelCopy(this.app);
        const version = this.app.querySelector<HTMLElement>('.version');
        if (version) version.textContent = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')).version;
        renderActionIcons(this.app);
        void this.refresh(true);
        this.schedule();
    }

    private el<T extends HTMLElement = HTMLElement>(id: string): T {
        const cached = this.controlElements?.get(id);
        if (cached?.isConnected && this.app.contains(cached)) return cached as T;
        const element = this.app.querySelector<T>('#' + id);
        if (!element) throw new Error(t('panel.missingElement', { id }));
        this.controlElements?.set(id, element);
        return element;
    }

    private bindCoreLayout(): void {
        this.on('history-options-toggle', () => {
            const tools = this.el<HTMLDetailsElement>('history-search-tools'); tools.open = !tools.open;
            this.renderCoreLayout();
            if (tools.open) this.el('history-search').focus();
        });
        this.el('history-search-tools').addEventListener('toggle', () => this.renderCoreLayout(), { signal: this.listenerScope?.signal });
        this.on('file-filter-toggle', () => {
            const tools = this.el<HTMLDetailsElement>('file-filter-tools');
            tools.open = !tools.open;
            this.renderCoreLayout();
            if (tools.open) this.el('filter').focus();
        });
        this.el('file-filter-tools').addEventListener('toggle', () => this.renderCoreLayout(), { signal: this.listenerScope?.signal });
        this.el('repo-toggle').hidden = false;
        for (const element of this.app.querySelectorAll<HTMLElement>('[data-core-ui]')) element.hidden = false;
        this.el('repo-select').addEventListener('change', () => {
            const select = this.el<HTMLSelectElement>('repo-select'), id = select.value;
            if (this.busy || this.planning || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden) || !this.snapshot?.repositories.some(repo => repo.id === id)) { select.value = this.repoId; return; }
            if (id !== this.repoId) void this.guard(() => this.selectRepo(id, true));
        }, { signal: this.listenerScope?.signal });
        this.on('repo-toggle', () => {
            this.layout?.toggleRepositories();
        });
        for (const menu of this.app.querySelectorAll<HTMLDetailsElement>('.toolbar-menu')) {
            menu.addEventListener('toggle', () => {
                if (menu.open) for (const other of this.app.querySelectorAll<HTMLDetailsElement>('.toolbar-menu[open]')) if (other !== menu) other.open = false;
            }, { signal: this.listenerScope?.signal });
            menu.addEventListener('click', event => {
                if (menu.id !== 'browser-debug-menu' && event.composedPath().some(item => item instanceof HTMLElement && item.tagName === 'BUTTON')) menu.open = false;
            }, { signal: this.listenerScope?.signal });
        }
        for (const kind of ['repo', 'branch'] as const) {
        const selectId = kind === 'repo' ? 'repo-select' : 'branch';
        const picker = this.el<HTMLDetailsElement>(kind + '-picker');
        picker.querySelector('summary')!.addEventListener('click', event => { if (this.el<HTMLSelectElement>(selectId).disabled) event.preventDefault(); }, { signal: this.listenerScope?.signal });
        picker.addEventListener('toggle', () => { if (picker.open) this.renderBranchPicker(); }, { signal: this.listenerScope?.signal });
        picker.addEventListener('keydown', event => {
            const options = [...this.el(kind + '-options').querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !options.length) return;
            event.preventDefault();
            const current = options.indexOf(event.target as HTMLButtonElement);
            picker.open = true;
            const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : current < 0 ? options.findIndex(option => option.getAttribute('aria-checked') === 'true') : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
            options[Math.max(0, index)]!.focus();
        }, { signal: this.listenerScope?.signal });
        this.el(kind + '-options').addEventListener('click', event => {
            const option = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-value]');
            if (!option || option.disabled) return;
            const branch = this.el<HTMLSelectElement>(selectId);
            if (branch.disabled) return;
            branch.value = option.dataset.value!;
            picker.open = false;
            picker.querySelector<HTMLElement>('summary')!.focus();
            branch.dispatchEvent(new Event('change'));
        }, { signal: this.listenerScope?.signal });
        }
        this.on('secondary-page-back', () => this.setMode('working'));
        this.on('reflog-close', () => { this.el('reflog-workspace').hidden = true; this.clearReflog(); });
        this.on('remote-close', () => { this.el('remote-workspace').hidden = true; this.resetRemotes(); });
    }

    private renderContextualRegions(): void {
        const draft = this.drafts?.get(this.repoId);
        const staged = this.details?.repo.files.some(file => !file.conflict && file.index !== ' ' && file.index !== '?');
        const commit = this.mode === 'working' && !!(staged || draft?.message || draft?.loading || draft?.saving || draft?.error || draft?.confirm || !this.el('merge-tools').hidden);
        this.app.classList.toggle('commit-unavailable', !commit);
        const viewer = (!!this.currentFile && (!!this.currentDiff || this.diffLoading || this.blameActive)) || !this.el('commit-inspector').hidden || !this.el('file-compare-tools').hidden;
        this.app.classList.toggle('viewer-empty', !viewer);
        this.el('viewer-tools').hidden = !this.currentFile || (!this.currentDiff && !this.diffLoading);
        this.el('file-title').hidden = !this.currentFile;
        this.el('commit-box').hidden = !commit;
        this.el('toggle-log').hidden = !this.el('log').textContent;
    }

    private renderCoreLayout(): void {
        this.renderContextualRegions();
        this.layout?.refresh();
        const repo = this.details?.repo;
        this.el<HTMLSelectElement>('repo-select').value = this.repoId;
        setControlValue(this.el('repo-select'), 'title', repo ? `${repo.path}\n${repo.branch || t('panel.detachedHead')}` : t('panel.html.repo-picker.summary.aria'));
        this.renderMergeTargetHint();
        this.renderBranchPicker();
        const labels = { working: t('panel.html.working-tab'), history: t('panel.html.history-tab'), stash: t('panel.mode.stash'), compare: t('panel.html.compare-tab'), branches: t('panel.html.branch-menu.div2.aria'), sync: t('panel.html.sync-tab'), tags: t('panel.html.tags-tab') };
        setControlValue(this.el('secondary-page'), 'hidden', this.mode === 'working' || this.mode === 'history');
        setControlValue(this.el('secondary-page-title'), 'textContent', labels[this.mode]);
        const fileFilter = this.el<HTMLInputElement>('filter');
        fileFilter.placeholder = this.mode === 'history' ? t('panel.filter.commitFilesPlaceholder') : t('panel.html.filter.placeholder');
        setControlAttribute(fileFilter, 'aria-label', this.mode === 'history' ? t('panel.filter.commitFiles') : t('panel.html.file-filter-toggle.aria'));
        const historyFilterTarget = this.el('history-file-filter-target');
        const workingFilterTarget = this.el('working-file-filter-target');
        if (this.mode === 'history') {
            if (fileFilter.parentElement !== historyFilterTarget) historyFilterTarget.append(fileFilter);
        } else if (fileFilter.previousElementSibling !== workingFilterTarget) workingFilterTarget.after(fileFilter);
        setControlValue(historyFilterTarget, 'hidden', true);
        const pathFilter = fileFilter.value.trim();
        const filtered = !!pathFilter || (this.mode === 'working' && (this.workingFilter.area !== 'all' || this.workingFilter.status !== 'all' || this.workingFilter.kind !== 'all'));
        setControlValue(this.el('working-filter-title'), 'textContent', pathFilter ? t('panel.filter.titleWithPath', { path: pathFilter }) : filtered ? t('panel.filter.titleActive') : t('panel.html.working-filter-title'));
        this.el('working-filter-title').classList.toggle('filter-active', filtered);
        setControlValue(this.el('working-filter-title'), 'title', pathFilter);
        const filterToggle = this.el('file-filter-toggle');
        setControlValue(filterToggle, 'hidden', this.mode === 'history' || this.mode === 'branches' || this.mode === 'tags');
        setControlAttribute(filterToggle, 'aria-expanded', String(this.el<HTMLDetailsElement>('file-filter-tools').open));
        filterToggle.dataset.active = String(filtered);
        filterToggle.classList.toggle('active', filtered || this.el<HTMLDetailsElement>('file-filter-tools').open);
        setControlValue(filterToggle, 'title', this.el('working-filter-title').textContent || t('panel.html.file-filter-toggle.aria'));
        this.app.classList.toggle('history-overview', this.mode === 'history' && !this.revision);
        const name = this.el<HTMLInputElement>('history-path').value;
        setControlValue(this.el('history-path-title'), 'textContent', name ? t('panel.history.pathTitleWith', { name }) : t('panel.html.history-path-title'));
        setControlValue(this.el('history-path-title'), 'title', name);
        setControlValue(this.el('history-selection-options'), 'hidden', this.mode !== 'history' || !this.revision);
        setControlValue(this.el('history-search-title'), 'textContent', name || this.el<HTMLInputElement>('history-search').value ? t('panel.history.optionsTitleActive') : t('panel.html.history-search-title'));
        const historyToggle = this.el('history-options-toggle');
        const historyActive = !!name || !!this.el<HTMLInputElement>('history-search').value || this.el<HTMLSelectElement>('history-scope').value !== 'all';
        setControlValue(historyToggle, 'hidden', this.mode !== 'history');
        setControlAttribute(historyToggle, 'aria-expanded', String(this.el<HTMLDetailsElement>('history-search-tools').open));
        historyToggle.dataset.active = String(historyActive);
        historyToggle.classList.toggle('active', historyActive || this.el<HTMLDetailsElement>('history-search-tools').open);
        setControlValue(historyToggle, 'title', historyActive ? t('panel.history.toggleTitleActive') : t('panel.html.history-options-toggle.aria'));
    }
    private async guard(work: () => Promise<void>): Promise<void> {
        try { await work(); } catch (e) { this.error(e); }
    }
    private error(e: unknown): void {
        const notice = this.el('notice');
        notice.textContent = e instanceof Error ? e.message : String(e);
        notice.hidden = false;
    }
    private on(id: string, work: () => Promise<void> | void): void {
        this.el(id).addEventListener('click', () => { void this.guard(async () => { await work(); }); }, { signal: this.listenerScope?.signal });
    }
    private bind(): void {
        this.browserDebugFeedback = new BrowserDebugFeedback((message, pending) => {
            if (this.closed) return;
            for (const button of this.app.querySelectorAll<HTMLButtonElement>('#browser-debug-menu button')) button.disabled = pending;
            this.el('browser-debug-feedback').textContent = message;
            this.el('browser-debug-feedback').hidden = false;
            this.el('browser-debug-menu-status').textContent = message;
        });
        const runDebug = (label: string, method: string, ...args: unknown[]) => this.browserDebugFeedback!.run(label, () => request<string>(method, ...args));
        this.on('browser-debug-open', () => runDebug(t('panel.debug.openingEmbedded'), 'debug-preview-open'));
        this.on('browser-debug-external', () => runDebug(t('panel.debug.openingExternal'), 'browser-debug-external'));
        this.on('browser-debug-codex', () => runDebug(t('panel.debug.configuringClient'), 'browser-debug-connect-codex'));
        this.on('browser-debug-enable', () => runDebug(t('panel.debug.enabling'), 'browser-debug-set-enabled', true));
        this.on('browser-debug-disable', () => runDebug(t('panel.debug.disabling'), 'browser-debug-set-enabled', false));
        this.on('discard-files', () => this.runFileAction('discardFiles'));
        this.on('stage', () => this.runFileAction('stage'));
        this.on('unstage', () => this.runFileAction('unstage'));
        this.on('file-menu-submodule', async () => {
            const target = this.fileMenuTarget;
            if (!target || this.workingSelectionLocked() || target.repo !== this.repoId || target.version !== this.details?.repo.version) return;
            await this.openSubmodule(target.file);
        });
        this.el('file-menu-comparison').addEventListener('toggle', () => {
            const target = this.fileMenuTarget;
            if (!target || this.el('file-menu').hidden) return;
            this.placeFileMenu(target.x, target.y);
        }, { signal: this.listenerScope?.signal });
        this.on('file-menu-restore',()=>{
            const target=this.fileMenuTarget,source=target?.source;
            if(target?.repo===this.repoId && source && this.details)return this.prepareWorktreeOperation({repo:this.repoId,version:this.details.repo.version,action:'restoreFiles',paths:[source.path],revision:source.revision});
        });

        this.on('refresh', () => this.refreshRemote(false));
        this.on('auto-fetch-toggle', () => { this.remoteFetch.toggle(); this.updateButtons(); });
        this.on('file-page-prev', () => this.changeFilePage(-1));
        this.on('file-page-next', () => this.changeFilePage(1));
        this.on('file-menu-open', () => this.navigateFile('open'));
        this.on('file-menu-reveal', () => this.navigateFile('reveal'));
        this.on('file-menu-copy', () => this.copyFilePath());
        this.on('file-menu-left', () => this.pinFile('left'));
        this.on('file-menu-right', () => this.pinFile('right'));
        this.on('file-menu-worktree-compare', () => {
            const target = this.fileMenuTarget;
            if (!target || target.repo !== this.repoId) return;
            const source = target.source || (!target.historical ? this.fileCompareLeft : undefined);
            if (source) return this.showLocalFileComparison(source, target.file);
        });
        this.on('file-compare-worktree', () => {
            if (this.fileCompareLeft) return this.showLocalFileComparison(this.fileCompareLeft, this.fileCompareLeft.path);
        });
        this.on('file-menu-index-compare', () => {
            const target = this.fileMenuTarget;
            if (!target || target.repo !== this.repoId) return;
            const source = target.source || (!target.historical ? this.fileCompareLeft : undefined);
            if (source) return this.showLocalFileComparison(source, target.file, 'index-compare');
        });
        this.on('file-compare-index', () => {
            if (this.fileCompareLeft) return this.showLocalFileComparison(this.fileCompareLeft, this.fileCompareLeft.path, 'index-compare');
        });
        this.on('file-compare-show', () => this.showPinnedFiles());
        this.on('file-compare-retry', () => {
            const file = this.currentFile;
            return file && (file.area === 'worktree-compare' || file.area === 'index-compare') && file.left ? this.showLocalFileComparison(file.left, file.path, file.area) : this.showPinnedFiles(true);
        });
        this.on('file-compare-swap', async () => {
            [this.fileCompareLeft, this.fileCompareRight] = [this.fileCompareRight, this.fileCompareLeft];
            if (this.currentFile?.area === 'worktree-compare' || this.currentFile?.area === 'index-compare') { this.diffEpoch++; this.diffLoading = false; this.currentFile = undefined; this.currentDiff = undefined; this.renderDiff(); }
            this.updateButtons(); if (this.currentFile?.area === 'file-compare') await this.showPinnedFiles();
        });
        this.on('file-compare-clear', () => {
            this.fileCompareLeft = undefined; this.fileCompareRight = undefined;
            if (this.isFileComparison()) { this.diffEpoch++; this.diffLoading = false; this.currentFile = undefined; this.currentDiff = undefined; this.renderDiff(); }
            this.updateButtons();
        });
        for (const side of ['left', 'right'] as const) this.on('file-compare-open-' + side, async () => {
            const source = side === 'left' ? this.fileCompareLeft : this.fileCompareRight;
            const name = side === 'right' && (this.currentFile?.area === 'worktree-compare' || this.currentFile?.area === 'index-compare') ? this.currentFile.path : source?.path;
            if (name && !this.busy && !this.planning && !this.diffLoading) await request('reveal', this.repoId, name, 'open');
        });
        const doc = this.app.ownerDocument;
        doc.addEventListener('pointerdown', this.menuOutside, { capture: true, signal: this.listenerScope?.signal });
        doc.addEventListener('keydown', this.menuKeys, { capture: true, signal: this.listenerScope?.signal });
        for (const type of ['pointerdown', 'pointercancel', 'click'] as const) this.app.addEventListener(type, this.modalBackdrop, { signal: this.listenerScope?.signal });
        doc.addEventListener('visibilitychange', this.visibilityChanged, { signal: this.listenerScope?.signal });
        doc.defaultView?.addEventListener('focus', this.windowFocused, { signal: this.listenerScope?.signal });
        doc.addEventListener('scroll', this.menuViewportChanged, { capture: true, signal: this.listenerScope?.signal });
        doc.defaultView?.addEventListener('resize', this.menuViewportChanged, { signal: this.listenerScope?.signal });
        this.el('message').addEventListener('input', () => {
            const state = this.draft(this.repoId);
            state.message = this.el<HTMLTextAreaElement>('message').value;
            state.edit++; state.confirm = undefined;
            this.queueDraft(this.repoId); this.renderDraft();
        }, { signal: this.listenerScope?.signal });
        this.on('draft-save', () => this.saveDraft(this.repoId, true));
        this.on('draft-reload', () => this.draftAction('reload'));
        this.on('draft-clear', () => this.draftAction('clear'));
        this.on('draft-cancel', () => { const state = this.draft(this.repoId); state.confirm = undefined; this.queueDraft(this.repoId); this.renderDraft(); });
        this.on('amend', () => this.openAmend());
        this.on('amend-cancel', () => this.cancelDialog());
        this.on('amend-preview', () => this.prepare('amendCommit'));
        this.on('plan-amend-edit', () => {
            if (!this.amendTarget || this.busy || this.planning) return;
            this.dialogEpoch++; this.plan = undefined; this.el('modal').hidden = true;
            this.el('amend-modal').hidden = false; this.el<HTMLTextAreaElement>('amend-message').focus();
        });
        this.el('amend-message').addEventListener('input', () => {
            const target = this.amendTarget;
            if (target) { const draft = this.amendDrafts.get(target.repo + '\0' + target.revision); if (draft) draft.message = this.el<HTMLTextAreaElement>('amend-message').value; }
            this.updateButtons();
        }, { signal: this.listenerScope?.signal });
        this.on('project-update-toggle', () => {
            const box = this.el('project-update-progress'), collapsed = box.classList.toggle('collapsed');
            this.el('project-update-toggle').setAttribute('aria-expanded', String(!collapsed)); this.layout?.refresh();
        });
        this.on('project-update-open', () => this.toggleProjectUpdate());
        this.on('scope-reviews-open', () => this.openScopeReviews());
        this.el('scope-review-select').addEventListener('change', () => { void this.guard(() => this.loadScopeReview()); }, { signal: this.listenerScope?.signal });
        this.el('scope-review-ack').addEventListener('change', () => this.updateScopeReviewButtons(), { signal: this.listenerScope?.signal });
        this.on('scope-review-approve', () => this.decideScopeReview(true));
        this.on('scope-review-reject', () => this.decideScopeReview(false));
        this.on('scope-review-close', () => { if (!this.planning) { ++this.scopeReviewEpoch; this.scopeReview = undefined; this.el('scope-review-modal').hidden = true; this.updateButtons(); void this.guard(() => this.showPendingScopeReview()); } });
        this.el('project-update-close').addEventListener('click', event => {
            event.preventDefault(); event.stopPropagation();
            this.closeProjectUpdate();
        }, { signal: this.listenerScope?.signal });
        this.on('update-all', () => {
            if (this.details) return this.prepareWorktreeOperation({ repo: this.repoId, version: this.details.repo.version, action: 'updateAll' });
        });
        for (const [id, action] of Object.entries({ 'fork-reset-preferred': 'forkResetPreferred', 'fork-smart-git': 'forkSmartGit', 'fork-reset-dev': 'forkResetDev' } as const)) this.on(id, () => {
            if (this.details) this.openProjectTool(action);
        });
        for (const [id, action] of Object.entries({ fetch: 'fetch', 'fetch-all': 'fetchAll', pull: 'pull', push: 'push', commit: 'commit', sync: 'syncSubmodules', lfs: 'lfsFetch' })) this.on(id, () => this.prepare(action as Action));
        this.el('manage-reflog').hidden = false;
        this.on('manage-reflog', async () => {
            const box = this.el('reflog-workspace'); box.hidden = !box.hidden;
            if (box.hidden) this.clearReflog();
            else { this.el('remote-workspace').hidden = true; this.resetRemotes(); await this.loadReflog(); }
        });
        this.on('reflog-read', () => this.loadReflog());
        this.on('reflog-prev', () => this.loadReflog(Math.max(0, (this.reflogPage?.offset || 0) - 20), this.reflogPage?.version));
        this.on('reflog-next', () => this.loadReflog(this.reflogPage?.nextOffset || 0, this.reflogPage?.version));
        this.el('reflog-ref').addEventListener('change', () => { this.clearReflog(); void this.guard(() => this.loadReflog()); }, { signal: this.listenerScope?.signal });
        this.el('reflog-source-filter').hidden = false;
        this.el('reflog-source-note').hidden = false;
        this.el('reflog-source-filter').addEventListener('input', () => {
            this.cancelDialog(); this.clearReflog();
            this.reflogTimer = setTimeout(() => { this.reflogTimer = undefined; void this.guard(() => this.loadReflog()); }, 150);
        }, { signal: this.listenerScope?.signal });
        this.el('reflog-filter').addEventListener('input', () => {
            this.cancelDialog(); this.clearReflog();
            this.reflogTimer = setTimeout(() => { this.reflogTimer = undefined; void this.guard(() => this.loadReflog()); }, 150);
        }, { signal: this.listenerScope?.signal });
        this.el('reflog-branch').addEventListener('input', () => { this.cancelDialog(); this.renderReflogControls(); }, { signal: this.listenerScope?.signal });
        this.on('reflog-create', () => this.prepareReflogBranch());
        this.el('manage-remotes').hidden = false;
        this.on('manage-remotes', async () => {
            const box = this.el('remote-workspace'); box.hidden = !box.hidden;
            if (box.hidden) this.resetRemotes(); else { this.el('reflog-workspace').hidden = true; this.clearReflog(); await this.loadRemotes(); }
        });
        this.on('remote-read', () => this.loadRemotes());
        this.on('remote-prev', () => this.loadRemotes(Math.max(0, (this.remotePage?.offset || 0) - 20), this.remotePage?.version));
        this.on('remote-next', () => this.loadRemotes(this.remotePage?.nextOffset || 0, this.remotePage?.version));
        this.on('remote-add-mode', () => {
            this.cancelDialog(); this.remoteSelection = undefined; this.remoteAdding = true;
            this.el<HTMLInputElement>('remote-name').value = ''; this.el<HTMLInputElement>('remote-url').value = '';
            this.renderRemoteControls(); this.el('remote-name').focus();
        });
        for (const id of ['remote-name', 'remote-url']) this.el(id).addEventListener('input', () => { this.cancelDialog(); this.renderRemoteControls(); }, { signal: this.listenerScope?.signal });
        this.on('remote-add', () => this.prepareRemote('addRemote'));
        this.on('remote-set-fetch', () => this.prepareRemote('setRemoteUrl'));
        this.on('remote-set-push', () => this.prepareRemote('setRemotePushUrl'));
        this.on('remote-reset-push', () => this.prepareRemote('resetRemotePushUrl'));
        this.on('working-tab', () => this.setMode('working'));
        this.on('history-tab', () => this.setMode('history'));
        this.on('compare-tab', () => this.setMode('compare'));
        this.on('sync-tab', () => this.setMode('sync'));
        this.on('sync-refresh', () => this.refresh(true));
        this.on('sync-retry', () => this.loadSync(false, !!this.syncPage));
        this.on('sync-more', () => this.loadSync(true));
        for (const direction of ['outgoing', 'incoming'] as const) this.on('sync-' + direction, () => {
            if (this.syncLoading || this.syncDirection === direction) return;
            this.syncDirection = direction;
            return this.loadSync(false, !!this.syncPage);
        });
        this.on('manage-branches', () => this.setMode('branches'));
        this.on('tags-tab', () => this.setMode('tags'));
        this.on('tags-refresh', () => this.loadTags());
        this.on('tags-prev', () => this.loadTags(Math.max(0, (this.tagPage?.offset || 0) - 100), this.tagPage?.version));
        this.on('tags-next', () => this.tagPage?.nextOffset !== undefined ? this.loadTags(this.tagPage.nextOffset, this.tagPage.version) : undefined);
        this.on('tag-use-head', () => { if (this.details?.repo.head && !this.tagLocked()) { this.cancelDialog(); this.tagTarget = { repo: this.repoId, sha: this.details.repo.head }; this.renderTags(); } });
        this.on('history-new-tag', async () => {
            const repo = this.repoId, sha = this.revision;
            if (this.mode !== 'history' || !this.commits.some(commit => commit.sha === sha) || this.busy || this.planning) return;
            const loading = this.setMode('tags'), epoch = this.epoch;
            await loading;
            if (!this.closed && epoch === this.epoch && this.repoId === repo && !this.el('tag-workspace').hidden) { this.tagTarget = { repo, sha }; this.renderTags(); this.el<HTMLInputElement>('tag-name').focus(); }
        });
        this.on('tag-create', () => this.prepareTag('createTag'));
        this.on('tag-delete', () => this.prepareTag('deleteTag'));
        this.on('tag-view', async () => {
            const repo = this.repoId, sha = this.selectedTag?.commit;
            if (!sha || this.tagLocked()) return;
            const loading = this.setMode('history'), epoch = this.epoch;
            await loading;
            if (!this.closed && this.epoch === epoch && this.repoId === repo && this.mode === 'history') await this.selectHistoryCommit(sha);
        });
        this.el('tags-filter').addEventListener('input', () => {
            this.tagEpoch++; this.cancelDialog(); this.tagPage = undefined; this.selectedTag = undefined; this.tagLoading = true;
            if (this.tagTimer) clearTimeout(this.tagTimer);
            this.tagTimer = setTimeout(() => { this.tagTimer = undefined; if (!this.closed && this.mode === 'tags') void this.loadTags(); }, 150);
            this.renderTags();
        }, { signal: this.listenerScope?.signal });
        for (const id of ['tag-name', 'tag-kind', 'tag-message']) this.el(id).addEventListener('input', () => { this.cancelDialog(); this.renderTagControls(); }, { signal: this.listenerScope?.signal });
        this.el('branch-filter').addEventListener('input', () => { this.renderBranches(); this.updateButtons(); }, { signal: this.listenerScope?.signal });
        this.on('rename-branch', () => this.openInput('renameBranch'));
        this.on('delete-branch', () => this.prepare('deleteBranch'));
        this.on('set-upstream', () => this.openUpstream());
        this.on('unset-upstream', () => this.prepare('unsetUpstream'));
        this.el('upstream-filter').addEventListener('input', () => this.renderUpstreamChoices(), { signal: this.listenerScope?.signal });
        this.on('history-new-branch', () => {
            const commit = this.mode === 'history' && !this.historyLoading ? this.commits.find(c => c.sha === this.revision) : undefined;
            if (commit) this.openInput('createBranch', commit);
        });
        this.on('history-preserve-branch', () => {
            const commit = this.mode === 'history' && !this.historyLoading ? this.commits.find(c => c.sha === this.revision) : undefined;
            if (commit) this.openInput('createBranchAt', commit);
        });
        this.on('head-preserve', () => {
            const repo = this.details?.repo;
            if (repo && headState(repo) === 'detached') this.openInput('createBranchAt', { sha: repo.head, subject: t('panel.currentDetachedHead') });
        });
        this.on('history-tree', async () => {
            if (this.mode !== 'history' || !this.revision || this.busy || this.planning) return;
            const revision = this.revision;
            if (this.treeActive) { this.clearTree(); await this.selectHistoryCommit(revision); }
            else { this.treeActive = true; await this.loadTree(''); }
        });
        this.on('tree-root', () => this.loadTree(''));
        this.on('tree-parent', () => this.loadTree(this.treeDirectory.includes('/') ? this.treeDirectory.slice(0, this.treeDirectory.lastIndexOf('/')) : ''));
        this.on('tree-retry', () => this.loadTree(this.treeDirectory));
        this.on('tree-prev', () => this.loadTree(this.treeDirectory, Math.max(0, (this.treePage?.offset || 0) - 100), this.treePage?.version));
        this.on('tree-next', () => this.treePage?.nextOffset !== undefined ? this.loadTree(this.treeDirectory, this.treePage.nextOffset, this.treePage.version) : undefined);
        this.el('tree-filter').addEventListener('input', () => {
            this.treeEpoch++; this.treePage = undefined; this.treeLoading = true; this.cancelDialog(); this.closeFileMenu();
            this.diffEpoch++; this.currentDiff = undefined; this.currentFile = undefined; this.clearBlame(); this.renderDiff();
            if (this.treeTimer) clearTimeout(this.treeTimer);
            this.treeTimer = setTimeout(() => { this.treeTimer = undefined; if (!this.closed) void this.loadTree(this.treeDirectory); }, 150);
            this.renderFiles(); this.updateButtons();
        }, { signal: this.listenerScope?.signal });
        this.on('history-search-apply', () => this.applyHistorySearch());
        this.on('history-search-clear', () => {
            this.el<HTMLInputElement>('history-search').value = '';
            this.el<HTMLInputElement>('history-path').value = '';
            return this.applyHistorySearch();
        });
        this.on('history-base', () => this.useHistoryForCompare('base'));
        this.on('history-target', () => this.useHistoryForCompare('target'));
        this.on('file-history', async () => {
            const target = this.fileMenuTarget;
            if (!target || target.repo !== this.repoId || this.busy || this.planning || !this.details || target.version !== this.details.repo.version) return;
            const name = target.file;
            this.closeFileMenu();
            this.el<HTMLInputElement>('history-search').value = '';
            this.el<HTMLInputElement>('history-path').value = name;
            this.historyQuery = this.historyDraft();
            await this.setMode('history');
        });
        this.on('commit-files-open', () => this.openInspectedCommit());
        this.on('commit-preserve-branch', () => {
            const commit = this.commitDetails;
            if (commit && !this.inspectLoading) this.openInput('createBranchAt', { sha: commit.sha, subject: commit.message.split('\n')[0] || t('panel.noCommitMessage') });
        });
        this.on('commit-details-retry', () => this.showCommitDetails(this.inspectRevision, this.inspectPath));
        this.on('blame-run', () => this.loadBlame());
        this.on('blame-more', () => this.loadBlame(true));
        this.on('compare-run', () => this.loadComparison());
        this.on('compare-swap', () => {
            const base = this.el<HTMLInputElement>('compare-base'), target = this.el<HTMLInputElement>('compare-target');
            [base.value, target.value] = [target.value, base.value]; this.renderComparison();
        });
        for (const id of ['history-search', 'history-path', 'compare-base', 'compare-target']) {
            this.el(id).addEventListener('keydown', event => {
                if (event.key === 'Enter' && !event.isComposing) {
                    event.preventDefault();
                    void this.guard(() => id.startsWith('history-') ? this.applyHistorySearch() : this.loadComparison());
                }
            }, { signal: this.listenerScope?.signal });
        }
        for (const id of ['history-field', 'history-search', 'history-path']) this.el(id).addEventListener('input', () => this.renderHistoryDraft(), { signal: this.listenerScope?.signal });
        for (const id of ['compare-base', 'compare-target', 'compare-mode']) this.el(id).addEventListener('input', () => this.renderComparison(), { signal: this.listenerScope?.signal });
        this.on('stash-apply', () => this.prepare('stashApply'));
        this.on('stash-drop', () => this.prepare('stashDrop'));
        this.on('stash-restore-file', () => {
            const file = this.currentFile, sequence = this.diffEpoch, ref = this.stashRef;
            if (!this.details || this.mode !== 'stash' || file?.area !== 'stash' || !file.revision || !file.stashPart || this.diffLoading || !this.currentDiff) return;
            if (!this.stashes.some(stash => stash.ref === ref && stash.sha === file.revision)) return;
            return this.prepareWorktreeOperation({repo:this.repoId,version:this.details.repo.version,action:'restoreStashFiles',paths:[file.path],revision:file.revision,stashRef:ref,stashPart:file.stashPart},()=>this.mode==='stash' && this.currentFile===file && this.diffEpoch===sequence && this.stashRef===ref && this.revision===file.revision);
        });
        for (const type of ['wheel', 'scroll', 'keydown', 'touchmove', 'pointerdown']) this.el('commit-list').addEventListener(type, this.historyPaging, { ...({ passive: true }), signal: this.listenerScope?.signal });
        this.el('history-scope').addEventListener('change', () => { void this.guard(() => this.applyHistorySearch()); }, { signal: this.listenerScope?.signal });
        this.on('line-action', () => this.prepare(this.currentFile?.area === 'index' ? 'unstageLines' : 'stageLines'));
        this.on('line-discard', () => {
            const file=this.currentFile,partial=this.currentDiff?.partial,epoch=this.diffEpoch,ids=[...this.selectedLines];
            if(!this.details || this.mode!=='working' || file?.area!=='worktree' || !partial || !ids.length || this.diffLoading || this.blameActive)return;
            return this.prepareWorktreeOperation({repo:this.repoId,version:this.details.repo.version,action:'discardLines',lines:{path:file.path,version:partial.version,ids}},()=>this.mode==='working' && this.currentFile===file && this.diffEpoch===epoch && this.currentDiff?.partial?.version===partial.version && this.selectedLines.size===ids.length && ids.every(id=>this.selectedLines.has(id)));
        });
        this.on('lines-all', () => { for (const hunk of this.currentDiff?.partial?.hunks || []) for (const line of hunk.lines) if (line.id) this.selectedLines.add(line.id); this.updateButtons(); });
        this.on('lines-clear', () => { this.selectedLines.clear(); this.updateButtons(); });
        this.on('conflict-reload', () => {
            if (this.currentFile?.area === 'conflict' && !this.busy && !this.planning && !this.diffLoading) return this.showDiff(this.currentFile.path, 'conflict');
        });
        this.on('conflict-resolve', () => this.prepare('resolveConflict'));
        this.el('filter').addEventListener('input', () => {
            if (this.mode === 'working' && (this.busy || this.planning || !this.details || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden))) { this.el<HTMLInputElement>('filter').value = this.workingFilter.text; return; }
            this.selectionEpoch++; this.closeFileMenu(); this.cancelDialog();
            this.filterPending = true;
            if (this.filterTimer) clearTimeout(this.filterTimer);
            this.filterTimer = setTimeout(() => {
                this.filterTimer = undefined;
                if (this.closed) return;
                this.filterPending = false; this.filePage = 0;
                if (this.mode === 'working') this.workingFilter.text = this.el<HTMLInputElement>('filter').value;
                this.renderFiles(); this.updateButtons();
            }, 150);
            this.updateButtons();
        }, { signal: this.listenerScope?.signal });
        for (const [id, key] of [['working-area', 'area'], ['working-status', 'status'], ['working-kind', 'kind']] as const) {
            this.el(id).addEventListener('change', () => {
                const input = this.el<HTMLSelectElement>(id);
                if (this.workingSelectionLocked()) { input.value = this.workingFilter[key]; return; }
                if (key === 'area') this.workingFilter.area = input.value as WorkingFilter['area'];
                else if (key === 'status') this.workingFilter.status = input.value as WorkingFilter['status'];
                else this.workingFilter.kind = input.value as WorkingFilter['kind'];
                this.filePage = 0; this.selectionEpoch++; this.closeFileMenu(); this.renderFiles(); this.updateButtons();
            }, { signal: this.listenerScope?.signal });
        }
        this.on('working-filter-clear', () => {
            if (this.workingSelectionLocked()) return;
            this.resetWorkingFilter(); this.selectionEpoch++; this.renderFiles(); this.updateButtons();
        });
        this.on('working-selection-clear', () => {
            if (this.workingSelectionLocked()) return;
            this.selected.clear(); this.selectionEpoch++; this.updateWorkingSummary(); this.updateButtons();
        });
        this.el('pointers').addEventListener('change', () => {
            const pointers = this.el<HTMLInputElement>('pointers');
            if (this.busy || this.planning || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden)) pointers.checked = false;
        }, { signal: this.listenerScope?.signal });
        this.on('patch-tab', () => { this.blameActive = false; this.sides = false; this.renderDiff(); });
        this.on('sides-tab', () => { this.blameActive = false; this.sides = true; this.renderDiff(); });
        this.on('toggle-log', () => this.toggleLog());
        this.on('log-close', () => this.toggleLog(false));
        this.on('new-branch', () => this.openInput('createBranch'));
        this.on('checkout-remote', () => this.openInput('checkoutRemote'));
        this.on('stash-save', () => this.openInput('stashPush'));
        this.on('stash-selected', () => this.runFileAction('stashSelected'));
        this.on('merge-start-preview',()=>{
            const revision=this.el<HTMLSelectElement>('merge-start-target').value;
            if(this.details && revision)return this.prepareWorktreeOperation({repo:this.repoId,version:this.details.repo.version,action:'merge',revision});
        });
        this.el('branch').addEventListener('change', async () => {
            const branch = this.el<HTMLSelectElement>('branch');
            if (!this.details || !branch.value || branch.value === this.details.repo.branch) return;
            this.cancelDialog();
            try { await this.prepare('switch'); }
            finally { branch.value = this.details?.repo.branch || ''; this.renderMergeTargetHint(); }
        }, { signal: this.listenerScope?.signal });
        this.el('merge-start-target').addEventListener('change',()=>{this.cancelDialog();this.renderMergeControls();}, { signal: this.listenerScope?.signal });
        this.on('commit-start-merge',()=>{
            const commit=this.commitDetails,sequence=this.inspectEpoch;
            if(commit && this.details && !this.inspectLoading)return this.prepareWorktreeOperation({repo:this.repoId,version:this.details.repo.version,action:'merge',revision:commit.sha},()=>sequence===this.inspectEpoch);
        });
        this.on('merge-abort-preview',()=>{
            const state=this.mergeView,epoch=this.mergeEpoch;
            if(state?.canAbort && state.abortVersion)return this.prepareWorktreeOperation({repo:this.repoId,version:state.repoVersion,action:'abortMerge',mergeVersion:state.abortVersion},()=>epoch===this.mergeEpoch);
        });
        this.on('merge-read', () => this.readMerge());
        this.on('merge-preview', () => this.prepareMerge());
        this.el('merge-message').addEventListener('input', () => {
            const draft = this.mergeDrafts.get(this.mergeKey);
            if (draft) draft.message = this.el<HTMLTextAreaElement>('merge-message').value;
            this.cancelDialog(); this.renderMergeControls();
        }, { signal: this.listenerScope?.signal });
        this.el('merge-pointers').addEventListener('change', () => { this.cancelDialog(); this.renderMergeControls(); }, { signal: this.listenerScope?.signal });
        this.el('remote-branch').addEventListener('change', () => {
            const source = this.details?.remoteBranches.find(b => b.ref === this.el<HTMLSelectElement>('remote-branch').value);
            this.el<HTMLInputElement>('branch-name').value = source?.branch || '';
        }, { signal: this.listenerScope?.signal });
        this.el('project-tool-confirm').addEventListener('input', () => this.updateButtons(), { signal: this.listenerScope?.signal });
        this.on('cancel', () => this.cancelDialog());
        this.on('confirm', async () => {
            if (this.busy || this.planning) return;
            if (this.projectToolAction && this.details) {
                const action = this.projectToolAction, branch = this.el<HTMLInputElement>('branch-name').value.trim();
                const remote = this.el<HTMLInputElement>('project-tool-remote').value.trim() || undefined;
                this.cancelDialog();
                await this.prepareWorktreeOperation({ repo: this.repoId, version: this.details.repo.version, action, branch, remote }); return;
            }
            if (this.projectToolConfirmation && this.el<HTMLInputElement>('project-tool-confirm').value !== 'RESET ALL') return;
            if (this.inputAction) { await this.prepare(this.inputAction); return; }
            if (!this.plan) return;
            if (this.pendingUpdate?.token === this.plan.token) this.warningPreferences.confirmUpdate(this.pendingUpdate.key);
            await this.executePlan(this.plan);
        });
    }

    private async executePlan(plan: Plan): Promise<void> {
        if (this.closed || this.busy) return;
        if (this.pendingWarnings?.token === plan.token) {
            this.warningPreferences.acknowledge(this.pendingWarnings.action, this.pendingWarnings.warnings);
        }
        this.pendingWarnings = undefined; this.pendingUpdate = undefined;
        const epoch = this.epoch, repo = this.repoId, wasPlanning = this.planning;
        this.plan = undefined; this.el('modal').hidden = true;
        // Lock before IPC dispatch, including the time before a task id is returned.
        this.planning = true; this.busy = true; this.updateButtons();
        try {
            const task = await request<Task>('execute', plan.token);
            if (this.closed) return;
            if (epoch === this.epoch && repo === this.repoId) {
                this.selected.clear(); this.selectionEpoch++; this.selectedLines.clear();
                if (this.mode === 'working') this.renderFiles();
            }
            this.renderTask(task);
            if (task.status !== 'running') await this.refresh(true);
        } catch (error) {
            if (!this.closed) {
                this.busy = true;
                this.error(t('panel.resultUnconfirmed', { error: error instanceof Error ? error.message : String(error) }));
            }
        } finally {
            this.planning = wasPlanning;
            if (!this.closed) { this.updateButtons(); this.schedule(); }
        }
    }

    private draft(id: string): DraftState {
        let state = this.drafts.get(id);
        if (!state) {
            state = { message: '', savedMessage: '', loaded: false, loading: false, saving: false, queued: false, edit: 0, error: '' };
            this.drafts.set(id, state);
            for (const [key, saved] of this.drafts) {
                if (this.drafts.size <= SESSION_DRAFT_LIMIT) break;
                if (key !== id && key !== this.repoId && saved.loaded && !saved.loading && !saved.saving && !saved.queued && !saved.timer && !saved.error && !saved.confirm && saved.message === saved.savedMessage) this.drafts.delete(key);
            }
        }
        return state;
    }

    private renderDraft(): void {
        if (this.closed) return;
        const state = this.draft(this.repoId), input = this.el<HTMLTextAreaElement>('message');
        if (input.value !== state.message) input.value = state.message;
        const dirty = state.message !== state.savedMessage;
        this.el('draft-status').textContent = state.confirm === 'reload' ? t('panel.draft.confirmReload')
            : state.confirm === 'clear' ? t('panel.draft.confirmClear')
            : state.error ? t('panel.draft.unsavedError', { error: state.error })
            : state.loading ? t('panel.draft.loading') : state.saving ? t('panel.draft.saving')
            : !state.loaded ? t('panel.draft.notLoaded') : dirty ? t('panel.draft.unsaved') : t('panel.draft.saved');
        this.el('draft-status').classList.toggle('draft-error', !!state.error);
        this.el('draft-status').hidden = state.loaded && !state.loading && !state.saving && !dirty && !state.error && !state.confirm && !state.message;
        setTooltipTitle(this.el('draft-status'), !dirty && state.loaded && !state.error && !state.confirm ? t('panel.draft.savedTooltip') : this.el('draft-status').textContent || '');
        this.el('commit-draft-tools').classList.toggle('draft-attention', !!state.error || !!state.confirm || !state.loaded || dirty);
        setActionLabel(this.el('draft-reload'), state.confirm === 'reload' ? t('panel.draft.confirmReloadButton') : t('panel.html.draft-reload'));
        setActionLabel(this.el('draft-clear'), state.confirm === 'clear' ? t('panel.draft.confirmClearButton') : t('panel.html.draft-clear'));
        this.el('draft-cancel').hidden = !state.confirm;
        this.el<HTMLButtonElement>('draft-save').disabled = state.loading || state.saving || !state.loaded || !!state.confirm;
        this.el<HTMLButtonElement>('draft-reload').disabled = state.loading || state.saving;
        this.el<HTMLButtonElement>('draft-clear').disabled = state.loading || state.saving || !state.loaded;
        if (this.layout) { this.renderContextualRegions(); this.layout.refresh(); }
        renderActionIcons(this.app);
    }

    private toggleLog(show = this.el('log').hidden): void {
        const visible = show && !!this.el('log').textContent;
        this.el('log').hidden = !visible; this.el('log-dialog').hidden = !visible;
        if (visible) this.el('log-close').focus();
        else this.el('toggle-log').focus();
    }

    private queueDraft(id: string): void {
        const state = this.draft(id);
        if (state.timer) clearTimeout(state.timer);
        state.timer = undefined;
        if (state.error || state.confirm || state.message === state.savedMessage) return;
        state.timer = setTimeout(() => { state.timer = undefined; void this.saveDraft(id); }, 650);
    }

    private async readDraft(id: string, replace = false): Promise<void> {
        const state = this.draft(id);
        if (state.loading || state.saving || (state.loaded && !replace)) return;
        if (state.timer) clearTimeout(state.timer);
        state.timer = undefined;
        const edit = state.edit;
        state.loading = true; state.error = ''; state.confirm = undefined;
        if (id === this.repoId) this.renderDraft();
        try {
            const saved = await request<CommitDraft>('details', id, { kind: 'draft', action: 'read' });
            if (replace && edit !== state.edit) throw new Error(t('panel.draft.changedDuringRead'));
            if (!saved || typeof saved.message !== 'string' || typeof saved.version !== 'string' || !saved.version) throw new Error(t('panel.draft.versionMismatch'));
            state.version = saved.version; state.savedMessage = saved.message; state.loaded = true;
            if (replace || state.edit === 0) state.message = saved.message;
        } catch (e) { state.error = e instanceof Error ? e.message : String(e); }
        finally {
            state.loading = false;
            if (id === this.repoId) this.renderDraft();
            if (!state.error && state.message !== state.savedMessage) void this.saveDraft(id);
        }
    }

    private async saveDraft(id: string, retry = false): Promise<void> {
        const state = this.draft(id);
        if (state.timer) clearTimeout(state.timer);
        state.timer = undefined;
        if (state.confirm || (state.error && !retry)) return;
        if (state.loading || state.saving) { state.queued = true; return; }
        if (!state.loaded || state.version === undefined) return;
        if (state.message.length > 5000 || state.message.includes('\0')) {
            state.error = t('panel.draft.tooLong');
            if (id === this.repoId) this.renderDraft();
            return;
        }
        if (!state.error && state.message === state.savedMessage) return;
        const message = state.message, version = state.version;
        state.error = ''; state.saving = true; state.queued = false;
        if (id === this.repoId) this.renderDraft();
        try {
            const saved = await request<CommitDraft>('details', id, { kind: 'draft', action: 'save', message, version });
            if (!saved || typeof saved.message !== 'string' || typeof saved.version !== 'string' || !saved.version) throw new Error(t('panel.draft.versionMismatch'));
            state.version = saved.version; state.savedMessage = saved.message;
        } catch (e) {
            state.error = t('panel.draft.saveFailed', { error: e instanceof Error ? e.message : String(e) });
        } finally {
            state.saving = false;
            if (id === this.repoId) this.renderDraft();
            if (!state.error && !state.confirm && (state.queued || state.message !== state.savedMessage)) void this.saveDraft(id);
        }
    }

    private async draftAction(action: 'reload' | 'clear'): Promise<void> {
        const id = this.repoId, state = this.draft(id);
        if (state.loading || state.saving) return;
        if (state.confirm !== action) {
            if (state.timer) clearTimeout(state.timer);
            state.timer = undefined; state.confirm = action; this.renderDraft(); return;
        }
        state.confirm = undefined;
        if (action === 'reload') { await this.readDraft(id, true); return; }
        state.message = ''; state.edit++; this.renderDraft();
        await this.saveDraft(id, true);
    }

    private async openAmend(): Promise<void> {
        const repo = this.details?.repo;
        if (!repo?.head || !repo.branch || repo.operation || repo.files.some(file => file.conflict) || this.busy || this.planning) return;
        this.cancelDialog();
        const target = { repo: this.repoId, revision: repo.head }, epoch = ++this.amendEpoch;
        this.amendTarget = target; this.amendLoading = true; this.amendBlocked = '';
        this.el('amend-title').textContent = t('panel.html.amend-title');
        this.el('amend-target').textContent = t('panel.amend.target', { path: repo.path, revision: target.revision });
        this.el('amend-note').textContent = t('panel.amend.loading');
        this.el<HTMLTextAreaElement>('amend-message').value = '';
        this.el('amend-modal').hidden = false; this.updateButtons();
        try {
            const commit = await request<CommitDetails>('history', target.repo, 0, { kind: 'commit', revision: target.revision });
            if (this.closed || epoch !== this.amendEpoch || this.repoId !== target.repo || this.amendTarget !== target) return;
            if (commit.sha !== target.revision) throw new Error(t('panel.amend.targetMismatch'));
            this.amendBlocked = commit.shallow ? t('panel.amend.shallow') : commit.parents.length > 1 ? t('panel.amend.mergeCommit') : '';
            const key = target.repo + '\0' + target.revision;
            if (!this.amendDrafts.has(key)) {
                for (const [oldKey, draft] of this.amendDrafts) {
                    if (this.amendDrafts.size < SESSION_DRAFT_LIMIT) break;
                    if (draft.message === draft.original) this.amendDrafts.delete(oldKey);
                }
                if (this.amendDrafts.size >= SESSION_DRAFT_LIMIT) throw new Error(t('panel.amend.draftLimit'));
                this.amendDrafts.set(key, { message: commit.message, original: commit.message });
            }
            this.el<HTMLTextAreaElement>('amend-message').value = this.amendDrafts.get(key)?.message || '';
            this.el('amend-note').textContent = this.amendBlocked || t('panel.amend.note');
        } catch (e) {
            if (!this.closed && epoch === this.amendEpoch) { this.amendTarget = undefined; this.el('amend-note').textContent = e instanceof Error ? e.message : String(e); }
        } finally {
            if (epoch === this.amendEpoch) {
                this.amendLoading = false; this.updateButtons();
                if (this.amendTarget && !this.closed) this.el<HTMLTextAreaElement>('amend-message').focus();
            }
        }
    }

    private openInput(action: 'createBranchAt' | 'createBranch' | 'checkoutRemote' | 'stashPush' | 'stashSelected' | 'renameBranch', origin?: Pick<Commit, 'sha' | 'subject'>): void {
        if (!this.details || this.busy || this.planning) return;
        if (action === 'createBranchAt' && (!origin || headState(this.details.repo) === 'unavailable')) return;
        const stashAction = action === 'stashPush' || action === 'stashSelected';
        const stashPaths = action === 'stashSelected' ? selectedWholeFiles(this.worklist().rendered, this.selected) : [];
        if (action === 'stashSelected' && (this.mode !== 'working' || this.workingSelectionLocked() || !stashPaths.length)) return;
        const target = action === 'renameBranch' ? this.branchTarget() : undefined;
        if (action === 'renameBranch' && (!target || target.current || target.worktree)) return;
        this.cancelDialog();
        this.inputAction = action;
        this.inputStash = action === 'stashSelected' ? { paths: stashPaths, selection: this.selectionEpoch } : undefined;
        this.inputRevision = action === 'createBranch' || action === 'createBranchAt' ? origin?.sha : undefined;
        this.inputBranch = target ? { name: target.name, sha: target.sha } : undefined;
        this.el('plan-patch').hidden = true;
        const remote = this.el<HTMLSelectElement>('remote-branch'); remote.replaceChildren();
        if (action === 'checkoutRemote') for (const branch of this.details.remoteBranches) remote.add(new Option(`${branch.name} · ${branch.sha.slice(0, 8)}`, branch.ref));
        this.el<HTMLInputElement>('branch-name').value = action === 'checkoutRemote' ? this.details.remoteBranches[0]?.branch || '' : target?.name || '';
        this.el('plan-title').textContent = action === 'stashSelected' ? t('panel.input.stashSelectedTitle') : action === 'stashPush' ? t('panel.input.stashPushTitle') : action === 'checkoutRemote' ? t('panel.input.checkoutRemoteTitle') : action === 'renameBranch' ? t('panel.input.renameBranchTitle') : action === 'createBranchAt' ? t('panel.input.createBranchAtTitle') : t('panel.input.createBranchTitle');
        this.el('plan-description').textContent = action === 'stashSelected' ? t('panel.input.stashSelectedDescription', { count: stashPaths.length })
            : action === 'stashPush' ? t('panel.input.stashPushDescription')
            : action === 'checkoutRemote' ? t('panel.input.checkoutRemoteDescription')
            : target ? t('panel.input.renameBranchDescription', { name: target.name, sha: target.sha, upstream: target.upstream || t('panel.upstream.unset') })
            : action === 'createBranchAt' && origin ? t('panel.input.createBranchAtDescription', { sha: origin.sha, subject: origin.subject.slice(0, 1000) })
            : origin ? t('panel.input.createBranchFromCommitDescription', { sha: origin.sha, subject: origin.subject })
            : t('panel.input.createBranchDescription', { branch: this.details.repo.branch || t('panel.detachedHead'), head: this.details.repo.head || t('panel.noCommitsYet') });
        this.el('plan-warnings').replaceChildren(); this.el('plan-files').hidden = true;
        this.el('branch-input-wrap').hidden = stashAction;
        this.el('remote-branch-wrap').hidden = action !== 'checkoutRemote';
        this.el('stash-input-wrap').hidden = !stashAction;
        this.el('stash-untracked-label').textContent = action === 'stashSelected' ? t('panel.input.includeSelectedUntracked') : t('panel.html.stash-untracked-label');
        this.el('modal').hidden = false; this.el('confirm').textContent = t('panel.confirm.preview');
        this.el<HTMLInputElement>(stashAction ? 'stash-message' : 'branch-name').focus();
        this.updateButtons();
    }

    private openProjectTool(action: ForkToolAction): void {
        if (!this.details || this.busy || this.planning) return;
        this.cancelDialog(); this.projectToolAction = action;
        this.el('plan-title').textContent = forkToolNames[action];
        this.el('plan-description').textContent = t('panel.input.projectToolDescription');
        this.el('plan-warnings').replaceChildren(); this.el('plan-patch').hidden = true;
        this.el('branch-input-label').textContent = t('panel.input.targetBranch');
        this.el('branch-input-wrap').hidden = false; this.el('project-tool-remote-wrap').hidden = false;
        for (const id of ['remote-branch-wrap', 'stash-input-wrap', 'upstream-input-wrap']) this.el(id).hidden = true;
        this.el<HTMLInputElement>('branch-name').value = this.details.repo.branch || '';
        this.el<HTMLInputElement>('project-tool-remote').value = this.el<HTMLSelectElement>('remote').value || '';
        this.el('confirm').textContent = t('panel.confirm.previewProjectTool'); this.el('modal').hidden = false;
        this.updateButtons(); this.el('branch-name').focus();
    }

    private cancelDialog(): void {
        this.closeFileMenu();
        this.projectToolAction = undefined; this.projectToolConfirmation = false;
        this.el('project-tool-remote-wrap').hidden = true; this.el('project-tool-confirm-wrap').hidden = true;
        this.el('branch-input-label').textContent = t('panel.html.branch-input-label');
        this.pendingWarnings = undefined; this.pendingUpdate = undefined;
        this.el('plan-files-wrap').hidden = true; this.el('plan-repositories-wrap').hidden = true;
        this.dialogEpoch++; this.el('modal').hidden = true; this.plan = undefined;
        this.inputAction = undefined; this.inputRevision = undefined; this.inputBranch = undefined;
        this.inputStash = undefined;
        this.inputUpstream = undefined; this.el('upstream-input-wrap').hidden = true;
        this.amendEpoch++; this.amendTarget = undefined; this.amendLoading = false; this.amendBlocked = '';
        this.el('amend-modal').hidden = true; this.el('plan-amend-edit').hidden = true;
        this.updateButtons();
    }

    private upstreamText(branch: Branch): string {
        const tracking = branch.tracking;
        const configured = branch.upstream || (tracking?.remote && tracking.merge ? `${tracking.remote} → ${tracking.merge}` : tracking?.merge || tracking?.remote || t('panel.upstream.unresolved'));
        if (!tracking) return branch.upstream || t('panel.upstream.unset');
        if (tracking.state === 'none') return t('panel.upstream.unset');
        if (tracking.state === 'gone') return t('panel.upstream.gone', { configured });
        if (tracking.state === 'invalid') return t('panel.upstream.invalid', { configured });
        const counts = tracking.ahead !== undefined && tracking.behind !== undefined ? t('panel.upstream.counts', { ahead: tracking.ahead, behind: tracking.behind }) : t('panel.upstream.countsUnavailable');
        return t('panel.upstream.summary', { configured, counts });
    }

    private openUpstream(): void {
        const target = this.branchTarget();
        if (!this.details || this.busy || this.planning || this.mode !== 'branches' || !target || (!target.current && target.worktree)) return;
        this.cancelDialog(); this.inputAction = 'setUpstream';
        this.inputBranch = { name: target.name, sha: target.sha };
        this.el('plan-title').textContent = t('panel.upstream.title');
        this.el('plan-description').textContent = t('panel.upstream.description', { name: target.name, sha: target.sha, upstream: this.upstreamText(target) });
        this.el('plan-warnings').replaceChildren();
        for (const id of ['plan-files', 'plan-patch', 'branch-input-wrap', 'remote-branch-wrap', 'stash-input-wrap']) this.el(id).hidden = true;
        this.el<HTMLInputElement>('upstream-filter').value = '';
        this.el('upstream-input-wrap').hidden = false;
        this.el('modal').hidden = false; this.el('confirm').textContent = t('panel.confirm.previewUpstream');
        this.renderUpstreamChoices(); this.el<HTMLInputElement>('upstream-filter').focus();
    }

    private renderUpstreamChoices(): void {
        const list = this.el('upstream-list'), scrollTop = list.scrollTop; list.replaceChildren();
        const filter = this.el<HTMLInputElement>('upstream-filter').value.toLowerCase();
        const all = this.details?.remoteBranches || [];
        const previous = this.inputUpstream;
        if (previous && !all.some(branch => branch.ref === previous.ref && branch.sha === previous.sha)) this.inputUpstream = undefined;
        const selectedUpstream = this.inputUpstream;
        const branches = all.filter(branch => [branch.name, branch.ref, branch.sha].some(value => value.toLowerCase().includes(filter)));
        for (const branch of branches) {
            const row = document.createElement('button');
            const selected = branch.ref === selectedUpstream?.ref && branch.sha === selectedUpstream.sha;
            row.className = 'upstream-row' + (selected ? ' active' : '');
            row.setAttribute('aria-pressed', String(selected)); row.dataset.upstreamChoice = '';
            setTooltipTitle(row, `${branch.ref}\n${branch.sha}`);
            const name = document.createElement('strong'); name.textContent = branch.name;
            const sha = document.createElement('small'); sha.textContent = branch.sha;
            row.append(name, sha);
            row.addEventListener('click', () => {
                if (this.inputAction !== 'setUpstream' || this.planning || this.busy) return;
                this.inputUpstream = { ref: branch.ref, name: branch.name, sha: branch.sha };
                this.renderUpstreamChoices();
                this.el('upstream-list').querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
            });
            list.append(row);
        }
        if (!branches.length) {
            const empty = document.createElement('p'); empty.className = 'empty';
            empty.textContent = all.length ? t('panel.upstream.noMatch') : t('panel.upstream.noneCached'); list.append(empty);
        }
        list.scrollTop = scrollTop;
        this.el('upstream-selection').textContent = this.inputUpstream ? t('panel.upstream.selection', { name: this.inputUpstream.name, ref: this.inputUpstream.ref, sha: this.inputUpstream.sha }) : t('panel.html.upstream-selection');
        this.updateButtons();
    }

    private tagLocked(): boolean {
        return this.mode !== 'tags' || this.busy || this.planning || !this.details || this.tagLoading || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden);
    }

    private clearTags(): void {
        this.tagEpoch++;
        if (this.tagTimer) clearTimeout(this.tagTimer);
        this.tagTimer = undefined; this.tagPage = undefined; this.selectedTag = undefined;
        this.tagLoading = false; this.tagError = '';
        this.el('tags-list').replaceChildren(); this.el('tag-selection').textContent = t('panel.html.tag-selection');
        this.el('tags-status').textContent = t('panel.tags.notRead'); this.el('tags-page').textContent = '';
    }

    private async loadTags(offset = 0, version?: string): Promise<void> {
        if (!this.details || this.mode !== 'tags' || this.closed || this.busy || this.planning) return;
        if (this.tagTimer) clearTimeout(this.tagTimer);
        this.tagTimer = undefined;
        const epoch = ++this.tagEpoch, repo = this.repoId;
        const text = this.el<HTMLInputElement>('tags-filter').value;
        this.cancelDialog(); this.tagLoading = true; this.tagError = '';
        this.tagPage = undefined; this.selectedTag = undefined; this.renderTags();
        try {
            const page = await request<TagPage>('details', repo, { kind: 'tags', offset, limit: 100, text, version });
            if (this.closed || epoch !== this.tagEpoch || repo !== this.repoId || this.mode !== 'tags') return;
            this.tagPage = page;
        } catch (error) {
            if (this.closed || epoch !== this.tagEpoch || repo !== this.repoId || this.mode !== 'tags') return;
            this.tagError = t('panel.tags.readFailed', { error: error instanceof Error ? error.message : String(error) });
        } finally {
            if (!this.closed && epoch === this.tagEpoch && repo === this.repoId && this.mode === 'tags') { this.tagLoading = false; this.renderTags(); }
        }
    }

    private renderTagControls(): void {
        const locked = this.tagLocked(), page = this.tagPage, selected = this.selectedTag;
        const annotated = this.el<HTMLSelectElement>('tag-kind').value === 'annotated';
        setControlValue(this.el('tag-message-wrap'), 'hidden', !annotated);
        this.el<HTMLInputElement>('tag-target').value = this.tagTarget?.repo === this.repoId ? this.tagTarget.sha : '';
        for (const id of ['tag-name', 'tag-kind', 'tag-message']) this.setDisabled(this.el<HTMLInputElement>(id), locked);
        this.setDisabled(this.el<HTMLInputElement>('tags-filter'), this.busy || this.planning || !this.details || !this.el('modal').hidden);
        this.setDisabled(this.el<HTMLButtonElement>('tags-refresh'), locked);
        this.setDisabled(this.el<HTMLButtonElement>('tags-prev'), locked || !page || page.offset === 0);
        this.setDisabled(this.el<HTMLButtonElement>('tags-next'), locked || page?.nextOffset === undefined);
        this.setDisabled(this.el<HTMLButtonElement>('tag-use-head'), locked || !this.details?.repo.head);
        this.setDisabled(this.el<HTMLButtonElement>('tag-create'), locked || !this.el<HTMLInputElement>('tag-name').value || this.tagTarget?.repo !== this.repoId || !this.tagTarget?.sha || (annotated && !this.el<HTMLTextAreaElement>('tag-message').value.trim()));
        this.setDisabled(this.el<HTMLButtonElement>('tag-delete'), locked || !selected || selected.kind === 'symbolic');
        this.setDisabled(this.el<HTMLButtonElement>('tag-view'), locked || !selected?.commit);
        this.setDisabled(this.el<HTMLButtonElement>('history-new-tag'), this.busy || this.planning || this.mode !== 'history' || this.historyLoading || !this.commits.some(commit => commit.sha === this.revision));
        for (const button of this.app.querySelectorAll<HTMLButtonElement>('[data-tag-choice]')) this.setDisabled(button, locked);
    }

    private renderTags(): void {
        const list = this.el('tags-list'), scrollTop = list.scrollTop; list.replaceChildren();
        const page = this.tagPage;
        this.el('tags-status').textContent = this.tagLoading ? t('panel.tags.loading') : this.tagError || (page ? t('panel.tags.status', { total: page.total, count: page.tagCount, capturedAt: page.capturedAt }) : t('panel.tags.notRead'));
        this.el('tags-page').textContent = page ? t('panel.tags.page', { page: Math.floor(page.offset / page.limit) + 1, shown: page.tags.length, limit: page.limit }) : '';
        for (const tag of page?.tags || []) {
            const button = document.createElement('button'); button.dataset.tagChoice = '';
            const selected = tag.ref === this.selectedTag?.ref && tag.object === this.selectedTag.object;
            button.className = 'tag-row' + (selected ? ' active' : '');
            button.setAttribute('aria-pressed', String(selected)); setTooltipTitle(button, tag.ref + '\n' + tag.object);
            const name = document.createElement('strong'); name.textContent = tag.name;
            const info = document.createElement('small');
            info.textContent = `${tag.kind === 'annotated' ? t('panel.tags.kindAnnotated') : tag.kind === 'symbolic' ? t('panel.tags.kindSymbolic') : t('panel.tags.kindLightweight')} · ${tag.commit ? t('panel.tags.commitTarget', { sha: tag.commit.slice(0, 12) }) : t('panel.tags.targetType', { type: tag.targetType || t('panel.unknown') })}`;
            button.append(name, info);
            button.addEventListener('click', () => {
                if (this.tagLocked()) return;
                this.cancelDialog(); this.selectedTag = { ...tag }; this.renderTags();
                this.el('tags-list').querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus({ preventScroll: true });
            });
            list.append(button);
        }
        if (page && !page.tags.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = page.total ? t('panel.tags.pageEmpty') : t('panel.tags.noMatch'); list.append(empty); }
        const tag = this.selectedTag;
        this.el('tag-selection').textContent = tag ? t('panel.tags.selection', { ref: tag.ref, object: tag.object, objectType: tag.objectType, target: tag.target || t('panel.tags.unreadable'), targetType: tag.targetType || t('panel.unknown') }) + (tag.symbolic ? t('panel.tags.symbolicTarget', { target: tag.symbolic }) : '') + (tag.commit ? '' : t('panel.tags.noCommitView')) : t('panel.html.tag-selection');
        list.scrollTop = scrollTop;
        this.renderTagControls();
    }

    private async prepareTag(action: 'createTag' | 'deleteTag'): Promise<void> {
        if (this.tagLocked() || !this.details) return;
        const tag = this.selectedTag, target = this.tagTarget;
        if (action === 'deleteTag' && (!tag || tag.kind === 'symbolic')) return;
        if (action === 'createTag' && (!target || target.repo !== this.repoId)) return;
        const epoch = this.epoch, tagEpoch = this.tagEpoch, dialogEpoch = this.dialogEpoch;
        const kind = this.el<HTMLSelectElement>('tag-kind').value;
        if (kind !== 'lightweight' && kind !== 'annotated') return;
        const operation: OperationRequest = { repo: this.repoId, version: this.details.repo.version, action,
            tag: action === 'deleteTag' ? tag!.name : this.el<HTMLInputElement>('tag-name').value,
            tagObject: action === 'deleteTag' ? tag!.object : undefined,
            tagKind: action === 'createTag' ? kind : undefined, revision: action === 'createTag' ? target!.sha : undefined,
            message: action === 'createTag' && kind === 'annotated' ? this.el<HTMLTextAreaElement>('tag-message').value : undefined };
        this.planning = true; this.updateButtons();
        try {
            const plan = await this.requestPlan(operation);
            if (!plan) return;
            if (this.closed || epoch !== this.epoch || tagEpoch !== this.tagEpoch || dialogEpoch !== this.dialogEpoch || this.mode !== 'tags') return;
            this.plan = plan; this.inputAction = undefined;
            this.el('plan-title').textContent = plan.title; this.el('plan-description').textContent = plan.description;
            this.el('plan-files').hidden = true; this.el('plan-patch').hidden = true; this.el('plan-amend-edit').hidden = true;
            for (const id of ['branch-input-wrap', 'remote-branch-wrap', 'stash-input-wrap', 'upstream-input-wrap']) this.el(id).hidden = true;
            this.renderPlanWarnings(plan, action);
            this.el('confirm').textContent = action === 'deleteTag' ? t('panel.confirm.deleteTag') : t('panel.confirm.createTag');
            this.el('modal').hidden = false;
        } catch (error) {
            if (!this.closed && epoch === this.epoch && tagEpoch === this.tagEpoch && dialogEpoch === this.dialogEpoch) this.error(error);
        } finally { this.planning = false; this.updateButtons(); }
    }

    private clearTree(deactivate = true): void {
        this.treeEpoch++;
        if (this.treeTimer) clearTimeout(this.treeTimer);
        this.treeTimer = undefined; this.treePage = undefined; this.treeDirectory = ''; this.treeError = ''; this.treeLoading = false;
        if (deactivate) this.treeActive = false;
        this.el<HTMLInputElement>('tree-filter').value = '';
        this.el('tree-tools').hidden = !this.treeActive;
    }

    private async loadTree(directory: string, offset = 0, version?: string): Promise<void> {
        if (this.closed || !this.treeActive || this.mode !== 'history' || !this.details || !this.revision || this.busy || this.planning) return;
        if (this.treeTimer) clearTimeout(this.treeTimer);
        this.treeTimer = undefined;
        if (directory !== this.treeDirectory) this.el<HTMLInputElement>('tree-filter').value = '';
        const epoch = ++this.treeEpoch, repo = this.repoId, revision = this.revision;
        this.treeDirectory = directory; this.treePage = undefined; this.treeError = ''; this.treeLoading = true;
        this.cancelDialog(); this.clearBlame(); this.diffEpoch++; this.currentDiff = undefined; this.currentFile = undefined; this.diffLoading = false;
        this.renderFiles(); this.renderDiff(); this.updateButtons();
        try {
            const page = await request<TreePage>('details', repo, { kind: 'tree', revision, directory, text: this.el<HTMLInputElement>('tree-filter').value, offset, limit: 100, version });
            if (this.closed || epoch !== this.treeEpoch || this.repoId !== repo || this.revision !== revision || !this.treeActive || this.mode !== 'history') return;
            this.treePage = page;
        } catch (error) {
            if (this.closed || epoch !== this.treeEpoch || this.repoId !== repo || this.revision !== revision) return;
            this.treeError = t('panel.tree.readFailed', { error: error instanceof Error ? error.message : String(error) });
        } finally {
            if (!this.closed && epoch === this.treeEpoch) { this.treeLoading = false; this.renderFiles(); this.updateButtons(); }
        }
    }

    private renderTree(): void {
        const list = this.el('file-list'), top = list.scrollTop;
        const focused = this.app.ownerDocument.activeElement;
        const focusedPath = focused instanceof HTMLElement && list.contains(focused) ? focused.dataset.treePath : undefined;
        list.replaceChildren();
        this.el('tree-location').textContent = t('panel.tree.location', { revision: this.revision, directory: this.treeDirectory });
        this.el('tree-note').textContent = this.treeLoading ? t('panel.tree.loading') : this.treeError || (this.treePage ? t('panel.tree.status', { total: this.treePage.total, shown: this.treePage.entries.length }) : t('panel.tree.notRead'));
        this.el('tree-page').textContent = this.treePage ? t('panel.pageNumber', { page: Math.floor(this.treePage.offset / this.treePage.limit) + 1 }) : '';
        this.el('file-pagination').hidden = true;
        const labels = { directory: t('panel.tree.directory'), file: t('panel.tree.file'), executable: t('panel.tree.executable'), symlink: t('panel.tree.symlink'), submodule: t('panel.tree.submodule') };
        for (const entry of this.treePage?.entries || []) {
            const row = document.createElement('div'); row.dataset.treePath = entry.path; row.className = 'tree-row' + (entry.path === this.currentFile?.path ? ' active' : '');
            row.dataset.fileArea = 'tree';
            row.setAttribute('role', 'button'); row.setAttribute('aria-label', labels[entry.kind] + ' ' + entry.name);
            setTooltipTitle(row, entry.path + '\n' + entry.object + '\n' + t('panel.tree.mode', { mode: entry.mode }));
            const kind = document.createElement('span'); kind.className = 'tree-kind'; kind.textContent = labels[entry.kind];
            const name = document.createElement('span'); name.className = 'tree-name'; name.textContent = entry.name;
            row.append(kind, name); this.bindFileMenu(row, entry.path, true, entry.kind === 'directory' ? undefined : { revision: this.revision, path: entry.path });
            row.addEventListener('click', event => {
                if (event.detail > 1) return;
                if (this.busy || this.planning || this.treeLoading || !this.el('modal').hidden) return;
                if (entry.kind === 'directory') void this.loadTree(entry.path);
                else void this.guard(() => this.showDiff(entry.path, 'tree'));
            });
            list.append(row);
        }
        if (this.treePage && !this.treePage.entries.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = t('panel.tree.noMatch'); list.append(empty); }
        list.scrollTop = top;
        if (focusedPath) [...list.querySelectorAll<HTMLElement>('[data-tree-path]')].find(row => row.dataset.treePath === focusedPath)?.focus({ preventScroll: true });
    }

    private async requestPlan(operation: OperationRequest, valid?: () => boolean): Promise<Plan | undefined> {
        const epoch = this.epoch, dialog = this.dialogEpoch, selection = this.selectionEpoch, diff = this.diffEpoch;
        const repo = this.repoId, original = this.details?.repo;
        const current = () => !this.closed && epoch === this.epoch && dialog === this.dialogEpoch
            && selection === this.selectionEpoch && diff === this.diffEpoch && repo === this.repoId && (!valid || valid());
        try { return await request<Plan>('prepare', operation); }
        catch (error) {
            if (!(error instanceof EditorPreparationRequestError)) throw error;
            if (!current() || !original) return;
            this.el('notice').hidden = true;
            if (!await request<boolean>('prepare-editor', error.worktreeChange) || !current()) return;
            const details = await request<RepoDetails>('details', repo);
            if (!current()) return;
            if (details.repo.head !== original.head || details.repo.branch !== original.branch || details.repo.path !== original.path) throw new Error(t('panel.resumeStateChanged'));
            this.details = details;
            if (this.snapshot) this.snapshot.repositories = this.snapshot.repositories.map(item => item.id === repo ? details.repo : item);
            this.renderRepos();
            if (this.mode === 'working') this.renderFiles();
            this.updateButtons();
            this.el('notice').hidden = true;
            // Save changes the repo version; fixed paths, revisions and line versions stay fixed.
            return await request<Plan>('prepare', { ...operation, version: details.repo.version });
        }
    }

    private renderPlanWarnings(plan: Plan, action: Action): void {
        this.projectToolConfirmation = action === 'forkResetPreferred' || action === 'forkResetDev';
        this.el('project-tool-confirm-wrap').hidden = !this.projectToolConfirmation;
        this.el<HTMLInputElement>('project-tool-confirm').value = '';
        this.el('plan-description').textContent = plan.descriptionSummary || plan.description;
        for (const [name, items, label] of [['files', plan.paths, t('panel.plan.files')], ['repositories', plan.repositories || [], t('panel.plan.repositories')]] as const) {
            const scope = this.el<HTMLDetailsElement>('plan-' + name + '-wrap');
            scope.hidden = !items.length; scope.open = name === 'repositories';
            this.el('plan-' + name + '-count').textContent = label + ' · ' + items.length;
            this.el('plan-' + name).textContent = items.join('\n');
            this.el('plan-' + name).hidden = !items.length;
        }
        this.pendingUpdate = action === 'updateAll' && plan.repeatConfirmationKey ? { token: plan.token, key: plan.repeatConfirmationKey } : undefined;
        const box = this.el('plan-warnings'); box.replaceChildren();
        if (this.pendingUpdate && !this.warningPreferences.confirmedUpdate(this.pendingUpdate.key)) {
            const note = document.createElement('p'); note.className = 'confirmation-policy';
            note.textContent = t('panel.plan.rememberNote');
            box.append(note);
        }
        const grouped = groupPlanWarnings(plan, this.warningPreferences.read(action));
        this.pendingWarnings = { token: plan.token, action, warnings: grouped.general };
        for (const text of grouped.fresh) {
            const row = document.createElement('p'); row.textContent = text; box.append(row);
        }
        if (grouped.known.length) {
            const details = document.createElement('details'), summary = document.createElement('summary');
            details.className = 'update-warning-details'; summary.textContent = t('panel.plan.notesSummary');
            setTooltipTitle(summary, t('panel.plan.notesTooltip')); details.append(summary);
            for (const text of grouped.known) {
                const row = document.createElement('p'); row.textContent = text; details.append(row);
            }
            box.append(details);
        }
    }

    private async prepareWorktreeOperation(operation: OperationRequest, valid?: () => boolean, forceConfirmation = false): Promise<void> {
        if(this.closed || !this.details || this.busy || this.planning || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden))return;
        this.cancelDialog();const epoch=this.epoch,repo=this.repoId,dialog=this.dialogEpoch;
        this.planning=true;this.updateButtons();
        if (operation.action === 'updateAll') this.el('status').textContent = t('panel.checkingRepositories');
        try {
            const plan=await this.requestPlan(operation,valid);
            if(!plan){if(operation.action==='updateAll')this.el('modal').hidden=true;return;}
            if(this.closed || epoch!==this.epoch || repo!==this.repoId || dialog!==this.dialogEpoch || (valid && !valid()))return;
            if (!forceConfirmation && canRepeatUpdate(operation.action, plan, !!plan.repeatConfirmationKey && this.warningPreferences.confirmedUpdate(plan.repeatConfirmationKey), this.warningPreferences.read(operation.action))) {
                await this.executePlan(plan); return;
            }
            this.plan=plan;this.inputAction=undefined;
            this.el('plan-title').textContent=plan.title;this.el('plan-description').textContent=plan.description;
            this.el('plan-files').textContent=plan.paths.join('\n');this.el('plan-files').hidden=!plan.paths.length;this.el('plan-patch').textContent=plan.patch || '';this.el('plan-patch').hidden=!plan.patch;this.el('plan-amend-edit').hidden=true;
            for(const id of ['branch-input-wrap','remote-branch-wrap','stash-input-wrap','upstream-input-wrap'])this.el(id).hidden=true;
            this.renderPlanWarnings(plan, operation.action);
            this.el('confirm').textContent = operation.action.startsWith('fork')?t('panel.confirm.projectTool'):operation.action==='updateAll'?t('panel.confirm.updateAll'):operation.action==='merge'?t('panel.confirm.merge'):operation.action==='beginMerge'?t('panel.confirm.beginMerge'):operation.action==='abortMerge'?t('panel.confirm.abortMerge'):operation.action==='discardLines'?t('panel.confirm.discardLines'):operation.action==='discardFiles'?t('panel.confirm.discardFiles'):operation.action==='restoreStashFiles'?t('panel.confirm.restoreStashFiles'):t('panel.confirm.restoreFiles');
            this.el('modal').hidden=false;
        }catch(error){if(epoch===this.epoch && dialog===this.dialogEpoch && !this.closed){ if(operation.action==='updateAll')this.el('modal').hidden=true; this.error(error); }}
        finally{this.planning=false;this.updateButtons();}
    }

    private clearReflog(): void {
        if (this.reflogTimer) clearTimeout(this.reflogTimer);
        this.reflogTimer = undefined; this.reflogEpoch++; this.reflogPage = undefined; this.reflogSelected = undefined;
        this.reflogLoading = false; this.reflogError = ''; this.el('reflog-list').replaceChildren();
        this.renderReflogControls();
    }

    private async loadReflog(offset = 0, version?: string): Promise<void> {
        if (this.closed || this.el('reflog-workspace').hidden || !this.details || this.busy || this.planning || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden)) return;
        if (this.reflogTimer) clearTimeout(this.reflogTimer);
        this.reflogTimer = undefined;
        const refSelect = this.el<HTMLSelectElement>('reflog-ref'), previous = refSelect.value || 'HEAD'; refSelect.replaceChildren();
        const sources = reflogSources(this.details, this.el<HTMLInputElement>('reflog-source-filter').value);
        for (const source of sources.options) refSelect.add(new Option(source.label, source.ref));
        this.el('reflog-source-note').textContent = t('panel.reflog.sourceNote', { matched: sources.matched, truncated: sources.truncated ? t('panel.reflog.sourceTruncated') : '' });
        refSelect.value = [...refSelect.options].some(option => option.value === previous) ? previous : 'HEAD';
        const epoch = ++this.reflogEpoch, repo = this.repoId, ref = refSelect.value, text = this.el<HTMLInputElement>('reflog-filter').value;
        this.cancelDialog(); this.reflogPage = undefined; this.reflogSelected = undefined; this.reflogLoading = true; this.reflogError = '';
        this.el('reflog-list').replaceChildren(); this.renderReflogControls();
        try {
            const page = await request<ReflogPage>('details', repo, { kind: 'reflog', ref, text, offset, limit: 20, version });
            if (this.closed || epoch !== this.reflogEpoch || repo !== this.repoId) return;
            this.reflogPage = page;
            for (const entry of page.entries) {
                const button = document.createElement('button'); button.className = 'reflog-entry';
                const heading = document.createElement('span'); heading.className = 'reflog-entry-heading';
                const date = document.createElement('time'); date.dateTime = entry.date; date.textContent = entry.date;
                const hash = document.createElement('code'); hash.textContent = entry.revision.slice(0, 12); heading.append(date, hash);
                const subject = document.createElement('span'); subject.textContent = entry.subject + (entry.subjectTruncated ? t('panel.reflog.subjectTruncated') : '');
                const person = document.createElement('small'); person.textContent = `${entry.actor} <${entry.email}>${entry.identityTruncated ? t('panel.reflog.identityTruncated') : ''}`;
                setTooltipTitle(button, entry.selector + '\n' + entry.revision); button.append(heading, subject, person);
                button.addEventListener('click', () => {
                    if (this.busy || this.planning || this.reflogLoading || this.reflogPage !== page || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden)) return;
                    this.cancelDialog(); this.reflogSelected = entry;
                    for (const item of this.el('reflog-list').children) item.classList.toggle('active', item === button);
                    this.renderReflogControls(); void this.guard(() => this.showCommitDetails(entry.revision));
                });
                this.el('reflog-list').append(button);
            }
        } catch (error) { if (!this.closed && epoch === this.reflogEpoch) this.reflogError = t('panel.readFailedRestart', { error: error instanceof Error ? error.message : String(error) }); }
        finally { if (!this.closed && epoch === this.reflogEpoch) { this.reflogLoading = false; this.renderReflogControls(); } }
    }

    private renderReflogControls(): void {
        const page = this.reflogPage, selected = this.reflogSelected;
        const locked = this.closed || this.busy || this.planning || this.reflogLoading || !this.details || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden);
        this.setDisabled(this.el<HTMLButtonElement>('manage-reflog'), this.closed || this.busy || this.planning || !this.details || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden));
        this.setDisabled(this.el<HTMLButtonElement>('reflog-read'), locked);
        this.setDisabled(this.el<HTMLButtonElement>('reflog-prev'), locked || !page || page.offset === 0);
        this.setDisabled(this.el<HTMLButtonElement>('reflog-next'), locked || page?.nextOffset === undefined);
        this.setDisabled(this.el<HTMLSelectElement>('reflog-ref'), locked);
        this.setDisabled(this.el<HTMLInputElement>('reflog-source-filter'), this.closed || this.busy || this.planning || !this.details || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden));
        this.setDisabled(this.el<HTMLInputElement>('reflog-filter'), this.closed || this.busy || this.planning || !this.details || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden));
        this.setDisabled(this.el<HTMLInputElement>('reflog-branch'), locked);
        this.setDisabled(this.el<HTMLButtonElement>('reflog-create'), locked || !page || !selected || !this.el<HTMLInputElement>('reflog-branch').value.trim());
        setControlValue(this.el('reflog-note'), 'textContent', this.reflogLoading ? t('panel.reflog.loading') : this.reflogError || (page ? t('panel.reflog.status', { ref: page.ref, sampled: page.sampled, total: page.total, page: Math.floor(page.offset / page.limit) + 1, truncated: page.truncated ? t('panel.reflog.truncated') : '', unavailable: !page.available ? t('panel.reflog.unavailable') : '' }) : t('panel.reflog.intro')));
        setControlValue(this.el('reflog-selection'), 'textContent', selected ? t('panel.reflog.selection', { revision: selected.revision, selector: selected.selector }) : t('panel.reflog.selectEntry'));
    }

    private async prepareReflogBranch(): Promise<void> {
        const page = this.reflogPage, entry = this.reflogSelected;
        if (this.closed || !page || !entry || this.busy || this.planning || this.reflogLoading || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden)) return;
        const epoch = this.reflogEpoch, repo = this.repoId, dialogEpoch = this.dialogEpoch;
        const operation: OperationRequest = { repo, version: page.repoVersion, action: 'createBranchAt', branch: this.el<HTMLInputElement>('reflog-branch').value.trim(), revision: entry.revision };
        this.planning = true; this.updateButtons();
        try {
            const plan = await this.requestPlan(operation);
            if (!plan) return;
            if (this.closed || epoch !== this.reflogEpoch || repo !== this.repoId || dialogEpoch !== this.dialogEpoch) return;
            this.plan = plan; this.inputAction = undefined; this.inputStash = undefined;
            this.el('plan-title').textContent = plan.title; this.el('plan-description').textContent = plan.description;
            this.el('plan-files').hidden = true; this.el('plan-patch').hidden = true; this.el('plan-amend-edit').hidden = true;
            for (const id of ['branch-input-wrap', 'remote-branch-wrap', 'stash-input-wrap', 'upstream-input-wrap']) this.el(id).hidden = true;
            this.renderPlanWarnings(plan, 'createBranchAt');
            this.el('confirm').textContent = t('panel.confirm.createBranchAt'); this.el('modal').hidden = false;
        } catch (error) { if (!this.closed && epoch === this.reflogEpoch && repo === this.repoId && dialogEpoch === this.dialogEpoch) { this.reflogError = error instanceof Error ? error.message : String(error); this.error(error); } }
        finally { this.planning = false; this.updateButtons(); }
    }

    private resetRemotes(): void {
        this.remoteEpoch++; this.remotePage = undefined; this.remoteSelection = undefined;
        this.remoteAdding = false; this.remoteLoading = false; this.remoteError = '';
        this.el('remote-config-list').replaceChildren();
        this.el('remote-config-note').textContent = t('panel.remotes.notRead');
        this.renderRemoteControls();
    }

    private async loadRemotes(offset = 0, version?: string): Promise<void> {
        if (this.closed || !this.details || this.busy || this.planning || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden)) return;
        const epoch = ++this.remoteEpoch, repo = this.repoId;
        this.cancelDialog(); this.remoteLoading = true; this.remoteError = '';
        this.remotePage = undefined; this.remoteSelection = undefined; this.remoteAdding = false;
        this.el('remote-config-list').replaceChildren(); this.renderRemoteControls();
        try {
            const page = await request<RemotePage>('details', repo, { kind: 'remotes', offset, limit: 20, version });
            if (this.closed || epoch !== this.remoteEpoch || repo !== this.repoId) return;
            this.remotePage = page;
            for (const entry of page.entries) {
                const button = document.createElement('button'); button.className = 'remote-entry';
                const name = document.createElement('b'); name.textContent = entry.name;
                const addresses = document.createElement('span');
                addresses.textContent = t('panel.remotes.addresses', { fetchCount: entry.fetchCount, fetch: entry.fetchUrls.join(' · ') || t('panel.remotes.notConfigured'), push: entry.pushUsesFetch ? t('panel.remotes.pushFollowsFetch') : entry.pushUrls.join(' · '), pushCount: entry.pushCount > 1 ? t('panel.remotes.pushCount', { count: entry.pushCount }) : '' });
                const note = document.createElement('small'); note.textContent = entry.reason || t('panel.remotes.editable');
                button.append(name, addresses, note);
                button.addEventListener('click', () => {
                    if (this.busy || this.planning || this.remoteLoading || !this.el('modal').hidden || this.remotePage !== page) return;
                    this.cancelDialog(); this.remoteSelection = entry; this.remoteAdding = false;
                    this.el<HTMLInputElement>('remote-name').value = entry.name;
                    this.el<HTMLInputElement>('remote-url').value = entry.editable ? entry.fetchUrls[0] || '' : '';
                    for (const item of this.el('remote-config-list').children) item.classList.toggle('active', item === button);
                    this.renderRemoteControls();
                });
                this.el('remote-config-list').append(button);
            }
        } catch (error) { if (!this.closed && epoch === this.remoteEpoch) this.remoteError = t('panel.readFailedRestart', { error: error instanceof Error ? error.message : String(error) }); }
        finally { if (!this.closed && epoch === this.remoteEpoch) { this.remoteLoading = false; this.renderRemoteControls(); } }
    }

    private renderRemoteControls(): void {
        const page = this.remotePage, selected = this.remoteSelection;
        const locked = this.closed || this.busy || this.planning || this.remoteLoading || !this.details || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden);
        const url = this.el<HTMLInputElement>('remote-url').value;
        this.el<HTMLInputElement>('remote-name').readOnly = !this.remoteAdding;
        this.setDisabled(this.el<HTMLInputElement>('remote-name'), locked || !this.remoteAdding);
        this.setDisabled(this.el<HTMLInputElement>('remote-url'), locked || !(this.remoteAdding ? page?.canAdd : selected?.editable));
        this.setDisabled(this.el<HTMLButtonElement>('remote-read'), locked);
        this.setDisabled(this.el<HTMLButtonElement>('remote-prev'), locked || !page || page.offset === 0);
        this.setDisabled(this.el<HTMLButtonElement>('remote-next'), locked || page?.nextOffset === undefined);
        this.setDisabled(this.el<HTMLButtonElement>('remote-add-mode'), locked || !page?.canAdd);
        this.setDisabled(this.el<HTMLButtonElement>('remote-add'), locked || !this.remoteAdding || !page?.canAdd || !url || !this.el<HTMLInputElement>('remote-name').value);
        for (const id of ['remote-set-fetch', 'remote-set-push']) this.setDisabled(this.el<HTMLButtonElement>(id), locked || this.remoteAdding || !selected?.editable || !url);
        this.setDisabled(this.el<HTMLButtonElement>('remote-reset-push'), locked || this.remoteAdding || !selected?.editable || selected.pushUsesFetch);
        setControlValue(this.el('remote-config-note'), 'textContent', this.remoteLoading ? t('panel.remotes.loading') : this.remoteError || page?.reason || (page ? t('panel.remotes.status', { total: page.total, shown: page.entries.length, page: Math.floor(page.offset / page.limit) + 1, state: this.remoteAdding ? t('panel.remotes.adding') : selected ? t('panel.remotes.selected', { name: selected.name, reason: selected.reason || '' }) : t('panel.remotes.selectFirst') }) : t('panel.remotes.notRead')));
    }

    private async prepareRemote(action: 'addRemote' | 'setRemoteUrl' | 'setRemotePushUrl' | 'resetRemotePushUrl'): Promise<void> {
        const page = this.remotePage;
        if (!page || this.closed || this.busy || this.planning || this.remoteLoading || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden)) return;
        if (action === 'addRemote' ? !this.remoteAdding || !page.canAdd : this.remoteAdding || !this.remoteSelection?.editable) return;
        const epoch = this.remoteEpoch, dialogEpoch = this.dialogEpoch, repo = this.repoId;
        const operation: OperationRequest = { repo, version: page.repoVersion, remoteVersion: page.remoteVersion, action,
            remote: action === 'addRemote' ? this.el<HTMLInputElement>('remote-name').value : this.remoteSelection!.name,
            ...(action === 'resetRemotePushUrl' ? {} : { url: this.el<HTMLInputElement>('remote-url').value }) };
        this.planning = true; this.updateButtons();
        try {
            const plan = await this.requestPlan(operation);
            if (!plan) return;
            if (this.closed || epoch !== this.remoteEpoch || dialogEpoch !== this.dialogEpoch || repo !== this.repoId) return;
            this.plan = plan; this.inputAction = undefined; this.inputStash = undefined;
            this.el('plan-title').textContent = plan.title; this.el('plan-description').textContent = plan.description;
            this.el('plan-files').hidden = true; this.el('plan-patch').hidden = true; this.el('plan-amend-edit').hidden = true;
            for (const id of ['branch-input-wrap', 'remote-branch-wrap', 'stash-input-wrap', 'upstream-input-wrap']) this.el(id).hidden = true;
            this.renderPlanWarnings(plan, action);
            this.el('confirm').textContent = t('panel.confirm.remoteConfig'); this.el('modal').hidden = false;
        } catch (error) { if (!this.closed && epoch === this.remoteEpoch && dialogEpoch === this.dialogEpoch) { this.remoteError = error instanceof Error ? error.message : String(error); this.error(error); } }
        finally { this.planning = false; this.updateButtons(); }
    }

    private resetMerge(): void {
        this.mergeEpoch++; this.mergeView = undefined; this.mergeLoading = false; this.mergeError = ''; this.mergeKey = '';
        this.el<HTMLTextAreaElement>('merge-message').value = '';
        this.el<HTMLInputElement>('merge-pointers').checked = false;
    }

    private async readMerge(): Promise<void> {
        if (!this.details || this.busy || this.planning || this.mode !== 'working' || this.closed) return;
        const epoch = ++this.mergeEpoch, repo = this.repoId, previousKey = this.mergeKey;
        this.cancelDialog(); this.mergeLoading = true; this.mergeError = ''; this.mergeView = undefined;
        this.renderMergeControls();
        try {
            const state = await request<MergeState>('details', repo, { kind: 'merge' });
            if (this.closed || epoch !== this.mergeEpoch || repo !== this.repoId || this.mode !== 'working') return;
            const key = state.active && state.mergeHead ? repo + '\0' + state.head + '\0' + state.mergeHead : '';
            if (key && !this.mergeDrafts.has(key)) {
                for (const [oldKey, draft] of this.mergeDrafts) {
                    if (this.mergeDrafts.size < 16) break;
                    if (draft.message === draft.original) this.mergeDrafts.delete(oldKey);
                }
                if (this.mergeDrafts.size >= 16) throw new Error(t('panel.merge.draftLimit'));
                this.mergeDrafts.set(key, { message: state.message, original: state.message });
            }
            const saved = this.mergeDrafts.get(key);
            if (saved && saved.message === saved.original) { saved.message = state.message; saved.original = state.message; }
            this.mergeView = state; this.mergeKey = key;
            this.el<HTMLTextAreaElement>('merge-message').value = this.mergeDrafts.get(key)?.message || '';
            if (key !== previousKey) this.el<HTMLInputElement>('merge-pointers').checked = false;
        } catch (error) {
            if (!this.closed && epoch === this.mergeEpoch) { this.mergeView = undefined; this.mergeKey = ''; this.mergeError = error instanceof Error ? error.message : String(error); }
        } finally { if (!this.closed && epoch === this.mergeEpoch) { this.mergeLoading = false; this.renderMergeControls(); } }
    }

    private populateMergeTargets(details: RepoDetails): void {
        const select = this.el<HTMLSelectElement>('merge-start-target'), previous = select.value;
        const entries: Array<[string, string]> = [];
        outer: for (const branches of [details.branches, details.remoteBranches]) for (const item of branches) {
            if (item.sha === details.repo.head) continue;
            entries.push([item.name, item.sha]);
            if (entries.length >= 200) break outer;
        }
        const signature = JSON.stringify(entries);
        if (select.dataset.references !== signature || select.options.length !== entries.length) {
            select.replaceChildren();
            for (const [label, sha] of entries) select.add(new Option(label, sha));
            if ([...select.options].some(option => option.value === previous)) select.value = previous;
            select.dataset.references = signature;
        }
        const note = t('panel.merge.startNote', { branch: details.repo.branch || t('panel.merge.unnamedBranch'), count: entries.length });
        this.el('merge-start-note').textContent = t('panel.merge.into', { branch: details.repo.branch || t('panel.merge.unnamedBranch') });
        select.dataset.mergeHint = note;
        this.renderMergeTargetHint();
        setTooltipTitle(this.el('merge-start-preview'), t('panel.merge.previewStart') + '\n' + note);
    }

    private renderBranchPicker(): void {
        for (const kind of ['repo', 'branch'] as const) {
        const branch = this.el<HTMLSelectElement>(kind === 'repo' ? 'repo-select' : 'branch'), picker = this.el<HTMLDetailsElement>(kind + '-picker');
        const selected = kind === 'repo' ? this.repoId : this.details?.repo.branch;
        const label = kind === 'repo' ? branch.options[branch.selectedIndex]?.textContent || t('panel.html.repo-select.aria') : this.details?.repo.branch || (this.details?.repo.head ? t('panel.detachedHead') : t('panel.noCommitsYet'));
        this.el(kind + '-picker-label').textContent = label;
        const summary = picker.querySelector<HTMLElement>('summary')!;
        summary.setAttribute('aria-disabled', String(branch.disabled));
        setTooltipTitle(summary, `${kind === 'repo' ? t('panel.html.repo-picker.summary.aria') : t('panel.html.branch.aria')}\n${label}`);
        const list = this.el(kind + '-options');
        const signature = JSON.stringify([...branch.options].map(option => [option.value, option.textContent, option.value === selected, branch.disabled]));
        if (list.dataset.signature !== signature) {
            list.replaceChildren();
            for (const option of branch.options) {
                const button = document.createElement('button');
                button.type = 'button'; button.dataset.value = option.value; button.textContent = option.textContent;
                button.setAttribute('role', 'menuitemradio');
                button.setAttribute('aria-checked', String(option.value === selected));
                button.disabled = branch.disabled || !option.value;
                setTooltipTitle(button, option.textContent || option.value);
                list.append(button);
            }
            list.dataset.signature = signature;
        }
        if (branch.disabled) picker.open = false;
        if (picker.open) {
            const rect = picker.getBoundingClientRect(), bounds = this.app.getBoundingClientRect();
            const below = Math.min(bounds.bottom, this.app.ownerDocument.defaultView!.innerHeight) - rect.bottom - 12;
            const above = rect.top - Math.max(0, bounds.top) - 12;
            const desired = Math.min(300, list.scrollHeight || 300);
            const upward = below < Math.min(120, desired) && above > below;
            picker.classList.toggle('opens-up', upward);
            list.style.maxHeight = Math.max(40, Math.min(300, upward ? above : below)) + 'px';
        }
        }
    }

    private renderMergeTargetHint(): void {
        const branch = this.el<HTMLSelectElement>('branch');
        setTooltipTitle(branch, branch.value ? t('panel.switchTo', { branch: branch.value }) : t('panel.noSwitchableBranch'));
        const select = this.el<HTMLSelectElement>('merge-start-target'), option = select.options[select.selectedIndex];
        const selected = option ? `${option.textContent}\n${option.value}` : t('panel.merge.noTarget');
        setTooltipTitle(select, [selected, select.dataset.mergeHint].filter(Boolean).join('\n'));
        setTooltipTitle(this.el('merge-start-note'), select.dataset.mergeHint || t('panel.html.merge-start-note'));
    }

    private renderMergeControls(): void {
        this.renderMergeTargetHint();
        const active = this.mode === 'working' && this.details?.repo.operation === 'MERGE_HEAD';
        const state = this.mergeView, message = this.el<HTMLTextAreaElement>('merge-message').value;
        setControlValue(this.el('merge-tools'), 'hidden', !active);
        setControlValue(this.el('merge-start-tools'), 'hidden', !this.details || !this.details.repo.branch || !!this.details.repo.operation);
        setControlValue(this.el('merge-start-preview'), 'hidden', !this.details || !this.details.repo.branch || !!this.details.repo.operation);
        for (const element of this.app.querySelectorAll<HTMLElement>('[data-normal-commit]')) setControlValue(element, 'hidden', !!active);
        const locked = this.busy || this.planning || this.mergeLoading || !this.details || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden);
        this.setDisabled(this.el<HTMLButtonElement>('merge-start-preview'), locked || !!this.details?.repo.operation || !this.details?.repo.branch || !this.el<HTMLSelectElement>('merge-start-target').value);
        this.setDisabled(this.el<HTMLSelectElement>('merge-start-target'), locked);
        this.setDisabled(this.el<HTMLButtonElement>('merge-abort-preview'), !active || locked || !state?.canAbort || !state.abortVersion);
        setControlValue(this.el('merge-abort-note'), 'textContent', state?.abortReason || t('panel.merge.abortUnknown'));
        this.setDisabled(this.el<HTMLButtonElement>('merge-read'), !active || locked);
        this.setDisabled(this.el<HTMLTextAreaElement>('merge-message'), !active || locked || !this.mergeKey);
        this.setDisabled(this.el<HTMLInputElement>('merge-pointers'), !active || locked || !state?.pointers);
        this.setDisabled(this.el<HTMLButtonElement>('merge-preview'), !active || locked || !state?.canFinish || !this.mergeKey || !message.trim() || message.length > 5000 || message.includes('\0') || (state.pointers && !this.el<HTMLInputElement>('merge-pointers').checked));
        setControlValue(this.el('merge-summary'), 'textContent', state ? t('panel.merge.summary', { branch: state.branch || t('panel.detachedHead'), head: state.head, mergeHead: state.mergeHead || t('panel.merge.notRead'), conflicts: state.conflicts, staged: state.staged === null ? t('panel.merge.stagedUnknown') : t('panel.merge.stagedCount', { count: state.staged }), pointers: state.pointers ? t('panel.merge.withPointers') : '' }) : t('panel.merge.resolveFirst'));
        setControlValue(this.el('merge-note'), 'textContent', this.mergeLoading ? t('panel.merge.loading') : this.mergeError || state?.reason || state?.messageNotice || (state?.canFinish ? t('panel.merge.canFinish', { length: message.length }) : t('panel.merge.stateNotRead')));
    }

    private async prepareMerge(): Promise<void> {
        const state = this.mergeView;
        if (this.closed || this.mode !== 'working' || this.busy || this.planning || !state?.canFinish || !this.mergeKey || this.mergeLoading || !this.el('modal').hidden) return;
        const epoch = this.epoch, mergeEpoch = this.mergeEpoch, dialogEpoch = this.dialogEpoch;
        const operation: OperationRequest = { repo: this.repoId, version: state.repoVersion, action: 'finishMerge', mergeVersion: state.version,
            message: this.el<HTMLTextAreaElement>('merge-message').value, includePointers: this.el<HTMLInputElement>('merge-pointers').checked };
        this.planning = true; this.updateButtons();
        try {
            const plan = await this.requestPlan(operation);
            if (!plan) return;
            if (this.closed || epoch !== this.epoch || mergeEpoch !== this.mergeEpoch || dialogEpoch !== this.dialogEpoch || this.mode !== 'working') return;
            this.plan = plan; this.inputAction = undefined; this.inputStash = undefined;
            this.el('plan-title').textContent = plan.title; this.el('plan-description').textContent = plan.description;
            this.el('plan-files').textContent = plan.paths.join('\n'); this.el('plan-files').hidden = !plan.paths.length;
            this.el('plan-patch').hidden = true; this.el('plan-amend-edit').hidden = true;
            for (const id of ['branch-input-wrap', 'remote-branch-wrap', 'stash-input-wrap', 'upstream-input-wrap']) this.el(id).hidden = true;
            this.renderPlanWarnings(plan, 'finishMerge');
            this.el('confirm').textContent = t('panel.confirm.finishMerge'); this.el('modal').hidden = false;
        } catch (error) { if (!this.closed && epoch === this.epoch && mergeEpoch === this.mergeEpoch && dialogEpoch === this.dialogEpoch) { this.error(error); this.mergeError = error instanceof Error ? error.message : String(error); } }
        finally { this.planning = false; this.updateButtons(); }
    }

    private branchTarget(): Branch | undefined {
        const selected = this.managedBranch;
        return selected && this.details?.branches.find(branch => branch.name === selected.name && branch.sha === selected.sha);
    }

    private renderBranches(): void {
        const list = this.el('branch-list');
        const filter = this.el<HTMLInputElement>('branch-filter').value.toLowerCase();
        const branches = (this.details?.branches || []).filter(branch => [branch.name, branch.sha, this.upstreamText(branch)].some(value => value.toLowerCase().includes(filter)));
        if (!branches.some(branch => branch.name === this.managedBranch?.name && branch.sha === this.managedBranch.sha)) this.managedBranch = undefined;
        const signature = JSON.stringify([this.details?.repo.id, this.details?.repo.branch, !!this.details?.repo.head, this.details?.branches.length, filter, branches.map(branch => [branch.name, branch.sha, branch.current, branch.worktree, branch.tracking?.state, this.upstreamText(branch)]), this.managedBranch]);
        if (list.dataset.branches === signature && list.childElementCount) return;
        list.dataset.branches = signature;
        const scrollTop = list.scrollTop; list.replaceChildren();
        this.el('branch-current').textContent = this.details ? t('panel.branches.current', { branch: this.details.repo.branch || (this.details.repo.head ? t('panel.detachedHead') : t('panel.noCommitsYet')) }) : t('panel.loadingRepository');
        for (const branch of branches) {
            const row = document.createElement('button');
            row.className = 'branch-row' + (branch.name === this.managedBranch?.name ? ' active' : '');
            row.setAttribute('aria-pressed', String(branch.name === this.managedBranch?.name));
            const name = document.createElement('strong'); name.textContent = branch.name + (branch.current ? t('panel.branches.currentSuffix') : '');
            const info = document.createElement('small'); info.textContent = `${branch.sha.slice(0, 12)} · ${t('panel.branches.upstream', { upstream: this.upstreamText(branch) })}`;
            if (branch.tracking?.state === 'gone' || branch.tracking?.state === 'invalid') info.className = 'branch-warning';
            setTooltipTitle(row, `${branch.name}\n${branch.sha}\n${t('panel.branches.upstream', { upstream: this.upstreamText(branch) })}`);
            row.append(name, info);
            if (branch.worktree || branch.current) {
                const occupied = document.createElement('small'); occupied.className = 'branch-occupied';
                occupied.textContent = branch.worktree ? t('panel.branches.occupiedBy', { worktree: branch.worktree }) : t('panel.branches.occupiedHere'); row.append(occupied);
            }
            row.addEventListener('click', () => {
                this.managedBranch = { name: branch.name, sha: branch.sha };
                this.renderBranches(); this.updateButtons();
            });
            list.append(row);
        }
        if (!branches.length) {
            const empty = document.createElement('div'); empty.className = 'empty';
            empty.textContent = !this.details ? t('panel.branches.loading') : this.details.branches.length ? t('panel.branches.noMatch') : t('panel.branches.none'); list.append(empty);
        }
        list.scrollTop = scrollTop;
        const target = this.branchTarget();
        this.el('branch-selection').textContent = target ? [
            t('panel.branches.target', { name: target.name }),
            t('panel.branches.commit', { sha: target.sha }),
            t('panel.branches.upstream', { upstream: this.upstreamText(target) }),
            target.current ? t('panel.branches.currentNote') : target.worktree ? t('panel.branches.worktreeNote', { worktree: target.worktree }) : t('panel.branches.notCheckedOut'),
        ].join('\n') : t('panel.branches.selectOne');
    }

    private updateVisibility(): void {
        if (this.closed) return;
        this.schedule();
        if (!this.panelVisible()) {
            this.diskRefreshPending = true; this.diskRefreshAll = true;
            if (this.diskRefreshTimer) clearTimeout(this.diskRefreshTimer);
            this.diskRefreshTimer = undefined;
            return;
        }
        if (this.diffRenderPending) {
            this.diffRenderPending = false;
            if (this.currentDiff) { this.el('notice').hidden = true; this.renderDiff(); this.updateButtons(); }
        }
        this.queueDiskRefresh(); this.wakeRemoteCheck();
    }

    private panelVisible(): boolean { return !this.app.ownerDocument.hidden && !!this.app.getClientRects().length; }

    private canRefreshFromDisk(): boolean {
        return !this.closed && !this.busy && !this.planning && !this.refreshing && !this.diffLoading
            && !this.app.ownerDocument.hidden && !!this.app.getClientRects().length
            && this.el('modal').hidden && this.el('amend-modal').hidden && this.el('scope-review-modal').hidden;
    }

    private queueDiskRefresh(all = true): void {
        this.diskRefreshAll ||= all;
        if (this.closed) return;
        this.diskRefreshPending = true;
        if (this.diskRefreshTimer) clearTimeout(this.diskRefreshTimer);
        this.diskRefreshTimer = undefined;
        if (!this.panelVisible()) return;
        this.diskRefreshTimer = setTimeout(() => { this.diskRefreshTimer = undefined; void this.guard(() => this.refreshFromDisk()); }, 350);
    }

    private async refreshFromDisk(all = this.diskRefreshAll): Promise<void> {
        if (!this.canRefreshFromDisk()) return;
        this.diskRefreshPending = false; this.diskRefreshAll = false;
        const file = this.currentFile, epoch = this.diffEpoch, repo = this.repoId;
        if (file && ['worktree', 'conflict'].includes(file.area) && !this.blameActive) {
            let diff: FileDiff;
            try { diff = await request<FileDiff>('diff', { ...file, force: true }); }
            catch (error) { if (this.closed || this.currentFile !== file || epoch !== this.diffEpoch) return; throw error; }
            if (this.currentFile !== file || epoch !== this.diffEpoch) return;
            if (!this.canRefreshFromDisk()) { this.diskRefreshPending = true; this.diskRefreshAll ||= all; return; }
            if (!sameDisplayedDiff(this.currentDiff, diff)) {
                const view = this.el('diff-view'), top = view.scrollTop, left = view.scrollLeft;
                this.diffEpoch++; this.selectedLines.clear(); this.currentDiff = diff;
                this.renderDiff(); view.scrollTop = top; view.scrollLeft = left; this.updateButtons();
            }
        }
        await this.refresh(false, true, !all && file ? repo : undefined);
    }

    private scopeReview?: ScopeApproval;
    private scopeReviewEpoch = 0;
    private scopeReviewOpening = false;
    private scopeReviewRequests: string[] = [];
    private scopeReviewExpiry?: ReturnType<typeof setTimeout>;
    private scopeReviewDiffViewport?: DiffViewport;
    private readonly scopeReviewRequested = (...args: unknown[]): void => {
        const id = args[0];
        if (this.closed || typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id) || this.scopeReviewRequests.includes(id) || this.scopeReview?.id === id) return;
        this.scopeReviewRequests.push(id);
        void this.guard(() => this.showPendingScopeReview());
    };
    private async showPendingScopeReview(): Promise<void> {
        const id = this.scopeReviewRequests[0];
        if (id) await this.openScopeReviews(id);
    }
    private async openScopeReviews(requestedId?: string): Promise<void> {
        if (this.closed || this.scopeReviewOpening || this.busy || this.planning || !this.el('modal').hidden || !this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden || !this.el('log-dialog').hidden || !this.el('project-update-progress').hidden) return;
        this.scopeReviewOpening = true;
        try {
            const epoch = ++this.scopeReviewEpoch;
            const list = await request<{ id: string; context: string; title: string; status: string }[]>('scope-reviews');
            if (this.closed || epoch !== this.scopeReviewEpoch || this.busy || this.planning || !this.el('modal').hidden || !this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden || !this.el('log-dialog').hidden || !this.el('project-update-progress').hidden) return;
            const select = this.el<HTMLSelectElement>('scope-review-select'); select.replaceChildren();
            for (const item of list.filter(r => r.status === 'pending')) { const option = this.app.ownerDocument.createElement('option'); option.value = item.id; option.textContent = item.title + ' · ' + (item.context === 'creator' ? t('panel.scopeReview.contextCreator') : t('panel.scopeReview.contextIsolated')); select.append(option); }
            if (requestedId) {
                this.scopeReviewRequests = this.scopeReviewRequests.filter(id => id !== requestedId);
                if (!list.some(item => item.id === requestedId && item.status === 'pending')) return;
                select.value = requestedId;
            }
            this.el('scope-review-modal').hidden = false; this.updateButtons();
            await this.loadScopeReview();
            if (!this.closed && epoch === this.scopeReviewEpoch - 1) { this.el('scope-review-title').tabIndex = -1; this.el('scope-review-title').focus(); }
        } finally { this.scopeReviewOpening = false; }
    }
    private async loadScopeReview(): Promise<void> {
        const epoch = ++this.scopeReviewEpoch, id = this.el<HTMLSelectElement>('scope-review-select').value;
        this.scopeReview = undefined; this.el<HTMLInputElement>('scope-review-ack').checked = false;
        if (this.scopeReviewExpiry) clearTimeout(this.scopeReviewExpiry);
        this.el('scope-review-title').textContent = t('panel.html.scope-reviews-open');
        this.el('scope-review-summary').textContent = '';
        this.el('scope-review-select-wrap').hidden = !id || (this.el<HTMLSelectElement>('scope-review-select').options?.length ?? 2) <= 1;
        this.scopeReviewDiffViewport?.close(); this.scopeReviewDiffViewport = undefined;
        this.el('scope-review-diff').replaceChildren();
        this.el('scope-review-patch').textContent = ''; this.el('scope-review-info').textContent = id ? t('panel.scopeReview.loadingPatch') : t('panel.scopeReview.none'); this.updateScopeReviewButtons();
        if (!id) return;
        const item = await request<ScopeApproval>('scope-review-view', id);
        if (this.closed || epoch !== this.scopeReviewEpoch || this.el('scope-review-modal').hidden) return;
        this.scopeReview = item;
        if (this.scopeReviewExpiry) clearTimeout(this.scopeReviewExpiry);
        this.scopeReviewExpiry = setTimeout(() => { if (!this.closed && this.scopeReview?.id === item.id) this.updateScopeReviewButtons(); }, Math.max(0, item.expiresAt - Date.now()) + 1);
        this.el('scope-review-title').textContent = t('panel.scopeReview.title', { title: item.title });
        this.el('scope-review-approve').textContent = t('panel.scopeReview.approveCount', { count: item.paths.length });
        this.el('scope-review-context-label').textContent = t('panel.scopeReview.contextLabel', { count: item.paths.length, branch: item.branch, expires: new Date(item.expiresAt).toLocaleTimeString() });
        this.el('scope-review-summary').textContent = [
            t('panel.scopeReview.decision', { title: item.title }),
            t('panel.scopeReview.reasons') + '\n' + (item.files?.map(file => file.path + '\n  ' + file.reasons.join('\n  ')).join('\n') || t('panel.scopeReview.reasonsMissing')),
            t('panel.scopeReview.summary') + '\n' + (item.review?.summary || t('panel.scopeReview.summaryMissing')),
            t('panel.scopeReview.focus') + '\n' + (item.review?.focus || t('panel.scopeReview.focusMissing')),
            t('panel.scopeReview.validation') + '\n' + (item.review?.validation || t('panel.scopeReview.validationMissing')),
        ].join('\n\n');
        this.el('scope-review-info').textContent = t('panel.scopeReview.info', { root: item.root, repo: item.repo, branch: item.branch, head: item.head, count: item.paths.length, expires: new Date(item.expiresAt).toLocaleTimeString(), created: new Date(item.createdAt).toLocaleString() });
        this.el('scope-review-patch').textContent = item.patch;
        this.renderScopeReviewPatch(item); this.updateScopeReviewButtons();
    }

    private renderScopeReviewPatch(item: ScopeApproval): void {
        const host = this.el('scope-review-diff'), doc = host.ownerDocument;
        host.replaceChildren(); host.className = 'scope-diff';
        const sections = scopeDiffSections(item), paths = [...new Set(sections.map(section => section.path))];
        const files = doc.createElement('nav'); files.className = 'scope-diff-files'; files.setAttribute('aria-label', t('panel.scopeReview.filesAria'));
        const viewer = doc.createElement('section'); viewer.className = 'scope-diff-viewer';
        const title = doc.createElement('h3'), legend = doc.createElement('div'), viewport = doc.createElement('div');
        title.className = 'scope-diff-path'; legend.className = 'scope-diff-legend'; viewport.className = 'scope-diff-viewport';
        legend.textContent = t('panel.scopeReview.legend');
        viewer.append(title, legend, viewport); host.append(files, viewer);
        const buttons: HTMLButtonElement[] = [];
        const select = (name: string, button: HTMLButtonElement) => {
            this.scopeReviewDiffViewport?.close(); this.scopeReviewDiffViewport = undefined;
            viewport.replaceChildren(); viewport.scrollTop = 0; viewport.scrollLeft = 0; title.textContent = name;
            buttons.forEach(other => other.setAttribute('aria-current', String(other === button)));
            const rows: ScopeDiffRow[] = [];
            for (const section of sections.filter(section => section.path === name)) {
                rows.push({ kind: 'hunk', text: section.area === 'index' ? t('panel.scopeReview.sectionIndex') : section.area === 'worktree' ? t('panel.scopeReview.sectionWorktree') : t('panel.scopeReview.sectionNotice'), height: 30 });
                rows.push(...scopeDiffRows(section.text));
            }
            const patch = doc.createElement('div'); patch.className = 'scope-diff-lines'; viewport.append(patch);
            const createRow = (index: number): HTMLElement => {
                const row = rows[index]!, element = doc.createElement('div');
                element.className = 'scope-diff-row ' + row.kind;
                if (row.kind === 'hunk' || row.kind === 'meta') { element.textContent = row.text; return element; }
                const oldNumber = doc.createElement('span'), newNumber = doc.createElement('span'), sign = doc.createElement('span'), code = doc.createElement('span');
                oldNumber.className = newNumber.className = 'line-number'; sign.className = 'scope-diff-sign'; code.className = 'scope-diff-code';
                oldNumber.textContent = String(row.oldLine ?? ''); newNumber.textContent = String(row.newLine ?? '');
                sign.textContent = row.kind === 'add' ? '+' : row.kind === 'delete' ? '−' : ''; code.textContent = row.code!;
                element.append(oldNumber, newNumber, sign, code); return element;
            };
            if (rows.length >= DIFF_VIRTUAL_THRESHOLD) this.scopeReviewDiffViewport = new DiffViewport(viewport, patch, rows, createRow, 140);
            else rows.forEach((_, index) => patch.append(createRow(index)));
        };
        paths.forEach(name => {
            const button = doc.createElement('button'), label = doc.createElement('span'), count = doc.createElement('span');
            button.type = 'button'; button.className = 'scope-diff-file'; label.textContent = name; label.className = 'scope-diff-filename';
            const rows = sections.filter(section => section.path === name).flatMap(section => scopeDiffRows(section.text));
            count.textContent = '+' + rows.filter(row => row.kind === 'add').length + ' / −' + rows.filter(row => row.kind === 'delete').length;
            count.className = 'scope-diff-count'; button.append(label, count);
            button.addEventListener('click', () => select(name, button), { signal: this.listenerScope.signal });
            files.append(button); buttons.push(button);
        });
        if (buttons[0]) select(paths[0]!, buttons[0]);
    }

    private updateScopeReviewButtons(): void {
        const invalid = this.busy || this.planning || !this.scopeReview || this.scopeReview.status !== 'pending' || this.scopeReview.expiresAt <= Date.now();
        const missing = !this.scopeReview;
        for (const id of ['scope-review-summary', 'scope-review-diff', 'scope-review-raw', 'scope-review-patch', 'scope-review-ack-wrap', 'scope-review-approve', 'scope-review-reject']) this.el(id).hidden = missing;
        this.el<HTMLButtonElement>('scope-review-approve').disabled = invalid || !this.el<HTMLInputElement>('scope-review-ack').checked;
        this.el<HTMLButtonElement>('scope-review-reject').disabled = invalid;
        if (this.scopeReview && this.scopeReview.expiresAt <= Date.now()) this.el('scope-review-info').textContent = t('panel.scopeReview.expired');
    }
    private async decideScopeReview(approve: boolean): Promise<void> {
        const item = this.scopeReview;
        if (!item || this.busy || this.planning || item.status !== 'pending' || item.expiresAt <= Date.now() || (approve && !this.el<HTMLInputElement>('scope-review-ack').checked)) return;
        this.planning = true; this.updateScopeReviewButtons();
        try { await request('scope-review-decision', item.id, item.digest, approve); this.scopeReview = undefined; this.el('scope-review-modal').hidden = true; ++this.scopeReviewEpoch; }
        finally { this.planning = false; this.updateButtons(); this.updateScopeReviewButtons(); void this.guard(() => this.showPendingScopeReview()); }
    }
    private remoteRefreshAllowed(allowRefreshing = false): boolean {
        return !this.closed && !this.busy && !this.planning && (!this.refreshing || allowRefreshing) && !this.repoLoading && !!this.details
            && this.el('modal').hidden && this.el('amend-modal').hidden && this.el('scope-review-modal').hidden
            && !this.app.ownerDocument.hidden && !!this.app.getClientRects().length;
    }
    private automaticCheckAllowed(): boolean { return this.remoteRefreshAllowed() && this.app.ownerDocument.hasFocus(); }
    private wakeRemoteCheck(): void {
        if (this.remoteChecking) return;
        if (!this.remoteFetch.wake(this.repoId)) return;
        this.remoteWakePending = true;
        if (this.automaticCheckAllowed()) { this.remoteWakePending = false; void this.guard(() => this.checkRemote()); }
    }
    private async checkRemote(): Promise<void> {
        if (this.remoteChecking || !this.automaticCheckAllowed() || !this.details?.remotes.length || !this.remoteFetch.enabled) return;
        const repo = this.repoId;
        this.remoteWakePending = false; this.remoteChecking = true; this.remoteFetch.reserve(repo);
        try {
            const result = await request<RemoteCheckResult>('check-remote', repo);
            if (this.closed) return;
            if (result.state === 'busy') { this.remoteFetch.defer(repo); return; }
            if (result.checkedAt) this.remoteCheckTimes.set(repo, result.checkedAt);
            if (result.task) {
                this.remoteFetchPending = { id: result.task.id, repo, automatic: true };
                this.renderTask(result.task);
            } else {
                // Timer and focus disk refresh own the snapshot; probing must not add a second scan.
                this.remoteFetch.checked(repo);
            }
        } catch (error) {
            this.remoteFetch.settle(repo, false);
            if (!this.closed && repo === this.repoId) this.error(t('panel.remoteCheckFailed', { error: error instanceof Error ? error.message : String(error) }));
        } finally { this.remoteChecking = false; if (!this.closed) { this.updateButtons(); this.schedule(); } }
    }
    private async refreshRemote(automatic: boolean): Promise<void> {
        if (!this.remoteRefreshAllowed() || (automatic && !this.details?.remotes.length)) return;
        const repo = this.repoId;
        this.remoteFetch.reserve(repo); this.planning = true; this.updateButtons();
        try {
            const task = await request<Task | null>('refresh-remote', repo);
            if (this.closed) return;
            if (!task) { this.remoteFetch.defer(repo); return; }
            this.remoteFetchPending = { id: task.id, repo, automatic };
            this.renderTask(task);
            if (task.status !== 'running') {
                this.remoteFetch.settle(repo, task.status === 'success'); this.remoteFetchPending = undefined;
            }
        } catch (error) {
            this.remoteFetch.settle(repo, false);
            this.error(t('panel.remoteFetchFailed', { error: error instanceof Error ? error.message : String(error) }));
        } finally { if (!this.closed) { this.planning = false; this.updateButtons(); this.schedule(); } }
    }
    private async refreshRemoteDetails(allowRefreshing = false): Promise<void> {
        if (!this.remoteRefreshAllowed(allowRefreshing)) return;
        const repo = this.repoId, epoch = this.epoch, previous = this.details!.repo.version;
        const details = await request<RepoDetails>('details', repo);
        if (this.closed || this.epoch !== epoch || repo !== this.repoId || !this.remoteRefreshAllowed(allowRefreshing)) return;
        if (details.repo.version !== previous) { await this.selectRepo(repo, false); return; }
        this.details = details;
        this.populateCompareRefs(details); this.populateMergeTargets(details);
        this.renderRepoInfo(details);
        this.renderBranches(); this.renderComparison(); this.updateButtons();
        if (this.mode === 'history') await this.loadHistory(false, true);
        if (this.mode === 'sync') { this.syncSnapshotChanged = true; this.renderSync(); }
    }
    private schedule(): void {
        if (this.timer) clearTimeout(this.timer);
        if (this.closed) return;
        this.timer = setTimeout(async () => {
            if (this.closed) return;
            await this.guard(async () => {
                if (!this.panelVisible() && !this.busy) return;
                await this.showPendingScopeReview();
                if (this.automaticCheckAllowed() && this.remoteFetch.due(this.repoId)) await this.checkRemote();
                const task = await request<Task | null>('task');
                const wasBusy = this.busy;
                this.renderTask(task);
                if (wasBusy && !this.busy) {
                    const pending = this.remoteFetchPending;
                    if (pending) { this.remoteFetch.settle(pending.repo, task?.id === pending.id && task.status === 'success'); this.remoteFetchPending = undefined; }
                    if (!this.panelVisible()) { this.diskRefreshPending = true; this.diskRefreshAll = true; return; }
                    await this.refresh(!(task?.workspace?.isolated || task?.remoteOnly), true);
                    if (task?.remoteOnly) {
                        await this.refreshRemoteDetails();
                        if (pending && !pending.automatic && pending.repo === this.repoId && this.mode === 'sync' && this.remoteRefreshAllowed()) await this.loadSync();
                    }
                }
                else if (!this.busy && !this.app.ownerDocument.hidden && this.app.getClientRects().length && this.el('modal').hidden) {
                    if (this.diskRefreshPending || (this.currentFile?.area === 'worktree' && !this.diskObserver.active)) await this.refreshFromDisk(true);
                    else await this.refresh(false);
                }
                if (this.remoteWakePending && this.automaticCheckAllowed()) await this.checkRemote();
            });
            this.schedule();
        }, this.busy ? 700 : this.app.ownerDocument.hidden || !this.app.getClientRects().length ? 60000 : this.automaticCheckAllowed() && !!this.details?.remotes.length && !this.remoteChecking ? this.remoteFetch.delay(this.repoId) : 15000);
    }

    private async refresh(force: boolean, fresh = false, changedRepo?: string): Promise<void> {
        if (force && !this.closed) this.cancelDialog();
        if (this.refreshing || this.closed) return;
        this.refreshing = true;
        try {
            const snapshot = changedRepo ? await request<Snapshot>('snapshot', true, changedRepo) : await request<Snapshot>('snapshot', force || fresh);
            if (this.closed) return;
            if (!this.panelVisible()) { this.diskRefreshPending = true; this.diskRefreshAll = true; return; }
            const previous = this.details?.repo.version;
            this.snapshot = snapshot; this.renderRepos();
            if (snapshot.lastProjectUpdate && !this.projectUpdateResult) {
                this.projectUpdateResult = snapshot.lastProjectUpdate;
                if (!snapshot.task?.repositories) this.projectUpdateHidden = snapshot.lastProjectUpdate.id;
            }
            this.renderTask(snapshot.task);
            if (!force && (this.planning || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden))) return;
            const current = snapshot.repositories.find(r => r.id === this.repoId);
            const remoteChanged = !!this.details && current?.remoteVersion !== this.details.repo.remoteVersion;
            if (!force && remoteChanged && current?.version === previous && !this.busy) { await this.refreshRemoteDetails(true); return; }
            if (!force && this.mode === 'sync' && this.syncPage && current?.initialized && !current.error) {
                if (current.version !== previous && !this.syncSnapshotChanged) { this.syncSnapshotChanged = true; this.renderSync(); }
                return;
            }
            const targetId = current ? this.repoId : '.';
            if (targetId !== this.repoId || force || !this.details || current?.version !== previous || (this.mode === 'sync' && (!current?.initialized || !!current.error)) || this.mode === 'stash' || this.mode === 'branches') await this.selectRepo(targetId, force || !this.details);
        } catch (e) { this.error(e); }
        finally { this.refreshing = false; }
    }

    private readonly repositoryRows = new Map<string, { button: HTMLButtonElement; name: Text; count: HTMLSpanElement; info: HTMLSpanElement }>();
    private renderRepos(): void {
        const list = this.el('repo-list'), select = this.el<HTMLSelectElement>('repo-select');
        const repositories = this.snapshot?.repositories || [];
        const structureChanged = list.children.length !== repositories.length || repositories.some((repo, index) => this.repositoryRows.get(repo.id)?.button !== list.children[index]);
        const scroll = structureChanged ? { top: list.scrollTop, left: list.scrollLeft } : undefined;
        const focused = structureChanged && list.contains(list.ownerDocument.activeElement) ? list.ownerDocument.activeElement as HTMLElement : undefined;
        const signature = JSON.stringify(repositories.map(repo => [repo.id, repo.name]));
        if (select.dataset.repositories !== signature) {
            select.replaceChildren();
            for (const repo of repositories) {
                const option = document.createElement('option'); option.value = repo.id;
                option.textContent = repo.id === '.' ? repo.name : `${repo.name} · ${repo.id}`;
                select.append(option);
            }
            select.dataset.repositories = signature;
        }
        if (select.value !== this.repoId) select.value = this.repoId;
        const ids = new Set(repositories.map(repo => repo.id));
        for (const [id, row] of this.repositoryRows) if (!ids.has(id)) { row.button.remove(); this.repositoryRows.delete(id); }
        for (const [index, repo] of repositories.entries()) {
            let row = this.repositoryRows.get(repo.id);
            if (!row) {
                const button = document.createElement('button'); button.className = 'repo';
                button.style.paddingLeft = `${10 + (repo.id === '.' ? 0 : repo.id.split('/').length > 3 ? 18 : 9)}px`;
                const title = document.createElement('strong'), name = document.createTextNode(repo.name);
                const count = document.createElement('span'); count.className = 'count'; title.append(name, count);
                const info = document.createElement('span'); info.className = 'meta'; button.append(title, info);
                button.addEventListener('click', () => { void this.guard(() => this.selectRepo(repo.id, true)); });
                row = { button, name, count, info }; this.repositoryRows.set(repo.id, row);
            }
            const active = repo.id === this.repoId, warning = !!repo.expected && repo.expected !== repo.head;
            const title = repo.path + (repo.error ? '\n' + repo.error : '');
            const info = (repo.error ? t('panel.repos.readFailed') : !repo.initialized ? t('panel.repos.uninitialized') : `${repo.branch || t('panel.detachedHead')}  ↑${repo.ahead} ↓${repo.behind}`) + (warning ? t('panel.repos.pointerDiffers') : '');
            if (row.button.classList.contains('active') !== active) row.button.classList.toggle('active', active);
            if (tooltipTitle(row.button) !== title) setTooltipTitle(row.button, title);
            if (row.name.data !== repo.name) row.name.data = repo.name;
            if (row.count.textContent !== String(repo.files.length)) row.count.textContent = String(repo.files.length);
            if (row.info.textContent !== info) row.info.textContent = info;
            if (row.info.classList.contains('warn') !== warning) row.info.classList.toggle('warn', warning);
            if (list.children[index] !== row.button) list.insertBefore(row.button, list.children[index] || null);
        }
        // Reordering must not move the user's viewport or keyboard focus.
        if (scroll) { list.scrollTop = scroll.top; list.scrollLeft = scroll.left; }
        if (focused?.isConnected && list.ownerDocument.activeElement !== focused) focused.focus({ preventScroll: true });
    }

    private async applyRepositoryView(details: RepoDetails, contextChanged: boolean): Promise<boolean> {
        if (!contextChanged) return false;
        const next = details.repo.files.length || details.repo.operation || this.drafts.get(details.repo.id)?.message ? 'working' : 'history';
        if (this.mode === next) return false;
        await this.setMode(next);
        return true;
    }

    private async selectRepo(id: string, clear: boolean): Promise<void> {
        const entering = id !== this.repoId || !this.details, previousBranch = this.details?.repo.branch;
        const epoch = ++this.epoch, changed = id !== this.repoId;
        if (changed) this.layout?.restoreWorkspace();
        this.clearReflog();
        this.resetRemotes();
        this.resetMerge();
        this.closeFileMenu(); this.flushFilter();
        this.clearTags();
        this.clearTree();
        if (changed) { this.tagTarget = undefined; this.el<HTMLInputElement>('tags-filter').value = ''; }
        if (changed) { this.filePage = 0; this.fileCompareLeft = undefined; this.fileCompareRight = undefined; }
        this.selectionEpoch++;
        if (changed) {
            void this.saveDraft(this.repoId); this.selected.clear(); this.resetWorkingFilter();
            this.el<HTMLInputElement>('pointers').checked = false;
        }
        this.clearInspection();
        this.cancelDialog();
        if (id !== this.repoId) { this.managedBranch = undefined; this.el<HTMLInputElement>('branch-filter').value = ''; }
        this.historyEpoch++; this.historyLoading = false; this.historyScrollArmed = false;
        this.clearSync();
        this.compareEpoch++; this.compareLoading = false;
        if (id !== this.compareRepo) { this.comparison = undefined; this.compareError = ''; this.compareAttempt = undefined; this.compareRepo = ''; }
        this.selectedLines.clear(); this.currentDiff = undefined; this.currentFile = undefined; this.diffLoading = false; this.diffEpoch++; this.renderDiff();
        this.repoId = id; this.el('repo-info').textContent = t('panel.repos.infoLoading'); setTooltipTitle(this.el('repo-info'), ''); this.renderRepos(); this.renderDraft();
        if (!this.draft(id).loaded && !this.draft(id).error) void this.readDraft(id);
        if (clear) {
            this.currentFile = undefined; this.currentDiff = undefined;
            this.revision = ''; this.stashRef = ''; this.historyFiles = []; this.commits = []; this.stashes = []; this.diffEpoch++;
            this.renderDiff();
        }
        this.details = undefined; this.repoLoading = true; this.repoLoadError = '';
        this.el('file-list').replaceChildren();
        if (this.mode === 'working') this.renderFiles();
        this.renderComparison(); this.renderSync(); this.updateButtons();
        this.el('branch-list').replaceChildren(); this.el('branch-current').textContent = t('panel.loadingRepository'); this.el('branch-selection').textContent = t('panel.branches.loadingState');
        try {
            const details = await request<RepoDetails>('details', id);
            if (epoch !== this.epoch || this.closed) return;
            if (!details?.repo || !Array.isArray(details.repo.files) || !Array.isArray(details.branches) || !Array.isArray(details.remotes) || !Array.isArray(details.remoteBranches) || !Array.isArray(details.stashes) || !Array.isArray(details.tags)) {
                throw new Error(t('panel.dataVersionMismatch'));
            }
            this.details = details; this.repoLoading = false;
            this.selected = reconcileSelection(this.selected, this.worklist().rows);
            this.populateCompareRefs(details);
            this.populateMergeTargets(details);
            const branch = this.el<HTMLSelectElement>('branch'); branch.replaceChildren();
            if (!details.repo.branch) branch.add(new Option(details.repo.head ? t('panel.detachedHead') : t('panel.noCommitsYet'), ''));
            for (const b of details.branches) branch.add(new Option(b.name, b.name, false, b.current));
            const remote = this.el<HTMLSelectElement>('remote'), previousRemote = remote.value; remote.replaceChildren();
            for (const name of details.remotes) remote.add(new Option(name, name, false, name === previousRemote || (!previousRemote && name === 'origin')));
            const currentBranch = details.branches.find(item => item.current);
            this.renderRepoInfo(details);
            this.el('notice').hidden = true;
            if (details.repo.operation) this.error(t('panel.pendingOperation', { operation: details.repo.operation }));
            this.renderFiles(); this.renderComparison(); this.renderBranches(); this.updateButtons();
            const viewChanged = await this.applyRepositoryView(details, entering || previousBranch !== details.repo.branch);
            if (!viewChanged && this.mode === 'history') await this.loadHistory();
            if (this.mode === 'sync') await this.loadSync();
            if (this.mode === 'stash') await this.loadStashes(details.stashes);
            if (this.mode === 'tags') {
                if (!this.tagTarget || this.tagTarget.repo !== id) this.tagTarget = details.repo.head ? { repo: id, sha: details.repo.head } : undefined;
                await this.loadTags();
            }
        } catch (e) {
            if (epoch !== this.epoch) return;
            this.repoLoading = false; this.repoLoadError = t('panel.repos.loadFailed');
            this.el('file-list').replaceChildren(); this.el('branch-list').replaceChildren(); this.managedBranch = undefined;
            if (this.mode === 'working') this.renderFiles();
            this.el('branch-current').textContent = t('panel.repos.loadFailedShort'); this.el('branch-selection').textContent = t('panel.branches.refreshFirst');
            this.error(e); this.updateButtons();
        }
    }

    private async setMode(mode: 'working' | 'history' | 'stash' | 'compare' | 'branches' | 'sync' | 'tags'): Promise<void> {
        this.cancelDialog();
        this.clearReflog();
        this.resetRemotes();
        this.el('reflog-workspace').hidden = true; this.el('remote-workspace').hidden = true;
        for (const menu of this.app.querySelectorAll<HTMLDetailsElement>('.toolbar-menu[open]')) menu.open = false;
        this.resetMerge();
        this.clearTree();
        this.clearTags();
        this.clearInspection();
        this.epoch++; this.revision = ''; this.stashRef = ''; this.historyFiles = [];
        this.historyEpoch++; this.historyLoading = false; this.historyScrollArmed = false; this.selectedLines.clear();
        this.clearSync();
        this.compareEpoch++; this.compareLoading = false;
        this.closeFileMenu(); this.flushFilter(); this.filePage = 0;
        this.mode = mode; this.selected.clear(); this.selectionEpoch++;
        if (mode === 'working') this.el<HTMLInputElement>('filter').value = this.workingFilter.text;
        this.currentDiff = undefined; this.currentFile = undefined; this.diffLoading = false; this.diffEpoch++;
        this.el('working-tab').classList.toggle('active', mode === 'working'); this.el('history-tab').classList.toggle('active', mode === 'history');
        this.el('stash-tools').hidden = mode !== 'stash'; this.el('stash-list').hidden = mode !== 'stash';
        this.el('compare-tab').classList.toggle('active', mode === 'compare'); this.el('compare-tools').hidden = mode !== 'compare'; this.el('compare-note').hidden = mode !== 'compare';
        this.el('sync-tab').classList.toggle('active', mode === 'sync');
        for (const id of ['sync-tools', 'sync-list', 'sync-note']) this.el(id).hidden = mode !== 'sync';
        this.app.classList.toggle('branch-mode', mode === 'branches'); this.el('manage-branches').classList.toggle('active', mode === 'branches');
        this.app.classList.toggle('tag-mode', mode === 'tags'); this.el('tags-tab').classList.toggle('active', mode === 'tags');
        this.el('tag-workspace').hidden = mode !== 'tags';
        for (const id of ['branch-tools', 'branch-list', 'branch-actions']) this.el(id).hidden = mode !== 'branches';
        this.el('filter').hidden = mode === 'branches' || mode === 'tags'; this.el('file-list').hidden = mode === 'branches' || mode === 'tags';
        for (const element of this.app.querySelectorAll<HTMLElement>('[data-worklist-feature]')) element.hidden = mode !== 'working';
        this.el('commit-list').hidden = mode !== 'history'; this.el('commit-box').hidden = mode !== 'working';
        this.el('history-footer').hidden = mode !== 'history'; this.el('history-tools').hidden = mode !== 'history'; this.el('history-note').hidden = mode !== 'history'; this.el('history-search-tools').hidden = mode !== 'history';
        this.renderFiles(); this.renderDiff(); this.renderComparison(); this.renderBranches(); this.renderSync();
        this.updateButtons();
        if (!this.details) await this.selectRepo(this.repoId, true);
        else if (mode === 'branches') await this.selectRepo(this.repoId, false);
        else if (mode === 'history') await this.loadHistory();
        else if (mode === 'sync') await this.loadSync();
        else if (mode === 'stash') await this.loadStashes();
        else if (mode === 'tags') {
            if (!this.tagTarget || this.tagTarget.repo !== this.repoId) this.tagTarget = this.details.repo.head ? { repo: this.repoId, sha: this.details.repo.head } : undefined;
            await this.loadTags();
        }
    }

    private async loadStashes(existing?: Stash[]): Promise<void> {
        const epoch = this.epoch;
        const stashes = existing || (await request<RepoDetails>('details', this.repoId)).stashes;
        if (epoch !== this.epoch || this.mode !== 'stash' || this.closed) return;
        this.stashes = stashes;
        if (!stashes.some(s => s.ref === this.stashRef && s.sha === this.revision)) {
            this.stashRef = ''; this.revision = ''; this.historyFiles = [];
            this.currentDiff = undefined; this.currentFile = undefined; this.diffEpoch++;
            this.renderFiles(); this.renderDiff();
        }
        this.renderStashes(); this.updateButtons();
    }

    private renderStashes(): void {
        const list = this.el('stash-list'); list.replaceChildren();
        if (!this.stashes.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = t('panel.stash.none'); list.append(empty); }
        for (const stash of this.stashes) {
            const row = document.createElement('button'); row.className = 'history-row' + (stash.ref === this.stashRef && stash.sha === this.revision ? ' active' : '');
            const title = document.createElement('strong'); title.textContent = stash.subject;
            const info = document.createElement('small'); info.textContent = `${stash.ref} · ${stash.sha.slice(0, 8)} · ${stash.date}`;
            setTooltipTitle(row, stash.subject); row.append(title, info);
            row.addEventListener('click', () => { void this.guard(async () => {
                const epoch = this.epoch; this.filePage = 0; this.revision = stash.sha; this.stashRef = stash.ref; this.historyFiles = [];
                this.currentDiff = undefined; this.currentFile = undefined; this.diffEpoch++;
                this.renderStashes(); this.renderFiles(); this.renderDiff(); this.updateButtons();
                const files = await request<ChangedFile[]>('commit-files', this.repoId, stash.sha, 'stash');
                if (epoch !== this.epoch || this.mode !== 'stash' || this.stashRef !== stash.ref || this.revision !== stash.sha) return;
                this.historyFiles = files; this.renderFiles();
            }); });
            list.append(row);
        }
    }

    private historyDraft(): HistoryQuery {
        const text = this.el<HTMLInputElement>('history-search').value.trim();
        const name = this.el<HTMLInputElement>('history-path').value;
        return {
            scope: this.el<HTMLSelectElement>('history-scope').value === 'current' ? 'current' : 'all',
            search: text ? { field: this.el<HTMLSelectElement>('history-field').value === 'author' ? 'author' : 'message', text } : undefined,
            path: name || undefined,
        };
    }

    private async applyHistorySearch(): Promise<void> {
        this.historyQuery = this.historyDraft();
        await this.loadHistory();
    }

    private renderHistoryDraft(): void {
        this.el('history-search-clear').hidden = !this.el<HTMLInputElement>('history-search').value && !this.el<HTMLInputElement>('history-path').value && !this.historyQuery.search && !this.historyQuery.path;
        const draft = this.historyDraft(), applied = this.historyQuery;
        const pending = draft.scope !== applied.scope || draft.path !== applied.path || draft.search?.field !== applied.search?.field || draft.search?.text !== applied.search?.text;
        this.el('history-draft-note').textContent = pending ? t('panel.history.pendingNote') : '';
        this.el('history-draft-note').hidden = !pending;
        setTooltipTitle(this.el('history-search'), t('panel.history.searchTooltip'));
        setTooltipTitle(this.el('history-path'), t('panel.history.pathTooltip'));
    }

    private populateCompareRefs(details: RepoDetails): void {
        const list = this.el('compare-refs');
        const entries = [
            { ref: 'HEAD', label: t('panel.compare.refHead') },
            ...details.branches.map(branch => ({ ref: 'refs/heads/' + branch.name, label: t('panel.compare.refLocal', { name: branch.name }) })),
            ...details.remoteBranches.map(branch => ({ ref: branch.ref, label: t('panel.compare.refRemote', { name: branch.name }) })),
            ...details.tags.map(tag => ({ ref: tag.ref, label: t('panel.compare.refTag', { name: tag.name }) })),
        ];
        const signature = JSON.stringify(entries);
        if (list.dataset.references !== signature || list.childElementCount !== entries.length) {
            list.replaceChildren();
            for (const entry of entries) {
                const option = document.createElement('option'); option.value = entry.ref; option.label = entry.label; list.append(option);
            }
            list.dataset.references = signature;
        }
        if (this.compareRepo !== details.repo.id) {
            const upstream = details.remoteBranches.find(branch => branch.name === details.repo.upstream)?.ref
                || details.branches.find(branch => branch.name === details.repo.upstream)?.name;
            this.el<HTMLInputElement>('compare-base').value = upstream ? upstream.startsWith('refs/') ? upstream : 'refs/heads/' + upstream : 'HEAD';
            this.el<HTMLInputElement>('compare-target').value = 'HEAD';
            this.compareRepo = details.repo.id;
        }
    }

    private compareDraft(): CompareQuery {
        return {
            base: this.el<HTMLInputElement>('compare-base').value.trim(),
            target: this.el<HTMLInputElement>('compare-target').value.trim(),
            mode: this.el<HTMLSelectElement>('compare-mode').value === 'merge-base' ? 'merge-base' : 'direct',
        };
    }

    private async useHistoryForCompare(side: 'base' | 'target'): Promise<void> {
        if (!this.revision || this.mode !== 'history') return;
        this.el<HTMLInputElement>('compare-' + side).value = this.revision;
        this.comparison = undefined; this.compareError = ''; this.compareAttempt = undefined;
        await this.setMode('compare');
    }

    private async loadComparison(): Promise<void> {
        if (this.mode !== 'compare' || !this.details || this.compareLoading) return;
        this.clearInspection();
        const epoch = this.epoch, sequence = ++this.compareEpoch, query = this.compareDraft();
        this.filePage = 0; this.compareLoading = true; this.compareError = ''; this.comparison = undefined; this.compareAttempt = query;
        this.currentFile = undefined; this.currentDiff = undefined; this.selectedLines.clear(); this.diffEpoch++;
        this.renderComparison(); this.renderFiles(); this.renderDiff(); this.updateButtons();
        try {
            const result = await request<Comparison>('details', this.repoId, query);
            if (epoch !== this.epoch || sequence !== this.compareEpoch || this.mode !== 'compare' || this.closed) return;
            this.comparison = result; this.el('notice').hidden = true;
        } catch (e) {
            if (epoch !== this.epoch || sequence !== this.compareEpoch || this.closed) return;
            this.compareError = e instanceof Error ? e.message : String(e); this.error(e);
        } finally {
            if (epoch === this.epoch && sequence === this.compareEpoch) {
                this.compareLoading = false; this.renderComparison(); this.renderFiles(); this.updateButtons();
            }
        }
    }

    private renderComparison(): void {
        const result = this.comparison, note = this.el('compare-note');
        if (!result) {
            const attempt = this.compareAttempt;
            setTooltipTitle(note, '');
            note.textContent = this.compareLoading || this.compareError ? [
                this.compareLoading ? t('panel.compare.loading') : t('panel.compare.failed', { error: this.compareError }),
                ...(attempt ? [t('panel.compare.attempt', { base: attempt.base, target: attempt.target }), attempt.mode === 'direct' ? t('panel.html.compare-mode.option') : t('panel.html.compare-mode.option2')] : []),
                ...(this.compareError ? [t('panel.compare.retryHint')] : []),
            ].join('\n') : t('panel.compare.intro');
            return;
        }
        const draft = this.compareDraft();
        const pending = draft.base !== result.baseLabel || draft.target !== result.targetLabel || draft.mode !== result.mode;
        const lines = [
            result.mode === 'direct' ? t('panel.compare.resultDirect') : t('panel.compare.resultMergeBase'),
            'A ' + result.baseLabel + ' · ' + result.base.slice(0, 12),
            'B ' + result.targetLabel + ' · ' + result.target.slice(0, 12),
            ...(result.mode === 'merge-base' ? [t('panel.compare.mergeBase', { sha: result.effectiveBase.slice(0, 12) })] : []),
            t('panel.compare.counts', { left: result.leftOnly, right: result.rightOnly, files: result.files.length }),
            t('panel.compare.pinned'),
            ...(result.shallow ? [t('panel.compare.shallow')] : []),
            ...(pending ? [t('panel.compare.pending')] : []),
        ];
        note.textContent = lines.join('\n');
        setTooltipTitle(note, 'A ' + result.base + '\nB ' + result.target + '\n' + t('panel.compare.diffBase', { sha: result.effectiveBase }));
    }

    private readonly historyPaging = (event: Event): void => {
        const list = this.el('commit-list');
        if (this.closed || this.mode !== 'history' || !this.details || this.historyLoading || !this.historyCursor || this.busy || this.planning || !this.el('modal').hidden || !this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden) { this.historyScrollArmed = false; return; }
        if (event.type === 'scroll') {
            const down = list.scrollTop > this.historyPagingTop; this.historyPagingTop = list.scrollTop;
            if (!down) return;
        } else this.historyPagingTop = list.scrollTop;
        if (event instanceof WheelEvent) {
            this.historyScrollArmed = event.deltaY > 0;
        } else if (event instanceof KeyboardEvent) {
            this.historyScrollArmed = ['ArrowDown', 'PageDown', 'End'].includes(event.key) || (event.key === ' ' && !event.shiftKey);
        } else if (event.type === 'touchmove' || (event.type === 'pointerdown' && event.target === list)) {
            this.historyScrollArmed = true; return;
        } else if (event.type !== 'scroll') return;
        if (!this.historyScrollArmed || list.scrollHeight - list.scrollTop - list.clientHeight > 120) return;
        this.historyScrollArmed = false;
        void this.guard(() => this.loadHistory(true));
    };

    private renderRepoInfo(details: RepoDetails): void {
        if (details.repo.id !== this.repoId) return;
        const repo = details.repo, branch = details.branches.find(item => item.current);
        const summary = `${repo.name} · ${repo.branch || (repo.head ? t('panel.detachedHead') : t('panel.noCommitsYet'))} · ↑${repo.ahead} ↓${repo.behind}`;
        this.el('repo-info').textContent = summary;
        setTooltipTitle(this.el('repo-info'), `${repo.path}\n${repo.head || t('panel.noCommitsYet')}\n${t('panel.branches.upstream', { upstream: branch ? this.upstreamText(branch) : repo.upstream || t('panel.upstream.unset') })}\n${t('panel.repos.countsFromCache')}\n${t('panel.repos.lastFetch', { time: this.snapshot?.fetchedAt[this.repoId] || t('panel.repos.notFetched') })}`);
    }

    private async loadHistory(more = false, preserveInspection = false): Promise<void> {
        if (this.mode !== 'history' || !this.details || (more && (this.historyLoading || !this.historyCursor))) return;
        this.historyScrollArmed = false;
        const epoch = this.epoch, sequence = ++this.historyEpoch;
        const query: HistoryQuery = { ...this.historyQuery, cursor: more ? this.historyCursor : undefined };
        this.historyLoading = true; this.historyError = '';
        if (!more && !preserveInspection) {
            this.clearTree();
            this.clearInspection();
            this.commits = []; this.historyCursor = undefined; this.historyShallow = false; this.historyTipCount = 0;
            this.historyFiltered = !!query.search || !!query.path;
            this.revision = ''; this.historyFiles = []; this.currentFile = undefined; this.currentDiff = undefined; this.diffEpoch++;
            this.renderFiles(); this.renderDiff();
        }
        this.renderHistory(); this.updateButtons();
        try {
            const page = await request<HistoryPage>('history', this.repoId, 0, query);
            if (epoch !== this.epoch || sequence !== this.historyEpoch || this.mode !== 'history' || this.closed) return;
            this.commits = more ? [...this.commits, ...page.commits] : page.commits;
            this.historyCursor = page.cursor; this.historyShallow = page.shallow; this.historyTipCount = page.tipCount;
            this.historyFiltered = page.filtered;
            this.historyQuery = { scope: page.scope, search: page.search, path: page.path };
            this.el('notice').hidden = true;
        } catch (e) {
            if (epoch !== this.epoch || sequence !== this.historyEpoch || this.closed) return;
            this.historyError = e instanceof Error ? e.message : String(e);
            this.error(e);
        } finally {
            if (sequence === this.historyEpoch && epoch === this.epoch) { this.historyLoading = false; this.renderHistory(); this.updateButtons(); }
        }
    }

    private clearSync(): void {
        this.syncEpoch++; this.syncLoading = false; this.syncPage = undefined;
        this.syncCommits = []; this.syncNextStart = undefined; this.syncError = '';
        this.syncSnapshotChanged = false;
    }

    private async loadSync(more = false, reuseSnapshot = false): Promise<void> {
        if (this.mode !== 'sync' || !this.details || (more && (this.syncLoading || !this.syncPage || this.syncNextStart === undefined))) return;
        const epoch = this.epoch, sequence = ++this.syncEpoch, direction = this.syncDirection;
        const snapshot = more || reuseSnapshot ? this.syncPage?.snapshot : undefined;
        const query: SyncQuery = { kind: 'sync', direction, ...(snapshot ? { snapshot, start: more ? this.syncNextStart : 0 } : {}) };
        this.syncLoading = true; this.syncError = '';
        if (!more) {
            this.clearInspection(); this.cancelDialog();
            this.syncCommits = []; this.syncNextStart = undefined;
            if (!snapshot) {
                this.syncPage = undefined; this.syncSnapshotChanged = false;
            }
            this.revision = ''; this.historyFiles = []; this.currentFile = undefined; this.currentDiff = undefined; this.diffLoading = false; this.diffEpoch++;
            this.renderFiles(); this.renderDiff();
        }
        this.renderSync(); this.updateButtons();
        try {
            const page = await request<SyncPage>('history', this.repoId, 0, query);
            if (epoch !== this.epoch || sequence !== this.syncEpoch || this.mode !== 'sync' || this.closed) return;
            if (page.direction !== direction || page.start !== (query.start || 0) || (snapshot && page.snapshot !== snapshot)) throw new Error(t('panel.sync.snapshotMismatch'));
            if (page.nextStart !== undefined && (!Number.isInteger(page.nextStart) || page.nextStart <= page.start)) throw new Error(t('panel.sync.pageInvalid'));
            const known = new Set(more ? this.syncCommits.map(commit => commit.sha) : []);
            const additional = page.commits.filter(commit => {
                if (known.has(commit.sha)) return false;
                known.add(commit.sha); return true;
            });
            this.syncCommits = more ? [...this.syncCommits, ...additional] : additional;
            this.syncPage = page; this.syncNextStart = page.nextStart;
            this.el('notice').hidden = true;
        } catch (e) {
            if (epoch !== this.epoch || sequence !== this.syncEpoch || this.closed) return;
            this.syncError = e instanceof Error ? e.message : String(e);
            this.error(e);
        } finally {
            if (epoch === this.epoch && sequence === this.syncEpoch && !this.closed) { this.syncLoading = false; this.renderSync(); this.updateButtons(); }
        }
    }

    private renderSync(): void {
        const page = this.syncPage, list = this.el('sync-list'), scrollTop = list.scrollTop;
        const states: Record<SyncPage['state'], string> = { ready: t('panel.sync.stateReady'), unborn: t('panel.sync.stateUnborn'), detached: t('panel.sync.stateDetached'), 'no-upstream': t('panel.sync.stateNoUpstream'), gone: t('panel.sync.stateGone'), invalid: t('panel.sync.stateInvalid') };
        const relations: Record<NonNullable<SyncPage['relation']>, string> = { equal: t('panel.sync.relationEqual'), ahead: t('panel.sync.relationAhead'), behind: t('panel.sync.relationBehind'), diverged: t('panel.sync.relationDiverged'), unrelated: t('panel.sync.relationUnrelated'), unknown: t('panel.sync.relationUnknown') };
        const count = (value: number | undefined): string => value === undefined ? t('panel.unavailable') : String(value);
        this.el('sync-summary').textContent = page ? [
            t('panel.sync.state', { state: states[page.state] }) + (page.relation ? ' · ' + relations[page.relation] : ''),
            t('panel.sync.local', { branch: page.branch || t('panel.none'), head: page.head || t('panel.none') }),
            t('panel.sync.upstream', { ref: page.upstreamRef || t('panel.none'), remote: page.remote === '.' ? t('panel.sync.remoteLocal') : page.remote ? t('panel.sync.remoteName', { remote: page.remote }) : '', head: page.upstreamHead || t('panel.unavailable') }),
            t('panel.sync.counts', { ahead: count(page.ahead), behind: count(page.behind) }),
            t('panel.sync.captured', { capturedAt: page.capturedAt, fetchedAt: page.fetchedAt || t('panel.sync.fetchNotRecorded') }),
            ...(page.shallow ? [t('panel.sync.shallow')] : []),
        ].join('\n') : this.syncLoading ? t('panel.sync.sampling') : t('panel.sync.intro');
        for (const direction of ['outgoing', 'incoming'] as const) {
            const button = this.el<HTMLButtonElement>('sync-' + direction);
            button.classList.toggle('active', direction === this.syncDirection);
            button.setAttribute('aria-pressed', String(direction === this.syncDirection));
            button.textContent = `${direction === 'outgoing' ? t('panel.html.sync-outgoing') : t('panel.html.sync-incoming')} · ${count(direction === 'outgoing' ? page?.ahead : page?.behind)}`;
            button.disabled = this.syncLoading || !this.details || page?.state !== 'ready';
        }
        list.replaceChildren();
        for (const commit of this.syncCommits) {
            const row = document.createElement('button'); row.className = 'history-row sync-row' + (this.revision === commit.sha ? ' active' : '');
            const title = document.createElement('strong'); title.textContent = commit.subject;
            const info = document.createElement('small'); info.textContent = `${commit.short} · ${commit.author} · ${commit.date}${commit.parents.length > 1 ? t('panel.history.mergeSuffix') : ''}`;
            setTooltipTitle(row, `${commit.sha}\n${commit.subject}\n${t('panel.sync.commitTooltip')}`);
            row.append(title, info);
            row.addEventListener('click', () => { void this.guard(() => this.selectHistoryCommit(commit.sha)); });
            list.append(row);
        }
        if (!this.syncCommits.length) {
            const empty = document.createElement('div'); empty.className = 'empty';
            empty.textContent = this.syncLoading ? t('panel.sync.loadingCommits') : this.syncError ? t('panel.sync.readFailed') : page?.state === 'ready' ? (this.syncDirection === 'outgoing' ? t('panel.sync.noLocalOnly') : t('panel.sync.noUpstreamOnly')) : t('panel.sync.stateBlocks');
            list.append(empty);
        }
        list.scrollTop = scrollTop;
        this.el('sync-note').textContent = [
            ...(this.syncSnapshotChanged ? [t('panel.sync.snapshotChanged')] : []),
            page?.notice || t('panel.sync.noAutoSync'),
            t('panel.sync.direction', { direction: this.syncDirection === 'outgoing' ? t('panel.sync.directionOutgoing') : t('panel.sync.directionIncoming'), count: this.syncCommits.length }),
            ...(this.syncError ? [t('panel.readFailed', { error: this.syncError }), this.syncCommits.length ? t('panel.sync.retryHint') : t('panel.sync.refreshHint')] : []),
        ].join('\n');
        this.el('sync-retry').hidden = this.mode !== 'sync' || !this.syncError || this.syncNextStart !== undefined;
        this.el<HTMLButtonElement>('sync-retry').disabled = this.syncLoading || !this.details;
        this.el('sync-more').hidden = this.mode !== 'sync' || this.syncNextStart === undefined;
        this.el<HTMLButtonElement>('sync-more').disabled = this.syncLoading || !this.details;
        this.el('sync-more').textContent = this.syncLoading ? t('panel.loadingShort') : this.syncError ? t('panel.sync.retryMore') : t('panel.html.sync-more');
        this.el<HTMLButtonElement>('sync-refresh').disabled = this.syncLoading || !this.details;
    }

    private clearCommitDetails(): void {
        this.inspectEpoch++; this.inspectRevision = ''; this.inspectPath = undefined;
        this.commitDetails = undefined; this.inspectLoading = false; this.inspectError = ''; this.inspectFileNote = '';
        this.renderCommitDetails();
    }

    private clearBlame(): void {
        this.blameEpoch++; this.blame = undefined; this.blameQuery = undefined;
        this.blameActive = false; this.blameLoading = false; this.blameError = '';
        this.el('blame-status').hidden = true;
        this.el<HTMLDetailsElement>('blame-controls').open = false;
    }

    private clearInspection(): void { this.clearCommitDetails(); this.clearBlame(); }

    private async showCommitDetails(revision: string, preferredPath?: string): Promise<void> {
        if (!revision || !this.details) return;
        if (this.mode !== 'history') this.layout?.revealViewer();
        const epoch = this.epoch, sequence = ++this.inspectEpoch;
        if (this.inspectRevision !== revision) this.el<HTMLDetailsElement>('commit-inspector').open = false;
        this.inspectRevision = revision; this.inspectPath = preferredPath; this.commitDetails = undefined;
        this.inspectError = ''; this.inspectFileNote = ''; this.inspectLoading = true;
        this.renderCommitDetails();
        try {
            const details = await request<CommitDetails>('history', this.repoId, 0, { kind: 'commit', revision });
            if (epoch !== this.epoch || sequence !== this.inspectEpoch || this.closed) return;
            this.commitDetails = details;
        } catch (e) {
            if (epoch !== this.epoch || sequence !== this.inspectEpoch || this.closed) return;
            this.inspectError = e instanceof Error ? e.message : String(e);
        } finally {
            if (epoch === this.epoch && sequence === this.inspectEpoch) { this.inspectLoading = false; this.renderCommitDetails(); }
        }
    }

    private renderCommitDetails(): void {
        this.el('commit-inspector').hidden = !this.inspectRevision || this.mode === 'history';
        this.el('commit-inspector-label').textContent = t('panel.html.commit-inspector-label');
        const details = this.commitDetails;
        const identitySummary = this.el('commit-identity-summary');
        if (details) {
            identitySummary.textContent = `${details.author.name} <${details.author.email}> · ${details.author.date}`;
            setTooltipTitle(identitySummary, t('panel.inspect.identity', { author: `${details.author.name} <${details.author.email}>`, authorDate: details.author.date, committer: `${details.committer.name} <${details.committer.email}>`, commitDate: details.committer.date }));
        } else identitySummary.textContent = '';
        identitySummary.hidden = !details;
        this.el('commit-message').hidden = !details;
        this.el('commit-message').textContent = details?.message || (details ? t('panel.noCommitMessage') : '');
        const parents = this.el('commit-parents'); parents.replaceChildren();
        if (details) {
            const label = document.createElement('span'); label.textContent = t('panel.inspect.parents') + (details.parents.length ? '' : t('panel.inspect.rootCommit')); parents.append(label);
            for (const sha of details.parents) {
                const button = document.createElement('button'); button.className = 'quiet'; button.textContent = sha.slice(0, 12); setTooltipTitle(button, sha);
                button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); void this.guard(() => this.showCommitDetails(sha)); }); parents.append(button);
            }
        }
        this.el('commit-inspector-note').textContent = [
            ...(this.inspectLoading ? [t('panel.inspect.loading')] : []),
            ...(this.inspectError ? [t('panel.inspect.failed', { error: this.inspectError })] : []),
            ...(details?.shallow ? [t('panel.inspect.shallow')] : []),
            ...(details && !this.commits.some(commit => commit.sha === details.sha) ? [t('panel.inspect.notInList')] : []),
            ...(this.inspectPath ? [t('panel.inspect.path', { path: this.inspectPath })] : []),
            ...(this.inspectFileNote ? [this.inspectFileNote] : []),
        ].join('\n');
        this.el<HTMLButtonElement>('commit-files-open').disabled = !details || this.inspectLoading;
        this.renderBranchEntryControls();
        this.el('commit-details-retry').hidden = !this.inspectError;
    }

    private renderBranchEntryControls(): void {
        const repo = this.details?.repo;
        const detached = !!repo && headState(repo) === 'detached';
        setControlValue(this.el('head-context'), 'hidden', !detached);
        setControlValue(this.el('head-context-note'), 'textContent', detached ? t('panel.headContext', { sha: repo!.head.slice(0, 12) }) : '');
        const locked = this.busy || this.planning || !repo || headState(repo) === 'unavailable' || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden);
        this.setDisabled(this.el<HTMLButtonElement>('head-preserve'), locked || !detached);
        this.setDisabled(this.el<HTMLButtonElement>('history-preserve-branch'), locked || this.mode !== 'history' || this.historyLoading || !this.commits.some(commit => commit.sha === this.revision));
        this.setDisabled(this.el<HTMLButtonElement>('commit-preserve-branch'), locked || this.inspectLoading || !this.commitDetails);
        this.setDisabled(this.el<HTMLButtonElement>('commit-start-merge'), locked || this.inspectLoading || !this.commitDetails || !repo?.branch || !!repo.operation);
    }

    private async openInspectedCommit(): Promise<void> {
        const commit = this.commitDetails, preferredPath = this.inspectPath, repoId = this.repoId;
        if (!commit) return;
        let epoch = this.epoch;
        if (this.mode !== 'history' && this.mode !== 'sync') {
            const loading = this.setMode('history'); epoch = this.epoch;
            await loading;
        }
        if (epoch !== this.epoch || this.repoId !== repoId || (this.mode !== 'history' && this.mode !== 'sync') || this.closed) return;
        await this.selectHistoryCommit(commit.sha, preferredPath);
    }

    private async selectHistoryCommit(revision: string, preferredPath?: string): Promise<void> {
        if ((this.mode !== 'history' && this.mode !== 'sync') || !this.details) return;
        this.layout?.revealHistoryFiles();
        const browseTree = this.treeActive && this.mode === 'history';
        this.clearTree(!browseTree);
        const epoch = this.epoch, fileEpoch = ++this.diffEpoch, mode = this.mode;
        this.clearBlame(); this.filePage = 0; this.revision = revision; this.historyFiles = []; this.currentDiff = undefined; this.currentFile = undefined;
        if (mode === 'sync') this.renderSync(); else this.renderHistory();
        this.renderFiles(); this.renderDiff(); this.updateButtons();
        const detailsRequest = this.showCommitDetails(revision, preferredPath);
        try {
            if (browseTree) {
                const directory = preferredPath?.includes('/') ? preferredPath.slice(0, preferredPath.lastIndexOf('/')) : '';
                await Promise.all([this.loadTree(directory), detailsRequest]);
                if (!this.closed && epoch === this.epoch && this.revision === revision && this.treeActive && preferredPath && this.treePage?.entries.some(entry => entry.path === preferredPath && entry.kind !== 'directory')) await this.showDiff(preferredPath, 'tree');
                return;
            }
            const [files] = await Promise.all([request<ChangedFile[]>('commit-files', this.repoId, revision), detailsRequest]);
            if (epoch !== this.epoch || fileEpoch !== this.diffEpoch || this.revision !== revision || this.mode !== mode || this.closed) return;
            this.historyFiles = files; this.el('notice').hidden = true; this.renderFiles();
            const matchingFile = preferredPath && files.find(file => file.path === preferredPath);
            if (matchingFile) await this.showDiff(matchingFile.path, 'commit');
            else if (preferredPath && this.inspectRevision === revision) {
                this.inspectFileNote = t('panel.inspect.pathMissing');
                this.renderCommitDetails();
            }
        } catch (e) {
            if (epoch === this.epoch && fileEpoch === this.diffEpoch && this.revision === revision && !this.closed) this.error(e);
        }
    }

    private populateBlameVersions(): void {
        const select = this.el<HTMLSelectElement>('blame-version'); select.replaceChildren();
        const file = this.currentFile;
        const add = (sha: string | undefined, label: string) => { if (sha) select.add(new Option(`${label} · ${sha.slice(0, 12)}`, sha)); };
        if (file?.area === 'compare') { add(file.baseRevision, this.comparison?.mode === 'merge-base' ? t('panel.blame.mergeBase') : t('panel.html.compare-base.aria')); add(file.revision, t('panel.html.compare-target.aria')); select.selectedIndex = select.options.length - 1; }
        else if (file?.area === 'commit' || file?.area === 'tree') {
            if (this.commitDetails && this.commitDetails.sha === file.revision) add(this.commitDetails.parents[0], t('panel.blame.firstParent'));
            add(file.revision, t('panel.blame.selectedCommit')); select.selectedIndex = select.options.length - 1;
        }
        else if (file?.area === 'worktree' || file?.area === 'index') add(this.details?.repo.head, t('panel.blame.committedHead'));
        this.el('blame-context').textContent = file?.area === 'worktree' || file?.area === 'index'
            ? t('panel.blame.headNote')
            : t('panel.blame.versionNote');
    }

    private canShowBlame(): boolean {
        const file = this.currentFile, diff = this.currentDiff;
        if (!file || !diff || file.area === 'stash' || file.area === 'conflict' || this.isFileComparison()) return false;
        const files = this.mode === 'history' ? this.historyFiles : this.mode === 'compare' ? this.comparison?.files : this.details?.repo.files;
        return !files?.some(item => item.path === file.path && item.submodule) && !diff.before.image && !diff.after.image
            && (typeof diff.before.text === 'string' || typeof diff.after.text === 'string');
    }

    private async loadBlame(more = false): Promise<void> {
        if (!this.currentFile || this.currentFile.area === 'conflict' || this.isFileComparison() || !this.details || this.blameLoading || (more && (!this.blame?.nextStart || !this.blameQuery))) return;
        const select = this.el<HTMLSelectElement>('blame-version');
        const query = more ? this.blameQuery : { revision: select.value, path: this.currentFile.path, label: select.selectedOptions[0]?.text || '' };
        if (!query?.revision) return;
        if (!more) this.el<HTMLDetailsElement>('blame-controls').open = false;
        const epoch = this.epoch, sequence = ++this.blameEpoch, start = more ? this.blame?.nextStart : undefined, boundary = more ? this.blame?.boundary : undefined;
        if (!more) { this.blame = undefined; this.blameQuery = query; }
        this.blameLoading = true; this.blameActive = true; this.blameError = ''; this.renderDiff();
        try {
            const page = await request<FileBlame>('history', this.repoId, 0, { kind: 'blame', revision: query.revision, path: query.path, start, boundary });
            if (epoch !== this.epoch || sequence !== this.blameEpoch || this.closed) return;
            this.blame = more && this.blame ? { ...page, start: this.blame.start, lines: [...this.blame.lines, ...page.lines] } : page;
            this.el('notice').hidden = true;
        } catch (e) {
            if (epoch !== this.epoch || sequence !== this.blameEpoch || this.closed) return;
            this.blameError = e instanceof Error ? e.message : String(e);
        } finally {
            if (epoch === this.epoch && sequence === this.blameEpoch) { this.blameLoading = false; this.renderDiff(); }
        }
    }

    private renderBlame(): void {
        const view = this.el('diff-view'), data = this.blame, query = this.blameQuery;
        view.replaceChildren();
        this.el('blame-note').textContent = [
            query ? `${query.label}\n${query.path}\n${t('panel.blame.pinned', { revision: query.revision })}` : '',
            data ? t('panel.blame.shown', { shown: data.lines.length, total: data.totalLines }) : '',
            this.blameLoading ? t('panel.blame.loading') : '',
            data?.shallow ? t('panel.blame.shallow') : '',
            data?.notice || '',
            this.blameError ? t('panel.blame.failed', { error: this.blameError }) : '',
        ].filter(Boolean).join('\n');
        const more = this.el<HTMLButtonElement>('blame-more'); more.hidden = !data?.nextStart; more.disabled = this.blameLoading;
        more.textContent = this.blameLoading ? t('panel.loadingMore') : this.blameError ? t('panel.blame.retryMore') : t('panel.html.blame-more');
        if (!data?.lines.length) {
            const empty = document.createElement('div'); empty.className = 'empty';
            empty.textContent = this.blameLoading ? t('panel.blame.loading') : data?.notice || (this.blameError ? t('panel.blame.retry') : t('panel.blame.noLines')); view.append(empty); return;
        }
        const list = document.createElement('div'); list.className = 'blame-list';
        for (const line of data.lines) {
            const row = document.createElement('div'); row.className = 'blame-row';
            const number = document.createElement('span'); number.className = 'line-number'; number.textContent = String(line.line);
            const attribution = document.createElement('div'); attribution.className = 'blame-attribution';
            const commit = document.createElement('button'); commit.className = 'quiet'; commit.textContent = `${line.sha.slice(0, 8)} · ${line.author}${line.boundary ? t('panel.blame.boundarySuffix') : ''}`;
            setTooltipTitle(commit, `${line.sha}\n${line.author} <${line.email}>\n${line.date}\n${line.summary}\n${t('panel.blame.originalPath', { path: line.originalPath, line: line.originalLine })}`);
            commit.addEventListener('click', () => { void this.guard(() => this.showCommitDetails(line.sha, line.originalPath)); });
            const source = document.createElement('small'); source.textContent = `${line.originalPath}:${line.originalLine} · ${line.date}`; setTooltipTitle(source, line.summary);
            attribution.append(commit, source);
            const text = document.createElement('code'); text.textContent = line.text; row.append(number, attribution, text); list.append(row);
        }
        view.append(list);
    }

    private renderHistory(): void {
        const list = this.el('commit-list');
        const signature = JSON.stringify([this.repoId, this.historyFiltered, this.historyQuery.path, this.commits.map(commit => [commit.sha, commit.short, commit.subject, commit.author, commit.date, commit.parents, commit.refs, commit.boundary]), this.commits.length ? null : [this.historyLoading, this.historyError]]);
        if (list.dataset.history !== signature || !list.childElementCount) {
            const scrollTop = list.scrollTop, anchor = this.historyViewport?.anchor();
            this.historyViewport?.close(); this.historyViewport = undefined;
            list.replaceChildren();
            list.classList.toggle('graph-list', !this.historyFiltered); list.classList.toggle('filtered-list', this.historyFiltered);
            const graph = this.historyFiltered ? undefined : layoutGraph(this.commits), naturalGraphWidth = graph ? Math.max(38, graph.width * 18 + 16) : 0, graphWidth = Math.min(112, naturalGraphWidth);
            const colors = ['#83b8ff', '#db9fff', '#72d5a2', '#edb774', '#ed8fa5', '#7fd0df'];
            const svgElement = (tag: string) => document.createElementNS('http://www.w3.org/2000/svg', tag);
            const commits = this.commits;
            const createRow = (index: number): HTMLButtonElement => {
                const commit = commits[index]!;
                const row = document.createElement('button'); row.className = 'history-row' + (graph ? ' graph-row' : ' filtered-row') + (commit.sha === this.revision ? ' active' : '');
                row.dataset.historySha = commit.sha;
                if (graph) {
                    const lane = graph.rows[index]!;
                    row.style.minWidth = '0';
                    const svg = svgElement('svg'); svg.setAttribute('width', String(graphWidth)); svg.setAttribute('height', '54'); svg.setAttribute('viewBox', `0 0 ${naturalGraphWidth} 54`); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-hidden', 'true');
                    const draw = (from: number, to: number, start: number, end: number, color: number) => {
                        const edge = svgElement('path'), x = 12 + from * 18, target = 12 + to * 18;
                        edge.setAttribute('d', `M ${x} ${start} C ${x} ${(start + end) / 2} ${target} ${(start + end) / 2} ${target} ${end}`);
                        edge.setAttribute('stroke', colors[color % colors.length]!); edge.setAttribute('stroke-width', '2'); edge.setAttribute('fill', 'none'); svg.append(edge);
                    };
                    for (const edge of lane.edges) draw(edge.from, edge.to, edge.parent ? 27 : 0, 54, edge.to);
                    if (lane.incoming) draw(lane.column, lane.column, 0, 27, lane.column);
                    const dot = svgElement(commit.boundary ? 'rect' : 'circle');
                    if (commit.boundary) { dot.setAttribute('x', String(8 + lane.column * 18)); dot.setAttribute('y', '23'); dot.setAttribute('width', '8'); dot.setAttribute('height', '8'); }
                    else { dot.setAttribute('cx', String(12 + lane.column * 18)); dot.setAttribute('cy', '27'); dot.setAttribute('r', commit.parents.length > 1 ? '5' : '4'); }
                    dot.setAttribute('fill', colors[lane.column % colors.length]!); dot.setAttribute('stroke', '#20252d'); dot.setAttribute('stroke-width', '1.5'); svg.append(dot);
                    row.append(svg);
                }
                const text = document.createElement('span'); text.className = 'graph-text';
                const title = document.createElement('strong'); title.textContent = commit.subject;
                const info = document.createElement('small'); info.textContent = `${commit.short} · ${commit.author} · ${commit.date}${commit.parents.length > 1 ? t('panel.history.mergeSuffix') : ''}${commit.boundary ? t('panel.history.boundarySuffix') : ''}`;
                const refs = document.createElement('span'); refs.className = 'graph-refs'; refs.textContent = commit.refs || '\u00a0';
                text.append(title, info, refs); setTooltipTitle(row, `${commit.subject}\n${info.textContent}\n${commit.refs}\n${t('panel.inspect.parents')}${commit.parents.join(', ') || (commit.boundary ? t('panel.history.incompleteHistory') : t('panel.none'))}\n${t('panel.history.rowTooltip')}`); row.append(text);
                row.addEventListener('click', () => { void this.guard(() => this.selectHistoryCommit(commit.sha, this.historyQuery.path)); });
                const repo = this.repoId;
                row.addEventListener('contextmenu', event => {
                    event.preventDefault(); event.stopPropagation(); this.closeFileMenu();
                    this.copyMenu?.open(row, event.clientX, event.clientY, [
                        { label: t('panel.copy.sha'), text: commit.sha },
                        { label: t('panel.copy.message'), text: async () => (await request<CommitDetails>('history', repo, 0, { kind: 'commit', revision: commit.sha })).message },
                        { label: t('panel.copy.commitInfo'), text: async () => {
                            const details = await request<CommitDetails>('history', repo, 0, { kind: 'commit', revision: commit.sha });
                            return `${details.sha}\n${details.author.name} <${details.author.email}>\n${details.author.date}\n\n${details.message}`;
                        } },
                    ]);
                });
                return row;
            };
            if (commits.length >= HISTORY_VIRTUAL_THRESHOLD) {
                let rowHeight = 54;
                if (this.historyFiltered) {
                    const sample = createRow(0); list.append(sample);
                    rowHeight = sample.getBoundingClientRect().height || 68; sample.remove();
                }
                this.historyViewport = new HistoryViewport(list, commits.map(commit => commit.sha), rowHeight, createRow, scrollTop, anchor);
            } else commits.forEach((_, index) => list.append(createRow(index)));
            if (!this.commits.length) {
                const empty = document.createElement('div'); empty.className = 'empty';
                empty.textContent = this.historyLoading ? t('panel.history.loading') : this.historyError ? t('panel.history.failed') : this.historyFiltered ? t('panel.history.noMatch') : t('panel.history.empty'); list.append(empty);
            }
            if (!this.historyViewport) list.scrollTop = scrollTop;
            list.dataset.history = signature; list.dataset.pending = String(graph?.pending.length || 0); list.dataset.compressed = String(graphWidth < naturalGraphWidth);
        }
        if (this.historyViewport) this.historyViewport.setSelected(this.revision);
        else for (const row of list.children) {
            const active = (row as HTMLElement).dataset.historySha === this.revision && !!this.revision;
            row.classList.toggle('active', active);
        }
        const query = this.historyQuery, conditions = [
            query.scope === 'all' ? t('panel.history.scopeAll') : t('panel.history.scopeCurrent'),
            ...(query.search ? [t('panel.history.searchCondition', { field: query.search.field === 'author' ? t('panel.html.history-field.option2') : t('panel.history.fieldMessage'), text: query.search.text })] : []),
            ...(query.path ? [t('panel.history.pathCondition', { path: query.path })] : []),
        ];
        const historyNote = this.el('history-note');
        setTooltipTitle(historyNote, [
            t('panel.history.applied', { conditions: conditions.join(' · ') }),
            t('panel.history.counts', { commits: this.commits.length, tips: this.historyTipCount }),
            this.historyFiltered ? t('panel.history.filteredNote') : t('panel.history.graphNote', { pending: Number(list.dataset.pending) ? t('panel.history.graphPending', { count: list.dataset.pending }) : '' }),
            ...(this.historyShallow ? [t('panel.history.shallow')] : []),
            t('panel.history.mergeFilesNote'),
            ...(this.historyError ? [t('panel.readFailed', { error: this.historyError })] : []),
        ].join('\n'));
        historyNote.textContent = t('panel.history.footerCount', { count: this.commits.length }) + (this.historyLoading ? t('panel.history.footerLoading') : this.historyCursor ? t('panel.history.footerMore') : '') + (this.historyFiltered ? t('panel.history.footerFiltered') : '') + (this.historyShallow ? t('panel.history.footerShallow') : '') + (this.historyError ? ' · ' + t('panel.readFailed', { error: this.historyError }) : '');
        if (list.dataset.compressed === 'true') setTooltipTitle(historyNote, tooltipTitle(historyNote) + '\n' + t('panel.history.compressed'));
        this.el('history-view-label').textContent = this.historyFiltered ? t('panel.history.filteredCommits') : t('panel.html.history-view-label');
        this.renderHistoryDraft();
        renderActionIcons(this.app);
    }

    private flushFilter(): void {
        if (this.filterTimer) clearTimeout(this.filterTimer);
        this.filterTimer = undefined;
        if (this.filterPending && this.mode === 'working') this.workingFilter.text = this.el<HTMLInputElement>('filter').value;
        this.filterPending = false;
    }

    private changeFilePage(direction: number): void {
        if (this.busy || this.planning || this.filterPending || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden)) return;
        this.filePage = Math.max(0, this.filePage + direction);
        this.selectionEpoch++; this.closeFileMenu(); this.renderFiles(); this.updateButtons();
        this.el('file-list').scrollTop = 0;
    }

    private renderFilePagination(total: number): void {
        this.fileTotal = total;
        const pages = Math.max(1, Math.ceil(total / FILE_PAGE_SIZE));
        this.filePage = Math.min(this.filePage, pages - 1);
        const hidden = this.mode === 'branches' || this.mode === 'tags' || this.treeActive || !this.details || pages <= 1;
        setControlValue(this.el('file-pagination'), 'hidden', hidden);
        setControlValue(this.el('file-page-status'), 'textContent', this.filterPending ? t('panel.files.filtering') : total ? t('panel.files.page', { page: this.filePage + 1, pages, shown: Math.min(FILE_PAGE_SIZE, total - this.filePage * FILE_PAGE_SIZE), total }) : t('panel.files.noItems'));
        const locked = this.busy || this.planning || this.filterPending || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden);
        setControlValue(this.el('file-page-prev'), 'hidden', this.filePage === 0);
        setControlValue(this.el('file-page-next'), 'hidden', this.filePage >= pages - 1);
        this.setDisabled(this.el<HTMLButtonElement>('file-page-prev'), locked || this.filePage === 0);
        this.setDisabled(this.el<HTMLButtonElement>('file-page-next'), locked || this.filePage >= pages - 1);
    }

    private updateWorkingSummary(): void {
        if (this.mode !== 'working' || !this.details) return;
        const { rows, visible, rendered } = this.worklist(), keys = new Set(rendered.map(row => row.key));
        const chosen = rows.filter(row => row.selectable && this.selected.has(row.key));
        const hidden = chosen.filter(row => !keys.has(row.key)).length;
        this.el('working-summary').textContent = t('panel.files.summaryCount', { count: visible.length }) + (visible.length !== rows.length ? t('panel.files.summaryTotal', { total: rows.length }) : '') + (chosen.length ? t('panel.files.summarySelected', { count: chosen.length - hidden }) : '') + (hidden ? t('panel.files.summaryHidden', { count: hidden }) : '');
        this.el('working-summary').parentElement!.hidden = !chosen.length && visible.length === rows.length && !rows.some(row => row.area === 'conflict');
        for (const title of this.app.querySelectorAll<HTMLElement>('[data-working-title]')) {
            const area = title.dataset.workingTitle, all = rows.filter(row => row.area === area), shown = rendered.filter(row => row.area === area);
            const selected = all.filter(row => row.selectable && this.selected.has(row.key)).length;
            const shownSelected = shown.filter(row => row.selectable && this.selected.has(row.key)).length;
            const name = area === 'conflict' ? t('panel.files.areaConflict') : area === 'index' ? t('panel.files.areaIndex') : t('panel.files.areaWorktree');
            title.textContent = `${name} ${all.length}${shown.length !== all.length ? t('panel.files.groupShown', { count: shown.length }) : ''}${selected ? t('panel.files.groupSelected', { count: selected }) : ''}${selected - shownSelected ? t('panel.files.groupHidden', { count: selected - shownSelected }) : ''}`;
        }
    }

    private fileStatus(element: HTMLElement, file: ChangedFile, code: string): void {
        const states: Record<string, string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'renamed', '?': 'untracked', T: 'type' };
        element.dataset.status = file.conflict ? 'conflict' : file.submodule ? 'submodule' : states[code] || 'modified';
    }

    private bindFileMenu(row: HTMLElement, file: string, historical: boolean, source?: FileRevision, workingKey?: string): void {
        const repo = this.repoId;
        row.dataset.filePath = file;
        setTooltipTitle(row, tooltipTitle(row) + '\n' + t('panel.files.rowHint'));
        row.tabIndex = 0;
        row.setAttribute('aria-haspopup', 'menu');
        row.addEventListener('dblclick', event => {
            if (event.target instanceof Element && event.target.closest('input')) return;
            event.preventDefault();
            void this.guard(() => this.doubleClickFile(repo, file));
        });
        row.addEventListener('contextmenu', event => {
            event.preventDefault();
            if (repo !== this.repoId || this.busy || this.planning || this.filterPending) return;
            event.stopPropagation();
            void this.guard(() => this.openFileMenu(row, repo, file, historical, event.clientX, event.clientY, source, workingKey));
        });
        row.addEventListener('keydown', event => {
            if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
                event.preventDefault(); event.stopPropagation();
                if (repo !== this.repoId || this.busy || this.planning || this.filterPending) return;
                const rect = row.getBoundingClientRect();
                void this.guard(() => this.openFileMenu(row, repo, file, historical, rect.left + 16, rect.bottom, source, workingKey));
            } else if ((event.key === 'Enter' || event.key === ' ') && event.target === row) {
                event.preventDefault(); row.click();
            }
        });
    }

    private pinFile(side: 'left' | 'right'): void {
        const target = this.fileMenuTarget;
        if (!target?.source || target.repo !== this.repoId || this.busy || this.planning || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(target.source.revision)) return;
        if (side === 'left') this.fileCompareLeft = { ...target.source }; else this.fileCompareRight = { ...target.source };
        this.closeFileMenu(true);
        if (this.isFileComparison()) { this.diffEpoch++; this.diffLoading = false; this.currentDiff = undefined; this.currentFile = undefined; this.renderDiff(); }
        this.updateButtons();
    }

    private renderFileComparisonControls(): void {
        const left = this.fileCompareLeft, right = this.fileCompareRight;
        const locked = this.closed || this.busy || this.planning || this.diffLoading || !this.details || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden);
        setControlValue(this.el('file-compare-tools'), 'hidden', !left && !right);
        const leftLabel = left ? t('panel.fileCompare.left', { revision: left.revision, path: left.path }) : t('panel.fileCompare.leftUnset');
        const rightLabel = right ? t('panel.fileCompare.right', { revision: right.revision, path: right.path }) : t('panel.fileCompare.rightUnset');
        if (this.el('file-compare-left').textContent !== leftLabel) setControlValue(this.el('file-compare-left'), 'textContent', leftLabel);
        if (this.el('file-compare-right').textContent !== rightLabel) setControlValue(this.el('file-compare-right'), 'textContent', rightLabel);
        this.setDisabled(this.el<HTMLButtonElement>('file-compare-show'), locked || !left || !right);
        this.setDisabled(this.el<HTMLButtonElement>('file-compare-retry'), locked || (this.currentFile?.area === 'worktree-compare' || this.currentFile?.area === 'index-compare' ? !this.currentFile.left : !left || !right));
        this.setDisabled(this.el<HTMLButtonElement>('file-compare-worktree'), locked || !left);
        this.setDisabled(this.el<HTMLButtonElement>('file-compare-index'), locked || !left);
        this.setDisabled(this.el<HTMLButtonElement>('file-compare-swap'), locked || (!left && !right));
        this.setDisabled(this.el<HTMLButtonElement>('file-compare-clear'), this.busy || this.planning || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden) || (!left && !right));
        this.setDisabled(this.el<HTMLButtonElement>('file-compare-open-left'), locked || !left);
        const diskComparison = this.currentFile?.area === 'worktree-compare';
        const indexComparison = this.currentFile?.area === 'index-compare';
        this.setDisabled(this.el<HTMLButtonElement>('file-compare-open-right'), locked || (diskComparison ? this.currentDiff?.worktreeComparison?.right.kind !== 'file' : indexComparison ? !this.currentDiff?.indexComparison : !right));
        const openLabel = indexComparison || diskComparison ? t('panel.fileCompare.openDisk') : t('panel.fileCompare.openRight');
        if (this.el('file-compare-open-right').textContent !== openLabel) setActionLabel(this.el('file-compare-open-right'), openLabel);
        const label = indexComparison ? t('panel.fileCompare.showingIndex', { path: this.currentFile?.path }) : diskComparison ? t('panel.fileCompare.showingDisk', { path: this.currentFile?.path }) : this.currentFile?.area === 'file-compare' ? t('panel.fileCompare.showingPinned') : t('panel.fileCompare.pinned');
        if (this.el('file-compare-current').textContent !== label) setControlValue(this.el('file-compare-current'), 'textContent', label);
    }

    private async showPinnedFiles(force = false): Promise<void> {
        const left = this.fileCompareLeft, right = this.fileCompareRight;
        if (!left || !right || this.closed || this.busy || this.planning || this.diffLoading || !this.details || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden)) return;
        this.layout?.revealViewer();
        this.cancelDialog(); this.clearBlame(); this.selectedLines.clear();
        const epoch = ++this.diffEpoch, repo = this.repoId;
        this.currentFile = { repo, path: right.path, area: 'file-compare', left: { ...left }, right: { ...right }, force };
        this.currentDiff = undefined; this.diffLoading = true; this.populateBlameVersions(); this.updateButtons();
        this.el('file-title').textContent = t('panel.fileCompare.title', { left: left.path, right: right.path });
        this.el('diff-summary').hidden = true; this.el('diff-view').textContent = t('panel.fileCompare.loading');
        try {
            const diff = await request<FileDiff>('diff', this.currentFile);
            if (this.closed || epoch !== this.diffEpoch || repo !== this.repoId) return;
            if (!diff.comparison) throw new Error(t('panel.fileCompare.noMetadata'));
            this.currentDiff = diff; this.renderDiff();
        } catch (error) {
            if (this.closed || epoch !== this.diffEpoch || repo !== this.repoId) return;
            this.el('diff-view').textContent = t('panel.fileCompare.failed'); this.error(error);
        } finally { if (!this.closed && epoch === this.diffEpoch) { this.diffLoading = false; this.updateButtons(); } }
    }

    private isFileComparison(): boolean {
        return this.currentFile?.area === 'file-compare' || this.currentFile?.area === 'worktree-compare' || this.currentFile?.area === 'index-compare';
    }

    private async showLocalFileComparison(source: FileRevision, name: string, area: 'worktree-compare' | 'index-compare' = 'worktree-compare'): Promise<void> {
        if (this.closed || this.busy || this.planning || this.diffLoading || !this.details || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden)) return;
        const left = { ...source };
        this.layout?.revealViewer();
        this.closeFileMenu(true); this.cancelDialog(); this.clearBlame(); this.selectedLines.clear();
        this.fileCompareLeft = left;
        const epoch = ++this.diffEpoch, repo = this.repoId;
        this.currentFile = { repo, path: name, area, left };
        this.currentDiff = undefined; this.diffLoading = true; this.populateBlameVersions(); this.updateButtons();
        const targetLabel = area === 'index-compare' ? t('panel.fileCompare.targetIndex') : t('panel.fileCompare.targetDisk');
        this.el('file-title').textContent = t('panel.fileCompare.titleTarget', { left: left.path, name, target: targetLabel });
        this.el('diff-summary').hidden = true; this.el('diff-view').textContent = t('panel.fileCompare.loadingTarget', { target: targetLabel });
        try {
            const diff = await request<FileDiff>('diff', this.currentFile);
            if (this.closed || epoch !== this.diffEpoch || repo !== this.repoId) return;
            if (area === 'index-compare' ? !diff.indexComparison : !diff.worktreeComparison) throw new Error(t('panel.fileCompare.noTargetMetadata'));
            this.currentDiff = diff; this.renderDiff();
        } catch (error) {
            if (this.closed || epoch !== this.diffEpoch || repo !== this.repoId) return;
            this.el('diff-view').textContent = t('panel.fileCompare.targetFailed', { target: targetLabel }); this.error(error);
        } finally { if (!this.closed && epoch === this.diffEpoch) { this.diffLoading = false; this.updateButtons(); } }
    }

    private closeFileMenu(restore = false): void {
        const origin = this.fileMenuTarget?.origin;
        this.fileMenuEpoch++; this.fileMenuTarget = undefined; this.fileMenuResult = undefined; this.fileMenuBusy = false;
        this.el('file-menu').hidden = true;
        for (const group of this.el('file-menu').querySelectorAll<HTMLDetailsElement>('details')) group.open = false;
        if (restore && origin?.isConnected) origin.focus({ preventScroll: true });
    }

    private placeFileMenu(x: number, y: number): void {
        const menu = this.el('file-menu'), win = this.app.ownerDocument.defaultView;
        menu.style.left = '0px'; menu.style.top = '0px';
        const rect = menu.getBoundingClientRect(), width = win?.innerWidth || this.app.clientWidth, height = win?.innerHeight || this.app.clientHeight;
        menu.style.left = Math.max(8, Math.min(x, width - rect.width - 8)) + 'px';
        menu.style.top = Math.max(8, Math.min(y, height - rect.height - 8)) + 'px';
    }

    private async runFileAction(action: 'stage' | 'unstage' | 'stashSelected' | 'discardFiles'): Promise<void> {
        const target = this.fileMenuTarget;
        if (!target?.workingKey || this.workingSelectionLocked() || !this.details) return;
        if (target.repo !== this.repoId || target.version !== this.details.repo.version || target.selection !== this.selectionEpoch) {
            this.closeFileMenu(); throw new Error(t('panel.fileMenu.stale'));
        }
        const item = this.worklist().rendered.find(row => row.key === target.workingKey && row.file.path === target.file);
        if (!item || item.area === 'conflict') return;
        this.closeFileMenu();
        if (item.file.submodule) {
            if (action !== (item.area === 'index' ? 'unstage' : 'stage')) return;
            return this.prepare(action, item.file.path);
        }
        if (action === 'stage' || action === 'unstage') return this.prepare(action);
        if (action === 'stashSelected') { this.openInput(action); return; }
        const paths = selectedPaths(this.worklist().rendered, this.selected, 'worktree');
        if (paths.length) await this.prepareWorktreeOperation({ repo: this.repoId, version: this.details.repo.version, action, paths });
    }

    private async doubleClickFile(repo: string, file: string): Promise<void> {
        if (this.closed || repo !== this.repoId || this.busy || this.planning || this.filterPending || !this.details
            || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden)) return;
        this.closeFileMenu();
        const epoch = this.epoch, navigation = ++this.navigationEpoch, diffEpoch = this.diffEpoch;
        try {
            const result = await request<EditorFileResult>('reveal', repo, file, 'reveal');
            if (this.closed || epoch !== this.epoch || navigation !== this.navigationEpoch || diffEpoch !== this.diffEpoch || repo !== this.repoId) return;
            if (!result.revealRequested) { this.error(result.reason || t('panel.fileMenu.revealUnconfirmed')); return; }
            if (!result.canOpen) { this.error(t('panel.fileMenu.revealedCannotOpen', { reason: result.reason || t('panel.fileMenu.cannotOpen') })); return; }
            if (this.busy || this.planning || this.filterPending || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden)) return;
            const opened = await request<EditorFileResult>('reveal', repo, file, 'open');
            if (this.closed || epoch !== this.epoch || navigation !== this.navigationEpoch || diffEpoch !== this.diffEpoch || repo !== this.repoId) return;
            if (!opened.openRequested) this.error(t('panel.fileMenu.revealedNotOpened', { reason: opened.reason || t('panel.fileMenu.openUnconfirmed') }));
            else this.el('notice').hidden = true;
        } catch (error) {
            if (!this.closed && epoch === this.epoch && navigation === this.navigationEpoch && diffEpoch === this.diffEpoch && repo === this.repoId) this.error(error);
        }
    }

    private submoduleRepo(file: string): string | undefined {
        const parent = this.details?.repo;
        return parent ? this.snapshot?.repositories.find(repo => repo.parent === parent.id && repo.initialized && !repo.error
            && path.relative(parent.path, repo.path).split(path.sep).join('/') === file)?.id : undefined;
    }

    private async openSubmodule(file: string): Promise<void> {
        if (this.workingSelectionLocked()) return;
        const id = this.submoduleRepo(file);
        if (!id) { this.error(t('panel.fileMenu.submoduleNotReady')); return; }
        this.closeFileMenu();
        await this.selectRepo(id, true);
    }

    private fileMenuNote(text: string): void {
        const note = this.el('file-menu-note'); note.textContent = text; note.hidden = !text;
    }

    private async openFileMenu(origin: HTMLElement, repo: string, file: string, historical: boolean, x: number, y: number, source?: FileRevision, workingKey?: string): Promise<void> {
        this.navigationEpoch++;
        this.closeFileMenu();
        this.copyMenu?.hide();
        if (this.closed || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden)) return;
        if (workingKey) {
            if (this.workingSelectionLocked() || repo !== this.repoId || !this.worklist().rendered.some(row => row.key === workingKey && row.file.path === file)) return;
            this.selected = contextSelection(this.worklist().rendered, this.selected, workingKey);
            this.selectionEpoch++; this.updateWorkingSummary(); this.updateButtons();
        }
        const target = { repo, file, historical, origin, x, y, source: source ? { ...source } : undefined, workingKey, selection: this.selectionEpoch, version: this.details?.repo.version }, epoch = this.fileMenuEpoch;
        this.fileMenuTarget = target;
        const selectedCount = workingKey ? this.worklist().rendered.filter(row => row.selectable && this.selected.has(row.key)).length : 0;
        this.el('file-menu').setAttribute('aria-label', t('panel.fileMenu.aria', { file }));
        this.fileMenuNote(selectedCount > 1 ? t('panel.fileMenu.selectedCount', { count: selectedCount }) : '');
        const pointer = !!workingKey && !!this.worklist().rendered.find(row => row.key === workingKey)?.file.submodule;
        this.el('file-menu-submodule').hidden = !pointer;
        this.el<HTMLButtonElement>('file-menu-submodule').disabled = !pointer || !this.submoduleRepo(file);
        this.el('file-history').hidden = pointer;
        this.el<HTMLButtonElement>('file-history').disabled = this.busy || this.planning || !this.details;
        this.el('file-menu-open').hidden = true;
        this.el('file-menu-reveal').hidden = true;
        this.el<HTMLButtonElement>('file-menu-open').disabled = true;
        this.el<HTMLButtonElement>('file-menu-reveal').disabled = true;
        this.el<HTMLButtonElement>('file-menu-copy').disabled = false;
        for (const side of ['left', 'right']) {
            const button = this.el<HTMLButtonElement>('file-menu-' + side);
            button.hidden = pointer || !source; button.disabled = !source || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.revision);
        }
        this.el('file-menu-restore').hidden=pointer || !source;
        const compareSource = pointer ? undefined : source || (!historical ? this.fileCompareLeft : undefined);
        this.el('file-menu-comparison').hidden = !compareSource;
        this.el('file-menu-worktree-compare').hidden = !compareSource;
        this.el('file-menu-worktree-compare').textContent = source ? t('panel.fileMenu.compareDisk') : t('panel.fileMenu.compareDiskLeft');
        this.el<HTMLButtonElement>('file-menu-worktree-compare').disabled = !compareSource || this.busy || this.planning || this.diffLoading;
        this.el('file-menu-index-compare').hidden = !compareSource;
        this.el('file-menu-index-compare').textContent = source ? t('panel.fileMenu.compareIndex') : t('panel.fileMenu.compareIndexLeft');
        this.el<HTMLButtonElement>('file-menu-index-compare').disabled = !compareSource || this.busy || this.planning || this.diffLoading;
        this.el<HTMLButtonElement>('file-menu-restore').disabled=!source || this.busy || this.planning;
        this.el('file-menu-copy-fallback').hidden = true;
        this.updateButtons();
        this.el('file-menu').hidden = false;
        this.placeFileMenu(x, y); this.el('file-menu').querySelector<HTMLButtonElement>('button:not([hidden]):not(:disabled)')?.focus({ preventScroll: true });
        if (pointer) return;
        try {
            const result = await request<EditorFileResult>('reveal', repo, file, 'describe');
            if (this.closed || epoch !== this.fileMenuEpoch || this.fileMenuTarget !== target || repo !== this.repoId) return;
            this.fileMenuResult = result;
            this.el<HTMLButtonElement>('file-menu-open').disabled = !result.canOpen;
            this.el<HTMLButtonElement>('file-menu-reveal').disabled = !result.canReveal;
            this.el('file-menu-open').hidden = !result.canOpen;
            this.el('file-menu-reveal').hidden = !result.canReveal;
            setTooltipTitle(this.el('file-menu-open'), result.reason || t('panel.fileMenu.openHint'));
            setTooltipTitle(this.el('file-menu-reveal'), file.endsWith('.meta') ? t('panel.fileMenu.revealAsset') : '');
            this.fileMenuNote(historical && (result.canOpen || result.canReveal) ? t('panel.fileMenu.historicalNote') : '');
            this.placeFileMenu(x, y);
        } catch (e) {
            if (!this.closed && epoch === this.fileMenuEpoch && this.fileMenuTarget === target) {
                this.fileMenuNote(e instanceof Error ? e.message : String(e));
                this.placeFileMenu(x, y);
            }
        }
    }

    private async navigateFile(action: 'open' | 'reveal'): Promise<void> {
        const target = this.fileMenuTarget, result = this.fileMenuResult, epoch = this.fileMenuEpoch;
        if (!target || !result || this.fileMenuBusy || target.repo !== this.repoId || this.busy || this.planning || (action === 'open' ? !result.canOpen : !result.canReveal)) return;
        this.fileMenuBusy = true;
        this.el<HTMLButtonElement>('file-menu-open').disabled = true; this.el<HTMLButtonElement>('file-menu-reveal').disabled = true;
        try {
            const response = await request<EditorFileResult>('reveal', target.repo, target.file, action);
            if (this.closed || epoch !== this.fileMenuEpoch || this.fileMenuTarget !== target) return;
            this.fileMenuNote([response.openRequested ? t('panel.fileMenu.openRequested') : response.revealRequested ? t('panel.fileMenu.revealRequested') : '', response.reason || (!response.openRequested && !response.revealRequested ? t('panel.fileMenu.unconfirmed') : '')].filter(Boolean).join('\n'));
            this.fileMenuResult = response;
        } catch (e) {
            if (!this.closed && epoch === this.fileMenuEpoch) this.fileMenuNote(e instanceof Error ? e.message : String(e));
        } finally {
            if (!this.closed && epoch === this.fileMenuEpoch && this.fileMenuTarget === target) {
                this.fileMenuBusy = false;
                this.el<HTMLButtonElement>('file-menu-open').disabled = !this.fileMenuResult?.canOpen;
                this.el<HTMLButtonElement>('file-menu-reveal').disabled = !this.fileMenuResult?.canReveal;
                this.placeFileMenu(target.x, target.y);
            }
        }
    }

    private async copyFilePath(): Promise<void> {
        const target = this.fileMenuTarget, epoch = this.fileMenuEpoch;
        if (!target) return;
        try {
            const clipboard = this.app.ownerDocument.defaultView?.navigator.clipboard;
            if (!clipboard) throw new Error(t('panel.clipboardUnavailable'));
            await clipboard.writeText(target.file);
            if (!this.closed && epoch === this.fileMenuEpoch) this.closeFileMenu(true);
        } catch {
            if (this.closed || epoch !== this.fileMenuEpoch) return;
            const input = this.el<HTMLInputElement>('file-menu-copy-fallback');
            input.value = target.file; input.hidden = false; input.focus(); input.select();
            this.fileMenuNote(t('panel.fileMenu.copyFailed'));
        } finally {
            if (!this.closed && epoch === this.fileMenuEpoch && this.fileMenuTarget === target) this.placeFileMenu(target.x, target.y);
        }
    }

    private fileMenuKey(event: KeyboardEvent): void {
        if (this.el('file-menu').hidden) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.closeFileMenu(true); return; }
        if (event.key === 'Tab') { this.closeFileMenu(true); return; }
        if (event.composedPath().includes(this.el('file-menu-copy-fallback'))) return;
        if (!event.composedPath().includes(this.el('file-menu'))) return;
        const group = event.composedPath().find(node => node instanceof HTMLDetailsElement) as HTMLDetailsElement | undefined;
        if (group && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
            event.preventDefault(); event.stopPropagation();
            group.open = event.key === 'ArrowRight';
            if (group.open) group.querySelector<HTMLButtonElement>('button:not([hidden]):not(:disabled)')?.focus();
            else group.querySelector('summary')?.focus();
            return;
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
        const items = [...this.el('file-menu').querySelectorAll<HTMLElement>('button:not(:disabled), summary')]
            .filter(item => !item.closest('[hidden]') && (item.matches('summary') || !item.closest('details:not([open])')));
        if (!items.length) return;
        event.preventDefault(); event.stopPropagation();
        const active = items.findIndex(item => event.composedPath().includes(item));
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (active + 1) % items.length : (active - 1 + items.length) % items.length;
        items[next]?.focus({ preventScroll: true });
    }

    private workingSelectionLocked(): boolean {
        return this.mode !== 'working' || this.filterPending || this.busy || this.planning || !this.details || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden);
    }

    private resetWorkingFilter(): void {
        this.flushFilter(); this.filePage = 0;
        this.workingFilter = { text: '', area: 'all', status: 'all', kind: 'all' };
        this.el<HTMLInputElement>('filter').value = '';
        for (const id of ['working-area', 'working-status', 'working-kind']) this.el<HTMLSelectElement>(id).value = 'all';
    }

    private worklist(): { rows: WorkingRow[]; visible: WorkingRow[]; rendered: WorkingRow[] } {
        const files = this.details?.repo.files, filter = JSON.stringify(this.workingFilter);
        if (!this.workingCache || this.workingCache.files !== files || this.workingCache.filter !== filter) {
            const rows = workingRows(files || [], false);
            this.workingCache = { files, filter, rows, visible: filterWorkingRows(rows, this.workingFilter) };
        }
        const { rows, visible } = this.workingCache;
        const page = Math.min(this.filePage, Math.max(0, Math.ceil(visible.length / FILE_PAGE_SIZE) - 1));
        return { rows, visible, rendered: visible.slice(page * FILE_PAGE_SIZE, (page + 1) * FILE_PAGE_SIZE) };
    }

    private fileRowCache = new Map<string, { signature: string; row: HTMLElement }>();

    private cachedFileRow(key: string, data: unknown, create: () => HTMLElement): HTMLElement {
        const signature = JSON.stringify([this.repoId, this.mode, this.revision, this.comparison?.effectiveBase, this.comparison?.target, data]);
        const cache = this.fileRowCache ||= new Map();
        const previous = cache.get(key);
        if (previous?.signature === signature) return previous.row;
        const row = create(); cache.set(key, { signature, row }); return row;
    }

    private reconcileFileRows(list: HTMLElement, rows: HTMLElement[]): void {
        const retained = new Set(rows), root = list.getRootNode();
        const focused = root instanceof ShadowRoot ? root.activeElement : list.ownerDocument.activeElement;
        for (const child of [...list.children]) if (!retained.has(child as HTMLElement)) child.remove();
        for (const [index, row] of rows.entries()) if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
        if (focused instanceof HTMLElement && list.contains(focused)) focused.focus({ preventScroll: true });
        for (const [key, entry] of this.fileRowCache || []) if (!retained.has(entry.row)) this.fileRowCache.delete(key);
    }

    private renderWorkingFiles(): void {
        const list = this.el('file-list'), scrollTop = list.scrollTop;
        const focused = list.querySelector<HTMLInputElement>('input[data-working-key]:focus, input[data-working-group]:focus');
        const focusedKey = focused?.dataset.workingKey, focusedGroup = focused?.dataset.workingGroup;
        const children: HTMLElement[] = [];
        const summary = this.el('working-summary'), warning = this.el('working-conflicts');
        warning.hidden = true;
        if (!this.details) {
            summary.textContent = this.repoLoading ? t('panel.files.loadingChanges') : this.repoLoadError || t('panel.files.waitingState');
            const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = summary.textContent;
            this.reconcileFileRows(list, [empty]); this.renderFilePagination(0); return;
        }
        const { rows, visible, rendered } = this.worklist(), repo = this.repoId;
        this.renderFilePagination(visible.length); this.updateWorkingSummary();
        const conflicts = rows.filter(row => row.area === 'conflict').length;
        warning.hidden = !conflicts;
        warning.textContent = t('panel.files.conflictWarning', { conflicts, matched: visible.filter(row => row.area === 'conflict').length });
        if (!rows.length || !visible.length) {
            const empty = document.createElement('div'); empty.className = 'empty';
            empty.textContent = rows.length ? t('panel.files.noMatch') : t('panel.files.noChanges');
            this.reconcileFileRows(list, [empty]); return;
        }
        for (const [area, name] of [['conflict', t('panel.files.areaConflict')], ['worktree', t('panel.files.areaWorktree')], ['index', t('panel.files.areaIndex')]] as const) {
            const all = rows.filter(row => row.area === area), shown = rendered.filter(row => row.area === area);
            if (!shown.length && this.workingFilter.area !== 'all' && this.workingFilter.area !== area) continue;
            if (area === 'conflict' && !all.length) continue;
            const selectable = shown.filter(row => row.selectable);
            const selected = all.filter(row => row.selectable && this.selected.has(row.key)).length;
            const visibleSelected = selectable.filter(row => this.selected.has(row.key)).length;
            const label = this.cachedFileRow('group:' + area, [all.length, shown.map(row => [row.key, row.selectable]), selected, visibleSelected, this.workingSelectionLocked()], () => {
                const label = document.createElement('div'); label.className = 'file-group working-group';
                const title = document.createElement('span'); title.dataset.workingTitle = area;
                title.textContent = `${name} ${all.length}${shown.length !== all.length ? t('panel.files.groupShown', { count: shown.length }) : ''}${selected ? t('panel.files.groupSelected', { count: selected }) : ''}${selected - visibleSelected ? t('panel.files.groupHidden', { count: selected - visibleSelected }) : ''}`;
                label.append(title);
                if (area !== 'conflict' && selectable.length) {
                    const bulkLabel = document.createElement('label'), bulk = document.createElement('input');
                    bulk.type = 'checkbox'; bulk.dataset.workingGroup = area;
                    bulk.checked = !!selectable.length && visibleSelected === selectable.length;
                    bulk.indeterminate = visibleSelected > 0 && visibleSelected < selectable.length;
                    bulk.disabled = !selectable.length || this.workingSelectionLocked();
                    bulk.setAttribute('aria-label', t('panel.files.bulkAria', { name }));
                    bulk.addEventListener('change', () => {
                        if (this.workingSelectionLocked() || repo !== this.repoId) return;
                        this.selected = selectVisible(this.selected, this.worklist().rendered.filter(row => row.area === area), bulk.checked);
                        this.selectionEpoch++; this.updateWorkingSummary(); this.updateButtons();
                    });
                    setTooltipTitle(bulkLabel, t('panel.files.bulkTooltip', { name }));
                    bulkLabel.append(bulk, title); label.append(bulkLabel);
                }
                return label;
            });
            children.push(label);
            for (const item of shown) {
                const file = item.file;
                const row = this.cachedFileRow(item.key, [file, item.selectable], () => {
                    const row = document.createElement('div'); row.className = 'file-row';
                    row.dataset.workingRow = item.key;
                    row.dataset.fileArea = area;
                    setTooltipTitle(row, file.oldPath ? `${file.oldPath} → ${file.path}` : file.path);
                    if (this.currentFile?.path === file.path && this.currentFile.area === area) row.classList.add('active');
                    if (area !== 'conflict') {
                        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.workingKey = item.key;
                        checkbox.checked = item.selectable && this.selected.has(item.key); checkbox.disabled = !item.selectable || this.workingSelectionLocked();
                        checkbox.setAttribute('aria-label', t('panel.files.selectAria', { name, path: file.path }));
                        if (!item.selectable) setTooltipTitle(checkbox, t('panel.files.pointerHint'));
                        checkbox.addEventListener('click', event => event.stopPropagation());
                        checkbox.addEventListener('change', () => {
                            if (this.workingSelectionLocked() || repo !== this.repoId) return;
                            if (!this.worklist().rendered.some(current => current.key === item.key && current.selectable)) return;
                            if (checkbox.checked) this.selected.add(item.key); else this.selected.delete(item.key);
                            this.selectionEpoch++; this.updateWorkingSummary(); this.updateButtons();
                        });
                        row.append(checkbox);
                    }
                    const status = document.createElement('span'); status.className = 'file-status' + (file.conflict ? ' conflict' : '');
                    this.fileStatus(status, file, area === 'worktree' ? file.worktree : file.index);
                    status.textContent = area === 'conflict' ? file.index + file.worktree : file.submodule ? t('panel.files.pointer') : area === 'worktree' ? file.worktree : file.index;
                    const filename = document.createElement('span'); filename.className = 'file-path'; filename.textContent = file.path;
                    row.append(status, filename);
                    this.bindFileMenu(row, file.path, false, undefined, item.key);
                    row.addEventListener('click', event => {
                        if (event.detail > 1) return;
                        if (this.busy || this.planning || this.filterPending || !this.details || repo !== this.repoId || this.mode !== 'working') return;
                        void this.guard(() => this.showDiff(file.path, area));
                    });
                    return row;
                });
                row.classList.toggle('active', this.currentFile?.path === file.path && this.currentFile.area === area);
                const checkbox = row.querySelector<HTMLInputElement>('input[data-working-key]');
                if (checkbox) { checkbox.checked = item.selectable && this.selected.has(item.key); checkbox.disabled = !item.selectable || this.workingSelectionLocked(); }
                children.push(row);
            }
        }
        this.reconcileFileRows(list, children);
        if (focusedKey || focusedGroup) {
            const input = [...list.querySelectorAll<HTMLInputElement>('input[data-working-key], input[data-working-group]')]
                .find(item => focusedKey ? item.dataset.workingKey === focusedKey : item.dataset.workingGroup === focusedGroup);
            input?.focus({ preventScroll: true });
        }
        list.scrollTop = scrollTop;
        this.renderFileLfsBadges();
    }

    private renderFiles(): void {
        this.closeFileMenu();
        this.copyMenu?.hide();
        if (this.treeActive && this.mode === 'history') { this.renderTree(); return; }
        if (this.mode === 'working') { this.renderWorkingFiles(); return; }
        const list = this.el('file-list'), children: HTMLElement[] = [], scrollTop = list.scrollTop;
        const filter = this.mode === 'history' ? '' : this.el<HTMLInputElement>('filter').value.toLowerCase();
        const source = this.mode === 'compare' ? this.comparison?.files || [] : this.historyFiles;
        const matching = source.filter(f => f.path.toLowerCase().includes(filter) || f.oldPath?.toLowerCase().includes(filter));
        this.renderFilePagination(matching.length);
        const files = matching.slice(this.filePage * FILE_PAGE_SIZE, (this.filePage + 1) * FILE_PAGE_SIZE);
        const groups: { name: string; area: DiffRequest['area']; files: ChangedFile[] }[] = this.mode === 'stash' ? [
            { name: this.revision ? t('panel.files.stashTracked') : t('panel.files.selectStash'), area: 'stash', files: files.filter(f => f.stashPart === 'tracked') },
            { name: t('panel.files.stashIndex'), area: 'stash', files: files.filter(f => f.stashPart === 'index') },
            { name: t('panel.files.stashUntracked'), area: 'stash', files: files.filter(f => f.stashPart === 'untracked') },
        ] : this.mode === 'compare' ? [{ name: this.compareLoading ? t('panel.files.compareLoading') : this.comparison ? t('panel.files.compareResult') : this.compareError ? t('panel.files.compareFailed') : t('panel.files.compareIdle'), area: 'compare', files }] : [
            { name: this.revision ? t('panel.files.commitFiles') : t('panel.files.selectCommit'), area: 'commit', files },
        ];
        for (const group of groups) {
            if (this.mode !== 'history') children.push(this.cachedFileRow('group:' + group.name, group.files.length, () => {
                const label = document.createElement('div'); label.className = 'file-group'; label.textContent = `${group.name} (${group.files.length})`; return label;
            }));
            for (const file of group.files) {
                const row = this.cachedFileRow(group.area + ':' + (file.stashPart || '') + ':' + file.path, file, () => {
                    const row = document.createElement('div'); row.className = 'file-row'; setTooltipTitle(row, file.oldPath ? `${file.oldPath} → ${file.path}` : file.path);
                    row.dataset.fileArea = group.area; row.dataset.stashPart = file.stashPart || '';
                    if (this.currentFile?.path === file.path && this.currentFile.area === group.area) row.classList.add('active');
                    const status = document.createElement('span'); status.className = 'file-status' + (file.conflict ? ' conflict' : ''); status.textContent = file.submodule ? t('panel.files.pointer') : file.index;
                    this.fileStatus(status, file, file.index);
                    const name = document.createElement('span'); name.className = 'file-path'; name.textContent = file.path;
                    row.append(status, name);
                    this.bindFileMenu(row, file.path, true, this.mode === 'history' && file.index !== 'D' ? { revision: this.revision, path: file.path } : undefined);
                    row.addEventListener('click', event => { if (event.detail <= 1) void this.guard(() => this.showDiff(file.path, group.area, file.stashPart)); });
                    return row;
                });
                row.classList.toggle('active', this.currentFile?.path === file.path && this.currentFile.area === group.area && (!file.stashPart || this.currentFile.stashPart === file.stashPart));
                children.push(row);
            }
        }
        if (this.mode === 'compare' && this.comparison && !files.length) {
            const empty = document.createElement('div'); empty.className = 'empty';
            empty.textContent = source.length ? t('panel.files.compareNoMatch') : t('panel.files.compareNoDiff');
            children.push(empty);
        }
        this.reconcileFileRows(list, children);
        list.scrollTop = scrollTop;
        this.renderFileLfsBadges();
    }

    private async showDiff(name: string, area: DiffRequest['area'], stashPart?: ChangedFile['stashPart']): Promise<void> {
        if (area === 'compare' && !this.comparison) return;
        if (this.currentFile?.path !== name || this.currentFile.area !== area || (['commit', 'stash', 'tree'].includes(area) && this.currentFile.revision !== this.revision)) this.sides = false;
        this.layout?.revealViewer();
        this.stashFileSelection = area === 'stash' ? this.historyFiles.find(file => file.path === name && file.stashPart === stashPart) : undefined;
        this.cancelDialog();
        this.clearBlame();
        const epoch = ++this.diffEpoch;
        this.currentDiff = undefined; this.diffLoading = true; this.diffRenderPending = false; this.selectedLines.clear();
        this.currentFile = {
            repo: this.repoId, path: name, area,
            revision: area === 'compare' ? this.comparison?.target : area === 'commit' || area === 'stash' || area === 'tree' ? this.revision : undefined,
            baseRevision: area === 'compare' ? this.comparison?.effectiveBase : undefined,
            stashPart,
        };
        this.populateBlameVersions();
        // Keep the row alive between click and dblclick; replacing it cancels the native gesture.
        this.closeFileMenu();
        for (const row of this.el('file-list').querySelectorAll<HTMLElement>('[data-file-path]')) {
            row.classList.toggle('active', row.dataset.filePath === name && row.dataset.fileArea === area && (area !== 'stash' || row.dataset.stashPart === (stashPart || '')));
        }
        this.updateButtons(); this.el('diff-summary').hidden = true;
        this.el('file-title').textContent = name + (area === 'conflict' ? ' · ' + t('panel.files.areaConflict') : area === 'compare' ? ` · ${this.currentFile.baseRevision?.slice(0, 8)} → ${this.currentFile.revision?.slice(0, 8)}` : area === 'stash' ? ` · ${this.stashRef} · ${stashPart === 'index' ? t('panel.diff.index') : stashPart === 'untracked' ? t('panel.diff.untracked') : t('panel.diff.worktree')}` : area === 'index' ? ' · ' + t('panel.diff.index') : area === 'commit' ? ' · ' + this.revision.slice(0, 8) : ' · ' + t('panel.diff.worktree'));
        if (area === 'tree') this.el('file-title').textContent = name + ' · ' + t('panel.diff.treeSnapshot', { revision: this.revision.slice(0, 12) });
        this.el('diff-view').textContent = t('panel.diff.loading');
        try {
            const query = { ...this.currentFile };
            const key = JSON.stringify([this.details?.repo.version, query]);
            const share = ['commit', 'tree', 'compare', 'stash'].includes(area);
            const diff = await (this.diffReads ||= new LatestRead<FileDiff>()).read(key, () => request<FileDiff>('diff', query), () => epoch === this.diffEpoch && !this.closed, share);
            if (!diff || epoch !== this.diffEpoch || this.closed) return;
            if (area === 'conflict' && !diff.conflict) throw new Error(t('panel.diff.noConflictSnapshot'));
            this.currentDiff = diff;
            if (this.panelVisible()) { this.el('notice').hidden = true; this.renderDiff(); }
            else this.diffRenderPending = true;
        } catch (e) {
            if (epoch !== this.diffEpoch || this.closed) return;
            if (this.blameActive) this.renderDiff();
            else this.el('diff-view').textContent = area === 'conflict' ? t('panel.diff.conflictFailed') : t('panel.diff.failed');
            this.error(e); this.updateButtons();
        } finally { if (epoch === this.diffEpoch && !this.closed) { this.diffLoading = false; if (this.panelVisible()) this.updateButtons(); } }
    }

    private fileLfsKey(name: string, area: string, stashPart = ''): string {
        return JSON.stringify([this.repoId, this.details?.repo.version, this.revision, this.comparison?.effectiveBase, this.comparison?.target, name, area, stashPart]);
    }

    private renderFileLfsBadges(): void {
        for (const row of this.el('file-list').querySelectorAll<HTMLElement>('[data-file-path]')) {
            const note = this.fileLfs.get(this.fileLfsKey(row.dataset.filePath || '', row.dataset.fileArea || '', row.dataset.stashPart));
            let badge = row.querySelector<HTMLElement>('.file-lfs');
            if (!note) { badge?.remove(); continue; }
            if (!badge) { badge = document.createElement('span'); badge.className = 'file-lfs'; badge.textContent = 'LFS'; row.append(badge); }
            setTooltipTitle(badge, note); badge.setAttribute('aria-label', note);
        }
    }

    private changedSideLines(diff: FileDiff): { before: Set<number>; after: Set<number> } {
        const before = new Set<number>(), after = new Set<number>();
        if (diff.partial) {
            for (const hunk of diff.partial.hunks) for (const line of hunk.lines) {
                if (line.kind === '-' && line.oldLine !== undefined) before.add(line.oldLine);
                if (line.kind === '+' && line.newLine !== undefined) after.add(line.newLine);
            }
        } else {
            let oldLine = 0, newLine = 0, oldRemaining = 0, newRemaining = 0;
            for (const line of diff.patch.split('\n')) {
                const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
                if (hunk) { oldLine = Number(hunk[1]); oldRemaining = Number(hunk[2] ?? 1); newLine = Number(hunk[3]); newRemaining = Number(hunk[4] ?? 1); continue; }
                if (line.startsWith('-') && oldRemaining > 0) { before.add(oldLine++); oldRemaining--; }
                else if (line.startsWith('+') && newRemaining > 0) { after.add(newLine++); newRemaining--; }
                else if (line.startsWith(' ') && oldRemaining > 0 && newRemaining > 0) { oldLine++; newLine++; oldRemaining--; newRemaining--; }
            }
        }
        return { before, after };
    }

    private renderDiff(): void {
        const observed = this.currentFile && ['worktree', 'conflict'].includes(this.currentFile.area) && this.currentFile.repo === this.repoId && this.details
            ? path.resolve(this.details.repo.path, this.currentFile.path) : undefined;
        const root = this.details?.repo.path;
        this.diskObserver.setFile(observed && root && observed.startsWith(path.resolve(root) + path.sep) ? observed : undefined);
        this.diffViewport?.close(); this.diffViewport = undefined;
        for (const viewport of this.sideViewports || []) viewport.close();
        this.sideViewports = [];
        const view = this.el('diff-view'), scrollTop = this.blameActive ? view.scrollTop : 0;
        const sideKey = this.sides && this.currentFile ? JSON.stringify([this.repoId, this.currentFile.path, this.currentFile.area, this.currentFile.revision, this.currentFile.baseRevision, this.currentFile.stashPart]) : '';
        const sameSides = !!sideKey && sideKey === this.sideScrollKey;
        const sideTop = sameSides ? view.scrollTop : 0, sideLeft = sameSides ? [...view.querySelectorAll<HTMLElement>('.side')].map(side => side.scrollLeft) : [];
        this.sideScrollKey = sideKey; view.replaceChildren();
        if (!this.blameActive) view.scrollTop = 0;
        for (const id of ['patch-tab', 'sides-tab']) this.el(id).hidden = !this.currentFile || !this.currentDiff || !!this.currentDiff.conflict || this.currentFile.area === 'tree';
        this.el('patch-tab').classList.toggle('active', !this.sides && !this.blameActive); this.el('sides-tab').classList.toggle('active', this.sides && !this.blameActive);
        this.el('blame-run').classList.toggle('active', this.blameActive);
        const lfsConflict = this.currentDiff?.conflict && (this.currentDiff.conflict.working.lfs || this.currentDiff.conflict.stages.some(stage => stage.content.lfs));
        const lfsLimited = (this.currentDiff?.before.lfs && this.currentDiff.before.notice) || (this.currentDiff?.after.lfs && this.currentDiff.after.notice);
        const lfsNote = lfsConflict ? t('panel.diff.lfsConflict') : lfsLimited ? t('panel.diff.lfsLimited') : this.currentDiff?.before.lfs || this.currentDiff?.after.lfs ? t('panel.diff.lfsContent') : '';
        if (this.currentFile?.repo === this.repoId && this.currentDiff) {
            const key = this.fileLfsKey(this.currentFile.path, this.currentFile.area, this.currentFile.stashPart);
            if (lfsNote) this.fileLfs.set(key, lfsNote); else this.fileLfs.delete(key);
            if (this.fileLfs.size > 500) this.fileLfs.delete(this.fileLfs.keys().next().value!);
        }
        this.renderFileLfsBadges();
        this.el('line-tools').hidden = this.currentFile?.area === 'conflict' || this.isFileComparison() || this.blameActive || this.sides || this.mode !== 'working' || !this.currentDiff?.partial;
        this.el('diff-summary').hidden = this.blameActive || !this.currentDiff?.summary;
        this.el('diff-summary').textContent = this.currentDiff?.summary || '';
        this.el('blame-controls').hidden = !this.canShowBlame();
        this.el('blame-status').hidden = !this.blameActive;
        if (this.blameActive) { this.renderBlame(); view.scrollTop = scrollTop; this.updateButtons(); return; }
        if (!this.currentDiff) {
            const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = t('panel.diff.selectFile'); view.append(empty); this.el('file-title').textContent = t('panel.diff.selectFileTitle'); return;
        }
        const diff = this.currentDiff;
        if (this.currentFile?.area === 'tree') {
            const content = diff.after, container = document.createElement('div'); container.className = 'tree-preview';
            if (content.notice) { const notice = document.createElement('p'); notice.textContent = content.notice; container.append(notice); }
            else if (content.image) { const image = document.createElement('img'); image.src = content.image; image.alt = diff.path; container.append(image); }
            else { const pre = document.createElement('pre'), text = content.text || '', lines = text.slice(0, 200000).split('\n', 15001); pre.textContent = text ? lines.slice(0, 15000).join('\n') : content.exists === true ? t('panel.diff.emptyFile') : t('panel.diff.emptyOrMissing'); container.append(pre); if (text.length > 200000 || lines.length > 15000) { const notice = document.createElement('p'); notice.textContent = t('panel.diff.truncatedPreview'); container.append(notice); } }
            view.append(container); this.updateButtons(); return;
        }
        if (diff.conflict) { this.renderConflict(diff.conflict); this.updateButtons(); return; }
        if (!this.sides && diff.partial && this.mode === 'working') {
            const patch = document.createElement('div'); patch.className = 'line-patch';
            type Row = DiffViewportRow & ({ kind: 'hunk'; hunk: number } | { kind: 'line'; line: PatchLine } | { kind: 'eof' });
            const rows: Row[] = [];
            for (let i = 0; i < diff.partial.hunks.length; i++) {
                const hunk = diff.partial.hunks[i]!;
                rows.push({ kind: 'hunk', hunk: i, text: hunk.header, height: 36, focusable: true });
                for (const line of hunk.lines) {
                    rows.push({ kind: 'line', line, text: line.kind + line.text, code: line.text, height: 21, focusable: !!line.id });
                    if (line.noNewline) rows.push({ kind: 'eof', text: t('panel.diff.noNewline'), height: 21 });
                }
            }
            const createRow = (index: number): HTMLElement => {
                const item = rows[index]!;
                if (item.kind === 'eof') { const note = document.createElement('div'); note.className = 'line-eof'; note.textContent = item.text; return note; }
                if (item.kind === 'hunk') {
                    const hunk = diff.partial!.hunks[item.hunk]!, heading = document.createElement('div'); heading.className = 'line-hunk';
                    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.dataset.hunk = String(item.hunk); toggle.setAttribute('aria-label', t('panel.diff.selectHunk'));
                    const ids = hunk.lines.flatMap(line => line.id ? [line.id] : []), count = ids.filter(id => this.selectedLines.has(id)).length;
                    toggle.checked = ids.length > 0 && count === ids.length; toggle.indeterminate = count > 0 && count < ids.length; toggle.disabled = this.busy || this.planning;
                    toggle.addEventListener('change', () => { for (const id of ids) { if (toggle.checked) this.selectedLines.add(id); else this.selectedLines.delete(id); } this.updateButtons(); });
                    const title = document.createElement('span'); title.textContent = hunk.header; heading.append(toggle, title); return heading;
                }
                const line = item.line, row = document.createElement('div'); row.className = 'line-row ' + (line.kind === '+' ? 'add' : line.kind === '-' ? 'delete' : 'context');
                const check = document.createElement(line.id ? 'input' : 'span');
                if (check instanceof HTMLInputElement && line.id) {
                    const id = line.id; check.type = 'checkbox'; check.dataset.line = id; check.setAttribute('aria-label', line.kind === '+' ? t('panel.diff.selectAddedLine', { line: line.newLine ?? line.oldLine }) : t('panel.diff.selectRemovedLine', { line: line.newLine ?? line.oldLine }));
                    check.checked = this.selectedLines.has(id); check.disabled = this.busy || this.planning; row.classList.toggle('selected', check.checked);
                    check.addEventListener('change', () => { if (check.checked) this.selectedLines.add(id); else this.selectedLines.delete(id); this.updateButtons(); });
                }
                const oldNumber = document.createElement('span'), newNumber = document.createElement('span'); oldNumber.className = newNumber.className = 'line-number'; oldNumber.textContent = String(line.oldLine ?? ''); newNumber.textContent = String(line.newLine ?? '');
                const content = document.createElement('span'); content.className = 'line-content'; content.dataset.diffPrefix = line.kind; content.textContent = line.text;
                row.append(check, oldNumber, newNumber, content); return row;
            };
            view.append(patch);
            if (rows.length >= DIFF_VIRTUAL_THRESHOLD) this.diffViewport = new DiffViewport(view, patch, rows, createRow, 140);
            else rows.forEach((_, index) => patch.append(createRow(index)));
        } else if (!this.sides && diff.before.text !== undefined && diff.after.text !== undefined) {
            const pre = document.createElement('pre'); pre.className = 'patch';
            const patchText = diff.patchNotice || diff.patch || t('panel.diff.noContentChange');
            const lines = patchText.slice(0, 200000).split('\n', 15001);
            const rows: DiffViewportRow[] = lines.slice(0, 15000).map(text => ({ text, code: text, height: 20 }));
            if (lines.length > 15000 || patchText.length > 200000) rows.push({ text: t('panel.diff.patchTruncated'), height: 20 });
            const createRow = (index: number): HTMLElement => {
                const line = rows[index]!.text, span = document.createElement('span'); span.textContent = line;
                span.className = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'delete' : line.startsWith('@@') ? 'hunk' : ''; return span;
            };
            view.append(pre);
            if (rows.length >= DIFF_VIRTUAL_THRESHOLD) this.diffViewport = new DiffViewport(view, pre, rows, createRow, 24);
            else rows.forEach((_, index) => pre.append(createRow(index)));
        } else {
            const sides = document.createElement('div'); sides.className = 'sides';
            const virtualSides: { pre: HTMLElement; rows: DiffViewportRow[]; create: (index: number) => HTMLElement }[] = [];
            const changed = this.changedSideLines(diff);
            const addSide = (title: string, content: FileContent) => {
                const side = document.createElement('div'); side.className = 'side'; const heading = document.createElement('h4'); heading.textContent = title; side.append(heading);
                if (content.image) { const img = document.createElement('img'); img.src = content.image; img.alt = title; side.append(img); }
                else if (content.notice) { const notice = document.createElement('p'); notice.textContent = content.notice; side.append(notice); }
                else { const pre = document.createElement('pre'), text = content.text || '', lines = text.slice(0, 200000).split('\n', 15001); if (text) {
                    const visible = lines.slice(0, 15000), changedLines = content === diff.before ? changed.before : changed.after;
                    if (visible.length >= DIFF_VIRTUAL_THRESHOLD) {
                        pre.className = 'virtual-side';
                        const rows = visible.map(text => ({ text, code: text, height: 20 }));
                        virtualSides.push({ pre, rows, create: index => {
                            const row = document.createElement('span'); row.textContent = rows[index]!.text;
                            if (changedLines.has(index + 1)) row.className = 'side-change ' + (content === diff.before ? 'delete' : 'add');
                            return row;
                        } });
                    } else {
                    let plain = '';
                    const flush = () => { if (plain) { pre.append(document.createTextNode(plain)); plain = ''; } };
                    for (let index = 0; index < visible.length; index++) {
                        const value = visible[index]! + (index < visible.length - 1 ? '\n' : '');
                        if (!changedLines.has(index + 1)) { plain += value; continue; }
                        flush(); const span = document.createElement('span'); span.className = 'side-change ' + (content === diff.before ? 'delete' : 'add'); span.textContent = value; pre.append(span);
                    }
                    flush();
                    }
                } else pre.textContent = content.exists === true ? t('panel.diff.emptyFile') : t('panel.diff.emptyOrMissing'); side.append(pre); if (text.length > 200000 || lines.length > 15000) { const note = document.createElement('p'); note.textContent = t('panel.diff.sideTruncated'); side.append(note); } }
                sides.append(side);
            };
            const hideBefore = emptyDiffSide(diff.before), hideAfter = emptyDiffSide(diff.after);
            sides.classList.toggle('single-side', hideBefore || hideAfter);
            const historySide = diff.indexComparison?.left || diff.worktreeComparison?.left || diff.comparison?.left;
            if (!hideBefore) addSide(historySide ? t('panel.diff.sideLeftHistory', { revision: historySide.revision.slice(0, 12), path: historySide.path }) : this.currentFile?.area === 'compare' ? t('panel.diff.sideBase', { revision: this.currentFile.baseRevision?.slice(0, 12) }) : t('panel.diff.sideBefore'), diff.before);
            if (!hideBefore && !hideAfter && this.layout) sides.append(this.layout.divider('sides'));
            if (!hideAfter) addSide(diff.indexComparison ? t('panel.diff.sideRightIndex', { path: diff.indexComparison.right.path }) + (diff.indexComparison.right.kind === 'missing' ? t('panel.diff.indexPathMissing') : '') : diff.worktreeComparison ? t('panel.diff.sideRightDisk', { path: diff.worktreeComparison.right.path }) + (diff.worktreeComparison.right.kind === 'missing' ? t('panel.diff.pathMissing') : '') : diff.comparison ? t('panel.diff.sideRight', { revision: diff.comparison.right.revision.slice(0, 12), path: diff.comparison.right.path }) : this.currentFile?.area === 'compare' ? t('panel.diff.sideTarget', { revision: this.currentFile.revision?.slice(0, 12) }) : t('panel.diff.sideAfter'), diff.after); if (hideBefore && hideAfter) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = t('panel.diff.bothSidesEmpty'); sides.append(empty); } view.append(sides);
            for (const side of virtualSides) this.sideViewports.push(new DiffViewport(view, side.pre, side.rows, side.create, 20, true));
            view.scrollTop = sideTop;
            [...sides.querySelectorAll<HTMLElement>('.side')].forEach((side, index) => { side.scrollLeft = sideLeft[index] || 0; });
        }
        this.updateButtons();
    }

    private renderConflict(conflict: ConflictView): void {
        const view = this.el('diff-view');
        const intro = document.createElement('div'); intro.className = 'conflict-context';
        const summary = document.createElement('strong'); summary.textContent = `${conflict.status} · ${conflict.operation || t('panel.conflict.unmergedIndex')}`;
        const meaning = document.createElement('p');
        meaning.textContent = t('panel.conflict.meaning');
        const workflow = document.createElement('p');
        workflow.textContent = t('panel.conflict.workflow');
        intro.append(summary, meaning, workflow); view.append(intro);
        const panes = document.createElement('div'); panes.className = 'conflict-panes';
        const addPane = (title: string, content: FileContent | undefined, metadata: string, exists: boolean) => {
            const pane = document.createElement('section'); pane.className = 'conflict-pane';
            const heading = document.createElement('h4'); heading.textContent = title;
            const identity = document.createElement('small'); identity.textContent = metadata;
            const body = document.createElement('div'); body.className = 'conflict-content';
            const note = (text: string) => { const paragraph = document.createElement('p'); paragraph.textContent = text; body.append(paragraph); };
            if (!exists) note(t('panel.conflict.fileMissing'));
            else if (content?.image) { const image = document.createElement('img'); image.src = content.image; image.alt = title + ' · ' + conflict.path; body.append(image); }
            else if (content?.notice) note(content.notice);
            else if (content?.text !== undefined) {
                if (!content.text.length) note(t('panel.conflict.fileEmpty'));
                else {
                    const clipped = content.text.slice(0, 200000), lines = clipped.split('\n');
                    const pre = document.createElement('pre'); pre.textContent = lines.slice(0, 4000).join('\n'); body.append(pre);
                    if (content.text.length > clipped.length || lines.length > 4000) note(t('panel.conflict.truncated'));
                }
            } else note(t('panel.conflict.noPreview'));
            pane.append(heading, identity, body); panes.append(pane);
        };
        for (const [stage, title] of [[1, t('panel.conflict.stageBase')], [2, t('panel.conflict.stageOurs')], [3, t('panel.conflict.stageTheirs')]] as const) {
            const entry = conflict.stages.find(item => item.stage === stage);
            addPane(title, entry?.content, entry ? t('panel.conflict.stageInfo', { mode: entry.mode, object: entry.object }) : t('panel.conflict.noStage'), !!entry);
        }
        addPane(t('panel.conflict.workingTitle'), conflict.working, conflict.workingExists ? t('panel.conflict.workingRead') : t('panel.conflict.workingMissing'), conflict.workingExists);
        view.append(panes);
    }

    private async prepare(action: Action, pointerPath?: string): Promise<void> {
        if (!this.details || this.busy || this.planning) return;
        const amendAction = action === 'amendCommit', amendTarget = this.amendTarget;
        if (amendAction && (this.amendLoading || this.amendBlocked || !amendTarget || amendTarget.repo !== this.repoId || this.el('amend-modal').hidden)) return;
        const fileAction = action === 'stage' || action === 'unstage';
        if (pointerPath !== undefined && (!fileAction || !this.worklist().rendered.some(row => row.file.path === pointerPath && row.file.submodule
            && row.area === (action === 'unstage' ? 'index' : 'worktree')))) return;
        const selectedStash = action === 'stashSelected', inputStash = this.inputStash;
        if (selectedStash && (this.mode !== 'working' || !inputStash || inputStash.selection !== this.selectionEpoch || this.el('modal').hidden)) return;
        if (fileAction && this.workingSelectionLocked()) return;
        const lineAction = action === 'stageLines' || action === 'unstageLines';
        if (lineAction && (!this.currentFile || this.currentFile.area === 'conflict' || !this.currentDiff?.partial || !this.selectedLines.size)) return;
        if (action === 'lfsFetch' && this.currentFile?.area === 'conflict') return;
        const resolutionAction = action === 'resolveConflict';
        const conflict = this.currentDiff?.conflict;
        if (resolutionAction && (this.mode !== 'working' || this.currentFile?.area !== 'conflict' || this.diffLoading || !conflict?.resolution || conflict.blockedReason || conflict.path !== this.currentFile.path)) return;
        const upstreamAction = action === 'setUpstream' || action === 'unsetUpstream';
        const branchAction = action === 'renameBranch' || action === 'deleteBranch' || upstreamAction;
        const targetBranch = action === 'renameBranch' || action === 'setUpstream' ? this.inputBranch : action === 'deleteBranch' || action === 'unsetUpstream' ? this.branchTarget() : undefined;
        if (branchAction && (!targetBranch || this.mode !== 'branches')) return;
        const upstream = action === 'setUpstream' ? this.inputUpstream : undefined;
        if (action === 'setUpstream' && !upstream) return;
        if (upstreamAction) {
            const local = this.details.branches.find(branch => branch.name === targetBranch?.name && branch.sha === targetBranch.sha);
            if (!local || (!local.current && local.worktree)) return;
        }
        const area = action === 'unstage' ? 'index:' : 'worktree:';
        const paths = pointerPath !== undefined ? [pointerPath] : selectedStash ? [...inputStash!.paths] : fileAction ? selectedPaths(this.worklist().rendered, this.selected, action === 'unstage' ? 'index' : 'worktree') : amendAction ? [] : resolutionAction && conflict ? [conflict.path] : [...this.selected].filter(k => k.startsWith(area)).map(k => k.slice(area.length)).filter(name => !this.details?.repo.files.find(file => file.path === name)?.conflict);
        if (fileAction && !paths.length) return;
        const epoch = this.epoch, dialogEpoch = this.dialogEpoch, diffEpoch = this.diffEpoch, selectionEpoch = this.selectionEpoch;
        const source = this.details.remoteBranches.find(b => b.ref === this.el<HTMLSelectElement>('remote-branch').value);
        this.planning = true; this.updateButtons();
        try {
            const operation: OperationRequest = action === 'createBranchAt'
                ? branchAtRequest(this.details.repo, this.inputRevision || '', this.el<HTMLInputElement>('branch-name').value)
                : {
                repo: this.repoId, version: this.details.repo.version, action, paths,
                includePointers: fileAction ? pointerPath !== undefined : (action === 'commit' || amendAction) && this.el<HTMLInputElement>('pointers').checked,
                message: amendAction ? this.el<HTMLTextAreaElement>('amend-message').value : action === 'stashPush' || selectedStash ? this.el<HTMLInputElement>('stash-message').value : this.el<HTMLTextAreaElement>('message').value,
                branch: amendAction ? this.details.repo.branch : branchAction ? targetBranch?.name : action === 'createBranch' || action === 'checkoutRemote' ? this.el<HTMLInputElement>('branch-name').value.trim() : this.el<HTMLSelectElement>('branch').value,
                newBranch: action === 'renameBranch' ? this.el<HTMLInputElement>('branch-name').value.trim() : undefined,
                remote: this.el<HTMLSelectElement>('remote').value,
                remoteBranch: action === 'checkoutRemote' ? source?.ref : upstream?.ref,
                upstreamRevision: upstream?.sha,
                revision: amendAction ? amendTarget?.revision : branchAction ? targetBranch?.sha : action === 'createBranch' ? this.inputRevision : action === 'checkoutRemote' ? source?.sha : action === 'stashApply' || action === 'stashDrop' || (action === 'lfsFetch' && this.mode === 'history') ? this.revision || undefined : undefined,
                stashRef: this.stashRef,
                includeUntracked: this.el<HTMLInputElement>('include-untracked').checked,
                restoreIndex: this.el<HTMLInputElement>('restore-index').checked,
                lines: lineAction ? { path: this.currentFile!.path, version: this.currentDiff!.partial!.version, ids: [...this.selectedLines] } : undefined,
                resolution: resolutionAction && conflict?.resolution ? { path: conflict.path, version: conflict.version, mode: conflict.resolution } : undefined,
            };
            const plan = await this.requestPlan(operation);
            if (!plan) return;
            if (this.closed || epoch !== this.epoch || dialogEpoch !== this.dialogEpoch || ((fileAction || selectedStash) && selectionEpoch !== this.selectionEpoch) || ((lineAction || resolutionAction) && diffEpoch !== this.diffEpoch)) return;
            if (fileAction && pointerPath === undefined && canApplyIndexPlan(action, paths, plan)) {
                this.el('notice').hidden = true;
                await this.executePlan(plan);
                return;
            }
            this.plan = plan; this.inputAction = undefined;
            this.inputStash = undefined;
            this.el('amend-modal').hidden = true; this.el('plan-amend-edit').hidden = !amendAction;
            this.inputBranch = undefined; this.inputRevision = undefined; this.inputUpstream = undefined; this.el('notice').hidden = true;
            this.el('plan-title').textContent = plan.title; this.el('plan-description').textContent = plan.description;
            this.el('plan-files').textContent = plan.paths.join('\n'); this.el('plan-files').hidden = !plan.paths.length;
            this.el('plan-patch').textContent = plan.patch || ''; this.el('plan-patch').hidden = !plan.patch;
            this.renderPlanWarnings(plan, action);
            for (const id of ['branch-input-wrap', 'remote-branch-wrap', 'stash-input-wrap', 'upstream-input-wrap']) this.el(id).hidden = true;
            this.el('confirm').textContent = action === 'createBranchAt' ? t('panel.confirm.createBranchAt') : amendAction ? t('panel.confirm.amend') : resolutionAction ? conflict?.resolution === 'delete' ? t('panel.confirm.markDeleted') : t('panel.confirm.markResolved') : action === 'stashDrop' ? t('panel.confirm.stashDrop') : action === 'deleteBranch' ? t('panel.confirm.deleteBranch') : action === 'unsetUpstream' ? t('panel.confirm.unsetUpstream') : action === 'setUpstream' ? t('panel.confirm.setUpstream') : t('panel.html.confirm'); this.el('modal').hidden = false;
        } catch (e) {
            if (!this.closed && epoch === this.epoch && dialogEpoch === this.dialogEpoch && (!(fileAction || selectedStash) || selectionEpoch === this.selectionEpoch) && (!(lineAction || resolutionAction) || diffEpoch === this.diffEpoch)) {
                this.error(e);
                if (amendAction) this.el('amend-note').textContent = t('panel.amend.failedKept', { error: e instanceof Error ? e.message : String(e) });
                if (this.inputAction && !this.el('modal').hidden) {
                    const warning = document.createElement('p'); warning.textContent = e instanceof Error ? e.message : String(e);
                    this.el('plan-warnings').replaceChildren(warning);
                }
            }
        } finally { this.planning = false; this.updateButtons(); }
    }

    private closeProjectUpdate(): void {
        if (this.projectUpdateResult?.status === 'running') return;
        this.projectUpdateHidden = this.projectUpdateTask;
        this.el('project-update-progress').hidden = true; this.layout?.refresh();
        this.renderProjectUpdateButton(); renderActionIcons(this.app);
    }

    private toggleProjectUpdate(): void {
        if (this.el('project-update-progress').hidden) this.openProjectUpdate();
        else this.closeProjectUpdate();
    }

    private openProjectUpdate(): void {
        if (!this.projectUpdateResult?.repositories) return;
        this.projectUpdateHidden = '';
        const box = this.el('project-update-progress');
        box.hidden = false; box.classList.remove('collapsed');
        this.el('project-update-toggle').setAttribute('aria-expanded', 'true');
        this.renderProjectUpdateButton(); renderActionIcons(this.app);
        this.layout?.refresh();
        this.el('project-update-toggle').focus();
    }

    private async inspectUpdateFailure(row: RepositoryUpdate, action: HelpAction): Promise<void> {
        if (this.busy || this.planning) return;
        if (!this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden)) throw new Error(t('panel.updateHelp.closeDialogFirst'));
        if (this.projectUpdateResult) this.closeProjectUpdate();
        const snapshot = await request<Snapshot>('snapshot', true);
        if (snapshot.task?.status === 'running') throw new Error(t('panel.updateHelp.taskRunning'));
        const repo = snapshot.repositories.find(item => item.id === row.id && item.initialized && !item.error);
        if (!repo) throw new Error(t('panel.updateHelp.repoUnreadable'));
        if (this.closed || this.busy || this.planning || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden)) return;
        this.snapshot = snapshot;
        await this.selectRepo(repo.id, false);
        if (this.closed || this.repoId !== repo.id || this.busy || this.planning || !this.el('modal').hidden || !this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden) return;
        if (action === 'repreview') {
            if (!this.details || this.details.repo.id !== repo.id) return;
            await this.prepareWorktreeOperation({ repo: repo.id, version: this.details.repo.version, action: 'updateAll' }, undefined, true);
            return;
        }
        await this.setMode(action === 'remotes' ? 'working' : action);
        if (action === 'remotes' && !this.closed && this.repoId === repo.id && !this.busy && !this.planning && this.el('modal').hidden && this.el('amend-modal').hidden && this.el('scope-review-modal').hidden) {
            this.el('remote-workspace').hidden = false;
            this.el('reflog-workspace').hidden = true; this.clearReflog();
            await this.loadRemotes();
        }
    }

    private generalUpdateFailure?: HTMLElement;
    private renderGeneralUpdateFailure(task: Task, rows: RepositoryUpdate[]): void {
        if (task.status !== 'failed' || rows.some(row => row.status === 'failed')) { this.generalUpdateFailure?.remove(); this.generalUpdateFailure = undefined; return; }
        const key = task.id + task.log;
        if (this.generalUpdateFailure?.dataset.summary === key) return;
        this.generalUpdateFailure?.remove();
        const node = this.el('project-update-rows').ownerDocument.createElement('div'); node.className = 'project-update-row'; node.dataset.state = 'failed'; node.dataset.summary = key;
        node.textContent = t('panel.update.stoppedEarly');
        this.renderUpdateFailure(node, { id: '.', status: 'failed', phase: task.recovery === 'repreview' ? t('panel.update.abortedBeforeUpdate') : t('panel.update.projectError'), detail: task.log.slice(-8000) }, task);
        this.el('project-update-rows').prepend(node); this.generalUpdateFailure = node;
    }

    private renderUpdateFailure(node: HTMLElement, row: RepositoryUpdate, task: Task): void {
        const doc = node.ownerDocument, help = updateFailureHelp(row);
        const details = doc.createElement('details'), summary = doc.createElement('summary');
        details.className = 'update-help'; details.open = help.action === 'repreview'; summary.textContent = t('panel.updateHelp.summary', { title: help.title });
        const note = doc.createElement('p'); note.textContent = help.steps;
        const stale = doc.createElement('p'); stale.className = 'update-help-note'; stale.textContent = t('panel.updateHelp.stale');
        const tools = doc.createElement('div'); tools.className = 'update-help-actions';
        const actions: [HelpAction, 'changes' | 'incoming' | 'stash' | 'branch' | 'settings', string][] = [['working', 'changes', t('panel.updateHelp.viewChanges')]];
        if (help.action !== 'working' && help.action !== 'repreview') actions.push([help.action,
            help.action === 'sync' ? 'incoming' : help.action === 'stash' ? 'stash' : help.action === 'remotes' ? 'settings' : 'branch',
            help.action === 'sync' ? t('panel.updateHelp.viewSync') : help.action === 'stash' ? t('panel.updateHelp.viewStash') : help.action === 'remotes' ? t('panel.updateHelp.checkRemotes') : t('panel.updateHelp.checkBranch')]);
        for (const [action, icon, label] of actions) {
            const button = doc.createElement('button'); button.className = 'quiet'; button.textContent = label;
            button.dataset.updateHelp = 'true'; decorateAction(button, icon, label);
            button.addEventListener('click', () => { void this.guard(() => this.inspectUpdateFailure(row, action)); }); tools.append(button);
        }
        if (help.action === 'repreview' && (task.kind === 'updateAll' || (task.kind === undefined && task.title === t('panel.update.allTitle')))) {
            const repreview = doc.createElement('button'); repreview.textContent = t('panel.updateHelp.repreview'); repreview.dataset.updateHelp = 'true';
            repreview.addEventListener('click', () => { void this.guard(() => this.inspectUpdateFailure(row, 'repreview')); });
            tools.prepend(repreview);
        }
        const copy = doc.createElement('button'); copy.className = 'quiet'; copy.textContent = t('panel.updateHelp.copy'); decorateAction(copy, 'copy', t('panel.updateHelp.copy'));
        copy.addEventListener('click', () => { void this.guard(async () => {
            const text = [task.title, updateResultTime(task).label, t('panel.updateHelp.lastFailure'), t('panel.updateHelp.repo', { repo: row.id }), t('panel.updateHelp.branch', { branch: row.branch || t('panel.unknown') }), t('panel.updateHelp.phase', { phase: row.phase }), row.detail, t('panel.updateHelp.logTail'), task.log.slice(-8000)].join('\n');
            await navigator.clipboard.writeText(text);
            decorateAction(copy, 'check', t('panel.updateHelp.copied')); setTooltipTitle(copy, t('panel.updateHelp.copied'));
            setTimeout(() => { if (copy.isConnected && !this.closed) { setTooltipTitle(copy, t('panel.updateHelp.copy')); decorateAction(copy, 'copy', t('panel.updateHelp.copy')); } }, 2000);
        }); });
        tools.append(copy); details.append(summary, note, tools, stale); node.append(details);
    }

    private renderProjectUpdateButton(): void {
        const button = this.el<HTMLButtonElement>('project-update-open'), result = this.projectUpdateResult;
        const rows = result?.repositories;
        const visible = !this.el('project-update-progress').hidden;
        button.disabled = !rows; button.setAttribute('aria-expanded', String(visible));
        button.dataset.state = result?.status || 'none';
        if (!result || !rows) { setTooltipTitle(button, t('panel.update.noResult')); return; }
        const label = result.status === 'running' ? t('panel.update.running') : result.status === 'success' ? t('panel.update.succeeded') : t('panel.update.failed');
        const counts = updateResultCounts(rows)
            + (result.recovery === 'repreview' ? t('panel.update.needsRepreview') : result.status === 'failed' && !rows.some(row => row.status === 'failed') ? t('panel.update.projectFailed') : '');
        setTooltipTitle(button, [label, updateResultTime(result).label, counts,
            result.status === 'running' ? t('panel.update.runningHint') : visible ? t('panel.update.clickClose') : t('panel.update.clickOpen')].filter(Boolean).join('\n'));
    }

    private renderTask(task: Task | null): void {
        const box = this.el('project-update-progress');
        if (task?.repositories) this.projectUpdateResult = task;
        if (this.projectUpdateResult) this.projectUpdateResult = updateResultForDisplay(this.projectUpdateResult);
        const update = this.projectUpdateResult;
        const rows = update?.repositories;
        const updating = !!rows && update?.status === 'running';
        if (updating) { this.projectUpdateHidden = ''; this.projectUpdateCompleted = ''; }
        if (update && rows && !updating && this.projectUpdateCompleted !== update.id) {
            this.projectUpdateCompleted = update.id;
            if (update.status === 'success' && rows.length && rows.every(row => row.status === 'success' || row.status === 'skipped')) {
                this.projectUpdateHidden = update.id;
            } else if (update.status === 'failed' || rows.some(row => row.status === 'failed')) {
                this.projectUpdateHidden = '';
                box.classList.remove('collapsed');
                this.el('project-update-toggle').setAttribute('aria-expanded', 'true');
            }
        }
        const close = this.el<HTMLButtonElement>('project-update-close');
        close.hidden = updating; close.disabled = updating;
        box.hidden = !rows || this.projectUpdateHidden === update?.id || !this.el('scope-review-modal').hidden || this.scopeReviewOpening;
        this.renderProjectUpdateButton();
        const time = update ? updateResultTime(update) : { timestamp: '', label: '' };
        const timestamp = this.el<HTMLTimeElement>('project-update-time');
        timestamp.dateTime = time.timestamp; timestamp.textContent = time.label; timestamp.hidden = !time.label;
        if (rows && update) {
            if (this.projectUpdateTask !== update.id) {
                this.generalUpdateFailure = undefined;
                this.projectUpdateTask = update.id; this.projectUpdateRows.clear(); this.el('project-update-rows').replaceChildren(); box.classList.remove('collapsed'); this.el('project-update-toggle').setAttribute('aria-expanded', 'true');
            }
            const labels = { queued: t('panel.update.rowQueued'), running: t('panel.update.running'), success: t('panel.update.rowSuccess'), failed: t('panel.update.rowFailed'), skipped: t('panel.update.rowSkipped') };
            for (const row of rows) {
                let node = this.projectUpdateRows.get(row.id);
                if (!node) { node = document.createElement('div'); node.className = 'project-update-row'; node.setAttribute('role', 'listitem'); this.projectUpdateRows.set(row.id, node); this.el('project-update-rows').append(node); }
                const text = (row.status === 'skipped' && (row.phaseId === 'notRun' || (row.phaseId === undefined && row.phase === t('panel.update.phaseNotRun'))) ? t('panel.update.phaseNotRun') : labels[row.status]) + ' · ' + row.id + (row.branch ? ' · ' + row.branch : '') + '\n' + row.phase + (row.head ? ' · ' + row.head.slice(0, 12) : '') + (row.detail ? '\n' + row.detail : '');
                if (node.dataset.summary !== text) {
                    const expanded = node.querySelector('details')?.open || false;
                    node.textContent = text; node.dataset.summary = text;
                    if (row.status === 'failed') {
                        this.renderUpdateFailure(node, row, update);
                        const help = node.querySelector('details'); if (help) help.open = expanded || updateFailureHelp(row).action === 'repreview';
                    }
                }
                node.dataset.state = row.status;
            }
            const done = rows.filter(row => row.status !== 'queued' && row.status !== 'running').length;
            this.renderGeneralUpdateFailure(update, rows);
            const title = update.title + (update.recovery === 'repreview' ? t('panel.update.titleAborted') : update.status === 'success' ? t('panel.update.titleDone') : update.status === 'failed' ? t('panel.update.titlePartial') : ' · ' + done + ' / ' + rows.length);
            const text = title + ' · ' + updateResultCounts(rows)
                + (update.status === 'failed' && !update.recovery && !rows.some(row => row.status === 'failed') ? t('panel.update.projectFailedHint') : '');
            const heading = this.el('project-update-summary');
            if (heading.textContent !== text) heading.textContent = text;
            box.classList.toggle('has-failures', update.status === 'failed');
        } else if (this.projectUpdateRows.size) {
            this.projectUpdateRows.clear(); this.el('project-update-rows').replaceChildren(); this.projectUpdateTask = '';
        }
        const wasRunning = this.busy;
        this.busy = task?.status === 'running';
        if (task) {
            this.el('status').textContent = `${task.status === 'running' ? t('panel.status.running') : task.status === 'success' ? t('panel.status.done') : t('panel.status.unfinished')} · ${task.title}`;
            const log = this.el('log');
            if (log.textContent !== task.log) { log.textContent = task.log; log.scrollTop = log.scrollHeight; }
            if (this.taskId !== task.id) { this.taskId = task.id; log.hidden = task.status !== 'failed'; }
            if (task.status === 'failed' && wasRunning) log.hidden = false;
            if (task.repositories) log.hidden = true;
            this.el('log-dialog').hidden = log.hidden || !log.textContent;
        } else this.el('status').textContent = t('panel.status.idle', { count: this.snapshot?.repositories.length || 0 });
        this.updateButtons();
    }

    private updateButtons(): void {
        const previousElements = this.controlElements, previousDisabled = this.pendingDisabled;
        this.controlElements = previousElements || new Map();
        this.pendingDisabled = new Map();
        try {
            setControlAttribute(this.el('refresh'), 'aria-busy', String(!!this.remoteFetchPending && this.busy));
            this.setDisabled(this.el<HTMLButtonElement>('refresh'), this.closed || this.busy || this.planning || !this.details || !this.el('modal').hidden || !this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden);
            const auto = this.el<HTMLButtonElement>('auto-fetch-toggle');
            setControlAttribute(auto, 'aria-pressed', String(this.remoteFetch.enabled));
            const checked = this.remoteCheckTimes.get(this.repoId);
            setActionHint(auto, (this.remoteFetch.blocked.has(this.repoId) ? t('panel.autoFetch.paused') : this.remoteFetch.enabled ? t('panel.autoFetch.enabled') : t('panel.autoFetch.disabled')) + (checked ? t('panel.autoFetch.lastCheck', { time: new Date(checked).toLocaleTimeString() }) : ''));

            this.setDisabled(this.el<HTMLButtonElement>('scope-reviews-open'), this.busy || this.planning);
            for (const button of this.app.querySelectorAll<HTMLButtonElement>('[data-update-help]')) this.setDisabled(button, this.busy || this.planning);
            this.renderCoreLayout();
            this.setDisabled(this.el<HTMLSelectElement>('repo-select'), this.busy || this.planning || !this.snapshot || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden));
            this.renderFileComparisonControls();
            this.setDisabled(this.el<HTMLButtonElement>('manage-remotes'), this.busy || this.planning || !this.details || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden));
            for (const button of this.app.querySelectorAll<HTMLButtonElement>('[data-write]')) this.setDisabled(button, this.busy || this.planning || !this.details);
            this.setDisabled(this.el<HTMLSelectElement>('branch'), this.busy || this.planning || !this.details || this.repoLoading || !this.el('modal').hidden || !this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden);
            this.renderReflogControls();
            this.renderRemoteControls();
            this.renderBranchEntryControls();
            this.renderMergeControls();
            this.renderTagControls();
            setControlValue(this.el('tree-tools'), 'hidden', !this.treeActive || this.mode !== 'history');
            setActionLabel(this.el('history-tree'), this.treeActive ? t('panel.tree.backToChanges') : t('panel.tree.browseAll'));
            this.setDisabled(this.el<HTMLButtonElement>('history-tree'), this.mode !== 'history' || !this.revision || this.busy || this.planning || this.historyLoading);
            const treeLocked = this.busy || this.planning || this.treeLoading || !this.details || !this.el('modal').hidden;
            for (const id of ['tree-root', 'tree-parent', 'tree-retry']) this.setDisabled(this.el<HTMLButtonElement>(id), treeLocked || !this.treeActive);
            this.setDisabled(this.el<HTMLButtonElement>('tree-parent'), this.getDisabled(this.el<HTMLButtonElement>('tree-parent')) || !this.treeDirectory);
            this.setDisabled(this.el<HTMLButtonElement>('tree-prev'), treeLocked || !this.treePage || this.treePage.offset === 0);
            this.setDisabled(this.el<HTMLButtonElement>('tree-next'), treeLocked || this.treePage?.nextOffset === undefined);
            this.setDisabled(this.el<HTMLInputElement>('tree-filter'), this.busy || this.planning || !this.details || !this.el('modal').hidden);
            setControlValue(this.el('file-filter-tools'), 'hidden', this.mode === 'branches' || this.mode === 'tags' || this.mode === 'history');
            if (this.mode === 'history') setControlValue(this.el('filter'), 'hidden', this.treeActive);
            const conflictPage = this.currentFile?.area === 'conflict';
            const conflict = conflictPage ? this.currentDiff?.conflict : undefined;
            setControlValue(this.el('conflict-tools'), 'hidden', !conflictPage);
            this.setDisabled(this.el<HTMLButtonElement>('conflict-reload'), this.busy || this.planning || this.diffLoading || !this.details);
            setControlValue(this.el('conflict-hint'), 'textContent', conflict?.blockedReason || (this.diffLoading ? t('panel.conflict.loading') : conflict?.resolution === 'delete' ? t('panel.conflict.hintDeleted') : conflict?.resolution === 'content' ? t('panel.conflict.hintContent') : t('panel.conflict.hintReload')));
            setControlValue(this.el('conflict-resolve'), 'hidden', !conflictPage || !conflict?.resolution || !!conflict.blockedReason);
            this.setDisabled(this.el<HTMLButtonElement>('conflict-resolve'), this.getDisabled(this.el<HTMLButtonElement>('conflict-resolve')) || this.diffLoading || !conflict?.resolution || !!conflict.blockedReason);
            setActionLabel(this.el('conflict-resolve'), conflict?.resolution === 'delete' ? t('panel.conflict.previewDeleted') : t('panel.html.conflict-resolve'));
            const hasDiffViews = !!this.currentFile && !!this.currentDiff && !conflictPage && this.currentFile.area !== 'tree';
            for (const id of ['patch-tab', 'sides-tab']) { setControlValue(this.el(id), 'hidden', !hasDiffViews); this.setDisabled(this.el<HTMLButtonElement>(id), conflictPage); }
            this.setDisabled(this.el<HTMLButtonElement>('confirm'), this.busy || this.planning || (this.inputAction === 'setUpstream' && !this.inputUpstream) || (this.projectToolConfirmation && this.el<HTMLInputElement>('project-tool-confirm').value !== 'RESET ALL'));
            for (const id of ['history-base', 'history-target']) this.setDisabled(this.el<HTMLButtonElement>(id), this.mode !== 'history' || !this.revision || this.historyLoading);
            this.setDisabled(this.el<HTMLButtonElement>('history-new-branch'), this.getDisabled(this.el<HTMLButtonElement>('history-new-branch')) || this.mode !== 'history' || this.historyLoading || !this.commits.some(commit => commit.sha === this.revision));
            const target = this.branchTarget();
            for (const id of ['rename-branch', 'delete-branch']) this.setDisabled(this.el<HTMLButtonElement>(id), this.getDisabled(this.el<HTMLButtonElement>(id)) || this.mode !== 'branches' || !target || target.current || !!target.worktree);
            const upstreamBlocked = this.mode !== 'branches' || !target || (!target.current && !!target.worktree);
            this.setDisabled(this.el<HTMLButtonElement>('set-upstream'), this.getDisabled(this.el<HTMLButtonElement>('set-upstream')) || upstreamBlocked);
            this.setDisabled(this.el<HTMLButtonElement>('unset-upstream'), this.getDisabled(this.el<HTMLButtonElement>('unset-upstream')) || upstreamBlocked || (target?.tracking ? target.tracking.state === 'none' : !target?.upstream));
            this.setDisabled(this.el<HTMLInputElement>('upstream-filter'), this.busy || this.planning);
            for (const button of this.app.querySelectorAll<HTMLButtonElement>('[data-upstream-choice]')) this.setDisabled(button, this.busy || this.planning);
            this.setDisabled(this.el<HTMLButtonElement>('history-search-apply'), !this.details);
            this.setDisabled(this.el<HTMLButtonElement>('history-search-clear'), !this.details);
            this.setDisabled(this.el<HTMLButtonElement>('file-history'), !this.fileMenuTarget || this.fileMenuTarget.repo !== this.repoId || !this.details || this.busy || this.planning);
            this.setDisabled(this.el<HTMLButtonElement>('blame-run'), !this.currentFile || this.currentFile.area === 'stash' || conflictPage || !this.details || this.blameLoading || !this.el<HTMLSelectElement>('blame-version').value);
            setControlValue(this.el('blame-controls'), 'hidden', !this.canShowBlame());
            setControlValue(this.el('blame-status'), 'hidden', !this.blameActive);
            this.setDisabled(this.el<HTMLButtonElement>('compare-run'), !this.details || this.compareLoading);
            this.setDisabled(this.el<HTMLButtonElement>('compare-swap'), this.compareLoading);
            setActionLabel(this.el('compare-run'), this.compareLoading ? t('panel.loadingShort') : t('panel.html.compare-run'));
            const worklist = this.worklist(), selectionLocked = this.workingSelectionLocked();
            this.renderFilePagination(this.mode === 'working' ? worklist.visible.length : this.fileTotal);
            const stageCount = selectedPaths(worklist.rendered, this.selected, 'worktree').length;
            const unstageCount = selectedPaths(worklist.rendered, this.selected, 'index').length;
            const stashCount = selectedWholeFiles(worklist.rendered, this.selected).length;
            const menuRow = this.fileMenuTarget?.workingKey ? worklist.rendered.find(row => row.key === this.fileMenuTarget!.workingKey) : undefined;
            const pointerRow = menuRow?.file.submodule ? menuRow : undefined;
            const ordinary = !!menuRow && !pointerRow && menuRow.area !== 'conflict';
            setControlValue(this.el('stage'), 'hidden', pointerRow ? pointerRow.area !== 'worktree' : !ordinary || !stageCount);
            setControlValue(this.el('unstage'), 'hidden', pointerRow ? pointerRow.area !== 'index' : !ordinary || !unstageCount);
            setControlValue(this.el('stash-selected'), 'hidden', !ordinary || !stashCount);
            setControlValue(this.el('discard-files'), 'hidden', !ordinary || !stageCount);
            setActionLabel(this.el('stash-selected'), t('panel.actions.stashSelected', { count: stashCount }));
            this.setDisabled(this.el<HTMLButtonElement>('stash-selected'), this.getDisabled(this.el<HTMLButtonElement>('stash-selected')) || selectionLocked || !stashCount);
            this.setDisabled(this.el<HTMLButtonElement>('discard-files'), selectionLocked || !stageCount || this.mode!=='working');
            setActionLabel(this.el('discard-files'), t('panel.actions.discardFiles', { count: stageCount }));
            setActionLabel(this.el('stage'), t('panel.actions.stage', { count: stageCount })); setActionLabel(this.el('unstage'), t('panel.actions.unstage', { count: unstageCount }));
            this.setDisabled(this.el<HTMLButtonElement>('stage'), this.getDisabled(this.el<HTMLButtonElement>('stage')) || selectionLocked || !stageCount);
            this.setDisabled(this.el<HTMLButtonElement>('unstage'), this.getDisabled(this.el<HTMLButtonElement>('unstage')) || selectionLocked || !unstageCount);
            if (pointerRow && pointerRow.area !== 'conflict') {
                const action = pointerRow.area === 'index' ? 'unstage' : 'stage';
                setActionLabel(this.el(action), action === 'stage' ? t('panel.actions.stagePointer') : t('panel.actions.unstagePointer'));
                this.setDisabled(this.el<HTMLButtonElement>(action), selectionLocked);
            }
            this.setDisabled(this.el<HTMLInputElement>('filter'), this.mode === 'working' && (this.busy || this.planning || !this.details || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden)));
            this.setDisabled(this.el<HTMLInputElement>('pointers'), selectionLocked);
            const stagedPointers = this.details?.repo.files.some(file => file.submodule && !file.conflict && file.index !== ' ' && file.index !== '?');
            setControlValue(this.el('commit-pointers'), 'hidden', !stagedPointers);
            if (!stagedPointers) setControlValue(this.el<HTMLInputElement>('pointers'), 'checked', false);
            for (const id of ['working-area', 'working-status', 'working-kind']) this.setDisabled(this.el<HTMLSelectElement>(id), selectionLocked);
            setControlValue(this.el('working-filter-clear'), 'hidden', !this.workingFilter.text && this.workingFilter.area === 'all' && this.workingFilter.status === 'all' && this.workingFilter.kind === 'all');
            this.setDisabled(this.el<HTMLButtonElement>('working-filter-clear'), selectionLocked || (!this.workingFilter.text && this.workingFilter.area === 'all' && this.workingFilter.status === 'all' && this.workingFilter.kind === 'all'));
            this.setDisabled(this.el<HTMLButtonElement>('working-selection-clear'), selectionLocked || !this.selected.size);
            setControlValue(this.el('working-selection-clear'), 'hidden', !this.selected.size);
            const visibleRows = new Map(worklist.rendered.map(row => [row.key, row]));
            for (const checkbox of this.app.querySelectorAll<HTMLInputElement>('input[data-working-key]')) {
                const row = visibleRows.get(checkbox.dataset.workingKey || '');
                setControlValue(checkbox, 'checked', !!row?.selectable && this.selected.has(row.key));
                this.setDisabled(checkbox, selectionLocked || !row?.selectable);
            }
            for (const checkbox of this.app.querySelectorAll<HTMLInputElement>('input[data-working-group]')) {
                const visible = worklist.rendered.filter(row => row.area === checkbox.dataset.workingGroup && row.selectable);
                const chosen = visible.filter(row => this.selected.has(row.key)).length;
                setControlValue(checkbox, 'checked', !!visible.length && chosen === visible.length); setControlValue(checkbox, 'indeterminate', chosen > 0 && chosen < visible.length);
                this.setDisabled(checkbox, selectionLocked || !visible.length);
            }
            let stagedCount = 0, conflicts = 0;
            for (const file of this.details?.repo.files || []) {
                if (file.index !== ' ' && file.index !== '?') stagedCount++;
                if (file.conflict) conflicts++;
            }
            const commitScope = (!this.details ? t('panel.commit.loadingIndex') : conflicts ? t('panel.commit.conflicts', { count: conflicts }) : stagedCount ? t('panel.commit.scope', { count: stagedCount }) : t('panel.commit.nothingStaged')) + (!conflicts && stagedPointers ? t('panel.commit.withPointers') : '');
            setControlValue(this.el('commit-scope'), 'textContent', commitScope);
            this.el('commit-scope').classList.toggle('has-conflict', !!conflicts);
            setControlValue(this.el('commit-scope'), 'title', this.el('commit-scope').textContent || '');
            this.el('commit-draft-tools').classList.toggle('scope-attention', !!conflicts || !!stagedPointers);
            setActionLabel(this.el('commit'), stagedCount ? t('panel.commit.buttonCount', { count: stagedCount }) : t('panel.html.commit'));
            setActionLabel(this.el('compact-commit-toggle'), !this.el('merge-tools').hidden ? t('panel.commit.handleMerge') : stagedCount ? t('panel.commit.compactCount', { count: stagedCount }) : t('panel.html.compact-commit-toggle'));
            setActionHint(this.el('compact-commit-toggle'), this.el('commit-scope').textContent || t('panel.commit.expandHint'));
            this.setDisabled(this.el<HTMLButtonElement>('commit'), this.getDisabled(this.el<HTMLButtonElement>('commit')) || !!conflicts || !stagedCount);
            this.setDisabled(this.el<HTMLButtonElement>('amend'), this.getDisabled(this.el<HTMLButtonElement>('amend')) || !this.details?.repo.head || !this.details.repo.branch || !!this.details.repo.operation || !!this.details.repo.files.some(file => file.conflict));
            const amendMessage = this.el<HTMLTextAreaElement>('amend-message').value;
            setControlValue(this.el('amend-validation'), 'textContent', amendMessage.includes('\0') ? t('panel.amend.nul') : amendMessage.length > 5000 ? t('panel.amend.tooLong') : t('panel.amend.length', { length: amendMessage.length }));
            this.setDisabled(this.el<HTMLButtonElement>('amend-preview'), this.busy || this.planning || this.amendLoading || !!this.amendBlocked || !this.amendTarget || !amendMessage.trim() || amendMessage.length > 5000 || amendMessage.includes('\0'));
            this.setDisabled(this.el<HTMLTextAreaElement>('amend-message'), this.amendLoading || this.planning || this.busy || !this.amendTarget);
            this.setDisabled(this.el<HTMLButtonElement>('plan-amend-edit'), this.busy || this.planning || !this.amendTarget);
            this.setDisabled(this.el<HTMLButtonElement>('checkout-remote'), this.getDisabled(this.el<HTMLButtonElement>('checkout-remote')) || !this.details?.remoteBranches.length);
            const lfsButton = this.el<HTMLButtonElement>('lfs');
            this.setDisabled(lfsButton, this.getDisabled(lfsButton) || this.mode === 'compare' || this.mode === 'sync' || conflictPage || this.isFileComparison());
            setActionHint(lfsButton, conflictPage ? t('panel.lfs.conflictHint') : this.mode === 'compare' || this.mode === 'sync' ? t('panel.lfs.previewHint') : '');
            this.setDisabled(this.el<HTMLButtonElement>('stash-save'), this.getDisabled(this.el<HTMLButtonElement>('stash-save')) || !this.details?.repo.head || !this.details.repo.files.length);
            for (const id of ['stash-apply', 'stash-drop']) this.setDisabled(this.el<HTMLButtonElement>(id), this.getDisabled(this.el<HTMLButtonElement>(id)) || !this.stashes.some(s => s.ref === this.stashRef && s.sha === this.revision));
            const stashFile = this.currentFile;
            const sourceFile = this.stashFileSelection;
            this.setDisabled(this.el<HTMLButtonElement>('stash-restore-file'), this.getDisabled(this.el<HTMLButtonElement>('stash-restore-file')) || this.mode!=='stash' || stashFile?.area!=='stash' || this.diffLoading || !this.currentDiff || stashFile.revision!==this.revision || !this.stashes.some(s=>s.ref===this.stashRef && s.sha===stashFile.revision) || !sourceFile || sourceFile.path!==stashFile.path || sourceFile.stashPart!==stashFile.stashPart || sourceFile.submodule || sourceFile.index==='D');
            const partial = this.mode === 'working' && !this.blameActive && !conflictPage ? this.currentDiff?.partial : undefined;
            setControlValue(this.el('line-tools'), 'hidden', this.isFileComparison() || this.sides || !partial);
            setControlValue(this.el('line-hint'), 'textContent', this.selectedLines.size ? t('panel.lines.selected', { count: this.selectedLines.size }) : t('panel.lines.hint'));
            setControlValue(this.el('line-hint'), 'title', t('panel.lines.tooltip'));
            if (this.el('line-tools').dataset.hasSelection !== String(!!this.selectedLines.size)) this.el('line-tools').dataset.hasSelection = String(!!this.selectedLines.size);
            setActionLabel(this.el('line-action'), this.currentFile?.area === 'index' ? t('panel.lines.unstage') : t('panel.lines.stage'));
            this.setDisabled(this.el<HTMLButtonElement>('line-action'), this.getDisabled(this.el<HTMLButtonElement>('line-action')) || !partial || !this.selectedLines.size);
            setControlValue(this.el('line-discard'), 'hidden', this.currentFile?.area!=='worktree' || this.mode!=='working' || this.blameActive);
            this.setDisabled(this.el<HTMLButtonElement>('line-discard'), this.getDisabled(this.el<HTMLButtonElement>('line-discard')) || !partial || !this.selectedLines.size || this.currentFile?.area!=='worktree' || this.diffLoading || !this.el('modal').hidden || (!this.el('amend-modal').hidden || !this.el('scope-review-modal').hidden));
            setControlValue(this.el('lines-clear'), 'hidden', !this.selectedLines.size);
            for (const id of ['lines-all', 'lines-clear']) this.setDisabled(this.el<HTMLButtonElement>(id), !partial || this.busy || this.planning);
            for (const checkbox of this.app.querySelectorAll<HTMLInputElement>('input[data-line]')) {
                setControlValue(checkbox, 'checked', this.selectedLines.has(checkbox.dataset.line!)); this.setDisabled(checkbox, this.busy || this.planning);
                checkbox.closest('.line-row')?.classList.toggle('selected', checkbox.checked);
            }
            for (const checkbox of this.app.querySelectorAll<HTMLInputElement>('input[data-hunk]')) {
                const ids = partial?.hunks[Number(checkbox.dataset.hunk)]?.lines.flatMap(line => line.id ? [line.id] : []) || [];
                const selected = ids.filter(id => this.selectedLines.has(id)).length;
                setControlValue(checkbox, 'checked', ids.length > 0 && selected === ids.length); setControlValue(checkbox, 'indeterminate', selected > 0 && selected < ids.length); this.setDisabled(checkbox, this.busy || this.planning);
            }
            renderActionIcons(this.app, this.controlElements);
        } finally {
            const changes = this.pendingDisabled;
            this.pendingDisabled = previousDisabled; this.controlElements = previousElements;
            for (const [element, disabled] of changes) {
                if (previousDisabled) previousDisabled.set(element, disabled);
                else if (element.disabled !== disabled) element.disabled = disabled;
            }
        }
    }

    close(): void {
        if (this.closed) return;
        this.closed = true; this.browserDebugFeedback?.dispose();
        this.listenerScope?.abort();
        Editor.Message.removeBroadcastListener('cocos-git-desk:scope-review-requested', this.scopeReviewRequested);
        if (this.scopeReviewExpiry) clearTimeout(this.scopeReviewExpiry);
        this.scopeReviewRequests = [];
        this.scopeReviewDiffViewport?.close(); this.scopeReviewDiffViewport = undefined;
        this.diffReads?.close(); this.diffRenderPending = false;
        this.fileRowCache?.clear();
        for (const type of ['wheel', 'scroll', 'keydown', 'touchmove', 'pointerdown']) this.el('commit-list').removeEventListener(type, this.historyPaging);
        this.tooltips?.close();
        this.historyViewport?.close(); this.historyViewport = undefined;
        this.diffViewport?.close(); this.diffViewport = undefined;
        for (const viewport of this.sideViewports || []) viewport.close();
        this.sideViewports = [];
        this.copyMenu?.close();
        this.layout?.close();
        this.browserDebugFeedback?.dispose();
        this.closed = true; this.fileCompareLeft = undefined; this.fileCompareRight = undefined;
        this.diffEpoch++; this.currentDiff = undefined; this.currentFile = undefined; this.diffLoading = false; this.epoch++; this.diffEpoch++; this.amendEpoch++;
        this.clearReflog();
        this.resetRemotes();
        this.resetMerge(); this.mergeDrafts.clear();
        this.clearTags();
        this.clearTree();
        if (this.timer) clearTimeout(this.timer);
        if (this.diskRefreshTimer) clearTimeout(this.diskRefreshTimer);
        this.diskObserver.close();
        this.flushFilter(); this.closeFileMenu(); this.workingCache = undefined; this.amendDrafts.clear();
        const doc = this.app.ownerDocument;
        doc.removeEventListener('pointerdown', this.menuOutside, true);
        doc.removeEventListener('keydown', this.menuKeys, true);
        for (const type of ['pointerdown', 'pointercancel', 'click'] as const) this.app.removeEventListener(type, this.modalBackdrop);
        doc.removeEventListener('visibilitychange', this.visibilityChanged);
        doc.defaultView?.removeEventListener('focus', this.windowFocused);
        doc.removeEventListener('scroll', this.menuViewportChanged, true);
        doc.defaultView?.removeEventListener('resize', this.menuViewportChanged);
        for (const id of this.drafts.keys()) void this.saveDraft(id);
        this.commits = []; this.historyFiles = []; this.syncCommits = []; this.stashes = [];
        this.blameEpoch++; this.inspectEpoch++; this.scopeReviewEpoch++; this.syncEpoch++; this.historyEpoch++; this.compareEpoch++;
        this.blame = undefined; this.blameQuery = undefined; this.commitDetails = undefined; this.scopeReview = undefined;
        this.comparison = undefined; this.compareAttempt = undefined; this.syncPage = undefined;
        this.details = undefined; this.snapshot = undefined;
        this.repositoryRows.clear(); this.projectUpdateRows.clear(); this.fileLfs.clear(); this.controlElements?.clear();
        this.selected.clear(); this.selectedLines.clear();
        for (const id of ['file-list', 'commit-list', 'repo-list', 'stash-list', 'sync-list', 'branch-list', 'upstream-list', 'diff-view', 'commit-parents', 'scope-review-patch', 'plan-warnings', 'project-update-rows']) this.el(id).replaceChildren();

    }
}

interface PanelInstance { $: { app: HTMLElement }; controller?: Controller; }
export function ready(this: PanelInstance): void { this.controller = new Controller(this.$.app); }
export function close(this: PanelInstance): void { const controller = this.controller; this.controller = undefined; controller?.close(); }
