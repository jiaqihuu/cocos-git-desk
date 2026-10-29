const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reflogSources } = require('../dist/reflog');

const details = () => ({ repo: { branch: 'dev' }, branches: [{ name: 'topic' }, { name: 'dev' }], remoteBranches: [{ name: 'origin/topic', ref: 'refs/remotes/origin/topic' }] });

test('source selector labels local and remote-tracking events and keeps current first', () => {
    const page = reflogSources(details(), '');
    assert.deepEqual(page.options.map(x => x.ref), ['HEAD', 'refs/heads/dev', 'refs/heads/topic', 'refs/remotes/origin/topic']);
    assert.equal(page.matched, 3); assert.equal(page.truncated, false);
    assert.match(page.options[3].label, /本机/);
});

test('source selector filters full names literally without hiding HEAD', () => {
    const input = details(); input.branches.push({ name: 'feature/[draft]' });
    assert.deepEqual(reflogSources(input, '[DRAFT]').options.map(x => x.ref), ['HEAD', 'refs/heads/feature/[draft]']);
    assert.deepEqual(reflogSources(input, 'refs/remotes/ORIGIN').options.map(x => x.ref), ['HEAD', 'refs/remotes/origin/topic']);
    assert.equal(reflogSources(input, 'absent').matched, 0);
});

test('large source metadata is bounded to 200 matches plus HEAD and supports narrowing', () => {
    const input = details(); input.branches = Array.from({ length: 1000 }, (_, i) => ({ name: 'topic-' + i }));
    const page = reflogSources(input, '');
    assert.equal(page.options.length, 201); assert.equal(page.matched, 1002); assert.equal(page.truncated, true);
    assert.deepEqual(reflogSources(input, 'topic-999').options.map(x => x.ref), ['HEAD', 'refs/heads/topic-999']);
});

test('detached source metadata does not invent a local HEAD branch or mutate inputs', () => {
    const input = details(); input.repo.branch = ''; const before = JSON.stringify(input);
    assert.equal(reflogSources(input, '').matched, 3); assert.equal(JSON.stringify(input), before);
    assert.ok(!reflogSources(input, '').options.some(x => x.ref === 'refs/heads/'));
});
