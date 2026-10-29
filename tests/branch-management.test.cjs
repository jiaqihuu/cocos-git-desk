const { test } = require('node:test');
const { windows, portableName, exoticNames, posixModes, linkTarget } = require('./platform.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GitDesk } = require('../dist/git');

const work = path.resolve(__dirname, '../.test-work');
process.env.GIT_ALLOW_PROTOCOL = 'file';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(work, 'branch-management-no-global-config');
const git = (cwd, ...args) => execFileSync('git', ['--literal-pathspecs', ...args], {
    cwd, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
}).trimEnd();

async function fixture(t, seed = true) {
    await fs.mkdir(work, { recursive: true });
    const base = await fs.mkdtemp(path.join(work, 'branch-management-'));
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

test('branch details keep names distinct from tags and expose complete SHAs and literal worktree paths', async t => {
    const { repo, base, desk } = await fixture(t);
    git(repo, 'branch', 'topic'); git(repo, 'branch', 'idle');
    const linked = path.join(base, portableName('linked 中文\n\tworktree'));
    git(repo, 'worktree', 'add', linked, 'topic');
    git(repo, 'tag', 'topic');
    const { branches } = await desk.details('.');
    assert.equal(branches.find(b => b.name === 'dev').sha, git(repo, 'rev-parse', 'HEAD'));
    assert.equal(branches.find(b => b.name === 'dev').current, true);
    assert.equal(branches.find(b => b.name === 'dev').worktree, await fs.realpath(repo));
    assert.equal(branches.find(b => b.name === 'topic').worktree, await fs.realpath(linked));
    assert.equal(branches.find(b => b.name === 'idle').worktree, undefined);
});

test('renaming an idle branch preserves its upstream and reflog while leaving dirty files, index and current branch untouched', async t => {
    const { repo, base, desk, calls } = await fixture(t);
    git(repo, 'branch', 'topic'); const revision = ref(repo, 'topic');
    upstream(repo, base, 'topic', revision);
    const reflog = git(repo, 'reflog', 'show', '--format=%H %gs', 'topic');
    await dirtyFiles(repo); calls.dirtyEditor = true;
    const before = await state(repo);
    await perform(desk, 'renameBranch', { branch: 'topic', newBranch: 'feature/中文', revision });
    assert.equal(ref(repo, 'topic'), ''); assert.equal(ref(repo, 'feature/中文'), revision);
    assert.equal(git(repo, 'config', 'branch.feature/中文.remote'), 'origin');
    assert.equal(git(repo, 'config', 'branch.feature/中文.merge'), 'refs/heads/topic');
    assert.ok(git(repo, 'reflog', 'show', '--format=%H %gs', 'feature/中文').includes(reflog));
    assert.deepEqual(await state(repo), before); noHostChanges(calls);
});

test('safe deletion removes only an idle branch merged into both current HEAD and its configured upstream', async t => {
    const { repo, base, desk, calls } = await fixture(t);
    git(repo, 'branch', 'topic'); const revision = ref(repo, 'topic');
    git(repo, 'commit', '--allow-empty', '-m', 'current branch advanced');
    upstream(repo, base, 'topic', git(repo, 'rev-parse', 'HEAD'));
    await dirtyFiles(repo); calls.dirtyEditor = true;
    const before = await state(repo);
    await perform(desk, 'deleteBranch', { branch: 'topic', revision });
    assert.equal(ref(repo, 'topic'), ''); assert.deepEqual(await state(repo), before); noHostChanges(calls);
});

test('rename and delete reject the current branch and branches occupied by other worktrees', async t => {
    const { repo, base, desk, calls } = await fixture(t);
    git(repo, 'branch', 'topic'); git(repo, 'worktree', 'add', path.join(base, 'linked'), 'topic');
    const refs = git(repo, 'show-ref');
    for (const branch of ['dev', 'topic']) for (const action of ['renameBranch', 'deleteBranch']) {
        await assert.rejects(plan(desk, action, { branch, newBranch: 'renamed', revision: ref(repo, branch) }));
    }
    assert.equal(git(repo, 'show-ref'), refs); noHostChanges(calls);
});

test('deletion cannot be forced when the source is merged upstream but not into current HEAD', async t => {
    const { repo, base, desk } = await fixture(t);
    const revision = nextCommit(repo); git(repo, 'branch', 'topic', revision);
    upstream(repo, base, 'topic', revision);
    await assert.rejects(plan(desk, 'deleteBranch', { branch: 'topic', revision, force: true }));
    assert.equal(ref(repo, 'topic'), revision);
});

test('deletion refuses a configured upstream that is behind or missing even when current HEAD contains the source', async t => {
    const { repo, base, desk } = await fixture(t), old = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'commit', '--allow-empty', '-m', 'advanced'); git(repo, 'branch', 'topic');
    const revision = ref(repo, 'topic'); upstream(repo, base, 'topic', old);
    await assert.rejects(plan(desk, 'deleteBranch', { branch: 'topic', revision }));
    git(repo, 'update-ref', '-d', 'refs/remotes/origin/topic');
    await assert.rejects(plan(desk, 'deleteBranch', { branch: 'topic', revision }));
    assert.equal(ref(repo, 'topic'), revision);
});

test('deletion requires a named current branch even when a detached HEAD contains the source', async t => {
    const { repo, desk } = await fixture(t);
    git(repo, 'branch', 'topic'); const revision = ref(repo, 'topic'); git(repo, 'switch', '--detach');
    await assert.rejects(plan(desk, 'deleteBranch', { branch: 'topic', revision }));
    assert.equal(ref(repo, 'topic'), revision); assert.equal(git(repo, 'branch', '--show-current'), '');
});

test('branch metadata operations reject stale SHA, missing sources, invalid names and destination namespace collisions', async t => {
    const { repo, desk } = await fixture(t);
    git(repo, 'branch', 'topic'); git(repo, 'branch', 'occupied');
    const revision = ref(repo, 'topic'), refs = git(repo, 'show-ref');
    for (const action of ['renameBranch', 'deleteBranch']) {
        for (const supplied of [undefined, 'HEAD', revision.slice(0, 8), '0'.repeat(40), nextCommit(repo)]) {
            await assert.rejects(plan(desk, action, { branch: 'topic', newBranch: 'renamed', revision: supplied }));
        }
        await assert.rejects(plan(desk, action, { branch: 'missing', newBranch: 'renamed', revision }));
    }
    for (const newBranch of ['', '-D', 'bad name', 'a..b', 'topic', 'occupied', 'occupied/child', 'bad\0name']) {
        await assert.rejects(plan(desk, 'renameBranch', { branch: 'topic', newBranch, revision }));
    }
    assert.equal(git(repo, 'show-ref'), refs);
});

test('creating from a historical SHA switches to exactly that commit without inheriting automatic upstream tracking', async t => {
    const { repo, base, desk, calls } = await fixture(t), revision = git(repo, 'rev-parse', 'HEAD');
    await fs.writeFile(path.join(repo, 'file.txt'), 'latest\n'); git(repo, 'add', 'file.txt'); git(repo, 'commit', '-m', 'latest');
    upstream(repo, base, 'dev', git(repo, 'rev-parse', 'HEAD'));
    git(repo, 'config', 'branch.autoSetupMerge', 'always');
    const remoteRefs = git(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/');
    await perform(desk, 'createBranch', { branch: 'feature/from-history', revision });
    assert.equal(git(repo, 'branch', '--show-current'), 'feature/from-history');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), revision);
    assert.equal(await fs.readFile(path.join(repo, 'file.txt'), 'utf8'), 'first\n');
    assert.equal(git(repo, 'for-each-ref', '--format=%(upstream)', 'refs/heads/feature/from-history'), '');
    assert.equal(git(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/'), remoteRefs);
    assert.ok(calls.check >= 2); assert.equal(calls.before, 1); assert.equal(calls.after, 1);
});

test('creating without an explicit revision retains HEAD as the start and does not set an automatic upstream', async t => {
    const { repo, desk } = await fixture(t), revision = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'config', 'branch.autoSetupMerge', 'always');
    await perform(desk, 'createBranch', { branch: 'feature/current' });
    assert.equal(git(repo, 'branch', '--show-current'), 'feature/current'); assert.equal(ref(repo, 'feature/current'), revision);
    assert.equal(git(repo, 'for-each-ref', '--format=%(upstream)', 'refs/heads/feature/current'), '');
});

test('history branch creation rejects revision expressions, abbreviated SHAs and non-commit objects', async t => {
    const { repo, desk } = await fixture(t), revision = git(repo, 'rev-parse', 'HEAD');
    for (const supplied of ['HEAD', 'HEAD~1', revision.slice(0, 8), '--orphan', '0'.repeat(40), git(repo, 'rev-parse', 'HEAD^{tree}'), git(repo, 'rev-parse', 'HEAD:file.txt')]) {
        await assert.rejects(plan(desk, 'createBranch', { branch: 'feature/rejected', revision: supplied }));
    }
    assert.equal(ref(repo, 'feature/rejected'), ''); assert.equal(git(repo, 'branch', '--show-current'), 'dev');
});

test('history branch creation stops for dirty worktrees and unsaved editor state', async t => {
    const { repo, desk, calls } = await fixture(t), revision = git(repo, 'rev-parse', 'HEAD');
    await fs.writeFile(path.join(repo, 'file.txt'), 'dirty\n');
    await assert.rejects(plan(desk, 'createBranch', { branch: 'feature/rejected', revision }));
    assert.equal(await fs.readFile(path.join(repo, 'file.txt'), 'utf8'), 'dirty\n');
    await fs.writeFile(path.join(repo, 'file.txt'), 'first\n'); calls.dirtyEditor = true;
    await assert.rejects(plan(desk, 'createBranch', { branch: 'feature/rejected', revision }), /unsaved scene/);
    assert.equal(ref(repo, 'feature/rejected'), ''); assert.equal(calls.before, 0); assert.equal(calls.after, 0);
});

test('moving the source after a rename or delete preview invalidates the plan and retains the new source tip', async t => {
    for (const action of ['renameBranch', 'deleteBranch']) {
        const { repo, desk, calls } = await fixture(t);
        git(repo, 'branch', 'topic'); const revision = ref(repo, 'topic');
        const preview = await plan(desk, action, { branch: 'topic', newBranch: 'renamed', revision });
        const newer = nextCommit(repo); git(repo, 'update-ref', 'refs/heads/topic', newer);
        const before = await state(repo), result = await finish(desk, preview);
        assert.equal(result.status, 'failed'); assert.equal(ref(repo, 'topic'), newer); assert.equal(ref(repo, 'renamed'), '');
        assert.deepEqual(await state(repo), before); noHostChanges(calls);
    }
});

test('creating a destination after preview cannot make rename or create overwrite an existing branch', async t => {
    for (const action of ['renameBranch', 'createBranch']) {
        const { repo, desk } = await fixture(t);
        git(repo, 'branch', 'topic'); const revision = ref(repo, 'topic');
        const args = action === 'renameBranch' ? { branch: 'topic', newBranch: 'destination', revision } : { branch: 'destination', revision };
        const preview = await plan(desk, action, args), other = nextCommit(repo);
        git(repo, 'branch', 'destination', other);
        const before = await state(repo), result = await finish(desk, preview);
        assert.equal(result.status, 'failed'); assert.equal(ref(repo, 'destination'), other); assert.equal(ref(repo, 'topic'), revision);
        assert.deepEqual(await state(repo), before);
    }
});

test('new worktree occupancy after preview prevents metadata operations without disturbing either worktree', async t => {
    for (const action of ['renameBranch', 'deleteBranch']) {
        const { repo, base, desk, calls } = await fixture(t);
        git(repo, 'branch', 'topic'); const revision = ref(repo, 'topic');
        const preview = await plan(desk, action, { branch: 'topic', newBranch: 'renamed', revision });
        const linked = path.join(base, 'late-worktree'); git(repo, 'worktree', 'add', linked, 'topic');
        const before = await state(repo), linkedBefore = await state(linked), result = await finish(desk, preview);
        assert.equal(result.status, 'failed'); assert.equal(ref(repo, 'topic'), revision); assert.equal(ref(repo, 'renamed'), '');
        assert.deepEqual(await state(repo), before); assert.deepEqual(await state(linked), linkedBefore); noHostChanges(calls);
    }
});

test('upstream movement, removal or configuration changes after preview invalidate branch metadata plans', async t => {
    for (const action of ['renameBranch', 'deleteBranch']) for (const change of ['move', 'remove', 'config']) {
        const { repo, base, desk } = await fixture(t);
        git(repo, 'branch', 'topic'); const revision = ref(repo, 'topic'); upstream(repo, base, 'topic', revision);
        git(repo, 'update-ref', 'refs/remotes/origin/other', revision);
        const preview = await plan(desk, action, { branch: 'topic', newBranch: 'renamed', revision });
        if (change === 'move') git(repo, 'update-ref', 'refs/remotes/origin/topic', nextCommit(repo));
        else if (change === 'remove') git(repo, 'update-ref', '-d', 'refs/remotes/origin/topic');
        else git(repo, 'config', 'branch.topic.merge', 'refs/heads/other');
        const before = await state(repo), result = await finish(desk, preview);
        assert.equal(result.status, 'failed'); assert.equal(ref(repo, 'topic'), revision); assert.equal(ref(repo, 'renamed'), '');
        assert.deepEqual(await state(repo), before);
        assert.equal(git(repo, 'config', 'branch.topic.merge'), change === 'config' ? 'refs/heads/other' : 'refs/heads/topic');
    }
});

test('history branch creation rechecks destination and worktree state after the editor preparation callback', async t => {
    for (const change of ['destination', 'worktree']) {
        const { repo, desk, calls } = await fixture(t), revision = git(repo, 'rev-parse', 'HEAD');
        const other = nextCommit(repo);
        calls.duringBefore = async () => {
            if (change === 'destination') git(repo, 'branch', 'feature/history', other);
            else await fs.writeFile(path.join(repo, 'file.txt'), 'late editor save\n');
        };
        const result = await finish(desk, await plan(desk, 'createBranch', { branch: 'feature/history', revision }));
        assert.equal(result.status, 'failed'); assert.equal(git(repo, 'branch', '--show-current'), 'dev');
        assert.equal(ref(repo, 'feature/history'), change === 'destination' ? other : '');
        assert.equal(await fs.readFile(path.join(repo, 'file.txt'), 'utf8'), change === 'worktree' ? 'late editor save\n' : 'first\n');
        assert.equal(calls.before, 1); assert.equal(calls.after, 1);
    }
});

test('mutating the request and public preview after prepare cannot redirect a branch rename', async t => {
    const { repo, desk } = await fixture(t);
    git(repo, 'branch', 'topic'); const revision = ref(repo, 'topic'), snapshot = await desk.snapshot(true);
    const request = { repo: '.', version: snapshot.repositories[0].version, action: 'renameBranch', branch: 'topic', newBranch: 'intended', revision };
    const preview = await desk.prepare(request);
    Object.assign(request, { action: 'deleteBranch', branch: 'dev', newBranch: 'unexpected', revision: '0'.repeat(40) });
    preview.paths.push('file.txt'); preview.title = 'mutated'; preview.warnings.push('mutated');
    const result = await finish(desk, preview); assert.equal(result.status, 'success', result.log);
    assert.equal(ref(repo, 'topic'), ''); assert.equal(ref(repo, 'intended'), revision); assert.equal(ref(repo, 'unexpected'), '');
    assert.equal(ref(repo, 'dev'), revision); assert.equal(git(repo, 'branch', '--show-current'), 'dev');
});

test('destination config checks distinguish dotted branch names from exact orphaned configuration', async t => {
    for (const action of ['renameBranch', 'createBranch']) for (const exact of [false, true]) {
        const { repo, desk } = await fixture(t);
        git(repo, 'branch', 'topic'); const revision = ref(repo, 'topic');
        git(repo, 'config', 'branch.foo.bar.description', 'belongs to foo.bar');
        if (exact) git(repo, 'config', 'branch.foo.description', 'orphaned foo settings');
        const args = action === 'renameBranch' ? { branch: 'topic', newBranch: 'foo', revision } : { branch: 'foo', revision };
        if (exact) {
            const before = await state(repo);
            await assert.rejects(plan(desk, action, args));
            assert.equal(ref(repo, 'foo'), ''); assert.equal(ref(repo, 'topic'), revision);
            assert.equal(git(repo, 'config', 'branch.foo.description'), 'orphaned foo settings');
            assert.deepEqual(await state(repo), before);
        } else {
            await perform(desk, action, args);
            assert.equal(ref(repo, 'foo'), revision);
        }
        assert.equal(git(repo, 'config', 'branch.foo.bar.description'), 'belongs to foo.bar');
    }
});

test('symbolic refs under heads are excluded from management and cannot be overwritten by rename or create', async t => {
    const { repo, desk } = await fixture(t);
    git(repo, 'branch', 'topic'); const revision = ref(repo, 'topic');
    git(repo, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/topic');
    git(repo, 'symbolic-ref', 'refs/heads/dangling', 'refs/heads/missing-target');
    assert.equal((await desk.details('.')).branches.some(branch => branch.name === 'alias'), false);
    const before = await state(repo);
    for (const action of ['renameBranch', 'deleteBranch']) {
        await assert.rejects(plan(desk, action, { branch: 'alias', newBranch: 'renamed', revision }));
    }
    for (const destination of ['alias', 'dangling']) {
        await assert.rejects(plan(desk, 'renameBranch', { branch: 'topic', newBranch: destination, revision }));
        await assert.rejects(plan(desk, 'createBranch', { branch: destination, revision }));
    }
    assert.equal(git(repo, 'symbolic-ref', 'refs/heads/alias'), 'refs/heads/topic');
    assert.equal(git(repo, 'symbolic-ref', 'refs/heads/dangling'), 'refs/heads/missing-target');
    assert.equal(ref(repo, 'topic'), revision); assert.equal(ref(repo, 'renamed'), '');
    assert.deepEqual(await state(repo), before);
});

test('switching refuses a target branch that moves after preview and leaves the current checkout intact', async t => {
    const { repo, desk, calls } = await fixture(t);
    git(repo, 'branch', 'topic');
    const preview = await plan(desk, 'switch', { branch: 'topic' }), newer = nextCommit(repo);
    git(repo, 'update-ref', 'refs/heads/topic', newer);
    const before = await state(repo), result = await finish(desk, preview);
    assert.equal(result.status, 'failed'); assert.equal(ref(repo, 'topic'), newer);
    assert.deepEqual(await state(repo), before); assert.equal(calls.after, calls.before);
});

test('history branch creation never follows a same-named forty-character ref to another commit', async t => {
    const { repo, desk } = await fixture(t), revision = git(repo, 'rev-parse', 'HEAD'), other = nextCommit(repo);
    git(repo, 'update-ref', 'refs/heads/' + revision, other);
    const before = await state(repo);
    let preview;
    try {
        preview = await plan(desk, 'createBranch', { branch: 'feature/from-hash', revision });
    } catch (error) {
        assert.ok(error instanceof Error);
        assert.equal(ref(repo, 'feature/from-hash'), ''); assert.equal(ref(repo, revision), other);
        assert.deepEqual(await state(repo), before);
        return;
    }
    const result = await finish(desk, preview); assert.equal(result.status, 'success', result.log);
    assert.equal(ref(repo, 'feature/from-hash'), revision); assert.equal(git(repo, 'rev-parse', 'HEAD'), revision);
    assert.equal(git(repo, 'branch', '--show-current'), 'feature/from-hash');
    assert.equal(ref(repo, revision), other); assert.equal(ref(repo, 'dev'), before.head);
    assert.deepEqual(await fs.readFile(path.join(repo, 'file.txt')), before.file);
});


test('historical branch creation ignores a same-named tag and validates the checked out commit', async t => {
    const { repo, desk } = await fixture(t), revision = git(repo, 'rev-parse', 'HEAD'), other = nextCommit(repo);
    git(repo, 'update-ref', 'refs/tags/' + revision, other);
    const result = await finish(desk, await plan(desk, 'createBranch', { branch: 'feature/from-tag-shadow', revision }));
    assert.equal(result.status, 'success', result.log);
    assert.equal(ref(repo, 'feature/from-tag-shadow'), revision);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), revision);
    assert.equal(git(repo, 'rev-parse', 'refs/tags/' + revision), other);
});
