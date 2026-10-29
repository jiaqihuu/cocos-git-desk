import path from 'path';
import { GitDesk } from './git';
import { AgentBridge, AgentOptions, AgentReply } from './agent';
import { Action, Host, Task } from './types';
import { WorktreeRegistry } from './worktrees';
import { ScopeReviewQueue } from './scope-reviews';
import { t, MessageError } from './i18n';

const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MessageError('agent.requestMustBeObject'); return value as Record<string, unknown>; };
const text = (value: unknown, name: string): string => { if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) throw new Error(t('agent.invalidParameterPrefix') + name); return value; };
const isolatedActions = new Set<Action>(['stage', 'unstage', 'stageLines', 'unstageLines', 'commit', 'commitSelected', 'merge', 'beginMerge', 'resolveConflict', 'finishMerge', 'abortMerge', 'push', 'fetch', 'lfsFetch', 'pull', 'stashPush', 'stashSelected', 'stashApply', 'stashDrop', 'discardFiles', 'discardLines', 'restoreFiles', 'restoreStashFiles', 'switch', 'checkoutRemote', 'createBranch', 'createBranchAt']);
interface ContextInstance { service: GitDesk; agent: AgentBridge; root: string; }
export class WorkspaceContexts {
    readonly worktrees: WorktreeRegistry;
    readonly reviews: ScopeReviewQueue;
    private instances = new Map<string, ContextInstance>();
    private routing?: string;
    private readonly creatorAgent: AgentBridge;
    constructor(readonly source: GitDesk, private readonly navigate: ConstructorParameters<typeof AgentBridge>[1], private readonly notifyReview?: (id: string) => Promise<void>, private readonly options: AgentOptions = {}) {
        this.creatorAgent = new AgentBridge(source, navigate, options);
        this.worktrees = new WorktreeRegistry(source, path.join(source.cache, 'workspaces'), () => this.running());
        this.reviews = new ScopeReviewQueue(path.join(source.cache, 'workspaces'), id => this.service(id), () => this.running());
    }
    running(): boolean { return !!this.displayTask(false); }
    externallyBusy(context = 'creator'): boolean {
        if (this.routing && this.routing !== context) return true;
        if (this.worktrees.task?.status === 'running') return true;
        if (context !== 'creator' && this.source.task()?.status === 'running') return true;
        for (const [id, instance] of this.instances) if (id !== context && instance.service.task()?.status === 'running') return true;
        return false;
    }
    displayTask(includeFinished = true): Task | null {
        const candidates: Task[] = [];
        const original = this.source.task(); if (original) candidates.push(original);
        if (this.worktrees?.task) candidates.push({ ...this.worktrees.task });
        for (const [id, instance] of this.instances) {
            const task = instance.service.task();
            if (task) candidates.push({ ...task, workspace: { id, root: instance.root, isolated: true }, title: t('agent.isolatedWorkspaceTitlePrefix') + task.title });
        }
        const running = candidates.find(t => t.status === 'running');
        return running || (includeFinished ? candidates.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] || null : null);
    }
    async service(id = 'creator'): Promise<GitDesk> {
        if (id === 'creator') return this.source;
        const context = await this.worktrees.get(id);
        let current = this.instances.get(id);
        if (current && current.root !== context.root) throw new MessageError('agent.contextRootChanged');
        if (!current) {
            const available = () => { if (this.externallyBusy(id)) throw new MessageError('agent.otherContextRunning'); };
            const host: Host = { assertAvailable: available, checkEditor: async () => available(), beforeWorktreeChange: async () => available(), afterWorktreeChange: async () => {} };
            const service = new GitDesk(context.root, path.join(this.source.cache, 'workspaces', 'contexts', id), host, this.source.settingsCache);
            const agent = new AgentBridge(service, async () => { throw new MessageError('agent.isolatedNoNavigation'); }, this.options);
            current = { service, agent, root: context.root }; this.instances.set(id, current);
        }
        return current.service;
    }
    // A mutation that arrives while another operation or task is running queues for a bounded time
    // instead of being refused; the human review path keeps refusing at once.
    private async idle(): Promise<void> {
        const busy = () => !!this.routing || this.running();
        if (!busy()) return;
        const deadline = Date.now() + (this.options.queueMs ?? 45000);
        while (busy() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(100, deadline - Date.now()))));
        if (busy()) throw new MessageError('agent.busyQueryTask');
    }
    async reviewDecision(id: string, digest: string, approve: boolean) {
        if (this.routing || this.running()) throw new MessageError('agent.waitForCurrentOperation');
        this.routing = 'human-review';
        try { return await this.reviews.decide(id, digest, approve); } finally { this.routing = undefined; }
    }
    async handle(repo: string, value: unknown, context = 'creator'): Promise<AgentReply> {
        let op = 'unknown', mutation = false, ownsRouting = false;
        try {
            await this.worktrees.ready;
            if (typeof context !== 'string' || context.length > 128 || !context) throw new MessageError('agent.invalidContextId');
            const query = object(value); op = text(query.op, 'op');
            mutation = ['prepare', 'execute', 'scopeStart', 'scopeExtend', 'scopeReviewRequest', 'contextRegister', 'contextForget', 'worktreePrepare', 'worktreeExecute'].includes(op);
            if (mutation) { await this.idle(); this.routing = context; ownsRouting = true; }
            let contextRoot: string | undefined;
            let result: unknown;
            if (op === 'contexts') {
                if (context !== 'creator') throw new MessageError('agent.contextsFromCreatorOnly');
                result = { creator: { id: 'creator', root: this.source.project }, contexts: await this.worktrees.list(), available: await this.worktrees.available(typeof query.baseRepo === 'string' ? query.baseRepo : '.') };
            } else if (op === 'contextRegister') {
                if (context !== 'creator') throw new MessageError('agent.registerFromCreatorOnly');
                result = await this.worktrees.register(text(query.path, 'path'), query.baseRepo === undefined ? '.' : text(query.baseRepo, 'baseRepo'));
            } else if (op === 'contextForget') {
                if (context === 'creator') throw new MessageError('agent.cannotForgetCreator');
                contextRoot = (await this.worktrees.list()).find(item => item.id === context)?.root;
                await this.worktrees.forget(context); this.instances.delete(context); result = { forgotten: context, filesRemoved: false };
            } else if (op === 'worktreePrepare') {
                if (context !== 'creator') throw new MessageError('agent.worktreeLifecycleFromCreator');
                if (query.mode !== 'create' && query.mode !== 'remove') throw new MessageError('agent.modeCreateOrRemove');
                result = await this.worktrees.prepare({ mode: query.mode, baseRepo: query.baseRepo === undefined ? '.' : text(query.baseRepo, 'baseRepo'), path: query.path === undefined ? undefined : text(query.path, 'path'), branch: query.branch === undefined ? undefined : text(query.branch, 'branch'), revision: query.revision === undefined ? undefined : text(query.revision, 'revision'), context: query.targetContext === undefined ? undefined : text(query.targetContext, 'targetContext') });
            } else if (op === 'worktreeExecute') {
                if (context !== 'creator') throw new MessageError('agent.worktreeLifecycleFromCreator');
                result = this.worktrees.execute(text(query.token, 'token'), text(query.digest, 'digest'));
            } else if (op === 'scopeReviewRequest') {
                if (!Array.isArray(query.paths) || query.paths.some(p => typeof p !== 'string')) throw new MessageError('agent.pathsMustBeArray');
                const requested = await this.reviews.request(context, repo, text(query.taskId, 'taskId'), query.paths.map(p => text(p, 'path')), query.review);
                let notification: 'sent' | 'unavailable' | 'failed' = 'unavailable';
                let notificationError: string | undefined;
                if (this.notifyReview) {
                    try { await this.notifyReview(requested.id); notification = 'sent'; }
                    catch (error) { notification = 'failed'; notificationError = (error instanceof Error ? error.message : String(error)).slice(0, 1000); }
                }
                result = { ...requested, notification, ...(notificationError ? { notificationError } : {}) };
            } else if (op === 'scopeReviewStatus') {
                const records = await this.reviews.list();
                result = records.filter(r => r.context === context && r.repo === repo && (query.id === undefined || r.id === query.id));
            } else if (op === 'task' && context === 'creator' && this.worktrees.task && (query.taskId === this.worktrees.task.id || query.taskId === undefined && this.displayTask()?.id === this.worktrees.task.id)) {
                if (query.logLimit !== undefined && (typeof query.logLimit !== 'number' || !Number.isInteger(query.logLimit) || query.logLimit < 0 || query.logLimit > 8000)) throw new MessageError('agent.logLimitRange');
                const limit = typeof query.logLimit === 'number' ? query.logLimit : 4000;
                if (query.waitMs !== undefined && (typeof query.waitMs !== 'number' || !Number.isInteger(query.waitMs) || query.waitMs < 0 || query.waitMs > 100000)) throw new MessageError('agent.waitMsRange');
                const deadline = Date.now() + (typeof query.waitMs === 'number' ? query.waitMs : 5000), since = Date.now();
                while (this.worktrees.task?.status === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
                const current = this.worktrees.task!;
                result = { ...current, log: limit ? current.log.slice(-limit) : '', requiresPolling: current.status === 'running', waitedMs: Date.now() - since };
            } else {
                const service = await this.service(context);
                if (context !== 'creator' && op === 'prepare') {
                    const operation = object(query.operation);
                    if (!isolatedActions.has(operation.action as Action)) throw new MessageError('agent.notOpenToIsolatedContext');
                }
                const agent = context === 'creator' ? this.creatorAgent : this.instances.get(context)!.agent;
                const reply = await agent.handle(repo, query);
                if (reply.ok && op === 'capabilities') reply.data.result = { ...object(reply.data.result), workspaces: { creator: this.source.project, explicitContext: true, noFallback: true, knownCommonGitDirectoryOnly: true, maximumContexts: 16, listTool: 'git_desk_context_list', registerTool: 'git_desk_context_register', lifecycle: ['git_desk_worktree_prepare', 'git_desk_worktree_execute'], isolatedActions: [...isolatedActions], humanReview: 'git_desk_scope_review request/status; approval only via Git Desk UI; no Git execution on approval' } };
                if (reply.ok) reply.data.context = { id: context, root: service.project, isolated: context !== 'creator' };
                return reply;
            }
            return { ok: true, data: { protocol: 1, op, result, context: { id: context, root: context === 'creator' ? this.source.project : contextRoot || (await this.worktrees.get(context)).root, isolated: context !== 'creator' } } };
        } catch (error) {
            return { ok: false, protocol: 1, op, code: 'CONTEXT_OPERATION_FAILED', error: (error instanceof Error ? error.message : String(error)).slice(0, 8000), refreshRequired: true, mayHaveSideEffects: mutation };
        } finally { if (ownsRouting) this.routing = undefined; }
    }
}
