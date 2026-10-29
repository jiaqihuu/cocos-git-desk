const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GitDesk } = require('../dist/git');

const work = path.resolve(__dirname, '../.test-work');
process.env.GIT_ALLOW_PROTOCOL = 'file';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(work, 'amend-no-global-config');
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
    const base = await fs.mkdtemp(path.join(work, 'amend-'));
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
async function request(desk, repo, fields = {}) {
    const snapshot = await desk.snapshot(true);
    return {
        repo: '.', version: snapshot.repositories[0].version, action: 'amendCommit',
        revision: tip(repo), message: '修订说明\n', ...fields,
    };
}
async function plan(desk, repo, fields) { return desk.prepare(await request(desk, repo, fields)); }
async function finish(desk, preview) {
    desk.execute(preview.token);
    const start = Date.now();
    while (desk.task().status === 'running') {
        if (Date.now() - start > 30000) throw new Error('task test timeout');
        await new Promise(resolve => setTimeout(resolve, 15));
    }
    return desk.task();
}
async function perform(desk, repo, fields) {
    const preview = await plan(desk, repo, fields), result = await finish(desk, preview);
    assert.equal(result.status, 'success', result.log);
    return preview;
}
function noWorktreeHooks(editor) {
    assert.ok(editor.calls.length >= 2, JSON.stringify(editor.calls));
    assert.ok(editor.calls.every(call => call[0] === 'check' && call[1] !== true), JSON.stringify(editor.calls));
}
async function indexBytes(repo) { return fs.readFile(path.resolve(repo, git(repo, 'rev-parse', '--git-path', 'index'))); }
async function hook(hooks, name, body) { const file = path.join(hooks, name); await fs.writeFile(file, '#!/bin/sh\n' + body + '\n'); await fs.chmod(file, 0o755); }

test('amend preview lists all staged paths and the exact old commit without changing repository state', async t => {
    const { repo, desk } = await fixture(t), old = tip(repo);
    await write(repo, 'file.txt', 'staged\n'); await write(repo, 'extra.txt', 'staged addition\n');
    git(repo, 'add', '--', 'file.txt', 'extra.txt'); await write(repo, 'file.txt', 'later unstaged\n');
    git(repo, 'mv', '--', 'file.txt.meta', 'renamed.meta');
    const before = await indexBytes(repo), preview = await plan(desk, repo, { message: '新主题\n\n正文\n' });
    assert.deepEqual([...preview.paths].sort(), ['extra.txt', 'file.txt', 'file.txt.meta', 'renamed.meta']);
    assert.ok(preview.description.includes(old)); assert.ok(preview.description.includes('新主题'));
    assert.ok(preview.warnings.some(value => /远端|发布/.test(value)));
    assert.ok(preview.warnings.some(value => /hook|钩子|签名/i.test(value)));
    assert.equal(tip(repo), old); assert.deepEqual(await indexBytes(repo), before);
    assert.equal(await fs.readFile(path.join(repo, 'file.txt'), 'utf8'), 'later unstaged\n');
});

test('message-only amend preserves tree parents and original author while retaining message whitespace', async t => {
    for (const message of ['中文新主题\n\n# 保留正文\n\t缩进和末尾空格  \n', 'without final newline']) {
        const { repo, desk, editor } = await fixture(t), old = tip(repo), before = commit(repo);
        await perform(desk, repo, { message });
        const after = commit(repo);
        assert.notEqual(tip(repo), old); assert.equal(after.tree, before.tree);
        assert.equal(after.author, before.author); assert.deepEqual(after.parents, before.parents);
        assert.equal(after.message, message); assert.equal(git(repo, 'diff', '--cached', '--name-only'), '');
        noWorktreeHooks(editor);
    }
});

test('amend consumes the entire existing index and preserves unstaged meta and untracked file contents', async t => {
    const { repo, desk, editor } = await fixture(t), old = commit(repo);
    await write(repo, 'file.txt', 'selected staged content\n'); git(repo, 'add', '--', 'file.txt');
    await write(repo, 'file.txt', 'keep later unstaged content\n'); await write(repo, 'file.txt.meta', 'keep dirty meta\n');
    await write(repo, 'added.txt', 'added staged\n'); git(repo, 'add', '--', 'added.txt');
    await write(repo, 'untracked.txt', 'keep untracked\n');
    const intendedTree = git(repo, 'write-tree');
    await perform(desk, repo, { paths: ['file.txt'] });
    assert.equal(commit(repo).tree, intendedTree); assert.deepEqual(commit(repo).parents, old.parents);
    assert.equal(git(repo, 'show', 'HEAD:file.txt'), 'selected staged content');
    assert.equal(git(repo, 'show', 'HEAD:added.txt'), 'added staged');
    assert.equal(await fs.readFile(path.join(repo, 'file.txt'), 'utf8'), 'keep later unstaged content\n');
    assert.equal(await fs.readFile(path.join(repo, 'file.txt.meta'), 'utf8'), 'keep dirty meta\n');
    assert.equal(await fs.readFile(path.join(repo, 'untracked.txt'), 'utf8'), 'keep untracked\n');
    assert.equal(git(repo, 'diff', '--cached', '--name-only'), ''); noWorktreeHooks(editor);
});

test('amending a root or an existing empty commit preserves its parent list tree and author', async t => {
    for (const empty of [false, true]) {
        const { repo, desk } = await fixture(t, { root: true });
        if (empty) git(repo, 'commit', '--allow-empty', '-m', 'existing empty commit');
        const before = commit(repo);
        await perform(desk, repo);
        assert.deepEqual(commit(repo).parents, before.parents); assert.equal(commit(repo).parents.length, empty ? 1 : 0);
        assert.equal(commit(repo).author, before.author); assert.equal(commit(repo).tree, before.tree);
    }
});

test('staged gitlink additions and deletions appear in the preview and require explicit pointer acknowledgement', async t => {
    for (const deleted of [false, true]) {
        const { repo, desk } = await fixture(t), target = child(repo);
        await fs.mkdir(path.join(repo, 'vendor'));
        git(repo, 'update-index', '--add', '--cacheinfo', '160000,' + target + ',vendor');
        if (deleted) { git(repo, 'commit', '-m', 'existing pointer'); git(repo, 'update-index', '--force-remove', '--', 'vendor'); }
        await assert.rejects(plan(desk, repo, { includePointers: false }));
        const preview = await plan(desk, repo, { includePointers: true });
        assert.ok(preview.paths.includes('vendor')); assert.ok(preview.warnings.some(value => /子模块|gitlink|指针/i.test(value)));
        const result = await finish(desk, preview); assert.equal(result.status, 'success', result.log);
        if (deleted) assert.equal(git(repo, 'ls-tree', 'HEAD', '--', 'vendor'), '');
        else assert.match(git(repo, 'ls-tree', 'HEAD', '--', 'vendor'), new RegExp('^160000 commit ' + target));
    }
});

test('amend rejects missing abbreviated stale or symbolic revisions and invalid commit messages', async t => {
    const { repo, desk } = await fixture(t), old = tip(repo), before = entries(repo);
    for (const revision of [undefined, '', 'HEAD', old.slice(0, 8), '0'.repeat(40), child(repo)]) {
        await assert.rejects(plan(desk, repo, { revision }));
    }
    for (const message of [undefined, '', ' \t\n', 'a'.repeat(5001), 'bad\0message', 123]) {
        await assert.rejects(plan(desk, repo, { message }));
    }
    await assert.rejects(plan(desk, repo, { message: commit(repo).message }));
    assert.equal(tip(repo), old); assert.deepEqual(entries(repo), before);
});

test('amend rejects detached HEAD unborn branches and merge commits', async t => {
    for (const mode of ['detached', 'unborn', 'merge']) {
        const { repo, desk } = await fixture(t, { unborn: mode === 'unborn' });
        if (mode === 'detached') git(repo, 'checkout', '--detach', 'HEAD');
        if (mode === 'merge') {
            const other = child(repo, 'HEAD^'), merge = git(repo, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-p', other, '-m', 'merge');
            git(repo, 'update-ref', 'refs/heads/dev', merge);
        }
        const snapshot = await desk.snapshot(true), revision = mode === 'unborn' ? '0'.repeat(40) : tip(repo);
        await assert.rejects(desk.prepare({ repo: '.', version: snapshot.repositories[0].version, action: 'amendCommit', revision, message: 'blocked' }));
        if (mode !== 'unborn') assert.equal(tip(repo), revision);
    }
});

test('unmerged index entries and active merge rebase cherry-pick revert or sequencer state prevent amendment', async t => {
    for (const mode of ['unmerged', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG']) {
        const { repo, desk, gitDir } = await fixture(t), old = tip(repo);
        if (mode === 'unmerged') {
            const blob = git(repo, 'rev-parse', 'HEAD:file.txt');
            gitBytes(repo, ['update-index', '-z', '--index-info'], `0 ${'0'.repeat(40)}\tfile.txt\0` + `100644 ${blob} 2\tfile.txt\0` + `100644 ${blob} 3\tfile.txt\0`);
        } else if (['rebase-merge', 'rebase-apply', 'sequencer'].includes(mode)) await fs.mkdir(path.join(gitDir, mode));
        else await fs.writeFile(path.join(gitDir, mode), old + '\n');
        const before = entries(repo); await assert.rejects(plan(desk, repo));
        assert.equal(tip(repo), old); assert.deepEqual(entries(repo), before);
    }
});

test('shallow history and grafts cannot bypass the history rewrite checks', async t => {
    for (const mode of ['shallow', 'grafts']) {
        const { repo, desk, gitDir } = await fixture(t), old = tip(repo);
        const file = mode === 'shallow' ? 'shallow' : 'info/grafts';
        await write(gitDir, file, old + '\n');
        await assert.rejects(plan(desk, repo)); assert.equal(tip(repo), old);
    }
});

test('any cached remote ref containing HEAD blocks amendment including a descendant without a configured remote', async t => {
    for (const descendant of [false, true]) {
        const { repo, desk } = await fixture(t), old = tip(repo);
        git(repo, 'update-ref', 'refs/remotes/offline/shared', descendant ? child(repo) : old);
        await assert.rejects(plan(desk, repo)); assert.equal(tip(repo), old);
    }
});

test('changed HEAD branch or staged entries invalidate an amend preview without consuming new work', async t => {
    for (const mode of ['head', 'branch', 'index']) {
        const { repo, desk } = await fixture(t), preview = await plan(desk, repo);
        if (mode === 'head') git(repo, 'update-ref', 'refs/heads/dev', child(repo));
        if (mode === 'branch') git(repo, 'branch', '-m', 'renamed');
        if (mode === 'index') { await write(repo, 'file.txt', 'new staged content\n'); git(repo, 'add', '--', 'file.txt'); }
        const old = tip(repo), before = entries(repo), branch = git(repo, 'symbolic-ref', 'HEAD');
        const result = await finish(desk, preview); assert.equal(result.status, 'failed', result.log);
        assert.equal(tip(repo), old); assert.deepEqual(entries(repo), before); assert.equal(git(repo, 'symbolic-ref', 'HEAD'), branch);
    }
});

test('configuration included configuration cached refs and operation metadata are frozen by the preview', async t => {
    for (const mode of ['config', 'included-config', 'remote', 'operation']) {
        const { repo, base, desk, gitDir } = await fixture(t), include = path.join(base, 'included.gitconfig');
        if (mode === 'included-config') { await fs.writeFile(include, '[commit]\n\tverbose = false\n'); git(repo, 'config', 'include.path', include); }
        const old = tip(repo), preview = await plan(desk, repo);
        if (mode === 'config') git(repo, 'config', 'commit.verbose', 'true');
        if (mode === 'included-config') await fs.writeFile(include, '[commit]\n\tverbose = true\n');
        if (mode === 'remote') git(repo, 'update-ref', 'refs/remotes/offline/ancestor', git(repo, 'rev-parse', 'HEAD^'));
        if (mode === 'operation') await fs.writeFile(path.join(gitDir, 'ORIG_HEAD'), old + '\n');
        const before = entries(repo), result = await finish(desk, preview);
        assert.equal(result.status, 'failed', result.log); assert.equal(tip(repo), old); assert.deepEqual(entries(repo), before);
    }
});

test('unsaved editor content blocks both preview and execution with no worktree hooks', async t => {
    const { repo, desk, editor } = await fixture(t), old = tip(repo), before = entries(repo);
    editor.dirty = true; await assert.rejects(plan(desk, repo), /unsaved scene/);
    editor.dirty = false; const preview = await plan(desk, repo); editor.dirty = true;
    const result = await finish(desk, preview); assert.equal(result.status, 'failed', result.log);
    assert.equal(tip(repo), old); assert.deepEqual(entries(repo), before); noWorktreeHooks(editor);
});

test('changes while the editor check is pending are rechecked before the commit command', async t => {
    for (const mode of ['index', 'remote', 'config']) {
        const { repo, desk, editor } = await fixture(t), old = tip(repo), preview = await plan(desk, repo);
        editor.onCheck = async () => {
            editor.onCheck = undefined;
            if (mode === 'index') { await write(repo, 'new.txt', 'staged during editor check\n'); git(repo, 'add', '--', 'new.txt'); }
            if (mode === 'remote') git(repo, 'update-ref', 'refs/remotes/offline/shared', old);
            if (mode === 'config') git(repo, 'config', 'commit.verbose', 'true');
        };
        const result = await finish(desk, preview); assert.equal(result.status, 'failed', result.log);
        assert.equal(tip(repo), old); noWorktreeHooks(editor);
        if (mode === 'index') assert.equal(git(repo, 'show', ':new.txt'), 'staged during editor check');
    }
});

test('pre-commit rejection is not bypassed and a failed operation token cannot be retried', async t => {
    const { repo, desk, hooks } = await fixture(t), old = tip(repo);
    await hook(hooks, 'pre-commit', 'echo "hook refused amendment" >&2\nexit 1');
    const preview = await plan(desk, repo), before = entries(repo), result = await finish(desk, preview);
    assert.equal(result.status, 'failed', result.log); assert.match(result.log, /hook refused amendment/);
    assert.equal(tip(repo), old); assert.deepEqual(entries(repo), before);
    assert.throws(() => desk.execute(preview.token));
});

test('commit-msg hooks remain enabled and a changed committed message is reported without rollback', async t => {
    const { repo, desk, hooks } = await fixture(t), old = tip(repo), before = commit(repo);
    await hook(hooks, 'commit-msg', 'printf "changed by hook\\n" > "$1"');
    const result = await finish(desk, await plan(desk, repo));
    assert.equal(result.status, 'failed', result.log); assert.notEqual(tip(repo), old);
    assert.equal(commit(repo).message, 'changed by hook\n'); assert.equal(commit(repo).tree, before.tree);
    assert.match(result.log, /提交|commit/i); assert.match(result.log, /重试|刷新|核对/);
});

test('a hook that changes the staged tree is detected after commit and its changes are not reset', async t => {
    const { repo, desk, hooks } = await fixture(t), old = tip(repo);
    await write(repo, 'hook.txt', 'hook stages this existing untracked file\n');
    await hook(hooks, 'pre-commit', 'git add -- hook.txt');
    const result = await finish(desk, await plan(desk, repo));
    assert.equal(result.status, 'failed', result.log); assert.notEqual(tip(repo), old);
    assert.equal(git(repo, 'show', 'HEAD:hook.txt'), 'hook stages this existing untracked file');
    assert.equal(await fs.readFile(path.join(repo, 'hook.txt'), 'utf8'), 'hook stages this existing untracked file\n');
    assert.match(result.log, /重试|刷新|核对/);
});

test('the reviewed message is retained after caller mutation and a successful preview token is single use', async t => {
    const { repo, desk } = await fixture(t), args = await request(desk, repo, { message: 'reviewed message\n' });
    const preview = await desk.prepare(args);
    args.message = 'unreviewed replacement\n'; args.revision = '0'.repeat(40); args.paths = ['unexpected.txt'];
    const result = await finish(desk, preview); assert.equal(result.status, 'success', result.log);
    assert.equal(commit(repo).message, 'reviewed message\n'); assert.throws(() => desk.execute(preview.token));
});

test('rename previews include both paths and amendment preserves later edits at the old and new names', async t => {
    const { repo, desk } = await fixture(t), renamed = 'renamed [x].txt', original = gitBytes(repo, ['show', 'HEAD:file.txt']);
    git(repo, 'mv', '--', 'file.txt', renamed);
    await write(repo, renamed, 'later edits at new name\n'); await write(repo, 'file.txt', 'new untracked file at old name\n');
    const preview = await plan(desk, repo);
    assert.deepEqual([...preview.paths].sort(), ['file.txt', renamed]);
    const result = await finish(desk, preview); assert.equal(result.status, 'success', result.log);
    assert.equal(git(repo, 'ls-tree', 'HEAD', '--', 'file.txt'), '');
    assert.deepEqual(gitBytes(repo, ['show', 'HEAD:' + renamed]), original);
    assert.equal(await fs.readFile(path.join(repo, renamed), 'utf8'), 'later edits at new name\n');
    assert.equal(await fs.readFile(path.join(repo, 'file.txt'), 'utf8'), 'new untracked file at old name\n');
});

test('non-UTF8 commit configuration or original commit encoding is rejected before writing', async t => {
    for (const mode of ['config', 'original-encoding']) {
        const { repo, desk } = await fixture(t);
        if (mode === 'config') git(repo, 'config', 'i18n.commitEncoding', 'ISO-8859-1');
        else {
            const raw = gitBytes(repo, ['cat-file', 'commit', 'HEAD']), split = raw.indexOf(Buffer.from('\n\n'));
            const encoded = Buffer.concat([raw.subarray(0, split), Buffer.from('\nencoding ISO-8859-1\n\n'), Buffer.from('caf\xe9\n', 'latin1')]);
            const object = gitBytes(repo, ['hash-object', '-t', 'commit', '-w', '--stdin'], encoded).toString('utf8').trim();
            git(repo, 'update-ref', 'refs/heads/dev', object);
        }
        const old = tip(repo), before = await indexBytes(repo), disk = await fs.readFile(path.join(repo, 'file.txt'));
        await assert.rejects(plan(desk, repo));
        assert.equal(tip(repo), old); assert.deepEqual(await indexBytes(repo), before);
        assert.deepEqual(await fs.readFile(path.join(repo, 'file.txt')), disk);
    }
});
