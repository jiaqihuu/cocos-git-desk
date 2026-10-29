import { promises as fs } from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { GitDesk } from './git';
import { Task } from './types';
import { t, MessageError } from './i18n';

export interface WorkspaceContext { id: string; root: string; common: string; baseRepo: string; createdByTool: boolean; createdAt: string; }
export interface WorktreeEntry { path: string; head: string; branch: string; locked: boolean; prunable: boolean; }
interface WorktreePlan { token: string; digest: string; expiresAt: number; mode: 'create' | 'remove'; baseRepo: string; root: string; common: string; path: string; branch?: string; revision?: string; context?: string; state: string; warnings: string[]; }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function parseWorktrees(raw: string): WorktreeEntry[] {
    const result: WorktreeEntry[] = []; let row: WorktreeEntry | undefined;
    for (const value of raw.split('\0')) {
        if (value.startsWith('worktree ')) { row = { path: value.slice(9), head: '', branch: '', locked: false, prunable: false }; result.push(row); }
        else if (row && value.startsWith('HEAD ')) row.head = value.slice(5);
        else if (row && value.startsWith('branch ')) row.branch = value.slice(7);
        else if (row && value.startsWith('locked')) row.locked = true;
        else if (row && value.startsWith('prunable')) row.prunable = true;
    }
    return result;
}
export class WorktreeRegistry {
    private plans = new Map<string, WorktreePlan>();
    task: Task | null = null;
    readonly ready: Promise<void>;
    private persistence: Promise<void> = Promise.resolve();
    private records: WorkspaceContext[] = [];
    constructor(private readonly source: GitDesk, private readonly cache: string, private readonly busy: () => boolean) { this.ready = this.restoreTask(); }
    private async restoreTask(): Promise<void> {
        try {
            const file = path.join(this.cache, 'worktree-task.json'), stat = await fs.lstat(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) throw new MessageError('agent.worktreeTaskRecordInvalid');
            const saved = JSON.parse(await fs.readFile(file, 'utf8'));
            if (saved.project !== this.source.project || !saved.task || typeof saved.task.id !== 'string' || typeof saved.task.log !== 'string' || !['running','success','failed'].includes(saved.task.status)) throw new MessageError('agent.worktreeTaskRecordCorrupt');
            this.task = saved.task;
            if (this.task!.status === 'running') { this.task!.status = 'failed'; this.task!.finishedAt = new Date().toISOString(); this.task!.log += t('agent.worktreeInterruptedLog'); await this.persistTask(); }
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    private persistTask(): Promise<void> {
        const snapshot = this.task && { ...this.task, log: this.task.log.slice(-16000) };
        this.persistence = this.persistence.then(async () => { await fs.mkdir(this.cache, { recursive: true, mode: 0o700 }); const file = path.join(this.cache, 'worktree-task.json'), temp = file + '.' + randomUUID(); await fs.writeFile(temp, JSON.stringify({ project: this.source.project, task: snapshot }), { mode: 0o600, flag: 'wx' }); await fs.rename(temp, file); });
        return this.persistence;
    }
    private get filename(): string { return path.join(this.cache, 'contexts.json'); }
    private async load(): Promise<void> {
        try {
            const stat = await fs.lstat(this.filename); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new MessageError('agent.contextRecordInvalid');
            const saved = JSON.parse(await fs.readFile(this.filename, 'utf8'));
            if (saved.schema !== 1 || saved.project !== this.source.project || !Array.isArray(saved.contexts) || saved.contexts.length > 16) throw new MessageError('agent.contextRecordForeign');
            const seen = new Set<string>();
            for (const item of saved.contexts) {
                if (!item || !/^[a-f0-9-]{36}$/.test(item.id) || seen.has(item.id) || !path.isAbsolute(item.root) || !path.isAbsolute(item.common) || typeof item.baseRepo !== 'string' || typeof item.createdByTool !== 'boolean' || typeof item.createdAt !== 'string') throw new MessageError('agent.contextRecordBad');
                seen.add(item.id);
            }
            this.records = saved.contexts;
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; this.records = []; }
    }
    private async save(): Promise<void> {
        const records = this.records.map(item => ({ ...item }));
        await fs.mkdir(this.cache, { recursive: true, mode: 0o700 });
        const temp = this.filename + '.' + randomUUID();
        await fs.writeFile(temp, JSON.stringify({ schema: 1, project: this.source.project, contexts: records }), { mode: 0o600, flag: 'wx' });
        await fs.rename(temp, this.filename);
    }
    private async sourceInfo(baseRepo: string) {
        const repo = (await this.source.snapshot(true)).repositories.find(r => r.id === baseRepo && r.initialized && !r.error);
        if (!repo) throw new MessageError('agent.sourceRepoNotInProject');
        const identity = await this.source.workspaceIdentity(repo.path);
        return { repo, ...identity };
    }
    async available(baseRepo = '.'): Promise<WorktreeEntry[]> {
        const source = await this.sourceInfo(baseRepo);
        const entries = parseWorktrees((await this.source.workspaceCommand(source.root, ['worktree', 'list', '--porcelain', '-z'])).stdout.toString('utf8'));
        // Git prints forward slashes (D:/work/x on Windows); compare in the platform's real-path form like every other root.
        for (const entry of entries) entry.path = await fs.realpath(entry.path).catch(() => path.resolve(entry.path));
        // Git reports the primary submodule worktree as its common directory.
        for (const entry of entries) if (entry.path === source.common && source.gitDir === source.common) entry.path = source.root;
        return entries;
    }
    async list(): Promise<(WorkspaceContext & { available: boolean; error?: string })[]> {
        await this.load(); const result = [];
        for (const item of this.records) { try { await this.validate(item); result.push({ ...item, available: true }); } catch (e) { result.push({ ...item, available: false, error: e instanceof Error ? e.message : String(e) }); } }
        return result;
    }
    private async validate(item: WorkspaceContext): Promise<void> {
        const source = await this.sourceInfo(item.baseRepo);
        if (source.common !== item.common) throw new MessageError('agent.sourceRepoIdentityChanged');
        const actual = await this.source.workspaceIdentity(item.root);
        const entry = (await this.available(item.baseRepo)).find(r => r.path === item.root);
        if (actual.root !== item.root || actual.common !== item.common || !entry || entry.prunable) throw new MessageError('agent.pathNoLongerWorktree');
    }
    async get(id: string): Promise<WorkspaceContext> {
        await this.load(); const item = this.records.find(r => r.id === id);
        if (!item) throw new MessageError('agent.unknownContextNoFallback');
        await this.validate(item); return { ...item };
    }
    async register(directory: string, baseRepo = '.', createdByTool = false): Promise<WorkspaceContext> {
        if (this.busy()) throw new MessageError('agent.waitForGitOperation');
        if (!path.isAbsolute(directory) || directory.includes('\0')) throw new MessageError('agent.worktreeAbsolutePath');
        const canonical = await fs.realpath(directory);
        if (canonical !== path.resolve(directory)) throw new MessageError('agent.useRealPath');
        const source = await this.sourceInfo(baseRepo), actual = await this.source.workspaceIdentity(canonical);
        if (canonical === source.root || actual.root !== canonical || actual.common !== source.common) throw new MessageError('agent.registerOnlyExtraWorktree');
        const existing = (await this.available(baseRepo)).find(row => row.path === canonical);
        if (!existing || existing.prunable) throw new MessageError('agent.pathNotInWorktreeList');
        await this.load(); const known = this.records.find(r => r.root === canonical);
        if (known) { await this.validate(known); return { ...known }; }
        if (this.records.length >= 16) throw new MessageError('agent.contextLimitForget');
        const item = { id: randomUUID(), root: canonical, common: source.common, baseRepo, createdByTool, createdAt: new Date().toISOString() };
        this.records.push(item); await this.save(); return item;
    }
    async forget(id: string): Promise<void> {
        if (this.busy()) throw new MessageError('agent.waitForGitOperation');
        await this.load(); if (!this.records.some(r => r.id === id)) throw new MessageError('agent.unknownContext');
        this.records = this.records.filter(r => r.id !== id); await this.save();
    }
    private async state(baseRepo: string, destination: string, mode: 'create' | 'remove'): Promise<string> {
        const source = await this.sourceInfo(baseRepo);
        if (source.repo.operation) throw new MessageError('agent.finishSourceOperation');
        if ((await this.source.workspaceCommand(source.root, ['for-each-ref', '--format=%(refname)', 'refs/replace'])).stdout.length) throw new MessageError('agent.replaceRefsUnsupported');
        try { await fs.lstat(path.join(source.common, 'info/grafts')); throw new MessageError('agent.handleGraftsFirst'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        const refs = (await this.source.workspaceCommand(source.root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'])).stdout.toString('utf8');
        const config = (await this.source.workspaceCommand(source.root, ['config', '--null', '--list', '--show-origin'])).stdout.toString('utf8');
        const worktrees = await this.available(baseRepo);
        const parent = await fs.realpath(path.dirname(destination));
        if (parent !== path.dirname(destination)) throw new MessageError('agent.parentRealPath');
        const stat = await fs.stat(parent);
        if (mode === 'create') {
            if (destination.startsWith(source.root + path.sep) || destination.startsWith(path.resolve(this.source.project) + path.sep) || destination.startsWith(source.common + path.sep)) throw new MessageError('agent.isolatedDirLocation');
            try { await fs.lstat(destination); throw new MessageError('agent.targetExists'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        } else {
            const record = worktrees.find(w => w.path === destination);
            if (!record || record.locked || record.prunable) throw new MessageError('agent.worktreeNotRemovable');
            for (const args of [['status', '--porcelain=v1', '-z', '--untracked-files=all'], ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']]) if ((await this.source.workspaceCommand(destination, args)).stdout.length) throw new MessageError('agent.worktreeDirty');
            const rows = (await this.source.workspaceCommand(destination, ['ls-files', '--stage', '-z'])).stdout.toString('utf8').split('\0');
            for (const row of rows.filter(row => row.startsWith('160000 '))) {
                const name = row.slice(row.indexOf('\t') + 1), folder = path.resolve(destination, name);
                if (!folder.startsWith(destination + path.sep)) throw new MessageError('agent.submodulePathEscapes');
                const stat = await fs.lstat(folder).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
                if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.readdir(folder)).length)) throw new MessageError('agent.submoduleDirNotEmpty', { name });
            }
        }
        return digest({ root: source.root, common: source.common, head: source.repo.head, operation: source.repo.operation, refs, config, worktrees, parent: [parent, stat.dev, stat.ino] });
    }
    async prepare(input: { mode: 'create' | 'remove'; baseRepo?: string; path?: string; branch?: string; revision?: string; context?: string }): Promise<WorktreePlan> {
        if (this.busy()) throw new MessageError('agent.gitOperationExists');
        const mode = input.mode; if (mode !== 'create' && mode !== 'remove') throw new MessageError('agent.modeCreateOrRemove');
        let baseRepo = input.baseRepo || '.', destination = input.path, branch = input.branch, revision = input.revision;
        if (mode === 'remove') {
            const item = await this.get(input.context || ''); if (!item.createdByTool) throw new MessageError('agent.removeOnlyOwnWorktree');
            baseRepo = item.baseRepo; destination = item.root;
        }
        if (!destination || !path.isAbsolute(destination) || destination.includes('\0')) throw new MessageError('agent.targetAbsolutePath');
        destination = path.resolve(destination);
        const source = await this.sourceInfo(baseRepo);
        if (mode === 'create') {
            await this.load(); if (this.records.length >= 16) throw new MessageError('agent.contextLimit');
            if (!branch || branch.startsWith('-') || !revision || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) throw new MessageError('agent.createNeedsBranchAndSha');
            await this.source.workspaceCommand(source.root, ['check-ref-format', '--branch', branch]);
            const branches = (await this.source.workspaceCommand(source.root, ['for-each-ref', '--format=%(refname)', 'refs/heads'])).stdout.toString('utf8').split('\n');
            if (branches.includes('refs/heads/' + branch)) throw new MessageError('agent.newBranchExists');
            const resolved = (await this.source.workspaceCommand(source.root, ['rev-parse', '--verify', revision + '^{commit}'])).stdout.toString('utf8').trim();
            if (resolved !== revision) throw new MessageError('agent.targetNotSelectedCommit');
        }
        const state = await this.state(baseRepo, destination, mode);
        const body = { mode, baseRepo, root: source.root, common: source.common, path: destination, branch, revision, context: input.context, state,
            warnings: mode === 'create' ? [t('agent.worktreeCreateWarning1'), t('agent.worktreeCreateWarning2')] : [t('agent.worktreeRemoveWarning')] };
        for (const [id, plan] of this.plans) if (plan.expiresAt <= Date.now()) this.plans.delete(id);
        if (this.plans.size >= 16) throw new MessageError('agent.tooManyWorktreePlans');
        const plan: WorktreePlan = { ...body, token: randomUUID(), expiresAt: Date.now() + 120000, digest: digest(body) };
        this.plans.set(plan.token, plan); return { ...plan, warnings: [...plan.warnings] };
    }
    execute(token: string, expectedDigest: string): Task {
        if (this.busy()) throw new MessageError('agent.gitOperationExists');
        const plan = this.plans.get(token);
        if (!plan || plan.digest !== expectedDigest || plan.expiresAt < Date.now()) throw new MessageError('agent.worktreePlanExpired');
        this.plans.delete(token);
        this.task = { id: randomUUID(), title: plan.mode === 'create' ? t('agent.createIsolatedWorkspace') : t('agent.removeIsolatedWorkspace'), status: 'running', log: plan.path + '\n', startedAt: new Date().toISOString(), workspace: { id: plan.context || 'worktree-lifecycle', root: plan.path, isolated: true } };
        void this.persistTask().then(() => this.run(plan)).then(context => { this.task!.status = 'success'; this.task!.log += context ? t('agent.contextCreatedLog', { id: context.id }) : t('agent.worktreeRemovedLog'); }, error => { this.task!.status = 'failed'; this.task!.log += t('agent.worktreeFailedLog', { error: error instanceof Error ? error.message : String(error) }); }).finally(() => { this.task!.finishedAt = new Date().toISOString(); void this.persistTask().catch(error => console.error(t('agent.worktreeResultSaveFailed'), error)); });
        return { ...this.task };
    }
    private async run(plan: WorktreePlan): Promise<WorkspaceContext | undefined> {
        if (await this.state(plan.baseRepo, plan.path, plan.mode) !== plan.state) throw new MessageError('agent.worktreeStateChanged');
        if (plan.mode === 'create') {
            await this.source.workspaceCommand(plan.root, ['-c', 'submodule.recurse=false', 'worktree', 'add', '--no-track', '-b', plan.branch!, '--', plan.path, plan.revision!]);
            // The task itself holds the write lease; register after the Git command without acquiring it again.
            const identity = await this.source.workspaceIdentity(plan.path);
            if (identity.common !== plan.common || identity.root !== plan.path || identity.head !== plan.revision || identity.branch !== plan.branch) throw new MessageError('agent.createdWorktreeMismatch');
            await this.load(); if (this.records.length >= 16) throw new MessageError('agent.contextsFullAfterCreate');
            const item = { id: randomUUID(), root: plan.path, common: plan.common, baseRepo: plan.baseRepo, createdByTool: true, createdAt: new Date().toISOString() };
            this.records.push(item); await this.save(); return item;
        }
        const item = await this.get(plan.context!); if (!item.createdByTool || item.root !== plan.path) throw new MessageError('agent.worktreeOwnershipChanged');
        await this.source.workspaceCommand(plan.root, ['worktree', 'remove', '--', plan.path]);
        await this.load(); this.records = this.records.filter(r => r.id !== item.id); await this.save();
    }
}
