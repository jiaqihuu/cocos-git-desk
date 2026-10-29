import { createHash } from 'crypto';
import { readFileSync, realpathSync } from 'fs';
import os from 'os';
import path from 'path';
import { MessageError } from './i18n';

// Project configuration (git-desk.config.json in the Creator project root, committed with the project)
// and per-machine settings (extensions/cocos-git-desk/.cache/agent-settings.json). Nothing here is
// specific to one game: every project-dependent name, path or pattern comes from these two files.
export const extensionName = 'cocos-git-desk';
export const configFileName = 'git-desk.config.json';
export const settingsFileName = 'agent-settings.json';
export const defaultPreviewUrl = 'http://localhost:7456/';
export const dataDirName = '.cocos-git-desk';
export type ClientName = 'codex' | 'claude-code';
export const clientNames: readonly ClientName[] = ['codex', 'claude-code'];
/** perKey: one CSV row per key; perLanguage: one row per key and language, the shape many translation back ends import. */
export type CsvLayout = 'perKey' | 'perLanguage';
/** A CSV column: a field name, or a field with the header text the receiving system expects. */
export type CsvColumn = string | { field: string; header?: string };
export const perLanguageCsvColumns: readonly string[] = ['key', 'usage', 'language', 'text', 'status'];

export interface GitDeskConfig {
    preview: { url: string | null; engineVersions: string[] };
    bridge: { controlName: string; debugName: string; apiVersion: string; environmentField: string; testEnvironments: string[] };
    revision: { roots: string[] };
    i18n: { keyPattern: string | null; directory: string; languages: string[]; csvLayout: CsvLayout; csvColumns: CsvColumn[]; csvStatus: { missing: string; present: string } };
    clients: ClientName[];
}
export interface LocalSettings { requireHumanReview?: boolean; debug: { stateDir: string; outputDir: string } }
export interface ToolSchema { name: string; description?: string; inputSchema: { type?: string; properties: Record<string, any>; required?: string[] }; annotations?: Record<string, unknown>; }
export type CatalogueName = 'core' | 'inspector' | 'bridge' | 'i18n';
export const catalogueNames: readonly CatalogueName[] = ['core', 'inspector', 'bridge', 'i18n'];

export function defaultConfig(): GitDeskConfig {
    return {
        preview: { url: null, engineVersions: ['3.8.x'] },
        bridge: { controlName: '__COCOS_GIT_DESK_PREVIEW_CONTROL__', debugName: '__COCOS_GIT_DESK_DEBUG__', apiVersion: 'cocos-git-desk-preview-bridge/1', environmentField: 'environment', testEnvironments: ['dev', 'test', 'staging'] },
        revision: { roots: ['assets', 'extensions/*/assets'] },
        i18n: { keyPattern: null, directory: 'assets/resources/language/json', languages: [], csvLayout: 'perKey', csvColumns: ['key', 'en', 'zh'], csvStatus: { missing: 'missing', present: 'present' } },
        clients: [],
    };
}

const identifier = /^[A-Za-z_$][\w$]*$/, versionPattern = /^\d+(\.(\d+|x))*$/;
function invalid(key: string, expected: string): MessageError { return new MessageError('main.configFieldInvalid', { file: configFileName, key, expected }); }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function stringList(value: unknown, key: string, allowEmpty: boolean): string[] {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item) || (!allowEmpty && !value.length)) throw invalid(key, allowEmpty ? 'string[]' : 'non-empty string[]');
    return value as string[];
}
function relativePath(value: unknown, key: string, wildcard: boolean): string {
    if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) throw invalid(key, 'project-relative POSIX path');
    const parts = value.replace(/\/+$/, '').split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || (part.includes('*') && (!wildcard || part !== '*')))) throw invalid(key, wildcard ? 'project-relative path; "*" may replace a whole segment' : 'project-relative path');
    return parts.join('/');
}
function csvColumnList(value: unknown): CsvColumn[] {
    const expected = 'non-empty array of field names or { "field", "header" } objects';
    if (!Array.isArray(value) || !value.length || value.length > 50) throw invalid('i18n.csvColumns', expected);
    return value.map((item): CsvColumn => {
        if (typeof item === 'string' && item) return item;
        if (isRecord(item) && typeof item.field === 'string' && item.field && Object.keys(item).every(key => key === 'field' || key === 'header')
            && (item.header === undefined || (typeof item.header === 'string' && item.header))) return item.header === undefined ? { field: item.field } : { field: item.field, header: item.header as string };
        throw invalid('i18n.csvColumns', expected);
    });
}
function section<K extends keyof GitDeskConfig>(raw: Record<string, unknown>, name: K, allowed: string[]): Record<string, unknown> {
    const value = raw[name];
    if (value === undefined) return {};
    if (!isRecord(value)) throw invalid(name, 'object');
    for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new MessageError('main.configUnknownKey', { file: configFileName, key: name + '.' + key });
    return value;
}
/** Compile the configured key pattern; "/body/flags" keeps its flags, a bare pattern is global and case-sensitive. */
export function keyRegExp(pattern: string): RegExp {
    const wrapped = /^\/(.+)\/([a-z]*)$/s.exec(pattern);
    const body = wrapped ? wrapped[1]! : pattern, flags = wrapped ? wrapped[2]! : '';
    try { return new RegExp(body, flags.includes('g') ? flags : flags + 'g'); }
    catch { throw new MessageError('creator.languageKeyPatternInvalid', { pattern }); }
}
/** Validate a parsed configuration object and fill every omitted field with its default. */
export function validateConfig(raw: unknown): GitDeskConfig {
    const config = defaultConfig();
    if (raw === undefined || raw === null) return config;
    if (!isRecord(raw)) throw new MessageError('main.configNotObject', { file: configFileName });
    for (const key of Object.keys(raw)) if (!['preview', 'bridge', 'revision', 'i18n', 'clients'].includes(key)) throw new MessageError('main.configUnknownKey', { file: configFileName, key });
    const preview = section(raw, 'preview', ['url', 'engineVersions']);
    if (preview.url !== undefined && preview.url !== null) {
        if (typeof preview.url !== 'string') throw invalid('preview.url', 'http(s) URL or null');
        let parsed: URL; try { parsed = new URL(preview.url); } catch { throw invalid('preview.url', 'http(s) URL or null'); }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw invalid('preview.url', 'http(s) URL or null');
        config.preview.url = preview.url;
    }
    if (preview.engineVersions !== undefined) {
        config.preview.engineVersions = stringList(preview.engineVersions, 'preview.engineVersions', false);
        if (config.preview.engineVersions.some(item => !versionPattern.test(item))) throw invalid('preview.engineVersions', 'versions such as "3.8.x" or "3.8.8"');
    }
    const bridge = section(raw, 'bridge', ['controlName', 'debugName', 'apiVersion', 'environmentField', 'testEnvironments']);
    for (const key of ['controlName', 'debugName', 'environmentField'] as const) {
        if (bridge[key] === undefined) continue;
        if (typeof bridge[key] !== 'string' || !identifier.test(bridge[key] as string)) throw invalid('bridge.' + key, 'JavaScript identifier');
        config.bridge[key] = bridge[key] as string;
    }
    if (bridge.apiVersion !== undefined) {
        if (typeof bridge.apiVersion !== 'string' || !bridge.apiVersion || bridge.apiVersion.length > 128) throw invalid('bridge.apiVersion', 'non-empty string');
        config.bridge.apiVersion = bridge.apiVersion;
    }
    // Page commands run only on these environments; "*" accepts any environment the page reports, never an unreported one.
    if (bridge.testEnvironments !== undefined) {
        config.bridge.testEnvironments = stringList(bridge.testEnvironments, 'bridge.testEnvironments', false);
        if (config.bridge.testEnvironments.some(item => item.length > 64)) throw invalid('bridge.testEnvironments', 'non-empty string[] of names up to 64 characters');
    }
    const revision = section(raw, 'revision', ['roots']);
    if (revision.roots !== undefined) config.revision.roots = stringList(revision.roots, 'revision.roots', false).map(item => relativePath(item, 'revision.roots', true));
    const i18n = section(raw, 'i18n', ['keyPattern', 'directory', 'languages', 'csvLayout', 'csvColumns', 'csvStatus']);
    if (i18n.keyPattern !== undefined && i18n.keyPattern !== null) {
        if (typeof i18n.keyPattern !== 'string' || !i18n.keyPattern) throw invalid('i18n.keyPattern', 'regular expression source or null');
        keyRegExp(i18n.keyPattern);
        config.i18n.keyPattern = i18n.keyPattern;
    }
    if (i18n.directory !== undefined) config.i18n.directory = relativePath(i18n.directory, 'i18n.directory', false);
    if (i18n.languages !== undefined) config.i18n.languages = stringList(i18n.languages, 'i18n.languages', true);
    if (i18n.csvLayout !== undefined) {
        if (i18n.csvLayout !== 'perKey' && i18n.csvLayout !== 'perLanguage') throw invalid('i18n.csvLayout', '"perKey" or "perLanguage"');
        config.i18n.csvLayout = i18n.csvLayout;
    }
    // Without explicit columns a per-language layout gets its own default; ["key", "en", "zh"] only fits one row per key.
    if (i18n.csvColumns !== undefined) config.i18n.csvColumns = csvColumnList(i18n.csvColumns);
    else if (config.i18n.csvLayout === 'perLanguage') config.i18n.csvColumns = [...perLanguageCsvColumns];
    if (i18n.csvStatus !== undefined) {
        if (!isRecord(i18n.csvStatus) || Object.keys(i18n.csvStatus).some(key => key !== 'missing' && key !== 'present')) throw invalid('i18n.csvStatus', 'object with "missing" and "present" texts');
        for (const key of ['missing', 'present'] as const) {
            const value = i18n.csvStatus[key];
            if (value === undefined) continue;
            if (typeof value !== 'string' || !value || value.length > 200) throw invalid('i18n.csvStatus.' + key, 'non-empty string');
            config.i18n.csvStatus[key] = value;
        }
    }
    if (raw.clients !== undefined) {
        const clients = stringList(raw.clients, 'clients', true);
        if (clients.some(item => !clientNames.includes(item as ClientName))) throw invalid('clients', 'array of ' + clientNames.map(name => '"' + name + '"').join(', '));
        config.clients = [...new Set(clients as ClientName[])];
    }
    return config;
}
/** Read and validate <project>/git-desk.config.json; a missing file means the defaults. */
export function loadConfig(projectRoot: string): GitDeskConfig {
    const file = path.join(projectRoot, configFileName);
    let text: string;
    try { text = readFileSync(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultConfig(); throw error; }
    let raw: unknown;
    try { raw = JSON.parse(text); }
    catch (error) { throw new MessageError('main.configInvalidJson', { file: configFileName, reason: error instanceof Error ? error.message : String(error) }); }
    return validateConfig(raw);
}
/** The Creator project uuid from package.json, or a stable hash of the project path when there is none. */
export function projectId(projectRoot: string): string {
    const root = realpathSync(projectRoot);
    try {
        const uuid = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { uuid?: unknown }).uuid;
        if (typeof uuid === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(uuid)) return uuid;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    return createHash('sha256').update(root).digest('hex').slice(0, 12);
}
/** ~/.cocos-git-desk/<projectId>: per-machine state, exports, browser profiles and configuration backups. */
export function dataDir(id: string, home = os.homedir()): string { return path.join(home, dataDirName, id); }
function expandHome(value: string, home: string): string { return value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value; }
/** Read <cacheDir>/agent-settings.json; debug.stateDir and debug.outputDir default under the data directory. */
export function loadLocalSettings(cacheDir: string, id: string, home = os.homedir()): LocalSettings {
    const base = dataDir(id, home);
    const settings: LocalSettings = { debug: { stateDir: path.join(base, 'state'), outputDir: path.join(base, 'exports') } };
    let text: string;
    try { text = readFileSync(path.join(cacheDir, settingsFileName), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return settings; throw error; }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new MessageError('main.settingsNotObject', { file: settingsFileName }); }
    if (!isRecord(raw)) throw new MessageError('main.settingsNotObject', { file: settingsFileName });
    if (raw.requireHumanReview !== undefined) {
        if (typeof raw.requireHumanReview !== 'boolean') throw new MessageError('main.configFieldInvalid', { file: settingsFileName, key: 'requireHumanReview', expected: 'boolean' });
        settings.requireHumanReview = raw.requireHumanReview;
    }
    if (raw.debug !== undefined) {
        if (!isRecord(raw.debug)) throw new MessageError('main.configFieldInvalid', { file: settingsFileName, key: 'debug', expected: 'object' });
        for (const key of ['stateDir', 'outputDir'] as const) {
            const value = raw.debug[key];
            if (value === undefined) continue;
            if (typeof value !== 'string' || !value || value.includes('\0')) throw new MessageError('main.configFieldInvalid', { file: settingsFileName, key: 'debug.' + key, expected: 'absolute directory path' });
            const expanded = expandHome(value, home);
            if (!path.isAbsolute(expanded)) throw new MessageError('main.configFieldInvalid', { file: settingsFileName, key: 'debug.' + key, expected: 'absolute directory path' });
            settings.debug[key] = path.normalize(expanded);
        }
    }
    return settings;
}
/** Which tool catalogues a configuration exposes: core and inspector always, bridge always (calls fail clearly
 *  without a page bridge), i18n only when a key pattern is configured. No configuration means every catalogue. */
export function enabledCatalogues(config?: GitDeskConfig): CatalogueName[] {
    return catalogueNames.filter(name => name !== 'i18n' || !config || !!config.i18n.keyPattern);
}
/** Merge the enabled static/mcp-tools.<name>.json catalogues in catalogue order; names must be unique. */
export function toolCatalogue(config?: GitDeskConfig, staticDir = path.resolve(__dirname, '../static')): ToolSchema[] {
    const tools: ToolSchema[] = [], seen = new Set<string>();
    for (const name of enabledCatalogues(config)) {
        const list = JSON.parse(readFileSync(path.join(staticDir, 'mcp-tools.' + name + '.json'), 'utf8')) as ToolSchema[];
        if (!Array.isArray(list)) throw new Error('tool catalogue is not an array: mcp-tools.' + name + '.json');
        for (const tool of list) {
            if (!tool || typeof tool.name !== 'string' || seen.has(tool.name)) throw new Error('duplicate or invalid tool in catalogue mcp-tools.' + name + '.json: ' + String(tool && tool.name));
            seen.add(tool.name); tools.push(tool);
        }
    }
    return tools;
}
/** Does an engine version such as "3.8.8" satisfy one of the configured patterns ("3.8.x", "3.8.8", "3.x")? */
export function matchesEngineVersion(version: string, patterns: readonly string[]): boolean {
    const actual = String(version).split('.');
    return patterns.some(pattern => { const parts = pattern.split('.'); return parts.length <= actual.length && parts.every((part, index) => part === 'x' || part === actual[index]); });
}
