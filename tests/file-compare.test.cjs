const { test } = require('node:test');
const { windows, portableName, exoticNames, posixModes, linkTarget } = require('./platform.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GitDesk } = require('../dist/git');
const { FileComparisonStateChangedError } = require('../dist/types');

const work = path.resolve(__dirname, '../.test-work');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(work, 'file-comparison-no-global-config');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(work, 'file-comparison-no-global-config'), GIT_TERMINAL_PROMPT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd();
async function fixture(t) {
    await fs.mkdir(work, { recursive: true });
    const base = await fs.mkdtemp(path.join(work, 'file-compare-')), repo = path.join(base, 'project');
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
async function commit(f, name, content) {
    await fs.mkdir(path.dirname(path.join(f.repo, name)), { recursive: true });
    await fs.writeFile(path.join(f.repo, name), content); git(f.repo, 'add', '--', name);
    git(f.repo, 'commit', '-m', 'update'); f.head = git(f.repo, 'rev-parse', 'HEAD');
}

const edge = (revision, path = 'file.txt') => ({ revision, path });
const compare = (f, left, right, extra = {}) => f.desk.diff({ repo: '.', path: right.path, area: 'file-compare', left, right, ...extra });
const page = (f, left, right, extra = {}) => f.desk.compareFilePage('.', { left, right, ...extra });

test('file comparison pins different paths and commits independently of worktree contents', async t => {
    const f = await fixture(t), first = f.head; await commit(f, 'other.txt', 'second\n');
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'working changes\n');
    const diff = await compare(f, edge(first), edge(f.head, 'other.txt'));
    assert.equal(diff.before.text, 'first\n'); assert.equal(diff.after.text, 'second\n');
    assert.equal(diff.comparison.left.revision, first); assert.equal(diff.comparison.right.path, 'other.txt');
    assert.match(diff.patch, /before\/file\.txt/); assert.match(diff.patch, /after\/other\.txt/);
    assert.deepEqual(f.calls, { editor: 0, before: 0, after: 0 });
});

test('mode-only differences and empty text remain distinct from missing snapshots', async t => {
    const f = await fixture(t); await commit(f, 'empty.txt', ''); const first = f.head;
    git(f.repo, 'update-index', '--chmod=+x', 'empty.txt'); git(f.repo, 'commit', '-m', 'mode'); f.head = git(f.repo, 'rev-parse', 'HEAD');
    const diff = await compare(f, edge(first, 'empty.txt'), edge(f.head, 'empty.txt'));
    assert.equal(diff.before.text, ''); assert.equal(diff.after.text, ''); assert.equal(diff.patch, '');
    assert.equal(diff.comparison.left.mode, '100644'); assert.equal(diff.comparison.right.mode, '100755');
    assert.notEqual(diff.comparison.left.mode, diff.comparison.right.mode);
    const metadata = await page(f, edge(first, 'empty.txt'), edge(f.head, 'empty.txt'));
    assert.equal(metadata.before.kind, 'text'); assert.equal(metadata.before.characters, 0); assert.equal(metadata.patchAvailable, true);
    await assert.rejects(compare(f, edge(first, 'missing.txt'), edge(f.head, 'empty.txt')), /不在所选提交/);
});

test('explicit rename path pairs work without implicitly following missing paths', async t => {
    const f = await fixture(t), old = f.head;
    git(f.repo, 'mv', 'file.txt', 'renamed.txt'); git(f.repo, 'commit', '-m', 'rename'); f.head = git(f.repo, 'rev-parse', 'HEAD');
    const diff = await compare(f, edge(old), edge(f.head, 'renamed.txt'));
    assert.equal(diff.patch, ''); assert.equal(diff.comparison.left.object, diff.comparison.right.object);
    await assert.rejects(compare(f, edge(old), edge(f.head)), /不在所选提交/);
});

test('literal special paths work and malformed requests cannot select other data', { skip: exoticNames }, async t => {
    const f = await fixture(t), name = 'dir/[literal]*.txt'; await commit(f, name, 'literal\n');
    const diff = await compare(f, edge(f.head, name), edge(f.head, name)); assert.equal(diff.after.text, 'literal\n');
    for (const bad of [edge('HEAD'), edge(f.head, '../file.txt'), edge(f.head, '/file.txt'), edge(f.head, 'a\0b'), { revision: f.head, path: name, command: 'anything' }]) await assert.rejects(compare(f, bad, edge(f.head, name)));
    await assert.rejects(compare(f, edge(f.head, name), edge(f.head, name), { revision: f.head }), /无关字段/);
});

test('symlinks are compared as text without following their target and directories are refused', async t => {
    const f = await fixture(t); await fs.symlink('/outside/secret', path.join(f.repo, 'link.txt'));
    git(f.repo, 'add', 'link.txt'); git(f.repo, 'commit', '-m', 'link'); f.head = git(f.repo, 'rev-parse', 'HEAD');
    await commit(f, 'folder/file.txt', 'normal\n');
    const diff = await compare(f, edge(f.head, 'link.txt'), edge(f.head, 'folder/file.txt'));
    assert.equal(linkTarget(diff.before.text), '/outside/secret'); assert.equal(diff.comparison.left.kind, 'symlink');
    await assert.rejects(compare(f, edge(f.head, 'folder'), edge(f.head, 'folder/file.txt')), /目录/);
});

test('binary and image snapshots produce typed metadata without image bytes in agent pages', async t => {
    const f = await fixture(t); await commit(f, 'binary.bin', Buffer.from([0, 1, 2])); await commit(f, 'image.png', Buffer.from([137, 80, 78, 71, 0]));
    const diff = await compare(f, edge(f.head, 'binary.bin'), edge(f.head, 'image.png'));
    assert.match(diff.before.notice, /二进制/); assert.ok(diff.after.image.startsWith('data:image/png;base64,')); assert.ok(diff.patchNotice);
    const result = await page(f, edge(f.head, 'binary.bin'), edge(f.head, 'image.png'));
    assert.equal(result.before.kind, 'notice'); assert.equal(result.after.kind, 'image'); assert.equal(result.patchAvailable, false);
    assert.doesNotMatch(JSON.stringify(result), /data:image\/png/);
});

test('submodule snapshots expose the pointer without opening its missing repository object', async t => {
    const f = await fixture(t), missing = 'f'.repeat(40);
    git(f.repo, 'update-index', '--add', '--cacheinfo', `160000,${missing},child`);
    git(f.repo, 'commit', '-m', 'pointer'); f.head = git(f.repo, 'rev-parse', 'HEAD');
    const diff = await compare(f, edge(f.head, 'child'), edge(f.head));
    assert.equal(diff.comparison.left.kind, 'submodule'); assert.equal(diff.comparison.left.object, missing);
    assert.match(diff.before.notice, /子模块指针/); assert.ok(diff.before.notice.includes(missing)); assert.equal(diff.patch, '');
});

test('non-UTF8 historical text is reported explicitly instead of replacement characters', async t => {
    const f = await fixture(t); await commit(f, 'legacy.txt', Buffer.from([0xff, 0xfe, 0xfd]));
    const diff = await compare(f, edge(f.head, 'legacy.txt'), edge(f.head));
    assert.equal(diff.before.text, undefined); assert.match(diff.before.notice, /不是有效 UTF-8/);
    const tree = await f.desk.diff({ repo: '.', area: 'tree', revision: f.head, path: 'legacy.txt' });
    assert.equal(tree.after.notice, diff.before.notice);
});

test('local LFS text is refreshed explicitly and checked for UTF8 without downloading', async t => {
    const f = await fixture(t), { createHash } = require('node:crypto');
    const payload = Buffer.from([0xff, 0xfe]), oid = createHash('sha256').update(payload).digest('hex');
    const media = /^LocalMediaDir=(.+)$/m.exec(git(f.repo, 'lfs', 'env'))[1];
    await commit(f, 'lfs.txt', `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${payload.length}\n`);
    const before = await compare(f, edge(f.head, 'lfs.txt'), edge(f.head)); assert.match(before.before.notice, /未下载/);
    const directory = path.join(media, oid.slice(0, 2), oid.slice(2, 4)); await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, oid), payload);
    const after = await compare(f, edge(f.head, 'lfs.txt'), edge(f.head), { force: true });
    assert.equal(after.before.lfs, true); assert.match(after.before.notice, /不是有效 UTF-8/); assert.notEqual(after.comparison.version, before.comparison.version);
});

test('large snapshots and patch budgets return explicit notices rather than false equality', async t => {
    const f = await fixture(t); await commit(f, 'large.txt', 'a'.repeat(1100000)); await commit(f, 'other.txt', 'b'.repeat(1100000));
    const diff = await compare(f, edge(f.head, 'large.txt'), edge(f.head, 'other.txt')); assert.match(diff.patchNotice, /2 MiB/); assert.equal(diff.before.text.length, 1100000);
    const patch = await page(f, edge(f.head, 'large.txt'), edge(f.head, 'other.txt'), { view: 'patch' }); assert.equal(patch.patchAvailable, false); assert.match(patch.text, /不生成补丁/);
    await commit(f, 'huge.txt', 'x'.repeat(5 * 1024 * 1024 + 1));
    const huge = await compare(f, edge(f.head, 'huge.txt'), edge(f.head)); assert.match(huge.before.notice, /5 MiB/);
});

test('bounded content fragments require a stable comparison version and preserve exact text', async t => {
    const f = await fixture(t); await commit(f, 'other.txt', 'hello\nworld\n');
    const left = edge(f.head), right = edge(f.head, 'other.txt');
    const first = await page(f, left, right, { view: 'after', limit: 6 }); assert.equal(first.text, 'hello\n'); assert.equal(first.nextOffset, 6);
    const second = await page(f, left, right, { view: 'after', offset: 6, limit: 6, version: first.comparison.version }); assert.equal(second.text, 'world\n');
    await assert.rejects(page(f, left, right, { view: 'after', offset: 6 }), FileComparisonStateChangedError);
    await assert.rejects(page(f, left, right, { version: '0'.repeat(64) }), FileComparisonStateChangedError);
    await assert.rejects(page(f, left, right, { limit: 16001 }));
    await assert.rejects(page(f, left, right, { view: 'not-a-view' }));
});

test('shared reads and repeated comparisons cannot be corrupted through a caller-owned result', async t => {
    const f = await fixture(t), left = edge(f.head), right = edge(f.head);
    const [a, b] = await Promise.all([compare(f, left, right), compare(f, left, right)]);
    assert.equal(a.comparison.version, b.comparison.version); a.before.text = 'corrupted'; a.comparison.left.path = 'other';
    const fresh = await compare(f, left, right); assert.equal(fresh.before.text, 'first\n'); assert.equal(fresh.comparison.left.path, 'file.txt');
    const forced = await compare(f, left, right, { force: true }); assert.equal(forced.comparison.version, fresh.comparison.version);
});

test('read-only comparisons preserve refs, index and files, and busy tasks block queries', async t => {
    const f = await fixture(t), head = f.head; await commit(f, 'other.txt', 'other\n');
    const refs = git(f.repo, 'show-ref'), index = await fs.readFile(path.join(f.repo, '.git/index'));
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'unsaved\n');
    await compare(f, edge(head), edge(f.head, 'other.txt'));
    assert.equal(git(f.repo, 'show-ref'), refs); assert.deepEqual(await fs.readFile(path.join(f.repo, '.git/index')), index);
    assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'unsaved\n'); assert.deepEqual(f.calls, { editor: 0, before: 0, after: 0 });
    assert.deepEqual((await fs.readdir(path.join(f.repo, '../cache'))).filter(name => name.startsWith('diff-')), []);
    f.desk.taskState = { id: 'busy', status: 'running' };
    await assert.rejects(compare(f, edge(head), edge(f.head)), /任务/);
});


const workCompare = (f, left = edge(f.head), name = 'file.txt', extra = {}) => f.desk.diff({ repo: '.', path: name, area: 'worktree-compare', left, ...extra });
const workPage = (f, extra = {}) => f.desk.compareWorktreePage('.', { left: edge(f.head), path: 'file.txt', ...extra });

test('working comparison reads final saved disk including staged and unstaged changes without writing Git', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'staged\n'); git(f.repo, 'add', 'file.txt');
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'final disk\n');
    const refs = git(f.repo, 'show-ref'), index = await fs.readFile(path.join(f.repo, '.git/index'));
    const diff = await workCompare(f);
    assert.equal(diff.before.text, 'first\n'); assert.equal(diff.after.text, 'final disk\n');
    assert.equal(diff.worktreeComparison.diskOnly, true); assert.equal(diff.worktreeComparison.normalization, 'raw');
    assert.equal(diff.worktreeComparison.left.revision, f.head); assert.equal(diff.worktreeComparison.right.kind, 'file');
    assert.match(diff.summary, /未保存缓冲/); assert.match(diff.patch, /\+final disk/); assert.equal(diff.partial, undefined);
    assert.equal(git(f.repo, 'show-ref'), refs); assert.deepEqual(await fs.readFile(path.join(f.repo, '.git/index')), index);
    assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'final disk\n');
    assert.deepEqual(f.calls, { editor: 0, before: 0, after: 0 });
});

test('working comparisons never reuse completed disk snapshots even for same-size edits', async t => {
    const f = await fixture(t), a = await workCompare(f);
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'other\n');
    const b = await workCompare(f);
    assert.equal(b.after.text, 'other\n'); assert.notEqual(a.worktreeComparison.version, b.worktreeComparison.version);
    assert.notEqual(a.worktreeComparison.right.hash, b.worktreeComparison.right.hash);
    assert.equal(f.desk.worktreeComparisonReads.size, 0);
    const metadata = await workPage(f); assert.equal(metadata.cachedUpToMs, 0);
});

test('working fragments preserve exact text and invalidate every view after edits', async t => {
    const f = await fixture(t); await fs.writeFile(path.join(f.repo, 'file.txt'), 'hello\nworld\n');
    const a = await workPage(f, { view: 'after', limit: 6 }); assert.equal(a.text, 'hello\n');
    const b = await workPage(f, { view: 'after', offset: 6, limit: 6, version: a.comparison.version }); assert.equal(b.text, 'world\n');
    await assert.rejects(workPage(f, { view: 'after', offset: 6 }), FileComparisonStateChangedError);
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'hello\nother\n');
    for (const view of ['before', 'after', 'summary', 'patch']) await assert.rejects(workPage(f, { view, version: a.comparison.version }), FileComparisonStateChangedError);
});

test('missing disk paths and present empty files have distinct comparison identities', async t => {
    const f = await fixture(t); await fs.unlink(path.join(f.repo, 'file.txt'));
    const missing = await workCompare(f); assert.equal(missing.after.text, ''); assert.equal(missing.worktreeComparison.right.kind, 'missing');
    assert.match(missing.patch, /-first/); assert.match(missing.summary, /路径缺失/);
    await fs.writeFile(path.join(f.repo, 'file.txt'), '');
    const empty = await workCompare(f); assert.equal(empty.worktreeComparison.right.kind, 'file'); assert.equal(empty.after.text, '');
    assert.notEqual(missing.worktreeComparison.version, empty.worktreeComparison.version);
    const absentParent = await workCompare(f, edge(f.head), 'absent/child.txt'); assert.equal(absentParent.worktreeComparison.right.kind, 'missing');
    await assert.rejects(fs.stat(path.join(f.repo, 'absent')), { code: 'ENOENT' });
});

test('working comparison supports explicit cross-path literal names without rename inference', { skip: exoticNames }, async t => {
    const f = await fixture(t), name = 'dir/[literal]*换行\n.txt';
    await fs.mkdir(path.join(f.repo, 'dir')); await fs.writeFile(path.join(f.repo, name), 'cross path\n');
    const diff = await workCompare(f, edge(f.head), name);
    assert.equal(diff.worktreeComparison.left.path, 'file.txt'); assert.equal(diff.worktreeComparison.right.path, name);
    assert.equal(diff.after.text, 'cross path\n'); assert.match(diff.summary, /不推断重命名/);
});

test('working comparison rejects expression revisions, malformed endpoints and unrelated write fields', async t => {
    const f = await fixture(t);
    for (const value of [edge('HEAD'), { ...edge(f.head), force: true }, undefined]) await assert.rejects(workCompare(f, value, 'file.txt', value === undefined ? { left: undefined } : {}));
    for (const name of ['../outside', '/outside', '.git/config', 'dir/../file.txt', 'file.txt\0tail', '\ud800']) await assert.rejects(workCompare(f, edge(f.head), name));
    for (const extra of [{ right: edge(f.head) }, { force: true }, { revision: f.head }]) await assert.rejects(workCompare(f, edge(f.head), 'file.txt', extra), /无关字段/);
    for (const extra of [{ limit: 16001 }, { offset: -1 }, { view: 'image' }, { force: true }, { view: 'summary', offset: 1 }]) await assert.rejects(workPage(f, extra));
});

test('working comparison refuses links, hardlinks, directories and nested repositories', async t => {
    const f = await fixture(t);
    await fs.mkdir(path.join(f.repo, 'folder')); await assert.rejects(workCompare(f, edge(f.head), 'folder'), /普通文件/);
    await fs.mkdir(path.join(f.repo, 'nested')); await fs.mkdir(path.join(f.repo, 'nested/.git')); await fs.writeFile(path.join(f.repo, 'nested/file.txt'), 'nested');
    await assert.rejects(workCompare(f, edge(f.head), 'nested/file.txt'), /嵌套仓库/);
    if (process.platform !== 'win32') {
        await fs.symlink('file.txt', path.join(f.repo, 'link.txt')); await assert.rejects(workCompare(f, edge(f.head), 'link.txt'), /普通文件/);
        await fs.symlink('folder', path.join(f.repo, 'alias')); await assert.rejects(workCompare(f, edge(f.head), 'alias/file.txt'), /链接/);
        await fs.link(path.join(f.repo, 'file.txt'), path.join(f.repo, 'hard.txt')); await assert.rejects(workCompare(f, edge(f.head), 'hard.txt'), /普通文件/);
    }
});

test('working comparison accepts executable historical files and versions disk permission changes', async t => {
    const f = await fixture(t); git(f.repo, 'update-index', '--chmod=+x', 'file.txt'); git(f.repo, 'commit', '-m', 'mode'); f.head = git(f.repo, 'rev-parse', 'HEAD');
    const a = await workCompare(f); assert.equal(a.worktreeComparison.left.kind, 'executable');
    if (process.platform !== 'win32') {
        await fs.chmod(path.join(f.repo, 'file.txt'), 0o755); const b = await workCompare(f);
        await fs.chmod(path.join(f.repo, 'file.txt'), 0o644); const c = await workCompare(f);
        assert.equal(b.patch, ''); assert.notEqual(b.worktreeComparison.version, c.worktreeComparison.version);
        assert.equal(b.worktreeComparison.right.mode, 0o755); assert.equal(c.worktreeComparison.right.mode, 0o644);
    }
});

test('binary, image and non-UTF8 disk content return explicit metadata without image payload in pages', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.repo, 'binary.bin'), Buffer.from([0, 1]));
    const binary = await workCompare(f, edge(f.head), 'binary.bin'); assert.match(binary.after.notice, /二进制/); assert.ok(binary.patchNotice);
    await fs.writeFile(path.join(f.repo, 'image.png'), Buffer.from([137, 80, 78, 71, 0]));
    const image = await workPage(f, { path: 'image.png', view: 'after' }); assert.equal(image.after.kind, 'image'); assert.equal(image.text, ''); assert.ok(!JSON.stringify(image).includes('data:image'));
    await fs.writeFile(path.join(f.repo, 'file.txt'), Buffer.from([0xff, 0xfe]));
    const invalid = await workCompare(f); assert.match(invalid.after.notice, /不是有效 UTF-8/); assert.equal(invalid.after.text, undefined);
});

test('raw working comparison never expands LFS pointers or calls LFS helpers', async t => {
    const f = await fixture(t), pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 12\n`;
    await commit(f, 'pointer.txt', pointer);
    const run = f.desk.git.bind(f.desk); f.desk.git = async (repo, args, options) => { assert.ok(!args.includes('lfs')); return run(repo, args, options); };
    const diff = await workCompare(f, edge(f.head, 'pointer.txt'), 'pointer.txt');
    assert.equal(diff.before.lfs, true); assert.equal(diff.after.lfs, true); assert.match(diff.before.notice, /不展开/); assert.ok(diff.patchNotice);
});

test('working comparison preserves raw CRLF bytes without invoking configured clean or textconv programs', async t => {
    const f = await fixture(t); await fs.writeFile(path.join(f.repo, 'file.txt'), 'first\r\n');
    const repository = await f.desk.repo('.', true); f.desk.repo = async () => repository;
    git(f.repo, 'config', 'filter.blocked.clean', 'false'); git(f.repo, 'config', 'diff.blocked.textconv', 'false');
    await fs.writeFile(path.join(f.repo, '.gitattributes'), 'file.txt filter=blocked diff=blocked -text\n');
    const diff = await workCompare(f); assert.equal(diff.after.text, 'first\r\n'); assert.equal(diff.before.text, 'first\n');
    assert.match(diff.summary, /换行归一化/);
});

test('working comparison bounds file bytes and patch text budget without retaining completed snapshots', async t => {
    const f = await fixture(t); await fs.writeFile(path.join(f.repo, 'file.txt'), 'x'.repeat(5 * 1024 * 1024 + 1));
    await assert.rejects(workCompare(f), /5 MiB/);
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'x'.repeat(2 * 1024 * 1024));
    const diff = await workCompare(f); assert.match(diff.patchNotice, /2 MiB/); assert.equal(diff.patch, '');
    assert.equal(f.desk.worktreeComparisonReads.size, 0);
});

test('edits during rendering invalidate the response and release the in-flight slot', async t => {
    const f = await fixture(t); await fs.writeFile(path.join(f.repo, 'file.txt'), 'before rendering\n');
    const render = f.desk.renderFileDiff.bind(f.desk);
    f.desk.renderFileDiff = async (...args) => { const diff = await render(...args); await fs.writeFile(path.join(f.repo, 'file.txt'), 'changed during rendering\n'); return diff; };
    await assert.rejects(workCompare(f), FileComparisonStateChangedError); assert.equal(f.desk.worktreeComparisonReads.size, 0);
    f.desk.renderFileDiff = render; const fresh = await workCompare(f); assert.equal(fresh.after.text, 'changed during rendering\n');
});

test('working and historical comparisons share a global in-flight limit and failures release slots', async t => {
    const f = await fixture(t); await fs.writeFile(path.join(f.repo, 'file.txt'), 'changed\n');
    await f.desk.snapshot(true);
    const read = f.desk.readWorktreeComparison.bind(f.desk); let release;
    const gate = new Promise(resolve => { release = resolve; }); let started = 0;
    f.desk.readWorktreeComparison = async (...args) => { started++; await gate; return read(...args); };
    const a = workCompare(f), b = workCompare(f, edge(f.head), 'other.txt');
    try {
        for (let attempt = 0; started < 2 && attempt < 500; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(started, 2); await assert.rejects(compare(f, edge(f.head), edge(f.head)), /查询过多/);
    } finally { release(); await Promise.allSettled([a, b]); }
    assert.equal(f.desk.worktreeComparisonReads.size, 0);
});

test('coalesced working reads return caller-owned copies and refuse running tasks', async t => {
    const f = await fixture(t), [a, b] = await Promise.all([workCompare(f), workCompare(f)]);
    a.after.text = 'corrupt'; a.worktreeComparison.right.path = 'elsewhere';
    assert.equal(b.after.text, 'first\n'); assert.equal(b.worktreeComparison.right.path, 'file.txt');
    assert.equal(f.desk.worktreeComparisonReads.size, 0);
    f.desk.taskState = { id: 'busy', status: 'running' }; await assert.rejects(workCompare(f), /任务/);
});


const indexCompare = (f, left = edge(f.head), name = 'file.txt', extra = {}) => f.desk.diff({ repo: '.', path: name, area: 'index-compare', left, ...extra });
const indexPage = (f, extra = {}) => f.desk.compareIndexPage('.', { left: edge(f.head), path: 'file.txt', ...extra });

test('historical versus index comparison reads only staged objects and preserves disk, refs and index bytes', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'staged\n'); git(f.repo, 'add', 'file.txt');
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'later disk\n');
    const index = await fs.readFile(path.join(f.repo, '.git/index')), refs = git(f.repo, 'show-ref');
    f.desk.recovery.readDisk = async () => { throw new Error('must not read disk through recovery'); };
    const diff = await indexCompare(f);
    assert.equal(diff.before.text, 'first\n'); assert.equal(diff.after.text, 'staged\n'); assert.equal(diff.partial, undefined);
    assert.equal(diff.indexComparison.indexOnly, true); assert.equal(diff.indexComparison.normalization, 'raw');
    assert.equal(diff.indexComparison.right.stage, 0); assert.equal(diff.indexComparison.right.object, git(f.repo, 'rev-parse', ':file.txt'));
    assert.match(diff.patch, /\+staged/); assert.match(diff.summary, /不是暂存快照/);
    assert.equal(git(f.repo, 'show-ref'), refs); assert.deepEqual(await fs.readFile(path.join(f.repo, '.git/index')), index);
    assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'later disk\n'); assert.deepEqual(f.calls, { editor: 0, before: 0, after: 0 });
});

test('index comparison keeps identity across disk edits and unrelated staging but changes on selected staging', async t => {
    const f = await fixture(t), a = await indexCompare(f);
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'disk edit\n');
    await fs.writeFile(path.join(f.repo, 'other.txt'), 'other\n'); git(f.repo, 'add', 'other.txt');
    const b = await indexCompare(f); assert.equal(b.indexComparison.version, a.indexComparison.version); assert.equal(b.after.text, 'first\n');
    git(f.repo, 'add', 'file.txt'); const c = await indexCompare(f);
    assert.equal(c.after.text, 'disk edit\n'); assert.notEqual(c.indexComparison.version, b.indexComparison.version);
    assert.equal(f.desk.indexComparisonReads.size, 0);
});

test('index fragments bind selected stage zero content and require a version for subsequent pages', async t => {
    const f = await fixture(t); await fs.writeFile(path.join(f.repo, 'file.txt'), 'hello\nworld\n'); git(f.repo, 'add', 'file.txt');
    const a = await indexPage(f, { view: 'after', limit: 6 }); assert.equal(a.text, 'hello\n'); assert.equal(a.cachedUpToMs, 0);
    const b = await indexPage(f, { view: 'after', offset: 6, limit: 6, version: a.comparison.version }); assert.equal(b.text, 'world\n');
    await assert.rejects(indexPage(f, { view: 'after', offset: 6 }), FileComparisonStateChangedError);
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'hello\nother\n'); git(f.repo, 'add', 'file.txt');
    for (const view of ['before', 'after', 'patch', 'summary']) await assert.rejects(indexPage(f, { view, version: a.comparison.version }), FileComparisonStateChangedError);
});

test('missing index entry remains distinct from a staged empty file or a disk-only file', async t => {
    const f = await fixture(t); git(f.repo, 'rm', '--cached', 'file.txt');
    const missing = await indexCompare(f); assert.equal(missing.indexComparison.right.kind, 'missing'); assert.equal(missing.indexComparison.right.object, undefined);
    assert.equal(missing.after.text, ''); assert.match(missing.patch, /-first/); assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'first\n');
    await fs.writeFile(path.join(f.repo, 'file.txt'), ''); git(f.repo, 'add', 'file.txt');
    const empty = await indexCompare(f); assert.equal(empty.indexComparison.right.kind, 'file'); assert.equal(empty.indexComparison.right.size, 0); assert.equal(empty.after.text, '');
    assert.notEqual(empty.indexComparison.version, missing.indexComparison.version);
    const absent = await indexCompare(f, edge(f.head), 'missing/child.txt'); assert.equal(absent.indexComparison.right.kind, 'missing');
});

test('intent-to-add is not presented as a staged empty file', async t => {
    const f = await fixture(t); await fs.writeFile(path.join(f.repo, 'new.txt'), 'not staged\n'); git(f.repo, 'add', '-N', 'new.txt');
    await assert.rejects(indexCompare(f, edge(f.head), 'new.txt'), /待添加/);
    git(f.repo, 'add', 'new.txt'); const staged = await indexCompare(f, edge(f.head), 'new.txt'); assert.equal(staged.after.text, 'not staged\n');
    await fs.writeFile(path.join(f.repo, 'empty.txt'), ''); git(f.repo, 'add', '-N', 'empty.txt');
    await assert.rejects(indexCompare(f, edge(f.head), 'empty.txt'), /待添加/);
    git(f.repo, 'add', 'empty.txt'); assert.equal((await indexCompare(f, edge(f.head), 'empty.txt')).after.text, '');
});

test('unmerged index stages are refused rather than selecting ours or theirs', async t => {
    const f = await fixture(t); git(f.repo, 'switch', '-c', 'topic'); await commit(f, 'file.txt', 'topic\n');
    git(f.repo, 'switch', 'dev'); await commit(f, 'file.txt', 'ours\n');
    assert.throws(() => git(f.repo, 'merge', '--no-edit', 'topic'));
    await assert.rejects(indexCompare(f), /冲突/); assert.equal(f.desk.indexComparisonReads.size, 0);
});

test('index comparisons support explicit cross-path and executable modes without reading disk paths', { skip: exoticNames }, async t => {
    const f = await fixture(t), name = 'dir/[literal]*文件\n.txt';
    await fs.mkdir(path.join(f.repo, 'dir')); await fs.writeFile(path.join(f.repo, name), 'index only\n');
    git(f.repo, '--literal-pathspecs', 'add', '--', name); git(f.repo, '--literal-pathspecs', 'update-index', '--chmod=+x', '--', name);
    await fs.unlink(path.join(f.repo, name));
    const diff = await indexCompare(f, edge(f.head), name);
    assert.equal(diff.after.text, 'index only\n'); assert.equal(diff.indexComparison.right.path, name); assert.equal(diff.indexComparison.right.mode, '100755');
    assert.equal(diff.indexComparison.left.path, 'file.txt'); assert.match(diff.summary, /不推断重命名/);
});

test('index comparisons reject directory ranges, submodule entries and staged links', async t => {
    const f = await fixture(t); await commit(f, 'folder/child.txt', 'child');
    await assert.rejects(indexCompare(f, edge(f.head), 'folder'), /精确文件/);
    git(f.repo, 'update-index', '--add', '--cacheinfo', `160000,${'f'.repeat(40)},child`);
    await assert.rejects(indexCompare(f, edge(f.head), 'child'), /子模块/);
    if (process.platform !== 'win32') {
        await fs.symlink('file.txt', path.join(f.repo, 'link.txt')); git(f.repo, 'add', 'link.txt');
        await assert.rejects(indexCompare(f, edge(f.head), 'link.txt'), /链接/);
    }
});

test('index comparison validates pinned endpoints and rejects unknown fields or malformed fragments', async t => {
    const f = await fixture(t);
    await assert.rejects(indexCompare(f, edge('HEAD')));
    await assert.rejects(indexCompare(f, { ...edge(f.head), extra: true }));
    for (const name of ['../outside', '/outside', '.git/config', 'a\0b', '\ud800']) await assert.rejects(indexCompare(f, edge(f.head), name));
    for (const extra of [{ force: true }, { right: edge(f.head) }, { revision: f.head }]) await assert.rejects(indexCompare(f, edge(f.head), 'file.txt', extra), /无关字段/);
    for (const extra of [{ limit: 16001 }, { offset: -1 }, { view: 'image' }, { force: true }, { view: 'summary', offset: 1 }]) await assert.rejects(indexPage(f, extra));
});

test('index snapshots preserve binary, image and invalid UTF8 metadata without Agent image payloads', async t => {
    const f = await fixture(t); await fs.writeFile(path.join(f.repo, 'file.txt'), Buffer.from([0, 1])); git(f.repo, 'add', 'file.txt');
    const binary = await indexPage(f, { view: 'after' }); assert.equal(binary.after.kind, 'notice'); assert.match(binary.after.notice, /二进制/); assert.equal(binary.patchAvailable, false);
    await fs.writeFile(path.join(f.repo, 'image.png'), Buffer.from([137, 80, 78, 71, 0])); git(f.repo, 'add', 'image.png');
    const image = await indexPage(f, { path: 'image.png', view: 'after' }); assert.equal(image.after.kind, 'image'); assert.ok(!JSON.stringify(image).includes('data:image'));
    await fs.writeFile(path.join(f.repo, 'file.txt'), Buffer.from([0xff, 0xfe])); git(f.repo, 'add', 'file.txt');
    assert.match((await indexCompare(f)).after.notice, /不是有效 UTF-8/);
});

test('index LFS pointers are never expanded and preview limits do not load oversized blobs', async t => {
    const f = await fixture(t), pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${'b'.repeat(64)}\nsize 4\n`;
    await fs.writeFile(path.join(f.repo, 'file.txt'), pointer); git(f.repo, 'add', 'file.txt');
    const run = f.desk.git.bind(f.desk); f.desk.git = async (repo, args, options) => { assert.ok(!args.includes('lfs')); return run(repo, args, options); };
    assert.match((await indexCompare(f)).after.notice, /不展开/);
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'x'.repeat(5 * 1024 * 1024 + 1)); git(f.repo, 'add', 'file.txt');
    const hugeObject = git(f.repo, 'rev-parse', ':file.txt');
    f.desk.git = async (repo, args, options) => { assert.ok(!args.includes('lfs')); assert.ok(!(args.includes('cat-file') && args.includes('blob') && args.includes(hugeObject))); return run(repo, args, options); };
    const huge = await indexCompare(f); assert.match(huge.after.notice, /5 MiB/); assert.equal(huge.after.text, undefined);
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'x'.repeat(2 * 1024 * 1024)); git(f.repo, 'add', 'file.txt');
    assert.match((await indexCompare(f)).patchNotice, /2 MiB/);
});

test('staging during rendering invalidates an index response and releases its slot', async t => {
    const f = await fixture(t); await fs.writeFile(path.join(f.repo, 'file.txt'), 'staged\n'); git(f.repo, 'add', 'file.txt');
    const render = f.desk.renderFileDiff.bind(f.desk);
    f.desk.renderFileDiff = async (...args) => { const value = await render(...args); await fs.writeFile(path.join(f.repo, 'file.txt'), 'new staging\n'); git(f.repo, 'add', 'file.txt'); return value; };
    await assert.rejects(indexCompare(f), FileComparisonStateChangedError); assert.equal(f.desk.indexComparisonReads.size, 0);
});

test('coalesced index reads are isolated from callers, share all comparison slots and reject busy tasks', async t => {
    const f = await fixture(t), [a, b] = await Promise.all([indexCompare(f), indexCompare(f)]);
    a.indexComparison.right.path = 'corrupted'; a.after.text = 'corrupted';
    assert.equal(b.indexComparison.right.path, 'file.txt'); assert.equal(b.after.text, 'first\n'); assert.equal(f.desk.indexComparisonReads.size, 0);
    f.desk.fileComparisonReads.set('one', Promise.resolve({})); f.desk.worktreeComparisonReads.set('two', Promise.resolve({}));
    await assert.rejects(indexCompare(f), /查询过多/); f.desk.fileComparisonReads.clear(); f.desk.worktreeComparisonReads.clear();
    f.desk.taskState = { id: 'busy', status: 'running' }; await assert.rejects(indexCompare(f), /任务/);
});

test('comparison headers are stable across temp directories and preserve header-looking source lines',async t=>{
    const f=await fixture(t);
    await commit(f,'file.txt','base\n');const first=f.head;
    await commit(f,'file.txt','-- before\n++ after\n');
    const one=await compare(f,edge(first),edge(f.head));
    // A new service prevents a completed comparison cache from hiding random temp paths.
    const other=new GitDesk(f.repo,path.join(path.dirname(f.repo),'other-cache'),{checkEditor:async()=>{},beforeWorktreeChange:async()=>{},afterWorktreeChange:async()=>{}});
    const two=await other.diff({repo:'.',path:'file.txt',area:'file-compare',left:edge(first),right:edge(f.head)});
    assert.equal(one.patch,two.patch);assert.match(one.patch,/before\/file\.txt/);
    assert.match(one.patch,/\+-- before/);assert.match(one.patch,/\+\+\+ after/);
});
