import { t } from './i18n';
import { virtualDiffText, virtualDiffSelection } from './diff-viewport';

export interface CopyItem { label: string; text: string | (() => Promise<string>); }

export class PanelCopy {
    private readonly menu: HTMLDivElement;
    private origin?: HTMLElement;
    private epoch = 0;
    private closed = false;

    constructor(private app: HTMLElement) {
        this.menu = app.ownerDocument.createElement('div');
        this.menu.className = 'file-menu text-copy-menu';
        this.menu.setAttribute('role', 'menu');
        this.menu.setAttribute('aria-label', t('panel.copyMenu.aria'));
        this.menu.hidden = true;
        app.append(this.menu);
        app.addEventListener('contextmenu', this.context);
        app.addEventListener('copy', this.copySelection);
        app.ownerDocument.addEventListener('pointerdown', this.outside, true);
        app.ownerDocument.addEventListener('keydown', this.keydown, true);
        app.ownerDocument.addEventListener('scroll', this.scroll, true);
        app.ownerDocument.defaultView?.addEventListener('resize', this.hide);
    }

    open(origin: HTMLElement, x: number, y: number, items: CopyItem[]): void {
        this.hide();
        if (this.closed) return;
        this.origin = origin;
        const epoch = this.epoch;
        for (const item of items) {
            const button = this.app.ownerDocument.createElement('button');
            button.textContent = item.label; button.setAttribute('role', 'menuitem');
            button.disabled = typeof item.text === 'string' && !item.text;
            button.addEventListener('click', () => { void this.copy(item, epoch); });
            this.menu.append(button);
        }
        this.menu.hidden = false;
        this.place(x, y);
        this.menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    }

    private selectedText(element: HTMLElement): string {
        const virtual = virtualDiffSelection(element);
        if (virtual !== undefined) return virtual;
        if (element.matches('.line-patch')) return this.codeSelection() ?? '';
        const selection = this.app.ownerDocument.getSelection();
        return selection?.anchorNode && selection.focusNode && element.contains(selection.anchorNode) && element.contains(selection.focusNode) ? selection.toString() : '';
    }

    private codeSelection(): string | undefined {
        const selection = this.app.ownerDocument.getSelection();
        if (!selection?.rangeCount) return;
        const original = selection.getRangeAt(0);
        // Creator's Chromium may report isCollapsed=true for a nonempty shadow-DOM selection.
        if (original.collapsed) return;
        const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
        const virtual = anchor?.closest<HTMLElement>('.virtual-diff');
        if (virtual && this.app.contains(virtual)) {
            const text = virtualDiffSelection(virtual);
            if (text !== undefined) return text;
        }
        const patch = anchor?.closest('.line-patch');
        if (!patch || !this.app.contains(patch) || !selection.focusNode || !patch.contains(selection.focusNode)) return;
        const lines: string[] = [];
        for (const content of patch.querySelectorAll('.line-content')) {
            if (!original.intersectsNode(content)) continue;
            const range = original.cloneRange();
            if (!content.contains(range.startContainer)) range.setStart(content, 0);
            if (!content.contains(range.endContainer)) range.setEnd(content, content.childNodes.length);
            lines.push(range.toString());
        }
        return lines.length ? lines.join('\n') : undefined;
    }

    private copySelection = (event: ClipboardEvent): void => {
        const code = this.codeSelection();
        if (code === undefined || !event.clipboardData) return;
        event.clipboardData.setData('text/plain', code);
        event.preventDefault();
    };

    private context = (event: MouseEvent): void => {
        if (!(event.target instanceof Element)) return;
        const element = event.target.closest<HTMLElement>('#commit-message, #commit-identity, .line-patch, .diff-view pre, .blame-list, #plan-patch');
        if (!element || !this.app.contains(element)) return;
        event.preventDefault(); event.stopPropagation();
        const selected = this.selectedText(element);
        const lines = element.matches('.line-patch') ? element.querySelectorAll<HTMLElement>('.line-hunk span, .line-content, .line-eof')
            : element.matches('.patch') ? element.querySelectorAll<HTMLElement>('span')
            : element.matches('.blame-list') ? element.querySelectorAll<HTMLElement>('.blame-row code') : [];
        const text = virtualDiffText(element) ?? (lines.length ? Array.from(lines, line => (line.dataset.diffPrefix || '') + (line.textContent || '')).join('\n') : element.textContent || '');
        const label = element.id === 'commit-message' ? t('panel.copyMenu.commitMessage') : element.id === 'commit-identity' ? t('panel.copyMenu.commitIdentity')
            : element.matches('.line-patch, .patch, #plan-patch') ? t('panel.copyMenu.diff') : t('panel.copyMenu.code');
        this.open(element, event.clientX, event.clientY, [{ label: t('panel.copyMenu.selection'), text: selected }, { label, text }]);
    };

    private async copy(item: CopyItem, epoch: number): Promise<void> {
        for (const button of this.menu.querySelectorAll<HTMLButtonElement>('button')) button.disabled = true;
        let text: string;
        try {
            text = typeof item.text === 'string' ? item.text : await item.text();
            if (this.closed || epoch !== this.epoch || !this.origin?.isConnected) return;
            if (text.length > 1024 * 1024) throw new Error(t('panel.copyMenu.tooLarge'));
        } catch (error) {
            if (!this.closed && epoch === this.epoch) this.note(t('panel.readFailed', { error: error instanceof Error ? error.message : String(error) }));
            return;
        }
        try {
            const clipboard = this.app.ownerDocument.defaultView?.navigator.clipboard;
            if (!clipboard) throw new Error(t('panel.clipboardUnavailable'));
            await clipboard.writeText(text);
            if (!this.closed && epoch === this.epoch) this.hide();
        } catch {
            if (this.closed || epoch !== this.epoch) return;
            this.note(t('panel.copyMenu.copyFailed'));
            const fallback = this.app.ownerDocument.createElement('textarea');
            fallback.className = 'text-copy-fallback'; fallback.readOnly = true; fallback.value = text;
            fallback.setAttribute('aria-label', t('panel.copyMenu.fallbackAria')); this.menu.append(fallback);
            this.place(this.menu.getBoundingClientRect().left, this.menu.getBoundingClientRect().top);
            fallback.focus(); fallback.select();
        }
    }

    private note(text: string): void {
        const note = this.app.ownerDocument.createElement('div');
        note.className = 'file-menu-note'; note.textContent = text; note.setAttribute('role', 'status');
        this.menu.append(note);
        this.place(this.menu.getBoundingClientRect().left, this.menu.getBoundingClientRect().top);
    }

    private place(x: number, y: number): void {
        const window = this.app.ownerDocument.defaultView;
        if (!window) return;
        const rect = this.menu.getBoundingClientRect();
        this.menu.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
        this.menu.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
    }

    private outside = (event: Event): void => { if (!event.composedPath().includes(this.menu)) this.hide(); };
    private scroll = (event: Event): void => { if (!event.composedPath().includes(this.menu)) this.hide(); };
    private keydown = (event: KeyboardEvent): void => {
        if (this.menu.hidden) return;
        if (event.key === 'Escape' || event.key === 'Tab') {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
            const origin = this.origin; this.hide(); origin?.focus({ preventScroll: true }); return;
        }
        if (!event.composedPath().includes(this.menu) || event.target instanceof HTMLTextAreaElement) return;
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const items = [...this.menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        if (!items.length) return;
        event.preventDefault(); event.stopPropagation();
        const index = items.findIndex(item => event.composedPath().includes(item));
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        items[next]?.focus({ preventScroll: true });
    };

    hide = (): void => { this.epoch++; this.origin = undefined; this.menu.hidden = true; this.menu.replaceChildren(); };

    close(): void {
        this.closed = true; this.hide();
        this.app.removeEventListener('contextmenu', this.context);
        this.app.removeEventListener('copy', this.copySelection);
        this.app.ownerDocument.removeEventListener('pointerdown', this.outside, true);
        this.app.ownerDocument.removeEventListener('keydown', this.keydown, true);
        this.app.ownerDocument.removeEventListener('scroll', this.scroll, true);
        this.app.ownerDocument.defaultView?.removeEventListener('resize', this.hide);
        this.menu.remove();
    }
}
