import fs from 'fs';
import path from 'path';
import { MessageError } from './i18n';

export const AUTO_FETCH_INTERVAL = 15 * 1000;
export class AutoFetchSchedule {
    enabled = true;
    readonly blocked = new Set<string>();
    private next = new Map<string, number>();
    private readonly initial: number;
    constructor(private readonly filename = path.resolve(__dirname, '../.cache/auto-fetch.json'), now = Date.now()) {
        this.initial = now + 15000;
        if (!fs.existsSync(filename)) return;
        const stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new MessageError('common.autoFetchFileInvalid');
        const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (value.schema !== 1 || typeof value.enabled !== 'boolean') throw new MessageError('common.autoFetchCorrupted');
        this.enabled = value.enabled;
    }
    due(repo: string, now = Date.now()): boolean { return this.enabled && !this.blocked.has(repo) && now >= (this.next.get(repo) ?? this.initial); }
    wake(repo: string, now = Date.now()): boolean { if (!this.enabled || this.blocked.has(repo)) return false; this.next.set(repo, now); return true; }
    delay(repo: string, now = Date.now()): number { return this.enabled && !this.blocked.has(repo) ? Math.max(250, Math.min(AUTO_FETCH_INTERVAL, (this.next.get(repo) ?? this.initial) - now)) : AUTO_FETCH_INTERVAL; }
    defer(repo: string, now = Date.now()): void { this.next.set(repo, now + 15000); }
    reserve(repo: string, now = Date.now()): void { this.next.set(repo, now + AUTO_FETCH_INTERVAL); }
    checked(repo: string): void { this.blocked.delete(repo); }
    settle(repo: string, success: boolean, now = Date.now()): void {
        this.reserve(repo, now);
        if (success) this.blocked.delete(repo); else this.blocked.add(repo);
    }
    toggle(): void {
        fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
        const temp = this.filename + '.' + process.pid + '.tmp';
        fs.writeFileSync(temp, JSON.stringify({ schema: 1, enabled: !this.enabled }), { mode: 0o600 });
        fs.renameSync(temp, this.filename); this.enabled = !this.enabled;
    }
}
