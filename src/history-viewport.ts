import { t } from './i18n';
export const HISTORY_VIRTUAL_THRESHOLD = 200;
const BUFFER_ROWS = 4;

export function historyVisibleRange(count: number, top: number, height: number, rowHeight: number): [number, number] {
    const start = Math.min(count, Math.max(0, Math.floor(top / rowHeight) - BUFFER_ROWS));
    const end = Math.min(count, Math.max(start, Math.ceil((Math.max(0, top) + Math.max(1, height)) / rowHeight) + BUFFER_ROWS));
    return [start, end];
}

export interface HistoryAnchor { sha: string; offset: number; focusSha?: string; }

export class HistoryViewport {
    private readonly host: HTMLDivElement;
    private readonly mounted = new Map<number, HTMLButtonElement>();
    private readonly window: Window;
    private readonly observer: ResizeObserver;
    private selected = '';
    private restoringFocus?: number;
    private frame?: number;
    private closed = false;

    constructor(private list: HTMLElement, private shas: readonly string[], private rowHeight: number, private createRow: (index: number) => HTMLButtonElement, top: number, anchor?: HistoryAnchor) {
        const document = list.ownerDocument;
        this.window = document.defaultView!;
        this.host = document.createElement('div'); this.host.className = 'history-virtual';
        this.host.style.height = `${shas.length * rowHeight}px`;
        this.host.style.setProperty('--gd-history-row-height', `${rowHeight}px`);
        list.append(this.host);
        const index = anchor ? shas.indexOf(anchor.sha) : -1;
        list.scrollTop = index >= 0 ? index * rowHeight + anchor!.offset : top;
        list.addEventListener('scroll', this.schedule, { passive: true });
        list.addEventListener('keydown', this.navigate);
        list.addEventListener('focusout', this.schedule);
        this.observer = new ResizeObserver(this.schedule); this.observer.observe(list);
        const focus = anchor?.focusSha ? shas.indexOf(anchor.focusSha) : -1;
        if (focus >= 0) this.restoringFocus = focus;
        this.render();
        if (focus >= 0) this.mounted.get(focus)?.focus({ preventScroll: true });
        this.restoringFocus = undefined;
    }

    anchor(): HistoryAnchor | undefined {
        const index = Math.min(this.shas.length - 1, Math.floor(this.list.scrollTop / this.rowHeight));
        const focus = this.focusedIndex();
        return index >= 0 ? { sha: this.shas[index]!, offset: this.list.scrollTop - index * this.rowHeight, focusSha: focus === undefined ? undefined : this.shas[focus] } : undefined;
    }

    setSelected(sha: string): void {
        this.selected = sha;
        for (const [index, row] of this.mounted) this.mark(row, index);
    }

    private mark(row: HTMLButtonElement, index: number): void {
        const active = this.shas[index] === this.selected;
        row.classList.toggle('active', active);
        if (row.getAttribute('aria-current') !== String(active)) row.setAttribute('aria-current', String(active));
    }

    private focusedIndex(): number | undefined {
        const root = this.host.getRootNode(), active = root instanceof ShadowRoot ? root.activeElement : this.host.ownerDocument.activeElement;
        const row = active instanceof Element ? active.closest<HTMLElement>('[data-history-index]') : undefined;
        return row?.parentElement === this.host ? Number(row.dataset.historyIndex) : undefined;
    }

    private schedule = (): void => {
        if (this.closed || this.frame !== undefined) return;
        this.frame = this.window.requestAnimationFrame(() => { this.frame = undefined; this.render(); });
    };

    private render(): void {
        if (this.closed) return;
        const [start, end] = historyVisibleRange(this.shas.length, this.list.scrollTop, this.list.clientHeight, this.rowHeight);
        const wanted = new Set<number>();
        for (let index = start; index < end; index++) wanted.add(index);
        const focus = this.focusedIndex() ?? this.restoringFocus; if (focus !== undefined) wanted.add(focus);
        for (const [index, row] of this.mounted) if (!wanted.has(index)) { row.remove(); this.mounted.delete(index); }
        let next: ChildNode | null = null;
        for (const index of [...wanted].sort((a, b) => b - a)) {
            let row = this.mounted.get(index);
            if (!row) {
                row = this.createRow(index); row.dataset.historyIndex = String(index); row.style.top = `${index * this.rowHeight}px`;
                row.setAttribute('aria-label', `${row.title}\n${t('panel.history.rowAria', { index: index + 1, loaded: this.shas.length })}`);
                this.mark(row, index); this.host.insertBefore(row, next); this.mounted.set(index, row);
            }
            next = row;
        }
    }

    private focus(index: number): void {
        const top = index * this.rowHeight;
        if (top < this.list.scrollTop) this.list.scrollTop = top;
        else if (top + this.rowHeight > this.list.scrollTop + this.list.clientHeight) this.list.scrollTop = top + this.rowHeight - this.list.clientHeight;
        this.render(); this.mounted.get(index)?.focus({ preventScroll: true });
    }

    private navigate = (event: KeyboardEvent): void => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const current = this.focusedIndex(); if (current === undefined) return;
        let next: number;
        switch (event.key) {
            case 'ArrowDown': next = Math.min(this.shas.length - 1, current + 1); break;
            case 'ArrowUp': next = Math.max(0, current - 1); break;
            case 'Home': next = 0; break;
            case 'End': next = this.shas.length - 1; break;
            case 'PageDown': next = Math.min(this.shas.length - 1, current + Math.max(1, Math.floor(this.list.clientHeight / this.rowHeight))); break;
            case 'PageUp': next = Math.max(0, current - Math.max(1, Math.floor(this.list.clientHeight / this.rowHeight))); break;
            case 'Tab': next = current + (event.shiftKey ? -1 : 1); if (next < 0 || next >= this.shas.length) return; break;
            default: return;
        }
        event.preventDefault(); this.focus(next);
    };

    close(): void {
        this.closed = true;
        if (this.frame !== undefined) this.window.cancelAnimationFrame(this.frame);
        this.observer.disconnect();
        this.list.removeEventListener('scroll', this.schedule);
        this.list.removeEventListener('keydown', this.navigate);
        this.list.removeEventListener('focusout', this.schedule);
        this.mounted.clear();
    }
}
