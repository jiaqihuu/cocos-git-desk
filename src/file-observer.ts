import fs from 'fs';
import path from 'path';

// Watch only the selected file's parent; a recursive project watch is costly in Creator.
export class SelectedFileObserver {
    private watcher?: fs.FSWatcher;
    private filename = '';
    constructor(private readonly changed: () => void) {}
    get active(): boolean { return !!this.watcher; }
    setFile(filename?: string): void {
        if ((filename || '') === this.filename && this.watcher) return;
        this.close();
        if (!filename) return;
        this.filename = filename;
        try {
            this.watcher = fs.watch(path.dirname(filename), { persistent: false }, (event, name) => {
                if (!name || event === 'rename' || name.toString() === path.basename(filename)) this.changed();
            });
            this.watcher.on('error', () => { this.close(); this.changed(); });
        } catch { this.filename = ''; }
    }
    close(): void { this.watcher?.close(); this.watcher = undefined; this.filename = ''; }
}
