import { promises as fs } from 'fs';
import path from 'path';
import { t, MessageError } from './i18n';
import { keyRegExp, CsvColumn, CsvLayout, perLanguageCsvColumns } from './config';

// Many games resolve language keys from a remote configuration at runtime and keep json files in the
// project only as the fallback. A change that adds or renames a key therefore needs the key in every
// fallback file and a hand-off (CSV) for whoever maintains the remote copy. This audit collects the
// keys a change touches, where they are used, which fallback files have them, placeholder consistency
// and the commit that introduced each one, and drafts the CSV. The key pattern, fallback directory,
// languages and CSV columns come from git-desk.config.json (i18n section) through the options.
export interface LanguageKeyOptions {
    keys?: string[]; since?: string; paths?: string[]; history?: boolean; csv?: boolean | 'all'; limit?: number;
    /** Regular expression source matching one key (required; from config i18n.keyPattern). */
    keyPattern?: string | null;
    /** Fallback json directory, project-relative (config i18n.directory). */
    directory?: string;
    /** Languages to audit (config i18n.languages); empty means every <directory>/*.json file. */
    languages?: string[];
    /** CSV columns (config i18n.csvColumns): "key", "usage", "status" or a language code, plus "language" and "text" per language; a column may carry its header. */
    csvColumns?: CsvColumn[];
    /** One row per key, or one row per key and language (config i18n.csvLayout). */
    csvLayout?: CsvLayout;
    /** Texts written in the "status" column (config i18n.csvStatus). */
    csvStatus?: { missing?: string; present?: string };
}
export interface KeyUsage { file: string; line: number; text: string; }
export interface KeyReport { key: string; usageCount: number; usages: KeyUsage[]; local: Record<string, string | null>; missing: string[]; placeholders: Record<string, string[]>; placeholderMismatch: boolean; firstSeen: { commit: string; date: string; author: string; subject: string } | null | 'skipped'; }
export interface LanguageKeyAudit { source: string; languages: string[]; files: Record<string, string>; keys: KeyReport[]; truncated: boolean; csv?: string; note: string; }
export type KeyGit = (args: string[], allowed?: number[]) => Promise<string>;

const KEY_LIMIT = 100, USAGE_LIMIT = 50, HISTORY_LIMIT = 30;
const PLACEHOLDER = /\{\d+\}|\{[a-zA-Z_]+\}|%[sd]/g;
export const defaultLanguageDirectory = 'assets/resources/language/json', defaultCsvColumns = ['key', 'en', 'zh'];

export async function auditLanguageKeys(root: string, git: KeyGit, options: LanguageKeyOptions = {}): Promise<LanguageKeyAudit> {
    if (!options.keyPattern) throw new MessageError('creator.languageKeyPatternMissing');
    const pattern = keyRegExp(options.keyPattern);
    const directory = (options.directory || defaultLanguageDirectory).replace(/\/+$/, '');
    let languages = options.languages?.length ? options.languages : [];
    if (!languages.length) {
        try { languages = (await fs.readdir(path.join(root, directory))).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).sort(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (!languages.length) throw new MessageError('creator.languageFilesMissing', { directory });
    const files: Record<string, string> = {}, tables: Record<string, Record<string, unknown>> = {};
    for (const language of languages) {
        const name = directory + '/' + language + '.json';
        files[language] = name;
        try { const parsed: unknown = JSON.parse(await fs.readFile(path.join(root, name), 'utf8')); tables[language] = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new MessageError('creator.languageFileUnparsable', { name }); tables[language] = {}; }
    }
    const roots = (options.paths?.length ? options.paths : ['assets']).map(item => item.replace(/\/+$/, ''));
    const inLanguageDir = (name: string) => name === directory || name.startsWith(directory + '/');
    // Keys come from the caller, or from the added lines of the change (plus untracked files) under the roots.
    let keys: string[], source: string;
    if (options.keys?.length) {
        keys = [...new Set(options.keys.map(item => item.trim()).filter(item => /^[A-Za-z0-9_.-]{1,120}$/.test(item)))]; source = t('creator.languageSourceKeys');
    } else {
        // Keys mentioned in added lines but not in removed lines of the same diff: a reformatted or moved
        // line does not count, and the fallback json files themselves are not usages.
        const added = new Set<string>(), removed = new Set<string>();
        const diff = await git(['diff', '--unified=0', '--no-color', ...(options.since ? [options.since] : ['HEAD']), '--', ...roots]);
        let skipFile = false;
        for (const line of diff.split('\n')) {
            if (line.startsWith('+++ ') || line.startsWith('--- ')) { const name = line.slice(4).replace(/^[ab]\//, ''); if (line.startsWith('+++ ')) skipFile = inLanguageDir(name); continue; }
            if (skipFile || !/^[+-]/.test(line)) continue;
            for (const match of line.matchAll(pattern)) (line.startsWith('+') ? added : removed).add(match[0]);
        }
        const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...roots])).split('\0').filter(name => name && !inLanguageDir(name) && /\.(ts|js|json|prefab|scene)$/i.test(name)).slice(0, 200);
        for (const name of untracked) { try { for (const match of (await fs.readFile(path.join(root, name), 'utf8')).matchAll(pattern)) added.add(match[0]); } catch { /* unreadable files are skipped */ } }
        keys = [...added].filter(key => !removed.has(key)).sort(); source = options.since ? t('creator.languageSourceSince', { since: options.since }) : t('creator.languageSourceUncommitted');
    }
    const truncated = keys.length > (options.limit ?? KEY_LIMIT);
    keys = keys.slice(0, options.limit ?? KEY_LIMIT);
    const reports: KeyReport[] = [];
    for (const [index, key] of keys.entries()) {
        const grep = await git(['grep', '-n', '-F', '--untracked', '-e', key, '--', ...roots], [0, 1]);
        const usages: KeyUsage[] = [];
        let usageCount = 0;
        for (const line of grep.split('\n')) {
            const match = /^([^:]+):(\d+):(.*)$/.exec(line);
            if (!match || inLanguageDir(match[1]!)) continue;
            usageCount++;
            if (usages.length < USAGE_LIMIT) usages.push({ file: match[1]!, line: Number(match[2]), text: match[3]!.trim().slice(0, 200) });
        }
        const local: Record<string, string | null> = {}, placeholders: Record<string, string[]> = {}, missing: string[] = [];
        for (const language of languages) {
            const value = tables[language]![key];
            local[language] = typeof value === 'string' && value !== '' ? value : null;
            if (local[language] === null) missing.push(language); else placeholders[language] = [...local[language]!.matchAll(PLACEHOLDER)].map(item => item[0]).sort();
        }
        const shapes = new Set(Object.values(placeholders).map(list => list.join(' ')));
        let firstSeen: KeyReport['firstSeen'] = 'skipped';
        if (options.history !== false && index < HISTORY_LIMIT) {
            const log = await git(['log', '-S' + key, '--reverse', '--date=short', '--format=%h%x1f%ad%x1f%an%x1f%s', '--', ...roots, directory]);
            const first = log.split('\n').find(Boolean);
            const parts = first ? first.split('\x1f') : [];
            firstSeen = parts.length === 4 ? { commit: parts[0]!, date: parts[1]!, author: parts[2]!, subject: parts[3]!.slice(0, 120) } : null;
        }
        reports.push({ key, usageCount, usages, local, missing, placeholders, placeholderMismatch: shapes.size > 1, firstSeen });
    }
    let csv: string | undefined;
    if (options.csv) {
        // perKey: one row per key; csv=missing keeps keys that lack at least one language. perLanguage: one row per key
        // and language; csv=missing keeps only the languages that lack the key. csv=all keeps every row in both layouts.
        const layout: CsvLayout = options.csvLayout === 'perLanguage' ? 'perLanguage' : 'perKey';
        const columns = (options.csvColumns?.length ? options.csvColumns : layout === 'perLanguage' ? perLanguageCsvColumns : defaultCsvColumns)
            .map(column => typeof column === 'string' ? { field: column, header: column } : { field: column.field, header: column.header ?? column.field });
        const missingText = options.csvStatus?.missing ?? 'missing', presentText = options.csvStatus?.present ?? 'present';
        const escape = (value: string) => /[",\n\r]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
        const usage = (report: KeyReport) => report.usages[0] ? report.usages[0].file + ':' + report.usages[0].line : '';
        const rows = [columns.map(column => escape(column.header)).join(',')];
        for (const report of reports) {
            if (layout === 'perLanguage') {
                for (const language of languages) {
                    const value = report.local[language] ?? null;
                    if (options.csv !== 'all' && value !== null) continue;
                    const cell = (field: string): string => field === 'key' ? report.key : field === 'usage' ? usage(report) : field === 'language' ? language
                        : field === 'text' ? value ?? '' : field === 'status' ? (value === null ? missingText : presentText) : report.local[field] ?? '';
                    rows.push(columns.map(column => escape(cell(column.field))).join(','));
                }
                continue;
            }
            if (options.csv !== 'all' && !report.missing.length) continue;
            const cell = (field: string): string => field === 'key' ? report.key : field === 'usage' ? usage(report)
                : field === 'status' ? (report.missing.length ? missingText + ': ' + report.missing.join(' ') : presentText) : report.local[field] ?? '';
            rows.push(columns.map(column => escape(cell(column.field))).join(','));
        }
        csv = rows.join('\n') + '\n';
    }
    return { source, languages, files, keys: reports, truncated, ...(csv !== undefined ? { csv } : {}), note: t('creator.languageKeysNote') };
}
