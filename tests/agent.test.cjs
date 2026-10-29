const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { AgentBridge } = require('../dist/agent');
const { TagStateChangedError, TreeStateChangedError, MergeStateChangedError, RemoteStateChangedError, FileComparisonStateChangedError, ReflogStateChangedError, StashStateChangedError } = require('../dist/types');

// In-memory protocol fixtures only: no Git commands, filesystem writes or Creator requests.
const changed = (path, extra = {}) => ({ path, index: ' ', worktree: 'M', conflict: false, submodule: false, ...extra });
const repository = (id = '.', extra = {}) => ({ id, path: '/project/' + id, name: id, head: 'a'.repeat(40), branch: 'dev', upstream: 'origin/dev', ahead: 1, behind: 2, initialized: true, files: [], version: 'v1', operation: '', ...extra });
const task = (extra = {}) => ({ id: 'task-1', title: 'stage', status: 'running', log: 'first\nlast\n', startedAt: '2026-10-23T00:00:00.000Z', ...extra });
const query = (op, extra = {}) => ({ kind: 'agent', protocol: 1, op, ...extra });
const operation = (extra = {}) => ({ version: 'v1', action: 'stage', paths: ['assets/a.ts'], ...extra });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(options = { queueMs: 100, waitMs: 100, pollMs: 100 }) {
    const calls = { snapshot: [], prepare: [], execute: [], navigate: [], tags: [], tree: [], merge: [], remotes: [], fileCompare: [], worktreeCompare: [], indexCompare: [], reflog: [], backups: [] };
    const state = { repos: [repository()], task: null, sequence: 0, hooks: {} };
    const service = {
        supportedActions: () => ['stage', 'stageLines', 'resolveConflict', 'commit', 'push', 'createTag', 'deleteTag', 'stashSelected', 'finishMerge', 'createBranchAt', 'addRemote', 'setRemoteUrl', 'setRemotePushUrl', 'resetRemotePushUrl', 'discardLines', 'discardFiles', 'restoreFiles', 'restoreStashFiles', 'beginMerge', 'abortMerge'],
        tags: async (repo, query) => {
            calls.tags.push({ repo, query });
            if (state.hooks.tags) return state.hooks.tags(repo, query);
            return { repo, version: 'tags-v1', tags: [], offset: query.offset, limit: query.limit, total: 0, tagCount: 0, capturedAt: 'snapshot-time' };
        },

        reflog: async (repo, query) => {
            calls.reflog.push({ repo, query });
            if (state.hooks.reflog) return state.hooks.reflog(repo, query);
            return { repo, repoVersion: 'v1', ref: query.ref, version: 'c'.repeat(64), entries: [], total: 0, sampled: 0, available: true, truncated: false, offset: query.offset, limit: query.limit, notice: 'local recent window', capturedAt: 'time' };
        },
        compareFilePage: async (repo, query) => {
            calls.fileCompare.push({ repo, query });
            if (state.hooks.fileCompare) return state.hooks.fileCompare(repo, query);
            return { repo, comparison: { version: 'f'.repeat(64), left: query.left, right: query.right }, view: query.view, text: '', offset: query.offset, total: 0, limit: query.limit, patchAvailable: true };
        },
        compareWorktreePage: async (repo, query) => {
            calls.worktreeCompare.push({ repo, query });
            if (state.hooks.worktreeCompare) return state.hooks.worktreeCompare(repo, query);
            return { repo, comparison: { version: 'd'.repeat(64), left: query.left, right: { path: query.path, kind: 'file', hash: 'b'.repeat(64), size: 0, mode: 420 }, diskOnly: true, normalization: 'raw' }, view: query.view, text: '', offset: query.offset, total: 0, limit: query.limit, patchAvailable: true, cachedUpToMs: 0 };
        },
        compareIndexPage: async (repo, query) => {
            calls.indexCompare.push({ repo, query });
            if (state.hooks.indexCompare) return state.hooks.indexCompare(repo, query);
            return { repo, comparison: { version: 'e'.repeat(64), left: query.left, right: { path: query.path, kind: 'file', object: 'b'.repeat(40), size: 0, mode: '100644', stage: 0, entryVersion: 'f'.repeat(64) }, indexOnly: true, normalization: 'raw' }, view: query.view, text: '', offset: query.offset, total: 0, limit: query.limit, patchAvailable: true, cachedUpToMs: 0 };
        },
        remotePage: async (repo, query) => {
            calls.remotes.push({ repo, query });
            if (state.hooks.remotes) return state.hooks.remotes(repo, query);
            return { repo, repoVersion: 'v1', version: 'r'.repeat(64), remoteVersion: 'c'.repeat(64), entries: [], total: 0, offset: query.offset, limit: query.limit, canAdd: true };
        },
        mergeState: async repo => {
            calls.merge.push(repo);
            if (state.hooks.merge) return state.hooks.merge(repo);
            return { repo, repoVersion: 'v1', version: 'merge-v1', active: true, canFinish: true, head: 'a'.repeat(40), branch: 'dev', mergeHead: 'b'.repeat(40), conflicts: 0, staged: 1, pointers: false, message: 'default merge' };
        },
        tree: async (repo, query) => {
            calls.tree.push({ repo, query });
            if (state.hooks.tree) return state.hooks.tree(repo, query);
            return { repo, revision: query.revision, directory: query.directory, tree: 'b'.repeat(40), version: 'tree-v1', entries: [], offset: query.offset, limit: query.limit, total: 0 };
        },
        snapshot: async force => {
            calls.snapshot.push(force);
            if (state.hooks.snapshot) await state.hooks.snapshot(force);
            return { project: 'sample', root: '/project', repositories: state.repos, task: state.task, fetchedAt: { '.': 'cached-fetch-time' } };
        },
        prepare: async input => {
            calls.prepare.push(input);
            if (state.hooks.prepare) return state.hooks.prepare(input);
            return { token: 'token-' + ++state.sequence, title: 'Stage selected', description: 'Review scope', paths: [...(input.paths || [])], warnings: ['Related .meta can be included'], expiresAt: Date.now() + 60000 };
        },
        execute: token => {
            calls.execute.push(token);
            if (state.hooks.execute) return state.hooks.execute(token);
            return state.task = task();
        },
        task: () => state.task,
    };
    const navigate = async (repo, path, action) => {
        calls.navigate.push({ repo, path, action });
        if (state.hooks.navigate) return state.hooks.navigate(repo, path, action);
        return { file: path, asset: path.replace(/\.meta$/, ''), canOpen: true, canReveal: true,
            ...(action === 'open' ? { openRequested: true } : action === 'reveal' ? { revealRequested: true } : {}) };
    };
    const bridge = new AgentBridge(service, navigate, options);
    return { bridge, state, calls, handle: (op, extra, repo = '.') => bridge.handle(repo, query(op, extra)) };
}
function success(reply) { assert.equal(reply.ok, true, reply.error); assert.equal(reply.data.protocol, 1); return reply.data.result; }
function failure(reply, code, effects = false) { assert.equal(reply.ok, false); assert.equal(reply.code, code); assert.equal(reply.protocol, 1); assert.equal(reply.mayHaveSideEffects, effects); return reply; }
async function preview(f, extra = {}, repo = '.') { return success(await f.handle('prepare', { operation: operation(extra) }, repo)); }

test('agent capabilities is local discovery and explicitly describes review and bounded requests', async () => {
    const f = fixture(), result = success(await f.handle('capabilities'));
    assert.deepEqual(f.calls.snapshot, []); assert.deepEqual(f.calls.prepare, []); assert.deepEqual(f.calls.execute, []);
    assert.ok(result.operations.includes('execute')); assert.ok(result.actions.includes('stageLines'));
    assert.equal(result.limits.pageSize, 200); assert.equal(result.limits.pendingPlans, 32);
    assert.ok(result.rules.some(rule => rule.includes('not user authorization')));
    assert.ok(result.rules.some(rule => rule.includes('Never retry')));
    assert.deepEqual(result.navigation, ['describe', 'reveal', 'open']);
});

test('agent rejects invalid protocol, non-JSON requests and unsupported operations before service access', async () => {
    const f = fixture(), circular = {}; circular.self = circular;
    for (const value of [null, [], undefined, circular]) failure(await f.bridge.handle('.', value), 'INVALID_REQUEST');
    for (const value of [{ op: 'status' }, { kind: 'agent', protocol: 2, op: 'status' }]) failure(await f.bridge.handle('.', value), 'UNSUPPORTED_PROTOCOL');
    failure(await f.handle('constructor'), 'UNSUPPORTED_OPERATION');
    failure(await f.handle('shell', { command: 'git reset' }), 'UNSUPPORTED_OPERATION');
    failure(await f.bridge.handle('', query('capabilities')), 'INVALID_REQUEST');
    assert.deepEqual(f.calls.snapshot, []); assert.deepEqual(f.calls.execute, []);
});

test('agent rejects unknown fields, nonboolean force and invalid page or log limits', async () => {
    const f = fixture();
    failure(await f.handle('status', { ignored: true }), 'INVALID_REQUEST');
    failure(await f.handle('status', { force: 'true' }), 'INVALID_REQUEST');
    for (const extra of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { offset: -1 }]) failure(await f.handle('repositories', extra), 'INVALID_REQUEST');
    for (const extra of [{ limit: 0 }, { limit: 201 }, { offset: -1 }, { text: 'a\0b' }, { text: 123 }]) failure(await f.handle('files', extra), 'INVALID_REQUEST');
    for (const logLimit of [-1, 8001, 1.5]) failure(await f.handle('task', { logLimit }), 'INVALID_REQUEST');
    assert.deepEqual(f.calls.execute, []);
});

test('agent bounds encoded input and output payloads without executing oversized plans', async () => {
    const f = fixture();
    failure(await f.handle('files', { text: '中'.repeat(50000) }), 'INVALID_REQUEST');
    assert.deepEqual(f.calls.snapshot, []);
    f.state.repos[0].files = [changed('a'.repeat(270000))];
    failure(await f.handle('files'), 'RESPONSE_TOO_LARGE');
    f.state.hooks.prepare = async () => ({ token: 'large-plan', title: 'large', description: 'x'.repeat(270000), paths: [], warnings: [], expiresAt: Date.now() + 60000 });
    failure(await f.handle('prepare', { operation: operation() }), 'RESPONSE_TOO_LARGE');
    failure(await f.handle('execute', { token: 'large-plan', digest: 'a'.repeat(64) }), 'PLAN_INVALID');
    assert.deepEqual(f.calls.execute, []);
});

test('agent repository pages expose summaries, pagination and cache observations', async () => {
    const f = fixture(); f.state.repos = Array.from({ length: 3 }, (_, i) => repository(String(i), { files: [changed('a')] }));
    const first = success(await f.handle('repositories', { limit: 2, force: true }));
    assert.equal(first.total, 3); assert.equal(first.offset, 0); assert.equal(first.nextOffset, 2);
    assert.deepEqual(first.repositories.map(repo => repo.id), ['0', '1']);
    assert.equal(first.repositories[0].files, undefined); assert.equal(first.repositories[0].counts.files, 1);
    assert.equal(first.repositories[0].remoteCacheOnly, true); assert.equal(first.cachedUpToMs, 4000);
    assert.equal(f.calls.snapshot[0], true); assert.ok(!Number.isNaN(Date.parse(first.respondedAt)));
    assert.match(first.version, /^[a-f0-9]{64}$/);
    assert.equal(failure(await f.handle('repositories', { offset: 2, limit: 2 }), 'STATE_CHANGED').refreshRequired, true);
    const last = success(await f.handle('repositories', { offset: 2, limit: 2, version: first.version }));
    assert.deepEqual(last.repositories.map(repo => repo.id), ['2']); assert.equal(last.nextOffset, undefined);
    assert.equal(last.version, first.version);
    f.state.repos[0].version = 'v2';
    failure(await f.handle('repositories', { offset: 2, limit: 2, version: first.version }), 'STATE_CHANGED');
    const refreshed = success(await f.handle('repositories', { limit: 2 }));
    assert.notEqual(refreshed.version, first.version);
    f.state.repos[2] = repository('replacement');
    failure(await f.handle('repositories', { offset: 2, limit: 2, version: refreshed.version }), 'STATE_CHANGED');
    assert.deepEqual(f.calls.execute, []);
});

test('agent status remains a compact summary even when repository files and task log are large', async () => {
    const f = fixture();
    f.state.repos[0].files = Array.from({ length: 5000 }, (_, i) => changed('assets/large-' + i + '.ts'));
    f.state.repos[0].files.push(changed('both.ts', { index: 'M' }), changed('conflict.ts', { index: 'U', worktree: 'U', conflict: true }));
    f.state.task = task({ log: 'large log'.repeat(10000) });
    const result = success(await f.handle('status'));
    assert.deepEqual(result.repository.counts, { files: 5002, worktree: 5001, index: 1, conflicts: 1 });
    assert.equal(result.repository.files, undefined); assert.equal(result.task.log, ''); assert.equal(result.task.logTruncated, true);
    assert.equal(result.duringTask, true); assert.equal(result.fetchedAt, 'cached-fetch-time');
    assert.equal(result.frozenDuringTask, true); assert.equal(result.cachedUpToMs, null);
    assert.ok(JSON.stringify(result).length < 3000); assert.deepEqual(f.calls.execute, []);
});

test('agent files use bounded pages with stable version and literal case-insensitive old-path matching', async () => {
    const f = fixture(); f.state.repos[0].files = Array.from({ length: 205 }, (_, i) => changed('assets/file-' + i));
    f.state.repos[0].files[204] = changed('new.ts', { oldPath: 'assets/OLD[1].ts', index: 'R' });
    const first = success(await f.handle('files', { limit: 200 }));
    assert.equal(first.files.length, 200); assert.equal(first.nextOffset, 200); assert.equal(first.version, 'v1');
    const second = success(await f.handle('files', { offset: first.nextOffset, version: first.version, limit: 200 }));
    assert.equal(second.files.length, 5); assert.equal(second.nextOffset, undefined);
    const match = success(await f.handle('files', { text: 'old[1]' }));
    assert.equal(match.total, 1); assert.equal(match.files[0].path, 'new.ts');
    assert.equal(success(await f.handle('files', { text: 'old.*' })).total, 0);
    first.files[0].path = 'caller-only'; assert.equal(f.state.repos[0].files[0].path, 'assets/file-0');
});

test('agent files refuse missing or stale page versions and preserve read-only failure markers', async () => {
    const f = fixture();
    for (const extra of [{ offset: 1 }, { version: 'stale' }, { offset: 1, version: 'stale' }]) {
        const result = failure(await f.handle('files', extra), 'STATE_CHANGED'); assert.equal(result.refreshRequired, true);
    }
    assert.deepEqual(f.calls.prepare, []); assert.deepEqual(f.calls.execute, []);
});

test('agent unavailable repositories and stale operation versions stop before prepare', async () => {
    const f = fixture();
    failure(await f.handle('status', {}, 'missing'), 'REPOSITORY_NOT_FOUND');
    failure(await f.handle('prepare', { operation: operation() }, 'missing'), 'REPOSITORY_UNAVAILABLE');
    f.state.repos[0].initialized = false;
    failure(await f.handle('files'), 'REPOSITORY_UNAVAILABLE');
    failure(await f.handle('prepare', { operation: operation() }), 'REPOSITORY_UNAVAILABLE');
    f.state.repos[0].initialized = true; f.state.repos[0].version = 'v2';
    assert.equal(failure(await f.handle('prepare', { operation: operation() }), 'STATE_CHANGED').refreshRequired, true);
    assert.deepEqual(f.calls.prepare, []); assert.deepEqual(f.calls.execute, []);
});

test('agent prepare binds the transport repository and isolates nested caller mutations before await', async () => {
    const f = fixture(), gate = deferred();
    f.state.repos = [repository('nested')]; f.state.hooks.snapshot = () => gate.promise;
    const original = operation({ action: 'stageLines', lines: { path: 'assets/a.ts', version: 'patch-v1', ids: ['line-1'] } });
    const pending = f.handle('prepare', { operation: original }, 'nested');
    original.paths[0] = 'mutated'; original.lines.ids[0] = 'changed'; original.version = 'wrong';
    gate.resolve(); success(await pending);
    assert.equal(f.calls.prepare[0].repo, 'nested'); assert.equal(f.calls.prepare[0].version, 'v1');
    assert.deepEqual(f.calls.prepare[0].paths, ['assets/a.ts']); assert.deepEqual(f.calls.prepare[0].lines.ids, ['line-1']);
    assert.deepEqual(f.calls.snapshot, [true]); assert.deepEqual(f.calls.execute, []);
    failure(await f.handle('prepare', { operation: operation({ repo: '.' }) }, 'nested'), 'INVALID_REQUEST');
});

test('agent operation validation rejects unsupported actions and malformed nested write inputs', async () => {
    const f = fixture();
    failure(await f.handle('prepare', { operation: operation({ action: 'resetHard' }) }), 'UNSUPPORTED_ACTION');
    for (const extra of [
        { extra: true }, { version: '' }, { paths: Array(5001).fill('a') }, { paths: ['a\0b'] },
        { includePointers: 'yes' }, { message: 'x'.repeat(5001) },
        { lines: { path: 'a', version: 'v', ids: [] } }, { lines: { path: 'a', version: 'v', ids: ['x'], extra: true } },
        { resolution: { path: 'a', version: 'v', mode: 'overwrite' } },
    ]) failure(await f.handle('prepare', { operation: operation(extra) }), 'INVALID_REQUEST');
    assert.deepEqual(f.calls.snapshot, []); assert.deepEqual(f.calls.prepare, []); assert.deepEqual(f.calls.execute, []);
});

test('agent prepare returns the digest of the full reviewable plan without automatic execution', async () => {
    const f = fixture(), result = await preview(f);
    assert.equal(result.requiresReview, true); assert.equal(result.executed, false);
    assert.equal(result.digest, createHash('sha256').update(JSON.stringify(result.plan)).digest('hex'));
    assert.deepEqual(result.plan.paths, ['assets/a.ts']); assert.ok(result.plan.warnings.length);
    assert.deepEqual(f.calls.execute, []); assert.equal(f.state.task, null);
});

test('a panel direct-index hint does not authorize automatic Agent execution', async () => {
    const f = fixture();
    f.state.hooks.prepare = async () => ({ token: 'index-plan', title: 'stage', description: '', paths: ['assets/a.ts'], warnings: [], expiresAt: Date.now() + 60000, directIndexAction: 'stage' });
    const result = await preview(f);
    assert.equal(result.plan.directIndexAction, 'stage'); assert.equal(result.requiresReview, true); assert.equal(result.executed, false);
    assert.equal(result.digest, createHash('sha256').update(JSON.stringify(result.plan)).digest('hex'));
    assert.deepEqual(f.calls.execute, []);
});

test('agent execute requires matching digest and repository and consumes its token once', async () => {
    const f = fixture(), result = await preview(f), { token } = result.plan;
    failure(await f.handle('execute', { token, digest: '0'.repeat(64) }), 'PLAN_INVALID');
    failure(await f.handle('execute', { token, digest: result.digest }, 'other'), 'PLAN_INVALID');
    assert.deepEqual(f.calls.execute, []);
    assert.equal(success(await f.handle('execute', { token, digest: result.digest })).status, 'running');
    failure(await f.handle('execute', { token, digest: result.digest }), 'PLAN_INVALID');
    assert.deepEqual(f.calls.execute, [token]);
});

test('agent rejects expired tokens without timers and evicts the oldest beyond 32 pending plans', async () => {
    const expired = fixture();
    expired.state.hooks.prepare = async () => ({ token: 'expired', title: 'old', description: '', paths: [], warnings: [], expiresAt: Date.now() - 1 });
    const old = await preview(expired);
    failure(await expired.handle('execute', { token: old.plan.token, digest: old.digest }), 'PLAN_INVALID');
    assert.deepEqual(expired.calls.execute, []);
    const f = fixture(), plans = [];
    for (let i = 0; i < 33; i++) plans.push(await preview(f));
    failure(await f.handle('execute', { token: plans[0].plan.token, digest: plans[0].digest }), 'PLAN_INVALID');
    success(await f.handle('execute', { token: plans[1].plan.token, digest: plans[1].digest }));
    assert.deepEqual(f.calls.execute, [plans[1].plan.token]);
});

test('agent busy guards preserve prepared tokens and allow describe while a task is running', async () => {
    const f = fixture(), saved = await preview(f); f.state.task = task();
    failure(await f.handle('prepare', { operation: operation() }), 'BUSY');
    failure(await f.handle('execute', { token: saved.plan.token, digest: saved.digest }), 'BUSY');
    failure(await f.handle('navigate', { path: 'assets/a.ts', action: 'open' }), 'BUSY');
    success(await f.handle('navigate', { path: 'assets/a.ts', action: 'describe' }));
    assert.deepEqual(f.calls.execute, []); assert.deepEqual(f.calls.navigate.map(call => call.action), ['describe']);
    f.state.task = null;
    success(await f.handle('execute', { token: saved.plan.token, digest: saved.digest }));
    assert.equal(f.calls.execute.length, 1);
});

test('agent serializes concurrent prepare calls and releases its busy state after failed preparation', async () => {
    const f = fixture(), entered = deferred(), release = deferred();
    f.state.hooks.prepare = async () => { entered.resolve(); await release.promise; throw new Error('preview backend failed'); };
    const pending = f.handle('prepare', { operation: operation() }); await entered.promise;
    failure(await f.handle('prepare', { operation: operation() }), 'BUSY');
    release.resolve(); failure(await pending, 'OPERATION_FAILED');
    f.state.hooks.prepare = undefined;
    success(await f.handle('prepare', { operation: operation() }));
    assert.deepEqual(f.calls.execute, []);
});

test('agent uncertain execute errors are marked potentially side-effectful and never automatically retried', async () => {
    const f = fixture(), saved = await preview(f);
    f.state.hooks.execute = () => { throw new Error('dispatch failed after possible work'); };
    const request = { token: saved.plan.token, digest: saved.digest };
    const failed = failure(await f.handle('execute', request), 'OPERATION_FAILED', true);
    assert.equal(failed.refreshRequired, true); assert.match(failed.error, /dispatch failed/);
    failure(await f.handle('execute', request), 'PLAN_INVALID'); assert.equal(f.calls.execute.length, 1);
});

test('agent task observations bind task IDs and return a bounded tail or explicitly no log', async () => {
    const f = fixture(); assert.equal(success(await f.handle('task')), null);
    failure(await f.handle('task', { taskId: 'missing' }), 'TASK_NOT_FOUND');
    f.state.task = task({ log: 'x'.repeat(9000) + 'tail' });
    const tail = success(await f.handle('task', { taskId: 'task-1', logLimit: 4 }));
    assert.equal(tail.log, 'tail'); assert.equal(tail.logTruncated, true); assert.equal(tail.requiresPolling, true);
    assert.equal(success(await f.handle('task', { logLimit: 0 })).log, '');
    assert.equal(success(await f.handle('task', { logLimit: 8000 })).log.length, 8000);
    f.state.task.status = 'success'; assert.equal(success(await f.handle('task')).requiresPolling, false);
    assert.equal(failure(await f.handle('task', { taskId: 'other' }), 'TASK_NOT_FOUND').refreshRequired, true);
});

test('agent navigation binds repository and reports request dispatch without claiming an opened editor', async () => {
    const f = fixture();
    const described = success(await f.handle('navigate', { path: 'assets/a.ts.meta', action: 'describe' }, 'nested'));
    assert.equal(described.asset, 'assets/a.ts'); assert.equal(described.openRequested, undefined);
    const opened = success(await f.handle('navigate', { path: 'assets/a.ts', action: 'open' }, 'nested'));
    assert.equal(opened.openRequested, true); assert.equal(opened.opened, undefined);
    assert.equal(success(await f.handle('navigate', { path: 'assets/a.ts', action: 'reveal' })).revealRequested, true);
    assert.deepEqual(f.calls.navigate[0], { repo: 'nested', path: 'assets/a.ts.meta', action: 'describe' });
    failure(await f.handle('navigate', { path: 'assets/a.ts', action: 'restore' }), 'INVALID_REQUEST');
    failure(await f.handle('navigate', { path: 'bad\0path', action: 'describe' }), 'INVALID_REQUEST');
    assert.equal(f.calls.navigate.length, 3);
});

test('agent backend failures return structured bounded errors and distinguish describe from navigation side effects', async () => {
    const f = fixture(); f.state.hooks.snapshot = async () => { throw new Error('e'.repeat(9000)); };
    const failed = failure(await f.handle('status'), 'OPERATION_FAILED');
    assert.equal(failed.error.length, 8000); assert.equal(failed.refreshRequired, true); assert.equal(failed.op, 'status');
    f.state.hooks.navigate = async () => { throw new Error('navigation rejected'); };
    failure(await f.handle('navigate', { path: 'assets/a.ts', action: 'describe' }), 'OPERATION_FAILED');
    failure(await f.handle('navigate', { path: 'assets/a.ts', action: 'open' }), 'OPERATION_FAILED', true);
    failure(await f.handle('navigate', { path: 'assets/a.ts', action: 'reveal' }), 'OPERATION_FAILED', true);
    assert.deepEqual(f.calls.execute, []);
});

test('agent tags validates bounded independent pagination without a repository scan', async () => {
    const f = fixture();
    const page = success(await f.handle('tags', { text: 'release', limit: 20 }));
    assert.equal(page.version, 'tags-v1'); assert.equal(f.calls.snapshot.length, 0);
    assert.deepEqual(f.calls.tags[0], { repo: '.', query: { kind: 'tags', offset: 0, limit: 20, text: 'release', version: undefined } });
    failure(await f.handle('tags', { offset: 100 }), 'STATE_CHANGED');
    for (const extra of [{ limit: 201 }, { offset: -1 }, { text: 'a\0b' }, { force: true }]) failure(await f.handle('tags', extra), 'INVALID_REQUEST');
    assert.equal(f.calls.tags.length, 1);
});

test('agent tags reports stale refs, busy and service failure without claiming side effects', async () => {
    const f = fixture();
    f.state.hooks.tags = () => { throw new TagStateChangedError('changed'); };
    const stale = failure(await f.handle('tags', { offset: 100, version: 'old' }), 'STATE_CHANGED');
    assert.equal(stale.refreshRequired, true);
    f.state.task = task(); failure(await f.handle('tags'), 'BUSY'); assert.equal(f.calls.tags.length, 1);
    f.state.task = null; f.state.hooks.tags = () => { throw new Error('unavailable'); };
    failure(await f.handle('tags'), 'OPERATION_FAILED');
});

test('agent tag writes preserve exact object and annotation in shared reviewed plan flow', async () => {
    const f = fixture(), object = 'b'.repeat(40), commit = 'a'.repeat(40);
    const created = await preview(f, { action: 'createTag', tag: 'v1', tagKind: 'annotated', revision: commit, message: '# release\n\n原文' });
    assert.equal(f.calls.prepare[0].tagKind, 'annotated'); assert.equal(f.calls.prepare[0].revision, commit);
    assert.equal(f.calls.prepare[0].message, '# release\n\n原文');
    success(await f.handle('execute', { token: created.plan.token, digest: created.digest }));
    f.state.task = null;
    const deleted = await preview(f, { action: 'deleteTag', tag: 'v1', tagObject: object });
    assert.equal(f.calls.prepare[1].tagObject, object);
    failure(await f.handle('execute', { token: deleted.plan.token, digest: 'wrong' }), 'PLAN_INVALID');
    failure(await f.handle('prepare', { operation: operation({ action: 'createTag', tagKind: 'signed' }) }), 'INVALID_REQUEST');
});

test('agent tree binds pinned commit and directory with bounded defaults and no state scan', async () => {
    const f = fixture(), revision = 'a'.repeat(40);
    const page = success(await f.handle('tree', { revision, directory: 'assets', text: '中文' }));
    assert.equal(page.revision, revision); assert.equal(page.directory, 'assets');
    assert.equal(f.calls.snapshot.length, 0);
    assert.deepEqual(f.calls.tree[0], { repo: '.', query: { kind: 'tree', revision, directory: 'assets', text: '中文', offset: 0, limit: 100, version: undefined } });
    const capabilities = success(await f.handle('capabilities')); assert.ok(capabilities.operations.includes('tree')); assert.equal(capabilities.limits.treeDirectoryEntries, 20000);
});

test('agent tree rejects expressions, malformed pages and unknown fields before service reads', async () => {
    const f = fixture(), revision = 'a'.repeat(40);
    for (const extra of [{ revision: 'HEAD' }, { revision, limit: 201 }, { revision, directory: 'a\0b' }, { revision, text: false }, { revision, force: true }]) failure(await f.handle('tree', extra), 'INVALID_REQUEST');
    failure(await f.handle('tree', { revision, offset: 100 }), 'STATE_CHANGED');
    assert.equal(f.calls.tree.length, 0);
});

test('agent tree reports stable snapshot failures and busy state without writes', async () => {
    const f = fixture(), revision = 'a'.repeat(40);
    f.state.hooks.tree = () => { throw new TreeStateChangedError('changed query'); };
    const stale = failure(await f.handle('tree', { revision, offset: 100, version: 'old' }), 'STATE_CHANGED'); assert.equal(stale.refreshRequired, true);
    f.state.task = task(); failure(await f.handle('tree', { revision }), 'BUSY');
    assert.equal(f.calls.tree.length, 1); assert.deepEqual(f.calls.execute, []); assert.deepEqual(f.calls.prepare, []);
});

test('agent advertises whole-file selected stash semantics and retains explicit paths in preview', async () => {
    const f = fixture(), capabilities = success(await f.handle('capabilities'));
    assert.ok(capabilities.actions.includes('stashSelected'));
    assert.equal(capabilities.actionParameters.stashSelected.includesIndexAndWorktree, true);
    assert.equal(capabilities.actionParameters.stashSelected.rejectsStagedOutsideScope, true);
    const result = await preview(f, { action: 'stashSelected', paths: ['assets/a.ts'], includeUntracked: true, message: '保存当前任务' });
    assert.deepEqual(f.calls.prepare[0].paths, ['assets/a.ts']); assert.equal(f.calls.prepare[0].includeUntracked, true);
    assert.deepEqual(result.plan.paths, ['assets/a.ts']);
    success(await f.handle('execute', { token: result.plan.token, digest: result.digest })); assert.equal(f.calls.execute.length, 1);
});

test('agent selected stash validation rejects malformed paths and preserves service safety failures', async () => {
    const f = fixture();
    for (const paths of ['all', [null], Array(5001).fill('a')]) failure(await f.handle('prepare', { operation: operation({ action: 'stashSelected', paths }) }), 'INVALID_REQUEST');
    f.state.hooks.prepare = () => { throw new Error('范围外有已暂存文件'); };
    const failed = failure(await f.handle('prepare', { operation: operation({ action: 'stashSelected', paths: ['a'] }) }), 'OPERATION_FAILED');
    assert.match(failed.error, /已暂存/); assert.deepEqual(f.calls.execute, []);
});

test('agent merge read exposes independent operation version without executing or scanning twice', async () => {
    const f = fixture(), state = success(await f.handle('merge'));
    assert.equal(state.repoVersion, 'v1'); assert.equal(state.version, 'merge-v1'); assert.equal(state.canFinish, true);
    assert.deepEqual(f.calls.merge, ['.']); assert.deepEqual(f.calls.snapshot, []); assert.deepEqual(f.calls.execute, []);
    const capabilities = success(await f.handle('capabilities')); assert.equal(capabilities.actionParameters.finishMerge.entireIndex, true); assert.equal(capabilities.actionParameters.finishMerge.acceptsPaths, false);
});

test('agent finishMerge passes exact context and message through reviewed one-time execution', async () => {
    const f = fixture();
    const reviewed = await preview(f, { action: 'finishMerge', mergeVersion: 'merge-v1', message: '合并\n# 原文', paths: undefined });
    assert.equal(f.calls.prepare[0].mergeVersion, 'merge-v1'); assert.equal(f.calls.prepare[0].message, '合并\n# 原文');
    success(await f.handle('execute', { token: reviewed.plan.token, digest: reviewed.digest }));
    failure(await f.handle('execute', { token: reviewed.plan.token, digest: reviewed.digest }), 'PLAN_INVALID');
});

test('agent merge rejects extra fields/busy reads and reports stale preparation as STATE_CHANGED', async () => {
    const f = fixture(); failure(await f.handle('merge', { force: true }), 'INVALID_REQUEST');
    f.state.task = task(); failure(await f.handle('merge'), 'BUSY'); f.state.task = null;
    f.state.hooks.prepare = () => { throw new MergeStateChangedError('合并索引已变化'); };
    const result = failure(await f.handle('prepare', { operation: operation({ action: 'finishMerge', mergeVersion: 'old', message: 'merge' }) }), 'STATE_CHANGED');
    assert.equal(result.refreshRequired, true); assert.deepEqual(f.calls.execute, []);
});


test('agent remote discovery documents bounded queries and atomic local configuration actions', async () => {
    const f = fixture(), caps = success(await f.handle('capabilities'));
    assert.ok(caps.operations.includes('remotes')); assert.equal(caps.limits.remotePageSize, 50);
    for (const action of ['addRemote', 'setRemoteUrl', 'setRemotePushUrl', 'resetRemotePushUrl']) {
        assert.equal(caps.actionParameters[action].connectsRemote, false);
        assert.ok(caps.actionParameters[action].required.includes('remoteVersion'));
    }
    const result = success(await f.handle('remotes', { offset: 0, limit: 5 }));
    assert.equal(result.remoteVersion, 'c'.repeat(64)); assert.equal(f.calls.remotes[0].query.limit, 5);
    assert.deepEqual(f.calls.snapshot, []);
});

test('agent remote requests reject unknown fields, oversized pages and busy reads; stale state is classified', async () => {
    const f = fixture();
    failure(await f.handle('remotes', { shell: 'git remote' }), 'INVALID_REQUEST');
    failure(await f.handle('remotes', { limit: 51 }), 'INVALID_REQUEST');
    f.state.task = task(); failure(await f.handle('remotes'), 'BUSY');
    assert.deepEqual(f.calls.remotes, []); f.state.task = null;
    f.state.hooks.remotes = () => { throw new RemoteStateChangedError('remote changed'); };
    const result = failure(await f.handle('remotes'), 'STATE_CHANGED'); assert.equal(result.refreshRequired, true);
});

test('agent remote write parameters are included in the complete plan digest and execute once', async () => {
    const f = fixture(), fields = { action: 'setRemoteUrl', paths: undefined, remote: 'origin', remoteVersion: 'c'.repeat(64), url: 'https://host/team/repo.git' };
    const p = await preview(f, fields);
    assert.equal(f.calls.prepare[0].url, fields.url); assert.equal(f.calls.prepare[0].remoteVersion, fields.remoteVersion);
    assert.equal(p.digest, createHash('sha256').update(JSON.stringify(p.plan)).digest('hex'));
    success(await f.handle('execute', { token: p.plan.token, digest: p.digest }));
    failure(await f.handle('execute', { token: p.plan.token, digest: p.digest }), 'PLAN_INVALID');
    assert.equal(f.calls.execute.length, 1);
});


test('agent file comparison discovers read-only bounded snapshots and forwards pinned paths', async () => {
    const f = fixture(), caps = success(await f.handle('capabilities'));
    assert.ok(caps.operations.includes('fileCompare')); assert.equal(caps.limits.fileComparisonCharacters, 16000);
    const left = { revision: 'a'.repeat(40), path: 'old/file.txt' }, right = { revision: 'b'.repeat(40), path: 'new/file.txt' };
    success(await f.handle('fileCompare', { left, right }));
    assert.deepEqual(f.calls.fileCompare[0], { repo: '.', query: { left, right, view: 'summary', offset: 0, limit: 8000, version: undefined, force: false } });
    assert.deepEqual(f.calls.prepare, []); assert.deepEqual(f.calls.execute, []);
});

test('agent file comparison rejects expressions, extra endpoint fields and excessive fragments', async () => {
    const f = fixture(), edge = { revision: 'a'.repeat(40), path: 'file.txt' };
    failure(await f.handle('fileCompare', { left: { ...edge, revision: 'HEAD' }, right: edge }), 'INVALID_REQUEST');
    failure(await f.handle('fileCompare', { left: { ...edge, shell: 'git' }, right: edge }), 'INVALID_REQUEST');
    failure(await f.handle('fileCompare', { left: edge, right: edge, limit: 16001 }), 'INVALID_REQUEST');
    failure(await f.handle('fileCompare', { left: edge, right: edge, view: 'image-base64' }), 'INVALID_REQUEST');
    failure(await f.handle('fileCompare', { left: edge, right: edge, force: 'yes' }), 'INVALID_REQUEST');
    assert.deepEqual(f.calls.fileCompare, []);
});

test('agent file comparison fragments require versions and return state-changed or busy explicitly', async () => {
    const f = fixture(), edge = { revision: 'a'.repeat(40), path: 'file.txt' };
    failure(await f.handle('fileCompare', { left: edge, right: edge, view: 'after', offset: 1 }), 'STATE_CHANGED');
    f.state.task = task(); failure(await f.handle('fileCompare', { left: edge, right: edge }), 'BUSY'); f.state.task = null;
    f.state.hooks.fileCompare = () => { throw new FileComparisonStateChangedError('comparison changed'); };
    const result = failure(await f.handle('fileCompare', { left: edge, right: edge }), 'STATE_CHANGED'); assert.equal(result.refreshRequired, true);
});

test('agent file comparison forwards exact fragment boundaries, force and comparison version', async () => {
    const f = fixture(), edge = { revision: 'a'.repeat(40), path: '[literal].txt' };
    success(await f.handle('fileCompare', { left: edge, right: edge, view: 'patch', offset: 12000, limit: 4000, version: 'f'.repeat(64), force: true }));
    const query = f.calls.fileCompare[0].query;
    assert.equal(query.offset, 12000); assert.equal(query.limit, 4000); assert.equal(query.force, true); assert.equal(query.version, 'f'.repeat(64));
    assert.equal(query.left.path, '[literal].txt'); assert.deepEqual(f.calls.execute, []);
});


test('agent reflog discovery describes local event pages and pinned branch recovery', async () => {
    const f = fixture(), caps = success(await f.handle('capabilities'));
    assert.ok(caps.operations.includes('reflog')); assert.equal(caps.limits.reflogRecentEntries, 1000);
    assert.equal(caps.actionParameters.createBranchAt.switchesBranch, false); assert.equal(caps.actionParameters.createBranchAt.minimumGit, '2.54');
    success(await f.handle('reflog'));
    assert.deepEqual(f.calls.reflog[0], { repo: '.', query: { kind: 'reflog', ref: 'HEAD', text: '', offset: 0, limit: 20, version: undefined } });
    assert.deepEqual(f.calls.prepare, []); assert.deepEqual(f.calls.execute, []);
});

test('agent reflog paging rejects missing versions, oversized pages and busy reads', async () => {
    const f = fixture();
    failure(await f.handle('reflog', { offset: 1 }), 'STATE_CHANGED');
    failure(await f.handle('reflog', { limit: 101 }), 'INVALID_REQUEST');
    failure(await f.handle('reflog', { command: 'git' }), 'INVALID_REQUEST');
    f.state.task = task(); failure(await f.handle('reflog'), 'BUSY'); f.state.task = null;
    assert.deepEqual(f.calls.reflog, []);
    f.state.hooks.reflog = () => { throw new ReflogStateChangedError('changed log'); };
    const result = failure(await f.handle('reflog'), 'STATE_CHANGED'); assert.equal(result.refreshRequired, true);
});

test('agent reflog forwards a literal local source, filter and independent page version', async () => {
    const f = fixture();
    success(await f.handle('reflog', { ref: 'refs/heads/topic', text: '[literal]', offset: 20, limit: 20, version: 'c'.repeat(64) }));
    assert.deepEqual(f.calls.reflog[0].query, { kind: 'reflog', ref: 'refs/heads/topic', text: '[literal]', offset: 20, limit: 20, version: 'c'.repeat(64) });
});

test('agent discovers and forwards remote-tracking reflog sources without write calls', async () => {
    const f = fixture(), caps = success(await f.handle('capabilities'));
    assert.match(caps.reads.reflog, /refs\/remotes/);
    success(await f.handle('reflog', { ref: 'refs/remotes/offline/topic' }));
    assert.equal(f.calls.reflog[0].query.ref, 'refs/remotes/offline/topic');
    assert.deepEqual(f.calls.prepare, []); assert.deepEqual(f.calls.execute, []);
});

test('agent pinned branch recovery uses the shared full preview digest and one-time execution', async () => {
    const f = fixture(), p = await preview(f, { action: 'createBranchAt', branch: 'recovery/topic', revision: 'b'.repeat(40), paths: undefined });
    assert.equal(f.calls.prepare[0].branch, 'recovery/topic'); assert.equal(f.calls.prepare[0].revision, 'b'.repeat(40));
    assert.equal(p.digest, createHash('sha256').update(JSON.stringify(p.plan)).digest('hex'));
    success(await f.handle('execute', { token: p.plan.token, digest: p.digest }));
    failure(await f.handle('execute', { token: p.plan.token, digest: p.digest }), 'PLAN_INVALID'); assert.equal(f.calls.execute.length, 1);
});


test('status exposes detached versus unborn independently of branch-name presence', async () => {
    const f = fixture();
    f.state.repos = [repository('.', { branch: '' })];
    assert.equal(success(await f.bridge.handle('.', query('status'))).repository.headState, 'detached');
    f.state.repos = [repository('.', { branch: 'new', head: '' })];
    assert.equal(success(await f.bridge.handle('.', query('status'))).repository.headState, 'unborn');
});

test('repository summaries expose failed and missing repository state without classifying as detached', async () => {
    const f = fixture();
    f.state.repos = [repository('.', { error: 'failed' }), repository('missing', { initialized: false, branch: '', head: '' })];
    const result = success(await f.bridge.handle('.', query('repositories')));
    assert.deepEqual(result.repositories.map(repo => repo.headState), ['unavailable', 'unavailable']);
});

test('capabilities explain all HEAD states without adding background service calls', async () => {
    const f = fixture();
    const result = success(await f.bridge.handle('.', query('capabilities')));
    assert.deepEqual(Object.keys(result.headStates).sort(), ['attached', 'detached', 'unavailable', 'unborn']);
    assert.match(result.headStates.detached, /createBranchAt/);
    assert.equal(f.calls.snapshot.length, 0); assert.equal(f.calls.prepare.length, 0);
});


test('capability discovery without local backups explains recovery write scope and bounds', async () => {
    const f=fixture(),caps=success(await f.handle('capabilities'));
    for(const action of ['discardFiles','restoreFiles']) {
        assert.equal(caps.actionParameters[action].alwaysBacksUp,false);
        assert.equal(caps.actionParameters[action].preservesIndex,true);
        assert.equal(caps.actionParameters[action].maxPaths,50);
    }
    assert.deepEqual(f.calls.backups,[]);
});


test('merge discovery distinguishes pending initiation and journal-backed abort from completion',async()=>{
    const f=fixture(),caps=success(await f.handle('capabilities'));
    assert.equal(caps.actionParameters.beginMerge.automaticCommit,false);assert.equal(caps.actionParameters.beginMerge.fastForward,false);assert.equal(caps.actionParameters.beginMerge.requiresCleanTree,true);
    assert.equal(caps.actionParameters.abortMerge.alwaysBacksUp,false);assert.equal(caps.actionParameters.abortMerge.reads,'merge.abortVersion');
});

test('agent merge state forwards independent finish and abort versions and eligibility',async()=>{
    const f=fixture();f.state.hooks.merge=async()=>({active:true,canFinish:false,version:'finish-v',canAbort:true,abortVersion:'abort-v',abortReason:'journal matched'});
    const result=success(await f.handle('merge'));assert.equal(result.version,'finish-v');assert.equal(result.abortVersion,'abort-v');assert.equal(result.canAbort,true);assert.equal(result.canFinish,false);
});

test('merge initiation passes pinned SHA through the existing full-plan review contract',async()=>{
    const f=fixture(),revision='b'.repeat(40),plan=success(await f.handle('prepare',{operation:{action:'beginMerge',version:'v1',revision}}));
    assert.equal(f.calls.prepare[0].revision,revision);assert.equal(plan.requiresReview,true);assert.deepEqual(f.calls.execute,[]);
    success(await f.handle('execute',{token:plan.plan.token,digest:plan.digest}));assert.equal(f.calls.execute.length,1);
});

test('merge abort uses mergeVersion and rejects stale digest execution without service writes',async()=>{
    const f=fixture(),plan=success(await f.handle('prepare',{operation:{action:'abortMerge',version:'v1',mergeVersion:'abort-v'}}));assert.equal(f.calls.prepare[0].mergeVersion,'abort-v');
    failure(await f.handle('execute',{token:plan.plan.token,digest:'0'.repeat(64)}),'PLAN_INVALID');assert.deepEqual(f.calls.execute,[]);
});


test('agent discovers saved-disk comparison with raw semantics, zero cache and bounded reads', async () => {
    const f = fixture(), caps = success(await f.handle('capabilities'));
    assert.ok(caps.operations.includes('worktreeCompare')); assert.equal(caps.limits.worktreeComparisonFileBytes, 5242880);
    assert.equal(caps.limits.worktreeComparisonCacheMs, 0); assert.match(caps.reads.worktreeCompare, /no editor buffers/);
    const left = { revision: 'a'.repeat(40), path: 'old.txt' };
    const result = success(await f.handle('worktreeCompare', { left, path: 'new.txt' }));
    assert.deepEqual(f.calls.worktreeCompare[0], { repo: '.', query: { left, path: 'new.txt', view: 'summary', offset: 0, limit: 8000, version: undefined } });
    assert.equal(result.comparison.diskOnly, true); assert.equal(result.comparison.normalization, 'raw'); assert.equal(result.cachedUpToMs, 0);
    assert.deepEqual(f.calls.prepare, []); assert.deepEqual(f.calls.execute, []);
});

test('agent saved-disk comparison rejects unpinned sources, extra fields and invalid fragments', async () => {
    const f = fixture(), left = { revision: 'a'.repeat(40), path: 'file.txt' };
    for (const extra of [{ left: { ...left, revision: 'HEAD' } }, { left: { ...left, extra: true } }, { path: '' }, { right: left }, { force: true }, { limit: 16001 }, { view: 'image' }, { version: 'short' }, { view: 'summary', offset: 1 }]) {
        failure(await f.handle('worktreeCompare', { left, path: 'file.txt', ...extra }), 'INVALID_REQUEST');
    }
    assert.deepEqual(f.calls.worktreeCompare, []);
});

test('agent saved-disk comparison forwards cross-path fragment boundaries with exact version', async () => {
    const f = fixture(), left = { revision: 'a'.repeat(64), path: 'old/[literal].txt' }, version = 'd'.repeat(64);
    success(await f.handle('worktreeCompare', { left, path: 'new/文件.txt', view: 'after', offset: 16000, limit: 4000, version }));
    assert.deepEqual(f.calls.worktreeCompare[0].query, { left, path: 'new/文件.txt', view: 'after', offset: 16000, limit: 4000, version });
    assert.deepEqual(f.calls.fileCompare, []); assert.deepEqual(f.calls.execute, []);
});

test('agent saved-disk comparison reports missing page version, busy tasks and edited snapshots safely', async () => {
    const f = fixture(), params = { left: { revision: 'a'.repeat(40), path: 'file.txt' }, path: 'file.txt' };
    failure(await f.handle('worktreeCompare', { ...params, view: 'after', offset: 1 }), 'STATE_CHANGED');
    f.state.task = task(); failure(await f.handle('worktreeCompare', params), 'BUSY'); f.state.task = null;
    f.state.hooks.worktreeCompare = () => { throw new FileComparisonStateChangedError('disk changed'); };
    const reply = failure(await f.handle('worktreeCompare', params), 'STATE_CHANGED'); assert.equal(reply.refreshRequired, true);
    assert.deepEqual(f.calls.prepare, []); assert.deepEqual(f.calls.execute, []);
});


test('agent discovers exact stage-zero index comparison and forwards pinned source without writes', async () => {
    const f = fixture(), caps = success(await f.handle('capabilities')), left = { revision: 'a'.repeat(40), path: 'old.txt' };
    assert.ok(caps.operations.includes('indexCompare')); assert.equal(caps.limits.indexComparisonCacheMs, 0); assert.equal(caps.limits.indexComparisonFileBytes, 5242880);
    assert.match(caps.reads.indexCompare, /excluding disk edits/); assert.match(caps.reads.indexCompare, /intent-to-add rejected/);
    const result = success(await f.handle('indexCompare', { left, path: 'new.txt' }));
    assert.deepEqual(f.calls.indexCompare[0], { repo: '.', query: { left, path: 'new.txt', view: 'summary', offset: 0, limit: 8000, version: undefined } });
    assert.equal(result.comparison.indexOnly, true); assert.equal(result.comparison.right.stage, 0); assert.equal(result.cachedUpToMs, 0);
    assert.deepEqual(f.calls.prepare, []); assert.deepEqual(f.calls.execute, []);
});

test('agent index comparison rejects expressions, unknown endpoints and invalid fragments', async () => {
    const f = fixture(), left = { revision: 'a'.repeat(40), path: 'file.txt' };
    for (const extra of [{ left: { ...left, revision: 'HEAD' } }, { left: { ...left, extra: true } }, { path: '' }, { right: left }, { force: true }, { limit: 16001 }, { view: 'image' }, { version: 'short' }, { view: 'summary', offset: 1 }]) failure(await f.handle('indexCompare', { left, path: 'file.txt', ...extra }), 'INVALID_REQUEST');
    assert.deepEqual(f.calls.indexCompare, []);
});

test('agent index comparison forwards exact cross-path fragment and entry-bound version', async () => {
    const f = fixture(), left = { revision: 'a'.repeat(64), path: 'old/[literal].txt' }, version = 'e'.repeat(64);
    success(await f.handle('indexCompare', { left, path: 'new/文件.txt', view: 'after', offset: 16000, limit: 4000, version }));
    assert.deepEqual(f.calls.indexCompare[0].query, { left, path: 'new/文件.txt', view: 'after', offset: 16000, limit: 4000, version });
    assert.deepEqual(f.calls.worktreeCompare, []); assert.deepEqual(f.calls.fileCompare, []);
});

test('agent index comparison reports missing versions, busy tasks and restaging without side effects', async () => {
    const f = fixture(), params = { left: { revision: 'a'.repeat(40), path: 'file.txt' }, path: 'file.txt' };
    failure(await f.handle('indexCompare', { ...params, view: 'after', offset: 1 }), 'STATE_CHANGED');
    f.state.task = task(); failure(await f.handle('indexCompare', params), 'BUSY'); f.state.task = null;
    f.state.hooks.indexCompare = () => { throw new FileComparisonStateChangedError('restaged'); };
    const reply = failure(await f.handle('indexCompare', params), 'STATE_CHANGED'); assert.equal(reply.refreshRequired, true);
    assert.deepEqual(f.calls.prepare, []); assert.deepEqual(f.calls.execute, []);
});


test('agent stash file recovery discovery distinguishes parts, worktree writes and retained index and stash', async () => {
    const f=fixture(),caps=success(await f.handle('capabilities')),params=caps.actionParameters.restoreStashFiles;
    assert.deepEqual(params.required,['version','paths','stashRef','revision','stashPart']);assert.deepEqual(params.stashParts,['tracked','index','untracked']);
    assert.equal(params.preservesIndex,true);assert.equal(params.preservesStash,true);assert.equal(params.alwaysBacksUp,false);assert.equal(params.maxPaths,50);
    assert.equal(params.rejectsDeletionEntries,true);assert.equal(params.automaticRetry,false);assert.deepEqual(f.calls.prepare,[]);
});

test('agent stash recovery forwards complete pinned source and part only to reviewed prepare', async () => {
    const f=fixture(),operation={version:'v1',action:'restoreStashFiles',paths:['assets/a.ts'],stashRef:'stash@{0}',revision:'a'.repeat(40),stashPart:'index'};
    const prepared=success(await f.handle('prepare',{operation}));
    assert.deepEqual(f.calls.prepare[0],{...operation,repo:'.'});assert.equal(prepared.requiresReview,true);assert.deepEqual(f.calls.execute,[]);
    failure(await f.handle('execute',{token:prepared.plan.token,digest:'0'.repeat(64)}),'PLAN_INVALID');assert.deepEqual(f.calls.execute,[]);
});

test('agent stash recovery rejects invalid part values before service calls', async () => {
    const f=fixture();
    for(const stashPart of ['all','worktree',true,{},''])failure(await f.handle('prepare',{operation:{version:'v1',action:'restoreStashFiles',paths:['file.txt'],stashRef:'stash@{0}',revision:'a'.repeat(40),stashPart}}),'INVALID_REQUEST');
    assert.deepEqual(f.calls.prepare,[]);assert.deepEqual(f.calls.execute,[]);
});

test('agent stash identity changes require refreshing without automatic writes', async () => {
    const f=fixture();f.state.hooks.prepare=()=>{throw new StashStateChangedError('stash reordered');};
    const reply=failure(await f.handle('prepare',{operation:{version:'v1',action:'restoreStashFiles',paths:['file.txt'],stashRef:'stash@{0}',revision:'a'.repeat(40),stashPart:'tracked'}}),'STATE_CHANGED');
    assert.equal(reply.refreshRequired,true);assert.deepEqual(f.calls.execute,[]);
});


test('agent line discard capability declares full-file backup and unstaged-only bounded scope',async()=>{
    const f=fixture(),caps=success(await f.handle('capabilities')),params=caps.actionParameters.discardLines;
    assert.deepEqual(params.required,['version','lines']);assert.equal(params.worktreeOnly,true);assert.equal(params.preservesIndex,true);assert.equal(params.preservesUnselectedContent,true);assert.equal(params.alwaysBacksUp,false);
    assert.equal(params.maxPaths,1);assert.equal(params.patchJsonBytes,131072);assert.equal(params.expandsAssetMeta,false);assert.equal(params.automaticRetry,false);assert.deepEqual(f.calls.prepare,[]);
});

test('agent selected line discard forwards precise selection only to reviewed prepare',async()=>{
    const f=fixture(),operation={version:'v1',action:'discardLines',lines:{path:'assets/a.ts',version:'a'.repeat(64),ids:['0:2','0:3']}};
    const prepared=success(await f.handle('prepare',{operation}));assert.equal(prepared.requiresReview,true);assert.deepEqual(f.calls.prepare[0],{...operation,repo:'.'});assert.deepEqual(f.calls.execute,[]);
    failure(await f.handle('execute',{token:prepared.plan.token,digest:'0'.repeat(64)}),'PLAN_INVALID');assert.deepEqual(f.calls.execute,[]);
});

test('agent line discard rejects malformed selections and reports source changes without executing',async()=>{
    const f=fixture(),operation={version:'v1',action:'discardLines',lines:{path:'file.txt',version:'a'.repeat(64),ids:['0:2']}};
    for(const lines of [{...operation.lines,ids:[]},{...operation.lines,ids:[null]},{...operation.lines,extra:true},{...operation.lines,path:''}])failure(await f.handle('prepare',{operation:{...operation,lines}}),'INVALID_REQUEST');
    const {FileStateChangedError}=require('../dist/types');f.state.hooks.prepare=()=>{throw new FileStateChangedError('selected lines changed');};
    const reply=failure(await f.handle('prepare',{operation}),'STATE_CHANGED');assert.equal(reply.refreshRequired,true);assert.deepEqual(f.calls.execute,[]);
});

test('removed backup operations and request fields are rejected before preparation', async () => {
    const f=fixture(),caps=success(await f.handle('capabilities'));
    assert.equal(caps.operations.includes('backups'),false);
    assert.equal(caps.actions.includes('restoreBackup'),false);
    failure(await f.handle('backups'),'UNSUPPORTED_OPERATION');
    failure(await f.handle('prepare',{operation:{action:'restoreBackup',version:'v1'}}),'UNSUPPORTED_ACTION');
    failure(await f.handle('prepare',{operation:{action:'discardFiles',version:'v1',paths:['file.txt'],backupId:'old'}}),'INVALID_REQUEST');
    assert.equal(f.calls.prepare.length,0);
});

test('task-scope replies and prepare are compact by default and complete with verbose', async () => {
    const f = fixture();
    const file = { path: 'assets/a.ts', index: ' ', worktree: 'M', conflict: false, submodule: false, fingerprint: 'fp-1', workingFingerprint: 'wf-1', workingObject: 'o'.repeat(40), indexObject: 'i'.repeat(40), classification: 'observedSinceStart', inScope: true, humanReviewed: false };
    const review = { id: 't1', repo: '.', snapshotVersion: 'v1', headChanged: false, canProceed: true, humanReviewRequired: false, reviewPolicySource: 'default', files: [file, { ...file, path: 'assets/b.ts', classification: 'preExisting', inScope: false }], resolvedPaths: ['assets/a.ts'], candidatePaths: [], blockers: [], ownership: 'observed changes are not proof of authorship' };
    const scopeCalls = [];
    Object.assign(f.bridge.service, { scopeStart: async () => review, scopeList: async () => [], scopeReview: async (...args) => { scopeCalls.push(args); return review; } });
    const compact = success(await f.handle('scopeChanges', { id: 't1' }));
    assert.equal(compact.compact, true); assert.deepEqual(compact.summary, { files: 2, inScope: 1, byClassification: { observedSinceStart: 1, preExisting: 1 }, blockers: 0 });
    assert.deepEqual(compact.files[0], { path: 'assets/a.ts', index: ' ', worktree: 'M', classification: 'observedSinceStart', inScope: true, humanReviewed: false });
    assert.equal(compact.canProceed, true); assert.deepEqual(compact.resolvedPaths, ['assets/a.ts']);
    const full = success(await f.handle('commitCheck', { id: 't1', verbose: true }));
    assert.equal(full.compact, undefined); assert.equal(full.files[0].fingerprint, 'fp-1'); assert.equal(full.files[0].workingObject, 'o'.repeat(40));
    failure(await f.handle('scopeChanges', { id: 't1', verbose: 'yes' }), 'INVALID_REQUEST');
    f.state.hooks.prepare = input => ({ token: 'token-p', title: 'Discard lines', description: 'x', paths: [...input.paths], warnings: [], expiresAt: Date.now() + 60000, patch: 'diff --git a/x b/x\n' });
    const prepared = success(await f.handle('prepare', { operation: operation({ action: 'stage' }), taskId: 't1' }));
    assert.equal(prepared.plan.patch, undefined); assert.equal(prepared.plan.patchBytes, 19); assert.equal(prepared.plan.compact, true); assert.equal(prepared.scopeReview.compact, true);
    assert.equal(prepared.digest, createHash('sha256').update(JSON.stringify({ token: 'token-p', title: 'Discard lines', description: 'x', paths: ['assets/a.ts'], warnings: [], expiresAt: prepared.plan.expiresAt, patch: 'diff --git a/x b/x\n' })).digest('hex'), 'the digest still covers the full plan');
    const verbosePlan = success(await f.handle('prepare', { operation: operation({ action: 'stage' }), taskId: 't1', verbose: true }));
    assert.equal(verbosePlan.plan.patch, 'diff --git a/x b/x\n'); assert.equal(verbosePlan.scopeReview.files[0].fingerprint, 'fp-1');
});

test('execute waits for its task, task_status long-polls, and busy callers queue behind a running task', async () => {
    const f = fixture({ queueMs: 2000, waitMs: 2000, pollMs: 2000 });
    const first = await preview(f);
    f.state.hooks.execute = () => { f.state.task = task(); setTimeout(() => { f.state.task.status = 'success'; }, 60); return f.state.task; };
    const done = success(await f.handle('execute', { token: first.plan.token, digest: first.digest }));
    assert.equal(done.status, 'success'); assert.equal(done.completed, true); assert.equal(done.requiresPolling, false); assert.ok(done.waitedMs >= 50, 'waited for the task');
    const second = await preview(f);
    f.state.hooks.execute = () => { f.state.task = task(); return f.state.task; };
    const immediate = success(await f.handle('execute', { token: second.plan.token, digest: second.digest, wait: false }));
    assert.equal(immediate.status, 'running'); assert.equal(immediate.requiresPolling, true); assert.equal(immediate.waitedMs, 0); assert.match(immediate.note, /waitMs/);
    setTimeout(() => { f.state.task.status = 'failed'; }, 60);
    const polled = success(await f.handle('task', { taskId: 'task-1', waitMs: 1500 }));
    assert.equal(polled.status, 'failed'); assert.equal(polled.requiresPolling, false); assert.ok(polled.waitedMs >= 50);
    f.state.task = task();
    const quick = success(await f.handle('task', { waitMs: 0 })); assert.equal(quick.requiresPolling, true); assert.ok(quick.waitedMs < 50);
    failure(await f.handle('task', { waitMs: 100001 }), 'INVALID_REQUEST');
    failure(await f.handle('execute', { token: 'x', digest: 'y'.repeat(64), wait: 'yes' }), 'INVALID_REQUEST');
    failure(await f.handle('execute', { token: 'x', digest: 'y'.repeat(64), waitMs: 60001 }), 'INVALID_REQUEST');
    setTimeout(() => { f.state.task = null; }, 60);
    const queued = Date.now(); success(await f.handle('prepare', { operation: operation() })); assert.ok(Date.now() - queued >= 50, 'prepare waited for the task to end');
    assert.equal(f.calls.prepare.length, 3);
});

test('commit checks and commit prepares fold the asset/.meta check into the task review', async () => {
    const f = fixture();
    const file = { path: 'assets/a.ts', index: 'M', worktree: ' ', conflict: false, submodule: false, fingerprint: 'fp', classification: 'observedSinceStart', inScope: true, humanReviewed: false };
    const review = { id: 't1', repo: '.', snapshotVersion: 'v1', headChanged: false, canProceed: true, humanReviewRequired: false, reviewPolicySource: 'default', files: [file], resolvedPaths: ['assets/a.ts'], candidatePaths: [], blockers: [], ownership: 'observed changes are not proof of authorship' };
    const metaCalls = []; let blockers = [];
    const actions = f.bridge.service.supportedActions();
    Object.assign(f.bridge.service, { supportedActions: () => [...actions, 'commitSelected'], scopeStart: async () => review, scopeList: async () => [], scopeReview: async () => review, metaCheck: async (repo, options) => { metaCalls.push(options); return { scope: options.scope, blockers, issues: blockers, warnings: [] }; } });
    blockers = [{ code: 'META_MISSING', severity: 'blocker', path: 'assets/a.png.meta', related: 'assets/a.png', message: '资源缺少 .meta' }];
    const check = success(await f.handle('commitCheck', { id: 't1' }));
    assert.equal(check.canProceed, false); assert.deepEqual(check.blockers, [{ code: 'META_MISSING', path: 'assets/a.png.meta', message: '资源缺少 .meta（assets/a.png）' }]); assert.equal(check.meta.scope, 'index'); assert.equal(check.summary.blockers, 1);
    assert.deepEqual(metaCalls, [{ scope: 'index' }]);
    const blocked = failure(await f.handle('prepare', { operation: operation({ action: 'commit', message: 'm' }), taskId: 't1' }), 'META_BLOCKED');
    assert.match(blocked.error, /META_MISSING/);
    blockers = [];
    const ok = success(await f.handle('prepare', { operation: operation({ action: 'commitSelected', message: 'm' }), taskId: 't1' }));
    assert.deepEqual(metaCalls.at(-1), { scope: 'worktree', paths: ['assets/a.ts'] }); assert.equal(ok.scopeReview.canProceed, true);
    success(await f.handle('scopeChanges', { id: 't1' })); success(await f.handle('prepare', { operation: operation({ action: 'stage' }), taskId: 't1' }));
    assert.equal(metaCalls.length, 3, 'task_changes and stage do not run the meta check');
});
