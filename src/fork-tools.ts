import { promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { ProjectUpdatePreview, previewProjectUpdate } from './project-update';
import type { RepositoryUpdate } from './types';
import { t, MessageError } from './i18n';

export type ForkToolAction = 'forkResetPreferred' | 'forkSmartGit' | 'forkResetDev';
export type ProjectGit = (cwd: string, args: string[], allowed?: number[]) => Promise<{ stdout: Buffer }>;
interface Target {
    id: string; path: string; branch: string; head: string; revision: string; state: string;
    local: boolean; remote?: string; clean: string[]; affected: string[];
}
export interface ForkToolPreview {
    action: ForkToolAction; root: string; branch: string; remote?: string;
    scope: ProjectUpdatePreview; targets: Target[]; skipped: { id: string; detail: string }[];
}
// Getters keep the names in the current editor language for every reader.
export const forkToolNames: Readonly<Record<ForkToolAction, string>> = Object.freeze({
    get forkResetPreferred() { return t('misc.fork.nameResetPreferred'); },
    get forkSmartGit() { return t('misc.fork.nameSmartGit'); },
    get forkResetDev() { return t('misc.fork.nameResetDev'); },
});
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const text = async (git: ProjectGit, cwd: string, args: string[], allowed?: number[]) => (await git(cwd, args, allowed)).stdout.toString('utf8').trim();
const list = (value: Buffer) => { const decoded = value.toString('utf8'); if (!Buffer.from(decoded, 'utf8').equals(value)) throw new MessageError('misc.fork.pathNotUtf8'); return decoded.split('\0').filter(Boolean); };
const overlaps = (a: string, b: string) => { a = a.replace(/\/$/, ''); b = b.replace(/\/$/, ''); return a === b || a.startsWith(b + '/') || b.startsWith(a + '/'); };

async function state(git: ProjectGit, cwd: string): Promise<string> {
    const digest = createHash('sha256');
    for (const args of [
        ['rev-parse', 'HEAD'], ['symbolic-ref', '--quiet', '--short', 'HEAD'],
        ['ls-files', '--stage', '-z'], ['ls-files', '-v', '-z'],
        ['config', '--null', '--list', '--show-origin'], ['worktree', 'list', '--porcelain', '-z'],
        ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/stash'],
        ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'],
        ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
    ]) { const value = (await git(cwd, args, [0, 1])).stdout; digest.update(String(value.length)); digest.update(value); }
    return digest.digest('hex');
}

async function checkRepository(git: ProjectGit, cwd: string, branch: string): Promise<void> {
    if (await text(git, cwd, ['rev-parse', '--is-inside-work-tree']) !== 'true') throw new MessageError('misc.fork.bareUnsupported');
    if ((await git(cwd, ['ls-files', '-u', '-z'])).stdout.length) throw new MessageError('misc.fork.unresolvedConflicts');
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG', 'info/grafts']) {
        const location = await text(git, cwd, ['rev-parse', '--git-path', marker]);
        try { await fs.lstat(path.resolve(cwd, location)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        throw new MessageError('misc.fork.operationInProgress', { marker });
    }
    if ((await git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/replace'])).stdout.length) throw new MessageError('misc.fork.replaceRefs');
    const flags = list((await git(cwd, ['ls-files', '-v', '-z'])).stdout);
    if (flags.some(row => /^[a-zS] /u.test(row))) throw new MessageError('misc.fork.sparseFlags');
    const sparse = await text(git, cwd, ['config', '--bool', 'core.sparseCheckout'], [0, 1]);
    if (sparse === 'true') throw new MessageError('misc.fork.sparseUnsupported');
    const common = await fs.realpath(path.resolve(cwd, await text(git, cwd, ['rev-parse', '--git-common-dir'])));
    const gitDir = await fs.realpath(await text(git, cwd, ['rev-parse', '--absolute-git-dir']));
    const records = list((await git(cwd, ['worktree', 'list', '--porcelain', '-z'])).stdout);
    let location = '';
    for (const record of records) {
        if (record.startsWith('worktree ')) location = record.slice(9);
        if (record === 'branch refs/heads/' + branch && path.resolve(location) !== cwd && !(path.resolve(location) === common && gitDir === common)) throw new MessageError('misc.fork.branchInOtherWorktree');
    }
}

async function checkPaths(git: ProjectGit, target: Target, action: ForkToolAction): Promise<void> {
    const currentLayout = (await git(target.path, ['show', 'HEAD:.gitmodules'], [0, 128])).stdout;
    const nextLayout = (await git(target.path, ['show', target.revision + ':.gitmodules'], [0, 128])).stdout;
    if (hash(currentLayout) !== hash(nextLayout)) throw new MessageError('misc.fork.gitmodulesChanged');
    const gitlinkPaths = async (revision: string) => list((await git(target.path, ['ls-tree', '-r', '-z', revision])).stdout)
        .filter(row => row.startsWith('160000 ')).map(row => row.slice(row.indexOf('\t') + 1));
    if (JSON.stringify(await gitlinkPaths('HEAD')) !== JSON.stringify(await gitlinkPaths(target.revision))) throw new MessageError('misc.fork.submoduleLayoutChanged');
    const tree = list((await git(target.path, ['ls-tree', '-r', '--name-only', '-z', target.revision])).stdout);
    const untracked = list((await git(target.path, ['ls-files', '--others', '--exclude-standard', '--directory', '-z'])).stdout);
    const ignored = list((await git(target.path, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])).stdout);
    const protectedPaths = [...ignored];
    async function hasNestedRepository(folder: string): Promise<boolean> {
        let visited = 0;
        async function visit(directory: string): Promise<boolean> {
            if (++visited > 10000) throw new MessageError('misc.fork.untrackedTooLarge');
            const entries = await fs.readdir(directory, { withFileTypes: true });
            if (entries.some(entry => entry.name === '.git')) return true;
            for (const entry of entries) if (entry.isDirectory() && await visit(path.join(directory, entry.name))) return true;
            return false;
        }
        return visit(folder);
    }
    for (const name of untracked) {
        if (action !== 'forkResetDev') { protectedPaths.push(name); continue; }
        if (name.endsWith('/')) {
            const folder = path.resolve(target.path, name);
            const root = await text(git, folder, ['rev-parse', '--show-toplevel'], [0, 128]);
            if ((root && path.resolve(root) === folder) || (tree.some(file => overlaps(name, file)) && await hasNestedRepository(folder))) protectedPaths.push(name);
        }
    }
    if (protectedPaths.some(name => tree.some(file => overlaps(name, file)))) throw new MessageError('misc.fork.wouldOverwrite');
    // reset --hard can remove an untracked directory that blocks a tracked file.
    const checkedParents = new Set<string>();
    for (const file of tree) {
        let parent = path.dirname(path.resolve(target.path, file));
        while (parent !== target.path) {
            if (checkedParents.has(parent)) break; checkedParents.add(parent);
            try { if ((await fs.lstat(parent)).isSymbolicLink()) throw new MessageError('misc.fork.pathThroughSymlink', { file }); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            const next = path.dirname(parent); if (next === parent) throw new MessageError('misc.fork.pathOutsideRepo'); parent = next;
        }
    }
    const changes: string[] = [];
    for (const args of [
        ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', 'HEAD', target.revision],
        ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', 'HEAD'],
        ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', 'HEAD'],
    ]) changes.push(...list((await git(target.path, args)).stdout));
    target.affected = [...new Set(changes)];
    target.clean = action === 'forkResetDev' ? untracked.filter(name => !protectedPaths.includes(name)) : [];
}

export async function previewForkTool(root: string, cache: string, action: ForkToolAction, options: { branch: string; remote?: string }, git: ProjectGit): Promise<ForkToolPreview> {
    if (!options.branch || options.branch.startsWith('-') || options.branch.length > 250) throw new MessageError('misc.fork.chooseBranch');
    await git(root, ['check-ref-format', '--branch', options.branch]);
    if (options.remote && (options.remote.startsWith('-') || /[\s\0]/u.test(options.remote))) throw new MessageError('misc.fork.invalidRemote');
    const scope = await previewProjectUpdate(root, cache), targets: Target[] = [], skipped: ForkToolPreview['skipped'] = [];
    for (const entry of scope.entries) {
        if (entry.detail || !entry.state) { skipped.push({ id: entry.id, detail: entry.detail || t('misc.fork.repoUnreadable') }); continue; }
        const cwd = path.resolve(root, entry.id);
        if (path.relative(root, cwd).split(path.sep).includes('..') || await fs.realpath(cwd) !== cwd) throw new MessageError('misc.fork.invalidSubmodulePath');
        try { await checkRepository(git, cwd, options.branch); }
        catch (error) { throw new MessageError('misc.fork.repoError', { id: entry.id, message: (error instanceof Error ? error.message : String(error)) }); }
        if (action === 'forkSmartGit' && list((await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'])).stdout).some(row => !row.startsWith('?? '))) throw new MessageError('misc.fork.localChanges', { id: entry.id });
        const localRef = 'refs/heads/' + options.branch;
        const localTip = await text(git, cwd, ['rev-parse', '--verify', '--quiet', localRef + '^{commit}'], [0, 1]);
        let remote: string | undefined, revision = localTip;
        if (action !== 'forkSmartGit' || !localTip) {
            const remotes = (await text(git, cwd, ['remote'])).split('\n').filter(Boolean);
            remote = options.remote || (remotes.length === 1 ? remotes[0] : undefined);
            if (!remote || !remotes.includes(remote)) throw new MessageError('misc.fork.chooseRemote', { id: entry.id });
            revision = await text(git, cwd, ['rev-parse', '--verify', '--quiet', 'refs/remotes/' + remote + '/' + options.branch + '^{commit}'], [0, 1]);
            if (!revision) throw new MessageError('misc.fork.remoteCacheMissing', { id: entry.id });
        }
        const target: Target = { id: entry.id, path: cwd, branch: options.branch, head: await text(git, cwd, ['rev-parse', 'HEAD']), revision, remote, local: !!localTip, state: await state(git, cwd), clean: [], affected: [] };
        await checkPaths(git, target, action); targets.push(target);
    }
    if (!targets.length) throw new MessageError('misc.fork.noRepositories');
    if (JSON.stringify(scope) !== JSON.stringify(await previewProjectUpdate(root, cache))) throw new MessageError('misc.fork.projectChangedWhileReading');
    return { action, root, branch: options.branch, remote: options.remote, scope, targets, skipped };
}

export async function executeForkTool(preview: ForkToolPreview, cache: string, log: (text: string) => void, git: ProjectGit, progress: (row: RepositoryUpdate) => void): Promise<void> {
    if (JSON.stringify(preview.scope) !== JSON.stringify(await previewProjectUpdate(preview.root, cache))) throw new MessageError('misc.fork.stateChanged');
    const assertContentUnchanged = async (target: Target) => {
        const expected = preview.scope.entries.find(entry => entry.id === target.id)?.state;
        const current = await previewProjectUpdate(target.path, cache);
        if (!expected || current.entries[0]?.state !== expected) throw new MessageError('misc.fork.contentChanged', { id: target.id });
    };
    for (const target of preview.targets) {
        await assertContentUnchanged(target);
        await checkRepository(git, target.path, target.branch);
        if (await state(git, target.path) !== target.state) throw new MessageError('misc.fork.localStateChanged', { id: target.id });
        await checkPaths(git, target, preview.action);
        if (target.remote) {
            log(t('misc.fork.fetchAndCheck', { id: target.id, remote: target.remote, branch: target.branch }));
            await git(target.path, ['fetch', '--no-tags', '--recurse-submodules=no', '--', target.remote, 'refs/heads/' + target.branch + ':refs/remotes/' + target.remote + '/' + target.branch]);
            const actual = await text(git, target.path, ['rev-parse', '--verify', 'refs/remotes/' + target.remote + '/' + target.branch + '^{commit}']);
            if (actual !== target.revision) throw new MessageError('misc.fork.remoteTargetChanged', { id: target.id });
        }
    }
    for (const target of preview.targets) {
        try {
            await assertContentUnchanged(target);
            await checkRepository(git, target.path, target.branch);
            if (await state(git, target.path) !== target.state) throw new MessageError('misc.fork.localChanged');
            await checkPaths(git, target, preview.action);
            progress({ id: target.id, status: 'running', phase: t('misc.fork.phaseRunning'), phaseId: 'running', branch: target.branch, detail: '' });
            const prefix = ['-c', 'submodule.recurse=false'];
            if (preview.action === 'forkSmartGit') {
                await git(target.path, [...prefix, 'checkout', '--no-overwrite-ignore', ...(target.local ? [target.branch] : ['--no-track', '-b', target.branch, target.revision])]);
            } else {
                if (preview.action === 'forkResetDev') await git(target.path, [...prefix, 'clean', '-fd']);
                await git(target.path, [...prefix, 'checkout', '--force', '--no-overwrite-ignore', '-B', target.branch, target.revision]);
                await git(target.path, [...prefix, 'reset', '--hard', target.revision]);
            }
            const head = await text(git, target.path, ['rev-parse', 'HEAD']);
            const branch = await text(git, target.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
            if (head !== target.revision || branch !== target.branch) throw new MessageError('misc.fork.writeMismatch');
            progress({ id: target.id, status: 'success', phase: t('misc.update.phase.done'), phaseId: 'done', branch, head, detail: forkToolNames[preview.action] });
        } catch (error) {
            progress({ id: target.id, status: 'failed', phase: t('misc.update.phase.unfinished'), phaseId: 'unfinished', branch: target.branch, detail: error instanceof Error ? error.message : String(error) });
            throw error;
        }
    }
}
