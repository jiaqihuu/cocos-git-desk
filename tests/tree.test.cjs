const { test } = require('node:test');
const { windows, portableName, exoticNames, posixModes, linkTarget } = require('./platform.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GitDesk } = require('../dist/git');
const { TreeStateChangedError } = require('../dist/types');

const work = path.resolve(__dirname, '../.test-work');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(work, 'tree-no-global-config');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(work, 'tree-no-global-config'), GIT_TERMINAL_PROMPT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd();
async function fixture(t) {
    await fs.mkdir(work, { recursive: true });
    const base = await fs.mkdtemp(path.join(work, 'tree-')), repo = path.join(base, 'project');
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
const read = (f, extra = {}) => f.desk.tree('.', { kind: 'tree', revision: f.head, ...extra });
const file = (f, name, revision = f.head) => f.desk.diff({ repo: '.', revision, path: name, area: 'tree' });
async function commit(f, name, content) {
    await fs.mkdir(path.dirname(path.join(f.repo, name)), { recursive: true });
    await fs.writeFile(path.join(f.repo, name), content); git(f.repo, 'add', '--', name);
    git(f.repo, 'commit', '-m', 'update'); f.head = git(f.repo, 'rev-parse', 'HEAD');
}

test('tree includes unchanged files and reads a pinned snapshot rather than worktree contents', async t => {
    const f = await fixture(t); await commit(f, 'folder/other.txt', 'other\n');
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'uncommitted\n');
    const page = await read(f); assert.deepEqual(page.entries.map(entry => entry.name), ['folder', 'file.txt']);
    assert.equal(page.entries[0].kind, 'directory'); assert.equal(page.entries[1].kind, 'file');
    assert.equal((await file(f, 'file.txt')).after.text, 'first\n');
    const changed = await f.desk.commitFiles('.', f.head); assert.ok(!changed.some(entry => entry.path === 'file.txt'));
    const nested = await read(f, { directory: 'folder' }); assert.equal(nested.entries[0].path, 'folder/other.txt');
    assert.deepEqual(f.calls, { editor: 0, before: 0, after: 0 });
});

test('tree path selection is literal for magic names, tabs, newlines, unicode and colons', { skip: exoticNames }, async t => {
    const f = await fixture(t), names = ['folder/:(glob)*.txt', 'folder/space 中文\nline\tfile.txt', 'with:colon.txt'];
    for (const name of names) await commit(f, name, name + '\n');
    for (const name of names) assert.equal((await file(f, name)).after.text, name + '\n');
    const nested = await read(f, { directory: 'folder', text: ':(glob)*' });
    assert.equal(nested.total, 1); assert.equal(nested.entries[0].name, ':(glob)*.txt');
});

test('directory navigation and file preview never follow a symbolic link', async t => {
    const f = await fixture(t);
    await fs.symlink('/outside/secret', path.join(f.repo, 'link')); git(f.repo, 'add', 'link'); git(f.repo, 'commit', '-m', 'link'); f.head = git(f.repo, 'rev-parse', 'HEAD');
    const link = (await read(f)).entries.find(entry => entry.name === 'link'); assert.equal(link.kind, 'symlink');
    assert.equal(linkTarget((await file(f, 'link')).after.text), '/outside/secret');
    await assert.rejects(read(f, { directory: 'link' }), /不是目录/);
    await assert.rejects(file(f, 'link/child'));
});

test('submodule pointers can be previewed without reading a child worktree or missing commit object', async t => {
    const f = await fixture(t), missing = '1'.repeat(40);
    git(f.repo, 'update-index', '--add', '--cacheinfo', `160000,${missing},child`); git(f.repo, 'commit', '-m', 'pointer'); f.head = git(f.repo, 'rev-parse', 'HEAD');
    const entry = (await read(f)).entries.find(entry => entry.name === 'child');
    assert.equal(entry.kind, 'submodule'); assert.equal(entry.object, missing);
    assert.match((await file(f, 'child')).after.notice, new RegExp(missing));
    await assert.rejects(read(f, { directory: 'child' }));
});

test('directory pages bind commit, directory and filter independently from current repository state', async t => {
    const f = await fixture(t); await commit(f, 'b.txt', 'b'); await commit(f, 'c.txt', 'c');
    const original = f.head, first = await read(f, { limit: 2 });
    assert.equal(first.nextOffset, 2); assert.equal((await read(f, { limit: 2, offset: 2, version: first.version })).entries.length, 1);
    await assert.rejects(read(f, { offset: 2 }), TreeStateChangedError);
    await assert.rejects(read(f, { offset: 2, version: first.version, text: 'b' }), TreeStateChangedError);
    await commit(f, 'new.txt', 'new');
    await assert.rejects(read(f, { offset: 2, version: first.version }), TreeStateChangedError);
    assert.equal((await read(f, { revision: original, limit: 2, offset: 2, version: first.version })).revision, original);
});

test('invalid paths, expressions, unavailable paths and non-directories fail without fallback', async t => {
    const f = await fixture(t);
    for (const directory of ['../outside', '/tmp', './file.txt', 'folder//x', '.git', 'a/../b', 'a\0b']) await assert.rejects(read(f, { directory }));
    for (const revision of ['HEAD', f.head.slice(0, 12), 'HEAD~0', 'f'.repeat(40)]) await assert.rejects(read(f, { revision }));
    for (const extra of [{ limit: 201 }, { offset: -1 }, { text: 'a\0b' }, { unknown: true }]) await assert.rejects(read(f, extra));
    await assert.rejects(read(f, { directory: 'file.txt' }), /不是目录/);
    await assert.rejects(file(f, 'absent.txt'), /不在所选提交/);
});

test('tree preview preserves empty/binary/executable and oversized semantics', async t => {
    const f = await fixture(t);
    await commit(f, 'empty.txt', ''); await commit(f, 'binary.bin', Buffer.from([0, 1, 2]));
    await commit(f, 'encoded.txt', Buffer.from([255, 254, 100]));
    await commit(f, 'large.txt', Buffer.alloc(5 * 1024 * 1024 + 1, 120));
    git(f.repo, 'update-index', '--chmod=+x', 'file.txt'); git(f.repo, 'commit', '-m', 'mode'); f.head = git(f.repo, 'rev-parse', 'HEAD');
    assert.equal((await file(f, 'empty.txt')).after.text, '');
    assert.match((await file(f, 'binary.bin')).after.notice, /二进制/);
    assert.match((await file(f, 'encoded.txt')).after.notice, /UTF-8/);
    assert.match((await file(f, 'large.txt')).after.notice, /5 MiB/);
    assert.equal((await read(f)).entries.find(entry => entry.name === 'file.txt').kind, 'executable');
});

test('tree queries are blocked while a Git task runs and replacement objects do not change historical content', async t => {
    const f = await fixture(t), original = f.head;
    await commit(f, 'file.txt', 'replacement\n');
    git(f.repo, 'replace', original, f.head);
    assert.equal((await file(f, 'file.txt', original)).after.text, 'first\n');
    f.desk.taskState = { id: 'busy', title: 'external', status: 'running', log: '', startedAt: new Date().toISOString() };
    await assert.rejects(read(f), /任务正在执行/);
});
