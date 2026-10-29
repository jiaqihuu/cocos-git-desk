import { t } from './i18n';
export const DIFF_VIRTUAL_THRESHOLD = 400;
const BUFFER_PIXELS = 300;

export interface DiffViewportRow { height: number; text: string; code?: string; focusable?: boolean; }
const sources = new WeakMap<HTMLElement, DiffViewport>();

export function diffRowOffsets(rows: readonly DiffViewportRow[]): number[] {
    const offsets = [0];
    for (const row of rows) offsets.push(offsets[offsets.length - 1]! + row.height);
    return offsets;
}

export function diffVisibleRange(offsets: readonly number[], top: number, height: number): [number, number] {
    const count = offsets.length - 1;
    const find = (position: number): number => {
        let low = 0, high = count;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (offsets[middle + 1]! <= position) low = middle + 1;
            else high = middle;
        }
        return low;
    };
    const start = find(Math.max(0, top - BUFFER_PIXELS));
    const end = Math.min(count, find(Math.max(0, top) + Math.max(1, height) + BUFFER_PIXELS) + 1);
    return [start, end];
}

export function virtualDiffText(element: HTMLElement): string | undefined {
    return sources.get(element)?.text();
}

export function virtualDiffSelection(element: HTMLElement): string | undefined {
    return sources.get(element)?.selectionText();
}

function displayColumns(text: string): number {
    let columns = 0;
    for (const character of text) {
        if (character === '\t') columns += 4 - columns % 4;
        else columns += character.codePointAt(0)! >= 0x1100 ? 2 : 1;
    }
    return columns;
}

export class DiffViewport {
    private readonly offsets: number[];
    private readonly mounted = new Map<number, HTMLElement>();
    private readonly window: Window;
    private readonly observer: ResizeObserver;
    private frame?: number;
    private closed = false;

    constructor(private viewport: HTMLElement, private host: HTMLElement, private rows: readonly DiffViewportRow[], private createRow: (index: number) => HTMLElement, gutter: number, private relativeHost = false) {
        this.window = host.ownerDocument.defaultView!;
        this.offsets = diffRowOffsets(rows);
        host.classList.add('virtual-diff'); host.tabIndex = 0;
        host.setAttribute('aria-label', t('panel.diff.viewportAria'));
        host.style.height = `${this.offsets[this.offsets.length - 1]}px`;
        // Reserve width for unmounted lines so horizontal scrolling does not jump.
        let columns = 0;
        for (const row of rows) columns = Math.max(columns, displayColumns(row.code ?? row.text));
        host.style.width = `calc(${columns + 1}ch + ${gutter}px)`;
        sources.set(host, this);
        viewport.addEventListener('scroll', this.schedule, { passive: true });
        host.addEventListener('keydown', this.selectAll);
        host.ownerDocument.addEventListener('selectionchange', this.schedule);
        host.addEventListener('focusout', this.schedule);
        this.observer = new ResizeObserver(this.schedule);
        this.observer.observe(viewport);
        this.render();
    }

    private rowIndex(node: Node | null): number | undefined {
        const element = node?.nodeType === 1 ? node as Element : node?.parentElement;
        const row = element?.closest<HTMLElement>('[data-viewport-row]');
        return row && row.parentElement === this.host ? Number(row.dataset.viewportRow) : undefined;
    }

    private schedule = (): void => {
        if (this.closed || this.frame !== undefined) return;
        this.frame = this.window.requestAnimationFrame(() => { this.frame = undefined; this.render(); });
    };

    private render(): void {
        if (this.closed) return;
        const [start, end] = diffVisibleRange(this.offsets, this.relativeHost ? this.viewport.getBoundingClientRect().top - this.host.getBoundingClientRect().top : this.viewport.scrollTop, this.viewport.clientHeight);
        const wanted = new Set<number>();
        for (let index = start; index < end; index++) wanted.add(index);
        const selection = this.host.ownerDocument.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
        const entire = range && !range.collapsed && range.startContainer === this.host && range.endContainer === this.host && range.startOffset === 0 && range.endOffset === this.host.childNodes.length;
        let changed = false;
        for (const node of [selection?.anchorNode, selection?.focusNode, this.host.getRootNode() instanceof ShadowRoot ? (this.host.getRootNode() as ShadowRoot).activeElement : this.host.ownerDocument.activeElement]) {
            const index = this.rowIndex(node ?? null);
            if (index !== undefined) wanted.add(index);
        }
        for (const [index, element] of this.mounted) if (!wanted.has(index)) { element.remove(); this.mounted.delete(index); changed = true; }
        let next: ChildNode | null = null;
        // Insert only new rows, keeping native focus and text selection on retained nodes.
        for (const index of [...wanted].sort((a, b) => b - a)) {
            let element = this.mounted.get(index);
            if (!element) {
                element = this.createRow(index);
                element.dataset.viewportRow = String(index);
                element.classList.add('virtual-diff-row');
                element.style.top = `${this.offsets[index]}px`;
                element.style.height = `${this.rows[index]!.height}px`;
                this.host.insertBefore(element, next); this.mounted.set(index, element); changed = true;
            }
            next = element;
        }
        if (entire && changed && selection) {
            const full = this.host.ownerDocument.createRange(); full.selectNodeContents(this.host);
            selection.removeAllRanges(); selection.addRange(full);
        }
    }

    text(): string { return this.rows.map(row => row.text).join('\n'); }

    selectionText(): string | undefined {
        const selection = this.host.ownerDocument.getSelection();
        if (!selection?.rangeCount) return;
        const range = selection.getRangeAt(0);
        if (range.collapsed || !this.host.contains(range.startContainer) || !this.host.contains(range.endContainer)) return;
        const start = this.rowIndex(range.startContainer) ?? 0, end = this.rowIndex(range.endContainer) ?? this.rows.length - 1;
        const lines: string[] = [];
        for (let index = start; index <= end; index++) {
            const row = this.rows[index]!;
            if (row.code === undefined) continue;
            const element = this.mounted.get(index);
            const content = element?.matches('.line-row') ? element.querySelector('.line-content') : element;
            if ((index === start || index === end) && content && range.intersectsNode(content)) {
                const clipped = range.cloneRange();
                if (!content.contains(clipped.startContainer)) clipped.setStart(content, 0);
                if (!content.contains(clipped.endContainer)) clipped.setEnd(content, content.childNodes.length);
                lines.push(clipped.toString());
            } else if ((index !== start && index !== end) || range.startContainer === this.host || range.endContainer === this.host) lines.push(row.code);
        }
        return lines.join('\n');
    }

    private selectAll = (event: KeyboardEvent): void => {
        if (event.key === 'Tab' && event.target instanceof HTMLInputElement) {
            const current = this.rowIndex(event.target);
            if (current === undefined) return;
            const direction = event.shiftKey ? -1 : 1;
            let index = current + direction;
            while (index >= 0 && index < this.rows.length && !this.rows[index]!.focusable) index += direction;
            if (index < 0 || index >= this.rows.length) return;
            if (this.offsets[index]! < this.viewport.scrollTop || this.offsets[index + 1]! > this.viewport.scrollTop + this.viewport.clientHeight) this.viewport.scrollTop = this.offsets[index]!;
            this.render(); this.mounted.get(index)?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
            event.preventDefault(); return;
        }
        if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'a') return;
        const selection = this.host.ownerDocument.getSelection();
        if (!selection) return;
        const range = this.host.ownerDocument.createRange(); range.selectNodeContents(this.host);
        selection.removeAllRanges(); selection.addRange(range); event.preventDefault(); event.stopPropagation();
    };

    close(): void {
        this.closed = true;
        if (this.frame !== undefined) this.window.cancelAnimationFrame(this.frame);
        this.observer.disconnect();
        this.viewport.removeEventListener('scroll', this.schedule);
        this.host.removeEventListener('keydown', this.selectAll);
        this.host.ownerDocument.removeEventListener('selectionchange', this.schedule);
        this.host.removeEventListener('focusout', this.schedule);
        sources.delete(this.host); this.mounted.clear();
    }
}
