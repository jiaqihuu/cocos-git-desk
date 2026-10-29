const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { GitDesk } = require('../dist/git');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
async function fixture(t) {
    const parent = path.resolve(__dirname, '../.cache');
    await fs.mkdir(parent, { recursive: true });
    const base = await fs.mkdtemp(path.join(parent, 'diff-reads-'));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const repo = path.join(base, 'repo'); await fs.mkdir(repo);
    git(repo, 'init', '-b', 'dev'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
    const commit = async (text) => {
        await fs.writeFile(path.join(repo, 'file.txt'), text); git(repo, 'add', 'file.txt'); git(repo, 'commit', '-m', 'fixture');
        return git(repo, 'rev-parse', 'HEAD');
    };
    const first = await commit('before\n'), head = await commit('after\n');
    const service = new GitDesk(repo, path.join(base, 'cache'), { checkEditor: async () => {} });
    await service.snapshot(true);
    const commands = [], original = service.git.bind(service);
    let media = path.join(base, 'media'), envError = false;
    service.git = async (cwd, args, opts) => {
        commands.push(args);
        if (args[0] === 'lfs' && args[1] === 'env') {
            if (envError) throw Error('LFS environment failure');
            return { stdout: Buffer.from('LocalMediaDir=' + media + '\n'), stderr: Buffer.alloc(0), code: 0 };
        }
        return original(cwd, args, opts);
    };
    const object = async (text, present = true) => {
        const oid = createHash('sha256').update(text).digest('hex');
        if (present) { const dir = path.join(media, oid.slice(0, 2), oid.slice(2, 4)); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, oid), text); }
        return `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${Buffer.byteLength(text)}\n`;
    };
    const diff = revision => service.diff({ repo: '.', path: 'file.txt', area: 'commit', revision });
    return { repo, base, service, commands, commit, first, head, diff, object,
        envCalls: () => commands.filter(a => a[0] === 'lfs').length,
        setMedia: value => { media = value; }, setError: value => { envError = value; } };
}
test('one historical diff validates commit and resolves parent once, preserving content', async t => {
    const f = await fixture(t), result = await f.diff(f.head);
    assert.equal(result.before.text, 'before\n'); assert.equal(result.after.text, 'after\n');
    assert.equal(f.commands.filter(a => a.includes('rev-parse') && a.at(-1) === f.head + '^{commit}').length, 1);
    assert.equal(f.commands.filter(a => a.includes('rev-parse') && a.at(-1) === f.head + '^').length, 1);
    assert.equal(f.envCalls(), 0);
    assert.deepEqual((await f.service.commitFiles('.', f.head)).map(x => x.path), ['file.txt']);
});
test('root commits and deletions retain missing-side semantics', async t => {
    const f = await fixture(t), root = await f.diff(f.first);
    assert.equal(root.before.exists, false); assert.equal(root.after.text, 'before\n');
    git(f.repo, 'rm', 'file.txt'); git(f.repo, 'commit', '-m', 'delete');
    const deleted = await f.diff(git(f.repo, 'rev-parse', 'HEAD'));
    assert.equal(deleted.before.text, 'after\n'); assert.equal(deleted.after.text, '');
});
test('unchanged paths and invalid revisions remain rejected', async t => {
    const f = await fixture(t); await fs.writeFile(path.join(f.repo, 'other.txt'), 'other'); git(f.repo, 'add', 'other.txt'); git(f.repo, 'commit', '-m', 'other');
    await assert.rejects(f.diff(git(f.repo, 'rev-parse', 'HEAD')), /不在提交变更列表/);
    await assert.rejects(f.diff('HEAD'), /完整提交哈希/);
});
test('shallow boundary is still rejected, then succeeds after boundary removal', async t => {
    const f = await fixture(t); await fs.writeFile(path.join(f.repo, '.git/shallow'), f.head + '\n');
    await assert.rejects(f.diff(f.head), /第一父提交/);
    await fs.unlink(path.join(f.repo, '.git/shallow'));
    assert.equal((await f.diff(f.head)).before.text, 'before\n');
});
test('replacement refs do not change original commit content', async t => {
    const f = await fixture(t); git(f.repo, 'replace', f.head, f.first);
    assert.equal((await f.diff(f.head)).after.text, 'after\n');
});
test('two LFS sides share only this request environment, retaining SHA checks', async t => {
    const f = await fixture(t); await f.commit(await f.object('LFS before\n')); const head = await f.commit(await f.object('LFS after\n'));
    f.commands.length = 0; const diff = await f.diff(head);
    assert.equal(diff.before.text, 'LFS before\n'); assert.equal(diff.after.text, 'LFS after\n'); assert.equal(f.envCalls(), 1);
    await f.diff(head); assert.equal(f.envCalls(), 2);
});
test('missing local LFS objects become readable on the next request', async t => {
    const f = await fixture(t); await f.commit(await f.object('LFS before\n', false)); const head = await f.commit(await f.object('LFS after\n', false));
    assert.match((await f.diff(head)).after.notice, /未下载/);
    await f.object('LFS before\n'); await f.object('LFS after\n');
    assert.equal((await f.diff(head)).after.text, 'LFS after\n');
});
test('LFS environment errors are not cached across requests', async t => {
    const f = await fixture(t); const head = await f.commit(await f.object('LFS after\n'));
    f.setError(true); await assert.rejects(f.diff(head), /environment failure/);
    f.setError(false); assert.equal((await f.diff(head)).after.text, 'LFS after\n');
});
test('changed LFS directory and corrupt objects are rechecked', async t => {
    const f = await fixture(t); const pointer = await f.object('LFS after\n'), head = await f.commit(pointer);
    assert.equal((await f.diff(head)).after.text, 'LFS after\n');
    f.setMedia(path.join(f.base, 'second-media')); assert.match((await f.diff(head)).after.notice, /未下载/);
    await f.object('LFS after\n'); const oid = /sha256:(\w+)/.exec(pointer)[1];
    await fs.writeFile(path.join(f.base, 'second-media', oid.slice(0, 2), oid.slice(2, 4), oid), 'bad');
    await assert.rejects(f.diff(head), /对象校验失败/);
});
test('worktree edits and index changes are never completed-result cached', async t => {
    const f = await fixture(t); await fs.writeFile(path.join(f.repo, 'file.txt'), 'first disk\n'); await f.service.snapshot(true, '.');
    const query = { repo: '.', path: 'file.txt', area: 'worktree' };
    assert.equal((await f.service.diff(query)).after.text, 'first disk\n');
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'second disk\n');
    assert.equal((await f.service.diff(query)).after.text, 'second disk\n');
    git(f.repo, 'add', 'file.txt');
    assert.equal((await f.service.diff({ ...query, area: 'index' })).after.text, 'second disk\n');
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'third disk\n'); git(f.repo, 'add', 'file.txt');
    assert.equal((await f.service.diff({ ...query, area: 'index' })).after.text, 'third disk\n');
});

test('historical sides overlap while simultaneous diff requests never exceed two blob reads', async t => {
    const f = await fixture(t), original = f.service.blob.bind(f.service);
    let active = 0, maximum = 0, started = 0, release, entered;
    const held = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { entered = resolve; });
    f.service.blob = async (...args) => {
        active++; maximum = Math.max(maximum, active); started++;
        if (started === 2) entered();
        try { await held; return await original(...args); } finally { active--; }
    };
    const reads = [f.diff(f.head), f.diff(f.head), f.diff(f.head)];
    await ready;
    assert.equal(active, 2); assert.equal(started, 2);
    release(); const results = await Promise.all(reads);
    assert.equal(maximum, 2); assert.equal(started, 6); assert.equal(active, 0);
    for (const result of results) { assert.equal(result.before.text, 'before\n'); assert.equal(result.after.text, 'after\n'); }
});

test('failed side drains its partner before returning error and releases queued reads', async t => {
    const f = await fixture(t), original = f.service.blob.bind(f.service);
    let started = 0, release, entered;
    const held = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { entered = resolve; });
    f.service.blob = async (...args) => {
        const index = ++started;
        if (index === 1) throw Error('simulated old-side read failure');
        if (index === 2) { entered(); await held; }
        return original(...args);
    };
    let settled = false;
    const failed = assert.rejects(f.diff(f.head), /old-side read failure/).then(() => { settled = true; });
    await ready;
    const next = f.diff(f.head);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false); assert.equal(started, 2);
    release(); await failed;
    assert.equal((await next).after.text, 'after\n');
    assert.equal((await f.diff(f.head)).before.text, 'before\n');
});

test('parallel LFS environment rejection is observed by both sides and next request recovers', async t => {
    const f = await fixture(t); await f.commit(await f.object('LFS before\n')); const head = await f.commit(await f.object('LFS after\n'));
    f.commands.length = 0; f.setError(true);
    await assert.rejects(f.diff(head), /environment failure/); assert.equal(f.envCalls(), 1);
    f.setError(false); const result = await f.diff(head);
    assert.equal(result.before.text, 'LFS before\n'); assert.equal(result.after.text, 'LFS after\n'); assert.equal(f.envCalls(), 2);
});
