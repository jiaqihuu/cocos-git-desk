const { test } = require('node:test');
const { windows, portableName, exoticNames, posixModes, linkTarget } = require('./platform.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { GitDesk } = require('../dist/git');

const work = path.resolve(__dirname, '../.test-work');
process.env.GIT_ALLOW_PROTOCOL = 'file';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(work, 'search-compare-no-global-config');
const git = (cwd, ...args) => execFileSync('git', ['--literal-pathspecs', ...args], {
    cwd, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
}).trimEnd();

async function fixture(t, seed = true) {
    await fs.mkdir(work, { recursive: true });
    const base = await fs.mkdtemp(path.join(work, 'search-compare-'));
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
    const calls = [];
    const desk = new GitDesk(repo, path.join(base, 'cache'), {
        async checkEditor() { calls.push('check'); },
        async beforeWorktreeChange() { calls.push('before'); },
        async afterWorktreeChange() { calls.push('after'); },
    });
    return { base, repo, desk, calls };
}

async function save(repo, name, text, message) {
    await fs.mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await fs.writeFile(path.join(repo, name), text);
    git(repo, 'add', '--', name); git(repo, 'commit', '-m', message);
    return git(repo, 'rev-parse', 'HEAD');
}

function treeCommit(repo, tree, message, parents = []) {
    return git(repo, 'commit-tree', tree, ...parents.flatMap(parent => ['-p', parent]), '-m', message);
}

async function fork(t) {
    const f = await fixture(t), common = git(f.repo, 'rev-parse', 'HEAD');
    const left = await save(f.repo, 'file.txt', 'left\n', 'left change');
    git(f.repo, 'switch', '-c', 'topic', common);
    const right = await save(f.repo, 'right.txt', 'right\n', 'right change');
    return { ...f, common, left, right };
}

function comparisonDiff(desk, comparison, name) {
    return desk.diff({ repo: '.', path: name, area: 'compare', baseRevision: comparison.effectiveBase, revision: comparison.target });
}

test('history searches literal case-insensitive text in message bodies and author name or email', async t => {
    const { repo, desk } = await fixture(t);
    git(repo, 'commit', '--allow-empty', '-m', 'literal A[1].* subject', '-m', 'body-only TOKEN(+)?');
    const literal = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'commit', '--allow-empty', '-m', 'regex decoy A1anything', '--author=Alice [Ops] <alice+git@example.invalid>');
    const alice = git(repo, 'rev-parse', 'HEAD');
    for (const text of ['a[1].*', 'token(+)?']) {
        const page = await desk.historyPage('.', { scope: 'current', search: { field: 'message', text } });
        assert.deepEqual(page.commits.map(c => c.sha), [literal]); assert.equal(page.filtered, true);
        assert.deepEqual(page.search, { field: 'message', text });
    }
    for (const text of ['ALICE [OPS]', 'ALICE+GIT@EXAMPLE.INVALID']) {
        const page = await desk.historyPage('.', { scope: 'current', search: { field: 'author', text } });
        assert.deepEqual(page.commits.map(c => c.sha), [alice]);
    }
    assert.deepEqual((await desk.historyPage('.', { scope: 'current', search: { field: 'message', text: 'absent' } })).commits, []);
});

test('filtered pagination applies search before its limit and freezes tips, labels and query conditions', async t => {
    const { repo, desk } = await fixture(t);
    const tree = git(repo, 'rev-parse', 'HEAD^{tree}'), matches = [];
    let head = git(repo, 'rev-parse', 'HEAD');
    for (let i = 0; i < 67; i++) {
        if (i % 10 === 0) head = treeCommit(repo, tree, 'unmatched ' + i, [head]);
        head = treeCommit(repo, tree, 'needle[+] ' + i, [head]); matches.push(head);
    }
    git(repo, 'update-ref', 'refs/heads/dev', head);
    const query = { scope: 'all', search: { field: 'message', text: 'needle[+]' } };
    const first = await desk.historyPage('.', query);
    assert.equal(first.commits.length, 60); assert.ok(first.cursor);
    first.search.text = 'mutated response';
    const newer = treeCommit(repo, tree, 'needle[+] new tip', [head]);
    git(repo, 'update-ref', 'refs/heads/dev', newer); git(repo, 'tag', 'after-query', matches[0]);
    const second = await desk.historyPage('.', { ...query, cursor: first.cursor });
    assert.deepEqual([...first.commits, ...second.commits].map(c => c.sha), matches.reverse());
    assert.equal(second.cursor, undefined); assert.doesNotMatch(second.commits.at(-1).refs, /after-query/);
    assert.deepEqual(await desk.historyPage('.', { ...query, cursor: first.cursor }), second);
    for (const changed of [
        { ...query, scope: 'current' },
        { ...query, search: { field: 'message', text: 'other' } },
        { ...query, search: { field: 'author', text: 'needle[+]' } },
        { ...query, path: 'file.txt' },
        { scope: 'all' },
    ]) await assert.rejects(desk.historyPage('.', { ...changed, cursor: first.cursor }));
    assert.equal((await desk.historyPage('.', query)).commits[0].sha, newer);
});

test('file history keeps colon, glob, Unicode and newline paths literal, including deletion, and combines filters with AND', { skip: exoticNames }, async t => {
    const { repo, desk } = await fixture(t, false), name = ':(glob)* 中文\nfile.txt';
    const added = await save(repo, name, 'one\n', 'needle add');
    await save(repo, 'other.txt', 'decoy\n', 'needle unrelated');
    const modified = await save(repo, name, 'two\n', 'unmatched change');
    git(repo, 'rm', '--', name); git(repo, 'commit', '-m', 'needle delete');
    const deleted = git(repo, 'rev-parse', 'HEAD');
    const page = await desk.historyPage('.', { scope: 'current', path: name });
    assert.deepEqual(page.commits.map(c => c.sha), [deleted, modified, added]);
    assert.equal(page.path, name); assert.equal(page.filtered, true);
    const combined = await desk.historyPage('.', { scope: 'all', path: name, search: { field: 'message', text: 'needle' } });
    assert.deepEqual(combined.commits.map(c => c.sha), [deleted, added]);
    assert.deepEqual((await desk.historyPage('.', { scope: 'all', path: 'missing.txt' })).commits, []);
});

test('directory history is precise and renamed files do not silently follow their old names', async t => {
    const { repo, desk } = await fixture(t);
    const beforeRename = await save(repo, 'assets/old.txt', 'one\n', 'old path');
    await save(repo, 'assets-sibling/unrelated.txt', 'decoy\n', 'outside directory');
    git(repo, 'mv', 'assets/old.txt', 'assets/new.txt'); git(repo, 'commit', '-m', 'rename');
    const renamed = git(repo, 'rev-parse', 'HEAD');
    const modified = await save(repo, 'assets/new.txt', 'two\n', 'new path');
    git(repo, 'config', 'log.follow', 'true');
    const file = await desk.historyPage('.', { scope: 'current', path: 'assets/new.txt' });
    assert.deepEqual(file.commits.map(c => c.sha), [modified, renamed]);
    const directory = await desk.historyPage('.', { scope: 'current', path: 'assets' });
    assert.deepEqual(directory.commits.map(c => c.sha), [modified, renamed, beforeRename]);
});

test('history rejects malformed fields and unsafe paths before issuing a query', async t => {
    const { desk } = await fixture(t);
    for (const query of [
        { scope: 'invalid' }, { scope: 'current', search: { field: 'committer', text: 'a' } },
        { scope: 'current', search: { field: 'message', text: 'a\0b' } },
        { scope: 'current', search: { field: 'message', text: 'a\nb' } },
        { scope: 'current', search: { field: 'message', text: 'x'.repeat(501) } },
        ...['../escape', '/outside.txt', '.git/config', 'assets/.git/config', 'bad\0path'].map(name => ({ scope: 'current', path: name })),
    ]) await assert.rejects(desk.historyPage('.', query));
});

test('direct and merge-base comparisons distinguish two snapshots from target-side changes', async t => {
    const { desk, common, left, right } = await fork(t);
    const direct = await desk.compare('.', { base: 'refs/heads/dev', target: 'refs/heads/topic', mode: 'direct' });
    assert.equal(direct.base, left); assert.equal(direct.target, right); assert.equal(direct.effectiveBase, left);
    assert.equal(direct.leftOnly, 1); assert.equal(direct.rightOnly, 1); assert.equal(direct.shallow, false);
    assert.deepEqual(direct.files.map(f => f.path).sort(), ['file.txt', 'right.txt']);
    const changed = await comparisonDiff(desk, direct, 'file.txt');
    assert.equal(changed.before.text, 'left\n'); assert.equal(changed.after.text, 'first\n'); assert.equal(changed.partial, undefined);
    const topic = await desk.compare('.', { base: 'refs/heads/dev', target: 'refs/heads/topic', mode: 'merge-base' });
    assert.equal(topic.effectiveBase, common); assert.equal(topic.base, left); assert.equal(topic.target, right);
    assert.deepEqual(topic.files.map(f => f.path), ['right.txt']); assert.equal(topic.leftOnly, 1); assert.equal(topic.rightOnly, 1);
    const added = await comparisonDiff(desk, topic, 'right.txt');
    assert.equal(added.before.text, ''); assert.equal(added.after.text, 'right\n');
});

test('comparison accepts explicit refs, annotated tags, HEAD and abbreviated commit hashes', async t => {
    const { repo, desk, left, right } = await fork(t);
    git(repo, 'update-ref', 'refs/remotes/origin/topic', right);
    git(repo, 'tag', '-a', 'v-left', '-m', 'left release', left);
    const tagged = await desk.compare('.', { base: 'refs/tags/v-left', target: 'refs/remotes/origin/topic', mode: 'direct' });
    assert.equal(tagged.base, left); assert.equal(tagged.target, right);
    assert.ok(tagged.baseLabel.includes('v-left')); assert.ok(tagged.targetLabel.includes('origin/topic'));
    const short = await desk.compare('.', { base: left.slice(0, 12), target: 'HEAD', mode: 'direct' });
    assert.equal(short.base, left); assert.equal(short.target, right);
});

test('resolved comparison stays on its original SHAs after refs move and leaves dirty index, worktree and refs unchanged', async t => {
    const { repo, desk, calls, left, right } = await fork(t);
    const comparison = await desk.compare('.', { base: 'refs/heads/dev', target: 'refs/heads/topic', mode: 'direct' });
    const newer = await save(repo, 'right.txt', 'new tip\n', 'move target');
    await fs.writeFile(path.join(repo, 'file.txt'), 'staged\n'); git(repo, 'add', 'file.txt');
    await fs.writeFile(path.join(repo, 'file.txt'), 'unstaged\n');
    await fs.writeFile(path.join(repo, 'untracked.txt'), 'keep\n');
    const before = {
        index: await fs.readFile(path.join(repo, '.git/index')),
        refs: git(repo, 'show-ref'), head: git(repo, 'rev-parse', 'HEAD'),
        status: git(repo, 'status', '--porcelain=v1', '-z'),
    };
    const diff = await comparisonDiff(desk, comparison, 'right.txt');
    assert.equal(diff.after.text, 'right\n'); assert.equal(comparison.base, left); assert.equal(comparison.target, right);
    const latest = await desk.compare('.', { base: left, target: 'HEAD', mode: 'direct' });
    assert.equal(latest.target, newer);
    await desk.historyPage('.', { scope: 'all', path: 'right.txt' });
    assert.deepEqual(await fs.readFile(path.join(repo, '.git/index')), before.index);
    assert.equal(git(repo, 'show-ref'), before.refs); assert.equal(git(repo, 'rev-parse', 'HEAD'), before.head);
    assert.equal(git(repo, 'status', '--porcelain=v1', '-z'), before.status);
    assert.equal(await fs.readFile(path.join(repo, 'file.txt'), 'utf8'), 'unstaged\n');
    assert.equal(await fs.readFile(path.join(repo, 'untracked.txt'), 'utf8'), 'keep\n'); assert.deepEqual(calls, []);
});

test('comparison rejects command options, arbitrary revision expressions, ambiguous short names and non-commit objects', async t => {
    const { repo, desk } = await fixture(t), head = git(repo, 'rev-parse', 'HEAD');
    for (const ref of ['--all', '-n1', 'dev', 'HEAD~1', 'HEAD:file.txt', 'HEAD^{tree}', 'dev..HEAD', 'refs/stash', 'HEAD\0other', 'refs/heads/missing', git(repo, 'rev-parse', 'HEAD^{tree}')]) {
        await assert.rejects(desk.compare('.', { base: ref, target: head, mode: 'direct' }), ref);
        await assert.rejects(desk.compare('.', { base: head, target: ref, mode: 'direct' }), ref);
    }
    await assert.rejects(desk.compare('.', { base: head, target: head, mode: 'invalid' }));
});

test('unrelated roots require direct comparison instead of inventing a merge base', async t => {
    const { repo, desk } = await fixture(t), head = git(repo, 'rev-parse', 'HEAD');
    const tree = git(repo, 'rev-parse', 'HEAD^{tree}'), island = treeCommit(repo, tree, 'independent root');
    await assert.rejects(desk.compare('.', { base: head, target: island, mode: 'merge-base' }), /共同祖先|直接/);
    const direct = await desk.compare('.', { base: head, target: island, mode: 'direct' });
    assert.deepEqual(direct.files, []); assert.equal(direct.leftOnly, 1); assert.equal(direct.rightOnly, 1);
});

test('criss-cross histories with multiple merge bases require an explicit direct comparison', async t => {
    const { repo, desk } = await fixture(t), root = git(repo, 'rev-parse', 'HEAD');
    const tree = git(repo, 'rev-parse', 'HEAD^{tree}');
    const left = treeCommit(repo, tree, 'left', [root]), right = treeCommit(repo, tree, 'right', [root]);
    const mergeLeft = treeCommit(repo, tree, 'merge left', [left, right]);
    const mergeRight = treeCommit(repo, tree, 'merge right', [right, left]);
    await assert.rejects(desk.compare('.', { base: mergeLeft, target: mergeRight, mode: 'merge-base' }), /共同祖先|直接/);
    const direct = await desk.compare('.', { base: mergeLeft, target: mergeRight, mode: 'direct' });
    assert.deepEqual(direct.files, []); assert.equal(direct.leftOnly, 1); assert.equal(direct.rightOnly, 1);
});

test('identical endpoints are empty and an unborn repository cannot resolve HEAD', async t => {
    const { repo, desk } = await fixture(t), head = git(repo, 'rev-parse', 'HEAD');
    for (const mode of ['direct', 'merge-base']) {
        const same = await desk.compare('.', { base: 'HEAD', target: head, mode });
        assert.deepEqual(same.files, []); assert.equal(same.effectiveBase, head);
        assert.equal(same.leftOnly, 0); assert.equal(same.rightOnly, 0);
    }
    const empty = await fixture(t, false);
    await assert.rejects(empty.desk.compare('.', { base: 'HEAD', target: 'HEAD', mode: 'direct' }));
});

test('comparison diff validates fixed hashes and membership, and handles literal added or deleted filenames', async t => {
    const { repo, desk } = await fixture(t), name = portableName(':(glob)* 中文\ncompare.txt');
    const base = git(repo, 'rev-parse', 'HEAD');
    const target = await save(repo, name, 'literal\n', 'add unusual path');
    const added = await desk.compare('.', { base, target, mode: 'direct' });
    assert.deepEqual(added.files.map(f => f.path), [name]);
    assert.equal((await comparisonDiff(desk, added, name)).after.text, 'literal\n');
    const removed = await desk.compare('.', { base: target, target: base, mode: 'direct' });
    const diff = await comparisonDiff(desk, removed, name);
    assert.equal(diff.before.text, 'literal\n'); assert.equal(diff.after.text, '');
    await assert.rejects(comparisonDiff(desk, added, 'file.txt'));
    for (const unsafe of ['../escape', '.git/config', '/outside.txt']) await assert.rejects(comparisonDiff(desk, added, unsafe));
    await assert.rejects(desk.diff({ repo: '.', path: name, area: 'compare', baseRevision: base, revision: 'HEAD' }));
    await assert.rejects(desk.diff({ repo: '.', path: name, area: 'compare', baseRevision: base.slice(0, 12), revision: target }));
});

test('comparison reports mode changes and submodule pointers without reading child working contents', async t => {
    const { repo, desk } = await fixture(t);
    git(repo, 'config', 'core.filemode', 'true');
    const root = git(repo, 'rev-parse', 'HEAD'), tree = git(repo, 'rev-parse', 'HEAD^{tree}');
    const childFirst = treeCommit(repo, tree, 'child first'), childSecond = treeCommit(repo, tree, 'child second', [childFirst]);
    git(repo, 'update-index', '--add', '--cacheinfo', `160000,${childFirst},modules/child`);
    git(repo, 'commit', '-m', 'first pointer'); const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-index', '--cacheinfo', `160000,${childSecond},modules/child`);
    git(repo, 'update-index', '--chmod=+x', 'file.txt'); git(repo, 'commit', '-m', 'mode and pointer');
    const target = git(repo, 'rev-parse', 'HEAD');
    const result = await desk.compare('.', { base, target, mode: 'direct' });
    assert.equal(result.files.find(f => f.path === 'modules/child').submodule, true);
    const pointer = await comparisonDiff(desk, result, 'modules/child');
    assert.ok(pointer.before.notice.includes(childFirst)); assert.ok(pointer.after.notice.includes(childSecond));
    assert.equal(pointer.partial, undefined);
    const mode = await comparisonDiff(desk, result, 'file.txt');
    assert.match(mode.summary, /100644/); assert.match(mode.summary, /100755/);
    assert.equal(mode.before.text, 'first\n'); assert.equal(mode.after.text, 'first\n');
    assert.notEqual(target, root);
});

test('comparison reuses image and local LFS previews while keeping partial staging unavailable', async t => {
    const { repo, desk } = await fixture(t);
    const imageBefore = Buffer.from('89504e470d0a1a0a', 'hex'), imageAfter = Buffer.concat([imageBefore, Buffer.from('changed')]);
    const lfsBefore = '[{"name":"before"}]\n', lfsAfter = '[{"name":"after"}]\n';
    const pointer = async text => {
        const data = Buffer.from(text), oid = createHash('sha256').update(data).digest('hex');
        const object = path.join(repo, '.git/lfs/objects', oid.slice(0, 2), oid.slice(2, 4), oid);
        await fs.mkdir(path.dirname(object), { recursive: true }); await fs.writeFile(object, data);
        return `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${data.length}\n`;
    };
    await fs.writeFile(path.join(repo, 'picture.png'), imageBefore);
    await fs.writeFile(path.join(repo, 'view.prefab'), await pointer(lfsBefore));
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'media before'); const base = git(repo, 'rev-parse', 'HEAD');
    await fs.writeFile(path.join(repo, 'picture.png'), imageAfter);
    await fs.writeFile(path.join(repo, 'view.prefab'), await pointer(lfsAfter));
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'media after'); const target = git(repo, 'rev-parse', 'HEAD');
    const result = await desk.compare('.', { base, target, mode: 'direct' });
    const image = await comparisonDiff(desk, result, 'picture.png');
    assert.equal(image.before.image, 'data:image/png;base64,' + imageBefore.toString('base64'));
    assert.equal(image.after.image, 'data:image/png;base64,' + imageAfter.toString('base64')); assert.equal(image.partial, undefined);
    const lfs = await comparisonDiff(desk, result, 'view.prefab');
    assert.equal(lfs.before.lfs, true); assert.equal(lfs.after.lfs, true);
    assert.equal(lfs.before.text, lfsBefore); assert.equal(lfs.after.text, lfsAfter); assert.equal(lfs.partial, undefined);
});

test('oversized comparison blobs show a limit notice instead of empty text or broken images', async t => {
    const { repo, desk } = await fixture(t), names = ['large.txt', 'large.png'];
    for (const name of names) await fs.writeFile(path.join(repo, name), Buffer.alloc(5 * 1024 * 1024 + 1, 'a'));
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'large before'); const base = git(repo, 'rev-parse', 'HEAD');
    for (const name of names) await fs.writeFile(path.join(repo, name), Buffer.alloc(5 * 1024 * 1024 + 2, 'b'));
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'large after'); const target = git(repo, 'rev-parse', 'HEAD');
    const result = await desk.compare('.', { base, target, mode: 'direct' });
    for (const name of names) {
        const diff = await comparisonDiff(desk, result, name);
        for (const side of [diff.before, diff.after]) {
            assert.match(side.notice, /5 MiB/); assert.equal(side.text, undefined); assert.equal(side.image, undefined);
        }
        assert.equal(diff.patch, ''); assert.ok(diff.summary.includes(base.slice(0, 12))); assert.ok(diff.summary.includes(target.slice(0, 12)));
    }
});

test('symbolic links with image suffixes display link text without following the working target', async t => {
    const { repo, desk } = await fixture(t);
    await fs.symlink('file.txt', path.join(repo, 'link.png'));
    git(repo, 'add', 'link.png'); git(repo, 'commit', '-m', 'link before'); const base = git(repo, 'rev-parse', 'HEAD');
    await fs.unlink(path.join(repo, 'link.png')); await fs.symlink('missing-target.txt', path.join(repo, 'link.png'));
    git(repo, 'add', 'link.png'); git(repo, 'commit', '-m', 'link after'); const target = git(repo, 'rev-parse', 'HEAD');
    const result = await desk.compare('.', { base, target, mode: 'direct' });
    const diff = await comparisonDiff(desk, result, 'link.png');
    assert.equal(diff.before.text, 'file.txt'); assert.equal(diff.after.text, 'missing-target.txt');
    assert.equal(diff.before.image, undefined); assert.equal(diff.after.image, undefined); assert.match(diff.summary, /符号链接/);
});

test('configured partial clones are blocked before status or object reads, while false promisor values remain supported', async t => {
    const { repo, desk } = await fixture(t);
    const query = { base: 'HEAD', target: 'HEAD', mode: 'direct' };
    git(repo, 'config', 'remote.origin.promisor', 'true');
    assert.match((await desk.snapshot(true)).repositories[0].error, /Partial clone/);
    await assert.rejects(desk.details('.'), /Partial clone/);
    await assert.rejects(desk.historyPage('.', { scope: 'current' }), /Partial clone/);
    await assert.rejects(desk.compare('.', query), /Partial clone/);
    git(repo, 'config', 'remote.origin.promisor', 'false');
    assert.equal((await desk.snapshot(true)).repositories[0].error, undefined);
    assert.deepEqual((await desk.compare('.', query)).files, []);
    git(repo, 'config', 'extensions.partialClone', 'origin');
    assert.match((await desk.snapshot(true)).repositories[0].error, /Partial clone/);
});
