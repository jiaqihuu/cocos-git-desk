import { t } from './i18n';

export class BrowserDebugFeedback {
    private pending = false;
    private disposed = false;
    private timer?: ReturnType<typeof setTimeout>;
    constructor(private show: (message: string, pending: boolean) => void) {}
    async run(label: string, work: () => Promise<string>): Promise<void> {
        if (this.pending || this.disposed) return;
        this.pending = true;
        this.show(label + '…', true);
        this.timer = setTimeout(() => {
            if (!this.disposed) this.show(t('panel.feedback.waiting'), true);
        }, 15000);
        try {
            const message = await work();
            if (!this.disposed) this.show(message, false);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const reason = /Message does not exist/.test(detail) ? t('panel.feedback.messageMissing') : detail;
            if (!this.disposed) this.show(t('panel.feedback.failed', { label, reason }), false);
        } finally {
            clearTimeout(this.timer);
            this.pending = false;
        }
    }
    dispose(): void { this.disposed = true; clearTimeout(this.timer); }
}
