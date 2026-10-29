const { test } = require('node:test');
const { windows, portableName, exoticNames, posixModes, linkTarget } = require('./platform.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DraftStore } = require('../dist/drafts');

const work = path.resolve(__dirname, '../.test-work');
async function fixture(t) {
    await fs.mkdir(work, { recursive: true });
    const base = await fs.mkdtemp(path.join(work, 'drafts-'));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const repo = path.join(base, 'project'), cache = path.join(base, 'cache');
    await fs.mkdir(repo);
    const key = createHash('sha256').update(await fs.realpath(repo)).digest('hex');
    const filename = path.join(cache, 'drafts', key + '.json');
    return { base, repo, cache, filename, store: new DraftStore(cache) };
}
async function seed(f, message = 'first draft') {
    return f.store.save(f.repo, message, (await f.store.read(f.repo)).version);
}

test('draft read is stable and does not create cache directories or touch the repository', async t => {
    const f = await fixture(t);
    const first = await f.store.read(f.repo);
    assert.deepEqual(first, await new DraftStore(f.cache).read(f.repo));
    assert.equal(first.message, ''); assert.match(first.version, /^[a-f0-9]{64}$/);
    await assert.rejects(fs.stat(f.cache), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(f.repo), []);
});

test('drafts persist across stores with restrictive permissions and canonical repository identity', async t => {
    const f = await fixture(t), saved = await seed(f, '保存中文\n\n正文 😀\n');
    assert.deepEqual(await new DraftStore(f.cache).read(f.repo), saved);
    if (posixModes) assert.equal((await fs.stat(f.filename)).mode & 0o777, 0o600);
    const alias = path.join(f.base, 'alias'); await fs.symlink(f.repo, alias, 'dir');
    assert.deepEqual(await f.store.read(alias), saved);
    const other = path.join(f.base, 'other'); await fs.mkdir(other);
    assert.equal((await f.store.read(other)).message, '');
    assert.notEqual((await f.store.read(other)).version, (await f.store.read(f.repo)).version);
    assert.deepEqual(await fs.readdir(f.repo), []);
});

test('stale draft versions cannot overwrite another window or a cleared draft', async t => {
    const f = await fixture(t), initial = await f.store.read(f.repo);
    const first = await seed(f), second = await f.store.save(f.repo, 'second draft', first.version);
    await assert.rejects(f.store.save(f.repo, 'stale content', first.version), /其他窗口/);
    const cleared = await f.store.save(f.repo, '', second.version);
    assert.equal(cleared.message, ''); assert.notEqual(cleared.version, initial.version);
    await assert.rejects(f.store.save(f.repo, 'old window', initial.version), /其他窗口/);
    assert.deepEqual(await f.store.read(f.repo), cleared);
});

test('two independent stores sharing a version cannot both overwrite the draft', async t => {
    const f = await fixture(t), initial = await f.store.read(f.repo);
    const results = await Promise.allSettled([
        f.store.save(f.repo, 'window one', initial.version),
        new DraftStore(f.cache).save(f.repo, 'window two', initial.version),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    const winner = results.find(result => result.status === 'fulfilled').value;
    assert.deepEqual(await f.store.read(f.repo), winner);
    assert.deepEqual(await fs.readdir(path.dirname(f.filename)), [path.basename(f.filename)]);
});

test('draft limits use JS character length and reject NUL or invalid versions without changing saved bytes', async t => {
    const f = await fixture(t), saved = await seed(f, '😀'.repeat(2500));
    assert.equal(saved.message.length, 5000);
    const bytes = await fs.readFile(f.filename);
    for (const message of ['a'.repeat(5001), 'bad\0text', 123, null]) await assert.rejects(f.store.save(f.repo, message, saved.version), /草稿/);
    for (const version of ['', 'a'.repeat(63), 'g'.repeat(64), null]) await assert.rejects(f.store.save(f.repo, 'valid', version), /版本/);
    assert.deepEqual(await fs.readFile(f.filename), bytes);
});

test('empty and whitespace drafts round trip without trimming and identical saves keep the version', async t => {
    const f = await fixture(t), first = await seed(f, '  subject\n\n body\t\n');
    assert.deepEqual(await f.store.save(f.repo, first.message, first.version), first);
    const cleared = await f.store.save(f.repo, '', first.version);
    assert.deepEqual(await new DraftStore(f.cache).read(f.repo), cleared);
    assert.deepEqual(await f.store.save(f.repo, '', cleared.version), cleared);
});

test('damaged, oversized, foreign and invalidly encoded draft files are preserved rather than repaired', async t => {
    const f = await fixture(t), saved = await seed(f), original = JSON.parse(await fs.readFile(f.filename, 'utf8'));
    const badRecords = [
        '{', Buffer.alloc(65537, 32), Buffer.from([0xff]),
        JSON.stringify({ ...original, schema: 2 }), JSON.stringify({ ...original, repo: f.base }),
        JSON.stringify({ ...original, message: 'bad\0text' }), JSON.stringify({ ...original, extra: true }),
        JSON.stringify({ ...original, updatedAt: 'invalid' }), JSON.stringify({ ...original, message: 'x'.repeat(5001) }),
    ];
    for (const value of badRecords) {
        await fs.writeFile(f.filename, value);
        const before = await fs.readFile(f.filename);
        await assert.rejects(f.store.read(f.repo), /草稿/);
        await assert.rejects(f.store.save(f.repo, 'replacement', saved.version), /草稿/);
        assert.deepEqual(await fs.readFile(f.filename), before);
        await assert.rejects(fs.lstat(f.filename + '.lock'), { code: 'ENOENT' });
    }
});

test('preexisting locks including directories and symlinks are never removed or replaced', async t => {
    const f = await fixture(t), saved = await seed(f), lock = f.filename + '.lock', target = path.join(f.base, 'lock-target');
    await fs.writeFile(target, 'unrelated');
    for (const kind of ['file', 'directory', 'symlink']) {
        if (kind === 'file') await fs.writeFile(lock, 'another owner');
        if (kind === 'directory') await fs.mkdir(lock);
        if (kind === 'symlink') await fs.symlink(target, lock);
        const before = await fs.lstat(lock);
        await assert.rejects(f.store.save(f.repo, 'replacement', saved.version), /锁/);
        assert.equal((await fs.lstat(lock)).ino, before.ino);
        assert.deepEqual(await f.store.read(f.repo), saved);
        await fs.rm(lock, { recursive: true });
    }
    assert.equal(await fs.readFile(target, 'utf8'), 'unrelated');
});

test('cache and draft-directory symlinks refuse reads and writes without touching their targets', async t => {
    const f = await fixture(t), target = path.join(f.base, 'outside'); await fs.mkdir(target);
    const initial = await f.store.read(f.repo);
    await fs.symlink(target, f.cache, 'dir');
    await assert.rejects(f.store.read(f.repo), /符号链接/);
    await assert.rejects(f.store.save(f.repo, 'text', initial.version), /符号链接/);
    await fs.unlink(f.cache); await fs.mkdir(f.cache);
    await fs.symlink(target, path.join(f.cache, 'drafts'), 'dir');
    await assert.rejects(f.store.read(f.repo), /符号链接/);
    await assert.rejects(f.store.save(f.repo, 'text', initial.version), /符号链接/);
    assert.deepEqual(await fs.readdir(target), []);
});

test('draft-path symlinks, directories and hard links are preserved without following or replacing them', async t => {
    const f = await fixture(t), saved = await seed(f), target = path.join(f.base, 'original');
    await fs.rename(f.filename, target);
    const bytes = await fs.readFile(target);
    for (const kind of ['symlink', 'directory', 'hardlink']) {
        if (kind === 'symlink') await fs.symlink(target, f.filename);
        if (kind === 'directory') await fs.mkdir(f.filename);
        if (kind === 'hardlink') await fs.link(target, f.filename);
        const before = await fs.lstat(f.filename);
        await assert.rejects(f.store.read(f.repo), /类型/);
        await assert.rejects(f.store.save(f.repo, 'replacement', saved.version), /类型/);
        assert.equal((await fs.lstat(f.filename)).ino, before.ino);
        await fs.rm(f.filename, { recursive: true });
    }
    assert.deepEqual(await fs.readFile(target), bytes);
});

test('rename failure keeps the old draft and cleans only temporary files owned by the failed save', async t => {
    const f = await fixture(t), saved = await seed(f), bytes = await fs.readFile(f.filename);
    const unrelated = path.join(path.dirname(f.filename), '.other-writer.tmp'); await fs.writeFile(unrelated, 'keep');
    const rename = fs.rename;
    fs.rename = async (from, to) => { if (to === f.filename) throw new Error('simulated rename failure'); return rename(from, to); };
    try { await assert.rejects(f.store.save(f.repo, 'replacement', saved.version), /simulated rename failure/); }
    finally { fs.rename = rename; }
    assert.deepEqual(await fs.readFile(f.filename), bytes);
    assert.deepEqual((await fs.readdir(path.dirname(f.filename))).sort(), ['.other-writer.tmp', path.basename(f.filename)].sort());
    assert.equal(await fs.readFile(unrelated, 'utf8'), 'keep');
});

test('cleanup never deletes a replacement lock belonging to another writer', async t => {
    const f = await fixture(t), saved = await seed(f), lock = f.filename + '.lock', rename = fs.rename;
    fs.rename = async (from, to) => {
        if (to !== f.filename) return rename(from, to);
        await fs.unlink(lock); await fs.writeFile(lock, 'other writer owns this lock');
        throw new Error('simulated interruption');
    };
    try { await assert.rejects(f.store.save(f.repo, 'replacement', saved.version), /simulated interruption/); }
    finally { fs.rename = rename; }
    assert.equal(await fs.readFile(lock, 'utf8'), 'other writer owns this lock');
    assert.deepEqual(await f.store.read(f.repo), saved);
});
