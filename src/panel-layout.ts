import { t } from './i18n';
import { tooltipTitle, setTooltipTitle } from './panel-tooltips';
import fs from 'fs';
import path from 'path';

const definitions = {
    repositories: { target: '#repository-sidebar', peer: '.changes', axis: 'x', label: 'panel.layout.repositories', variable: '--gd-repository-width', min: 150, peerMin: 240, before: false },
    changes: { target: '.changes', peer: '.viewer', axis: 'x', label: 'panel.layout.changes', variable: '--gd-changes-width', min: 240, peerMin: 260, before: false },
    stacked: { target: '.changes', peer: '.viewer', axis: 'y', label: 'panel.layout.stacked', variable: '--gd-stacked-height', min: 180, peerMin: 150, before: false },
    history: { target: '#commit-list', peer: '#file-list', axis: 'y', label: 'panel.layout.history', variable: '--gd-history-height', min: 80, peerMin: 0, before: false },
    commit: { target: '#commit-box', peer: '#file-list', axis: 'y', label: 'panel.layout.commit', variable: '--gd-commit-height', min: 130, peerMin: 80, before: true },
    inspector: { target: '#commit-inspector', peer: '#diff-view', axis: 'y', label: 'panel.layout.inspector', variable: '--gd-inspector-height', min: 80, peerMin: 120, before: false },
    projectUpdate: { target: '#project-update-progress', peer: '.workspace', axis: 'y', label: 'panel.layout.projectUpdate', variable: '--gd-update-height', min: 70, peerMin: 180, before: false },
    log: { target: '#log', peer: '.workspace', axis: 'y', label: 'panel.layout.log', variable: '--gd-log-height', min: 60, peerMin: 240, before: true },
    sides: { target: '.sides .side', peer: '.sides', axis: 'x', label: 'panel.layout.sides', variable: '--gd-before-width', min: 100, peerMin: 100, before: false },
} as const;
type LayoutKey = keyof typeof definitions;
type Sizes = Partial<Record<LayoutKey, number>>;
const keys = Object.keys(definitions) as LayoutKey[];
const settingsFile = path.resolve(__dirname, '../.cache/panel-layout.json');
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const changesCollapseWidth = 180;

export class PanelLayout {
    private sizes: Sizes = {};
    private readonly window: Window;
    private readonly observer: ResizeObserver;
    private frame?: number;
    private closed = false;
    private warned = false;
    private compact = false;
    private visible: boolean;
    private stacked = false;
    private drawer = false;
    private viewerDrawer = false;
    private viewerHidden = false;
    private viewerMaximized = false;
    private readonly viewerToolsMarker: Comment;
    private readonly hoverTitles = new WeakMap<HTMLElement, string>();
    private changesCompact = false;
    private readonly overflow = new Map<HTMLElement, { marker: Comment; target: HTMLElement }>();
    private drag?: { key: LayoutKey; pointer: number; start: number; size: number; previous?: number; position: number; handle: HTMLElement };

    constructor(private app: HTMLElement, private visibilityChanged?: () => void) {
        const window = app.ownerDocument.defaultView;
        if (!window) throw new Error(t('panel.layout.noWindow'));
        this.window = window;
        this.visible = !app.ownerDocument.hidden && !!app.getClientRects().length;
        this.read();
        this.viewerToolsMarker = app.ownerDocument.createComment('viewer-tools');
        app.querySelector('#viewer-tools')!.before(this.viewerToolsMarker);
        for (const id of ['remote', 'fetch', 'update-all', 'pull', 'push', 'scope-reviews-open', 'project-update-open', 'toggle-log', 'compact-commit-toggle']) {
            const element = app.querySelector<HTMLElement>('#' + id)!;
            const marker = app.ownerDocument.createComment('toolbar-' + id);
            const target = app.querySelector<HTMLElement>(id === 'remote' ? '#toolbar-remote-target' : '#toolbar-read-target')!;
            element.before(marker); this.overflow.set(element, { marker, target });
        }
        for (const key of keys) {
            if (key === 'sides') continue;
            const target = this.target(key), divider = this.divider(key);
            if (definitions[key].before) target.before(divider); else target.after(divider);
        }
        app.classList.add('resizable-layout');
        app.addEventListener('pointerdown', this.start);
        app.addEventListener('pointermove', this.move);
        app.addEventListener('pointerup', this.end);
        app.addEventListener('pointercancel', this.cancel);
        app.addEventListener('lostpointercapture', this.cancel);
        app.addEventListener('keydown', this.keydown);
        app.addEventListener('dblclick', this.reset);
        app.addEventListener('toggle', this.refresh, true);
        app.addEventListener('click', this.clicked);
        app.addEventListener('pointerover', this.fullTextHint);
        app.addEventListener('focusin', this.fullTextHint);
        window.addEventListener('blur', this.cancel);
        this.observer = new ResizeObserver(this.refresh);
        for (const selector of ['#app', '.workspace', '.changes', '.viewer']) {
            const element = selector === '#app' ? app : app.querySelector(selector);
            if (element) this.observer.observe(element);
        }
        this.refresh();
    }

    private fullTextHint = (event: Event): void => {
        if (!(event.target instanceof Element)) return;
        for (let element: Element | null = event.target; element && element !== this.app; element = element.parentElement) {
            if (!(element instanceof HTMLElement)) continue;
            const owned = this.hoverTitles.get(element);
            if (tooltipTitle(element) && tooltipTitle(element) !== owned) continue;
            const style = this.window.getComputedStyle(element);
            if (style.textOverflow !== 'ellipsis' && !(Number(style.webkitLineClamp) > 0)) continue;
            const text = element.textContent?.trim() || '';
            const inherited = tooltipTitle(element.parentElement?.closest<HTMLElement>('[data-gd-tooltip], [title]'));
            if (!owned && inherited?.includes(text)) continue;
            setTooltipTitle(element, text);
            this.hoverTitles.set(element, text);
        }
    };

    toggleRepositories(): void {
        if (this.viewerMaximized) {
            this.viewerMaximized = false;
            if (this.compact) this.drawer = true; else this.app.classList.remove('repositories-collapsed');
            this.refresh(); return;
        }
        if (this.compact) { this.drawer = !this.drawer; this.viewerDrawer = false; }
        else this.app.classList.toggle('repositories-collapsed');
        this.refresh();
    }

    revealViewer(): void {
        this.viewerHidden = false;
        if (this.compact) this.viewerDrawer = true;
        else if ((this.sizes.changes ?? 0) >= this.limits('changes').max - 64) delete this.sizes.changes;
        this.drawer = false;
        this.refresh();
    }

    revealHistoryFiles(): void {
        if (this.sizes.history !== 0) return;
        delete this.sizes.history;
        this.save();
        this.refresh();
    }

    restoreWorkspace(): void {
        this.viewerMaximized = false;
        this.refresh();
    }

    private toggleViewer(): void {
        if (this.compact && this.viewerDrawer) this.viewerDrawer = false;
        else if (!this.compact && !this.viewerHidden && this.target('changes').getBoundingClientRect().width < this.limits('changes').max - 64) this.viewerHidden = true;
        else { this.revealViewer(); return; }
        this.refresh();
    }

    private placeViewerTools(): void {
        const tools = this.app.querySelector<HTMLElement>('#viewer-tools')!;
        const topbar = this.app.querySelector<HTMLElement>('#viewer-topbar')!;
        const toolbar = this.app.querySelector<HTMLElement>('.toolbar')!;
        const refresh = this.app.querySelector<HTMLElement>('#refresh')!;
        const lastAction = [...toolbar.children].slice(0, [...toolbar.children].indexOf(topbar)).reverse().find(element => element instanceof HTMLElement && !element.hidden && element.getBoundingClientRect().width > 0) as HTMLElement || refresh;
        const toggle = this.app.querySelector<HTMLElement>('#viewer-toggle')!;
        const viewer = this.target('inspector').parentElement!;
        const toolbarBounds = toolbar.getBoundingClientRect(), actionBounds = lastAction.getBoundingClientRect();
        const free = toolbarBounds.right - actionBounds.right - toggle.getBoundingClientRect().width - this.app.querySelector<HTMLElement>('#viewer-maximize')!.getBoundingClientRect().width - 42;
        const controls = tools.querySelector<HTMLElement>('.view-options')!;
        const controlsWidth = [...controls.children].reduce((width, child) => width + child.getBoundingClientRect().width, 0);
        const promoted = !this.compact && !this.viewerHidden && !toggle.hidden && viewer.clientWidth >= 320
            && actionBounds.top < toolbarBounds.top + 20 && Math.min(free, viewer.clientWidth) >= Math.max(100, controlsWidth + 16);
        const target = promoted ? topbar : this.viewerToolsMarker.parentElement!;
        if (tools.parentElement !== target) {
            const root = this.app.getRootNode();
            const focused = root instanceof ShadowRoot ? root.activeElement : this.app.ownerDocument.activeElement;
            if (promoted) target.append(tools); else this.viewerToolsMarker.after(tools);
            if (focused instanceof HTMLElement && tools.contains(focused)) focused.focus({ preventScroll: true });
        }
        topbar.hidden = !promoted;
        this.app.classList.toggle('viewer-tools-promoted', promoted);
        this.style('--gd-viewer-toolbar-width', Math.min(viewer.clientWidth, Math.max(0, free)));
    }

    private responsive(width: number, height: number): void {
        const compact = width < 1000, stacked = width < 600;
        const singleRemote = this.app.querySelector<HTMLSelectElement>('#remote')!.options.length === 1;
        const root = this.app.getRootNode();
        const focused = root instanceof ShadowRoot ? root.activeElement : this.app.ownerDocument.activeElement;
        let movedFocus = false;
        for (const [element, { marker, target }] of this.overflow) {
            const inMenu = (compact && (stacked || ['remote', 'fetch'].includes(element.id))) || (element.id === 'remote' && singleRemote);
            const move = inMenu ? element.parentElement !== target : marker.nextSibling !== element;
            if (!move) continue;
            if (focused instanceof HTMLElement && element.contains(focused)) {
                movedFocus = true;
                if (inMenu) this.app.querySelector<HTMLDetailsElement>('#more-menu')!.open = true;
            }
            if (inMenu) target.append(element); else marker.after(element);
        }
        if (movedFocus && focused instanceof HTMLElement) focused.focus({ preventScroll: true });
        if (compact !== this.compact) {
            this.compact = compact; this.drawer = false; this.viewerDrawer = false;
            if (compact && (this.app.querySelector('.viewer')!.matches(':focus-within') || this.app.querySelector('#viewer-tools')!.matches(':focus-within'))) this.app.querySelector<HTMLElement>('#viewer-toggle')!.focus();
        }
        this.stacked = stacked;
        this.app.classList.toggle('responsive-compact', compact);
        this.app.classList.toggle('responsive-stacked', stacked);
        this.app.classList.toggle('responsive-short', height < 560);
        if (this.drawer) this.app.dataset.repositoryOpen = 'true'; else delete this.app.dataset.repositoryOpen;
        const widePage = this.app.classList.contains('branch-mode') || this.app.classList.contains('tag-mode');
        const noViewer = this.app.classList.contains('viewer-empty');
        if (noViewer) this.viewerMaximized = false;
        if (widePage) { this.viewerDrawer = false; this.viewerMaximized = false; }
        this.app.classList.toggle('viewer-maximized', this.viewerMaximized);
        if (this.viewerDrawer) this.app.dataset.viewerOpen = 'true'; else delete this.app.dataset.viewerOpen;
        this.app.classList.toggle('viewer-collapsed', compact ? !this.viewerDrawer : this.viewerHidden);
        const viewerToggle = this.app.querySelector<HTMLElement>('#viewer-toggle')!;
        viewerToggle.hidden = widePage || noViewer;
        const viewerExpanded = this.viewerMaximized || (compact ? this.viewerDrawer : !this.viewerHidden && this.target('changes').getBoundingClientRect().width < this.limits('changes').max - 64);
        viewerToggle.setAttribute('aria-expanded', String(viewerExpanded));
        setTooltipTitle(viewerToggle, viewerExpanded ? t('panel.html.viewer-toggle.aria') : t('panel.layout.expandViewer'));
        viewerToggle.setAttribute('aria-label', tooltipTitle(viewerToggle));
        const maximize = this.app.querySelector<HTMLElement>('#viewer-maximize')!;
        maximize.hidden = widePage || noViewer;
        maximize.setAttribute('aria-pressed', String(this.viewerMaximized));
        setTooltipTitle(maximize, this.viewerMaximized ? t('panel.layout.restoreViewer') : t('panel.html.viewer-maximize.aria'));
        maximize.setAttribute('aria-label', tooltipTitle(maximize));
        this.style('--gd-viewer-drawer-width', Math.min(600, Math.max(0, width - 24)));
        const repoToggle = this.app.querySelector<HTMLElement>('#repo-toggle')!;
        const repositoriesExpanded = !this.viewerMaximized && (compact ? this.drawer : !this.app.classList.contains('repositories-collapsed'));
        const repoSelect = this.app.querySelector<HTMLDetailsElement>('#repo-picker')!;
        if (repositoriesExpanded && focused && repoSelect.contains(focused)) repoToggle.focus({ preventScroll: true });
        repoSelect.hidden = repositoriesExpanded;
        if (repositoriesExpanded) repoSelect.open = false;
        repoToggle.setAttribute('aria-expanded', String(repositoriesExpanded));
        setTooltipTitle(repoToggle, repositoriesExpanded ? t('panel.html.repo-toggle.aria') : t('panel.layout.expandRepositories'));
        repoToggle.setAttribute('aria-label', tooltipTitle(repoToggle));
        this.app.querySelector<HTMLElement>('#toolbar-overflow')!.hidden = !compact && !singleRemote;
        this.app.querySelector<HTMLElement>('#toolbar-read-target')!.hidden = !compact;
        this.style('--gd-popup-width', Math.max(160, Math.min(320, width - 16)));
        this.style('--gd-menu-height', Math.max(100, height - 100));
        this.style('--gd-repository-drawer-width', Math.min(width - 24, this.sizes.repositories ?? 180));
        const changes = this.app.querySelector<HTMLElement>('.changes')!, viewer = this.app.querySelector<HTMLElement>('.viewer')!;
        const localCompact = changes.clientWidth < 310 || stacked || height < 560;
        const history = this.app.querySelector<HTMLDetailsElement>('#history-search-tools')!;
        if (localCompact !== this.changesCompact) {
            if (localCompact && !history.matches(':focus-within')) history.open = false;
            this.changesCompact = localCompact;
        }
        changes.classList.toggle('changes-compact', localCompact);
        viewer.classList.toggle('viewer-compact', viewer.clientWidth < 440);
        this.style('--gd-viewer-popup-width', Math.max(160, Math.min(320, viewer.clientWidth - 16)));
        const commit = this.target('commit'), compactCommit = width < 760 || height < 560;
        if (compactCommit && !this.app.classList.contains('commit-compact') && commit.matches(':focus-within')) this.app.dataset.commitExpanded = 'true';
        if (!compactCommit || commit.hidden) delete this.app.dataset.commitExpanded;
        this.app.classList.toggle('commit-compact', compactCommit);
        const toggle = this.app.querySelector<HTMLElement>('#compact-commit-toggle')!;
        toggle.hidden = !compactCommit || commit.hidden;
        toggle.setAttribute('aria-expanded', String(this.app.dataset.commitExpanded === 'true'));
        this.app.querySelector<HTMLElement>('#compact-commit-close')!.hidden = !compactCommit;
    }

    divider(key: LayoutKey): HTMLElement {
        const element = this.app.ownerDocument.createElement('div');
        element.className = 'layout-splitter splitter-' + key;
        element.dataset.layoutKey = key;
        element.dataset.axis = definitions[key].axis;
        element.setAttribute('role', 'separator');
        element.setAttribute('aria-label', t(definitions[key].label));
        element.setAttribute('aria-orientation', definitions[key].axis === 'x' ? 'vertical' : 'horizontal');
        setTooltipTitle(element, t('panel.layout.handleHint', { label: t(definitions[key].label) }));
        element.tabIndex = 0;
        return element;
    }

    refresh = (): void => {
        if (this.closed || this.frame !== undefined) return;
        this.frame = this.window.requestAnimationFrame(() => {
            this.frame = undefined;
            const visible = !this.app.ownerDocument.hidden && !!this.app.getClientRects().length;
            if (this.visible !== visible) { this.visible = visible; this.visibilityChanged?.(); }
            if (this.drag && !this.drag.handle.getClientRects().length) this.finish(false);
            if (!visible) return;
            if (this.drag) this.resize(this.drag.key, this.drag.size + (this.drag.position - this.drag.start) * (definitions[this.drag.key].before ? -1 : 1));
            this.render();
        });
    };

    private target(key: LayoutKey): HTMLElement {
        const element = this.app.querySelector<HTMLElement>(definitions[key].target);
        if (!element) throw new Error(t('panel.layout.missingRegion', { key }));
        return element;
    }

    private handle(event: Event): HTMLElement | undefined {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const element = target.closest<HTMLElement>('[data-layout-key]');
        return element && this.app.contains(element) && keys.includes(element.dataset.layoutKey as LayoutKey) ? element : undefined;
    }

    private limits(key: LayoutKey): { min: number; max: number; value: number } {
        const def = definitions[key], target = this.target(key);
        const workspace = this.app.querySelector<HTMLElement>('.workspace')!;
        const width = workspace.clientWidth, collapsed = this.compact || this.app.classList.contains('repositories-collapsed');
        let max: number;
        if (key === 'repositories') max = Math.min(420, width - 240 - 260 - 12);
        else if (key === 'changes') {
            max = width - (collapsed ? 0 : this.target('repositories').getBoundingClientRect().width + 6) - 6;
        }
        else if (key === 'sides') max = this.app.querySelector<HTMLElement>('.sides')!.clientWidth - 6 - def.peerMin;
        else {
            const peer = this.app.querySelector<HTMLElement>(def.peer)!;
            max = target.getBoundingClientRect().height + peer.getBoundingClientRect().height - def.peerMin;
            if (key === 'history') max += this.app.querySelector<HTMLElement>('#file-pagination')!.getBoundingClientRect().height;
        }
        max = Math.max(0, max);
        return { min: Math.min(key === 'repositories' || key === 'changes' ? 0 : def.min, max), max, value: def.axis === 'x' ? target.getBoundingClientRect().width : target.getBoundingClientRect().height };
    }

    private resize(key: LayoutKey, value: number): void {
        const limit = this.limits(key), size = clamp(value, limit.min, limit.max);
        // Zero preserves a collapsed file pane across window resizes and reopenings.
        this.sizes[key] = key === 'history' && limit.max - size <= 24 ? 0
            : key === 'sides' ? size / Math.max(1, this.app.querySelector<HTMLElement>('.sides')!.clientWidth - 6) : Math.round(size);
    }

    private style(name: string, value?: number): void {
        const text = value === undefined ? '' : Math.round(value) + 'px';
        if (this.app.style.getPropertyValue(name) === text) return;
        if (text) this.app.style.setProperty(name, text); else this.app.style.removeProperty(name);
    }

    private render(): void {
        const width = this.app.querySelector<HTMLElement>('.workspace')!.clientWidth;
        if (!width) return;
        const historyFiles = !!this.target('history').getClientRects().length && !this.app.classList.contains('history-overview');
        this.app.classList.toggle('history-files-resizable', historyFiles);
        this.app.classList.toggle('history-files-collapsed', historyFiles && this.sizes.history === 0);
        this.responsive(this.app.clientWidth, this.app.clientHeight);
        const collapsed = this.compact || this.app.classList.contains('repositories-collapsed');
        const repository = this.limits('repositories');
        this.style('--gd-repository-width', collapsed ? 0 : clamp(this.sizes.repositories ?? 160, repository.min, repository.max));
        this.style('--gd-repository-gap', collapsed ? 0 : 6);
        const changes = this.limits('changes');
        this.style('--gd-changes-width', clamp(this.sizes.changes ?? changes.max * .60, changes.min, changes.max));
        for (const key of keys) {
            const handle = this.app.querySelector<HTMLElement>(`[data-layout-key="${key}"]`);
            const target = this.app.querySelector<HTMLElement>(definitions[key].target);
            if (!handle || !target) continue;
            const widePage = this.app.classList.contains('branch-mode') || this.app.classList.contains('tag-mode');
            handle.hidden = key === 'projectUpdate' || key === 'log' || !target.getClientRects().length || (key === 'repositories' && collapsed) || (key === 'changes' && (this.app.classList.contains('viewer-empty') || widePage || this.stacked || (this.compact ? !this.viewerDrawer : this.viewerHidden)))
                || (key === 'stacked' && (this.app.classList.contains('viewer-empty') || !this.stacked || widePage || (this.compact ? !this.viewerDrawer : this.viewerHidden))) || (key === 'history' && this.app.classList.contains('history-overview')) || (key === 'commit' && this.app.classList.contains('commit-compact')) || (key === 'inspector' && !(target as HTMLDetailsElement).open);
            if (handle.hidden) {
                if (this.drag?.key === key) this.finish(false);
                continue;
            }
            const limit = this.limits(key), preferred = this.sizes[key];
            if (key === 'sides') {
                const space = this.app.querySelector<HTMLElement>('.sides')!.clientWidth - 6;
                this.style(definitions[key].variable, clamp(space * (preferred ?? .5), limit.min, limit.max));
            } else if (definitions[key].axis === 'y') {
                const value = preferred ?? (key === 'stacked' ? this.app.querySelector<HTMLElement>('.workspace')!.clientHeight * .46 : key === 'projectUpdate' ? Math.min(180, this.app.clientHeight * .25) : undefined);
                this.style(definitions[key].variable, value === undefined ? undefined : clamp(value, limit.min, limit.max));
            }
            handle.setAttribute('aria-valuemin', String(Math.round(limit.min)));
            handle.setAttribute('aria-valuemax', String(Math.round(limit.max)));
            const size = Math.round(definitions[key].axis === 'x' ? target.getBoundingClientRect().width : target.getBoundingClientRect().height);
            handle.setAttribute('aria-valuenow', String(size));
            handle.setAttribute('aria-valuetext', t('panel.layout.pixels', { size }));
        }
        this.placeViewerTools();
    }

    private start = (event: PointerEvent): void => {
        if (event.target instanceof Element) {
            if (this.drawer && !event.target.closest('.repositories, #repo-toggle')) { this.drawer = false; this.refresh(); }
            if (this.app.dataset.commitExpanded && !event.target.closest('#commit-box, #compact-commit-toggle, .modal')) { delete this.app.dataset.commitExpanded; this.refresh(); }
        }
        const handle = this.handle(event);
        if (!handle || event.button !== 0 || !event.isPrimary || this.drag) return;
        event.preventDefault();
        const key = handle.dataset.layoutKey as LayoutKey, coordinate = definitions[key].axis === 'x' ? event.clientX : event.clientY;
        handle.setPointerCapture(event.pointerId);
        handle.focus({ preventScroll: true });
        this.drag = { key, pointer: event.pointerId, start: coordinate, position: coordinate, size: this.limits(key).value, previous: this.sizes[key], handle };
        this.app.dataset.resizing = definitions[key].axis;
        handle.classList.add('dragging');
    };

    private move = (event: PointerEvent): void => {
        if (!this.drag || event.pointerId !== this.drag.pointer) return;
        this.drag.position = definitions[this.drag.key].axis === 'x' ? event.clientX : event.clientY;
        this.refresh();
    };

    private end = (event: PointerEvent): void => {
        if (!this.drag || event.pointerId !== this.drag.pointer) return;
        this.drag.position = definitions[this.drag.key].axis === 'x' ? event.clientX : event.clientY;
        this.finish(true);
    };

    private cancel = (): void => { this.finish(false); };
    private clicked = (event: MouseEvent): void => {
        if (event.target instanceof Element && event.target.closest('#viewer-maximize')) { this.viewerMaximized = !this.viewerMaximized; this.refresh(); }
        if (event.target instanceof Element && event.target.closest('#viewer-toggle')) this.toggleViewer();
        if (event.target instanceof Element && event.target.closest('#compact-commit-toggle, #compact-commit-close')) {
            if (event.target.closest('#compact-commit-close') || this.app.dataset.commitExpanded) delete this.app.dataset.commitExpanded;
            else this.app.dataset.commitExpanded = 'true';
            this.refresh();
        }
        if (event.target instanceof Element && event.target.closest('.repo')) { this.drawer = false; this.refresh(); }
        if (event.target instanceof Element && event.target.closest('#toggle-log, #repo-toggle')) this.refresh();
    };

    private collapseRepositories(previous?: number): void {
        if (previous === undefined) delete this.sizes.repositories; else this.sizes.repositories = Math.max(definitions.repositories.min, previous);
        this.app.classList.add('repositories-collapsed');
        this.app.querySelector<HTMLElement>('#repo-toggle')!.focus();
    }

    private collapseViewer(previous?: number): void {
        if (previous === undefined) delete this.sizes.changes; else this.sizes.changes = previous;
        if (this.compact) this.viewerDrawer = false; else this.viewerHidden = true;
        this.app.querySelector<HTMLElement>('#viewer-toggle')!.focus();
    }

    private maximizeViewerFromResize(previous?: number): void {
        // Keep the expanded preference so restore never brings back a sliver.
        if (previous === undefined) delete this.sizes.changes;
        else this.sizes.changes = Math.max(definitions.changes.min, previous);
        this.viewerMaximized = true;
        this.app.querySelector<HTMLElement>('#viewer-maximize')!.focus();
    }

    private finish(save: boolean): void {
        const drag = this.drag;
        if (!drag) return;
        if (save && this.app.contains(drag.handle) && drag.handle.getClientRects().length) this.resize(drag.key, drag.size + (drag.position - drag.start) * (definitions[drag.key].before ? -1 : 1));
        else { save = false; if (drag.previous === undefined) delete this.sizes[drag.key]; else this.sizes[drag.key] = drag.previous; }
        if (save && drag.key === 'repositories' && (this.sizes.repositories ?? 160) <= 64) this.collapseRepositories(drag.previous);
        if (save && drag.key === 'changes') {
            if ((this.sizes.changes ?? 0) <= changesCollapseWidth) this.maximizeViewerFromResize(drag.previous);
            else if (this.limits('changes').max - (this.sizes.changes ?? 0) <= 64) this.collapseViewer(drag.previous);
        }
        this.drag = undefined;
        delete this.app.dataset.resizing;
        drag.handle.classList.remove('dragging');
        if (drag.handle.hasPointerCapture(drag.pointer)) drag.handle.releasePointerCapture(drag.pointer);
        if (save && this.sizes[drag.key] !== drag.previous) this.save();
        this.refresh();
    }

    private keydown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape' && this.drag) { event.preventDefault(); this.finish(false); return; }
        if (event.key === 'Escape' && !this.app.querySelector('.modal:not([hidden])')) {
            if (this.viewerMaximized) { this.restoreWorkspace(); this.app.querySelector<HTMLElement>('#viewer-maximize')!.focus(); event.preventDefault(); return; }
            if (this.app.dataset.commitExpanded) { delete this.app.dataset.commitExpanded; this.app.querySelector<HTMLElement>('#compact-commit-toggle')!.focus(); this.refresh(); event.preventDefault(); return; }
            if (this.viewerDrawer) { this.viewerDrawer = false; this.app.querySelector<HTMLElement>('#viewer-toggle')!.focus(); this.refresh(); event.preventDefault(); return; }
            if (this.drawer) { this.drawer = false; this.app.querySelector<HTMLElement>('#repo-toggle')!.focus(); this.refresh(); event.preventDefault(); return; }
        }
        const handle = this.handle(event);
        if (!handle || this.drag) return;
        const key = handle.dataset.layoutKey as LayoutKey, horizontal = definitions[key].axis === 'x';
        const direction = event.key === (horizontal ? 'ArrowRight' : 'ArrowDown') ? 1 : event.key === (horizontal ? 'ArrowLeft' : 'ArrowUp') ? -1 : 0;
        if (!direction && event.key !== 'Home') return;
        event.preventDefault();
        const previous = this.sizes[key];
        if (event.key === 'Home') delete this.sizes[key];
        else this.resize(key, this.limits(key).value + direction * (definitions[key].before ? -1 : 1) * (event.shiftKey ? 40 : 10));
        if (key === 'repositories' && event.key !== 'Home' && (this.sizes.repositories ?? 160) <= 64) this.collapseRepositories(previous);
        if (key === 'changes' && event.key !== 'Home') {
            if ((this.sizes.changes ?? 0) <= changesCollapseWidth) this.maximizeViewerFromResize(previous);
            else if (this.limits('changes').max - (this.sizes.changes ?? 0) <= 64) this.collapseViewer(previous);
        }
        this.render(); this.save();
    };

    private reset = (event: MouseEvent): void => {
        const handle = this.handle(event);
        if (!handle) return;
        event.preventDefault(); this.finish(false);
        delete this.sizes[handle.dataset.layoutKey as LayoutKey];
        this.render(); this.save();
    };

    private read(): void {
        try {
            if (!fs.existsSync(settingsFile)) return;
            if (fs.statSync(settingsFile).size > 4096) throw new Error(t('panel.layout.settingsTooLarge'));
            const value: unknown = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
            if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('sizes' in value) || !value.sizes || typeof value.sizes !== 'object') return;
            for (const key of keys) {
                const size = (value.sizes as Record<string, unknown>)[key];
                if (typeof size === 'number' && Number.isFinite(size) && (size > 0 || (key === 'history' && size === 0)) && size <= (key === 'sides' ? 1 : 10000)) this.sizes[key] = size;
            }
        } catch (error) { this.warn(error); }
    }

    private save(): void {
        const temporary = settingsFile + '.' + process.pid + '.' + Date.now() + '.tmp';
        let created = false;
        try {
            fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
            fs.writeFileSync(temporary, JSON.stringify({ version: 1, sizes: this.sizes }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            created = true;
            fs.renameSync(temporary, settingsFile);
        } catch (error) { this.warn(error); }
        finally {
            if (created && fs.existsSync(temporary)) {
                try { fs.unlinkSync(temporary); } catch (error) { this.warn(error); }
            }
        }
    }

    private warn(error: unknown): void {
        if (this.warned) return;
        this.warned = true;
        console.warn('[Git Desk] ' + t('panel.layout.settingsFailed'), error);
    }

    close(): void {
        if (this.closed) return;
        this.finish(false); this.closed = true;
        if (this.frame !== undefined) this.window.cancelAnimationFrame(this.frame);
        this.observer.disconnect();
        this.app.classList.remove('history-files-resizable', 'history-files-collapsed');
        for (const [element, { marker }] of this.overflow) { marker.after(element); marker.remove(); }
        this.overflow.clear();
        for (const divider of this.app.querySelectorAll('.layout-splitter')) divider.remove();
        this.viewerToolsMarker.after(this.app.querySelector('#viewer-tools')!);
        this.viewerToolsMarker.remove();
        this.app.removeEventListener('pointerdown', this.start);
        this.app.removeEventListener('pointermove', this.move);
        this.app.removeEventListener('pointerup', this.end);
        this.app.removeEventListener('pointercancel', this.cancel);
        this.app.removeEventListener('lostpointercapture', this.cancel);
        this.app.removeEventListener('keydown', this.keydown);
        this.app.removeEventListener('dblclick', this.reset);
        this.app.removeEventListener('toggle', this.refresh, true);
        this.app.removeEventListener('click', this.clicked);
        this.app.removeEventListener('pointerover', this.fullTextHint);
        this.app.removeEventListener('focusin', this.fullTextHint);
        this.window.removeEventListener('blur', this.cancel);
    }
}
