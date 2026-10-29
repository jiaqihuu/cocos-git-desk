const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GitDesk } = require('../dist/git');

const work = path.resolve(__dirname, '../.test-work');
process.env.GIT_ALLOW_PROTOCOL = 'file';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(work, 'merge-no-global-config');
function gitBytes(cwd, args, input) {
    return execFileSync('git', ['--literal-pathspecs', ...args], {
        cwd, input, timeout: 30000, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
}
const git = (cwd, ...args) => gitBytes(cwd, args).toString('utf8').trimEnd();
const tip = repo => git(repo, 'rev-parse', 'HEAD');
const entries = repo => gitBytes(repo, ['ls-files', '--stage', '-z']);
async function write(repo, name, content) {
    await fs.mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await fs.writeFile(path.join(repo, name), content);
}
function commit(repo, revision = 'HEAD') {
    const raw = gitBytes(repo, ['--no-replace-objects', 'cat-file', 'commit', revision]).toString('utf8');
    const split = raw.indexOf('\n\n'), headers = raw.slice(0, split).split('\n');
    return {
        tree: headers.find(line => line.startsWith('tree ')).slice(5),
        author: headers.find(line => line.startsWith('author ')).slice(7),
        parents: headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7)),
        message: raw.slice(split + 2),
    };
}
function child(repo, parent = 'HEAD') { return git(repo, 'commit-tree', 'HEAD^{tree}', '-p', parent, '-m', 'external commit'); }
async function fixture(t, options = {}) {
    await fs.mkdir(work, { recursive: true });
    const base = await fs.mkdtemp(path.join(work, 'merge-'));
    t.after(async () => { await fs.rm(base, { recursive: true, force: true }); });
    const repo = path.join(base, 'project'); await fs.mkdir(repo);
    git(repo, 'init', '-b', 'dev');
    git(repo, 'config', 'user.name', 'Original Author'); git(repo, 'config', 'user.email', 'original@example.invalid');
    git(repo, 'config', 'commit.gpgSign', 'false'); git(repo, 'config', 'core.autocrlf', 'false');
    const hooks = path.join(base, 'hooks'); await fs.mkdir(hooks);
    git(repo, 'config', 'core.hooksPath', hooks);
    if (!options.unborn) {
        await write(repo, 'file.txt', 'initial\n'); await write(repo, 'file.txt.meta', 'meta\n');
        git(repo, 'add', '--', 'file.txt', 'file.txt.meta'); git(repo, 'commit', '-m', 'initial');
        if (!options.root) {
            await write(repo, 'file.txt', 'current commit\n'); git(repo, 'add', '--', 'file.txt');
            git(repo, 'commit', '-m', 'original subject\n\noriginal body');
        }
    }
    git(repo, 'config', 'user.name', 'Current Committer'); git(repo, 'config', 'user.email', 'current@example.invalid');
    const editor = { dirty: false, onCheck: undefined, calls: [] };
    const desk = new GitDesk(repo, path.join(base, 'cache'), {
        async checkEditor(worktreeChange) {
            editor.calls.push(['check', worktreeChange]);
            if (editor.onCheck) await editor.onCheck();
            if (editor.dirty) throw new Error('unsaved scene');
        },
        async beforeWorktreeChange() { editor.calls.push(['before']); },
        async afterWorktreeChange() { editor.calls.push(['after']); },
    });
    return { repo, base, desk, editor, hooks, gitDir: git(repo, 'rev-parse', '--absolute-git-dir') };
}
async function startMerge(f, conflict = false) {
    const base = tip(f.repo); git(f.repo, 'switch', '-c', 'topic');
    await write(f.repo, conflict ? 'file.txt' : 'topic.txt', 'topic\n'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'topic');
    const source = tip(f.repo); git(f.repo, 'switch', 'dev');
    await write(f.repo, conflict ? 'file.txt' : 'dev.txt', 'dev\n'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'dev');
    const head = tip(f.repo);
    if (conflict) assert.throws(() => git(f.repo, 'merge', '--no-commit', 'topic'));
    else git(f.repo, 'merge', '--no-ff', '--no-commit', 'topic');
    return { base, head, source };
}
async function preview(f, fields = {}) {
    const state = await f.desk.mergeState('.');
    return f.desk.prepare({ repo: '.', version: state.repoVersion, action: 'finishMerge', mergeVersion: state.version, message: '完成合并\n', ...fields });
}
async function finish(f, p) {
    f.desk.execute(p.token); const started = Date.now();
    while (f.desk.task().status === 'running') { if (Date.now() - started > 30000) throw new Error('merge task timeout'); await new Promise(resolve => setTimeout(resolve, 15)); }
    return f.desk.task();
}

test('merge state is a structured read and inactive repositories cannot be finalized', async t => {
    const f = await fixture(t), state = await f.desk.mergeState('.');
    assert.equal(state.active, false); assert.equal(state.canFinish, false); assert.equal(tip(f.repo), state.head);
    await assert.rejects(preview(f), /不能|没有|合并/); assert.equal(f.desk.task(), null);
});

test('finish merge commits the entire index with exact two parents and preserves ordinary worktree edits', async t => {
    const f = await fixture(t), context = await startMerge(f), message = '完成当前合并\n\n# 保留注释\n  保留空格  \n';
    await write(f.repo, 'extra.txt', 'staged extra'); git(f.repo, 'add', 'extra.txt');
    await write(f.repo, 'file.txt', 'unstaged local\n');
    const state = await f.desk.mergeState('.'); assert.equal(state.canFinish, true); assert.equal(state.mergeHead, context.source);
    const p = await preview(f, { message }); assert.ok(p.paths.includes('extra.txt')); assert.ok(p.paths.includes('topic.txt'));
    const result = await finish(f, p); assert.equal(result.status, 'success', result.log);
    const actual = commit(f.repo); assert.deepEqual(actual.parents, [context.head, context.source]); assert.equal(actual.message, message);
    assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'unstaged local\n');
    await assert.rejects(fs.stat(path.join(f.gitDir, 'MERGE_HEAD')), { code: 'ENOENT' });
    assert.equal(f.editor.calls.some(call => call[0] === 'before' || call[0] === 'after'), false);
    assert.ok(f.editor.calls.some(call => call[0] === 'check' && call[1] === true));
});

test('unresolved conflicts block finish; resolving and staging enables an explicit new read', async t => {
    const f = await fixture(t); await startMerge(f, true);
    assert.equal((await f.desk.mergeState('.')).canFinish, false); await assert.rejects(preview(f), /冲突/);
    await write(f.repo, 'file.txt', 'resolved\n'); git(f.repo, 'add', 'file.txt');
    const state = await f.desk.mergeState('.'); assert.equal(state.canFinish, true); assert.equal(state.conflicts, 0);
    assert.equal((await finish(f, await preview(f))).status, 'success');
});

test('invalid message, scoped paths and unapproved pointers cannot enter a merge commit', async t => {
    const f = await fixture(t); await startMerge(f);
    for (const message of ['', '  ', 'a\0b', 'a'.repeat(5001)]) await assert.rejects(preview(f, { message }));
    await assert.rejects(preview(f, { paths: [] }), /整个索引/);
    git(f.repo, 'update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},child`);
    const state = await f.desk.mergeState('.'); assert.equal(state.pointers, true);
    await assert.rejects(preview(f), /子模块/); const p = await preview(f, { includePointers: true }); assert.ok(p.paths.includes('child'));
});

test('autostash, sequencer and octopus metadata explicitly refuse without cleanup', async t => {
    const f = await fixture(t), context = await startMerge(f);
    for (const name of ['MERGE_AUTOSTASH', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'BISECT_LOG', 'SQUASH_MSG']) {
        await fs.writeFile(path.join(f.gitDir, name), context.source + '\n');
        assert.equal((await f.desk.mergeState('.')).canFinish, false); await assert.rejects(preview(f));
        assert.equal(await fs.readFile(path.join(f.gitDir, name), 'utf8'), context.source + '\n'); await fs.rm(path.join(f.gitDir, name));
    }
    await fs.mkdir(path.join(f.gitDir, 'sequencer')); assert.equal((await f.desk.mergeState('.')).canFinish, false); await fs.rmdir(path.join(f.gitDir, 'sequencer'));
    await fs.writeFile(path.join(f.gitDir, 'MERGE_HEAD'), context.source + '\n' + context.head + '\n');
    assert.equal((await f.desk.mergeState('.')).canFinish, false); assert.equal(tip(f.repo), context.head);
});

test('merge mode and state file validation rejects malformed or linked state', async t => {
    const f = await fixture(t); await startMerge(f);
    await fs.writeFile(path.join(f.gitDir, 'MERGE_MODE'), 'no-ff\n'); assert.equal((await f.desk.mergeState('.')).canFinish, false);
    await fs.writeFile(path.join(f.gitDir, 'MERGE_MODE'), 'no-ff');
    const msg = path.join(f.gitDir, 'MERGE_MSG'), backup = path.join(f.base, 'message'); await fs.rename(msg, backup); await fs.symlink(backup, msg);
    await assert.rejects(f.desk.mergeState('.'), /类型异常/);
});

test('long default messages are omitted explicitly while a newly supplied valid message remains possible', async t => {
    const f = await fixture(t); await startMerge(f); await fs.writeFile(path.join(f.gitDir, 'MERGE_MSG'), 'x'.repeat(5001));
    const state = await f.desk.mergeState('.'); assert.equal(state.canFinish, true); assert.equal(state.message, ''); assert.match(state.messageNotice, /未载入/);
    assert.equal((await finish(f, await preview(f, { message: '替代长模板\n' }))).status, 'success');
});

test('merge template changes invalidate mergeVersion even when repo status version is unchanged', async t => {
    const f = await fixture(t); await startMerge(f); const p = await preview(f), version = (await f.desk.snapshot(true)).repositories[0].version;
    await fs.appendFile(path.join(f.gitDir, 'MERGE_MSG'), '\nexternal edit');
    assert.equal((await f.desk.snapshot(true)).repositories[0].version, version);
    const result = await finish(f, p); assert.equal(result.status, 'failed'); assert.match(result.log, /变化/);
    assert.ok(await fs.stat(path.join(f.gitDir, 'MERGE_HEAD')));
});

test('index/content changes and editor checks after preview block stale completion', async t => {
    const f = await fixture(t), context = await startMerge(f); const p = await preview(f);
    let changed = false; f.editor.onCheck = async () => { if (!changed) { changed = true; await write(f.repo, 'extra.txt', 'late'); git(f.repo, 'add', 'extra.txt'); } };
    const result = await finish(f, p); assert.equal(result.status, 'failed'); assert.equal(tip(f.repo), context.head);
    assert.ok(await fs.stat(path.join(f.gitDir, 'MERGE_HEAD'))); assert.equal(git(f.repo, 'show', ':extra.txt'), 'late');
});

test('unsaved editor state and hook rejection retain the merge for later inspection', async t => {
    const f = await fixture(t), context = await startMerge(f);
    f.editor.dirty = true; await assert.rejects(preview(f), /unsaved/); f.editor.dirty = false;
    await fs.writeFile(path.join(f.hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const result = await finish(f, await preview(f)); assert.equal(result.status, 'failed'); assert.equal(tip(f.repo), context.head); assert.ok(await fs.stat(path.join(f.gitDir, 'MERGE_HEAD')));
});

test('a modifying commit hook yields failed task but preserves any commit already created', async t => {
    const f = await fixture(t), context = await startMerge(f);
    await fs.writeFile(path.join(f.hooks, 'commit-msg'), '#!/bin/sh\nprintf "\\nhook changed\\n" >> "$1"\n', { mode: 0o755 });
    const result = await finish(f, await preview(f)); assert.equal(result.status, 'failed'); assert.notEqual(tip(f.repo), context.head);
    assert.match(commit(f.repo).message, /hook changed/); assert.match(result.log, /不会自动重试/);
});

test('empty-tree no-ff merge still produces a two-parent commit and stale plans are single-use', async t => {
    const f = await fixture(t), head = tip(f.repo), source = git(f.repo, 'rev-parse', 'HEAD^');
    await fs.writeFile(path.join(f.gitDir, 'MERGE_HEAD'), source + '\n'); await fs.writeFile(path.join(f.gitDir, 'MERGE_MODE'), ''); await fs.writeFile(path.join(f.gitDir, 'MERGE_MSG'), 'empty merge\n');
    assert.equal((await f.desk.mergeState('.')).canFinish, false);
    await fs.writeFile(path.join(f.gitDir, 'MERGE_MODE'), 'no-ff');
    const p = await preview(f); assert.deepEqual(p.paths, []); const result = await finish(f, p); assert.equal(result.status, 'success', result.log);
    assert.deepEqual(commit(f.repo).parents, [head, source]); assert.throws(() => f.desk.execute(p.token), /过期|不存在/);
});
