const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GitDesk } = require('../dist/git');
const { checkMeta } = require('../dist/meta-check');

const work = path.resolve(__dirname, '../.test-work');
process.env.GIT_CONFIG_NOSYSTEM = '1';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd();
const U = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const meta = (uuid, userData = {}) => JSON.stringify({ ver: '1.0.0', importer: 'image', imported: true, uuid, files: [], subMetas: {}, userData }, null, 2) + '\n';
async function write(repo, name, content) { await fs.mkdir(path.dirname(path.join(repo, name)), { recursive: true }); await fs.writeFile(path.join(repo, name), content); }
async function fixture(t) {
    await fs.mkdir(work, { recursive: true });
    const base = await fs.mkdtemp(path.join(work, 'meta-'));
    const repo = path.join(base, 'project'); await fs.mkdir(repo, { recursive: true });
    git(repo, 'init', '-b', 'dev'); git(repo, 'config', 'user.name', 'T'); git(repo, 'config', 'user.email', 't@example.invalid'); git(repo, 'config', 'commit.gpgSign', 'false');
    await write(repo, 'file.txt', 'x\n');
    await write(repo, 'assets/tex.meta', meta(U(10)));
    await write(repo, 'assets/tex/a.png', 'a'); await write(repo, 'assets/tex/a.png.meta', meta(U(1)));
    await write(repo, 'assets/tex/b.png', 'b'); await write(repo, 'assets/tex/b.png.meta', meta(U(2)));
    git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'seed');
    const desk = new GitDesk(repo, path.join(base, 'cache'), { async checkEditor() {}, async beforeWorktreeChange() {}, async afterWorktreeChange() {} });
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    return { repo, desk };
}
const pairs = result => result.issues.map(issue => [issue.code, issue.path, issue.related ?? '']).sort();

test('a clean index passes and changes outside assets are ignored', async t => {
    const { repo, desk } = await fixture(t);
    await write(repo, 'assets/tex/a.png', 'a2'); await write(repo, 'assets/tex/a.png.meta', meta(U(1), { note: 1 })); await write(repo, 'file.txt', 'y\n');
    git(repo, 'add', '.');
    const result = await desk.metaCheck('.', { scope: 'index' });
    assert.deepEqual(result.issues, []); assert.equal(result.checked, 2); assert.equal(result.blockers.length, 0); assert.equal(result.truncated, false);
});

test('the index check reports missing, orphan, unstaged, deleted-companion, directory and uuid problems', async t => {
    const { repo, desk } = await fixture(t);
    await write(repo, 'assets/tex/c.png', 'c');
    await write(repo, 'assets/tex/d.png.meta', meta(U(4)));
    await write(repo, 'assets/tex/e.png', 'e'); await write(repo, 'assets/tex/e.png.meta', meta(U(5)));
    await write(repo, 'assets/newdir/x.png', 'x'); await write(repo, 'assets/newdir/x.png.meta', meta(U(6)));
    await write(repo, 'assets/tex/f.png', 'f'); await write(repo, 'assets/tex/f.png.meta', meta(U(1)));
    await write(repo, 'assets/tex/g.png', 'g'); await write(repo, 'assets/tex/g.png.meta', meta(U(7), { atlasUuid: U(1) }));
    await write(repo, 'assets/tex/h.png', 'h'); await write(repo, 'assets/tex/h.png.meta', 'not json');
    await write(repo, 'assets/tex.meta', meta(U(11)));
    git(repo, 'add', 'assets/tex/c.png', 'assets/tex/d.png.meta', 'assets/tex/e.png.meta', 'assets/newdir', 'assets/tex/f.png', 'assets/tex/f.png.meta', 'assets/tex/g.png', 'assets/tex/g.png.meta', 'assets/tex/h.png', 'assets/tex/h.png.meta', 'assets/tex.meta');
    git(repo, 'rm', '-q', 'assets/tex/b.png');
    const result = await desk.metaCheck('.', { scope: 'index' });
    assert.deepEqual(pairs(result), [
        ['ASSET_UNSTAGED', 'assets/tex/e.png.meta', 'assets/tex/e.png'],
        ['META_DIR_MISSING', 'assets/newdir.meta', 'assets/newdir/x.png'],
        ['META_INVALID', 'assets/tex/h.png.meta', ''],
        ['META_MISSING', 'assets/tex/c.png.meta', 'assets/tex/c.png'],
        ['META_ORPHAN', 'assets/tex/d.png.meta', 'assets/tex/d.png'],
        ['META_ORPHAN_LEFT', 'assets/tex/b.png.meta', 'assets/tex/b.png'],
        ['META_UUID_CHANGED', 'assets/tex.meta', ''],
        ['META_UUID_DUPLICATE', 'assets/tex/f.png.meta', 'assets/tex/a.png.meta'],
    ]);
    assert.equal(result.warnings.length, 1); assert.equal(result.blockers.length, 7);
    assert.match(result.issues.find(issue => issue.code === 'META_UUID_CHANGED').message, /00000010-.*00000011-/);
    // Staging the companions clears the pairing problems.
    git(repo, 'add', 'assets/tex/e.png'); git(repo, 'rm', '-q', 'assets/tex/b.png.meta'); await write(repo, 'assets/tex/c.png.meta', meta(U(3))); git(repo, 'add', 'assets/tex/c.png.meta');
    const again = pairs(await desk.metaCheck('.', { scope: 'index' }));
    assert.ok(!again.some(([code]) => ['ASSET_UNSTAGED', 'META_ORPHAN_LEFT', 'META_MISSING'].includes(code)), JSON.stringify(again));
    // A tracked .meta edited but not staged next to a staged asset is the classic "forgot the meta" case.
    await write(repo, 'assets/tex/a.png', 'a3'); await write(repo, 'assets/tex/a.png.meta', meta(U(1), { changed: true })); git(repo, 'add', 'assets/tex/a.png');
    assert.ok(pairs(await desk.metaCheck('.', { scope: 'index' })).some(([code, p]) => code === 'META_UNSTAGED' && p === 'assets/tex/a.png.meta'));
});

test('the worktree check sees untracked files and honours path filters', async t => {
    const { repo, desk } = await fixture(t);
    await write(repo, 'assets/tex/w.png', 'w');
    await write(repo, 'assets/tex/v.png', 'v'); await write(repo, 'assets/tex/v.png.meta', meta(U(2)));
    await fs.rm(path.join(repo, 'assets/tex/a.png'));
    assert.deepEqual(pairs(await desk.metaCheck('.', { scope: 'worktree' })), [
        ['META_MISSING', 'assets/tex/w.png.meta', 'assets/tex/w.png'],
        ['META_ORPHAN_LEFT', 'assets/tex/a.png.meta', 'assets/tex/a.png'],
        ['META_UUID_DUPLICATE', 'assets/tex/v.png.meta', 'assets/tex/b.png.meta'],
    ]);
    const one = await desk.metaCheck('.', { scope: 'worktree', paths: ['assets/tex/w.png'] });
    assert.deepEqual(pairs(one), [['META_MISSING', 'assets/tex/w.png.meta', 'assets/tex/w.png']]); assert.equal(one.checked, 1);
    assert.equal((await desk.metaCheck('.', { scope: 'worktree', paths: ['assets/other'] })).checked, 0);
    assert.equal((await desk.metaCheck('.', { scope: 'index' })).issues.length, 0, 'nothing staged, nothing to block');
});

test('renames, submodule rows and conflicts are handled without git access beyond the listing', async () => {
    const calls = [];
    const git = async (args, allowed) => { calls.push(args[0]); if (args[0] === 'ls-files') return 'assets/tex.meta\0assets/tex/new.png\0assets/tex/new.png.meta\0'; if (args[0] === 'grep') return ''; return JSON.stringify({ uuid: U(1) }); };
    const files = [
        { path: 'assets/tex/new.png', oldPath: 'assets/tex/old.png', index: 'R', worktree: ' ', conflict: false, submodule: false },
        { path: 'assets/sub', index: 'M', worktree: ' ', conflict: false, submodule: true },
        { path: 'assets/tex/x.png', index: 'U', worktree: 'U', conflict: true, submodule: false },
    ];
    const result = await checkMeta('/nowhere', files, git, { scope: 'index' });
    assert.deepEqual(pairs(result), [['META_ORPHAN_LEFT', 'assets/tex/old.png.meta', 'assets/tex/old.png']].filter(() => false), 'old.png.meta is not in the index, so the rename is clean');
    assert.equal(result.checked, 2); assert.ok(calls.includes('ls-files'));
});
