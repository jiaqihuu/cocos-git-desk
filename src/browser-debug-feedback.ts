import { t } from './i18n';

export class BrowserDebugFeedback {
    private pending = false;
    private disposed = false;
    private timer?: ReturnType<typeof setTimeout>;
    constructor(private show: (message: string, pending: boolean, failed: boolean) => void) {}
    async run(label: string, work: () => Promise<string>): Promise<void> {
        if (this.pending || this.disposed) return;
        this.pending = true;
        this.show(label + '…', true, false);
        this.timer = setTimeout(() => {
            if (!this.disposed) this.show(t('panel.feedback.waiting'), true, false);
        }, 15000);
        try {
            const message = await work();
            if (!this.disposed) this.show(message, false, false);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const reason = /Message does not exist/.test(detail) ? t('panel.feedback.messageMissing') : detail;
            if (!this.disposed) this.show(t('panel.feedback.failed', { label, reason }), false, true);
        } finally {
            clearTimeout(this.timer);
            this.pending = false;
        }
    }
    dispose(): void { this.disposed = true; clearTimeout(this.timer); }
}

// A status element that closes by itself once an action settles: a success after a short read, a failure
// after a longer one. Hovering keeps it open and leaving restarts the countdown; pending progress stays.
export class TransientNotice {
    private timer?: ReturnType<typeof setTimeout>;
    private delay = 0;
    private readonly enter = () => this.cancel();
    private readonly leave = () => { if (!this.element.hidden && this.delay) this.schedule(this.delay); };
    constructor(private element: HTMLElement, private successMs = 3000, private failureMs = 10000) {
        element.addEventListener('pointerenter', this.enter);
        element.addEventListener('pointerleave', this.leave);
    }
    show(message: string, pending: boolean, failed = false): void {
        this.element.textContent = message;
        this.element.hidden = false;
        if (pending) { this.cancel(); this.delay = 0; } else this.schedule(failed ? this.failureMs : this.successMs);
    }
    hide(): void { this.cancel(); this.delay = 0; this.element.hidden = true; }
    dispose(): void {
        this.cancel();
        this.element.removeEventListener('pointerenter', this.enter);
        this.element.removeEventListener('pointerleave', this.leave);
    }
    private schedule(ms: number): void {
        this.cancel();
        this.delay = ms;
        this.timer = setTimeout(() => { this.timer = undefined; this.delay = 0; this.element.hidden = true; }, ms);
    }
    private cancel(): void { if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; } }
}
