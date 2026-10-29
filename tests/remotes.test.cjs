const { test } = require('node:test');
const { windows, portableName, exoticNames, posixModes, linkTarget } = require('./platform.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GitDesk } = require('../dist/git');
const { RemoteStore, remoteName, remoteUrl } = require('../dist/remotes');
const { RemoteStateChangedError } = require('../dist/types');
const work = path.resolve(__dirname, '../.test-work');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(work, 'remotes-no-global-config');
const gitBytes = (cwd, args) => execFileSync('git', args, { cwd, timeout: 30000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
const git = (cwd, ...args) => gitBytes(cwd, args).toString('utf8').trimEnd();
async function fixture(t) {
    await fs.mkdir(work, { recursive: true });
    const base = await fs.mkdtemp(path.join(work, 'remotes-'));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const repo = path.join(base, 'project'); await fs.mkdir(repo); git(repo, 'init', '-b', 'dev');
    git(repo, 'config', 'user.name', 'Remote Tests'); git(repo, 'config', 'user.email', 'remote@example.invalid');
    git(repo, 'config', 'commit.gpgSign', 'false');
    await fs.writeFile(path.join(repo, 'file.txt'), 'initial\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'initial');
    git(repo, 'remote', 'add', 'origin', 'https://example.invalid/team/repo.git');
    const cache = path.join(base, 'cache'), calls = [];
    const desk = new GitDesk(repo, cache, { async checkEditor() { calls.push('check'); }, async beforeWorktreeChange() { calls.push('before'); }, async afterWorktreeChange() { calls.push('after'); } });
    return { repo, base, cache, calls, desk, config: path.join(repo, '.git/config') };
}
async function page(f, query = {}) { return f.desk.remotePage('.', { kind: 'remotes', ...query }); }
async function preview(f, action, fields = {}) {
    const state = await page(f);
    return f.desk.prepare({ repo: '.', version: state.repoVersion, remoteVersion: state.remoteVersion, action, remote: 'origin', ...fields });
}
async function finish(f, plan) {
    f.desk.execute(plan.token); const start = Date.now();
    while (f.desk.task().status === 'running') { if (Date.now() - start > 30000) throw new Error('remote task timeout'); await new Promise(resolve => setTimeout(resolve, 10)); }
    return f.desk.task();
}

test('remote input rejects helpers, credentials, query secrets and ambiguous names', () => {
    for (const value of ['ext::sh command', 'custom-helper://host/repo', 'file:///local/repo', 'git@-host:repo', 'https://user:secret@host/repo', 'https://host/repo?token=secret', 'ssh://user:secret@host/repo', '-bad', 'a\nb', 'relative/path']) assert.throws(() => remoteUrl(value));
    for (const value of ['origin', 'team-2', 'mirror_1']) assert.equal(remoteName(value), value);
    for (const value of ['-origin', 'a.b', 'a/b', 'a\nb', '']) assert.throws(() => remoteName(value));
    for (const value of ['https://host/repo.git', 'ssh://git@host:2222/repo.git', 'git@host:team/repo.git', '/local/repo.git']) assert.equal(remoteUrl(value), value);
});

test('remote pages expose raw endpoints and push fallback without network or editor calls', async t => {
    const f = await fixture(t), state = await page(f);
    assert.equal(state.entries[0].editable, true); assert.equal(state.entries[0].pushUsesFetch, true);
    assert.deepEqual(state.entries[0].pushUrls, []); assert.equal(state.canAdd, true); assert.equal(state.remoteVersion.length, 64);
    assert.deepEqual(f.calls, []); assert.equal(f.desk.task(), null);
});

test('add remote installs URL and mapping together while preserving index and worktree', async t => {
    const f = await fixture(t); await fs.writeFile(path.join(f.repo, 'file.txt'), 'staged\n'); git(f.repo, 'add', '.');
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'unstaged\n');
    const before = gitBytes(f.repo, ['ls-files', '--stage', '-z']), head = git(f.repo, 'rev-parse', 'HEAD');
    const p = await preview(f, 'addRemote', { remote: 'backup', url: 'git@host:team/repo.git' });
    assert.deepEqual(p.paths, []); assert.match(p.description, /refs\/remotes\/backup/);
    const result = await finish(f, p); assert.equal(result.status, 'success', result.log);
    assert.equal(git(f.repo, 'config', 'remote.backup.url'), 'git@host:team/repo.git');
    assert.equal(git(f.repo, 'config', 'remote.backup.fetch'), '+refs/heads/*:refs/remotes/backup/*');
    assert.deepEqual(gitBytes(f.repo, ['ls-files', '--stage', '-z']), before);
    assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'unstaged\n'); assert.equal(git(f.repo, 'rev-parse', 'HEAD'), head);
    assert.deepEqual(f.calls, []);
});

test('fetch and push endpoints can be changed independently and push fallback can be restored', async t => {
    const f = await fixture(t);
    for (const [action, url] of [['setRemotePushUrl', 'ssh://git@host/repo.git'], ['setRemoteUrl', 'https://host/repo.git'], ['resetRemotePushUrl', undefined]]) {
        const p = await preview(f, action, url ? { url } : {}), task = await finish(f, p); assert.equal(task.status, 'success', task.log);
    }
    const state = await page(f); assert.equal(state.entries[0].fetchUrls[0], 'https://host/repo.git'); assert.equal(state.entries[0].pushUsesFetch, true);
});

test('existing remote, no-op, extra scope and invalid push reset are refused in preview', async t => {
    const f = await fixture(t);
    await assert.rejects(preview(f, 'addRemote', { url: 'https://host/repo' }), /存在/);
    await assert.rejects(preview(f, 'setRemoteUrl', { url: 'https://example.invalid/team/repo.git' }), /未变化/);
    await assert.rejects(preview(f, 'setRemoteUrl', { url: 'https://host/repo', paths: [] }), /无关/);
    await assert.rejects(preview(f, 'resetRemotePushUrl'), /独立推送/);
    assert.equal(f.desk.task(), null);
});

test('multi-value and custom remote configuration is readable but cannot be overwritten', async t => {
    const f = await fixture(t); git(f.repo, 'config', '--add', 'remote.origin.url', 'https://host/other.git');
    assert.equal((await page(f)).entries[0].fetchCount, 2);
    await assert.rejects(preview(f, 'setRemoteUrl', { url: 'https://host/repo' }), /单值/);
    git(f.repo, 'config', '--unset-all', 'remote.origin.url'); git(f.repo, 'config', 'remote.origin.url', 'https://host/repo');
    git(f.repo, 'config', 'remote.origin.mirror', 'true');
    assert.equal((await page(f)).entries[0].editable, false);
});

test('rewrite and include sources are read-only and sensitive URLs never enter output', async t => {
    const f = await fixture(t); git(f.repo, 'config', 'remote.origin.url', 'https://user:top-secret@host/repo?token=secret');
    assert.doesNotMatch(JSON.stringify(await page(f)), /top-secret|token=secret/);
    git(f.repo, 'config', 'remote.origin.url', 'https://host/repo');
    git(f.repo, 'config', 'url.ssh://git@host/.insteadOf', 'https://host/');
    let state = await page(f); assert.equal(state.canAdd, false); assert.match(state.reason, /重写/);
    git(f.repo, 'config', '--unset', 'url.ssh://git@host/.insteadOf');
    const included = path.join(f.base, 'included'); await fs.writeFile(included, '[user]\n name = other\n'); git(f.repo, 'config', 'include.path', included);
    state = await page(f); assert.equal(state.canAdd, false); assert.match(state.reason, /include/);
});

test('pagination requires matching snapshot version and rejects concurrent configuration changes', async t => {
    const f = await fixture(t); git(f.repo, 'remote', 'add', 'second', 'https://host/repo');
    const first = await page(f, { limit: 1 }); assert.equal(first.entries.length, 1); assert.equal(first.nextOffset, 1);
    await assert.rejects(page(f, { offset: 1, limit: 1 }), RemoteStateChangedError);
    assert.equal((await page(f, { offset: 1, limit: 1, version: first.version })).entries.length, 1);
    git(f.repo, 'config', 'user.name', 'changed');
    await assert.rejects(page(f, { offset: 1, limit: 1, version: first.version }), RemoteStateChangedError);
});

test('stale prepared writes fail without replacing newer config', async t => {
    const f = await fixture(t), p = await preview(f, 'setRemoteUrl', { url: 'https://host/new.git' });
    git(f.repo, 'config', 'remote.origin.url', 'https://host/external.git');
    const task = await finish(f, p); assert.equal(task.status, 'failed'); assert.equal(git(f.repo, 'config', 'remote.origin.url'), 'https://host/external.git');
});

test('existing config lock is preserved and config is not changed', async t => {
    const f = await fixture(t), p = await preview(f, 'setRemoteUrl', { url: 'https://host/new.git' });
    const before = await fs.readFile(f.config); await fs.writeFile(f.config + '.lock', 'external lock');
    const task = await finish(f, p); assert.equal(task.status, 'failed'); assert.deepEqual(await fs.readFile(f.config), before);
    assert.equal(await fs.readFile(f.config + '.lock', 'utf8'), 'external lock');
});

test('temporary Git edit failure leaves original config intact and removes owned temporary data', async t => {
    const f = await fixture(t), before = await fs.readFile(f.config);
    const store = new RemoteStore(f.repo, f.cache, async args => {
        if (args.includes('--file') && args.includes('remote.origin.url')) throw new Error('injected edit failure');
        return gitBytes(f.repo, args);
    });
    const state = await store.page('.', 'v1', { kind: 'remotes' });
    await assert.rejects(store.execute({ repo: '.', version: 'v1', remoteVersion: state.remoteVersion, action: 'setRemoteUrl', remote: 'origin', url: 'https://host/new' }), /injected/);
    assert.deepEqual(await fs.readFile(f.config), before); await assert.rejects(fs.stat(f.config + '.lock'), { code: 'ENOENT' });
    assert.deepEqual((await fs.readdir(f.cache)).filter(name => name.startsWith('remote-config-')), []);
});

test('file mode is preserved and linked config is refused without touching its target', async t => {
    const f = await fixture(t); await fs.chmod(f.config, 0o600);
    const task = await finish(f, await preview(f, 'setRemoteUrl', { url: 'https://host/new' })); assert.equal(task.status, 'success', task.log);
    if (posixModes) assert.equal((await fs.stat(f.config)).mode & 0o777, 0o600);
    const target = path.join(f.base, 'linked-config'); await fs.rename(f.config, target); await fs.symlink(target, f.config);
    const before = await fs.readFile(target); await assert.rejects(page(f), /普通非链接/); assert.deepEqual(await fs.readFile(target), before);
});

test('failure during the second add-remote key leaves neither key installed', async t => {
    const f = await fixture(t), before = await fs.readFile(f.config);
    const store = new RemoteStore(f.repo, f.cache, async args => {
        if (args.includes('--file') && args.includes('remote.backup.fetch')) throw new Error('mapping failed');
        return gitBytes(f.repo, args);
    });
    const state = await store.page('.', 'v1', { kind: 'remotes' });
    await assert.rejects(store.execute({ repo: '.', version: 'v1', remoteVersion: state.remoteVersion, action: 'addRemote', remote: 'backup', url: 'https://host/repo' }), /mapping failed/);
    assert.deepEqual(await fs.readFile(f.config), before); assert.equal(git(f.repo, 'remote'), 'origin');
});

test('a writer ignoring config.lock is detected before replacement and its change is retained', async t => {
    const f = await fixture(t); let changed = false;
    const store = new RemoteStore(f.repo, f.cache, async args => {
        const result = gitBytes(f.repo, args);
        if (!changed && args.includes('--file') && args.includes('remote.origin.url')) {
            changed = true; await fs.appendFile(f.config, '\n[external]\n value = retained\n');
        }
        return result;
    });
    const state = await store.page('.', 'v1', { kind: 'remotes' });
    await assert.rejects(store.execute({ repo: '.', version: 'v1', remoteVersion: state.remoteVersion, action: 'setRemoteUrl', remote: 'origin', url: 'https://host/new' }), RemoteStateChangedError);
    assert.equal(git(f.repo, 'config', 'external.value'), 'retained');
    assert.equal(git(f.repo, 'config', 'remote.origin.url'), 'https://example.invalid/team/repo.git');
});

test('a read-back failure after installation reports uncertainty and preserves the installed config', async t => {
    const f = await fixture(t); let staged = false;
    const store = new RemoteStore(f.repo, f.cache, async args => {
        if (args.includes('--file') && args.includes('remote.origin.url')) staged = true;
        if (staged && args.includes('--show-origin') && git(f.repo, 'config', 'remote.origin.url') === 'https://host/new') throw new Error('read-back failed');
        return gitBytes(f.repo, args);
    });
    const state = await store.page('.', 'v1', { kind: 'remotes' });
    await assert.rejects(store.execute({ repo: '.', version: 'v1', remoteVersion: state.remoteVersion, action: 'setRemoteUrl', remote: 'origin', url: 'https://host/new' }), /可能已经写入/);
    assert.equal(git(f.repo, 'config', 'remote.origin.url'), 'https://host/new');
    await assert.rejects(fs.stat(f.config + '.lock'), { code: 'ENOENT' });
});

test('new remote names cannot claim orphaned tracking refs or collide with existing name case', async t => {
    const f = await fixture(t);
    git(f.repo, 'update-ref', 'refs/remotes/backup/dev', 'HEAD');
    await assert.rejects(preview(f, 'addRemote', { remote: 'backup', url: 'https://host/repo' }), /跟踪引用/);
    await assert.rejects(preview(f, 'addRemote', { remote: 'Origin', url: 'https://host/repo' }), /存在/);
    assert.equal(git(f.repo, 'remote'), 'origin');
});
