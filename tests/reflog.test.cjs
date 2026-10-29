const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GitDesk } = require('../dist/git');
const { ReflogStateChangedError } = require('../dist/types');

const work = path.resolve(__dirname, '../.test-work');
process.env.GIT_ALLOW_PROTOCOL = 'file';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(work, 'reflog-no-global-config');
const git = (cwd, ...args) => execFileSync('git', ['--literal-pathspecs', ...args], {
    cwd, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
}).trimEnd();

async function fixture(t, seed = true) {
    await fs.mkdir(work, { recursive: true });
    const base = await fs.mkdtemp(path.join(work, 'reflog-'));
    t.after(async () => { await fs.rm(base, { recursive: true, force: true }); });
    const repo = path.join(base, 'project'); await fs.mkdir(repo);
    git(repo, 'init', '-b', 'dev');
    git(repo, 'config', 'user.name', 'Git Desk Test');
    git(repo, 'config', 'user.email', 'git-desk@example.invalid');
    git(repo, 'config', 'commit.gpgSign', 'false');
    git(repo, 'config', 'core.hooksPath', path.join(base, 'no-hooks'));
    if (seed) {
        await fs.writeFile(path.join(repo, 'file.txt'), 'first\n');
        git(repo, 'add', '.'); git(repo, 'commit', '-m', 'initial');
    }
    const calls = { check: 0, before: 0, after: 0, dirtyEditor: false, duringBefore: undefined };
    const desk = new GitDesk(repo, path.join(base, 'cache'), {
        async checkEditor() { calls.check++; if (calls.dirtyEditor) throw new Error('unsaved scene'); },
        async beforeWorktreeChange() { calls.before++; if (calls.duringBefore) await calls.duringBefore(); },
        async afterWorktreeChange() { calls.after++; },
    });
    return { base, repo, desk, calls };
}

async function plan(desk, action, args = {}) {
    const snapshot = await desk.snapshot(true);
    return desk.prepare({ repo: '.', version: snapshot.repositories[0].version, action, ...args });
}

async function finish(desk, preview) {
    desk.execute(preview.token);
    const start = Date.now();
    while (desk.task().status === 'running') {
        if (Date.now() - start > 30000) throw new Error('task test timeout');
        await new Promise(resolve => setTimeout(resolve, 15));
    }
    return desk.task();
}

async function perform(desk, action, args) {
    const result = await finish(desk, await plan(desk, action, args));
    assert.equal(result.status, 'success', result.log);
    return result;
}

function ref(repo, name) { return git(repo, 'for-each-ref', '--format=%(objectname)', 'refs/heads/' + name); }
function nextCommit(repo, parent = 'HEAD') { return git(repo, 'commit-tree', 'HEAD^{tree}', '-p', parent, '-m', 'other commit'); }
function upstream(repo, base, branch, revision) {
    git(repo, 'remote', 'add', 'origin', path.join(base, 'offline.git'));
    git(repo, 'update-ref', 'refs/remotes/origin/' + branch, revision);
    git(repo, 'config', 'branch.' + branch + '.remote', 'origin');
    git(repo, 'config', 'branch.' + branch + '.merge', 'refs/heads/' + branch);
}

async function dirtyFiles(repo) {
    await fs.writeFile(path.join(repo, 'file.txt'), 'staged\n'); git(repo, 'add', 'file.txt');
    await fs.writeFile(path.join(repo, 'file.txt'), 'unstaged\n');
    await fs.writeFile(path.join(repo, 'new.txt'), 'untracked\n');
}

async function state(repo) {
    const index = git(repo, 'rev-parse', '--git-path', 'index');
    return {
        head: git(repo, 'rev-parse', 'HEAD'), branch: git(repo, 'branch', '--show-current'),
        index: await fs.readFile(path.resolve(repo, index)),
        file: await fs.readFile(path.join(repo, 'file.txt')),
        untracked: await fs.readFile(path.join(repo, 'new.txt')).catch(error => { if (error.code === 'ENOENT') return null; throw error; }),
        remotes: git(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/'),
    };
}

function noHostChanges(calls) {
    assert.equal(calls.check, 0); assert.equal(calls.before, 0); assert.equal(calls.after, 0);
}

const read = (f, query = {}) => f.desk.reflog('.', { kind: 'reflog', ...query });
const tip = f => git(f.repo, 'rev-parse', 'HEAD');
const child = f => git(f.repo, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'reflog target');

test('other local branches and remote-tracking logs are read locally without host changes', async t => {
    const f = await fixture(t); git(f.repo, 'branch', 'topic');
    const target = child(f);
    git(f.repo, 'update-ref', '--create-reflog', '-m', 'offline tracking event', 'refs/remotes/offline/topic', target);
    await dirtyFiles(f.repo); const before = await state(f.repo);
    const commands = [], original = f.desk.git.bind(f.desk);
    f.desk.git = async (cwd, args, options) => { commands.push(args); return original(cwd, args, options); };
    assert.equal((await read(f, { ref: 'refs/heads/topic' })).available, true);
    const page = await read(f, { ref: 'refs/remotes/offline/topic' });
    assert.equal(page.entries[0].revision, target); assert.match(page.entries[0].subject, /offline tracking event/);
    assert.ok(page.entries[0].selector.startsWith('refs/remotes/offline/topic@{'));
    assert.ok(!commands.some(args => args.some(arg => ['fetch', 'push', 'ls-remote'].includes(arg))));
    assert.deepEqual(await state(f.repo), before); noHostChanges(f.calls);
});

test('remote-tracking symbolic aliases and revision expressions are rejected', async t => {
    const f = await fixture(t);
    git(f.repo, 'update-ref', '--create-reflog', 'refs/remotes/offline/dev', tip(f));
    git(f.repo, 'symbolic-ref', 'refs/remotes/offline/HEAD', 'refs/remotes/offline/dev');
    await assert.rejects(read(f, { ref: 'refs/remotes/offline/HEAD' }), /符号/);
    for (const ref of ['refs/remotes/offline/dev~1', 'refs/remotes/offline/dev^', 'refs/remotes/offline/dev\0bad']) await assert.rejects(read(f, { ref }));
});

test('remote-tracking missing logs are explicit and source versions cannot be mixed', async t => {
    const f = await fixture(t), missing = await read(f, { ref: 'refs/remotes/offline/missing' });
    assert.equal(missing.available, false); assert.deepEqual(missing.entries, []);
    const head = await read(f);
    await assert.rejects(read(f, { ref: 'refs/remotes/offline/missing', version: head.version }), ReflogStateChangedError);
});

test('remote-tracking updates invalidate paged event snapshots', async t => {
    const f = await fixture(t), ref = 'refs/remotes/offline/dev';
    git(f.repo, 'update-ref', '--create-reflog', ref, tip(f));
    const first = await read(f, { ref, limit: 1 });
    git(f.repo, 'update-ref', '-m', 'new offline event', ref, child(f));
    await assert.rejects(read(f, { ref, offset: 1, limit: 1, version: first.version }), ReflogStateChangedError);
});
const at = (f, branch, revision = tip(f), fields = {}) => plan(f.desk, 'createBranchAt', { branch, revision, ...fields });
function requireBranchAt(t) {
    const version = execFileSync('git', ['--version'], { encoding: 'utf8' }).match(/git version (\d+)\.(\d+)/);
    if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 54)) { t.skip('createBranchAt requires Git 2.54+'); return false; }
    return true;
}

test('reflog dates and identities describe the reference event instead of the commit author', async t => {
    const f = await fixture(t), target = child(f);
    execFileSync('git', ['update-ref', '-m', 'manual event', 'refs/heads/dev', target], {
        cwd: f.repo, env: { ...process.env, GIT_COMMITTER_DATE: '2001-01-02T03:04:05+00:00', GIT_COMMITTER_NAME: 'Event Actor', GIT_COMMITTER_EMAIL: 'event@example.invalid' }, stdio: 'pipe', timeout: 30000,
    });
    const page = await read(f), entry = page.entries[0];
    assert.equal(entry.revision, target); assert.equal(entry.actor, 'Event Actor'); assert.equal(entry.email, 'event@example.invalid');
    assert.equal(Date.parse(entry.date), Date.parse('2001-01-02T03:04:05+00:00')); assert.match(entry.subject, /manual event/);
    assert.equal(entry.selector, `HEAD@{${entry.date}}`); assert.equal(page.ref, 'HEAD'); assert.equal(page.available, true);
});

test('checkout events pointing to the same commit are not deduplicated', async t => {
    const f = await fixture(t), target = tip(f); git(f.repo, 'branch', 'topic');
    git(f.repo, 'switch', 'topic'); git(f.repo, 'switch', 'dev');
    const page = await read(f); assert.equal(page.entries[0].revision, target); assert.equal(page.entries[1].revision, target);
    assert.match(page.entries[0].subject, /checkout/); assert.match(page.entries[1].subject, /checkout/);
    assert.notEqual(page.entries[0].index, page.entries[1].index); assert.equal(f.calls.check, 0);
});

test('log queries accept exact branch sources and reject unknown fields', async t => {
    const f = await fixture(t); assert.equal((await read(f, { ref: 'refs/heads/dev' })).ref, 'refs/heads/dev');
    for (const ref of ['dev', 'HEAD@{0}', '--all', 'refs/heads/../dev', 'refs/tags/dev', 'refs/remotes/origin/dev@{0}', 'refs/remotes/origin/../dev']) await assert.rejects(read(f, { ref }));
    await assert.rejects(read(f, { command: 'anything' }), /无效/);
    await assert.rejects(read(f, { limit: 101 })); await assert.rejects(read(f, { offset: -1 }));
    git(f.repo, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/dev'); await assert.rejects(read(f, { ref: 'refs/heads/alias' }), /符号/);
});

test('missing logs return explicit availability and detached HEAD retains its own events', async t => {
    const empty = await fixture(t, false), page = await read(empty);
    assert.equal(page.available, false); assert.equal(page.total, 0); assert.deepEqual(page.entries, []);
    const f = await fixture(t); git(f.repo, 'switch', '--detach');
    const detached = await read(f); assert.equal(detached.available, true); assert.equal(detached.entries[0].revision, tip(f));
});

test('paging binds the recent log window and filters as literal text', async t => {
    const f = await fixture(t); git(f.repo, 'update-ref', '-m', '[literal] event', 'refs/heads/dev', child(f));
    const first = await read(f, { limit: 1 }); assert.equal(first.entries.length, 1); assert.equal(first.nextOffset, 1);
    const next = await read(f, { limit: 1, offset: 1, version: first.version }); assert.equal(next.entries.length, 1);
    await assert.rejects(read(f, { offset: 1, limit: 1 }), ReflogStateChangedError);
    assert.equal((await read(f, { text: '[literal]' })).total, 1);
    assert.equal((await read(f, { text: 'not present anywhere' })).total, 0);
    git(f.repo, 'update-ref', '-m', 'next event', 'refs/heads/dev', child(f));
    await assert.rejects(read(f, { offset: 1, limit: 1, version: first.version }), ReflogStateChangedError);
});

test('recent log windows stop at 1000 entries and report the omitted older history', async t => {
    const f = await fixture(t), file = path.join(f.repo, '.git/logs/HEAD'), initial = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, initial.repeat(1002));
    const page = await read(f, { limit: 10 }); assert.equal(page.sampled, 1000); assert.equal(page.total, 1000); assert.equal(page.truncated, true); assert.equal(page.entries.length, 10);
    assert.match(page.notice, /不是完整历史/);
});

test('long event text and identities are explicitly shortened without changing the full commit ID', async t => {
    const f = await fixture(t), target = child(f); git(f.repo, 'config', 'user.name', 'n'.repeat(300));
    git(f.repo, 'update-ref', '-m', 's'.repeat(1500), 'refs/heads/dev', target);
    const entry = (await read(f)).entries[0]; assert.equal(entry.revision, target);
    assert.equal(entry.subject.length, 1000); assert.equal(entry.subjectTruncated, true); assert.equal(entry.actor.length, 256); assert.equal(entry.identityTruncated, true);
});

test('creating a pinned branch preserves dirty index, worktree, current HEAD and editor state', async t => {
    if (!requireBranchAt(t)) return;
    const f = await fixture(t), original = tip(f), target = child(f); f.calls.dirtyEditor = true;
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'staged\n'); git(f.repo, 'add', '.');
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'unstaged\n'); await fs.writeFile(path.join(f.repo, 'untracked.txt'), 'keep\n');
    const index = await fs.readFile(path.join(f.repo, '.git/index'));
    const preview = await at(f, 'recovery/topic', target); assert.deepEqual(preview.paths, []); assert.ok(preview.description.includes(target));
    const task = await finish(f.desk, preview); assert.equal(task.status, 'success', task.log);
    assert.equal(git(f.repo, 'rev-parse', 'refs/heads/recovery/topic'), target); assert.equal(tip(f), original); assert.equal(git(f.repo, 'symbolic-ref', '--short', 'HEAD'), 'dev');
    assert.deepEqual(await fs.readFile(path.join(f.repo, '.git/index')), index); assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'unstaged\n');
    assert.equal(await fs.readFile(path.join(f.repo, 'untracked.txt'), 'utf8'), 'keep\n');
    assert.throws(() => git(f.repo, 'config', '--get-regexp', '^branch\\.recovery/topic\\.'));
    assert.equal(git(f.repo, 'reflog', 'exists', 'refs/heads/recovery/topic'), '');
    assert.equal(f.calls.check, 0); assert.equal(f.calls.before, 0); assert.equal(f.calls.after, 0);
});

test('pinned branch creation refuses existing, symbolic, configured and invalid targets', async t => {
    if (!requireBranchAt(t)) return;
    const f = await fixture(t), current = tip(f);
    await assert.rejects(at(f, 'dev'), /存在/);
    git(f.repo, 'symbolic-ref', 'refs/heads/dangling', 'refs/heads/missing'); await assert.rejects(at(f, 'dangling'), /符号/);
    git(f.repo, 'config', 'branch.configured.description', 'retain'); await assert.rejects(at(f, 'configured'), /配置/);
    for (const revision of ['HEAD', current.slice(0, 8), git(f.repo, 'rev-parse', 'HEAD^{tree}'), 'f'.repeat(40)]) await assert.rejects(at(f, 'candidate', revision));
    await assert.rejects(at(f, 'candidate', current, { paths: [] }), /不接受/);
    assert.equal(f.desk.task(), null);
});

test('late target creation and atomic dangling-symref races never overwrite another reference', async t => {
    if (!requireBranchAt(t)) return;
    const f = await fixture(t), target = child(f), preview = await at(f, 'late', target);
    git(f.repo, 'branch', 'late'); const original = git(f.repo, 'rev-parse', 'refs/heads/late');
    assert.equal((await finish(f.desk, preview)).status, 'failed'); assert.equal(git(f.repo, 'rev-parse', 'refs/heads/late'), original);
    const p = await at(f, 'raced', target), run = f.desk.git.bind(f.desk); let injected = false;
    f.desk.git = async (cwd, args, options) => {
        if (!injected && args[0] === 'update-ref' && args.includes('refs/heads/raced')) { injected = true; git(f.repo, 'symbolic-ref', 'refs/heads/raced', 'refs/heads/absent'); }
        return run(cwd, args, options);
    };
    const result = await finish(f.desk, p); assert.equal(result.status, 'failed'); assert.equal(git(f.repo, 'symbolic-ref', 'refs/heads/raced'), 'refs/heads/absent');
});

test('older Git is refused before writing and unborn current branch names cannot be initialized', async t => {
    const f = await fixture(t), run = f.desk.git.bind(f.desk);
    f.desk.git = async (cwd, args, options) => args[0] === '--version' ? { code: 0, stdout: Buffer.from('git version 2.53.0\n'), stderr: '' } : run(cwd, args, options);
    await assert.rejects(at(f, 'blocked'), /2\.54/);
    if (!requireBranchAt(t)) return;
    const unborn = await fixture(t, false); await assert.rejects(at(unborn, 'dev', 'a'.repeat(40)), /当前工作树/);
});

test('unborn branch occupancy in another worktree blocks reference creation', async t => {
    if (!requireBranchAt(t)) return;
    const f = await fixture(t), linked = path.join(f.base, 'linked'); git(f.repo, 'worktree', 'add', '--detach', linked, 'HEAD');
    git(f.repo, '-C', linked, 'symbolic-ref', 'HEAD', 'refs/heads/recovery');
    await assert.rejects(at(f, 'recovery'), /工作树/); assert.equal(git(f.repo, '-C', linked, 'symbolic-ref', 'HEAD'), 'refs/heads/recovery');
});

test('reference hook rejection and post-write side effects preserve the actual result without rollback', async t => {
    if (!requireBranchAt(t)) return;
    for (const kind of ['reject', 'changed']) {
        const f = await fixture(t), directory = path.join(f.base, 'hooks'); await fs.mkdir(directory); git(f.repo, 'config', 'core.hooksPath', directory);
        const body = kind === 'reject' ? 'if [ "$1" = prepared ]; then exit 1; fi\n' : 'if [ "$1" = committed ]; then git config user.name after-hook; fi\n';
        await fs.writeFile(path.join(directory, 'reference-transaction'), '#!/bin/sh\n' + body, { mode: 0o755 });
        const result = await finish(f.desk, await at(f, 'hooked')); assert.equal(result.status, 'failed'); assert.match(result.log, /可能已创建/);
        if (kind === 'changed') { assert.equal(git(f.repo, 'rev-parse', 'refs/heads/hooked'), tip(f)); assert.equal(git(f.repo, 'config', 'user.name'), 'after-hook'); }
        else assert.throws(() => git(f.repo, 'rev-parse', '--verify', 'refs/heads/hooked'));
    }
});

test('log reads reject busy tasks and branch creation previews are single-use', async t => {
    const f = await fixture(t); await read(f); f.desk.taskState = { id: 'busy', status: 'running' };
    await assert.rejects(read(f), /任务/); f.desk.taskState = null;
    if (!requireBranchAt(t)) return;
    const p = await at(f, 'once'); const result = await finish(f.desk, p); assert.equal(result.status, 'success', result.log);
    assert.throws(() => f.desk.execute(p.token), /过期/);
});

test('amended-away commits can be preserved on a new branch without checking them out', async t => {
    if (!requireBranchAt(t)) return;
    const f = await fixture(t), previous = tip(f);
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'amended\n'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '--amend', '-m', 'amended');
    const current = tip(f), page = await read(f, { text: previous });
    assert.ok(page.entries.some(entry => entry.revision === previous)); assert.notEqual(current, previous);
    const preview = await f.desk.prepare({ repo: '.', version: page.repoVersion, action: 'createBranchAt', branch: 'recovery/before-amend', revision: page.entries.find(entry => entry.revision === previous).revision });
    const result = await finish(f.desk, preview); assert.equal(result.status, 'success', result.log);
    assert.equal(git(f.repo, 'rev-parse', 'refs/heads/recovery/before-amend'), previous); assert.equal(tip(f), current);
    assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'amended\n');
});

test('ordinal selectors and incomplete command records are never misreported as event dates', async t => {
    const f = await fixture(t), revision = tip(f);
    f.desk.readReflog = async () => ({ available: true, raw: `${revision}\0HEAD@{0}\0actor\0email\0event\0` });
    await assert.rejects(read(f), /有效事件日期/);
    f.desk.readReflog = async () => ({ available: true, raw: `${revision}\0HEAD` });
    await assert.rejects(read(f), /不完整/);
});
