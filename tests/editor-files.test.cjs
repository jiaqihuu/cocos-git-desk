const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { editorFile } = require('../dist/editor-files');

const work = path.resolve(__dirname, '../.test-work');
async function fixture(t, name = 'folder/main.ts') {
    await fs.mkdir(work, { recursive: true });
    const base = await fs.mkdtemp(path.join(work, 'editor-files-'));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const project = path.join(base, 'project'), file = path.join(project, 'assets', name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'original');
    return { base, project, file };
}
function host(file, overrides = {}) {
    const calls = [];
    const info = { uuid: 'd3e808ee-e099-4074-8b8c-5c0e46cc114f', url: 'db://assets/folder/main.ts', file, isDirectory: false, imported: true, invalid: false };
    const responses = {
        'asset-db:query-asset-info': info,
        'scene:query-dirty': false,
        'scene:multi-scene-query': [{ type: 'scene', dirty: false }],
        'assets:twinkle': undefined,
        'asset-db:open-asset': undefined,
        ...overrides,
    };
    const request = async (channel, message, ...args) => {
        calls.push([channel, message, ...args]);
        const key = channel + ':' + message;
        assert.ok(Object.hasOwn(responses, key), 'Unexpected host call: ' + key);
        const response = responses[key];
        if (response instanceof Error) throw response;
        return typeof response === 'function' ? response(...args) : response;
    };
    return { calls, info, responses, request };
}
function actions(h) { return h.calls.filter(call => call[1] === 'open-asset' || call[1] === 'twinkle'); }

test('describe queries only bounded asset fields and save state without editor actions', async t => {
    const f = await fixture(t), h = host(f.file);
    const result = await editorFile(f.project, f.file, 'describe', h.request);
    assert.equal(result.canReveal, true); assert.equal(result.canOpen, true);
    assert.equal(result.uuid, h.info.uuid); assert.equal(result.asset, f.file);
    assert.deepEqual(h.calls[0], ['asset-db', 'query-asset-info', f.file, ['uuid', 'url', 'file', 'isDirectory', 'imported', 'invalid']]);
    assert.deepEqual(actions(h), []); assert.equal(result.openRequested, undefined);
    assert.equal(await fs.readFile(f.file, 'utf8'), 'original');
});

test('open dispatches the registered UUID once without claiming the file is open', async t => {
    const f = await fixture(t), h = host(f.file);
    const result = await editorFile(f.project, f.file, 'open', h.request);
    assert.equal(result.openRequested, true); assert.equal(result.opened, undefined);
    assert.deepEqual(actions(h), [['asset-db', 'open-asset', h.info.uuid]]);
    assert.equal(await fs.readFile(f.file, 'utf8'), 'original');
});

test('reveal dispatches assets twinkle by UUID without claiming focus has completed', async t => {
    const f = await fixture(t), h = host(f.file);
    const result = await editorFile(f.project, f.file, 'reveal', h.request);
    assert.equal(result.revealRequested, true); assert.equal(result.revealed, undefined);
    assert.deepEqual(actions(h), [['assets', 'twinkle', h.info.uuid]]);
});

test('existing meta maps to its resource while orphan meta stays unavailable', async t => {
    const f = await fixture(t), h = host(f.file), meta = f.file + '.meta';
    await fs.writeFile(meta, '{}');
    const result = await editorFile(f.project, meta, 'open', h.request);
    assert.equal(result.file, meta); assert.equal(result.asset, f.file); assert.equal(result.openRequested, true);
    await fs.unlink(f.file); h.calls.length = 0;
    const orphan = await editorFile(f.project, meta, 'describe', h.request);
    assert.equal(orphan.canReveal, false); assert.equal(orphan.canOpen, false); assert.match(orphan.reason, /对应的资源已不存在/);
    assert.deepEqual(h.calls, []);
});

test('deleted file and deleted meta are not reconstructed or imported', async t => {
    const f = await fixture(t), h = host(f.file);
    for (const target of [f.file + '.meta', path.join(path.dirname(f.file), 'deleted.scene')]) {
        const result = await editorFile(f.project, target, 'open', h.request);
        assert.equal(result.canReveal, false); assert.equal(result.openRequested, undefined);
        await assert.rejects(fs.stat(target), { code: 'ENOENT' });
    }
    assert.deepEqual(h.calls, []);
});

test('project configuration and files outside assets are rejected before host queries', async t => {
    const f = await fixture(t), h = host(f.file);
    for (const target of [path.join(f.project, 'project.json'), path.join(f.base, 'outside.ts')]) {
        await fs.writeFile(target, '{}');
        const result = await editorFile(f.project, target, 'open', h.request);
        assert.equal(result.canReveal, false); assert.match(result.reason, /assets/);
    }
    assert.deepEqual(h.calls, []);
});

test('symlink escape through a file or ancestor is rejected', async t => {
    const f = await fixture(t), outside = path.join(f.base, 'outside'), h = host(f.file);
    await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'escape.ts'), 'outside');
    const link = path.join(f.project, 'assets', 'escape.ts'), folder = path.join(f.project, 'assets', 'linked');
    await fs.symlink(path.join(outside, 'escape.ts'), link);
    await fs.symlink(outside, folder, 'dir');
    for (const target of [link, path.join(folder, 'escape.ts')]) {
        const result = await editorFile(f.project, target, 'open', h.request);
        assert.equal(result.canReveal, false); assert.equal(result.openRequested, undefined);
    }
    assert.deepEqual(h.calls, []);
});

test('symlink inside assets resolves to its canonical resource', async t => {
    const f = await fixture(t), h = host(f.file), link = path.join(f.project, 'assets', 'alias.ts');
    await fs.symlink(f.file, link);
    const result = await editorFile(f.project, link, 'open', h.request);
    assert.equal(result.asset, f.file); assert.equal(result.openRequested, true);
    assert.equal(h.calls[0][2], f.file);
});

test('an assets root redirected elsewhere is rejected even within the project', async t => {
    const f = await fixture(t), h = host(f.file), moved = path.join(f.project, 'elsewhere');
    await fs.rename(path.join(f.project, 'assets'), moved); await fs.symlink(moved, path.join(f.project, 'assets'), 'dir');
    const result = await editorFile(f.project, f.file, 'open', h.request);
    assert.equal(result.canReveal, false); assert.match(result.reason, /assets 外部/); assert.deepEqual(h.calls, []);
});

test('folders can be revealed but never opened as shell paths', async t => {
    const f = await fixture(t), directory = path.dirname(f.file), h = host(directory);
    h.info.isDirectory = true;
    const result = await editorFile(f.project, directory, 'open', h.request);
    assert.equal(result.canReveal, true); assert.equal(result.canOpen, false); assert.match(result.reason, /文件夹/);
    assert.deepEqual(actions(h), []);
    assert.equal((await editorFile(f.project, directory, 'reveal', h.request)).revealRequested, true);
});

test('null, false and malformed asset records remain unavailable', async t => {
    const f = await fixture(t), template = host(f.file).info;
    for (const info of [null, false, {}, { ...template, uuid: '' }, { ...template, url: 'db://internal/foo' }, { ...template, imported: undefined }]) {
        const h = host(f.file, { 'asset-db:query-asset-info': info });
        const result = await editorFile(f.project, f.file, 'open', h.request);
        assert.equal(result.canReveal, false); assert.equal(result.canOpen, false); assert.deepEqual(actions(h), []);
    }
});

test('asset records pointing to another file, an outside file, or meta are rejected', async t => {
    const f = await fixture(t), other = path.join(path.dirname(f.file), 'other.ts'), outside = path.join(f.base, 'other.ts');
    for (const file of [other, outside, f.file + '.meta']) await fs.writeFile(file, '{}');
    for (const file of [other, outside, f.file + '.meta']) {
        const h = host(f.file); h.info.file = file;
        const result = await editorFile(f.project, f.file, 'open', h.request);
        assert.equal(result.canReveal, false); assert.equal(result.openRequested, undefined); assert.deepEqual(actions(h), []);
    }
});

test('pending and invalid imports can be revealed but are not opened or reimported', async t => {
    const f = await fixture(t);
    for (const fields of [{ imported: false }, { invalid: true }]) {
        const h = host(f.file); Object.assign(h.info, fields);
        const result = await editorFile(f.project, f.file, 'open', h.request);
        assert.equal(result.canReveal, true); assert.equal(result.canOpen, false); assert.match(result.reason, /导入/);
        assert.deepEqual(actions(h), []);
        assert.equal((await editorFile(f.project, f.file, 'reveal', h.request)).revealRequested, true);
    }
});

test('dirty active scenes block open while resource reveal remains available', async t => {
    const f = await fixture(t), h = host(f.file, { 'scene:query-dirty': true });
    const result = await editorFile(f.project, f.file, 'open', h.request);
    assert.equal(result.canReveal, true); assert.equal(result.canOpen, false); assert.match(result.reason, /尚未保存/);
    assert.deepEqual(actions(h), []);
    assert.equal((await editorFile(f.project, f.file, 'reveal', h.request)).revealRequested, true);
});

test('dirty background scenes, malformed states and prefab mode fail closed', async t => {
    const f = await fixture(t);
    const variants = [
        { 'scene:query-dirty': null }, { 'scene:query-dirty': false, 'scene:multi-scene-query': null },
        { 'scene:multi-scene-query': [{ type: 'scene', dirty: false }, { type: 'scene', dirty: true }] },
        { 'scene:multi-scene-query': [{ type: 'scene' }] },
        { 'scene:multi-scene-query': [{ type: 'prefab', dirty: false }] },
        { 'scene:multi-scene-query': [{ dirty: false }] },
    ];
    for (const overrides of variants) {
        const h = host(f.file, overrides), result = await editorFile(f.project, f.file, 'open', h.request);
        assert.equal(result.canReveal, true); assert.equal(result.canOpen, false); assert.ok(result.reason); assert.deepEqual(actions(h), []);
    }
});

test('scene, prefab, script and ordinary assets all use Creator registered open dispatch', async t => {
    for (const name of ['main.scene', 'piece.prefab', 'main.ts', 'texture.png']) {
        const f = await fixture(t, name), h = host(f.file);
        assert.equal((await editorFile(f.project, f.file, 'open', h.request)).openRequested, true);
        assert.deepEqual(actions(h), [['asset-db', 'open-asset', h.info.uuid]]);
    }
});

test('open rechecks the editor state instead of trusting an earlier describe result', async t => {
    const f = await fixture(t), h = host(f.file);
    assert.equal((await editorFile(f.project, f.file, 'describe', h.request)).canOpen, true);
    h.responses['scene:query-dirty'] = true;
    const result = await editorFile(f.project, f.file, 'open', h.request);
    assert.equal(result.canOpen, false); assert.deepEqual(actions(h), []);
    assert.equal(h.calls.filter(call => call[1] === 'query-asset-info').length, 2);
});

test('file replacement during state query prevents both reveal and open dispatch', async t => {
    for (const action of ['reveal', 'open']) {
        const f = await fixture(t), h = host(f.file, { 'scene:multi-scene-query': async () => {
            const replacement = f.file + '.replacement'; await fs.writeFile(replacement, 'new'); await fs.rename(replacement, f.file);
            return [{ type: 'scene', dirty: false }];
        } });
        const result = await editorFile(f.project, f.file, action, h.request);
        assert.equal(result.canReveal, false); assert.equal(result.canOpen, false); assert.match(result.reason, /发生替换/); assert.deepEqual(actions(h), []);
    }
});

test('host query exceptions produce clear unavailable state without fallback actions', async t => {
    const f = await fixture(t);
    for (const key of ['asset-db:query-asset-info', 'scene:query-dirty', 'scene:multi-scene-query']) {
        const h = host(f.file, { [key]: new Error('host unavailable') });
        const result = await editorFile(f.project, f.file, 'open', h.request);
        assert.equal(result.canOpen, false); assert.match(result.reason, /host unavailable/); assert.deepEqual(actions(h), []);
    }
});

test('false, null, unexpected open results and thrown actions are not reported as dispatched', async t => {
    const f = await fixture(t);
    for (const action of ['reveal', 'open']) {
        const key = action === 'open' ? 'asset-db:open-asset' : 'assets:twinkle';
        for (const response of [false, null, true, {}, new Error('host rejected')]) {
            const h = host(f.file, { [key]: response }), result = await editorFile(f.project, f.file, action, h.request);
            assert.equal(result.openRequested, undefined); assert.equal(result.revealRequested, undefined);
            assert.match(result.reason, /未确认/); assert.equal(actions(h).length, 1);
        }
    }
});

test('invalid input and action never reach Creator', async t => {
    const f = await fixture(t), h = host(f.file);
    await assert.rejects(editorFile(f.project, f.file, 'delete', h.request), /不支持/);
    await assert.rejects(editorFile(f.project, null, 'open', h.request), /路径无效/);
    for (const target of ['relative.ts', f.file + '\0']) assert.equal((await editorFile(f.project, target, 'open', h.request)).canReveal, false);
    assert.deepEqual(h.calls, []);
});
