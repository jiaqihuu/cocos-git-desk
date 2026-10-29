const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function fixture(nextReply) {
    const filename = path.resolve(__dirname, '../dist/panel.js'), exports = {}, calls = [];
    let resolve, reject;
    const pending = new Promise((done, fail) => { resolve = done; reject = fail; });
    const context = { exports, require: createRequire(filename), __dirname: path.dirname(filename), Editor: { Message: {
        request: async (pkg, method, ...args) => { calls.push({ method, args }); return nextReply ? nextReply(method, ...args) : pending; },
    } } };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nexports.TestController = Controller;', context, { filename });
    const c = Object.create(exports.TestController.prototype), fields = new Map();
    Object.assign(c, { warningPreferences: { read: () => [] }, closed: false, busy: false, planning: false, epoch: 1, navigationEpoch: 0, repoId: '.', mode: 'working', selectionEpoch: 1,
        selected: new Set(['worktree:a']), selectedLines: new Set(['line']), plan: { token: 'one' }, renders: 0, refreshes: 0, schedules: 0,
        el(id) { if (!fields.has(id)) fields.set(id, { hidden: true, value: '', checked: false, replaceChildren() {} }); return fields.get(id); },
        updateButtons() {}, renderFiles() { this.renders++; }, renderTask(task) { this.busy = task.status === 'running'; },
        async refresh() { this.refreshes++; }, schedule() { this.schedules++; }, error(message) { this.lastError = message; },
    });
    return { c, calls, resolve: task => resolve({ ok: true, data: task }), reject };
}

function prepareState(c) {
    Object.assign(c, { details: { repo: { version: 'v1' }, remoteBranches: [] }, dialogEpoch: 1, diffEpoch: 1,
        workingSelectionLocked: () => false,
        worklist: () => ({ rendered: [{ key: 'worktree:a', area: 'worktree', selectable: true, file: { path: 'a' } }] }),
    });
}

test('double click locates then opens the clicked resource and preserves file selection', async () => {
    for (const area of ['worktree', 'index', 'commit', 'stash', 'compare', 'conflict']) {
        const f = fixture(async (method, repo, file, action) => ({ ok: true, data: { canOpen: true, revealRequested: action === 'reveal', openRequested: action === 'open' } })); prepareState(f.c);
        Object.assign(f.c, { mode: ['worktree', 'index', 'conflict'].includes(area) ? 'working' : area === 'commit' ? 'history' : area,
            selected: new Set(['worktree:other']), closeFileMenu() { this.fileMenuEpoch++; },
            async prepare() { this.prepared = true; },
        });
        f.c.fileMenuEpoch = 1;
        const pending = f.c.doubleClickFile('.', 'assets/target.ts');
        assert.equal(f.calls[0].method, 'reveal');
        assert.deepEqual(Array.from(f.calls[0].args), ['.', 'assets/target.ts', 'reveal']);
        await pending;
        assert.deepEqual(f.calls.map(call => Array.from(call.args)), [['.', 'assets/target.ts', 'reveal'], ['.', 'assets/target.ts', 'open']]);
        assert.deepEqual([...f.c.selected], ['worktree:other']);
        assert.equal(f.c.prepared, undefined); assert.equal(f.calls.length, 2);
    }
});

test('a context action refuses a stale repository version or changed selection before dispatch', async () => {
    for (const changed of ['repo', 'version', 'selection']) {
        const f = fixture(); prepareState(f.c);
        const target = { repo: '.', version: 'v1', selection: 1, workingKey: 'worktree:a' };
        target[changed] = changed === 'selection' ? 2 : 'changed';
        Object.assign(f.c, { fileMenuTarget: target, closeFileMenu() { this.menuClosed = true; }, async prepare() { this.dispatched = true; } });
        await assert.rejects(f.c.runFileAction('stage'), /状态或选择已变化/);
        assert.equal(f.c.dispatched, undefined); assert.equal(f.c.menuClosed, true); assert.equal(f.calls.length, 0);
    }
});

test('submodule context actions scope their pointer permission to the clicked path', async () => {
    for (const area of ['worktree', 'index']) {
        const f = fixture(); prepareState(f.c);
        const key = area + ':module';
        Object.assign(f.c, {
            fileMenuTarget: { repo: '.', file: 'module', version: 'v1', selection: 1, workingKey: key },
            closeFileMenu() {},
            worklist: () => ({ rendered: [{ key, area, selectable: false, file: { path: 'module', submodule: true } }] }),
            async prepare(action, pointerPath) { this.prepared = { action, pointerPath }; },
        });
        await f.c.runFileAction(area === 'index' ? 'unstage' : 'stage');
        assert.deepEqual(f.c.prepared, { action: area === 'index' ? 'unstage' : 'stage', pointerPath: 'module' });
        f.c.prepared = undefined;
        await f.c.runFileAction('discardFiles');
        assert.equal(f.c.prepared, undefined);
        assert.equal(f.calls.length, 0);
    }
});

test('explicit pointer staging always previews and ordinary staging ignores commit pointer consent', async () => {
    for (const pointer of [false, true]) {
        const f = fixture(); prepareState(f.c);
        f.c.el('pointers').checked = true;
        f.c.executePlan = async function(plan) { this.executed = plan.token; };
        if (pointer) f.c.worklist = () => ({ rendered: [{ key: 'worktree:module', area: 'worktree', selectable: false, file: { path: 'module', submodule: true } }] });
        const p = f.c.prepare('stage', pointer ? 'module' : undefined);
        assert.equal(f.calls[0].method, 'prepare');
        assert.deepEqual(Array.from(f.calls[0].args[0].paths), [pointer ? 'module' : 'a']);
        assert.equal(f.calls[0].args[0].includePointers, pointer);
        f.resolve({ token: 'one', paths: [pointer ? 'module' : 'a'], warnings: [], expiresAt: Date.now() + 60000, directIndexAction: 'stage' });
        await p;
        if (pointer) {
            assert.equal(f.c.el('modal').hidden, false);
            assert.deepEqual(f.calls.map(call => call.method), ['prepare']);
            assert.equal(f.c.executed, undefined);
        } else assert.equal(f.c.executed, 'one');
    }
});

test('double clicking an unsupported path reports its reason without navigating repositories or writing Git', async () => {
    const f = fixture(); prepareState(f.c);
    Object.assign(f.c, {
        fileMenuEpoch: 1, closeFileMenu() { this.fileMenuEpoch++; },
        async openSubmodule(file) { this.openedSubmodule = file; },
        async prepare() { this.prepared = true; },
    });
    const pending = f.c.doubleClickFile('.', 'extensions/module');
    f.resolve({ canReveal: false, reason: '仅支持当前 Creator 项目 assets 内的资源。' }); await pending;
    assert.match(f.c.lastError, /assets/);
    assert.equal(f.c.openedSubmodule, undefined);
    assert.equal(f.c.prepared, undefined);
    assert.deepEqual(f.calls.map(call => call.method), ['reveal']);
});

test('a late double-click navigation failure cannot affect a different repository', async () => {
    const f = fixture(); prepareState(f.c);
    Object.assign(f.c, { fileMenuEpoch: 1, closeFileMenu() { this.fileMenuEpoch++; } });
    const pending = f.c.doubleClickFile('.', 'assets/a.ts');
    f.c.repoId = 'child'; f.c.epoch++;
    f.reject(new Error('late navigation error')); await pending;
    assert.equal(f.c.lastError, undefined);
    assert.deepEqual(f.calls.map(call => call.method), ['reveal']);
});

test('double click keeps a blocked resource located without requesting open', async () => {
    const f = fixture(); prepareState(f.c);
    Object.assign(f.c, { fileMenuEpoch: 1, closeFileMenu() { this.fileMenuEpoch++; } });
    const pending = f.c.doubleClickFile('.', 'assets/a.prefab');
    f.resolve({ revealRequested: true, canOpen: false, reason: '请先保存当前场景。' }); await pending;
    assert.match(f.c.lastError, /已定位.*保存/);
    assert.deepEqual(f.calls.map(call => call.args[2]), ['reveal']);
});

test('a stale target or newly started task prevents opening after resource location', async () => {
    for (const changed of ['epoch', 'navigationEpoch', 'diffEpoch', 'busy']) {
        const f = fixture(); prepareState(f.c);
        Object.assign(f.c, { fileMenuEpoch: 1, closeFileMenu() { this.fileMenuEpoch++; } });
        const pending = f.c.doubleClickFile('.', 'assets/a.ts');
        if (changed === 'busy') f.c.busy = true; else f.c[changed]++;
        f.resolve({ revealRequested: true, canOpen: true }); await pending;
        assert.deepEqual(f.calls.map(call => call.args[2]), ['reveal']);
    }
});

test('resource-panel scrolling does not cancel the open following a double-click reveal', async () => {
    const f = fixture(async (method, repo, file, action) => {
        if (action === 'reveal') f.c.fileMenuEpoch++;
        return { ok: true, data: { canOpen: true, revealRequested: action === 'reveal', openRequested: action === 'open' } };
    });
    prepareState(f.c);
    Object.assign(f.c, { fileMenuEpoch: 1, closeFileMenu() { this.fileMenuEpoch++; } });
    await f.c.doubleClickFile('.', 'assets/a.ts');
    assert.deepEqual(f.calls.map(call => call.args[2]), ['reveal', 'open']);
});

test('index execution locks before IPC and cannot submit the same click twice', async () => {
    const f = fixture(), p = f.c.executePlan({ token: 'one' });
    assert.equal(f.c.busy, true); assert.equal(f.c.planning, true); assert.equal(f.c.plan, undefined);
    await f.c.executePlan({ token: 'one' }); assert.equal(f.calls.length, 1);
    f.resolve({ id: 'task', status: 'running' }); await p;
    assert.equal(f.c.selected.size, 0); assert.equal(f.c.selectedLines.size, 0); assert.equal(f.c.planning, false);
    assert.equal(f.c.schedules, 1);
});

test('execution response does not clear selections in a newly selected repository', async () => {
    const f = fixture(), p = f.c.executePlan({ token: 'one' });
    f.c.repoId = 'child'; f.c.epoch++; f.c.selected = new Set(['worktree:child-file']);
    f.resolve({ id: 'task', status: 'running' }); await p;
    assert.deepEqual([...f.c.selected], ['worktree:child-file']); assert.equal(f.c.renders, 0);
});

test('uncertain execution is reported and polled without retrying the write', async () => {
    const f = fixture(), p = f.c.executePlan({ token: 'one' });
    f.reject(new Error('IPC disconnected')); await p;
    assert.equal(f.calls.length, 1); assert.match(f.c.lastError, /不会自动重试/);
    assert.equal(f.c.busy, true); assert.equal(f.c.planning, false); assert.equal(f.c.schedules, 1);
    assert.deepEqual([...f.c.selected], ['worktree:a']);
});

test('closed panels ignore late execution responses', async () => {
    const f = fixture(), p = f.c.executePlan({ token: 'one' }); f.c.closed = true;
    f.resolve({ id: 'task', status: 'success' }); await p;
    assert.equal(f.c.renders, 0); assert.equal(f.c.refreshes, 0); assert.equal(f.c.schedules, 0);
});

test('already finished task replies trigger a fresh state read', async () => {
    const f = fixture(), p = f.c.executePlan({ token: 'one' });
    f.resolve({ id: 'task', status: 'success' }); await p;
    assert.equal(f.c.refreshes, 1); assert.equal(f.calls.length, 1);
});

test('a changed selection or repository prevents dispatch of a late direct plan', async () => {
    for (const key of ['selectionEpoch', 'epoch', 'dialogEpoch']) {
        const f = fixture(); prepareState(f.c);
        const p = f.c.prepare('stage'); f.c[key]++;
        f.resolve({ token: 'one', paths: ['a'], warnings: [], expiresAt: Date.now() + 60000, directIndexAction: 'stage' });
        await p; assert.deepEqual(f.calls.map(x => x.method), ['prepare']);
    }
});

test('plans from an older backend or with a different range still open confirmation', async () => {
    for (const extra of [{}, { directIndexAction: 'stage', paths: ['a', 'a.meta'] }]) {
        const f = fixture(); prepareState(f.c);
        const p = f.c.prepare('stage');
        f.resolve({ token: 'one', title: 'stage', description: '', paths: ['a'], warnings: [], expiresAt: Date.now() + 60000, ...extra });
        await p;
        assert.deepEqual(f.calls.map(x => x.method), ['prepare']); assert.equal(f.c.el('modal').hidden, false);
    }
});
