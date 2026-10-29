import { BlameLine } from './types';
import { MessageError } from './i18n';

function blamePath(value: string): string {
    if (!value || Buffer.from(value, 'utf8').toString('utf8') !== value) throw new MessageError('git.blame.pathNotUtf8');
    if (!value.startsWith('"')) {
        if (/[\x00-\x1f\x7f"\\]/.test(value)) throw new MessageError('git.blame.pathQuoteInvalid');
        return value;
    }
    const bytes: number[] = [], escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
    let closed = false;
    for (let i = 1; i < value.length; i++) {
        const char = value[i]!;
        if (char === '"') {
            if (i !== value.length - 1) throw new MessageError('git.blame.pathTrailing');
            closed = true; break;
        }
        if (char === '\\') {
            const escape = value[++i];
            if (escape !== undefined && Object.prototype.hasOwnProperty.call(escapes, escape)) bytes.push(escapes[escape]!);
            else {
                const octal = value.slice(i, i + 3);
                if (!/^[0-3][0-7]{2}$/.test(octal)) throw new MessageError('git.blame.pathEscapeInvalid');
                bytes.push(parseInt(octal, 8)); i += 2;
            }
        } else {
            const point = value.codePointAt(i)!;
            if (point < 32 || point === 127) throw new MessageError('git.blame.pathControlChar');
            bytes.push(...Buffer.from(String.fromCodePoint(point), 'utf8'));
            if (point > 0xffff) i++;
        }
    }
    if (!closed) throw new MessageError('git.blame.pathQuoteIncomplete');
    const encoded = Buffer.from(bytes), decoded = encoded.toString('utf8');
    if (!Buffer.from(decoded, 'utf8').equals(encoded)) throw new MessageError('git.blame.pathNotUtf8');
    if (!decoded || decoded.includes('\0')) throw new MessageError('git.blame.pathEmpty');
    return decoded;
}

function blameDate(timestamp: string, timezone: string): string {
    const seconds = Number(timestamp);
    if (!/^-?\d+$/.test(timestamp) || !Number.isSafeInteger(seconds) || !/^[+-](?:[01]\d|2[0-3])[0-5]\d$/.test(timezone)) throw new MessageError('git.blame.timeInvalid');
    const date = new Date(seconds * 1000);
    if (!Number.isFinite(date.getTime())) throw new MessageError('git.blame.timeOutOfRange');
    return date.toISOString();
}

export function parseBlame(raw: string): BlameLine[] {
    if (!raw) return [];
    const input = raw.split('\n');
    if (input.pop() !== '') throw new MessageError('git.blame.outputIncomplete');
    const result: BlameLine[] = [];
    const required = ['author', 'author-mail', 'author-time', 'author-tz', 'committer', 'committer-mail', 'committer-time', 'committer-tz', 'summary', 'filename'];
    for (let offset = 0; offset < input.length;) {
        const header = /^(?:([a-f0-9]{40}|[a-f0-9]{64})) ([1-9]\d*) ([1-9]\d*)(?: ([1-9]\d*))?$/.exec(input[offset++]!);
        if (!header || /^0+$/.test(header[1]!)) throw new MessageError('git.blame.headerInvalid');
        const originalLine = Number(header[2]), line = Number(header[3]), count = Number(header[4] ?? 1);
        if (![originalLine, line, count].every(Number.isSafeInteger) || (result.length > 0 && line !== result[result.length - 1]!.line + 1)) throw new MessageError('git.blame.lineNumberInvalid');
        const metadata = new Map<string, string>();
        let text: string | undefined, boundary = false;
        while (offset < input.length) {
            const item = input[offset++]!;
            if (item.startsWith('\t')) { text = item.slice(1); break; }
            const field = /^([a-z][a-z0-9-]*)(?: (.*))?$/.exec(item);
            if (!field) throw new MessageError('git.blame.metadataInvalid');
            const key = field[1]!, value = field[2];
            if (key === 'boundary') {
                if (value !== undefined || boundary) throw new MessageError('git.blame.boundaryInvalid');
                boundary = true;
            } else if (required.includes(key) || key === 'previous') {
                if (value === undefined || metadata.has(key)) throw new MessageError('git.blame.metadataValue');
                metadata.set(key, value);
            }
        }
        if (text === undefined) throw new MessageError('git.blame.contentMissing');
        if (required.some(key => !metadata.has(key))) throw new MessageError('git.blame.metadataMissing');
        const email = /^<([^<>]*)>$/.exec(metadata.get('author-mail')!);
        if (!email || !/^<[^<>]*>$/.test(metadata.get('committer-mail')!)) throw new MessageError('git.blame.emailInvalid');
        const date = blameDate(metadata.get('author-time')!, metadata.get('author-tz')!);
        blameDate(metadata.get('committer-time')!, metadata.get('committer-tz')!);
        const previous = metadata.get('previous');
        if (previous !== undefined) {
            const reference = /^([a-f0-9]{40}|[a-f0-9]{64}) (.+)$/.exec(previous);
            if (!reference || /^0+$/.test(reference[1]!)) throw new MessageError('git.blame.previousInvalid');
            blamePath(reference[2]!);
        }
        result.push({ line, originalLine, sha: header[1]!, author: metadata.get('author')!, email: email[1]!, date, summary: metadata.get('summary')!, originalPath: blamePath(metadata.get('filename')!), boundary, text });
    }
    return result;
}
