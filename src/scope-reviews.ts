import { promises as fs } from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { GitDesk } from './git';
import { taskPath } from './task-scope';
import { t, MessageError } from './i18n';

export interface ReviewNotes { summary: string; focus: string; validation: string; }
export interface ReviewFile { path: string; reasons: string[]; }
export interface ReviewSection { file: number; area: 'index' | 'worktree' | 'notice'; start: number; length: number; }
function reviewNotes(value: unknown): ReviewNotes | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MessageError('agent.reviewFieldsRequired');
    const fields = value as Record<string, unknown>;
    if (Object.keys(fields).some(key => !['summary', 'focus', 'validation'].includes(key))) throw new MessageError('agent.reviewUnknownField');
    for (const key of ['summary', 'focus', 'validation']) if (typeof fields[key] !== 'string' || !(fields[key] as string).trim() || (fields[key] as string).length > 4000 || (fields[key] as string).includes('\0')) throw new MessageError('agent.reviewFieldLength', { key });
    return { summary: (fields.summary as string).trim(), focus: (fields.focus as string).trim(), validation: (fields.validation as string).trim() };
}

export interface ScopeApproval {
    schema: 1; id: string; context: string; repo: string; taskId: string; title: string; root: string; paths: string[];
    head: string; branch: string; state: string; digest: string; patch: string; createdAt: string; expiresAt: number;
    status: 'pending' | 'approved' | 'rejected';
    review?: ReviewNotes; files?: ReviewFile[]; sections?: ReviewSection[];
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class ScopeReviewQueue {
    constructor(private readonly cache: string, private readonly resolve: (context: string) => Promise<GitDesk>, private readonly busy: () => boolean) {}
    private get directory(): string { return path.join(this.cache, 'scope-reviews'); }
    private async read(id: string): Promise<ScopeApproval> {
        if (!/^[a-f0-9-]{36}$/.test(id)) throw new MessageError('agent.invalidReviewId');
        const filename = path.join(this.directory, id + '.json'), stat = await fs.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new MessageError('agent.reviewRecordInvalid');
        const item: ScopeApproval = JSON.parse(await fs.readFile(filename, 'utf8'));
        if (item.schema !== 1 || item.id !== id || typeof item.context !== 'string' || typeof item.repo !== 'string' || typeof item.taskId !== 'string' || !Array.isArray(item.paths) || item.paths.length > 50 || typeof item.patch !== 'string' || typeof item.state !== 'string' || typeof item.digest !== 'string' || !['pending', 'approved', 'rejected'].includes(item.status) || typeof item.expiresAt !== 'number') throw new MessageError('agent.reviewRecordCorrupt');
        item.paths.forEach(taskPath); return item;
    }
    private async write(item: ScopeApproval): Promise<void> {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        const temp = path.join(this.directory, item.id + '.' + randomUUID() + '.tmp');
        const content = JSON.stringify(item);
        if (Buffer.byteLength(content) > 256 * 1024) throw new MessageError('agent.reviewTooLarge');
        await fs.writeFile(temp, content, { mode: 0o600, flag: 'wx' }); await fs.rename(temp, path.join(this.directory, item.id + '.json'));
    }
    async list() {
        let names: string[];
        try { names = (await fs.readdir(this.directory)).filter(n => n.endsWith('.json')); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
        if (names.length > 64) throw new MessageError('agent.tooManyReviews');
        const results = [];
        for (const name of names) {
            const item = await this.read(name.slice(0, -5));
            results.push({ id: item.id, context: item.context, repo: item.repo, title: item.title, paths: item.paths, status: item.status === 'pending' && item.expiresAt < Date.now() ? 'expired' : item.status, createdAt: item.createdAt, expiresAt: item.expiresAt });
        }
        return results;
    }
    private async archiveFinished() {
        let names: string[];
        try { names = (await fs.readdir(this.directory)).filter(name => name.endsWith('.json')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
        const archive = path.join(this.cache, 'scope-review-archives');
        for (const name of names) {
            const item = await this.read(name.slice(0, -5));
            if (item.status === 'pending' && item.expiresAt >= Date.now()) continue;
            await fs.mkdir(archive, { recursive: true, mode: 0o700 });
            await fs.link(path.join(this.directory, name), path.join(archive, name));
            await fs.unlink(path.join(this.directory, name));
        }
    }
    async request(context: string, repo: string, taskId: string, names: string[], notes?: unknown) {
        const review = reviewNotes(notes);
        if (this.busy()) throw new MessageError('agent.waitForOperationFirst');
        if (!Array.isArray(names) || !names.length || names.length > 50) throw new MessageError('agent.reviewPathsRange');
        const paths = [...new Set(names.map(taskPath))], service = await this.resolve(context);
        await this.archiveFinished();
        const existing = await this.list(); if (existing.length >= 64 || existing.filter(r => r.status === 'pending').length >= 16) throw new MessageError('agent.reviewQueueFull');
        const state = await service.taskScopeState(repo, paths);
        const task = (await service.scopeList(repo)).find(item => item.id === taskId);
        if (!task) throw new MessageError('agent.taskNotInContext');
        const scope = await service.scopeReview(repo, taskId, paths);
        if (!scope.canContinue || state.operation) throw new MessageError('agent.taskStateChangedCheck');
        const chunks: string[] = [], sections: ReviewSection[] = [];
        const append = (name: string, area: ReviewSection['area'], heading: string, content: string) => {
            const start = chunks.join('\n\n').length + (chunks.length ? 2 : 0) + heading.length;
            sections.push({ file: paths.indexOf(name), area, start, length: content.length });
            chunks.push(heading + content);
        };
        for (const name of paths) {
            const file = state.files.find(f => f.path === name || f.oldPath === name);
            if (!file || file.conflict) throw new MessageError('agent.fileUnchangedOrConflict', { name });
            if (file.submodule) { append(name, 'notice', '', t('agent.reviewSubmoduleNotice', { name, indexObject: file.indexObject, workingObject: file.workingObject })); continue; }
            if (file.oldPath === name && file.path !== name) { append(name, 'notice', '', t('agent.reviewRenameNotice', { name, path: file.path })); continue; }
            for (const area of ['index', 'worktree'] as const) {
                const diff = await service.diff({ repo, path: name, area });
                if (diff.before.image || diff.after.image || diff.before.notice || diff.after.notice) throw new MessageError('agent.reviewNotTextReviewable', { name });
                const empty = t('agent.reviewEmptySide');
                const content = diff.patch || (diff.before.text === diff.after.text ? t('agent.reviewSameContent') : t('agent.reviewBeforeAfter', { before: diff.before.text || empty, after: diff.after.text || empty }));
                if (diff.patchNotice) throw new MessageError('agent.reviewDiffIncomplete', { name });
                append(name, area, name + ' · ' + (area === 'index' ? t('agent.reviewAreaIndex') : t('agent.reviewAreaWorktree')) + '\n', content);
                if (Buffer.byteLength(chunks.join('\n\n')) > 180000) throw new MessageError('agent.reviewDiffTooLargeNoApprove');
            }
        }
        if (Buffer.byteLength(chunks.join('\n\n')) > 180000) throw new MessageError('agent.reviewDiffTooLarge');
        const files = paths.map(name => {
            const file = scope.files.find(f => f.path === name || f.oldPath === name);
            const reasons: string[] = [];
            if (file?.classification === 'preExisting') reasons.push(t('agent.reviewReasonPreexisting'));
            if (file?.classification === 'mixed') reasons.push(t('agent.reviewReasonMixed'));
            if (file && !file.inScope) reasons.push(t('agent.reviewReasonOutOfScope'));
            if (!reasons.length) reasons.push(t('agent.reviewReasonRequested'));
            for (const blocker of scope.blockers.filter(b => b.path === name && !['PREEXISTING_CHANGES', 'MIXED_CHANGES', 'OUTSIDE_SCOPE'].includes(b.code))) reasons.push(blocker.message);
            return { path: name, reasons };
        });
        const expected = scope.snapshotVersion;
        if ((await service.scopeReview(repo, taskId, paths)).snapshotVersion !== expected) throw new MessageError('agent.reviewStateChangedWhileDiffing');
        const item: ScopeApproval = { schema: 1, id: randomUUID(), context, repo, taskId, title: task.title, root: (await service.snapshot()).repositories.find(r => r.id === repo)!.path, paths, head: state.head, branch: state.branch, state: expected, digest: '', patch: chunks.join('\n\n'), createdAt: new Date().toISOString(), expiresAt: Date.now() + 600000, status: 'pending', review, files, sections };
        item.digest = hash([item.id, context, repo, taskId, item.root, item.paths, item.head, item.state, item.patch, item.review, item.files, item.sections]);
        await this.write(item);
        return { id: item.id, status: item.status, context, repo, paths, expiresAt: item.expiresAt, instruction: t('agent.reviewSavedInstruction') };
    }
    async view(id: string): Promise<ScopeApproval> { return this.read(id); }
    async decide(id: string, digest: string, approve: boolean) {
        if (this.busy()) throw new MessageError('agent.waitForOperationFirst');
        const item = await this.read(id);
        if (item.status !== 'pending' || item.expiresAt < Date.now() || digest !== item.digest) throw new MessageError('agent.reviewAlreadyHandled');
        if (approve) { const service = await this.resolve(item.context); await service.scopeApprove(item.repo, item.taskId, item.paths, item.id, item.state); }
        item.status = approve ? 'approved' : 'rejected'; await this.write(item);
        return { id, status: item.status, gitExecuted: false };
    }
}
