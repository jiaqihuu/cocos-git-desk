import { promises as fs } from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { ChangedFile } from './types';
import { t, MessageError } from './i18n';

export interface TaskFile extends ChangedFile { fingerprint: string; workingFingerprint?: string; workingObject?: string; workingMode?: string; indexObject?: string; indexMode?: string; }
export interface TaskState { repo: string; head: string; branch: string; version: string; operation?: string; files: TaskFile[]; }
interface HumanApproval { id: string; at: string; head: string; branch: string; files: Record<string, TaskFile>; }
type TaskSummary = Pick<Session, 'id' | 'title' | 'createdAt' | 'paths'> & { head: string; branch: string; headChanged?: boolean; canContinue?: boolean; };
interface Session { schema: 1; id: string; root: string; repo: string; title: string; createdAt: string; paths: string[]; baseline: TaskState; approvals?: HumanApproval[];
    continuation?: { head: string; branch: string };
    extensions?: { at: string; head: string; paths: string[]; files: TaskFile[] }[];
    commits?: { at: string; from: string; head: string; branch: string; paths: string[] }[];
}
export interface ScopeQuery { mode: 'start' | 'list' | 'changes' | 'check'; id?: string; title?: string; paths?: string[]; includePointers?: boolean; candidatePaths?: string[]; }
export interface ScopeReview {
    id: string; repo: string; snapshotVersion: string; headChanged: boolean; canProceed: boolean; humanReviewRequired: boolean; reviewPolicySource: 'project' | 'workspace' | 'default'; canContinue: boolean;
    files: (TaskFile & { classification: 'preExisting' | 'mixed' | 'observedSinceStart'; inScope: boolean; humanReviewed: boolean })[];
    resolvedPaths: string[]; candidatePaths: string[]; blockers: { code: string; path?: string; message: string }[];
    ownership: 'observed changes are not proof of authorship';
}
export function taskPath(value: unknown): string {
    if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || value.includes('\\') || value.startsWith('/') || value.startsWith('-') || value.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git') || /^[A-Za-z]:/.test(value)) throw new MessageError('agent.scopePathsRelative');
    return value;
}
const staged = (file: ChangedFile) => file.index !== ' ' && file.index !== '?';
export class TaskScopeStore {
    constructor(private readonly cache: string, private readonly root: string, private readonly settingsCache = cache,
        private readonly unchangedHeadPaths?: (repo: string, from: string, to: string, paths: string[]) => Promise<boolean>) {}
    async reviewPolicy(): Promise<{ required: boolean; source: ScopeReview['reviewPolicySource'] }> {
        for (const [directory, source] of [[this.cache, this.cache === this.settingsCache ? 'project' : 'workspace'], ...(this.cache === this.settingsCache ? [] : [[this.settingsCache, 'project']])] as [string, 'project' | 'workspace'][]) {
            let content: string;
            try { content = await fs.readFile(path.join(directory, 'agent-settings.json'), 'utf8'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
            const settings: unknown = JSON.parse(content);
            if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new MessageError('agent.taskSettingsObject');
            const required = (settings as { requireHumanReview?: unknown }).requireHumanReview;
            if (required !== undefined && typeof required !== 'boolean') throw new MessageError('agent.requireHumanReviewBoolean');
            if (required !== undefined) return { required, source };
        }
        return { required: true, source: 'default' };
    }
    private async canContinue(item: Session, state: Pick<TaskState, 'repo' | 'head' | 'branch'>): Promise<boolean> {
        const anchor = item.continuation || item.baseline;
        if (item.repo !== state.repo || item.baseline.branch !== state.branch || anchor.branch !== state.branch) return false;
        if (anchor.head === state.head) return true;
        const paths = [...new Set([...item.paths, ...(item.approvals || []).flatMap(a => Object.keys(a.files))])];
        return !!this.unchangedHeadPaths && await this.unchangedHeadPaths(state.repo, anchor.head, state.head, paths);
    }
    async paths(id: string): Promise<string[]> { return [...(await this.read(id)).paths]; }
    async extend(state: TaskState, id: string, names: unknown) {
        const item = await this.read(id);
        if (!Array.isArray(names) || !names.length || names.length > 500) throw new MessageError('agent.extendPathsRange');
        const added = [...new Set(names.map(taskPath))].filter(name => !item.paths.includes(name));
        if (!await this.canContinue(item, state)) throw new MessageError('agent.cannotExtendOldTask');
        if (item.paths.length + added.length > 500 || (item.extensions?.length || 0) >= 64) throw new MessageError('agent.scopeOrExtensionsTooLarge');
        if (added.length) {
            item.extensions = [...(item.extensions || []), { at: new Date().toISOString(), head: state.head, paths: added,
                files: state.files.filter(file => added.includes(file.path) || !!file.oldPath && added.includes(file.oldPath)) }];
            item.paths = [...item.paths, ...added];
            item.continuation = { head: state.head, branch: state.branch };
            await this.write(item);
        }
        return { id: item.id, paths: item.paths, added, baselinePreserved: true };
    }
    async recordCommit(id: string, repo: string, from: string, head: string, branch: string, paths: string[]) {
        const item = await this.read(id);
        if (!await this.canContinue(item, { repo, head: from, branch }) || (item.commits?.length || 0) >= 128) throw new MessageError('agent.commitDoneContinuationUnconfirmed');
        item.commits = [...(item.commits || []), { at: new Date().toISOString(), from, head, branch, paths: paths.map(taskPath) }];
        item.continuation = { head, branch };
        await this.write(item);
    }
    private get directory(): string { return path.join(this.cache, 'agent-tasks'); }
    private archiveDirectory(kind: 'expired' | 'completed'): string { return path.join(this.cache, 'agent-task-archives', kind); }
    // Archives keep the original baseline; an existing target stops the move so history is never overwritten.
    private async archive(id: string, kind: 'expired' | 'completed'): Promise<void> {
        const directory = this.archiveDirectory(kind), filename = id + '.json';
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.link(path.join(this.directory, filename), path.join(directory, filename));
        await fs.unlink(path.join(this.directory, filename));
    }
    async list(repo: string, current?: Pick<TaskState, 'head' | 'branch'>): Promise<TaskSummary[]> {
        let names: string[];
        try { names = await fs.readdir(this.directory); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
        const results = [];
        for (const name of names) {
            if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw new MessageError('agent.taskDirUnknownRecord');
            const item = await this.read(name.slice(0, -5));
            if (item.repo === repo) results.push({ id: item.id, title: item.title, createdAt: item.createdAt, paths: item.paths, head: item.baseline.head, branch: item.baseline.branch,
                headChanged: current ? item.baseline.head !== current.head || item.baseline.branch !== current.branch : undefined,
                canContinue: current ? await this.canContinue(item, { repo, ...current }) : undefined });
        }
        return results;
    }
    private async read(id: string): Promise<Session> {
        if (!/^[a-f0-9-]{36}$/.test(id)) throw new MessageError('agent.invalidTaskId');
        const filename = path.join(this.directory, id + '.json'), stat = await fs.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new MessageError('agent.taskRecordInvalid');
        const value: Session = JSON.parse(await fs.readFile(filename, 'utf8'));
        if (value.schema !== 1 || value.id !== id || value.root !== this.root || typeof value.repo !== 'string' || !Array.isArray(value.paths) || !Array.isArray(value.baseline?.files) || value.baseline.repo !== value.repo || typeof value.baseline.head !== 'string' || typeof value.baseline.branch !== 'string') throw new MessageError('agent.taskRecordForeign');
        value.paths.forEach(taskPath);
        for (const file of value.baseline.files) if (!file || typeof file.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(file.fingerprint)) throw new MessageError('agent.taskFileSnapshotCorrupt'); else taskPath(file.path);
        if (value.approvals !== undefined) {
            if (!Array.isArray(value.approvals) || value.approvals.length > 32) throw new MessageError('agent.reviewRecordCorrupt');
            for (const approval of value.approvals) {
                if (!approval || typeof approval.id !== 'string' || typeof approval.head !== 'string' || typeof approval.branch !== 'string' || !approval.files || Array.isArray(approval.files) || Object.keys(approval.files).length > 50) throw new MessageError('agent.reviewRecordCorrupt');
                for (const [name, file] of Object.entries(approval.files)) { taskPath(name); taskPath(file.path); if (!/^[a-f0-9]{64}$/.test(file.fingerprint) || file.workingFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(file.workingFingerprint)) throw new MessageError('agent.reviewFileSnapshotCorrupt'); }
            }
        }
        if (value.continuation && (typeof value.continuation.head !== 'string' || typeof value.continuation.branch !== 'string')) throw new MessageError('agent.continuationRecordCorrupt');
        if (value.extensions !== undefined) {
            if (!Array.isArray(value.extensions) || value.extensions.length > 64) throw new MessageError('agent.extensionRecordCorrupt');
            for (const entry of value.extensions) {
                if (!entry || typeof entry.at !== 'string' || typeof entry.head !== 'string' || !Array.isArray(entry.paths) || !Array.isArray(entry.files)) throw new MessageError('agent.extensionRecordCorrupt');
                entry.paths.forEach(taskPath);
                for (const file of entry.files) if (!file || !/^[a-f0-9]{64}$/.test(file.fingerprint)) throw new MessageError('agent.scopeSnapshotCorrupt'); else taskPath(file.path);
            }
        }
        if (value.commits !== undefined) {
            if (!Array.isArray(value.commits) || value.commits.length > 128) throw new MessageError('agent.taskCommitRecordCorrupt');
            for (const entry of value.commits) {
                if (!entry || typeof entry.from !== 'string' || typeof entry.head !== 'string' || typeof entry.branch !== 'string' || !Array.isArray(entry.paths)) throw new MessageError('agent.taskCommitRecordCorrupt');
                entry.paths.forEach(taskPath);
            }
        }
        return value;
    }
    private async write(item: Session): Promise<void> {
        const bytes = JSON.stringify(item); if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw new MessageError('agent.taskRecordTooLarge');
        const temporary = path.join(this.directory, item.id + '.' + randomUUID() + '.tmp');
        await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, path.join(this.directory, item.id + '.json'));
    }
    async approve(state: TaskState, id: string, names: string[], reviewId: string): Promise<void> {
        const item = await this.read(id);
        if (!await this.canContinue(item, state)) throw new MessageError('agent.taskRepoBranchChanged');
        if (!names.length || names.length > 50 || (item.approvals?.length || 0) >= 32) throw new MessageError('agent.reviewScopeTooLarge');
        const files: Record<string, TaskFile> = Object.create(null);
        for (const name of names.map(taskPath)) {
            const file = state.files.find(f => f.path === name || f.oldPath === name);
            if (!file || file.conflict) throw new MessageError('agent.reviewPathUnchangedOrConflict', { name });
            files[name] = { ...file };
        }
        item.approvals = [...(item.approvals || []), { id: reviewId, at: new Date().toISOString(), head: state.head, branch: state.branch, files }];
        item.continuation = { head: state.head, branch: state.branch };
        await this.write(item);
    }
    async start(state: TaskState, title: unknown, paths: unknown): Promise<Pick<Session, 'id' | 'title' | 'createdAt' | 'paths'> & { archived?: { id: string; title: string; reason: string }[] }> {
        if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new MessageError('agent.taskTitleLength');
        if (!Array.isArray(paths) || !paths.length || paths.length > 500) throw new MessageError('agent.taskPathsRange');
        const item: Session = { schema: 1, id: randomUUID(), root: this.root, repo: state.repo, title: title.trim(), createdAt: new Date().toISOString(), paths: [...new Set(paths.map(taskPath))], baseline: state };
        const bytes = JSON.stringify(item); if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw new MessageError('agent.taskSnapshotTooLarge');
        const tasks = await this.list(state.repo, state);
        let active = tasks.filter(task => task.canContinue !== false);
        const archived: { id: string; title: string; reason: string }[] = [];
        if (active.length >= 32) {
            // A task whose commits are recorded and whose paths carry no change any more is finished; the
            // oldest finished ones make room, so a long bug batch no longer stops at the task limit.
            const changed = new Set(state.files.map(file => file.path));
            const finished: TaskSummary[] = [];
            for (const task of active) { const saved = await this.read(task.id); if ((saved.commits?.length || 0) > 0 && !saved.paths.some(name => changed.has(name))) finished.push(task); }
            finished.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
            for (const task of finished) {
                if (active.length < 32) break;
                await this.archive(task.id, 'completed');
                archived.push({ id: task.id, title: task.title, reason: t('agent.autoArchivedReason') });
                active = active.filter(item => item.id !== task.id);
            }
        }
        if (active.length >= 32) throw new MessageError('agent.taskLimitReached');
        for (const task of tasks.filter(task => task.canContinue === false)) await this.archive(task.id, 'expired');
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        await fs.writeFile(path.join(this.directory, item.id + '.json'), bytes, { mode: 0o600, flag: 'wx' });
        return { id: item.id, title: item.title, createdAt: item.createdAt, paths: item.paths, ...(archived.length ? { archived } : {}) };
    }
    async review(state: TaskState, id: string, candidatePaths?: string[], includePointers = false): Promise<ScopeReview> {
        const saved = await this.read(id);
        if (saved.repo !== state.repo) throw new MessageError('agent.taskBelongsToOtherRepo');
        const policy = await this.reviewPolicy(), humanReviewRequired = policy.required;
        const canContinue = await this.canContinue(saved, state);
        const baseline = new Map(saved.baseline.files.map(file => [file.path, file]));
        for (const extension of saved.extensions || []) {
            for (const name of extension.paths) baseline.delete(name);
            for (const file of extension.files) baseline.set(file.path, file);
        }
        const approved = (name: string, file: TaskFile): boolean => (saved.approvals || []).some(approval => {
            if (!canContinue || approval.branch !== state.branch) return false;
            const original = approval.files[name]; if (!original) return false;
            if (original.fingerprint === file.fingerprint) return true;
            return !!original.workingFingerprint && original.workingFingerprint === file.workingFingerprint
                && file.indexObject === original.workingObject && file.indexMode === original.workingMode;
        });
        const files = state.files.map(file => {
            const previous = baseline.get(file.path) || (file.oldPath ? baseline.get(file.oldPath) : undefined) || [...baseline.values()].find(old => old.oldPath === file.path);
            const humanReviewed = approved(file.path, file);
            return { ...file, classification: previous ? (previous.fingerprint === file.fingerprint ? 'preExisting' as const : 'mixed' as const) : 'observedSinceStart' as const, inScope: saved.paths.includes(file.path) || humanReviewed, humanReviewed };
        });
        const candidates = [...new Set(candidatePaths === undefined ? state.files.filter(staged).flatMap(f => f.oldPath ? [f.path, f.oldPath] : [f.path]) : candidatePaths.map(taskPath))];
        const blockers: ScopeReview['blockers'] = [];
        const headChanged = saved.baseline.head !== state.head || saved.baseline.branch !== state.branch;
        if (!canContinue) blockers.push({ code: 'HEAD_CHANGED', message: t('agent.blockerHeadChanged') });
        if (state.operation) blockers.push({ code: 'OPERATION_IN_PROGRESS', message: t('agent.blockerOperationInProgress', { operation: state.operation }) });
        if (!candidates.length && candidatePaths === undefined) blockers.push({ code: 'EMPTY_SCOPE', message: t('agent.blockerEmptyScope') });
        for (const name of candidates) {
            const file = files.find(f => f.path === name || f.oldPath === name);
            const reviewed = file && approved(name, file);
            if (!saved.paths.includes(name) && !reviewed) blockers.push({ code: 'OUTSIDE_SCOPE', path: name, message: t('agent.blockerOutsideScope') });
            if (humanReviewRequired && !reviewed && (file?.classification === 'preExisting' || file?.classification === 'mixed')) blockers.push({ code: file.classification === 'mixed' ? 'MIXED_CHANGES' : 'PREEXISTING_CHANGES', path: name, message: t('agent.blockerPreexisting') });
            if (file?.conflict) blockers.push({ code: 'CONFLICT', path: name, message: t('agent.blockerConflict') });
            if (file?.submodule && !includePointers) blockers.push({ code: 'SUBMODULE_POINTER', path: name, message: t('agent.blockerSubmodulePointer') });
            if (file && !file.submodule) {
                const related = [name.endsWith('.meta') ? name.slice(0, -5) : name + '.meta'];
                let dir = path.posix.dirname(name); while (dir !== '.') { related.push(dir + '.meta'); dir = path.posix.dirname(dir); }
                for (const item of related) if (state.files.some(f => f.path === item) && !candidates.includes(item)) blockers.push({ code: 'RELATED_PATH_MISSING', path: item, message: t('agent.blockerRelatedPathMissing') });
            }
        }
        const snapshotVersion = createHash('sha256').update(JSON.stringify({ id, repo: state.repo, head: state.head, branch: state.branch, operation: state.operation,
            files: state.files.filter(file => candidates.includes(file.path) || !!file.oldPath && candidates.includes(file.oldPath)),
            index: state.files.filter(staged).map(file => [file.path, file.oldPath, file.index, file.indexObject, file.indexMode]),
            candidates, includePointers, humanReviewRequired, policySource: policy.source, canContinue })).digest('hex');
        return { id, repo: state.repo, snapshotVersion, headChanged, canContinue, canProceed: !blockers.length, humanReviewRequired, reviewPolicySource: policy.source, files, resolvedPaths: saved.baseline.files.filter(f => !files.some(current => current.path === f.path)).map(f => f.path), candidatePaths: candidates, blockers, ownership: 'observed changes are not proof of authorship' };
    }
}
