import { createHash, randomUUID } from 'crypto';
import { consoleLevel, formatConsoleArguments, safeUrl, sanitizeText, sourceLocation } from './preview-sanitize';

export interface CaptureEvent { id: number; time: string; category: string; level: string; message: string; [key: string]: unknown; }
export interface CaptureOptions { captureWebSocketPayloads?: boolean; includeExistingConsole?: boolean; }
interface ReloadWaiter { afterId: number; resolve: (value: unknown) => void; timer: ReturnType<typeof setTimeout>; }
type Params = Record<string, any>;

// Bounded, redacted timeline of what the embedded preview page does; fed from the page's
// CDP events by the main process and read by the MCP tools.
export class PreviewCapture {
    active = false;
    sessionId: string | null = null;
    startedAt: string | null = null;
    private startedAtEpochMs = 0;
    eventsBuffer: CaptureEvent[] = [];
    pageGeneration = 0;
    private requestMap = new Map<string, { method: string; url: string }>();
    private nextEventId = 1;
    private dropped = 0;
    private seenRuntimeEvents = new Set<string>();
    private suppressedHistoricalEvents = 0;
    private suppressedDuplicateEvents = 0;
    private captureWebSocketPayloads = false;
    private includeExistingConsole = false;
    private reloadWaiters = new Set<ReloadWaiter>();
    lastError: string | null = null;
    constructor(private targetUrl: string, private maxEvents = 50000) {}

    start(options: CaptureOptions = {}): Record<string, unknown> {
        this.stop();
        this.active = true;
        this.sessionId = randomUUID();
        this.startedAt = new Date().toISOString();
        this.startedAtEpochMs = Date.now();
        this.eventsBuffer = []; this.requestMap.clear(); this.nextEventId = 1; this.dropped = 0;
        this.seenRuntimeEvents.clear(); this.suppressedHistoricalEvents = 0; this.suppressedDuplicateEvents = 0; this.lastError = null;
        this.captureWebSocketPayloads = options.captureWebSocketPayloads === true;
        this.includeExistingConsole = options.includeExistingConsole === true;
        return this.status();
    }
    stop(): Record<string, unknown> {
        this.active = false;
        for (const waiter of this.reloadWaiters) { clearTimeout(waiter.timer); waiter.resolve({ observed: false, reason: 'capture_stopped', ...this.status() }); }
        this.reloadWaiters.clear();
        return this.status();
    }
    status(): Record<string, unknown> {
        return {
            active: this.active, targetUrl: this.targetUrl, transport: 'creator-embedded', sessionId: this.sessionId, startedAt: this.startedAt,
            pageGeneration: this.pageGeneration, oldestEventId: this.eventsBuffer[0]?.id ?? null, newestEventId: this.eventsBuffer[this.eventsBuffer.length-1]?.id ?? null,
            bufferedEvents: this.eventsBuffer.length, droppedEvents: this.dropped,
            suppressedHistoricalEvents: this.suppressedHistoricalEvents, suppressedDuplicateEvents: this.suppressedDuplicateEvents,
            captureWebSocketPayloads: this.captureWebSocketPayloads, includeExistingConsole: this.includeExistingConsole, lastError: this.lastError,
        };
    }
    isTargetUrl(value: unknown): boolean {
        try { const actual = new URL(String(value)), expected = new URL(this.targetUrl); return actual.origin === expected.origin && actual.pathname === expected.pathname; }
        catch { return false; }
    }
    // One CDP event from the page; navigation is tracked even while no capture session is active.
    handle(method: string, p: Params = {}): void {
        switch (method) {
            case 'Runtime.consoleAPICalled': {
                const frames = p.stackTrace?.callFrames ?? [], source = frames[0];
                const formatted = formatConsoleArguments(p.args);
                if (!this.shouldRecordRuntime(method, p.timestamp, formatted.message)) break;
                this.append('console', consoleLevel(p.type), formatted.message, { consoleType: p.type, appSource: formatted.appSource, loggerType: formatted.loggerType, source: source ? sourceLocation(source) : null, browserTimestamp: p.timestamp ?? null });
                break;
            }
            case 'Runtime.exceptionThrown': {
                const details = p.exceptionDetails ?? {}, frames = details.stackTrace?.callFrames ?? [];
                const content = details.exception?.description ?? details.text ?? 'Uncaught exception';
                if (!this.shouldRecordRuntime(method, p.timestamp, content)) break;
                this.append('exception', 'error', content, {
                    source: frames[0] ? sourceLocation(frames[0]) : { url: safeUrl(details.url ?? ''), line: details.lineNumber ?? null, column: details.columnNumber ?? null },
                    stack: frames.slice(0, 8).map(sourceLocation), browserTimestamp: p.timestamp ?? null,
                });
                break;
            }
            case 'Log.entryAdded': {
                const entry = p.entry ?? {};
                if (!this.shouldRecordRuntime(method, entry.timestamp, entry.text ?? '')) break;
                this.append('browserLog', entry.level ?? 'info', entry.text ?? '', { source: entry.url ? { url: safeUrl(entry.url), line: entry.lineNumber ?? null } : null, browserTimestamp: entry.timestamp ?? null });
                break;
            }
            case 'Network.requestWillBeSent': {
                const request = p.request ?? {};
                this.requestMap.set(p.requestId, { method: request.method, url: safeUrl(request.url) });
                if (this.requestMap.size > 3000) this.requestMap.delete(this.requestMap.keys().next().value!);
                break;
            }
            case 'Network.responseReceived': {
                const response = p.response ?? {};
                if (response.status >= 400) this.append('http', 'error', `HTTP ${response.status} ${safeUrl(response.url)}`, { requestId: p.requestId, method: this.requestMap.get(p.requestId)?.method ?? null, status: response.status });
                break;
            }
            case 'Network.loadingFailed': {
                const request = this.requestMap.get(p.requestId);
                this.append('network', p.canceled ? 'warning' : 'error', `Request failed: ${p.errorText ?? 'unknown'}`, { requestId: p.requestId, method: request?.method ?? null, url: request?.url ?? null, canceled: p.canceled ?? false });
                this.requestMap.delete(p.requestId);
                break;
            }
            case 'Network.loadingFinished': this.requestMap.delete(p.requestId); break;
            case 'Network.webSocketCreated':
                this.requestMap.set(p.requestId, { method: 'WebSocket', url: safeUrl(p.url) });
                this.append('websocket', 'info', 'WebSocket opened', { requestId: p.requestId, url: safeUrl(p.url) });
                break;
            case 'Network.webSocketClosed':
                this.append('websocket', 'info', 'WebSocket closed', { requestId: p.requestId, url: this.requestMap.get(p.requestId)?.url ?? null });
                this.requestMap.delete(p.requestId);
                break;
            case 'Network.webSocketFrameSent':
            case 'Network.webSocketFrameReceived': {
                const frame = p.response ?? {}, payload = frame.payloadData ?? '';
                this.append('websocket', 'info', method.endsWith('Sent') ? 'WebSocket frame sent' : 'WebSocket frame received', {
                    requestId: p.requestId, url: this.requestMap.get(p.requestId)?.url ?? null, opcode: frame.opcode ?? null, encodedPayloadLength: payload.length,
                    ...(this.captureWebSocketPayloads ? { payload: sanitizeText(payload, 1000) } : {}),
                });
                break;
            }
            case 'Page.frameNavigated': {
                if (p.frame?.parentId) break;
                this.pageGeneration++; this.requestMap.clear();
                const url = p.frame?.url ?? '';
                this.append('navigation', 'info', `Page navigated to ${safeUrl(url)}`, { target: this.isTargetUrl(url) });
                break;
            }
        }
    }
    append(category: string, level: string, message: string, details: Record<string, unknown> = {}): CaptureEvent | null {
        if (!this.active) return null;
        const event: CaptureEvent = { id: this.nextEventId++, time: new Date().toISOString(), category, level, message: sanitizeText(message), ...details };
        this.eventsBuffer.push(event);
        if (this.eventsBuffer.length > this.maxEvents) { this.eventsBuffer.shift(); this.dropped++; }
        if (category === 'navigation' && details.target === true) {
            for (const waiter of this.reloadWaiters) {
                if (event.id <= waiter.afterId) continue;
                clearTimeout(waiter.timer); waiter.resolve({ observed: true, event, ...this.status() }); this.reloadWaiters.delete(waiter);
            }
        }
        return event;
    }
    private shouldRecordRuntime(method: string, timestamp: unknown, content: string): boolean {
        if (!this.active) return false;
        if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
            if (!this.includeExistingConsole && timestamp < this.startedAtEpochMs) { this.suppressedHistoricalEvents++; return false; }
            const key = createHash('sha256').update(`${method}|${timestamp}|${content}`).digest('hex');
            if (this.seenRuntimeEvents.has(key)) { this.suppressedDuplicateEvents++; return false; }
            this.seenRuntimeEvents.add(key);
            if (this.seenRuntimeEvents.size > 50000) this.seenRuntimeEvents.delete(this.seenRuntimeEvents.values().next().value!);
        }
        return true;
    }
    events({ sinceId = 0, limit = 50, latest = true, categories, levels, query }: { sinceId?: number; limit?: number; latest?: boolean; categories?: string[]; levels?: string[]; query?: string } = {}): Record<string, unknown> {
        const cappedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
        const categorySet = categories?.length ? new Set(categories) : null, levelSet = levels?.length ? new Set(levels) : null;
        const needle = query ? String(query).toLowerCase() : null;
        const matches = this.eventsBuffer.filter(event => event.id > sinceId && (!categorySet || categorySet.has(event.category)) && (!levelSet || levelSet.has(event.level)) && (!needle || JSON.stringify(event).toLowerCase().includes(needle)));
        const useLatest = sinceId === 0 && latest !== false;
        const selected = useLatest ? matches.slice(-cappedLimit) : matches.slice(0, cappedLimit);
        return { sessionId: this.sessionId, events: selected, matchingEvents: matches.length, hasMore: matches.length > selected.length, omittedEarlierMatches: useLatest ? matches.length - selected.length : 0,
            nextSinceId: selected[selected.length-1]?.id ?? sinceId, oldestEventId: this.eventsBuffer[0]?.id ?? null, droppedEvents: this.dropped, gapBeforeCursor: this.dropped > 0 && sinceId < (this.eventsBuffer[0]?.id ?? 0) - 1 };
    }
    summary({ sinceId = 0 }: { sinceId?: number } = {}): Record<string, unknown> {
        const events = this.eventsBuffer.filter(e => e.id > sinceId), categories: Record<string, number> = {}, levels: Record<string, number> = {};
        for (const event of events) { categories[event.category] = (categories[event.category] ?? 0) + 1; levels[event.level] = (levels[event.level] ?? 0) + 1; }
        return { ...this.status(), sinceId, matchingEvents: events.length, categories, levels, recentErrors: events.filter(e => e.level === 'error').slice(-10) };
    }
    waitForReload({ afterId, timeoutMs = 10000 }: { afterId: number; timeoutMs?: number }): Promise<unknown> {
        if (!this.active) return Promise.resolve({ observed: false, reason: 'capture_not_active', ...this.status() });
        if (!Number.isInteger(afterId) || afterId < 0) throw new Error('afterId must be a non-negative event ID');
        const existing = this.eventsBuffer.find(e => e.id > afterId && e.category === 'navigation' && e.target === true);
        if (existing) return Promise.resolve({ observed: true, event: existing, ...this.status() });
        const delay = Math.min(Math.max(Number(timeoutMs) || 10000, 100), 15000);
        return new Promise(resolve => {
            const waiter: ReloadWaiter = { afterId, resolve, timer: setTimeout(() => { this.reloadWaiters.delete(waiter); resolve({ observed: false, reason: 'timeout', ...this.status() }); }, delay) };
            this.reloadWaiters.add(waiter);
        });
    }
    compare({ beforeStartId, beforeEndId, afterStartId, afterEndId }: { beforeStartId: number; beforeEndId: number; afterStartId: number; afterEndId?: number }): Record<string, unknown> {
        const currentEnd = this.eventsBuffer[this.eventsBuffer.length-1]?.id ?? 0, endAfter = afterEndId ?? currentEnd;
        for (const [name, value] of Object.entries({ beforeStartId, beforeEndId, afterStartId, afterEndId: endAfter })) if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative event ID`);
        if (beforeStartId > beforeEndId || beforeEndId > afterStartId || afterStartId > endAfter) throw new Error('Expected ordered ranges: beforeStart <= beforeEnd <= afterStart <= afterEnd');
        const oldest = this.eventsBuffer[0]?.id ?? null;
        const before = this.intervalReport(beforeStartId, beforeEndId, oldest), after = this.intervalReport(afterStartId, endAfter, oldest);
        const beforeKeys = new Set(before.errorGroups.map(x => x.signature)), afterKeys = new Set(after.errorGroups.map(x => x.signature));
        return { sessionId: this.sessionId, before, after, onlyBefore: before.errorGroups.filter(x => !afterKeys.has(x.signature)), onlyAfter: after.errorGroups.filter(x => !beforeKeys.has(x.signature)),
            interpretation: 'Observed differences only. Repeat the same reproduction steps and check UI and server evidence before concluding a fix.' };
    }
    private intervalReport(startId: number, endId: number, oldest: number | null) {
        const events = this.eventsBuffer.filter(e => e.id > startId && e.id <= endId), groups = new Map<string, { signature: string; count: number; firstEventId: number; appSource: unknown }>(), categories: Record<string, number> = {};
        for (const event of events) {
            categories[event.category] = (categories[event.category] ?? 0) + 1;
            if (event.level !== 'error' && event.category !== 'exception') continue;
            const signature = `${event.category}: ${event.message}`, existing = groups.get(signature);
            if (existing) existing.count++; else groups.set(signature, { signature, count: 1, firstEventId: event.id, appSource: event.appSource ?? null });
        }
        return { startId, endId, complete: oldest === null || startId >= oldest - 1, eventCount: events.length, categories, navigationCount: events.filter(e => e.category === 'navigation' && e.target === true).length, errorGroups: [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 20) };
    }
    mark(label: string): Record<string, unknown> {
        if (!this.active) throw new Error('Start a capture session first');
        this.append('marker', 'info', label);
        return { sessionId: this.sessionId, marker: this.eventsBuffer[this.eventsBuffer.length-1] };
    }
}
