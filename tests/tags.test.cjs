const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GitDesk } = require('../dist/git');
const { TagStateChangedError } = require('../dist/types');

const work = path.resolve(__dirname, '../.test-work');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(work, 'tags-no-global-config');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(work, 'tags-no-global-config'), GIT_TERMINAL_PROMPT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd();
async function fixture(t) {
    await fs.mkdir(work, { recursive: true });
    const base = await fs.mkdtemp(path.join(work, 'tags-')), repo = path.join(base, 'project');
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    await fs.mkdir(repo); git(repo, 'init', '-b', 'dev');
    git(repo, 'config', 'user.name', 'Git Desk Test'); git(repo, 'config', 'user.email', 'git-desk@example.invalid');
    git(repo, 'config', 'commit.gpgSign', 'false'); git(repo, 'config', 'core.hooksPath', path.join(base, 'no-hooks'));
    await fs.writeFile(path.join(repo, 'file.txt'), 'first\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'initial');
    const calls = { editor: 0, before: 0, after: 0 };
    const desk = new GitDesk(repo, path.join(base, 'cache'), {
        async checkEditor() { calls.editor++; throw new Error('unsaved editor'); },
        async beforeWorktreeChange() { calls.before++; }, async afterWorktreeChange() { calls.after++; },
    });
    return { repo, desk, calls, head: git(repo, 'rev-parse', 'HEAD') };
}
async function plan(desk, action, args) {
    const snapshot = await desk.snapshot(true);
    return desk.prepare({ repo: '.', version: snapshot.repositories[0].version, action, ...args });
}
async function finish(desk, preview) {
    desk.execute(preview.token);
    const start = Date.now();
    while (desk.task().status === 'running') {
        if (Date.now() - start > 30000) throw new Error('tag task timeout');
        await new Promise(resolve => setTimeout(resolve, 15));
    }
    return desk.task();
}
async function create(f, tag, extra = {}) {
    const preview = await plan(f.desk, 'createTag', { tag, tagKind: 'lightweight', revision: f.head, ...extra });
    const result = await finish(f.desk, preview); assert.equal(result.status, 'success', result.log); return preview;
}
const read = (desk, extra = {}) => desk.tags('.', { kind: 'tags', ...extra });

test('local lightweight tag preserves dirty index/worktree and does not invoke Creator', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'staged\n'); git(f.repo, 'add', 'file.txt');
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'unstaged\n');
    const index = git(f.repo, 'write-tree'), status = git(f.repo, 'status', '--porcelain');
    await create(f, 'release/中文-v1');
    const page = await read(f.desk), tag = page.tags[0];
    assert.equal(tag.object, f.head); assert.equal(tag.commit, f.head); assert.equal(tag.kind, 'lightweight');
    assert.equal(git(f.repo, 'write-tree'), index); assert.equal(git(f.repo, 'status', '--porcelain'), status);
    assert.deepEqual(f.calls, { editor: 0, before: 0, after: 0 });
});

test('annotated tag has distinct ref object, verbatim message and no signing process', async t => {
    const f = await fixture(t), message = '发布说明\n\n# keep comment\n  keep spaces  \n';
    git(f.repo, 'config', 'tag.gpgSign', 'true'); git(f.repo, 'config', 'gpg.program', path.join(f.repo, 'must-not-run'));
    const preview = await create(f, 'v1', { tagKind: 'annotated', message });
    assert.ok(preview.description.includes(message));
    const tag = (await read(f.desk)).tags[0];
    assert.notEqual(tag.object, f.head); assert.equal(tag.objectType, 'tag'); assert.equal(tag.commit, f.head);
    const raw = execFileSync('git', ['cat-file', 'tag', tag.object], { cwd: f.repo, encoding: 'utf8' });
    assert.equal(raw.slice(raw.indexOf('\n\n') + 2), message);
    assert.doesNotMatch(raw, /BEGIN PGP SIGNATURE/);
});

test('invalid names, expressions, non-commit objects and missing annotation are rejected', async t => {
    const f = await fixture(t);
    for (const tag of ['', '-force', 'refs/heads/dev', '../escape', 'with space', 'a\nb', 'a\0b', 'a.lock']) {
        await assert.rejects(plan(f.desk, 'createTag', { tag, tagKind: 'lightweight', revision: f.head }));
    }
    for (const revision of ['HEAD', f.head.slice(0, 12), 'HEAD~0', git(f.repo, 'rev-parse', 'HEAD^{tree}')]) {
        await assert.rejects(plan(f.desk, 'createTag', { tag: 'invalid', tagKind: 'lightweight', revision }));
    }
    await assert.rejects(plan(f.desk, 'createTag', { tag: 'invalid', revision: f.head }));
    for (const message of ['', '  ', 'a\0b', 'a'.repeat(5001)]) {
        await assert.rejects(plan(f.desk, 'createTag', { tag: 'invalid', tagKind: 'annotated', revision: f.head, message }));
    }
    assert.equal((await read(f.desk)).total, 0);
});

test('existing tag never overwrites and delete requires actual tag object rather than commit', async t => {
    const f = await fixture(t); await create(f, 'v1', { tagKind: 'annotated', message: 'release' });
    const tag = (await read(f.desk)).tags[0];
    await assert.rejects(plan(f.desk, 'createTag', { tag: 'v1', tagKind: 'lightweight', revision: f.head }), /已存在/);
    await assert.rejects(plan(f.desk, 'deleteTag', { tag: 'v1', tagObject: f.head }), /改变|不存在/);
    const preview = await plan(f.desk, 'deleteTag', { tag: 'v1', tagObject: tag.object });
    assert.ok(preview.description.includes(tag.object));
    assert.equal((await finish(f.desk, preview)).status, 'success');
    assert.equal((await read(f.desk)).total, 0); assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
});

test('tag movement invalidates delete even when repository version is unchanged', async t => {
    const f = await fixture(t); await create(f, 'v1');
    const version = (await f.desk.snapshot(true)).repositories[0].version;
    const preview = await plan(f.desk, 'deleteTag', { tag: 'v1', tagObject: f.head });
    const newer = git(f.repo, 'commit-tree', 'HEAD^{tree}', '-p', f.head, '-m', 'other');
    git(f.repo, 'update-ref', 'refs/tags/v1', newer);
    assert.equal((await f.desk.snapshot(true)).repositories[0].version, version);
    const result = await finish(f.desk, preview); assert.equal(result.status, 'failed');
    assert.equal(git(f.repo, 'rev-parse', 'refs/tags/v1'), newer);
});

test('atomic delete rejects an update made after the last preflight read', async t => {
    const f = await fixture(t); await create(f, 'v1');
    const preview = await plan(f.desk, 'deleteTag', { tag: 'v1', tagObject: f.head });
    const newer = git(f.repo, 'commit-tree', 'HEAD^{tree}', '-p', f.head, '-m', 'race');
    const original = f.desk.git.bind(f.desk); let raced = false;
    f.desk.git = async (cwd, args, options) => {
        if (!raced && args[0] === 'update-ref' && args.includes('-d')) { raced = true; git(f.repo, 'update-ref', 'refs/tags/v1', newer); }
        return original(cwd, args, options);
    };
    assert.equal((await finish(f.desk, preview)).status, 'failed'); assert.equal(raced, true);
    assert.equal(git(f.repo, 'rev-parse', 'refs/tags/v1'), newer);
});

test('atomic creation cannot replace a tag created after the last absence check', async t => {
    const f = await fixture(t), preview = await plan(f.desk, 'createTag', { tag: 'race', tagKind: 'annotated', revision: f.head, message: 'new' });
    const original = f.desk.git.bind(f.desk); let raced = false;
    f.desk.git = async (cwd, args, options) => {
        if (!raced && args[0] === 'update-ref') { raced = true; git(f.repo, 'update-ref', 'refs/tags/race', f.head); }
        return original(cwd, args, options);
    };
    assert.equal((await finish(f.desk, preview)).status, 'failed'); assert.equal(raced, true);
    assert.equal(git(f.repo, 'rev-parse', 'refs/tags/race'), f.head);
});

test('symbolic tag management rejects both creation and deletion without touching branch', async t => {
    const f = await fixture(t); git(f.repo, 'symbolic-ref', 'refs/tags/link', 'refs/heads/dev');
    const tag = (await read(f.desk)).tags.find(tag => tag.name === 'link');
    assert.equal(tag.kind, 'symbolic'); assert.equal(tag.commit, undefined);
    await assert.rejects(plan(f.desk, 'deleteTag', { tag: 'link', tagObject: f.head }), /符号/);
    await assert.rejects(plan(f.desk, 'createTag', { tag: 'link', tagKind: 'lightweight', revision: f.head }), /符号/);
    assert.equal(git(f.repo, 'rev-parse', 'refs/heads/dev'), f.head);
});

test('tag pages require a stable independent version and literal filter', async t => {
    const f = await fixture(t);
    for (const name of ['a', 'b', 'c']) git(f.repo, 'update-ref', 'refs/tags/' + name, f.head);
    const first = await read(f.desk, { limit: 2 }); assert.equal(first.tags.length, 2); assert.equal(first.nextOffset, 2);
    const last = await read(f.desk, { offset: 2, limit: 2, version: first.version }); assert.deepEqual(last.tags.map(tag => tag.name), ['c']);
    await assert.rejects(read(f.desk, { offset: 2 }), TagStateChangedError);
    await assert.rejects(read(f.desk, { offset: 2, text: 'b', version: first.version }), TagStateChangedError);
    assert.equal((await read(f.desk, { text: '*' })).total, 0);
    git(f.repo, 'update-ref', 'refs/tags/d', f.head);
    await assert.rejects(read(f.desk, { offset: 2, version: first.version }), TagStateChangedError);
    for (const args of [{ limit: 201 }, { offset: -1 }, { text: 'a\0b' }, { unexpected: true }]) await assert.rejects(read(f.desk, args));
});

test('non-commit tags retain target type and may be deleted by exact ref object', async t => {
    const f = await fixture(t), tree = git(f.repo, 'rev-parse', 'HEAD^{tree}');
    git(f.repo, 'update-ref', 'refs/tags/tree', tree);
    const tag = (await read(f.desk)).tags[0]; assert.equal(tag.targetType, 'tree'); assert.equal(tag.commit, undefined);
    assert.equal((await finish(f.desk, await plan(f.desk, 'deleteTag', { tag: 'tree', tagObject: tree }))).status, 'success');
});
