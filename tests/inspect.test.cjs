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
process.env.GIT_CONFIG_GLOBAL = path.join(work, 'inspect-no-global-config');
function gitWith(cwd, env, ...args) {
    return execFileSync('git', ['--literal-pathspecs', ...args], {
        cwd, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    }).trimEnd();
}
const git = (cwd, ...args) => gitWith(cwd, {}, ...args);

async function fixture(t, seed = true) {
    await fs.mkdir(work, { recursive: true });
    const base = await fs.mkdtemp(path.join(work, 'inspect-'));
    t.after(async () => { await fs.rm(base, { recursive: true, force: true }); });
    const repo = path.join(base, 'project'); await fs.mkdir(repo);
    git(repo, 'init', '-b', 'dev');
    git(repo, 'config', 'user.name', 'Git Desk Test'); git(repo, 'config', 'user.email', 'git-desk@example.invalid');
    git(repo, 'config', 'commit.gpgSign', 'false'); git(repo, 'config', 'core.hooksPath', path.join(base, 'no-hooks'));
    git(repo, 'config', 'core.autocrlf', 'false');
    if (seed) { await fs.writeFile(path.join(repo, 'file.txt'), 'first\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'initial'); }
    const calls = [];
    const desk = new GitDesk(repo, path.join(base, 'cache'), {
        async checkEditor() { calls.push('check'); }, async beforeWorktreeChange() { calls.push('before'); }, async afterWorktreeChange() { calls.push('after'); },
    });
    return { base, repo, desk, calls };
}

async function save(repo, name, text, message) {
    await fs.mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await fs.writeFile(path.join(repo, name), text);
    git(repo, 'add', '--', name); git(repo, 'commit', '-m', message);
    return git(repo, 'rev-parse', 'HEAD');
}

test('commit inspection returns full Unicode message and independent author and committer identities', async t => {
    const { repo, desk } = await fixture(t), parent = git(repo, 'rev-parse', 'HEAD');
    gitWith(repo, {
        GIT_AUTHOR_NAME: '作者 UI', GIT_AUTHOR_EMAIL: 'author+desk@example.invalid', GIT_AUTHOR_DATE: '2024-01-02T03:04:05+08:00',
        GIT_COMMITTER_NAME: 'Build Bot', GIT_COMMITTER_EMAIL: 'bot@example.invalid', GIT_COMMITTER_DATE: '2024-02-03T04:05:06-07:00',
    }, 'commit', '--allow-empty', '-m', '中文 subject [1]', '-m', 'first paragraph\n\nsecond <script> & paragraph');
    const sha = git(repo, 'rev-parse', 'HEAD'), detail = await desk.commitDetails('.', sha);
    assert.equal(detail.sha, sha); assert.equal(detail.subject, '中文 subject [1]');
    assert.match(detail.message, /^中文 subject \[1\]\n\nfirst paragraph\n\nsecond <script> & paragraph\n?$/);
    assert.deepEqual(detail.parents, [parent]); assert.equal(detail.shallow, false);
    assert.equal(detail.author.name, '作者 UI'); assert.equal(detail.author.email, 'author+desk@example.invalid');
    assert.equal(Date.parse(detail.author.date), Date.parse('2024-01-02T03:04:05+08:00'));
    assert.equal(detail.committer.name, 'Build Bot'); assert.equal(detail.committer.email, 'bot@example.invalid');
    assert.equal(Date.parse(detail.committer.date), Date.parse('2024-02-03T04:05:06-07:00'));
    assert.deepEqual((await desk.commitDetails('.', parent)).parents, []);
});

test('commit inspection preserves all merge parents and does not accept refs, expressions or noncommits', async t => {
    const { repo, desk } = await fixture(t), root = git(repo, 'rev-parse', 'HEAD'), tree = git(repo, 'rev-parse', 'HEAD^{tree}');
    const left = git(repo, 'commit-tree', tree, '-p', root, '-m', 'left'), right = git(repo, 'commit-tree', tree, '-p', root, '-m', 'right');
    const merge = git(repo, 'commit-tree', tree, '-p', left, '-p', right, '-m', 'merge');
    assert.deepEqual((await desk.commitDetails('.', merge)).parents, [left, right]);
    const blob = git(repo, 'rev-parse', 'HEAD:file.txt');
    for (const invalid of ['HEAD', 'refs/heads/dev', root.slice(0, 12), `${root}^`, '--all', '', 'g'.repeat(40), 'a'.repeat(41), blob, tree, 'f'.repeat(40)]) {
        await assert.rejects(desk.commitDetails('.', invalid));
    }
});

test('inspection reads frozen commits while preserving dirty index, worktree, refs and editor state', async t => {
    const { repo, desk, calls } = await fixture(t), frozen = git(repo, 'rev-parse', 'HEAD');
    await save(repo, 'file.txt', 'second\n', 'new tip');
    await fs.writeFile(path.join(repo, 'file.txt'), 'staged\n'); git(repo, 'add', '--', 'file.txt');
    await fs.writeFile(path.join(repo, 'file.txt'), 'working\n'); await fs.writeFile(path.join(repo, 'untracked.txt'), 'untracked\n');
    await fs.writeFile(path.join(repo, '.mailmap'), 'Mapped Person <mapped@example.invalid> <git-desk@example.invalid>\n');
    const index = await fs.readFile(path.join(repo, '.git/index')), refs = git(repo, 'show-ref'), status = git(repo, 'status', '--porcelain=v1');
    const detail = await desk.commitDetails('.', frozen);
    assert.equal(detail.subject, 'initial'); assert.equal(detail.author.name, 'Git Desk Test');
    const blame = await desk.blame('.', { revision: frozen, path: 'file.txt' });
    assert.equal(blame.revision, frozen); assert.deepEqual(blame.lines.map(line => line.text), ['first']);
    assert.equal(blame.lines[0].author, 'Git Desk Test'); assert.equal(blame.lines[0].email, 'git-desk@example.invalid');
    assert.ok((await fs.readFile(path.join(repo, '.git/index'))).equals(index));
    assert.equal(await fs.readFile(path.join(repo, 'file.txt'), 'utf8'), 'working\n');
    assert.equal(await fs.readFile(path.join(repo, 'untracked.txt'), 'utf8'), 'untracked\n');
    assert.equal(git(repo, 'show-ref'), refs); assert.equal(git(repo, 'status', '--porcelain=v1'), status); assert.deepEqual(calls, []);
});

test('inspection ignores replacement refs and reports the requested commit object contents', async t => {
    const { repo, desk } = await fixture(t), frozen = git(repo, 'rev-parse', 'HEAD');
    const replacement = await save(repo, 'file.txt', 'replacement contents\n', 'replacement commit');
    git(repo, 'replace', frozen, replacement);
    const detail = await desk.commitDetails('.', frozen), page = await desk.blame('.', { revision: frozen, path: 'file.txt' });
    assert.equal(detail.sha, frozen); assert.equal(detail.subject, 'initial'); assert.deepEqual(detail.parents, []);
    assert.deepEqual(page.lines.map(line => line.text), ['first']); assert.equal(page.lines[0].sha, frozen);
    const files = await desk.commitFiles('.', frozen);
    assert.deepEqual(files.map(file => [file.path, file.index]), [['file.txt', 'A']]);
    const diff = await desk.diff({ repo: '.', area: 'commit', revision: frozen, path: 'file.txt' });
    assert.equal(diff.before.text, ''); assert.equal(diff.after.text, 'first\n');
    const history = await desk.historyPage('.', { scope: 'current' });
    assert.deepEqual(history.commits.map(commit => [commit.sha, commit.subject, commit.parents]), [[replacement, 'replacement commit', [frozen]], [frozen, 'initial', []]]);
    const comparison = await desk.compare('.', { base: frozen, target: replacement, mode: 'direct' });
    assert.equal(comparison.base, frozen); assert.equal(comparison.target, replacement); assert.equal(comparison.effectiveBase, frozen);
    assert.equal(comparison.leftOnly, 0); assert.equal(comparison.rightOnly, 1);
    assert.deepEqual(comparison.files.map(file => [file.path, file.index]), [['file.txt', 'M']]);
    const compared = await desk.diff({ repo: '.', area: 'compare', baseRevision: comparison.effectiveBase, revision: comparison.target, path: 'file.txt' });
    assert.equal(compared.before.text, 'first\n'); assert.equal(compared.after.text, 'replacement contents\n');
    assert.equal(git(repo, 'rev-parse', `refs/replace/${frozen}`), replacement);
});

test('inspection ignores inherited graft and shallow file overrides and restores the caller environment', async t => {
    const { base, repo, desk } = await fixture(t), original = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'commit', '--allow-empty', '-m', 'second commit');
    const revision = git(repo, 'rev-parse', 'HEAD'), graftFile = path.join(base, 'external-grafts'), shallowFile = path.join(base, 'external-shallow');
    await fs.writeFile(graftFile, revision + '\n'); await fs.writeFile(shallowFile, revision + '\n');
    const saved = { GIT_GRAFT_FILE: process.env.GIT_GRAFT_FILE, GIT_SHALLOW_FILE: process.env.GIT_SHALLOW_FILE };
    try {
        for (const overrides of [{ GIT_GRAFT_FILE: graftFile }, { GIT_SHALLOW_FILE: shallowFile }, { GIT_GRAFT_FILE: graftFile, GIT_SHALLOW_FILE: shallowFile }]) {
            delete process.env.GIT_GRAFT_FILE; delete process.env.GIT_SHALLOW_FILE;
            Object.assign(process.env, overrides);
            const detail = await desk.commitDetails('.', revision), page = await desk.blame('.', { revision, path: 'file.txt' });
            assert.equal(detail.shallow, false); assert.deepEqual(detail.parents, [original]);
            assert.equal(page.shallow, false); assert.deepEqual(page.lines.map(line => [line.sha, line.text]), [[original, 'first']]);
        }
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
    assert.equal(await fs.readFile(graftFile, 'utf8'), revision + '\n');
    assert.equal(await fs.readFile(shallowFile, 'utf8'), revision + '\n');
    await assert.rejects(fs.stat(path.join(repo, '.git/shallow')), { code: 'ENOENT' });
});

test('blame keeps CRLF, blank lines, tabs and unterminated final lines with their commit origins', async t => {
    const { repo, desk } = await fixture(t, false), name = portableName(':(glob)* 中文\nfile.txt');
    const original = await save(repo, name, 'first\r\n\r\n\tthird\r\ntail', 'original text');
    const revision = await save(repo, name, 'changed\r\n\r\n\tthird\r\ntail', 'one line changed');
    const page = await desk.blame('.', { revision, path: name });
    assert.equal(page.totalLines, 4); assert.equal(page.start, 1); assert.equal(page.nextStart, undefined);
    assert.deepEqual(page.lines.map(line => line.text), ['changed\r', '\r', '\tthird\r', 'tail']);
    assert.deepEqual(page.lines.map(line => line.sha), [revision, original, original, original]);
    assert.deepEqual(page.lines.map(line => line.line), [1, 2, 3, 4]); assert.ok(page.lines.every(line => line.originalPath === name));
});

test('blame paginates 200 lines from a fixed SHA across branch moves and carries its boundary token', async t => {
    const { repo, desk } = await fixture(t);
    const text = Array.from({ length: 407 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const revision = await save(repo, 'long.txt', text, 'long file');
    const first = await desk.blame('.', { revision, path: 'long.txt' });
    assert.equal(first.totalLines, 407); assert.equal(first.lines.length, 200); assert.equal(first.nextStart, 201); assert.equal(typeof first.boundary, 'string');
    await save(repo, 'long.txt', 'new snapshot\n', 'branch moved');
    const second = await desk.blame('.', { revision, path: 'long.txt', start: first.nextStart, boundary: first.boundary });
    const third = await desk.blame('.', { revision, path: 'long.txt', start: second.nextStart, boundary: second.boundary });
    assert.equal(second.lines.length, 200); assert.equal(second.nextStart, 401); assert.equal(third.lines.length, 7); assert.equal(third.nextStart, undefined);
    assert.deepEqual([...first.lines, ...second.lines, ...third.lines].map(line => line.text), text.trimEnd().split('\n'));
    assert.ok(third.lines.every(line => line.sha === revision));
});

test('blame follows whole-file renames while reporting the actual historical path', async t => {
    const { repo, desk } = await fixture(t), oldPath = portableName('old "中文"\nfile.txt'), newPath = 'new file.txt';
    const original = await save(repo, oldPath, 'keep one\nkeep two\n', 'original file');
    git(repo, 'mv', '--', oldPath, newPath); git(repo, 'commit', '-m', 'rename only');
    const revision = git(repo, 'rev-parse', 'HEAD'), page = await desk.blame('.', { revision, path: newPath });
    assert.equal(page.path, newPath); assert.ok(page.lines.every(line => line.sha === original && line.originalPath === oldPath));
    assert.deepEqual(page.lines.map(line => line.originalLine), [1, 2]);
});

test('blame ignores configured revision exclusions, keeps boundary IDs and never invokes textconv', async t => {
    const { base, repo, desk } = await fixture(t);
    const original = git(repo, 'rev-parse', 'HEAD');
    await fs.writeFile(path.join(repo, '.gitattributes'), 'file.txt diff=inspect\n'); git(repo, 'add', '.gitattributes'); git(repo, 'commit', '-m', 'attributes');
    const revision = git(repo, 'rev-parse', 'HEAD'), marker = path.join(base, 'textconv-ran');
    git(repo, 'config', 'blame.ignoreRevsFile', path.join(base, 'missing-ignore-revs'));
    git(repo, 'config', 'blame.blankBoundary', 'true');
    git(repo, 'config', 'diff.inspect.textconv', `touch '${marker}'`);
    const page = await desk.blame('.', { revision, path: 'file.txt' });
    assert.equal(page.lines[0].sha, original); assert.equal(page.lines[0].boundary, true);
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('blame gives explicit notices for resources and paths that have no supported text line history', async t => {
    const { repo, desk } = await fixture(t), gitlink = git(repo, 'rev-parse', 'HEAD');
    const files = new Map([
        ['empty.txt', ''], ['binary.bin', Buffer.from([0, 1, 2, 3])], ['invalid.txt', Buffer.from([0xff, 0xfe, 0x61])],
        ['resource.png', 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 100\n'],
        ['folder/nested.txt', 'nested\n'],
    ]);
    for (const [name, content] of files) { await fs.mkdir(path.dirname(path.join(repo, name)), { recursive: true }); await fs.writeFile(path.join(repo, name), content); }
    await fs.symlink('file.txt', path.join(repo, 'link.txt'));
    git(repo, 'add', '.'); git(repo, 'update-index', '--add', '--cacheinfo', `160000,${gitlink},submodule`); git(repo, 'commit', '-m', 'resources');
    const revision = git(repo, 'rev-parse', 'HEAD');
    for (const name of ['empty.txt', 'binary.bin', 'invalid.txt', 'resource.png', 'link.txt', 'submodule', 'folder', 'missing.txt']) {
        const page = await desk.blame('.', { revision, path: name });
        assert.deepEqual(page.lines, [], name); assert.equal(typeof page.notice, 'string', name); assert.ok(page.notice.length > 0, name); assert.equal(page.nextStart, undefined);
    }
});

test('blame stops at byte and line limits without returning misleading partial contents', async t => {
    const { repo, desk } = await fixture(t);
    await fs.writeFile(path.join(repo, 'large.txt'), Buffer.alloc(5 * 1024 * 1024 + 1, 97));
    await fs.writeFile(path.join(repo, 'many.txt'), 'x\n'.repeat(15001));
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'too large');
    const revision = git(repo, 'rev-parse', 'HEAD');
    for (const name of ['large.txt', 'many.txt']) {
        const page = await desk.blame('.', { revision, path: name });
        assert.deepEqual(page.lines, []); assert.ok(page.notice); assert.equal(page.nextStart, undefined);
    }
});

test('blame rejects unsafe paths, nonfixed revisions and invalid pagination inputs', async t => {
    const { repo, desk } = await fixture(t), revision = git(repo, 'rev-parse', 'HEAD');
    for (const patch of [
        { path: '../file.txt' }, { path: '/tmp/file.txt' }, { path: '.git/config' }, { path: 'a\0b' }, { path: '' },
        { revision: 'HEAD' }, { revision: revision.slice(0, 12) }, { revision: `${revision}^` }, { revision: 'a'.repeat(41) },
        { start: 0 }, { start: -1 }, { start: 1.5 }, { start: '1' }, { start: Number.MAX_SAFE_INTEGER + 1 },
        { boundary: 42 }, { boundary: 'invalid-boundary' },
    ]) await assert.rejects(desk.blame('.', { revision, path: 'file.txt', ...patch }));
});

test('blame reports shallow roots and rejects continuation after the shallow boundary changes', async t => {
    const { repo, desk } = await fixture(t);
    const revision = await save(repo, 'long.txt', 'line\n'.repeat(205), 'shallow tip');
    await fs.writeFile(path.join(repo, '.git/shallow'), revision + '\n');
    const first = await desk.blame('.', { revision, path: 'long.txt' });
    assert.equal(first.shallow, true); assert.equal(first.nextStart, 201); assert.ok(first.lines.every(line => line.sha === revision && line.boundary));
    const detail = await desk.commitDetails('.', revision);
    assert.equal(detail.shallow, true); assert.equal(detail.parents.length, 1);
    await assert.rejects(desk.commitFiles('.', revision), /父提交|浅克隆|不可用/);
    await assert.rejects(desk.diff({ repo: '.', area: 'commit', revision, path: 'long.txt' }), /父提交|浅克隆|不可用/);
    await fs.rm(path.join(repo, '.git/shallow'));
    await assert.rejects(desk.blame('.', { revision, path: 'long.txt', start: first.nextStart, boundary: first.boundary }), /边界|浅克隆|变化|失效/);
    assert.equal((await desk.blame('.', { revision, path: 'long.txt' })).shallow, false);
});
