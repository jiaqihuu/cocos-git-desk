const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GitDesk } = require('../dist/git');

const work = path.resolve(__dirname, '../.test-work');
process.env.GIT_ALLOW_PROTOCOL = 'file';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(work, 'sync-no-global-config');
const git = (cwd, ...args) => execFileSync('git', ['--literal-pathspecs', ...args], {
    cwd, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
}).trimEnd();

async function fixture(t, seed = true) {
    await fs.mkdir(work, { recursive: true });
    const base = await fs.mkdtemp(path.join(work, 'sync-'));
    t.after(async () => { await fs.rm(base, { recursive: true, force: true }); });
    const repo = path.join(base, 'project'); await fs.mkdir(repo);
    git(repo, 'init', '-b', 'dev');
    git(repo, 'config', 'user.name', 'Git Desk Test'); git(repo, 'config', 'user.email', 'git-desk@example.invalid');
    git(repo, 'config', 'commit.gpgSign', 'false'); git(repo, 'config', 'core.hooksPath', path.join(base, 'no-hooks'));
    git(repo, 'config', 'core.autocrlf', 'false');
    if (seed) { await fs.writeFile(path.join(repo, 'file.txt'), 'first\n'); git(repo, 'add', 'file.txt'); git(repo, 'commit', '-m', 'initial'); }
    const calls = [];
    const desk = new GitDesk(repo, path.join(base, 'cache'), {
        async checkEditor() { calls.push('check'); throw new Error('unsaved scene'); },
        async beforeWorktreeChange() { calls.push('before'); },
        async afterWorktreeChange() { calls.push('after'); },
    });
    return { repo, base, desk, calls };
}

function head(repo) { return git(repo, 'rev-parse', 'HEAD'); }
function child(repo, message, parent = 'HEAD') { return git(repo, 'commit-tree', 'HEAD^{tree}', '-p', parent, '-m', message); }
function chain(repo, length, parent = 'HEAD', prefix = 'change') {
    const commits = [];
    for (let i = 0; i < length; i++) { parent = child(repo, prefix + ' ' + i, parent); commits.push(parent); }
    return commits;
}
function track(repo, base, revision, name = 'topic') {
    git(repo, 'remote', 'add', 'origin', path.join(base, 'offline-origin.git'));
    git(repo, 'update-ref', 'refs/remotes/origin/' + name, revision);
    git(repo, 'config', 'branch.dev.remote', 'origin');
    git(repo, 'config', 'branch.dev.merge', 'refs/heads/' + name);
}
const sync = (desk, query = {}) => desk.syncPage('.', { kind: 'sync', ...query });
const ids = page => page.commits.map(commit => commit.sha);
async function optionalFile(name) { return fs.readFile(name).catch(error => { if (error.code === 'ENOENT') return null; throw error; }); }
async function state(repo) {
    return {
        head: head(repo), refs: git(repo, 'for-each-ref', '--format=%(refname) %(objectname) %(symref)'),
        index: await optionalFile(path.join(repo, '.git/index')), config: await optionalFile(path.join(repo, '.git/config')),
        tracked: await optionalFile(path.join(repo, 'file.txt')), staged: await optionalFile(path.join(repo, 'staged.txt')),
        untracked: await optionalFile(path.join(repo, 'new.txt')), mergeHead: await optionalFile(path.join(repo, '.git/MERGE_HEAD')),
        mergeMessage: await optionalFile(path.join(repo, '.git/MERGE_MSG')), fetchHead: await optionalFile(path.join(repo, '.git/FETCH_HEAD')),
    };
}
function unavailable(page, expected) {
    assert.equal(page.state, expected); assert.deepEqual(page.commits, []);
    assert.equal(page.ahead, undefined); assert.equal(page.behind, undefined);
    assert.equal(page.nextStart, undefined); assert.ok(page.notice);
}

test('sync reports equal cached endpoints with zero counts and no pending commits', async t => {
    const { repo, base, desk, calls } = await fixture(t), initial = head(repo); track(repo, base, initial);
    const page = await sync(desk);
    assert.equal(page.state, 'ready'); assert.equal(page.relation, 'equal'); assert.equal(page.direction, 'outgoing');
    assert.equal(page.start, 0); assert.equal(page.ahead, 0); assert.equal(page.behind, 0);
    assert.equal(page.head, initial); assert.equal(page.upstreamHead, initial); assert.equal(page.upstreamRef, 'refs/remotes/origin/topic');
    assert.deepEqual(page.commits, []); assert.equal(page.nextStart, undefined); assert.ok(page.snapshot);
    assert.equal(page.shallow, false); assert.ok(Number.isFinite(Date.parse(page.capturedAt))); assert.deepEqual(calls, []);
});

test('sync outgoing lists only local commits beyond the configured upstream', async t => {
    const { repo, base, desk } = await fixture(t), initial = head(repo), local = chain(repo, 3);
    git(repo, 'update-ref', 'refs/heads/dev', local.at(-1)); track(repo, base, initial);
    const page = await sync(desk);
    assert.equal(page.relation, 'ahead'); assert.equal(page.ahead, 3); assert.equal(page.behind, 0);
    assert.deepEqual(ids(page), local.slice().reverse()); assert.ok(page.commits.every(commit => commit.parents.length === 1));
    assert.deepEqual(ids(await sync(desk, { snapshot: page.snapshot, direction: 'incoming' })), []);
});

test('sync incoming lists only cached upstream commits beyond the local branch', async t => {
    const { repo, base, desk } = await fixture(t), remote = chain(repo, 3, 'HEAD', 'upstream'); track(repo, base, remote.at(-1));
    const page = await sync(desk, { direction: 'incoming' });
    assert.equal(page.relation, 'behind'); assert.equal(page.ahead, 0); assert.equal(page.behind, 3);
    assert.deepEqual(ids(page), remote.slice().reverse());
    assert.deepEqual(ids(await sync(desk, { snapshot: page.snapshot, direction: 'outgoing' })), []);
});

test('sync divergence excludes shared ancestors and preserves each side of a merge history', async t => {
    const { repo, base, desk } = await fixture(t), initial = head(repo), local = chain(repo, 2), remote = chain(repo, 3, initial, 'upstream');
    const merged = git(repo, 'commit-tree', 'HEAD^{tree}', '-p', local.at(-1), '-p', remote[0], '-m', 'local merge');
    git(repo, 'update-ref', 'refs/heads/dev', merged); track(repo, base, remote.at(-1));
    const page = await sync(desk), incoming = await sync(desk, { snapshot: page.snapshot, direction: 'incoming' });
    assert.equal(page.relation, 'diverged'); assert.equal(page.ahead, 3); assert.equal(page.behind, 2);
    assert.deepEqual(new Set(ids(page)), new Set([merged, ...local])); assert.deepEqual(ids(incoming), remote.slice(1).reverse());
    assert.deepEqual(page.commits.find(commit => commit.sha === merged).parents, [local.at(-1), remote[0]]);
});

test('sync distinguishes unrelated complete histories instead of treating them as ordinary divergence', async t => {
    const { repo, base, desk } = await fixture(t), unrelated = git(repo, 'commit-tree', 'HEAD^{tree}', '-m', 'independent root');
    track(repo, base, unrelated);
    const page = await sync(desk);
    assert.equal(page.state, 'ready'); assert.equal(page.relation, 'unrelated'); assert.equal(page.ahead, 1); assert.equal(page.behind, 1);
    assert.deepEqual(ids(page), [head(repo)]);
    assert.deepEqual(ids(await sync(desk, { snapshot: page.snapshot, direction: 'incoming' })), [unrelated]);
});

test('sync paginates 60 commits from fixed endpoint SHAs after local and cached refs move', async t => {
    const { repo, base, desk } = await fixture(t), initial = head(repo), local = chain(repo, 67);
    git(repo, 'update-ref', 'refs/heads/dev', local.at(-1)); track(repo, base, initial);
    const first = await sync(desk); assert.equal(first.commits.length, 60); assert.equal(first.nextStart, 60);
    const newer = child(repo, 'after snapshot'); git(repo, 'update-ref', 'refs/heads/dev', newer);
    git(repo, 'update-ref', 'refs/remotes/origin/topic', local[5]);
    const second = await sync(desk, { snapshot: first.snapshot, start: first.nextStart });
    assert.equal(second.snapshot, first.snapshot); assert.equal(second.head, local.at(-1)); assert.equal(second.upstreamHead, initial);
    assert.equal(second.ahead, 67); assert.equal(second.start, 60); assert.equal(second.nextStart, undefined);
    assert.deepEqual([...ids(first), ...ids(second)], local.slice().reverse());
    assert.deepEqual(await sync(desk, { snapshot: first.snapshot, start: 60 }), second);
    const fresh = await sync(desk); assert.equal(fresh.head, newer); assert.equal(fresh.upstreamHead, local[5]); assert.equal(fresh.ahead, 62);
});

test('sync direction changes retain the same snapshot after tracking changes and response mutation', async t => {
    const { repo, base, desk } = await fixture(t), initial = head(repo), local = chain(repo, 2), remote = chain(repo, 3, initial, 'upstream');
    git(repo, 'update-ref', 'refs/heads/dev', local.at(-1)); track(repo, base, remote.at(-1));
    const first = await sync(desk), token = first.snapshot, capturedAt = first.capturedAt;
    first.head = initial; first.upstreamHead = initial; first.ahead = 999; first.commits[0].subject = 'mutated response'; first.commits[0].parents.length = 0;
    git(repo, 'config', 'branch.dev.merge', 'refs/heads/other'); git(repo, 'update-ref', 'refs/remotes/origin/other', initial);
    const incoming = await sync(desk, { snapshot: token, direction: 'incoming', start: 0 });
    assert.equal(incoming.head, local.at(-1)); assert.equal(incoming.upstreamHead, remote.at(-1)); assert.equal(incoming.capturedAt, capturedAt);
    assert.equal(incoming.upstreamRef, 'refs/remotes/origin/topic'); assert.equal(incoming.ahead, 2); assert.equal(incoming.behind, 3);
    assert.deepEqual(ids(incoming), remote.slice().reverse());
    const outgoing = await sync(desk, { snapshot: token, direction: 'outgoing', start: 0 });
    assert.equal(outgoing.commits[0].subject, 'change 1'); assert.deepEqual(outgoing.commits[0].parents, [local[0]]);
    assert.equal((await sync(desk)).upstreamRef, 'refs/remotes/origin/other');
});

test('sync reports visible shallow counts without claiming a full relation and rejects changed shallow boundaries', async t => {
    const { repo, base, desk } = await fixture(t), initial = head(repo), local = chain(repo, 65);
    git(repo, 'update-ref', 'refs/heads/dev', local.at(-1)); track(repo, base, initial);
    await fs.writeFile(path.join(repo, '.git/shallow'), local[0] + '\n');
    const first = await sync(desk);
    assert.equal(first.shallow, true); assert.equal(first.relation, 'unknown'); assert.equal(first.ahead, 65); assert.equal(first.behind, 1);
    const last = await sync(desk, { snapshot: first.snapshot, start: first.nextStart });
    assert.equal(last.commits.at(-1).sha, local[0]); assert.equal(last.shallow, true);
    await fs.writeFile(path.join(repo, '.git/shallow'), local[1] + '\n');
    await assert.rejects(sync(desk, { snapshot: first.snapshot, start: 60 }), /边界|浅克隆|变化|失效/);
    git(repo, 'update-ref', 'refs/remotes/origin/topic', local.at(-1));
    const equal = await sync(desk); assert.equal(equal.shallow, true); assert.equal(equal.relation, 'equal'); assert.equal(equal.ahead, 0); assert.equal(equal.behind, 0);
});

test('sync refuses to continue a frozen snapshot after local graft metadata changes', async t => {
    const { repo, base, desk } = await fixture(t), initial = head(repo), local = chain(repo, 61);
    git(repo, 'update-ref', 'refs/heads/dev', local.at(-1)); track(repo, base, initial);
    const first = await sync(desk);
    await fs.mkdir(path.join(repo, '.git/info'), { recursive: true });
    await fs.writeFile(path.join(repo, '.git/info/grafts'), local.at(-1) + '\n');
    await assert.rejects(sync(desk, { snapshot: first.snapshot, start: first.nextStart }), /边界|graft|变化|失效/i);
});

test('sync reads original commit objects and topology despite replacement refs', async t => {
    const { repo, base, desk } = await fixture(t), initial = head(repo), local = chain(repo, 2);
    git(repo, 'update-ref', 'refs/heads/dev', local.at(-1)); track(repo, base, initial);
    const replacement = git(repo, 'commit-tree', 'HEAD^{tree}', '-m', 'replacement root'); git(repo, 'replace', local.at(-1), replacement);
    const page = await sync(desk);
    assert.equal(page.relation, 'ahead'); assert.equal(page.ahead, 2); assert.equal(page.behind, 0);
    assert.deepEqual(ids(page), local.slice().reverse()); assert.equal(page.commits[0].subject, 'change 1'); assert.deepEqual(page.commits[0].parents, [local[0]]);
    assert.equal(git(repo, 'rev-parse', 'refs/replace/' + local.at(-1)), replacement);
});

test('sync keeps UTF-8 fields and original authors despite mailmap, encoding, notes and log display configuration', async t => {
    const { repo, base, desk } = await fixture(t), initial = head(repo);
    git(repo, 'config', 'user.name', '原始作者'); git(repo, 'config', 'user.email', 'original@example.invalid');
    const subject = '同步中文说明 <界面> [1] & Δ', local = child(repo, subject);
    git(repo, 'update-ref', 'refs/heads/dev', local); track(repo, base, initial);
    git(repo, 'notes', 'add', '-m', 'NOTE_MUST_NOT_ENTER_SYNC_FIELDS', local);
    const mailmap = path.join(base, 'mailmap');
    await fs.writeFile(mailmap, 'Mapped User <mapped@example.invalid> 原始作者 <original@example.invalid>\n');
    git(repo, 'config', 'mailmap.file', mailmap); git(repo, 'config', 'log.mailmap', 'true');
    git(repo, 'config', 'i18n.logOutputEncoding', 'ISO-8859-1');
    git(repo, 'config', 'log.showSignature', 'true'); git(repo, 'config', 'log.showNotes', 'true');
    git(repo, 'config', 'notes.displayRef', 'refs/notes/commits'); git(repo, 'config', 'log.decorate', 'full');
    git(repo, 'config', 'log.follow', 'true'); git(repo, 'config', 'color.ui', 'always');
    const page = await sync(desk);
    assert.deepEqual(ids(page), [local]); assert.equal(page.ahead, 1); assert.equal(page.behind, 0);
    assert.equal(page.commits[0].author, '原始作者'); assert.equal(page.commits[0].subject, subject);
    assert.deepEqual(page.commits[0].parents, [initial]); assert.equal(page.commits[0].refs, '');
    assert.doesNotMatch(JSON.stringify(page.commits), /NOTE_MUST_NOT_ENTER_SYNC_FIELDS|Mapped User|diff --git|\\u001b/);
});

test('sync preserves conflicts, dirty files, staged bytes, configuration and refs without consulting the editor', async t => {
    const { repo, base, desk, calls } = await fixture(t), initial = head(repo);
    git(repo, 'switch', '-c', 'theirs'); await fs.writeFile(path.join(repo, 'file.txt'), 'theirs\n'); git(repo, 'commit', '-am', 'theirs');
    git(repo, 'switch', 'dev'); await fs.writeFile(path.join(repo, 'file.txt'), 'ours\n'); git(repo, 'commit', '-am', 'ours');
    assert.throws(() => git(repo, 'merge', '--no-edit', 'theirs'), error => error.status === 1);
    track(repo, base, initial);
    await fs.writeFile(path.join(repo, 'staged.txt'), 'staged\n'); git(repo, 'add', 'staged.txt');
    await fs.writeFile(path.join(repo, 'staged.txt'), 'unstaged\n'); await fs.writeFile(path.join(repo, 'new.txt'), 'untracked\n');
    const before = await state(repo), page = await sync(desk);
    assert.equal(page.state, 'ready'); assert.equal(page.ahead, 1); assert.equal(page.behind, 0);
    await sync(desk, { snapshot: page.snapshot, direction: 'incoming' });
    assert.deepEqual(await state(repo), before); assert.deepEqual(calls, []);
});

test('sync uses local cached refs without fetch, push, pull, remote probes or host worktree callbacks', async t => {
    const { repo, base, desk, calls } = await fixture(t); track(repo, base, head(repo));
    git(repo, 'remote', 'set-url', 'origin', 'ssh://git@invalid.example.invalid/unavailable.git');
    const trace = path.join(base, 'git-trace.log'), previous = process.env.GIT_TRACE;
    process.env.GIT_TRACE = trace;
    try { const page = await sync(desk); assert.equal(page.state, 'ready'); await sync(desk, { snapshot: page.snapshot, direction: 'incoming' }); }
    finally { if (previous === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = previous; }
    const log = await fs.readFile(trace, 'utf8');
    assert.doesNotMatch(log, /built-in: git[^\n]*\b(?:fetch|push|pull|ls-remote)\b/);
    assert.doesNotMatch(log, /run_command:[^\n]*\b(?:ssh|git-remote-http|git-remote-https)\b/);
    assert.equal(await optionalFile(path.join(repo, '.git/FETCH_HEAD')), null); assert.deepEqual(calls, []);
});

test('sync gives explicit unborn, detached and no-upstream states with unknown counts', async t => {
    const empty = await fixture(t, false); unavailable(await sync(empty.desk), 'unborn');
    const { repo, desk } = await fixture(t); unavailable(await sync(desk), 'no-upstream');
    git(repo, 'switch', '--detach'); unavailable(await sync(desk), 'detached');
});

test('sync distinguishes missing upstream refs and malformed tracking configurations without inventing counts', async t => {
    const { repo, base, desk } = await fixture(t); track(repo, base, head(repo));
    git(repo, 'update-ref', '-d', 'refs/remotes/origin/topic'); unavailable(await sync(desk), 'gone');
    git(repo, 'config', '--unset-all', 'branch.dev.merge'); unavailable(await sync(desk), 'invalid');
    git(repo, 'config', 'branch.dev.merge', 'refs/heads/topic'); git(repo, 'config', '--add', 'branch.dev.merge', 'refs/heads/another');
    unavailable(await sync(desk), 'invalid');
});

test('sync compares a configured local upstream independently from pushRemote and push.default', async t => {
    const { repo, base, desk } = await fixture(t), initial = head(repo), local = child(repo, 'local change');
    git(repo, 'branch', '基线.branch', initial); git(repo, 'update-ref', 'refs/heads/dev', local);
    git(repo, 'config', 'branch.dev.remote', '.'); git(repo, 'config', 'branch.dev.merge', 'refs/heads/基线.branch');
    git(repo, 'remote', 'add', 'publish', path.join(base, 'publish-offline.git'));
    git(repo, 'config', 'branch.dev.pushRemote', 'publish'); git(repo, 'config', 'push.default', 'current');
    const page = await sync(desk);
    assert.equal(page.state, 'ready'); assert.equal(page.upstreamRef, 'refs/heads/基线.branch'); assert.equal(page.upstreamHead, initial);
    assert.equal(page.remote, '.'); assert.equal(page.relation, 'ahead'); assert.deepEqual(ids(page), [local]);
});

test('sync rejects invalid direction, offset and snapshot inputs instead of silently changing the query', async t => {
    const { repo, base, desk } = await fixture(t); track(repo, base, head(repo));
    for (const query of [
        null, {}, { kind: 'history' }, { kind: 'sync', direction: 'both' }, { kind: 'sync', direction: 1 },
        { kind: 'sync', start: -1 }, { kind: 'sync', start: 1.5 }, { kind: 'sync', start: '0' },
        { kind: 'sync', start: NaN }, { kind: 'sync', start: Infinity }, { kind: 'sync', start: Number.MAX_SAFE_INTEGER + 1 },
        { kind: 'sync', start: 1 }, { kind: 'sync', snapshot: 123 }, { kind: 'sync', snapshot: '' },
        { kind: 'sync', snapshot: 'missing-token' },
    ]) await assert.rejects(desk.syncPage('.', query));
    const page = await sync(desk);
    await assert.rejects(sync(desk, { snapshot: page.snapshot, direction: 'outgoing', start: -1 }));
});

test('sync snapshots expire after 30 minutes and cannot be revived by changing direction', async t => {
    const { repo, base, desk } = await fixture(t); track(repo, base, head(repo));
    const page = await sync(desk), realNow = Date.now, future = realNow() + 30 * 60 * 1000 + 1;
    Date.now = () => future;
    try { await assert.rejects(sync(desk, { snapshot: page.snapshot, direction: 'incoming' }), /失效|过期|重新|刷新/); }
    finally { Date.now = realNow; }
    assert.equal((await sync(desk)).state, 'ready');
});

test('sync retains at most 32 snapshots and evicts the oldest without damaging the most recent one', async t => {
    const { repo, base, desk } = await fixture(t); track(repo, base, head(repo));
    const first = await sync(desk); let latest;
    for (let i = 0; i < 32; i++) latest = await sync(desk);
    await assert.rejects(sync(desk, { snapshot: first.snapshot }), /失效|过期|重新|刷新/);
    assert.equal((await sync(desk, { snapshot: latest.snapshot, direction: 'incoming' })).snapshot, latest.snapshot);
});

test('sync snapshots are bound to their repository and cannot be reused for a registered submodule', async t => {
    const root = await fixture(t), childRepo = await fixture(t);
    track(root.repo, root.base, head(root.repo));
    git(root.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', childRepo.repo, 'modules/child');
    await root.desk.snapshot(true);
    const first = await sync(root.desk);
    await assert.rejects(root.desk.syncPage('modules/child', { kind: 'sync', snapshot: first.snapshot }), /仓库|失效|重新|刷新/);
    const own = await root.desk.syncPage('modules/child', { kind: 'sync' });
    assert.notEqual(own.snapshot, first.snapshot);
});

test('sync does not mistake an external FETCH_HEAD timestamp for a known successful plugin fetch', async t => {
    const { repo, base, desk } = await fixture(t), initial = head(repo); track(repo, base, initial);
    const fetch = path.join(repo, '.git/FETCH_HEAD');
    await fs.writeFile(fetch, initial + '\t\tbranch topic of offline-origin\n');
    const beforeTime = new Date('2024-01-02T03:04:05.000Z'); await fs.utimes(fetch, beforeTime, beforeTime);
    const before = await fs.readFile(fetch), first = await sync(desk);
    assert.equal(first.fetchedAt, undefined); assert.ok(first.notice);
    const later = new Date('2024-02-03T04:05:06.000Z'); await fs.utimes(fetch, later, later);
    assert.equal((await sync(desk, { snapshot: first.snapshot, direction: 'incoming' })).fetchedAt, first.fetchedAt);
    assert.equal((await sync(desk)).fetchedAt, undefined); assert.deepEqual(await fs.readFile(fetch), before);
});
