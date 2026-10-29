import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { MessageError } from './i18n';

export const revisionScope = 'cocos-git-desk-script-layout-v1';
export const defaultRevisionRoots = ['assets', 'extensions/*/assets'];
const suffixes = new Set(['.ts', '.prefab', '.scene', '.meta']);

export async function projectRoot(value: string): Promise<string> {
    if (!value) throw new MessageError('preview.projectPathEmpty');
    return fs.realpath(value);
}
// Expands the configured scan roots: a "*" segment matches every directory at that level, and roots
// that do not exist on disk are skipped (a project without extensions/*/assets is normal).
async function expandRoots(root: string, roots: readonly string[]): Promise<string[]> {
    const found = new Set<string>();
    async function expand(prefix: string, parts: string[]): Promise<void> {
        if (!parts.length) {
            try { if ((await fs.lstat(path.join(root, prefix))).isDirectory()) found.add(prefix); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            return;
        }
        const [head, ...rest] = parts;
        if (head !== '*') return expand(prefix ? prefix + '/' + head : head!, rest);
        let entries: import('fs').Dirent[];
        try { entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
        for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith('.')) await expand(prefix ? prefix + '/' + entry.name : entry.name, rest);
    }
    for (const item of roots) await expand('', item.split('/').filter(Boolean));
    return [...found].sort();
}

// Read-only fingerprint of the script and prefab layout on disk; compared against the page identity on request.
export async function sourceRevision(value: string, roots: readonly string[] = defaultRevisionRoots): Promise<Record<string, unknown>> {
    const root = await projectRoot(value);
    const files = ['package.json', 'tsconfig.json'];
    async function visit(directory: string): Promise<void> {
        for (const entry of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
            const item = directory + '/' + entry.name;
            if (entry.isSymbolicLink()) throw new MessageError('preview.revisionSymlink', { item });
            if (entry.isDirectory()) await visit(item);
            else if (entry.isFile() && suffixes.has(path.extname(entry.name))) files.push(item);
            if (files.length > 30000) throw new MessageError('preview.revisionTooManyFiles');
        }
    }
    const scanned = await expandRoots(root, roots);
    for (const directory of scanned) await visit(directory);
    const digest = createHash('sha256');
    let bytes = 0, hashed = 0;
    for (const item of files.sort()) {
        const full = path.resolve(root, item);
        let real: string;
        try { real = await fs.realpath(full); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && (item === 'package.json' || item === 'tsconfig.json')) continue; throw error; }
        if (path.relative(root, real).startsWith('..')) throw new MessageError('preview.revisionEscapes');
        const before = await fs.lstat(full);
        if (before.isSymbolicLink() || before.size > 32 * 1024 * 1024) throw new MessageError('preview.revisionUnsupportedFile', { item });
        bytes += before.size;
        if (bytes > 256 * 1024 * 1024) throw new MessageError('preview.revisionTooLarge');
        const content = await fs.readFile(full);
        const after = await fs.lstat(full);
        if (after.mtimeMs !== before.mtimeMs || after.size !== before.size || after.ino !== before.ino) throw new MessageError('preview.revisionChanged');
        digest.update(item + '\0' + createHash('sha256').update(content).digest('hex') + '\n'); hashed++;
    }
    return { scope: revisionScope, digest: digest.digest('hex'), fileCount: hashed, roots: scanned,
        exclusions: ['images/audio/fonts/binary assets', 'JSON content except package.json/tsconfig.json', 'runtime prefab instance versions'], atomicSnapshot: false };
}
