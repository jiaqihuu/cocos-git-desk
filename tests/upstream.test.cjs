const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GitDesk } = require('../dist/git');

const work = path.resolve(__dirname, '../.test-work');
process.env.GIT_ALLOW_PROTOCOL = 'file';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(work, 'upstream-no-global-config');
const git = (cwd, ...args) => execFileSync('git', ['--literal-pathspecs', ...args], {
    cwd, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
}).trimEnd();

async function fixture(t) {
    await fs.mkdir(work, { recursive: true });
    const base = await fs.mkdtemp(path.join(work, 'upstream-'));
    t.after(async () => { await fs.rm(base, { recursive: true, force: true }); });
    const repo = path.join(base, 'project'); await fs.mkdir(repo);
    git(repo, 'init', '-b', 'dev');
    git(repo, 'config', 'user.name', 'Git Desk Test');
    git(repo, 'config', 'user.email', 'git-desk@example.invalid');
    git(repo, 'config', 'commit.gpgSign', 'false');
    git(repo, 'config', 'core.hooksPath', path.join(base, 'no-hooks'));
    await fs.writeFile(path.join(repo, 'file.txt'), 'first\n');
    git(repo, 'add', 'file.txt'); git(repo, 'commit', '-m', 'initial');
    const calls = { check: 0, before: 0, after: 0 };
    const desk = new GitDesk(repo, path.join(base, 'cache'), {
        async checkEditor() { calls.check++; throw new Error('unsaved scene'); },
        async beforeWorktreeChange() { calls.before++; },
        async afterWorktreeChange() { calls.after++; },
    });
    return { repo, base, desk, calls };
}

function addRemote(repo, base, name = 'origin') { git(repo, 'remote', 'add', name, path.join(base, name + '-offline.git')); }
function tip(repo, branch = 'dev') { return git(repo, 'rev-parse', 'refs/heads/' + branch); }
function child(repo, message, parent = 'HEAD') { return git(repo, 'commit-tree', 'HEAD^{tree}', '-p', parent, '-m', message); }
function cached(repo, name, revision) { git(repo, 'update-ref', 'refs/remotes/' + name, revision); }
function track(repo, branch, remote = 'origin', merge = 'refs/heads/topic') {
    git(repo, 'config', 'branch.' + branch + '.remote', remote);
    git(repo, 'config', 'branch.' + branch + '.merge', merge);
}
function config(repo, key) {
    try { return git(repo, 'config', '--get-all', key); }
    catch (error) { if (error.status === 1) return undefined; throw error; }
}
async function configBytes(repo) { return fs.readFile(path.resolve(repo, git(repo, 'rev-parse', '--git-path', 'config'))); }

async function dirty(repo) {
    await fs.writeFile(path.join(repo, 'file.txt'), 'staged\n'); git(repo, 'add', 'file.txt');
    await fs.writeFile(path.join(repo, 'file.txt'), 'unstaged\n');
    await fs.writeFile(path.join(repo, 'new.txt'), 'untracked\n');
}
async function state(repo) {
    return {
        head: git(repo, 'rev-parse', 'HEAD'), branch: git(repo, 'branch', '--show-current'),
        refs: git(repo, 'for-each-ref', '--format=%(refname) %(objectname) %(symref)'),
        index: await fs.readFile(path.resolve(repo, git(repo, 'rev-parse', '--git-path', 'index'))),
        file: await fs.readFile(path.join(repo, 'file.txt')),
        untracked: await fs.readFile(path.join(repo, 'new.txt')).catch(error => { if (error.code === 'ENOENT') return null; throw error; }),
        remotes: git(repo, 'config', '--get-regexp', '^remote[.]'),
    };
}
function noHostChanges(calls) { assert.deepEqual(calls, { check: 0, before: 0, after: 0 }); }
async function plan(desk, action, args) {
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
}
function request(repo, branch = 'topic', remoteBranch = 'refs/remotes/origin/topic') {
    return { branch, revision: tip(repo, branch), remoteBranch, upstreamRevision: git(repo, 'rev-parse', remoteBranch) };
}

test('branch details distinguish no upstream, cached divergence, gone upstream and malformed configuration', async t => {
    const { repo, base, desk } = await fixture(t), initial = tip(repo);
    addRemote(repo, base);
    git(repo, 'branch', 'topic', child(repo, 'local change'));
    git(repo, 'branch', 'gone'); git(repo, 'branch', 'invalid');
    cached(repo, 'origin/topic', child(repo, 'remote change')); track(repo, 'topic');
    track(repo, 'gone', 'origin', 'refs/heads/deleted');
    git(repo, 'config', 'branch.invalid.remote', 'origin');
    const branches = (await desk.details('.')).branches;
    assert.equal(branches.find(branch => branch.name === 'dev').tracking.state, 'none');
    const tracked = branches.find(branch => branch.name === 'topic');
    assert.equal(tracked.upstreamRef, 'refs/remotes/origin/topic');
    assert.deepEqual(tracked.tracking, { state: 'tracked', remote: 'origin', merge: 'refs/heads/topic', ahead: 1, behind: 1 });
    assert.equal(branches.find(branch => branch.name === 'gone').tracking.state, 'gone');
    assert.equal(branches.find(branch => branch.name === 'invalid').tracking.state, 'invalid');
    assert.equal(tip(repo), initial);
});

test('setting an upstream on a dirty current branch preserves files, staged content, refs and editor state', async t => {
    const { repo, base, desk, calls } = await fixture(t);
    addRemote(repo, base); cached(repo, 'origin/shared', tip(repo));
    git(repo, 'config', 'branch.dev.description', 'keep description');
    git(repo, 'config', 'branch.dev.pushRemote', 'publish');
    git(repo, 'config', 'branch.dev.rebase', 'false');
    git(repo, 'config', 'branch.autoSetupRebase', 'always');
    await dirty(repo); const before = await state(repo);
    await perform(desk, 'setUpstream', request(repo, 'dev', 'refs/remotes/origin/shared'));
    assert.equal(config(repo, 'branch.dev.remote'), 'origin');
    assert.equal(config(repo, 'branch.dev.merge'), 'refs/heads/shared');
    assert.equal(config(repo, 'branch.dev.description'), 'keep description');
    assert.equal(config(repo, 'branch.dev.pushRemote'), 'publish');
    assert.equal(config(repo, 'branch.dev.rebase'), 'false');
    assert.deepEqual(await state(repo), before); noHostChanges(calls);
});

test('setting an idle dotted Unicode branch tracks the exact remote branch and does not add a rebase preference', async t => {
    const { repo, base, desk, calls } = await fixture(t), branch = 'feature/中文.topic';
    git(repo, 'branch', branch); git(repo, 'branch', branch + '.child');
    addRemote(repo, base); cached(repo, 'origin/team/中文', child(repo, 'cached change'));
    git(repo, 'config', 'branch.' + branch + '.child.description', 'another branch');
    git(repo, 'config', 'branch.autoSetupRebase', 'always');
    await dirty(repo); const before = await state(repo);
    await perform(desk, 'setUpstream', request(repo, branch, 'refs/remotes/origin/team/中文'));
    assert.equal(config(repo, 'branch.' + branch + '.remote'), 'origin');
    assert.equal(config(repo, 'branch.' + branch + '.merge'), 'refs/heads/team/中文');
    assert.equal(config(repo, 'branch.' + branch + '.rebase'), undefined);
    assert.equal(config(repo, 'branch.' + branch + '.child.description'), 'another branch');
    assert.deepEqual(await state(repo), before); noHostChanges(calls);
});

test('replacing a tracked or gone upstream changes only the chosen branch tracking configuration', async t => {
    for (const gone of [false, true]) {
        const { repo, base, desk, calls } = await fixture(t);
        git(repo, 'branch', 'topic'); addRemote(repo, base); addRemote(repo, base, 'team');
        if (!gone) cached(repo, 'origin/topic', tip(repo));
        track(repo, 'topic'); cached(repo, 'team/other', child(repo, 'other remote'));
        await dirty(repo); const before = await state(repo);
        await perform(desk, 'setUpstream', request(repo, 'topic', 'refs/remotes/team/other'));
        assert.equal(config(repo, 'branch.topic.remote'), 'team');
        assert.equal(config(repo, 'branch.topic.merge'), 'refs/heads/other');
        assert.deepEqual(await state(repo), before); noHostChanges(calls);
    }
});

test('unsetting a tracked or gone upstream keeps other branch settings and every dirty file intact', async t => {
    for (const branch of ['dev', 'topic']) for (const gone of [false, true]) {
        const { repo, base, desk, calls } = await fixture(t);
        if (branch !== 'dev') git(repo, 'branch', branch);
        addRemote(repo, base); if (!gone) cached(repo, 'origin/topic', tip(repo));
        track(repo, branch);
        git(repo, 'config', 'branch.' + branch + '.description', 'keep');
        git(repo, 'config', 'branch.' + branch + '.rebase', 'true');
        git(repo, 'config', 'branch.' + branch + '.pushRemote', 'publish');
        await dirty(repo); const before = await state(repo);
        await perform(desk, 'unsetUpstream', { branch, revision: tip(repo, branch) });
        assert.equal(config(repo, 'branch.' + branch + '.remote'), undefined);
        assert.equal(config(repo, 'branch.' + branch + '.merge'), undefined);
        assert.equal(config(repo, 'branch.' + branch + '.description'), 'keep');
        assert.equal(config(repo, 'branch.' + branch + '.rebase'), 'true');
        assert.equal(config(repo, 'branch.' + branch + '.pushRemote'), 'publish');
        assert.deepEqual(await state(repo), before); noHostChanges(calls);
    }
});

test('previewing a tracking change identifies its branch and target without applying configuration', async t => {
    const { repo, base, desk, calls } = await fixture(t);
    git(repo, 'branch', 'topic'); addRemote(repo, base); cached(repo, 'origin/topic', tip(repo));
    const before = await state(repo), originalConfig = await configBytes(repo), args = request(repo);
    const preview = await plan(desk, 'setUpstream', args);
    assert.ok(preview.description.includes('topic'));
    assert.ok(preview.description.includes(args.revision));
    assert.ok(preview.description.includes('origin'));
    assert.deepEqual(preview.paths, []); assert.ok(preview.warnings.length > 0);
    assert.deepEqual(await state(repo), before); assert.deepEqual(await configBytes(repo), originalConfig); noHostChanges(calls);
});

test('tracking changes require full current local and remote commit IDs', async t => {
    const { repo, base, desk } = await fixture(t);
    git(repo, 'branch', 'topic'); addRemote(repo, base); cached(repo, 'origin/topic', tip(repo)); track(repo, 'topic');
    const args = request(repo), originalConfig = await configBytes(repo);
    for (const revision of [undefined, 'HEAD', args.revision.slice(0, 8), '0'.repeat(40), child(repo, 'stale local')]) {
        for (const action of ['setUpstream', 'unsetUpstream']) await assert.rejects(plan(desk, action, { ...args, revision }));
    }
    for (const upstreamRevision of [undefined, 'HEAD', args.upstreamRevision.slice(0, 8), '0'.repeat(40), child(repo, 'stale remote')]) {
        await assert.rejects(plan(desk, 'setUpstream', { ...args, upstreamRevision }));
    }
    assert.deepEqual(await configBytes(repo), originalConfig);
});

test('tracking changes reject invalid or missing local branches and symbolic local aliases', async t => {
    const { repo, base, desk } = await fixture(t);
    git(repo, 'branch', 'topic'); addRemote(repo, base); cached(repo, 'origin/topic', tip(repo));
    git(repo, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/topic');
    const args = request(repo), before = await state(repo), originalConfig = await configBytes(repo);
    for (const branch of ['', '-d', 'bad name', 'missing', 'refs/heads/topic', 'alias', 'bad\0name']) {
        for (const action of ['setUpstream', 'unsetUpstream']) await assert.rejects(plan(desk, action, { ...args, branch }));
    }
    assert.deepEqual(await state(repo), before); assert.deepEqual(await configBytes(repo), originalConfig);
});

test('setting an upstream accepts only an existing nonsymbolic remote tracking ref', async t => {
    const { repo, base, desk } = await fixture(t);
    git(repo, 'branch', 'topic'); addRemote(repo, base); cached(repo, 'origin/topic', tip(repo));
    git(repo, 'tag', 'topic'); git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/topic');
    const args = request(repo), before = await state(repo), originalConfig = await configBytes(repo);
    for (const remoteBranch of [undefined, '', 'origin/topic', 'refs/heads/topic', 'refs/tags/topic', 'refs/remotes/origin/missing', 'refs/remotes/origin/HEAD']) {
        await assert.rejects(plan(desk, 'setUpstream', { ...args, remoteBranch }));
    }
    assert.deepEqual(await state(repo), before); assert.deepEqual(await configBytes(repo), originalConfig);
});

test('nonstandard, negative and ambiguous fetch mappings cannot select an accidental remote upstream', async t => {
    for (const mode of ['nonstandard', 'negative', 'overlap']) {
        const { repo, base, desk } = await fixture(t);
        git(repo, 'branch', 'topic'); addRemote(repo, base); cached(repo, 'origin/topic', tip(repo));
        if (mode === 'nonstandard') git(repo, 'config', 'remote.origin.fetch', '+refs/heads/topic:refs/remotes/origin/topic');
        if (mode === 'negative') git(repo, 'config', '--add', 'remote.origin.fetch', '^refs/heads/private/*');
        if (mode === 'overlap') {
            addRemote(repo, base, 'other');
            git(repo, 'config', 'remote.other.fetch', '+refs/heads/*:refs/remotes/origin/*');
        }
        const before = await state(repo), originalConfig = await configBytes(repo);
        await assert.rejects(plan(desk, 'setUpstream', request(repo)));
        assert.deepEqual(await state(repo), before); assert.deepEqual(await configBytes(repo), originalConfig);
    }
});

test('incomplete, empty or multiple upstream configuration values are not silently repaired', async t => {
    for (const mode of ['remote-only', 'merge-only', 'empty-remote', 'empty-merge', 'two-remotes', 'two-merges']) {
        const { repo, base, desk } = await fixture(t);
        git(repo, 'branch', 'topic'); addRemote(repo, base); cached(repo, 'origin/topic', tip(repo));
        if (mode !== 'merge-only') git(repo, 'config', 'branch.topic.remote', mode === 'empty-remote' ? '' : 'origin');
        if (mode !== 'remote-only') git(repo, 'config', 'branch.topic.merge', mode === 'empty-merge' ? '' : 'refs/heads/topic');
        if (mode === 'two-remotes') git(repo, 'config', '--add', 'branch.topic.remote', 'origin');
        if (mode === 'two-merges') git(repo, 'config', '--add', 'branch.topic.merge', 'refs/heads/other');
        const originalConfig = await configBytes(repo);
        for (const action of ['setUpstream', 'unsetUpstream']) await assert.rejects(plan(desk, action, request(repo)));
        assert.deepEqual(await configBytes(repo), originalConfig);
    }
});

test('tracking values inherited from global, included or worktree configuration remain untouched', async t => {
    for (const scope of ['global', 'include', 'worktree']) {
        const { repo, base, desk } = await fixture(t), previousGlobal = process.env.GIT_CONFIG_GLOBAL;
        git(repo, 'branch', 'topic'); addRemote(repo, base); cached(repo, 'origin/topic', tip(repo));
        let external;
        try {
            if (scope === 'worktree') {
                git(repo, 'config', 'extensions.worktreeConfig', 'true');
                git(repo, 'config', '--worktree', 'branch.topic.remote', 'origin');
                git(repo, 'config', '--worktree', 'branch.topic.merge', 'refs/heads/topic');
                external = path.resolve(repo, git(repo, 'rev-parse', '--git-path', 'config.worktree'));
            } else {
                external = path.join(base, scope + '.config');
                await fs.writeFile(external, '[branch "topic"]\n\tremote = origin\n\tmerge = refs/heads/topic\n');
                if (scope === 'global') process.env.GIT_CONFIG_GLOBAL = external;
                else git(repo, 'config', 'include.path', external);
            }
            const originalConfig = await configBytes(repo), externalBytes = await fs.readFile(external);
            for (const action of ['setUpstream', 'unsetUpstream']) await assert.rejects(plan(desk, action, request(repo)));
            assert.deepEqual(await configBytes(repo), originalConfig); assert.deepEqual(await fs.readFile(external), externalBytes);
        } finally { process.env.GIT_CONFIG_GLOBAL = previousGlobal; }
    }
});

test('unsetting an absent upstream is rejected without creating branch configuration', async t => {
    const { repo, desk } = await fixture(t), originalConfig = await configBytes(repo);
    await assert.rejects(plan(desk, 'unsetUpstream', { branch: 'dev', revision: tip(repo) }));
    assert.deepEqual(await configBytes(repo), originalConfig);
});

test('branches occupied by another worktree cannot have their upstream changed', async t => {
    const { repo, base, desk, calls } = await fixture(t);
    git(repo, 'branch', 'topic'); addRemote(repo, base); cached(repo, 'origin/topic', tip(repo)); track(repo, 'topic');
    const linked = path.join(base, 'linked 中文 worktree'); git(repo, 'worktree', 'add', linked, 'topic');
    const before = await state(repo), linkedBefore = await state(linked), originalConfig = await configBytes(repo);
    for (const action of ['setUpstream', 'unsetUpstream']) await assert.rejects(plan(desk, action, request(repo)));
    assert.deepEqual(await state(repo), before); assert.deepEqual(await state(linked), linkedBefore);
    assert.deepEqual(await configBytes(repo), originalConfig); noHostChanges(calls);
});

test('moving the selected local branch after preview invalidates either tracking operation', async t => {
    for (const action of ['setUpstream', 'unsetUpstream']) {
        const { repo, base, desk, calls } = await fixture(t);
        git(repo, 'branch', 'topic'); addRemote(repo, base); cached(repo, 'origin/topic', tip(repo)); track(repo, 'topic');
        cached(repo, 'origin/other', tip(repo));
        const preview = await plan(desk, action, request(repo, 'topic', 'refs/remotes/origin/other'));
        git(repo, 'update-ref', 'refs/heads/topic', child(repo, 'late local change'));
        const before = await state(repo), originalConfig = await configBytes(repo), result = await finish(desk, preview);
        assert.equal(result.status, 'failed'); assert.deepEqual(await state(repo), before);
        assert.deepEqual(await configBytes(repo), originalConfig); noHostChanges(calls);
    }
});

test('moving or removing a selected cached upstream after preview prevents setting stale tracking', async t => {
    for (const change of ['move', 'remove']) {
        const { repo, base, desk, calls } = await fixture(t);
        git(repo, 'branch', 'topic'); addRemote(repo, base); cached(repo, 'origin/topic', tip(repo));
        const preview = await plan(desk, 'setUpstream', request(repo));
        if (change === 'move') cached(repo, 'origin/topic', child(repo, 'late remote change'));
        else git(repo, 'update-ref', '-d', 'refs/remotes/origin/topic');
        const before = await state(repo), originalConfig = await configBytes(repo), result = await finish(desk, preview);
        assert.equal(result.status, 'failed'); assert.deepEqual(await state(repo), before);
        assert.deepEqual(await configBytes(repo), originalConfig); noHostChanges(calls);
    }
});

test('changing or removing the prior upstream after preview invalidates either tracking operation', async t => {
    for (const action of ['setUpstream', 'unsetUpstream']) for (const change of ['move', 'remove', 'config']) {
        const { repo, base, desk } = await fixture(t);
        git(repo, 'branch', 'topic'); addRemote(repo, base); cached(repo, 'origin/topic', child(repo, 'old upstream')); track(repo, 'topic');
        cached(repo, 'origin/other', tip(repo)); cached(repo, 'origin/third', tip(repo));
        const preview = await plan(desk, action, request(repo, 'topic', 'refs/remotes/origin/other'));
        if (change === 'move') cached(repo, 'origin/topic', child(repo, 'old upstream changed'));
        else if (change === 'remove') git(repo, 'update-ref', '-d', 'refs/remotes/origin/topic');
        else git(repo, 'config', 'branch.topic.merge', 'refs/heads/third');
        const before = await state(repo), originalConfig = await configBytes(repo), result = await finish(desk, preview);
        assert.equal(result.status, 'failed'); assert.deepEqual(await state(repo), before);
        assert.deepEqual(await configBytes(repo), originalConfig);
    }
});

test('changing fetch mapping after preview cannot redirect the confirmed upstream', async t => {
    for (const action of ['setUpstream', 'unsetUpstream']) {
        const { repo, base, desk } = await fixture(t);
        git(repo, 'branch', 'topic'); addRemote(repo, base); cached(repo, 'origin/topic', tip(repo)); track(repo, 'topic');
        cached(repo, 'origin/other', tip(repo));
        const preview = await plan(desk, action, request(repo, 'topic', 'refs/remotes/origin/other'));
        git(repo, 'config', 'remote.origin.fetch', '+refs/heads/renamed/*:refs/remotes/origin/*');
        const before = await state(repo), originalConfig = await configBytes(repo), result = await finish(desk, preview);
        assert.equal(result.status, 'failed'); assert.deepEqual(await state(repo), before);
        assert.deepEqual(await configBytes(repo), originalConfig);
    }
});

test('new worktree occupancy after preview preserves the branch configuration and both worktrees', async t => {
    for (const action of ['setUpstream', 'unsetUpstream']) {
        const { repo, base, desk, calls } = await fixture(t);
        git(repo, 'branch', 'topic'); addRemote(repo, base); cached(repo, 'origin/topic', tip(repo)); track(repo, 'topic');
        cached(repo, 'origin/other', tip(repo));
        const preview = await plan(desk, action, request(repo, 'topic', 'refs/remotes/origin/other'));
        const linked = path.join(base, 'late-worktree'); git(repo, 'worktree', 'add', linked, 'topic');
        const before = await state(repo), linkedBefore = await state(linked), originalConfig = await configBytes(repo);
        const result = await finish(desk, preview);
        assert.equal(result.status, 'failed'); assert.deepEqual(await state(repo), before);
        assert.deepEqual(await state(linked), linkedBefore); assert.deepEqual(await configBytes(repo), originalConfig); noHostChanges(calls);
    }
});

test('mutating the request or public preview cannot redirect a confirmed upstream change', async t => {
    const { repo, base, desk, calls } = await fixture(t);
    git(repo, 'branch', 'topic'); addRemote(repo, base); cached(repo, 'origin/topic', tip(repo));
    cached(repo, 'origin/unexpected', child(repo, 'unexpected target'));
    const snapshot = await desk.snapshot(true);
    const input = { repo: '.', version: snapshot.repositories[0].version, action: 'setUpstream', ...request(repo) };
    const preview = await desk.prepare(input), before = await state(repo);
    Object.assign(input, { action: 'unsetUpstream', branch: 'dev', remoteBranch: 'refs/remotes/origin/unexpected', upstreamRevision: '0'.repeat(40) });
    preview.paths.push('file.txt'); preview.title = 'mutated'; preview.warnings.push('mutated');
    const result = await finish(desk, preview);
    assert.equal(result.status, 'success', result.log);
    assert.equal(config(repo, 'branch.topic.remote'), 'origin'); assert.equal(config(repo, 'branch.topic.merge'), 'refs/heads/topic');
    assert.equal(config(repo, 'branch.dev.remote'), undefined); assert.equal(config(repo, 'branch.dev.merge'), undefined);
    assert.deepEqual(await state(repo), before); noHostChanges(calls);
});
