interface Reader<T> {
    current: () => boolean;
    resolve: (value: T | undefined) => void;
    reject: (error: unknown) => void;
}
interface Read<T> { key: string; load: () => Promise<T>; share: boolean; readers: Reader<T>[]; }

export class LatestRead<T> {
    private active = new Set<Read<T>>();
    private pending?: Read<T>;
    private closed = false;

    read(key: string, load: () => Promise<T>, current: () => boolean, share = false): Promise<T | undefined> {
        if (this.closed || !current()) return Promise.resolve(undefined);
        return new Promise((resolve, reject) => {
            const reader = { current, resolve, reject };
            const shared = share ? [...this.active, ...(this.pending ? [this.pending] : [])].find(entry => entry.share && entry.key === key) : undefined;
            if (shared) {
                if (this.pending && this.pending !== shared) this.dropPending();
                shared.readers.push(reader);
                return;
            }
            this.dropPending();
            const entry = { key, load, share, readers: [reader] };
            if (this.active.size < 2) this.start(entry); else this.pending = entry;
        });
    }

    private dropPending(): void {
        const pending = this.pending; this.pending = undefined;
        if (pending) for (const reader of pending.readers) reader.resolve(undefined);
    }

    private start(entry: Read<T>): void {
        if (this.closed || !entry.readers.some(reader => reader.current())) {
            for (const reader of entry.readers) reader.resolve(undefined);
            return;
        }
        this.active.add(entry);
        void (async () => {
            try {
                const value = await entry.load();
                for (const reader of entry.readers) reader.resolve(!this.closed && reader.current() ? value : undefined);
            } catch (error) {
                for (const reader of entry.readers) {
                    if (!this.closed && reader.current()) reader.reject(error); else reader.resolve(undefined);
                }
            } finally {
                entry.readers = []; this.active.delete(entry);
                const pending = this.pending; this.pending = undefined;
                if (pending) this.start(pending);
            }
        })();
    }

    close(): void {
        this.closed = true; this.dropPending();
        // Already dispatched IPC reads cannot be interrupted safely; release their UI consumers.
        for (const entry of this.active) {
            for (const reader of entry.readers) reader.resolve(undefined);
            entry.readers = [];
        }
    }
}
