// Message tables for everything the extension says to a person or to an AI client.
// Chinese entries are kept verbatim from the original code so behaviour and the existing tests
// (which run with GIT_DESK_LANG=zh) stay identical; English is the default outside a Chinese editor.
// Keys are `<domain>.<camelCase>`; placeholders are `{name}` and are filled from `params`.
export type Language = 'en' | 'zh';
export type Table = Readonly<Record<string, string>>;
export type Params = Readonly<Record<string, string | number | boolean | null | undefined>>;

const tables: Record<Language, Record<string, string>> = { en: {}, zh: {} };
let forced: Language | undefined;

/** Merge a domain table; the same key may only be registered twice with the same text. */
export function register(language: Language, entries: Table): void {
    const target = tables[language];
    for (const [key, value] of Object.entries(entries)) {
        if (key in target && target[key] !== value) throw new Error('duplicate i18n key: ' + key);
        target[key] = value;
    }
}

/** Force a language for this process (tests, or an explicit user preference); undefined restores detection. */
export function setLanguage(language: Language | undefined): void { forced = language; }

function normalize(value: unknown): Language | undefined {
    if (typeof value !== 'string') return undefined;
    const lower = value.toLowerCase();
    if (lower === 'zh' || lower.startsWith('zh-') || lower.startsWith('zh_')) return 'zh';
    if (lower === 'en' || lower.startsWith('en-') || lower.startsWith('en_')) return 'en';
    return undefined;
}

/** Forced language, then GIT_DESK_LANG, then the Creator editor language, then English. */
export function language(): Language {
    if (forced) return forced;
    const env = normalize(typeof process !== 'undefined' ? process.env?.GIT_DESK_LANG : undefined);
    if (env) return env;
    try {
        const editor = (globalThis as { Editor?: { I18n?: { getLanguage?: () => string } } }).Editor;
        const current = normalize(editor?.I18n?.getLanguage?.());
        if (current) return current;
    } catch { /* not inside Creator */ }
    return 'en';
}

/** Translate a message id; a missing id falls back to English, then Chinese, then the id itself. */
export function t(id: string, params?: Params): string {
    const text = tables[language()][id] ?? tables.en[id] ?? tables.zh[id];
    if (text === undefined) return id;
    return params ? text.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : text;
}

export function has(id: string): boolean { return id in tables.en || id in tables.zh; }

/** Ids registered in one language but not the other, for the i18n completeness test. */
export function missing(): { en: string[]; zh: string[] } {
    return { en: Object.keys(tables.zh).filter(key => !(key in tables.en)).sort(), zh: Object.keys(tables.en).filter(key => !(key in tables.zh)).sort() };
}

/** An error whose text is localized at construction and whose id survives for callers and tests. */
export class MessageError extends Error {
    constructor(readonly id: string, readonly params?: Params) { super(t(id, params)); this.name = 'MessageError'; }
}
