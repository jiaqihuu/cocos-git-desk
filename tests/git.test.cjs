const { test } = require('node:test');
const { windows, portableName, exoticNames, posixModes, linkTarget } = require('./platform.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GitDesk, parseStatus } = require('../dist/git');

const work = path.resolve(__dirname, '../.test-work');
process.env.GIT_ALLOW_PROTOCOL = 'file';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd();
async function init(dir) {
    await fs.mkdir(dir, { recursive: true }); git(dir, 'init', '-b', 'dev');
    git(dir, 'config', 'user.name', 'Git Desk Test'); git(dir, 'config', 'user.email', 'git-desk@example.invalid');
    git(dir, 'config', 'commit.gpgSign', 'false'); git(dir, 'config', 'core.hooksPath', path.join(dir, '.no-hooks'));
}
async function fixture(t, seed = true) {
    await fs.mkdir(work, { recursive: true });
    const base = await fs.mkdtemp(path.join(work, 'git-'));
    const repo = path.join(base, 'project'); await init(repo);
    if (seed) { await fs.writeFile(path.join(repo, 'file.txt'), 'first\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'initial'); }
    const calls = { before: 0, after: 0, dirty: false, failRefresh: false };
    const desk = new GitDesk(repo, path.join(base, 'cache'), {
        async checkEditor() { if (calls.dirty) throw new Error('unsaved scene'); },
        async beforeWorktreeChange() { calls.before++; },
        async afterWorktreeChange() { calls.after++; if (calls.failRefresh) throw new Error('refresh failed'); },
    });
    t.after(async () => { await fs.rm(base, { recursive: true, force: true }); });
    return { base, repo, desk, calls };
}
async function plan(desk, action, args = {}) {
    const s = await desk.snapshot(true), id = args.repo || '.';
    const repo = s.repositories.find(r => r.id === id);
    return desk.prepare({ repo: id, version: repo.version, action, ...args });
}
async function finish(desk, p) {
    desk.execute(p.token);
    const start = Date.now();
    while (desk.task().status === 'running') {
        if (Date.now() - start > 30000) throw new Error('task test timeout');
        await new Promise(resolve => setTimeout(resolve, 15));
    }
    return desk.task();
}
async function perform(desk, action, args = {}) {
    const result = await finish(desk, await plan(desk, action, args));
    assert.equal(result.status, 'success', result.log); return result;
}

test('porcelain handles renames, conflicts, unicode and newlines', () => {
    const files = parseStatus('R  新 文件.ts\0old\nname.ts\0UU conflict\0 M child\0?? :(glob)*.txt\0', new Set(['child']));
    assert.equal(files[0].oldPath, 'old\nname.ts'); assert.equal(files[1].conflict, true);
    assert.equal(files[2].submodule, true); assert.equal(files[3].path, ':(glob)*.txt');
});

test('unborn repository supports stage, unstage and first commit; literal paths stay literal', async t => {
    const { repo, desk } = await fixture(t, false);
    const name = portableName(':(glob)* 中文\nfile.ts');
    await fs.writeFile(path.join(repo, name), 'content\n'); await fs.writeFile(path.join(repo, name + '.meta'), '{}\n');
    const p = await plan(desk, 'stage', { paths: [name] }); assert.deepEqual(p.paths, [name, name + '.meta']);
    assert.equal((await finish(desk, p)).status, 'success');
    await perform(desk, 'unstage', { paths: [name, name + '.meta'] });
    assert.equal(git(repo, 'ls-files'), '');
    await perform(desk, 'stage', { paths: [name] });
    await perform(desk, 'commit', { message: '首个提交' });
    assert.equal(git(repo, 'log', '-1', '--format=%s'), '首个提交');
});

test('commit only includes staged paths, preserves unrelated files, and does not push', async t => {
    const { repo, desk } = await fixture(t);
    await fs.writeFile(path.join(repo, 'file.txt'), 'new\n'); await fs.writeFile(path.join(repo, 'unrelated.txt'), 'keep\n');
    await perform(desk, 'stage', { paths: ['file.txt'] });
    const p = await plan(desk, 'commit', { message: '指定文件' }); assert.deepEqual(p.paths, ['file.txt']);
    await finish(desk, p);
    assert.equal(git(repo, 'status', '--porcelain'), '?? unrelated.txt');
    assert.equal(git(repo, 'show', 'HEAD:file.txt'), 'new');
});

test('changed contents after preview are rejected even when porcelain status is unchanged', async t => {
    const { repo, desk } = await fixture(t);
    await fs.writeFile(path.join(repo, 'file.txt'), 'one\n');
    const p = await plan(desk, 'stage', { paths: ['file.txt'] });
    assert.equal(p.directIndexAction, 'stage');
    await fs.writeFile(path.join(repo, 'file.txt'), 'two\n');
    const result = await finish(desk, p); assert.equal(result.status, 'failed'); assert.match(result.log, /预览后仓库发生变化/);
    assert.equal(git(repo, 'diff', '--cached'), ''); assert.throws(() => desk.execute(p.token), /过期/);
});

test('ordinary stage and unstage plans preserve disk and unrelated staged paths', async t => {
    const { repo, desk } = await fixture(t);
    await fs.writeFile(path.join(repo, 'file.txt'), 'working\n');
    await fs.writeFile(path.join(repo, 'other.txt'), 'unrelated staged\n'); git(repo, 'add', 'other.txt');
    const stage = await plan(desk, 'stage', { paths: ['file.txt'] });
    assert.equal(stage.directIndexAction, 'stage'); assert.deepEqual(stage.warnings, []);
    assert.equal((await finish(desk, stage)).status, 'success');
    const unstage = await plan(desk, 'unstage', { paths: ['file.txt'] });
    assert.equal(unstage.directIndexAction, 'unstage'); assert.deepEqual(unstage.warnings, []);
    assert.equal((await finish(desk, unstage)).status, 'success');
    assert.equal(await fs.readFile(path.join(repo, 'file.txt'), 'utf8'), 'working\n');
    assert.equal(git(repo, 'show', ':file.txt'), 'first');
    assert.equal(git(repo, 'show', ':other.txt'), 'unrelated staged');
});

test('automatic meta expansion requires review but explicitly selected pairs can apply directly', async t => {
    const { repo, desk } = await fixture(t);
    await fs.writeFile(path.join(repo, 'file.txt'), 'working\n');
    await fs.writeFile(path.join(repo, 'file.txt.meta'), '{}\n');
    const expanded = await plan(desk, 'stage', { paths: ['file.txt'] });
    assert.equal(expanded.directIndexAction, undefined); assert.match(expanded.warnings.join('\n'), /未勾选/);
    const selected = await plan(desk, 'stage', { paths: ['file.txt.meta', 'file.txt'] });
    assert.equal(selected.directIndexAction, 'stage'); assert.deepEqual(selected.warnings, []);
});

test('renames and type changes retain confirmation', async t => {
    const { repo, desk } = await fixture(t);
    git(repo, 'mv', 'file.txt', 'moved.txt');
    const renamed = await plan(desk, 'unstage', { paths: ['moved.txt'] });
    assert.equal(renamed.directIndexAction, undefined); assert.ok(renamed.paths.includes('file.txt'));
    git(repo, 'commit', '-m', 'rename');
    await fs.unlink(path.join(repo, 'moved.txt')); await fs.symlink('target.txt', path.join(repo, 'moved.txt'));
    assert.equal((await plan(desk, 'stage', { paths: ['moved.txt'] })).directIndexAction, undefined);
});

test('working/staged/history diffs show exact areas and literal contents safely', async t => {
    const { repo, desk } = await fixture(t);
    await fs.writeFile(path.join(repo, 'file.txt'), 'second\n<script>example</script>\n');
    await perform(desk, 'stage', { paths: ['file.txt'] });
    await fs.writeFile(path.join(repo, 'file.txt'), 'third\n');
    const index = await desk.diff({ repo: '.', path: 'file.txt', area: 'index' });
    const tree = await desk.diff({ repo: '.', path: 'file.txt', area: 'worktree' });
    assert.equal(index.before.text, 'first\n'); assert.match(index.patch, /\+second/); assert.equal(tree.after.text, 'third\n');
    await perform(desk, 'commit', { message: 'second' });
    const history = await desk.history('.'); assert.equal(history.length, 2);
    const files = await desk.commitFiles('.', history[0].sha); assert.equal(files[0].path, 'file.txt');
    const old = await desk.diff({ repo: '.', path: 'file.txt', area: 'commit', revision: history[0].sha });
    assert.equal(old.after.text, 'second\n<script>example</script>\n');
});

test('dirty worktree blocks branch changes; unsaved scenes block resource commits only', async t => {
    const { repo, desk, calls } = await fixture(t);
    await fs.writeFile(path.join(repo, 'file.txt'), 'dirty\n');
    await assert.rejects(plan(desk, 'createBranch', { branch: 'feature/new' }), /本地改动/);
    await perform(desk, 'stage', { paths: ['file.txt'] }); calls.dirty = true;
    await perform(desk, 'commit', { message: 'text-only allowed' });
    await fs.mkdir(path.join(repo, 'assets'));
    await fs.writeFile(path.join(repo, 'assets/test.scene'), '{}');
    await fs.writeFile(path.join(repo, 'assets/test.scene.meta'), '{}');
    await perform(desk, 'stage', { paths: ['assets/test.scene', 'assets/test.scene.meta'] });
    await assert.rejects(plan(desk, 'commit', { message: 'blocked' }), /unsaved/);
    assert.equal(calls.before, 0);
});

test('branch creation and switching refresh editor; refresh failure reports Git outcome', async t => {
    const { repo, desk, calls } = await fixture(t);
    await perform(desk, 'createBranch', { branch: 'feature/new' });
    assert.equal(git(repo, 'branch', '--show-current'), 'feature/new');
    calls.failRefresh = true;
    const result = await finish(desk, await plan(desk, 'switch', { branch: 'dev' }));
    assert.equal(result.status, 'failed'); assert.match(result.log, /Git 已执行/);
    assert.equal(git(repo, 'branch', '--show-current'), 'dev'); assert.equal(calls.before, calls.after);
});

test('push sets an explicit upstream and fast-forward update uses it', async t => {
    const { repo, base, desk, calls } = await fixture(t);
    const remote = path.join(base, 'remote.git'); git(base, 'init', '--bare', remote); git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'config', 'push.followTags', 'true'); git(repo, 'tag', '-a', 'private-tag', '-m', 'not requested');
    await perform(desk, 'push', { remote: 'origin' });
    assert.equal(git(remote, 'tag'), '');
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/dev');
    const peer = path.join(base, 'peer'); git(base, 'clone', '-b', 'dev', remote, peer); git(peer, 'config', 'user.name', 'Peer'); git(peer, 'config', 'user.email', 'peer@example.invalid'); git(peer, 'config', 'commit.gpgSign', 'false');
    await fs.writeFile(path.join(peer, 'file.txt'), 'peer\n'); git(peer, 'commit', '-am', 'peer'); git(peer, 'push');
    await perform(desk, 'pull'); assert.equal(await fs.readFile(path.join(repo, 'file.txt'), 'utf8'), 'peer\n');
    assert.equal(calls.before, calls.after); assert.equal(calls.after, 1);
});

test('diverged branches stop without merge and always restore editor state', async t => {
    const { repo, base, desk, calls } = await fixture(t);
    const remote = path.join(base, 'remote.git'); git(base, 'init', '--bare', remote); git(repo, 'remote', 'add', 'origin', remote); await perform(desk, 'push', { remote: 'origin' });
    const old = git(repo, 'rev-parse', 'HEAD');
    await fs.writeFile(path.join(repo, 'file.txt'), 'local\n'); git(repo, 'commit', '-am', 'local');
    const local = git(repo, 'rev-parse', 'HEAD');
    const peer = path.join(base, 'peer'); git(base, 'clone', '-b', 'dev', remote, peer); git(peer, 'config', 'user.name', 'Peer'); git(peer, 'config', 'user.email', 'peer@example.invalid'); git(peer, 'config', 'commit.gpgSign', 'false');
    assert.equal(git(peer, 'rev-parse', 'HEAD'), old);
    await fs.writeFile(path.join(peer, 'file.txt'), 'remote\n'); git(peer, 'commit', '-am', 'remote'); git(peer, 'push');
    const result = await finish(desk, await plan(desk, 'pull')); assert.equal(result.status, 'failed');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), local); assert.equal(git(repo, 'status', '--porcelain'), ''); assert.equal(calls.before, calls.after);
});

test('recursive submodules are separate repos; pointer stage requires explicit opt-in', async t => {
    const { repo, base, desk } = await fixture(t);
    const leaf = path.join(base, 'leaf'), child = path.join(base, 'child'); await init(leaf); await fs.writeFile(path.join(leaf, 'leaf'), 'leaf'); git(leaf, 'add', '.'); git(leaf, 'commit', '-m', 'leaf');
    await init(child); git(child, '-c', 'protocol.file.allow=always', 'submodule', 'add', leaf, 'nested/leaf'); git(child, 'commit', '-am', 'child');
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'modules/child'); git(repo, 'commit', '-am', 'module');
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive');
    let snap = await desk.snapshot(true); assert.deepEqual(snap.repositories.map(r => r.id), ['.', 'modules/child', 'modules/child/nested/leaf']);
    const sub = path.join(repo, 'modules/child'); git(sub, 'config', 'user.name', 'Test'); git(sub, 'config', 'user.email', 'test@example.invalid'); git(sub, 'config', 'commit.gpgSign', 'false');
    await fs.writeFile(path.join(sub, 'new.txt'), 'new'); git(sub, 'add', '.'); git(sub, 'commit', '-m', 'local module change');
    await assert.rejects(plan(desk, 'stage', { paths: ['modules/child'] }), /明确勾选/);
    const pointerPlan = await plan(desk, 'stage', { paths: ['modules/child'], includePointers: true });
    assert.equal(pointerPlan.directIndexAction, undefined); assert.match(pointerPlan.warnings.join('\n'), /子模块/);
    await assert.rejects(plan(desk, 'syncSubmodules'), /未推送|没有远端引用/);
    await perform(desk, 'stage', { paths: ['modules/child'], includePointers: true });
    assert.match(git(repo, 'diff', '--cached'), /Subproject commit/);
});

test('uninitialized submodules can be synchronized without touching unrelated repositories', async t => {
    const { repo, base, calls } = await fixture(t);
    const child = path.join(base, 'child'); await init(child); await fs.writeFile(path.join(child, 'leaf'), 'leaf'); git(child, 'add', '.'); git(child, 'commit', '-m', 'leaf');
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'modules/child'); git(repo, 'commit', '-am', 'module');
    const clone = path.join(base, 'clone'); git(base, 'clone', repo, clone);
    const desk = new GitDesk(clone, path.join(base, 'cache'), { async checkEditor() {}, async beforeWorktreeChange() { calls.before++; }, async afterWorktreeChange() { calls.after++; } });
    assert.equal((await desk.snapshot(true)).repositories[1].initialized, false);
    await fs.writeFile(path.join(clone, 'unrelated.txt'), 'edit');
    await assert.rejects(plan(desk, 'syncSubmodules'), /有本地改动/, 'syncing everything still needs a clean parent');
    await assert.rejects(plan(desk, 'syncSubmodules', { paths: ['modules/nope'] }), /不是当前仓库的子模块/);
    const named = await plan(desk, 'syncSubmodules', { paths: ['modules/child'] }); assert.deepEqual(named.paths, ['modules/child']); assert.match(named.title, /指定子模块/);
    await perform(desk, 'syncSubmodules', { paths: ['modules/child'] }); assert.equal((await desk.snapshot(true)).repositories[1].initialized, true); assert.equal(calls.before, calls.after);
    assert.equal(await fs.readFile(path.join(clone, 'unrelated.txt'), 'utf8'), 'edit');
});

test('LFS prefab diff resolves local objects and reports missing historical objects', async t => {
    const { repo, desk } = await fixture(t);
    git(repo, 'config', '--unset', 'core.hooksPath'); git(repo, 'lfs', 'install', '--local'); git(repo, 'lfs', 'track', '*.prefab');
    const before = '[{"name":"before"}]\n', after = '[{"name":"after"}]\n';
    await fs.writeFile(path.join(repo, 'view.prefab'), before); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'prefab');
    await fs.writeFile(path.join(repo, 'view.prefab'), after); await desk.snapshot(true);
    const diff = await desk.diff({ repo: '.', path: 'view.prefab', area: 'worktree' });
    assert.equal(diff.before.text, before); assert.equal(diff.after.text, after); assert.equal(diff.before.lfs, true); assert.match(diff.patch, /\+.*after/);
    const pointer = git(repo, 'show', 'HEAD:view.prefab'), oid = /oid sha256:(\w+)/.exec(pointer)[1];
    const media = /^LocalMediaDir=(.+)$/m.exec(git(repo, 'lfs', 'env'))[1];
    await fs.unlink(path.join(media, oid.slice(0, 2), oid.slice(2, 4), oid));
    const missing = await desk.diff({ repo: '.', path: 'view.prefab', area: 'worktree' }); assert.match(missing.before.notice, /未下载/);
});

test('outside repo IDs and file paths are rejected', async t => {
    const { desk } = await fixture(t);
    await assert.rejects(desk.details('../outside'), /未初始化/);
    await assert.rejects(desk.diff({ repo: '.', path: '../../outside', area: 'worktree' }), /文件状态已变化/);
    const snapshot = await desk.snapshot(true);
    await assert.rejects(desk.prepare({ repo: '.', version: snapshot.repositories[0].version, action: 'deleteEverything' }), /不支持/);
});

test('remote/config changes after push preview invalidate the operation', async t => {
    const { repo, base, desk } = await fixture(t);
    const first = path.join(base, 'first.git'), second = path.join(base, 'second.git');
    git(base, 'init', '--bare', first); git(base, 'init', '--bare', second); git(repo, 'remote', 'add', 'origin', first);
    const p = await plan(desk, 'push', { remote: 'origin' });
    git(repo, 'remote', 'set-url', 'origin', second);
    const task = await finish(desk, p); assert.equal(task.status, 'failed'); assert.match(task.log, /预览后仓库发生变化|远端地址发生变化/);
    assert.equal(git(second, 'for-each-ref'), ''); assert.equal(git(first, 'for-each-ref'), '');
});

test('unregistered embedded repository cannot be staged as an ordinary directory', async t => {
    const { repo, desk } = await fixture(t); const nested = path.join(repo, 'unexpected'); await init(nested);
    await fs.writeFile(path.join(nested, 'nested.txt'), 'nested'); git(nested, 'add', '.'); git(nested, 'commit', '-m', 'nested');
    const s = await desk.snapshot(true), name = s.repositories[0].files.find(f => f.path.startsWith('unexpected')).path;
    await assert.rejects(plan(desk, 'stage', { paths: [name] }), /未登记的嵌套仓库/);
    assert.equal(git(repo, 'diff', '--cached'), '');
});

test('linked worktrees are supported and occupied branches fail without discarding files', async t => {
    const { repo, base, desk, calls } = await fixture(t);
    const other = path.join(base, 'linked'); git(repo, 'worktree', 'add', '-b', 'occupied', other);
    const linked = new GitDesk(other, path.join(base, 'cache-linked'), { async checkEditor() {}, async beforeWorktreeChange() {}, async afterWorktreeChange() {} });
    assert.equal((await linked.snapshot(true)).repositories[0].branch, 'occupied');
    await assert.rejects(plan(desk, 'switch', { branch: 'occupied' }), /其他工作目录中使用/);
    assert.equal(git(repo, 'branch', '--show-current'), 'dev'); assert.equal(calls.before, calls.after);
});

test('LFS fetch retrieves missing objects from a local remote without replacing worktree data', async t => {
    const { repo, base, desk } = await fixture(t);
    git(repo, 'config', '--unset', 'core.hooksPath'); git(repo, 'lfs', 'install', '--local'); git(repo, 'lfs', 'track', '*.prefab');
    const original = '[{"label":"stored"}]\n';
    await fs.writeFile(path.join(repo, 'view.prefab'), original); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'lfs');
    const remote = path.join(base, 'remote.git'); git(base, 'init', '--bare', remote); git(repo, 'remote', 'add', 'origin', remote);
    await perform(desk, 'push', { remote: 'origin' });
    const oid = /oid sha256:(\w+)/.exec(git(repo, 'show', 'HEAD:view.prefab'))[1];
    const media = /^LocalMediaDir=(.+)$/m.exec(git(repo, 'lfs', 'env'))[1];
    await fs.unlink(path.join(media, oid.slice(0, 2), oid.slice(2, 4), oid));
    await fs.writeFile(path.join(repo, 'view.prefab'), '[{"label":"local"}]\n');
    await perform(desk, 'lfsFetch', { remote: 'origin' });
    const diff = await desk.diff({ repo: '.', path: 'view.prefab', area: 'worktree' });
    assert.equal(diff.before.text, original); assert.match(diff.after.text, /local/);
});

test('inherited Git checkout variables cannot redirect plugin operations to another repository', async t => {
    const { repo, base, desk } = await fixture(t);
    const unrelated = path.join(base, 'unrelated'); await init(unrelated);
    const oldDir = process.env.GIT_DIR, oldTree = process.env.GIT_WORK_TREE;
    try {
        process.env.GIT_DIR = path.join(unrelated, '.git'); process.env.GIT_WORK_TREE = unrelated;
        const snapshot = await desk.snapshot(true); assert.equal(snapshot.root, repo); assert.equal(snapshot.repositories[0].branch, 'dev');
        await fs.writeFile(path.join(repo, 'file.txt'), 'changed\n');
        await perform(desk, 'stage', { paths: ['file.txt'] });
    } finally {
        if (oldDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = oldDir;
        if (oldTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = oldTree;
    }
    assert.equal(git(unrelated, 'ls-files'), ''); assert.match(git(repo, 'diff', '--cached'), /changed/);
});

test('stash saves all requested files, previews each area, restores the index and keeps the record', async t => {
    const { repo, desk, calls } = await fixture(t);
    await fs.writeFile(path.join(repo, '.gitignore'), 'ignored.log\n'); git(repo, 'add', '.gitignore'); git(repo, 'commit', '-m', 'ignore log');
    await fs.writeFile(path.join(repo, 'file.txt'), 'staged\n'); git(repo, 'add', 'file.txt');
    await fs.writeFile(path.join(repo, 'file.txt'), 'working\n');
    const added = portableName('新 文件\n.txt');
    await fs.writeFile(path.join(repo, added), 'new\n'); await fs.writeFile(path.join(repo, added + '.meta'), '{}\n');
    await fs.writeFile(path.join(repo, 'ignored.log'), 'keep ignored\n');
    const preview = await plan(desk, 'stashPush', { includeUntracked: true, message: '保存工作' });
    assert(preview.paths.includes(added)); assert(preview.paths.includes(added + '.meta')); assert(!preview.paths.includes('ignored.log'));
    assert.equal((await finish(desk, preview)).status, 'success');
    assert.equal(git(repo, 'status', '--porcelain'), ''); assert.equal(await fs.readFile(path.join(repo, 'ignored.log'), 'utf8'), 'keep ignored\n');
    const [stash] = await desk.stashes('.'); assert.equal(stash.ref, 'stash@{0}');
    const files = await desk.stashFiles('.', stash.sha);
    assert(files.some(f => f.path === added && f.stashPart === 'untracked'));
    for (const [part, expected] of [['tracked', 'working\n'], ['index', 'staged\n']]) {
        const diff = await desk.diff({ repo: '.', path: 'file.txt', area: 'stash', stashPart: part, revision: stash.sha });
        assert.equal(diff.before.text, 'first\n'); assert.equal(diff.after.text, expected);
    }
    const newFile = await desk.diff({ repo: '.', path: added, area: 'stash', stashPart: 'untracked', revision: stash.sha });
    assert.equal(newFile.before.text, ''); assert.equal(newFile.after.text, 'new\n');
    await perform(desk, 'stashApply', { stashRef: stash.ref, revision: stash.sha, restoreIndex: true });
    assert.equal(git(repo, 'show', ':file.txt'), 'staged'); assert.equal(await fs.readFile(path.join(repo, 'file.txt'), 'utf8'), 'working\n');
    assert.equal(await fs.readFile(path.join(repo, added), 'utf8'), 'new\n'); assert.equal((await desk.stashes('.')).length, 1);
    const restored = git(repo, 'status', '--porcelain');
    await perform(desk, 'stashDrop', { stashRef: stash.ref, revision: stash.sha });
    assert.equal((await desk.stashes('.')).length, 0); assert.equal(git(repo, 'status', '--porcelain'), restored);
    assert.equal(calls.before, 2); assert.equal(calls.after, 2);
});

test('stash preview includes staged changes even when worktree matches HEAD and can exclude untracked files', async t => {
    const { repo, desk } = await fixture(t);
    await fs.writeFile(path.join(repo, 'file.txt'), 'index only\n'); git(repo, 'add', 'file.txt');
    await fs.writeFile(path.join(repo, 'file.txt'), 'first\n');
    await fs.writeFile(path.join(repo, 'leave.txt'), 'leave\n');
    await perform(desk, 'stashPush', { includeUntracked: false });
    assert.equal(await fs.readFile(path.join(repo, 'leave.txt'), 'utf8'), 'leave\n');
    const [stash] = await desk.stashes('.'), files = await desk.stashFiles('.', stash.sha);
    assert(files.some(f => f.path === 'file.txt' && f.stashPart === 'index'));
    assert(!files.some(f => f.stashPart === 'untracked'));
    const diff = await desk.diff({ repo: '.', path: 'file.txt', area: 'stash', stashPart: 'index', revision: stash.sha });
    assert.equal(diff.after.text, 'index only\n');
});

test('stash recovery conflict preserves the record and always restores editor resources', async t => {
    const { repo, desk, calls } = await fixture(t);
    await fs.writeFile(path.join(repo, 'file.txt'), 'stash version\n'); await perform(desk, 'stashPush');
    const [stash] = await desk.stashes('.');
    await fs.writeFile(path.join(repo, 'file.txt'), 'new branch version\n'); git(repo, 'commit', '-am', 'diverge');
    const result = await finish(desk, await plan(desk, 'stashApply', { stashRef: stash.ref, revision: stash.sha, restoreIndex: false }));
    assert.equal(result.status, 'failed'); assert.match(result.log, /Stash 原记录仍保留/);
    assert.equal((await desk.stashes('.'))[0].sha, stash.sha);
    assert.match(git(repo, 'status', '--porcelain'), /UU file.txt/); assert.equal(calls.before, calls.after);
});

test('stash drop refuses changed reflog positions even when worktree is unchanged', async t => {
    const { repo, desk } = await fixture(t);
    await fs.writeFile(path.join(repo, 'file.txt'), 'stash version\n'); await perform(desk, 'stashPush');
    const [stash] = await desk.stashes('.');
    const preview = await plan(desk, 'stashDrop', { stashRef: stash.ref, revision: stash.sha });
    const other = git(repo, 'commit-tree', stash.sha + '^{tree}', '-p', stash.sha + '^1', '-p', stash.sha + '^2', '-m', 'different stash entry');
    assert.notEqual(other, stash.sha);
    git(repo, 'stash', 'store', '-m', 'another entry', other);
    const result = await finish(desk, preview);
    assert.equal(result.status, 'failed'); assert.match(result.log, /Stash 列表发生变化/); assert.equal((await desk.stashes('.')).length, 2);
});

test('stash cannot capture files added while the editor prepares a worktree change', async t => {
    const { repo, base } = await fixture(t);
    let restored = 0;
    const desk = new GitDesk(repo, path.join(base, 'late-cache'), {
        async checkEditor() {},
        async beforeWorktreeChange() { await fs.writeFile(path.join(repo, 'late.meta'), 'new import\n'); },
        async afterWorktreeChange() { restored++; },
    });
    await fs.writeFile(path.join(repo, 'file.txt'), 'local\n');
    const result = await finish(desk, await plan(desk, 'stashPush', { includeUntracked: true }));
    assert.equal(result.status, 'failed'); assert.match(result.log, /编辑器准备期间仓库发生变化/);
    assert.equal((await desk.stashes('.')).length, 0); assert.equal(restored, 1);
    assert.equal(await fs.readFile(path.join(repo, 'file.txt'), 'utf8'), 'local\n');
    assert.equal(await fs.readFile(path.join(repo, 'late.meta'), 'utf8'), 'new import\n');
});

test('stash refuses overwriting ignored files or restoring through a symlink', async t => {
    const { repo, base, desk } = await fixture(t);
    await fs.mkdir(path.join(repo, 'folder')); await fs.writeFile(path.join(repo, 'folder/new.txt'), 'saved\n');
    await perform(desk, 'stashPush', { includeUntracked: true }); const [stash] = await desk.stashes('.');
    await fs.writeFile(path.join(repo, '.gitignore'), 'folder\n'); git(repo, 'add', '.gitignore'); git(repo, 'commit', '-m', 'ignore folder');
    await fs.mkdir(path.join(repo, 'folder'), { recursive: true }); await fs.writeFile(path.join(repo, 'folder/new.txt'), 'do not replace\n');
    const args = { stashRef: stash.ref, revision: stash.sha };
    await assert.rejects(plan(desk, 'stashApply', args), /重名/);
    assert.equal(await fs.readFile(path.join(repo, 'folder/new.txt'), 'utf8'), 'do not replace\n');
    await fs.rm(path.join(repo, 'folder'), { recursive: true });
    const target = path.join(base, 'external'); await fs.mkdir(target); await fs.symlink(target, path.join(repo, 'folder'));
    await assert.rejects(plan(desk, 'stashApply', args), /符号链接/);
    assert.deepEqual(await fs.readdir(target), []);
});

test('stash rejects dirty submodules and unregistered embedded repositories', async t => {
    const { repo, base, desk } = await fixture(t);
    const child = path.join(base, 'child'); await init(child); await fs.writeFile(path.join(child, 'leaf'), 'initial'); git(child, 'add', '.'); git(child, 'commit', '-m', 'leaf');
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'module'); git(repo, 'commit', '-am', 'module');
    await fs.writeFile(path.join(repo, 'module/leaf'), 'modified');
    await assert.rejects(plan(desk, 'stashPush', { includeUntracked: true }), /子模块/);
    await fs.writeFile(path.join(repo, 'module/leaf'), 'initial');
    const nested = path.join(repo, 'unexpected'); await init(nested); await fs.writeFile(path.join(nested, 'leaf'), 'nested');
    await assert.rejects(plan(desk, 'stashPush', { includeUntracked: true }), /未登记的嵌套仓库/);
    assert.equal((await desk.stashes('.')).length, 0);
});

test('remote checkout uses an explicit cached ref and sets upstream without contacting the remote', async t => {
    const { repo, base, desk } = await fixture(t);
    git(repo, 'remote', 'add', 'origin', path.join(base, 'offline.git'));
    git(repo, 'update-ref', 'refs/remotes/origin/team/topic', 'HEAD');
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/team/topic');
    const { remoteBranches } = await desk.details('.'); assert.equal(remoteBranches.length, 1);
    const [remote] = remoteBranches; assert.equal(remote.branch, 'team/topic');
    await perform(desk, 'checkoutRemote', { remoteBranch: remote.ref, revision: remote.sha, branch: 'feature/topic' });
    assert.equal(git(repo, 'branch', '--show-current'), 'feature/topic');
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/team/topic');
    await assert.rejects(plan(desk, 'checkoutRemote', { remoteBranch: remote.ref, revision: remote.sha, branch: 'dev' }), /已存在/);
});

test('remote ref changes after preview do not create or switch a local branch', async t => {
    const { repo, base, desk } = await fixture(t);
    git(repo, 'remote', 'add', 'origin', path.join(base, 'offline.git')); git(repo, 'update-ref', 'refs/remotes/origin/topic', 'HEAD');
    const [remote] = (await desk.details('.')).remoteBranches;
    const preview = await plan(desk, 'checkoutRemote', { remoteBranch: remote.ref, revision: remote.sha, branch: 'feature/topic' });
    const next = git(repo, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'other commit'); git(repo, 'update-ref', remote.ref, next);
    const result = await finish(desk, preview); assert.equal(result.status, 'failed'); assert.match(result.log, /远端跟踪分支发生变化/);
    assert.equal(git(repo, 'branch', '--show-current'), 'dev'); assert.equal(git(repo, 'for-each-ref', 'refs/heads/feature/topic'), '');
});

test('Creator adapter blocks worktree changes in Prefab mode even when both dirty queries return false', async t => {
    const { repo } = await fixture(t);
    const previousEditor = globalThis.Editor;
    let prefab = true;
    globalThis.Editor = {
        Project: { path: repo },
        // No debug preview tab: unload would otherwise leave its reopen marker in this extension's real .cache.
        Panel: { has: async name => name !== 'cocos-git-desk.debug-preview', open: async () => true, close: async () => {} },
        Message: { async request(target, method) {
            if (target === 'scene' && method === 'query-dirty') return false;
            if (target === 'scene' && method === 'multi-scene-query') return [{ uuid: 'fixture-scene', name: 'Fixture', dirty: false, type: prefab ? 'prefab' : 'scene' }];
            throw new Error('Unexpected editor call: ' + target + '/' + method);
        } },
    };
    const main = require('../dist/main');
    try {
        await main.methods.open();
        const snapshot = await main.methods.snapshot(true); assert.equal(snapshot.ok, true);
        const request = { action: 'createBranch', repo: '.', version: snapshot.data.repositories[0].version, branch: 'feature/new' };
        const blocked = await main.methods.prepare(request); assert.equal(blocked.ok, false); assert.match(blocked.error, /退出 Prefab/);
        prefab = false;
        const permitted = await main.methods.prepare(request); assert.equal(permitted.ok, true);
        assert.equal(git(repo, 'branch', '--show-current'), 'dev');
    } finally {
        await main.unload();
        if (previousEditor === undefined) delete globalThis.Editor; else globalThis.Editor = previousEditor;
    }
});

const indexBytes = (repo, name) => execFileSync('git', ['show', ':' + name], { cwd: repo });
async function lineSelection(desk, name, area, predicate = () => true) {
    await desk.snapshot(true);
    const diff = await desk.diff({ repo: '.', path: name, area });
    assert.ok(diff.partial, diff.partialReason);
    return { path: name, version: diff.partial.version, ids: diff.partial.hunks.flatMap(h => h.lines.filter(l => l.id && predicate(l)).map(l => l.id)) };
}

test('line staging preserves existing index changes, other hunks, worktree and related meta', async t => {
    const { repo, desk, calls } = await fixture(t);
    const base = Array.from({ length: 30 }, (_, i) => `line-${i}`);
    await fs.writeFile(path.join(repo, 'file.txt'), base.join('\n') + '\n');
    await fs.writeFile(path.join(repo, 'other.txt'), 'original\n');
    await fs.writeFile(path.join(repo, 'file.txt.meta'), 'original meta\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'seed partial edits');
    const staged = [...base]; staged[1] = 'already staged';
    await fs.writeFile(path.join(repo, 'file.txt'), staged.join('\n') + '\n');
    await fs.writeFile(path.join(repo, 'other.txt'), 'staged elsewhere\n'); git(repo, 'add', 'file.txt', 'other.txt');
    const working = [...staged]; working[6] = 'selected change'; working[24] = 'leave in worktree';
    await fs.writeFile(path.join(repo, 'file.txt'), working.join('\n') + '\n');
    await fs.writeFile(path.join(repo, 'other.txt'), 'unrelated worktree\n');
    await fs.writeFile(path.join(repo, 'file.txt.meta'), 'changed meta\n');
    const lines = await lineSelection(desk, 'file.txt', 'worktree', l => ['line-6', 'selected change'].includes(l.text));
    const preview = await plan(desk, 'stageLines', { lines });
    assert.deepEqual(preview.paths, ['file.txt']); assert.match(preview.patch, /\+selected change/); assert.doesNotMatch(preview.patch, /leave in worktree/);
    const result = await finish(desk, preview); assert.equal(result.status, 'success', result.log);
    const expected = [...staged]; expected[6] = 'selected change';
    assert.equal(indexBytes(repo, 'file.txt').toString(), expected.join('\n') + '\n');
    assert.equal(await fs.readFile(path.join(repo, 'file.txt'), 'utf8'), working.join('\n') + '\n');
    assert.equal(indexBytes(repo, 'other.txt').toString(), 'staged elsewhere\n');
    assert.equal(indexBytes(repo, 'file.txt.meta').toString(), 'original meta\n');
    assert.equal(calls.before, 0); assert.equal(calls.after, 0);
});

test('line unstaging keeps unselected staged edits and never rewrites newer working content', async t => {
    const { repo, desk } = await fixture(t);
    const base = Array.from({ length: 30 }, (_, i) => `base-${i}`);
    await fs.writeFile(path.join(repo, 'file.txt'), base.join('\n') + '\n'); git(repo, 'commit', '-am', 'base lines');
    const staged = [...base]; staged[2] = 'first edit'; staged[23] = 'second edit';
    await fs.writeFile(path.join(repo, 'file.txt'), staged.join('\n') + '\n'); git(repo, 'add', 'file.txt');
    const working = [...staged]; working[10] = 'new unsaved-on-index change';
    await fs.writeFile(path.join(repo, 'file.txt'), working.join('\n') + '\n');
    const lines = await lineSelection(desk, 'file.txt', 'index', l => ['base-2', 'first edit'].includes(l.text));
    await perform(desk, 'unstageLines', { lines });
    const expected = [...base]; expected[23] = 'second edit';
    assert.equal(indexBytes(repo, 'file.txt').toString(), expected.join('\n') + '\n');
    assert.equal(await fs.readFile(path.join(repo, 'file.txt'), 'utf8'), working.join('\n') + '\n');
});

test('individual additions and deletions can be selected independently within one replacement hunk', async t => {
    const { repo, desk } = await fixture(t);
    await fs.writeFile(path.join(repo, 'file.txt'), 'start\nold-a\nold-b\nend\n'); git(repo, 'commit', '-am', 'base');
    const working = 'start\nnew-a\nnew-b\nend\n'; await fs.writeFile(path.join(repo, 'file.txt'), working);
    let lines = await lineSelection(desk, 'file.txt', 'worktree', l => l.text === 'new-a');
    await perform(desk, 'stageLines', { lines });
    assert.equal(indexBytes(repo, 'file.txt').toString(), 'start\nold-a\nold-b\nnew-a\nend\n');
    lines = await lineSelection(desk, 'file.txt', 'worktree', l => l.text === 'old-b');
    await perform(desk, 'stageLines', { lines });
    assert.equal(indexBytes(repo, 'file.txt').toString(), 'start\nold-a\nnew-a\nend\n');
    lines = await lineSelection(desk, 'file.txt', 'index', l => l.text === 'new-a');
    await perform(desk, 'unstageLines', { lines });
    assert.equal(indexBytes(repo, 'file.txt').toString(), 'start\nold-a\nend\n');
    assert.equal(await fs.readFile(path.join(repo, 'file.txt'), 'utf8'), working);
});

test('line operations preserve literal paths, CRLF, EOF and whitespace despite Git apply defaults', async t => {
    for (const ending of ['\n', '\r\n', '']) {
        const { repo, desk } = await fixture(t, false);
        git(repo, 'config', 'core.autocrlf', 'false'); git(repo, 'config', 'apply.whitespace', 'fix');
        const name = portableName(':(glob)* 中文\nfile.txt'), before = 'before' + ending, after = 'after  ' + ending;
        await fs.writeFile(path.join(repo, name), before); git(repo, '--literal-pathspecs', 'add', '--', name); git(repo, 'commit', '-m', 'seed');
        await fs.writeFile(path.join(repo, name), after);
        let lines = await lineSelection(desk, name, 'worktree'); await perform(desk, 'stageLines', { lines });
        assert.equal(indexBytes(repo, name).toString(), after);
        lines = await lineSelection(desk, name, 'index'); await perform(desk, 'unstageLines', { lines });
        assert.equal(indexBytes(repo, name).toString(), before);
        assert.equal(await fs.readFile(path.join(repo, name), 'utf8'), after);
    }
});

test('line previews reject changed contents, changed index and invalid selections without writes', async t => {
    const { repo, desk } = await fixture(t);
    await fs.writeFile(path.join(repo, 'file.txt'), 'second\n');
    const old = await lineSelection(desk, 'file.txt', 'worktree');
    await fs.writeFile(path.join(repo, 'file.txt'), 'third\n');
    await assert.rejects(plan(desk, 'stageLines', { lines: old }), /差异已变化/);
    const current = await lineSelection(desk, 'file.txt', 'worktree');
    for (const ids of [[], ['not-a-line'], [current.ids[0], current.ids[0]]]) await assert.rejects(plan(desk, 'stageLines', { lines: { ...current, ids } }), /请选择|失效/);
    const preview = await plan(desk, 'stageLines', { lines: current });
    await fs.writeFile(path.join(repo, 'file.txt'), 'fourth\n');
    const failed = await finish(desk, preview); assert.equal(failed.status, 'failed'); assert.match(failed.log, /发生变化/);
    assert.equal(indexBytes(repo, 'file.txt').toString(), 'first\n');
    const fresh = await lineSelection(desk, 'file.txt', 'worktree'), pending = await plan(desk, 'stageLines', { lines: fresh });
    git(repo, 'add', 'file.txt');
    const changedIndex = await finish(desk, pending); assert.equal(changedIndex.status, 'failed');
    assert.equal(indexBytes(repo, 'file.txt').toString(), 'fourth\n');
});

test('unsupported files report a line-operation reason and cannot submit a forged selection', async t => {
    const { repo, desk } = await fixture(t);
    for (const name of ['binary.bin', 'encoded.txt', 'filtered.txt', 'mode.txt', 'removed.txt', 'rename.txt']) await fs.writeFile(path.join(repo, name), 'before\n');
    await fs.writeFile(path.join(repo, '.gitattributes'), 'filtered.txt filter=identity\n');
    git(repo, 'config', 'filter.identity.clean', 'cat'); git(repo, 'config', 'filter.identity.smudge', 'cat');
    git(repo, 'config', 'core.filemode', 'true'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'seed unsupported');
    await fs.writeFile(path.join(repo, 'binary.bin'), Buffer.from([0, 1, 2]));
    await fs.writeFile(path.join(repo, 'encoded.txt'), Buffer.from([0xff, 0xfe, 65]));
    await fs.writeFile(path.join(repo, 'filtered.txt'), 'after\n');
    await fs.chmod(path.join(repo, 'mode.txt'), 0o755);
    await fs.rm(path.join(repo, 'removed.txt'));
    git(repo, 'mv', 'rename.txt', 'renamed.txt');
    await fs.writeFile(path.join(repo, 'new.txt'), 'new\n');
    // chmod sets no executable bit on Windows, so mode.txt has no change to report there.
    for (const name of ['binary.bin', 'encoded.txt', 'filtered.txt', ...(posixModes ? ['mode.txt'] : []), 'removed.txt', 'new.txt', 'renamed.txt']) {
        await desk.snapshot(true);
        const diff = await desk.diff({ repo: '.', path: name, area: name === 'renamed.txt' ? 'index' : 'worktree' });
        assert.equal(diff.partial, undefined, name); assert.ok(diff.partialReason, name);
        await assert.rejects(plan(desk, name === 'renamed.txt' ? 'unstageLines' : 'stageLines', { lines: { path: name, version: 'forged', ids: ['0:0'] } }));
    }
});

test('commit graph API returns real parents and frozen branch, remote and annotated tag labels', async t => {
    const { repo, desk } = await fixture(t);
    const root = git(repo, 'rev-parse', 'HEAD'), tree = git(repo, 'rev-parse', 'HEAD^{tree}');
    const commit = (name, parents = []) => git(repo, 'commit-tree', tree, ...parents.flatMap(p => ['-p', p]), '-m', name);
    const left = commit('left', [root]), right = commit('right', [root]), merge = commit('merge', [left, right]), island = commit('island');
    git(repo, 'update-ref', 'refs/heads/dev', merge); git(repo, 'update-ref', 'refs/heads/topic', right);
    git(repo, 'update-ref', 'refs/remotes/origin/island', island); git(repo, 'tag', '-a', 'v-test', '-m', 'tag', right);
    const stashOnly = commit('stash-only', [root]); git(repo, 'update-ref', 'refs/stash', stashOnly);
    const all = await desk.historyPage('.', { scope: 'all' });
    assert.deepEqual(new Set(all.commits.map(c => c.sha)), new Set([merge, left, right, root, island]));
    assert.deepEqual(all.commits.find(c => c.sha === merge).parents, [left, right]);
    assert.match(all.commits.find(c => c.sha === merge).refs, /HEAD → dev/);
    assert.match(all.commits.find(c => c.sha === right).refs, /tag: v-test/);
    assert.match(all.commits.find(c => c.sha === island).refs, /origin\/island/);
    for (let i = 0; i < all.commits.length; i++) for (const parent of all.commits[i].parents) assert.ok(all.commits.findIndex(c => c.sha === parent) > i);
    const current = await desk.historyPage('.', { scope: 'current' });
    assert.equal(current.commits.some(c => c.sha === island), false); assert.equal(current.commits.length, 4);
    assert.deepEqual((await desk.history('.'))[0].parents, [left, right]);
});

test('history pagination keeps its original tips when refs move, retries deterministically and rejects wrong scope', async t => {
    const { repo, desk } = await fixture(t);
    const tree = git(repo, 'rev-parse', 'HEAD^{tree}'), original = [git(repo, 'rev-parse', 'HEAD')];
    for (let i = 1; i < 67; i++) original.push(git(repo, 'commit-tree', tree, '-p', original.at(-1), '-m', `history-${i}`));
    git(repo, 'update-ref', 'refs/heads/dev', original.at(-1));
    const first = await desk.historyPage('.', { scope: 'all' }); assert.equal(first.commits.length, 60); assert.ok(first.cursor);
    const newer = git(repo, 'commit-tree', tree, '-p', original.at(-1), '-m', 'after-page-one'); git(repo, 'update-ref', 'refs/heads/dev', newer);
    git(repo, 'tag', 'new-label', original[0]);
    const second = await desk.historyPage('.', { scope: 'all', cursor: first.cursor });
    assert.deepEqual([...first.commits, ...second.commits].map(c => c.sha), [...original].reverse());
    assert.equal(second.cursor, undefined); assert.doesNotMatch(second.commits.at(-1).refs, /new-label/);
    assert.deepEqual(await desk.historyPage('.', { scope: 'all', cursor: first.cursor }), second);
    await assert.rejects(desk.historyPage('.', { scope: 'current', cursor: first.cursor }), /失效/);
    await assert.rejects(desk.historyPage('.', { scope: 'all', cursor: 'missing' }), /失效/);
    assert.equal((await desk.historyPage('.', { scope: 'all' })).commits[0].sha, newer);
});

test('history distinguishes an empty repository, detached HEAD and shallow boundaries', async t => {
    const { base, repo, desk } = await fixture(t, false);
    assert.deepEqual((await desk.historyPage('.', { scope: 'all' })).commits, []);
    await fs.writeFile(path.join(repo, 'file.txt'), 'one'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'one');
    await fs.writeFile(path.join(repo, 'file.txt'), 'two'); git(repo, 'commit', '-am', 'two');
    await fs.writeFile(path.join(repo, 'file.txt'), 'three'); git(repo, 'commit', '-am', 'three');
    const shallowRepo = path.join(base, 'shallow');
    git(base, 'clone', '--depth=2', require('node:url').pathToFileURL(repo).href, shallowRepo);
    const shallowDesk = new GitDesk(shallowRepo, path.join(base, 'shallow-cache'), { async checkEditor() {}, async beforeWorktreeChange() {}, async afterWorktreeChange() {} });
    const page = await shallowDesk.historyPage('.', { scope: 'current' });
    assert.equal(page.shallow, true); assert.equal(page.commits.length, 2); assert.equal(page.commits.at(-1).boundary, true);
    git(repo, 'switch', '--detach', 'HEAD');
    const detached = await desk.historyPage('.', { scope: 'current' }); assert.match(detached.commits[0].refs, /HEAD/); assert.doesNotMatch(detached.commits[0].refs, /HEAD →/);
});


test('stash reports incomplete removal without deleting residual files or the new record', async t => {
    const { repo, desk, calls } = await fixture(t);
    await fs.writeFile(path.join(repo, 'file.txt'), 'saved edit\n');
    const preview = await plan(desk, 'stashPush');
    const original = desk.git.bind(desk);
    let injected = false;
    desk.git = async (cwd, args, options) => {
        const result = await original(cwd, args, options);
        if (!injected && args.includes('stash') && args.includes('push')) {
            injected = true;
            await fs.writeFile(path.join(repo, 'file.txt'), 'concurrent edit\n');
        }
        return result;
    };
    const result = await finish(desk, preview);
    assert.equal(result.status, 'failed'); assert.match(result.log, /仍有需移走/);
    assert.equal(await fs.readFile(path.join(repo, 'file.txt'), 'utf8'), 'concurrent edit\n');
    const stashes = await desk.stashes('.'); assert.equal(stashes.length, 1);
    assert.equal(git(repo, 'show', stashes[0].sha + ':file.txt'), 'saved edit');
    assert.equal(calls.before, calls.after);
});

test('fileAt reads the index and history and resolves LFS pointers from the local object store', async t => {
    const { repo, desk } = await fixture(t);
    await fs.writeFile(path.join(repo, 'file.txt'), 'second\n'); git(repo, 'add', 'file.txt');
    assert.equal(await desk.fileAt('.', 'HEAD:file.txt'), 'first\n'); assert.equal(await desk.fileAt('.', ':file.txt'), 'second\n');
    assert.equal(await desk.fileAt('.', 'HEAD:missing.txt'), null); await assert.rejects(desk.fileAt('.', '-x:file.txt'), /无效的版本或路径/);
    const oid = 'd'.repeat(64), pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 9\n`;
    await fs.writeFile(path.join(repo, 'big.prefab'), pointer); git(repo, 'add', 'big.prefab'); git(repo, 'commit', '-q', '-m', 'pointer');
    await assert.rejects(desk.fileAt('.', 'HEAD:big.prefab'), /LFS 指针，本地没有对象 dddddddddddd/);
    const store = path.join(repo, '.git', 'lfs', 'objects', 'dd', 'dd'); await fs.mkdir(store, { recursive: true }); await fs.writeFile(path.join(store, oid), '[{"a":1}]');
    assert.equal(await desk.fileAt('.', 'HEAD:big.prefab'), '[{"a":1}]');
});
