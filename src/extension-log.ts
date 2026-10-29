import { format } from 'util';
import { t } from './i18n';

export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';
export interface LogEntry { id: number; time: string; level: LogLevel; text: string; }
export interface Issue { id: number; time: string; source: string; message: string; }
export interface LogQuery { level?: LogLevel | LogLevel[]; sinceId?: number; limit?: number; query?: string; }
type Sink = Pick<Console, 'log' | 'info' | 'warn' | 'error' | 'debug'>;
const levels: LogLevel[] = ['log', 'info', 'warn', 'error', 'debug'];

// The extension's own output and failures, kept in memory so an AI can read them instead of
// asking a person to open the Creator console. Only what passes through this object is recorded:
// the global console is never patched, because other extensions share the main process.
export class ExtensionLog {
    readonly console: Sink;
    private entries: LogEntry[] = [];
    private issues: Issue[] = [];
    private nextId = 1;
    private nextIssueId = 1;
    private dropped = 0;
    constructor(private sink: Sink = console, private capacity = 500, private issueCapacity = 50) {
        const make = (level: LogLevel) => (...args: unknown[]) => { this.record(level, format(...args)); (this.sink[level] || this.sink.log).apply(this.sink, args as []); };
        this.console = { log: make('log'), info: make('info'), warn: make('warn'), error: make('error'), debug: make('debug') };
    }
    record(level: LogLevel, text: string): LogEntry {
        const entry: LogEntry = { id: this.nextId++, time: new Date().toISOString(), level, text: String(text).slice(0, 2000) };
        this.entries.push(entry);
        if (this.entries.length > this.capacity) { this.entries.shift(); this.dropped++; }
        return entry;
    }
    issue(source: string, message: string): Issue {
        const entry: Issue = { id: this.nextIssueId++, time: new Date().toISOString(), source: String(source).slice(0, 80), message: String(message).slice(0, 500) };
        this.issues.push(entry);
        if (this.issues.length > this.issueCapacity) this.issues.shift();
        return entry;
    }
    recentIssues(limit = 50): Issue[] { return this.issues.slice(-Math.max(1, limit)); }
    // Same cursor semantics as the page event capture: sinceId 0 returns the latest page, a cursor continues forward.
    tail({ level, sinceId = 0, limit = 50, query }: LogQuery = {}): Record<string, unknown> {
        const wanted = level === undefined ? null : new Set((Array.isArray(level) ? level : [level]).filter(item => levels.includes(item)));
        const needle = query ? String(query).toLowerCase() : '';
        const cappedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
        const matches = this.entries.filter(entry => entry.id > sinceId && (!wanted || wanted.has(entry.level)) && (!needle || entry.text.toLowerCase().includes(needle)));
        const selected = sinceId === 0 ? matches.slice(-cappedLimit) : matches.slice(0, cappedLimit);
        return { entries: selected, matching: matches.length, hasMore: matches.length > selected.length, nextSinceId: selected.length ? selected[selected.length - 1]!.id : sinceId,
            oldestId: this.entries[0]?.id ?? null, newestId: this.entries.length ? this.entries[this.entries.length - 1]!.id : null, dropped: this.dropped, capacity: this.capacity,
            coverage: t('misc.log.coverage') };
    }
}
