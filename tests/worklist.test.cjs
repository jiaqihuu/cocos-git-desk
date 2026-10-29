const { test } = require('node:test');
const assert = require('node:assert/strict');
const { canApplyIndexPlan, contextSelection, workingRows, filterWorkingRows, reconcileSelection, selectVisible, selectedPaths, selectedWholeFiles } = require('../dist/worklist');

const file = (path, status = ' M', extra = {}) => ({ path, index: status[0], worktree: status[1], conflict: false, submodule: false, ...extra });
const filter = extra => ({ text: '', area: 'all', status: 'all', kind: 'all', ...extra });
const keys = rows => rows.map(row => row.key);

test('context menu preserves an existing selection but only visible rows become operation paths', () => {
    const rows = workingRows([file('a.ts', 'MM'), file('b.ts'), file('hidden.ts')], false);
    const visible = rows.filter(row => row.file.path !== 'hidden.ts');
    const selected = new Set(['worktree:a.ts', 'index:a.ts', 'worktree:b.ts', 'worktree:hidden.ts']);
    const context = contextSelection(visible, selected, 'worktree:a.ts');
    assert.deepEqual(context, selected);
    assert.deepEqual(selectedPaths(visible, context, 'worktree'), ['a.ts', 'b.ts']);
    assert.deepEqual(selectedPaths(visible, context, 'index'), ['a.ts']);
    assert.deepEqual([...contextSelection(visible, new Set(['worktree:b.ts']), 'index:a.ts')], ['index:a.ts']);
});

test('conflicts, absent rows and unapproved pointers cannot inherit another file selection', () => {
    const rows = workingRows([file('a.ts'), file('child', ' M', { submodule: true }), file('conflict', 'UU', { conflict: true })], false);
    for (const key of ['worktree:child', 'conflict:conflict', 'worktree:missing']) {
        assert.equal(contextSelection(rows, new Set(['worktree:a.ts']), key).size, 0);
    }
});

test('direct index actions require an explicit matching hint and the exact selected path set', () => {
    const preview = { token: 'one', paths: ['a', 'b'], warnings: [], expiresAt: Date.now() + 60000, directIndexAction: 'stage' };
    assert.equal(canApplyIndexPlan('stage', ['b', 'a'], preview), true);
    for (const paths of [[], ['a'], ['a', 'b', 'extra'], ['a', 'a']]) assert.equal(canApplyIndexPlan('stage', paths, preview), false);
    assert.equal(canApplyIndexPlan('stage', ['a', 'b'], { ...preview, paths: ['a', 'a'] }), false);
    assert.equal(canApplyIndexPlan('unstage', ['a', 'b'], { ...preview, directIndexAction: 'unstage' }), true);
});

test('older plans, warnings, patches, expired tokens and other actions retain confirmation', () => {
    const preview = { token: 'one', paths: ['a'], warnings: [], expiresAt: Date.now() + 60000, directIndexAction: 'stage' };
    for (const extra of [{ directIndexAction: undefined }, { directIndexAction: 'unstage' }, { warnings: ['review'] }, { patch: 'patch' }, { expiresAt: 0 }]) {
        assert.equal(canApplyIndexPlan('stage', ['a'], { ...preview, ...extra }), false);
    }
    for (const action of ['commit', 'discardFiles', 'stageLines', 'unstageLines']) assert.equal(canApplyIndexPlan(action, ['a'], preview), false);
});

test('working rows split mixed index and worktree states while conflicts stay single and unselectable', () => {
    const rows = workingRows([
        file('both.ts', 'MM'), file('added.ts', 'AM'), file('deleted.ts', 'AD'),
        file('new.ts', '??'), file('conflict.ts', 'UU', { conflict: true }), file('clean.ts', '  '),
    ], false);
    assert.deepEqual(rows.map(row => [row.key, row.selectable]), [
        ['worktree:both.ts', true], ['index:both.ts', true],
        ['worktree:added.ts', true], ['index:added.ts', true],
        ['worktree:deleted.ts', true], ['index:deleted.ts', true],
        ['worktree:new.ts', true], ['conflict:conflict.ts', false],
    ]);
});

test('row generation and filtering keep input files and their source order intact', () => {
    const files = Object.freeze([Object.freeze(file('z.ts', 'MM')), Object.freeze(file('a.ts', ' M'))]);
    const rows = workingRows(files, false);
    rows.forEach(Object.freeze); Object.freeze(rows);
    const result = filterWorkingRows(rows, filter({ status: 'modified' }));
    assert.notEqual(result, rows);
    assert.deepEqual(result, rows);
    assert.equal(result[0].file, files[0]);
    assert.equal(result[1].file, files[0]);
    assert.equal(result[2].file, files[1]);
});

test('status filters use each row area rather than the combined file status', () => {
    const rows = workingRows([
        file('am.ts', 'AM'), file('ad.ts', 'AD'), file('mm.ts', 'MM'),
        file('new.ts', '??'), file('conflict.ts', 'AA', { conflict: true }),
    ], false);
    assert.deepEqual(keys(filterWorkingRows(rows, filter({ status: 'added' }))), ['index:am.ts', 'index:ad.ts']);
    assert.deepEqual(keys(filterWorkingRows(rows, filter({ status: 'modified' }))), ['worktree:am.ts', 'worktree:mm.ts', 'index:mm.ts']);
    assert.deepEqual(keys(filterWorkingRows(rows, filter({ status: 'deleted' }))), ['worktree:ad.ts']);
    assert.deepEqual(keys(filterWorkingRows(rows, filter({ status: 'untracked' }))), ['worktree:new.ts']);
    assert.deepEqual(keys(filterWorkingRows(rows, filter({ status: 'conflict' }))), ['conflict:conflict.ts']);
});

test('rename and type filters distinguish copied paths, worktree edits and conflict states', () => {
    const rows = workingRows([
        file('renamed.ts', 'RM', { oldPath: 'old.ts' }), file('copied.ts', 'C '),
        file('worktree-rename.ts', ' R'), file('type.ts', 'MT'), file('conflict.ts', 'DD', { conflict: true }),
    ], false);
    assert.deepEqual(keys(filterWorkingRows(rows, filter({ status: 'renamed' }))), ['index:renamed.ts', 'index:copied.ts', 'worktree:worktree-rename.ts']);
    assert.deepEqual(keys(filterWorkingRows(rows, filter({ status: 'type' }))), ['worktree:type.ts']);
    assert.deepEqual(keys(filterWorkingRows(rows, filter({ status: 'deleted' }))), []);
    assert.equal(filterWorkingRows(rows, filter()).length, rows.length);
});

test('area and status filters intersect without removing the other area of an input file', () => {
    const rows = workingRows([file('a.ts', 'AM'), file('b.ts', 'MM'), file('c.ts', 'UU', { conflict: true })], false);
    assert.deepEqual(keys(filterWorkingRows(rows, filter({ area: 'index', status: 'modified' }))), ['index:b.ts']);
    assert.deepEqual(keys(filterWorkingRows(rows, filter({ area: 'worktree', status: 'added' }))), []);
    assert.deepEqual(keys(filterWorkingRows(rows, filter({ area: 'conflict' }))), ['conflict:c.ts']);
    assert.deepEqual(keys(filterWorkingRows(rows, filter({ area: 'conflict', status: 'modified' }))), []);
    assert.deepEqual(keys(filterWorkingRows(rows, filter({ area: 'index', status: 'conflict' }))), []);
});

test('path text search is case insensitive and literal for current and previous rename paths', () => {
    const rows = workingRows([
        file('Assets/New.ts', 'R ', { oldPath: 'Assets/Old[?]*.ts' }),
        file('assets/oldXYZ.ts'), file(' spaced .txt'), file('unspaced.txt'),
    ], false);
    assert.deepEqual(keys(filterWorkingRows(rows, filter({ text: 'ASSETS/NEW' }))), ['index:Assets/New.ts']);
    assert.deepEqual(keys(filterWorkingRows(rows, filter({ text: 'old[?]*.' }))), ['index:Assets/New.ts']);
    assert.deepEqual(keys(filterWorkingRows(rows, filter({ text: '^assets' }))), []);
    assert.deepEqual(keys(filterWorkingRows(rows, filter({ text: ' ' }))), ['worktree: spaced .txt']);
    assert.deepEqual(keys(filterWorkingRows(rows, filter({ text: ' spaced ' }))), ['worktree: spaced .txt']);
    assert.deepEqual(keys(filterWorkingRows(rows, filter({ text: 'unspaced.txt ' }))), []);
});

test('kind filters give submodules priority and only use a strict current meta suffix', () => {
    const rows = workingRows([
        file('asset.meta'), file('asset.META'), file('asset.meta.bak'), file('script.ts', 'R ', { oldPath: 'old.meta' }),
        file('plugin.meta', 'M ', { submodule: true }), file('plugin', 'M ', { submodule: true }),
    ], true);
    assert.deepEqual(keys(filterWorkingRows(rows, filter({ kind: 'meta' }))), ['worktree:asset.meta']);
    assert.deepEqual(keys(filterWorkingRows(rows, filter({ kind: 'files' }))), ['worktree:asset.META', 'worktree:asset.meta.bak', 'index:script.ts']);
    assert.deepEqual(keys(filterWorkingRows(rows, filter({ kind: 'submodules' }))), ['index:plugin.meta', 'index:plugin']);
    assert.deepEqual(keys(filterWorkingRows(rows, filter({ kind: 'files', text: 'old.meta' }))), ['index:script.ts']);
});

test('pointer permission changes both submodule areas but never makes conflicts selectable', () => {
    const files = [file('module', 'MM', { submodule: true }), file('module-conflict', 'UU', { submodule: true, conflict: true }), file('plain.ts')];
    const blocked = workingRows(files, false), allowed = workingRows(files, true);
    assert.deepEqual(blocked.map(row => row.selectable), [false, false, false, true]);
    assert.deepEqual(allowed.map(row => row.selectable), [true, true, false, true]);
    assert.deepEqual(keys(blocked), keys(allowed));
    assert.deepEqual([...selectVisible(new Set(), blocked, true)], ['worktree:plain.ts']);
    assert.deepEqual([...selectVisible(new Set(), allowed, true)], ['worktree:module', 'index:module', 'worktree:plain.ts']);
});

test('visible select all and select none retain hidden selections but actions only include visible rows', () => {
    const rows = workingRows([file('apple.ts'), file('banana.ts'), file('blocked', ' M', { submodule: true })], false);
    const visible = filterWorkingRows(rows, filter({ text: 'apple' }));
    const initial = new Set(['worktree:banana.ts']);
    const selected = selectVisible(initial, visible, true);
    assert.deepEqual([...selected], ['worktree:banana.ts', 'worktree:apple.ts']);
    assert.deepEqual(selectedPaths(visible, selected, 'worktree'), ['apple.ts']);
    assert.deepEqual([...selectVisible(selected, visible, false)], ['worktree:banana.ts']);
    assert.deepEqual([...initial], ['worktree:banana.ts']);
});

test('index and worktree selection remain independent for the same file', () => {
    const rows = workingRows([file('mixed.ts', 'MM')], false);
    const worktree = filterWorkingRows(rows, filter({ area: 'worktree' }));
    const index = filterWorkingRows(rows, filter({ area: 'index' }));
    const worktreeOnly = selectVisible(new Set(), worktree, true);
    assert.deepEqual(selectedPaths(rows, worktreeOnly, 'worktree'), ['mixed.ts']);
    assert.deepEqual(selectedPaths(rows, worktreeOnly, 'index'), []);
    const both = selectVisible(worktreeOnly, index, true);
    const indexOnly = selectVisible(both, worktree, false);
    assert.deepEqual([...indexOnly], ['index:mixed.ts']);
    assert.deepEqual(selectedPaths(rows, indexOnly, 'worktree'), []);
    assert.deepEqual(selectedPaths(rows, indexOnly, 'index'), ['mixed.ts']);
});

test('reconciliation prunes disappeared, changed-area and newly blocked selections without filtering hidden rows', () => {
    const selected = new Set(['worktree:hidden.ts', 'worktree:gone.ts', 'worktree:staged.ts', 'index:module', 'conflict:conflict.ts']);
    const rows = workingRows([
        file('hidden.ts'), file('staged.ts', 'M '), file('module', 'M ', { submodule: true }),
        file('conflict.ts', 'UU', { conflict: true }),
    ], false);
    const result = reconcileSelection(selected, rows);
    assert.deepEqual([...result], ['worktree:hidden.ts']);
    assert.deepEqual(selectedPaths(filterWorkingRows(rows, filter({ text: 'staged' })), result, 'worktree'), []);
    assert.deepEqual([...selected], ['worktree:hidden.ts', 'worktree:gone.ts', 'worktree:staged.ts', 'index:module', 'conflict:conflict.ts']);
});

test('selected paths deduplicate in visible order and exclude stale keys and unavailable areas', () => {
    const rows = workingRows([
        file('z.ts', 'MM'), file('a.ts'), file('z.ts', 'MM'), file('module', 'M ', { submodule: true }),
        file('conflict.ts', 'UU', { conflict: true }), file('new.ts', 'R ', { oldPath: 'old.ts' }),
    ], false);
    const selected = new Set(['worktree:a.ts', 'worktree:z.ts', 'index:z.ts', 'index:module', 'conflict:conflict.ts', 'index:new.ts', 'worktree:gone.ts']);
    assert.deepEqual(selectedPaths(rows, selected, 'worktree'), ['z.ts', 'a.ts']);
    assert.deepEqual(selectedPaths(rows, selected, 'index'), ['z.ts', 'new.ts']);
});

test('selection keys never need to be parsed to return colon and newline paths', () => {
    const names = ['folder:one/file.ts', 'index:worktree:file.ts', 'line\nbreak.ts'];
    const rows = workingRows(names.map(name => file(name, 'MM')), false);
    const selected = selectVisible(new Set(), rows, true);
    assert.equal(selected.size, names.length * 2);
    assert.deepEqual(selectedPaths(rows, selected, 'worktree'), names);
    assert.deepEqual(selectedPaths(rows, selected, 'index'), names);
    const visible = filterWorkingRows(rows, filter({ text: '\n', area: 'index' }));
    assert.deepEqual([...selectVisible(selected, visible, false)], [
        'worktree:folder:one/file.ts', 'index:folder:one/file.ts',
        'worktree:index:worktree:file.ts', 'index:index:worktree:file.ts', 'worktree:line\nbreak.ts',
    ]);
});

test('empty and no-op selection operations return independent sets without mutating inputs', () => {
    const initial = new Set(['worktree:a.ts']);
    const rows = Object.freeze(workingRows([file('a.ts')], false).map(Object.freeze));
    for (const result of [reconcileSelection(initial, rows), selectVisible(initial, rows, true), selectVisible(initial, [], false)]) {
        assert.notEqual(result, initial); assert.deepEqual([...result], [...initial]);
        result.add('other'); assert.deepEqual([...initial], ['worktree:a.ts']);
    }
    assert.deepEqual(workingRows([], false), []);
    assert.deepEqual(filterWorkingRows([], filter()), []);
    assert.deepEqual([...reconcileSelection(initial, [])], []);
    assert.deepEqual([...selectVisible(new Set(), [], true)], []);
    assert.deepEqual(selectedPaths([], initial, 'worktree'), []);
});

test('selected whole files merges index/worktree choices without importing hidden selections', () => {
    const rows = workingRows([file('both.ts', 'MM'), file('hidden.ts', ' M'), file('new.ts', '??')], false);
    const selected = new Set(['worktree:both.ts', 'index:both.ts', 'worktree:hidden.ts', 'worktree:new.ts']);
    const rendered = rows.filter(row => row.file.path !== 'hidden.ts');
    assert.deepEqual(selectedWholeFiles(rendered, selected), ['both.ts', 'new.ts']);
    assert.equal(selected.has('worktree:hidden.ts'), true);
});

test('selected whole files excludes conflicts, pointers even if allowed, and stale keys', () => {
    const rows = workingRows([file('child', ' M', { submodule: true }), file('conflict', 'UU', { conflict: true }), file('ok.ts', ' M')], true);
    const selected = new Set([...keys(rows), 'worktree:absent']);
    assert.deepEqual(selectedWholeFiles(rows, selected), ['ok.ts']);
});
