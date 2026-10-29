import { promises as fs } from 'fs';
import path from 'path';
import { ChangedFile } from './types';
import { t } from './i18n';

// Creator keeps one .meta next to every asset and directory under assets/. A commit that leaves an asset
// without its .meta, keeps a .meta for a removed asset, or repeats a uuid breaks the project for everyone
// who pulls it, so the index (or the working tree) is checked before such a commit is prepared.
export type MetaScope = 'index' | 'worktree';
export interface MetaCheckOptions { scope?: MetaScope; paths?: string[]; roots?: string[]; }
export type MetaIssueCode = 'META_MISSING' | 'META_DIR_MISSING' | 'META_ORPHAN' | 'META_ORPHAN_LEFT' | 'META_UNSTAGED' | 'ASSET_UNSTAGED' | 'META_INVALID' | 'META_UUID_DUPLICATE' | 'META_UUID_CHANGED';
export interface MetaIssue { code: MetaIssueCode; severity: 'blocker' | 'warning'; path: string; related?: string; message: string; }
export interface MetaCheckResult { scope: MetaScope; roots: string[]; checked: number; issues: MetaIssue[]; blockers: MetaIssue[]; warnings: MetaIssue[]; truncated: boolean; coverage: string; }
// Runs git inside the repository and returns stdout; exit codes outside `allowed` reject.
export type MetaGit = (args: string[], allowed?: number[]) => Promise<string>;

const STAGED = (file: ChangedFile) => file.index !== ' ' && file.index !== '?';
const CHANGE_LIMIT = 2000, CONTENT_LIMIT = 200, HIT_LIMIT = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidOf(text: string): string | null {
    try { const parsed = JSON.parse(text) as { uuid?: unknown }; return parsed && typeof parsed === 'object' && typeof parsed.uuid === 'string' && UUID.test(parsed.uuid) ? parsed.uuid.toLowerCase() : null; } catch { return null; }
}

export async function checkMeta(root: string, files: ChangedFile[], git: MetaGit, options: MetaCheckOptions = {}): Promise<MetaCheckResult> {
    const scope: MetaScope = options.scope === 'worktree' ? 'worktree' : 'index';
    const roots = (options.roots?.length ? options.roots : ['assets']).map(item => item.replace(/\/+$/, ''));
    const filters = (options.paths ?? []).map(item => item.replace(/\/+$/, '')).filter(Boolean);
    const under = (name: string) => roots.some(item => name === item || name.startsWith(item + '/'));
    const selected = (name: string) => !filters.length || filters.some(item => name === item || name.startsWith(item + '/'));
    const byPath = new Map(files.map(file => [file.path, file]));
    // Entries whose state in this scope is examined; a rename contributes its old name as a removal.
    const entries: { path: string; removed: boolean }[] = [];
    for (const file of files) {
        if (file.submodule || file.conflict) continue;
        if (scope === 'index' ? !STAGED(file) : file.index === ' ' && file.worktree === ' ') continue;
        if (file.oldPath && under(file.oldPath) && selected(file.oldPath)) entries.push({ path: file.oldPath, removed: true });
        if (!under(file.path) || !selected(file.path)) continue;
        entries.push({ path: file.path, removed: scope === 'index' ? file.index === 'D' : file.worktree === 'D' || (file.index === 'D' && file.worktree === ' ') });
    }
    const work = entries.slice(0, CHANGE_LIMIT);
    // Existence in the examined state: the index after staging, or the files on disk right now.
    let indexFiles: Set<string> | undefined, indexDirs: Set<string> | undefined;
    if (scope === 'index') {
        indexFiles = new Set(); indexDirs = new Set();
        for (const name of (await git(['ls-files', '-z', '--', ...roots])).split('\0')) {
            if (!name) continue;
            indexFiles.add(name);
            for (let dir = path.posix.dirname(name); dir && dir !== '.' && !indexDirs.has(dir); dir = path.posix.dirname(dir)) indexDirs.add(dir);
        }
    }
    const isFile = (name: string) => indexFiles ? Promise.resolve(indexFiles.has(name)) : fs.stat(path.join(root, name)).then(stat => stat.isFile(), () => false);
    const isDir = (name: string) => indexDirs ? Promise.resolve(indexDirs.has(name)) : fs.stat(path.join(root, name)).then(stat => stat.isDirectory(), () => false);
    const exists = async (name: string) => (await isFile(name)) || (await isDir(name));
    // Tracked companions whose working copy differs from the index, or untracked ones, are not part of the commit.
    const unstaged = (name: string) => { const file = byPath.get(name); return !!file && (file.index === '?' || file.worktree === 'M' || file.worktree === 'D'); };
    const ancestors = (name: string) => { const list: string[] = []; for (let dir = path.posix.dirname(name); dir && dir !== '.' && !roots.includes(dir); dir = path.posix.dirname(dir)) list.push(dir); return list; };
    const issues: MetaIssue[] = [], seen = new Set<string>();
    // A directory missing its .meta is reported once, whichever file under it was noticed first.
    const add = (issue: MetaIssue) => { const key = issue.code + ':' + issue.path + (issue.code === 'META_DIR_MISSING' ? '' : ':' + (issue.related ?? '')); if (!seen.has(key)) { seen.add(key); issues.push(issue); } };
    const blocker = (code: MetaIssueCode, name: string, message: string, related?: string) => add({ code, severity: 'blocker', path: name, message, ...(related ? { related } : {}) });
    const metas: string[] = [];
    for (const entry of work) {
        const name = entry.path, meta = name.endsWith('.meta'), base = meta ? name.slice(0, -5) : name;
        if (entry.removed) {
            if (meta) { if (await exists(base)) blocker('META_MISSING', base, t('creator.tools.metaDeleted'), name); }
            else if (await isFile(name + '.meta')) blocker('META_ORPHAN_LEFT', name + '.meta', t('creator.tools.metaLeftBehind'), name);
            continue;
        }
        for (const dir of ancestors(name)) if (!(await isFile(dir + '.meta'))) blocker('META_DIR_MISSING', dir + '.meta', t('creator.tools.metaDirMissing', { dir }), name);
        if (meta) {
            metas.push(name);
            if (!(await exists(base))) {
                if (scope === 'index' && unstaged(base)) blocker('ASSET_UNSTAGED', name, t('creator.tools.metaAssetUnstaged'), base);
                else blocker('META_ORPHAN', name, t('creator.tools.metaOrphan'), base);
            } else if (scope === 'index' && unstaged(base)) blocker('ASSET_UNSTAGED', name, t('creator.tools.metaAssetHasUnstaged'), base);
        } else if (!(await isFile(name + '.meta'))) {
            if (scope === 'index' && unstaged(name + '.meta')) blocker('META_UNSTAGED', name + '.meta', t('creator.tools.metaUnstaged'), name);
            else blocker('META_MISSING', name + '.meta', t('creator.tools.metaMissing'), name);
        } else if (scope === 'index' && unstaged(name + '.meta')) blocker('META_UNSTAGED', name + '.meta', t('creator.tools.metaHasUnstaged'), name);
    }
    const content = async (name: string, fromHead = false): Promise<string | null> => {
        try { return scope === 'index' || fromHead ? await git(['show', (fromHead ? 'HEAD:' : ':') + name]) : await fs.readFile(path.join(root, name), 'utf8'); } catch { return null; }
    };
    const examined = metas.slice(0, CONTENT_LIMIT), owners = new Map<string, string>();
    for (const name of examined) {
        const text = await content(name);
        if (text === null) continue;
        const uuid = uuidOf(text);
        if (!uuid) { blocker('META_INVALID', name, t('creator.tools.metaInvalid')); continue; }
        const owner = owners.get(uuid);
        if (owner && owner !== name) blocker('META_UUID_DUPLICATE', name, t('creator.tools.metaUuidDuplicate', { uuid }), owner); else owners.set(uuid, name);
        // Other tracked .meta files carrying the same uuid. A reference inside userData (an atlas uuid, for
        // example) also matches the search, so only a file whose own uuid is equal counts as a duplicate.
        const hits = (await git(['grep', ...(scope === 'index' ? ['--cached'] : []), '-l', '-F', '-e', uuid, '--', ...roots], [0, 1])).split('\n').map(line => line.trim()).filter(line => line.endsWith('.meta') && line !== name).slice(0, HIT_LIMIT);
        for (const other of hits) { const text2 = await content(other); if (text2 !== null && uuidOf(text2) === uuid) blocker('META_UUID_DUPLICATE', name, t('creator.tools.metaUuidDuplicate', { uuid }), other); }
        if (scope === 'index' && byPath.get(name)?.index === 'M') {
            const before = await content(name, true), old = before === null ? null : uuidOf(before);
            if (old && old !== uuid) add({ code: 'META_UUID_CHANGED', severity: 'warning', path: name, message: t('creator.tools.metaUuidChanged', { old, uuid }) });
        }
    }
    return { scope, roots, checked: work.length, issues, blockers: issues.filter(issue => issue.severity === 'blocker'), warnings: issues.filter(issue => issue.severity === 'warning'), truncated: entries.length > CHANGE_LIMIT || metas.length > CONTENT_LIMIT,
        coverage: scope === 'index' ? t('creator.tools.metaCoverageIndex') : t('creator.tools.metaCoverageDisk') };
}
