import { PatchHunk, PatchLine } from './types';
import { MessageError } from './i18n';

export interface ParsedPatch { headers: string[]; hunks: PatchHunk[]; }

// Only canonical, single-file Git patches enter this parser, never renderer input.
export function parsePatch(patch: string): ParsedPatch {
    const raw = patch.split('\n');
    if (raw.pop() !== '') throw new MessageError('git.patch.incomplete');
    if (raw.length > 15000) throw new MessageError('git.patch.tooManyLines');
    const headers: string[] = [], hunks: PatchHunk[] = [];
    let hunk: PatchHunk | undefined, oldLine = 0, newLine = 0;
    for (const line of raw) {
        const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (match) {
            hunk = { header: line, oldStart: Number(match[1]), oldCount: Number(match[2] ?? 1), newStart: Number(match[3]), newCount: Number(match[4] ?? 1), lines: [] };
            oldLine = hunk.oldStart; newLine = hunk.newStart; hunks.push(hunk);
        } else if (!hunk) {
            if (!/^(diff --git |index |--- |\+\+\+ )/.test(line)) throw new MessageError('git.patch.fileChanged');
            headers.push(line);
        } else if (line === '\\ No newline at end of file') {
            const previous = hunk.lines[hunk.lines.length - 1];
            if (!previous || previous.noNewline) throw new MessageError('git.patch.eofMarkerInvalid');
            previous.noNewline = true;
        } else {
            const kind = line[0];
            if (kind !== ' ' && kind !== '+' && kind !== '-') throw new MessageError('git.patch.cannotParse');
            hunk.lines.push({ kind, text: line.slice(1), id: kind === ' ' ? undefined : `${hunks.length - 1}:${hunk.lines.length}`, oldLine: kind !== '+' ? oldLine++ : undefined, newLine: kind !== '-' ? newLine++ : undefined });
        }
    }
    if (headers.filter(h => h.startsWith('diff --git ')).length !== 1 || headers.filter(h => h.startsWith('--- a/') || h.startsWith('--- "a/')).length !== 1 || headers.filter(h => h.startsWith('+++ b/') || h.startsWith('+++ "b/')).length !== 1 || !hunks.length) throw new MessageError('git.patch.linesUnsupported');
    for (const item of hunks) {
        if (item.lines.filter(l => l.kind !== '+').length !== item.oldCount || item.lines.filter(l => l.kind !== '-').length !== item.newCount) throw new MessageError('git.patch.lineCountIncomplete');
    }
    return { headers, hunks };
}

export function selectPatch(parsed: ParsedPatch, ids: string[], reverse = false): string {
    if (!Array.isArray(ids) || !ids.length || ids.length > 15000 || ids.some(id => typeof id !== 'string')) throw new MessageError('git.patch.selectLines');
    const selected = new Set(ids), valid = new Set(parsed.hunks.flatMap(h => h.lines.flatMap(l => l.id ? [l.id] : [])));
    if (selected.size !== ids.length || ids.some(id => !valid.has(id))) throw new MessageError('git.patch.selectionStale');
    // Index hashes refer to the original whole diff, not to the selected result.
    const headers = parsed.headers.filter(h => !h.startsWith('index '));
    const result: string[] = [...headers];
    let delta = 0;
    for (const hunk of parsed.hunks) {
        if (!hunk.lines.some(l => l.id && selected.has(l.id))) continue;
        const lines: PatchLine[] = [];
        for (const line of hunk.lines) {
            const chosen = !!line.id && selected.has(line.id);
            if (line.kind === ' ') lines.push(line);
            else if (!reverse) {
                if (line.kind === '-') lines.push({ ...line, kind: chosen ? '-' : ' ' });
                else if (chosen) lines.push(line);
            } else {
                if (line.kind === '+') lines.push({ ...line, kind: chosen ? '-' : ' ' });
                else if (chosen) lines.push({ ...line, kind: '+' });
            }
        }
        for (const excluded of ['+', '-']) {
            const side = lines.filter(l => l.kind !== excluded);
            if (side.slice(0, -1).some(l => l.noNewline)) throw new MessageError('git.patch.eofNewlineDependency');
        }
        const oldCount = lines.filter(l => l.kind !== '+').length, newCount = lines.filter(l => l.kind !== '-').length;
        const sourceStart = reverse ? hunk.newStart : hunk.oldStart;
        const sourceCount = reverse ? hunk.newCount : hunk.oldCount;
        const position = sourceStart + (sourceCount === 0 ? 1 : 0);
        const oldStart = position - (oldCount === 0 ? 1 : 0), newStart = position + delta - (newCount === 0 ? 1 : 0);
        result.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
        for (const line of lines) {
            result.push(line.kind + line.text);
            if (line.noNewline) result.push('\\ No newline at end of file');
        }
        delta += newCount - oldCount;
    }
    return result.join('\n') + '\n';
}

export function applyPatchText(source: string, parsed: ParsedPatch): string {
    const output: string[] = [];
    let cursor = 0, row = 0, unterminated = false;
    const emit = (text: string) => {
        if (!text) return;
        if (unterminated) throw new MessageError('git.patch.joinsNoNewlineEnd');
        output.push(text); unterminated = !text.endsWith('\n');
    };
    for (const hunk of parsed.hunks) {
        const target = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
        if (!Number.isSafeInteger(target) || target < row) throw new MessageError('git.patch.hunksOverlap');
        const start = cursor;
        while (row < target) {
            if (cursor >= source.length) throw new MessageError('git.patch.hunkOutOfFile');
            const end = source.indexOf('\n', cursor); cursor = end < 0 ? source.length : end + 1; row++;
        }
        emit(source.slice(start, cursor));
        let consumed = 0, produced = 0;
        for (const line of hunk.lines) {
            const text = line.text + (line.noNewline ? '' : '\n');
            if (line.kind !== '+') {
                if (cursor >= source.length) throw new MessageError('git.patch.bodyOutOfFile');
                const end = source.indexOf('\n', cursor), next = end < 0 ? source.length : end + 1;
                if (source.slice(cursor, next) !== text) throw new MessageError('git.patch.contextMismatch');
                cursor = next; row++; consumed++;
            }
            if (line.kind !== '-') { emit(text); produced++; }
        }
        if (consumed !== hunk.oldCount || produced !== hunk.newCount) throw new MessageError('git.patch.hunkLineCount');
    }
    emit(source.slice(cursor));
    return output.join('');
}
