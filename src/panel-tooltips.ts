export const TOOLTIP_DELAY_MS = 150;
let sequence = 0;

export function tooltipTitle(element: HTMLElement | undefined | null): string { return element?.title || element?.dataset?.gdTooltip || ''; }
export function setTooltipTitle(element: HTMLElement, text: string): void {
    if (element.dataset?.gdTooltip !== undefined) { if (element.dataset.gdTooltip !== text) element.dataset.gdTooltip = text; }
    else if (element.title !== text) element.title = text;
}

export class PanelTooltips {
    private readonly window: Window;
    private readonly bubble: HTMLDivElement;
    private readonly observer: MutationObserver;
    private target?: HTMLElement;
    private timer?: number;
    private suppressed = false;
    private pointer?: { x: number; y: number };
    private frame?: number;
    private closed = false;

    constructor(private app: HTMLElement) {
        this.window = app.ownerDocument.defaultView!;
        this.bubble = app.ownerDocument.createElement('div'); this.bubble.className = 'gd-tooltip';
        this.bubble.id = `gd-tooltip-${++sequence}`; this.bubble.setAttribute('role', 'tooltip'); this.bubble.hidden = true; app.append(this.bubble);
        this.migrate(app);
        this.observer = new MutationObserver(records => {
            for (const record of records) {
                if (record.type === 'childList') for (const node of record.addedNodes) if (node instanceof HTMLElement) this.migrate(node);
                if (record.type === 'attributes' && record.attributeName === 'title') this.migrate(record.target as HTMLElement);
                if (record.type === 'attributes' && record.attributeName === 'data-gd-tooltip' && record.target === this.target && !this.bubble.hidden) this.show();
            }
            if (this.target && (!this.target.isConnected || this.target.closest('[hidden]'))) this.dismiss();
        });
        this.observer.observe(app, { subtree: true, childList: true, attributes: true, attributeFilter: ['title', 'hidden', 'data-gd-tooltip'] });
        app.addEventListener('pointerover', this.over); app.addEventListener('pointerout', this.out); app.addEventListener('pointermove', this.move);
        app.addEventListener('focusin', this.focus); app.addEventListener('focusout', this.dismiss);
        app.addEventListener('pointerdown', this.dismiss);
        app.ownerDocument.addEventListener('keydown', this.keys, true);
        app.ownerDocument.addEventListener('scroll', this.dismiss, true);
        this.window.addEventListener('blur', this.dismiss); this.window.addEventListener('resize', this.dismiss);
    }

    private migrate(root: HTMLElement): void {
        for (const element of [root, ...root.querySelectorAll<HTMLElement>('[title]')]) {
            if (!element.hasAttribute('title')) continue;
            element.dataset.gdTooltip = element.getAttribute('title') || ''; element.removeAttribute('title');
        }
    }

    private enter(node: EventTarget | null, delay: number, pointer?: { x: number; y: number }): void {
        const element = node instanceof Element ? node.closest<HTMLElement>('[data-gd-tooltip], [title]') : undefined;
        if (!element || !this.app.contains(element) || !tooltipTitle(element) || this.suppressed) return;
        if (this.target === element) { this.pointer = pointer; if (!this.bubble.hidden) this.position(); return; }
        this.dismiss(); this.migrate(element); this.target = element; this.pointer = pointer;
        this.timer = this.window.setTimeout(() => { this.timer = undefined; this.show(); }, delay);
    }
    private over = (event: PointerEvent): void => { this.suppressed = false; this.enter(event.target, TOOLTIP_DELAY_MS, { x: event.clientX, y: event.clientY }); };
    private move = (event: PointerEvent): void => {
        if (!this.pointer || !this.target || !(event.target instanceof Node) || !this.target.contains(event.target)) return;
        this.pointer = { x: event.clientX, y: event.clientY };
        if (this.bubble.hidden || this.frame !== undefined) return;
        this.frame = this.window.requestAnimationFrame(() => { this.frame = undefined; this.position(); });
    };
    private focus = (event: FocusEvent): void => { this.enter(event.target, 0); };
    private out = (event: PointerEvent): void => { if (!this.target?.contains(event.relatedTarget as Node | null)) this.dismiss(); };
    private keys = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape') { this.suppressed = false; return; }
        const handled = this.dismiss(); this.suppressed = true;
        if (handled) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    private show(): void {
        const target = this.target;
        if (this.closed || !target?.isConnected || target.closest('[hidden]')) { this.dismiss(); return; }
        this.bubble.textContent = tooltipTitle(target); this.bubble.hidden = false;
        const described = (target.getAttribute('aria-describedby') || '').split(' ').filter(Boolean);
        if (!described.includes(this.bubble.id)) target.setAttribute('aria-describedby', [...described, this.bubble.id].join(' '));
        this.position();
    }

    private position(): void {
        if (!this.target || this.bubble.hidden) return;
        const app = this.app.getBoundingClientRect(), rect = this.target.getBoundingClientRect(), bounds = this.bubble.getBoundingClientRect();
        const scaleX = app.width / (this.app.offsetWidth || app.width) || 1, scaleY = app.height / (this.app.offsetHeight || app.height) || 1;
        const left = Math.max(app.left, 0) + 8, top = Math.max(app.top, 0) + 8;
        const right = Math.min(app.right, this.window.innerWidth) - 8, bottom = Math.min(app.bottom, this.window.innerHeight) - 8;
        let x: number, y: number;
        if (this.pointer) {
            x = this.pointer.x + 12; y = this.pointer.y + 18;
            if (x + bounds.width > right) x = this.pointer.x - bounds.width - 12;
            if (y + bounds.height > bottom) y = this.pointer.y - bounds.height - 12;
        } else {
            x = this.window.getComputedStyle(this.target).textAlign === 'right' ? rect.right - bounds.width : rect.left;
            y = rect.bottom + 6;
            if (y + bounds.height > bottom) y = rect.top - bounds.height - 6;
        }
        x = Math.max(left, Math.min(x, right - bounds.width));
        y = Math.max(top, Math.min(y, bottom - bounds.height));
        this.bubble.style.left = `${(x - app.left) / scaleX}px`;
        this.bubble.style.top = `${(y - app.top) / scaleY}px`;
    }

    dismiss = (): boolean => {
        const active = this.timer !== undefined || !this.bubble.hidden;
        if (this.timer !== undefined) this.window.clearTimeout(this.timer); this.timer = undefined;
        if (this.target) {
            const ids = (this.target.getAttribute('aria-describedby') || '').split(' ').filter(id => id && id !== this.bubble.id);
            if (ids.length) this.target.setAttribute('aria-describedby', ids.join(' ')); else this.target.removeAttribute('aria-describedby');
        }
        if (this.frame !== undefined) this.window.cancelAnimationFrame(this.frame); this.frame = undefined;
        this.pointer = undefined; this.target = undefined; this.bubble.hidden = true; return active;
    };

    close(): void {
        this.closed = true; this.dismiss(); this.observer.disconnect();
        this.app.removeEventListener('pointerover', this.over); this.app.removeEventListener('pointerout', this.out); this.app.removeEventListener('pointermove', this.move);
        this.app.removeEventListener('focusin', this.focus); this.app.removeEventListener('focusout', this.dismiss);
        this.app.removeEventListener('pointerdown', this.dismiss);
        this.app.ownerDocument.removeEventListener('keydown', this.keys, true); this.app.ownerDocument.removeEventListener('scroll', this.dismiss, true);
        this.window.removeEventListener('blur', this.dismiss); this.window.removeEventListener('resize', this.dismiss);
        for (const element of this.app.querySelectorAll<HTMLElement>('[data-gd-tooltip]')) { element.title = element.dataset.gdTooltip || ''; delete element.dataset.gdTooltip; }
        this.bubble.remove();
    }
}
