const { test } = require('node:test');
const { windows, portableName, exoticNames, posixModes, linkTarget } = require('./platform.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GitDesk } = require('../dist/git');

const work = path.resolve(__dirname, '../.test-work');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(work, 'selected-stash-no-global-config');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(work, 'selected-stash-no-global-config'), GIT_TERMINAL_PROMPT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd();
async function fixture(t) {
    await fs.mkdir(work, { recursive: true });
    const base = await fs.mkdtemp(path.join(work, 'selected-stash-')), repo = path.join(base, 'project');
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    await fs.mkdir(repo); git(repo, 'init', '-b', 'dev');
    git(repo, 'config', 'user.name', 'Git Desk Test'); git(repo, 'config', 'user.email', 'git-desk@example.invalid');
    git(repo, 'config', 'commit.gpgSign', 'false'); git(repo, 'config', 'core.hooksPath', path.join(base, 'no-hooks'));
    await fs.writeFile(path.join(repo, 'file.txt'), 'first\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'initial');
    const calls = { editor: 0, before: 0, after: 0, dirty: false, failAfter: false, duringBefore: undefined };
    const desk = new GitDesk(repo, path.join(base, 'cache'), {
        async checkEditor() { calls.editor++; if (calls.dirty) throw new Error('unsaved editor'); },
        async beforeWorktreeChange() { calls.before++; if (calls.duringBefore) await calls.duringBefore(); }, async afterWorktreeChange() { calls.after++; if (calls.failAfter) throw new Error('refresh failed'); },
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
        if (Date.now() - start > 30000) throw new Error('stash task timeout');
        await new Promise(resolve => setTimeout(resolve, 15));
    }
    return desk.task();
}
const preview = (f, paths, extra = {}) => plan(f.desk, 'stashSelected', { paths, ...extra });
async function save(f, paths, extra) {
    const p = await preview(f, paths, extra), result = await finish(f.desk, p);
    assert.equal(result.status, 'success', result.log); return p;
}
async function seed(f, entries) {
    for (const [name, content] of Object.entries(entries)) {
        await fs.mkdir(path.dirname(path.join(f.repo, name)), { recursive: true });
        await fs.writeFile(path.join(f.repo, name), content);
    }
    git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'seed');
}

test('selected stash leaves unrelated unstaged and untracked changes in place', async t => {
    const f = await fixture(t); await seed(f, { 'other.txt': 'old' });
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'chosen'); await fs.writeFile(path.join(f.repo, 'other.txt'), 'keep'); await fs.writeFile(path.join(f.repo, 'untracked.txt'), 'keep new');
    await save(f, ['file.txt']);
    assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'first\n');
    assert.equal(await fs.readFile(path.join(f.repo, 'other.txt'), 'utf8'), 'keep');
    assert.equal(await fs.readFile(path.join(f.repo, 'untracked.txt'), 'utf8'), 'keep new');
    const stash = (await f.desk.stashes('.'))[0], files = await f.desk.stashFiles('.', stash.sha);
    assert.ok(files.length); assert.ok(files.every(file => file.path === 'file.txt'));
    assert.equal(f.calls.before, 1); assert.equal(f.calls.after, 1);
});

test('whole file saves distinct index/worktree versions and can restore both through existing flow', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'staged\n'); git(f.repo, 'add', 'file.txt'); await fs.writeFile(path.join(f.repo, 'file.txt'), 'unstaged\n');
    const p = await save(f, ['file.txt']); assert.match(p.description, /完整|固定 HEAD/);
    assert.equal(git(f.repo, 'status', '--porcelain'), '');
    const stash = (await f.desk.stashes('.'))[0];
    assert.equal((await finish(f.desk, await plan(f.desk, 'stashApply', { stashRef: stash.ref, revision: stash.sha, restoreIndex: true }))).status, 'success');
    assert.equal(git(f.repo, 'show', ':file.txt'), 'staged');
    assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'unstaged\n');
    assert.equal((await f.desk.stashes('.'))[0].sha, stash.sha);
});

test('related asset/meta and changed parent metadata are explicit in the saved scope', async t => {
    const f = await fixture(t); await seed(f, { 'assets/a.ts': 'old', 'assets/a.ts.meta': '{}', 'assets.meta': '{}' });
    for (const name of ['assets/a.ts', 'assets/a.ts.meta', 'assets.meta']) await fs.writeFile(path.join(f.repo, name), 'changed');
    const p = await save(f, ['assets/a.ts']); assert.deepEqual(p.paths, ['assets.meta', 'assets/a.ts', 'assets/a.ts.meta']);
    assert.equal(git(f.repo, 'status', '--porcelain'), '');
});

test('new related metadata requires opt-in and only selected untracked files are saved', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'changed'); await fs.writeFile(path.join(f.repo, 'file.txt.meta'), '{}'); await fs.writeFile(path.join(f.repo, 'leave.txt'), 'keep');
    await assert.rejects(preview(f, ['file.txt']), /未跟踪/);
    const p = await save(f, ['file.txt'], { includeUntracked: true }); assert.ok(p.paths.includes('file.txt.meta'));
    await assert.rejects(fs.stat(path.join(f.repo, 'file.txt.meta')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(f.repo, 'leave.txt'), 'utf8'), 'keep');
    const stash = (await f.desk.stashes('.'))[0]; assert.equal(git(f.repo, 'show', stash.sha + '^3:file.txt.meta'), '{}');
});

test('staged paths outside expanded scope reject instead of silently entering a partial stash', async t => {
    const f = await fixture(t); await seed(f, { 'other.txt': 'old' });
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'chosen'); await fs.writeFile(path.join(f.repo, 'other.txt'), 'other'); git(f.repo, 'add', 'other.txt');
    await assert.rejects(preview(f, ['file.txt']), /范围外.*已暂存/);
    assert.equal((await f.desk.stashes('.')).length, 0);
    await save(f, ['file.txt', 'other.txt']); assert.equal(git(f.repo, 'status', '--porcelain'), '');
});

test('rename pair and special filenames use NUL literal pathspecs', async t => {
    const f = await fixture(t), renamed = portableName(':(glob)* 中文\nfile.txt');
    await seed(f, { 'other.txt': 'base' });
    await fs.writeFile(path.join(f.repo, 'other.txt'), 'unrelated edit');
    await fs.writeFile(path.join(f.repo, 'untracked.txt'), 'keep');
    git(f.repo, 'mv', 'file.txt', renamed);
    const p = await save(f, [renamed]); assert.deepEqual(p.paths, [renamed, 'file.txt'].sort());
    assert.equal(git(f.repo, 'status', '--porcelain'), ' M other.txt\n?? untracked.txt');
    assert.equal(await fs.readFile(path.join(f.repo, 'other.txt'), 'utf8'), 'unrelated edit');
    assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'first\n');
});

test('empty/unknown paths, metadata control files and directory replacements fail before writing', async t => {
    const f = await fixture(t);
    for (const paths of [[], ['missing'], ['../outside'], ['.git/config']]) await assert.rejects(preview(f, paths));
    await fs.writeFile(path.join(f.repo, '.gitmodules'), '# configuration'); await assert.rejects(preview(f, ['.gitmodules'], { includeUntracked: true }), /gitmodules/);
    await fs.rm(path.join(f.repo, 'file.txt')); await fs.mkdir(path.join(f.repo, 'file.txt')); await fs.writeFile(path.join(f.repo, 'file.txt', 'child.txt'), 'new');
    await assert.rejects(preview(f, ['file.txt'], { includeUntracked: true }), /目录/);
    assert.equal((await f.desk.stashes('.')).length, 0);
});

test('preview fingerprints reject same-porcelain edits without moving files or creating a stash', async t => {
    const f = await fixture(t); await fs.writeFile(path.join(f.repo, 'file.txt'), 'one'); const p = await preview(f, ['file.txt']);
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'two'); const result = await finish(f.desk, p);
    assert.equal(result.status, 'failed'); assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'two'); assert.equal((await f.desk.stashes('.')).length, 0);
});

test('new related meta after preview invalidates the frozen expanded scope', async t => {
    const f = await fixture(t); await fs.writeFile(path.join(f.repo, 'file.txt'), 'changed'); const p = await preview(f, ['file.txt'], { includeUntracked: true });
    await fs.writeFile(path.join(f.repo, 'file.txt.meta'), '{}'); assert.equal((await finish(f.desk, p)).status, 'failed');
    assert.equal((await f.desk.stashes('.')).length, 0); assert.equal(await fs.readFile(path.join(f.repo, 'file.txt.meta'), 'utf8'), '{}');
});

test('editor unsaved state and changes during asset pause block writes and still balance resume', async t => {
    const f = await fixture(t); await seed(f, { 'other.txt': 'old' }); await fs.writeFile(path.join(f.repo, 'file.txt'), 'chosen');
    f.calls.dirty = true; await assert.rejects(preview(f, ['file.txt']), /unsaved/); f.calls.dirty = false;
    const p = await preview(f, ['file.txt']); f.calls.duringBefore = async () => { await fs.writeFile(path.join(f.repo, 'other.txt'), 'late'); git(f.repo, 'add', 'other.txt'); };
    assert.equal((await finish(f.desk, p)).status, 'failed'); assert.equal(f.calls.before, 1); assert.equal(f.calls.after, 1); assert.equal((await f.desk.stashes('.')).length, 0);
});

test('changed stash chain after preview rejects without deleting the external record', async t => {
    const f = await fixture(t); await fs.writeFile(path.join(f.repo, 'file.txt'), 'chosen'); const p = await preview(f, ['file.txt']);
    const object = git(f.repo, 'stash', 'create', 'external'); git(f.repo, 'stash', 'store', '-m', 'external', object);
    assert.equal((await finish(f.desk, p)).status, 'failed'); assert.equal((await f.desk.stashes('.'))[0].sha, object); assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'chosen');
});

test('editor refresh failure preserves the saved stash and reports failure without automatic rollback', async t => {
    const f = await fixture(t); await fs.writeFile(path.join(f.repo, 'file.txt'), 'chosen'); const p = await preview(f, ['file.txt']); f.calls.failAfter = true;
    const result = await finish(f.desk, p); assert.equal(result.status, 'failed'); assert.match(result.log, /refresh failed|Git 已执行/);
    const stash = (await f.desk.stashes('.'))[0]; assert.ok(stash.sha); assert.equal(git(f.repo, 'show', stash.sha + ':file.txt'), 'chosen');
    assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'first\n'); assert.equal(f.calls.before, f.calls.after);
});


test('selected staged deletion alone preserves unrelated working edits', async t => {
    const f = await fixture(t); await seed(f, { 'other.txt': 'base' });
    await fs.writeFile(path.join(f.repo, 'other.txt'), 'keep');
    git(f.repo, 'rm', 'file.txt'); await save(f, ['file.txt']);
    assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'first\n');
    assert.equal(await fs.readFile(path.join(f.repo, 'other.txt'), 'utf8'), 'keep');
    assert.equal(git(f.repo, 'status', '--porcelain'), ' M other.txt');
});


test('a recreated rename source after stash is preserved and stops cleanup', async t => {
    const f = await fixture(t); git(f.repo, 'mv', 'file.txt', 'renamed.txt');
    const p = await preview(f, ['renamed.txt']), original = f.desk.git.bind(f.desk);
    f.desk.git = async (cwd, args, options) => {
        const result = await original(cwd, args, options);
        if (args.includes('stash') && args.includes('push')) await fs.writeFile(path.join(f.repo, 'file.txt'), 'concurrent edit');
        return result;
    };
    const result = await finish(f.desk, p);
    assert.equal(result.status, 'failed'); assert.match(result.log, /旧路径被重新写入/);
    assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'concurrent edit');
    assert.equal((await f.desk.stashes('.')).length, 1);
});

test('selected untracked magic and newline names are saved literally and cleaned', { skip: exoticNames }, async t => {
    const f = await fixture(t), name = ':(glob)* 中文\nnew.txt';
    await fs.writeFile(path.join(f.repo, name), 'chosen');
    await fs.writeFile(path.join(f.repo, 'other.txt'), 'keep');
    await save(f, [name], { includeUntracked: true });
    await assert.rejects(fs.stat(path.join(f.repo, name)), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(f.repo, 'other.txt'), 'utf8'), 'keep');
});
