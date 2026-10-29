const { test } = require('node:test');
const assert = require('node:assert/strict');
const { headState, branchAtRequest } = require('../dist/branch-actions');

// Pure snapshot/request fixtures. Source only until the user authorizes a build and test run.
const repo = (extra = {}) => ({ id: '.', path: '/project', name: 'sample', initialized: true,
    head: 'a'.repeat(40), branch: 'dev', version: 'v1', upstream: 'origin/dev', ahead: 0, behind: 0,
    files: [], operation: '', ...extra });

test('head state distinguishes detached, unborn and attached without looking at dirty files', () => {
    assert.equal(headState(repo()), 'attached');
    assert.equal(headState(repo({ branch: '' })), 'detached');
    assert.equal(headState(repo({ head: '' })), 'unborn');
    assert.equal(headState(repo({ head: '', branch: '' })), 'unborn');
    assert.equal(headState(repo({ files: [{ path: 'dirty' }], operation: 'MERGE_HEAD' })), 'attached');
});

test('failed or uninitialized snapshots are never presented as unborn or detached', () => {
    assert.equal(headState(repo({ initialized: false, head: '', branch: '' })), 'unavailable');
    assert.equal(headState(repo({ error: 'read failed', branch: '' })), 'unavailable');
});

test('ref-only request includes exactly pinned scope and never forwards dirty selections or options', () => {
    const source = repo({ files: [{ path: 'assets/secret.ts' }], remote: 'origin', paths: ['accidental'], message: 'draft', includePointers: true });
    const target = 'b'.repeat(40);
    const request = branchAtRequest(source, target, '  topic/name  ');
    assert.deepEqual(request, { repo: '.', version: 'v1', action: 'createBranchAt', branch: 'topic/name', revision: target });
    source.version = 'v2'; source.head = 'c'.repeat(40); source.files.push({ path: 'later' });
    assert.equal(request.version, 'v1'); assert.equal(request.revision, target);
});

test('detached request preserves the observed target without inventing a checkout or upstream', () => {
    const source = repo({ branch: '' });
    assert.deepEqual(branchAtRequest(source, source.head, 'keep/head'), {
        repo: '.', version: 'v1', action: 'createBranchAt', branch: 'keep/head', revision: source.head,
    });
});

test('full SHA-256 target is retained and branch validation stays in the backend', () => {
    assert.equal(branchAtRequest(repo(), 'd'.repeat(64), 'bad..name').revision, 'd'.repeat(64));
});

test('ref-only UI requests reject moving expressions, abbreviated IDs and unavailable snapshots', () => {
    for (const revision of ['HEAD', 'HEAD@{0}', 'a'.repeat(12), 'A'.repeat(40), 'a'.repeat(41), '']) {
        assert.throws(() => branchAtRequest(repo(), revision, 'keep'), /完整提交 SHA/);
    }
    assert.throws(() => branchAtRequest(repo({ error: 'failed' }), 'a'.repeat(40), 'keep'), /状态不可用/);
    assert.throws(() => branchAtRequest(repo({ initialized: false }), 'a'.repeat(40), 'keep'), /状态不可用/);
});

test('unborn snapshot may pin another known commit without pretending HEAD exists', () => {
    const source = repo({ head: '', branch: 'new' });
    assert.equal(branchAtRequest(source, 'b'.repeat(40), 'existing-object').revision, 'b'.repeat(40));
    assert.throws(() => branchAtRequest(source, source.head, 'keep'), /完整提交 SHA/);
});
