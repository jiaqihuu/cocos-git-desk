// Redaction rules shared by the capture buffer and the evidence export; ported from the former standalone MCP.
const MAX_TEXT = 2000;

export function sanitizeText(value: unknown, maxLength = MAX_TEXT): string {
    let text = String(value ?? '');
    text = text.replace(/\bBearer\s+[^\s,"'}]+/gi, 'Bearer [redacted]');
    text = text.replace(/\b(authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|password|secret|token)\b["']?\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1=[redacted]');
    text = text.replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[jwt redacted]');
    return text.length > maxLength ? `${text.slice(0, maxLength)}…[truncated]` : text;
}

export function safeUrl(value: unknown): string {
    try {
        const url = new URL(String(value));
        const pathname = url.pathname.replace(/[A-Za-z0-9_-]{32,}/g, '[long-id]');
        const base = url.protocol === 'file:' ? 'file://' : url.origin;
        return sanitizeText(`${base}${pathname}`, 500);
    } catch {
        return sanitizeText(value, 500);
    }
}

interface RemoteObject { value?: unknown; unserializableValue?: string; preview?: { properties?: Array<{ name: string; value?: string; type?: string }>; overflow?: boolean }; description?: string; type?: string; }

export function consoleArgument(arg: RemoteObject | undefined): string {
    if (arg?.value !== undefined) return sanitizeText(typeof arg.value === 'object' ? JSON.stringify(arg.value) : arg.value);
    if (arg?.unserializableValue !== undefined) return sanitizeText(arg.unserializableValue);
    if (arg?.preview?.properties?.length) {
        const fields = arg.preview.properties.slice(0, 12).map(p => `${p.name}: ${p.value ?? p.type ?? '?'}`);
        return sanitizeText(`{ ${fields.join(', ')}${arg.preview.overflow ? ', …' : ''} }`);
    }
    if (arg?.description) return sanitizeText(arg.description);
    if (arg?.type) return `[${arg.type}]`;
    return '[unknown]';
}

export interface ConsoleText { message: string; appSource: { file: string; functionName: string | null } | null; loggerType: string | null; }

// The game logger prints "%c%s%s%s:%s" style strings; the pieces are reassembled into one readable line.
export function formatConsoleArguments(args: RemoteObject[] = []): ConsoleText {
    const values = args.map(consoleArgument);
    const format = values[0] ?? '';
    if (format === '%c%s%s%s:%s%o' || format === '%c%s%s%s:%o') {
        const hasDescription = format === '%c%s%s%s:%s%o';
        const time = values[2] ?? '', loggerType = values[3] ?? '', stack = values[4] ?? '';
        const description = hasDescription ? values[5] ?? '' : '';
        const payload = values[hasDescription ? 6 : 5] ?? '';
        const match = stack.match(/\[([^\]\s]+\.ts)(?:->([^\]\s]+))?\]/);
        return {
            message: sanitizeText(`${time}${loggerType}${stack}${description ? `:${description}` : ''} ${payload}`.trim()),
            appSource: match ? { file: match[1]!, functionName: match[2] ?? null } : null,
            loggerType: loggerType || null,
        };
    }
    return { message: sanitizeText(values.join(' ')), appSource: null, loggerType: null };
}

export function consoleLevel(type: unknown): 'error' | 'warning' | 'info' {
    if (type === 'error' || type === 'assert') return 'error';
    if (type === 'warning' || type === 'warn') return 'warning';
    return 'info';
}

export interface SourceLocation { url: string; functionName: string; line: number | null; column: number | null; }
export function sourceLocation(frame: { url?: string; functionName?: string; lineNumber?: number; columnNumber?: number }): SourceLocation {
    return { url: safeUrl(frame.url ?? ''), functionName: sanitizeText(frame.functionName ?? '', 120), line: frame.lineNumber ?? null, column: frame.columnNumber ?? null };
}
