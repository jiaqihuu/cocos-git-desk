const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePatch, selectPatch, applyPatchText } = require('../dist/patch');
const { layoutGraph } = require('../dist/graph');

const header = 'diff --git a/file.txt b/file.txt\nindex aaaaaaa..bbbbbbb 100644\n--- a/file.txt\n+++ b/file.txt\n';
const changed = parsed => parsed.hunks.flatMap(h => h.lines.filter(l => l.id));

test('line parser retains CRLF, line numbers, quoted paths and missing-newline markers', () => {
    const parsed = parsePatch(header.replaceAll('a/file.txt', '"a/space\\nfile.txt"').replaceAll('b/file.txt', '"b/space\\nfile.txt"') + '@@ -1,3 +1,3 @@\n same\r\n-old\r\n+new\r\n end\n\\ No newline at end of file\n');
    assert.deepEqual(changed(parsed).map(l => [l.kind, l.text, l.oldLine, l.newLine]), [['-', 'old\r', 2, undefined], ['+', 'new\r', undefined, 2]]);
    assert.equal(parsed.hunks[0].lines.at(-1).noNewline, true);
    const result = selectPatch(parsed, changed(parsed).map(l => l.id));
    assert.match(result, /-old\r\n\+new\r\n/); assert.match(result, /\\ No newline at end of file/);
    assert.doesNotMatch(result, /^index /m);
});

test('partial patches recalculate offsets independently of skipped hunks in both directions', () => {
    const parsed = parsePatch(header + '@@ -1,3 +1,4 @@\n first\n-old\n+new\n+extra\n last\n@@ -20,3 +21,2 @@\n left\n-gone\n right\n');
    const line = changed(parsed).find(l => l.text === 'gone');
    const forward = selectPatch(parsed, [line.id]);
    assert.match(forward, /@@ -20,3 \+20,2 @@/); assert.doesNotMatch(forward, /extra/);
    const reverse = selectPatch(parsed, [line.id], true);
    assert.match(reverse, /@@ -21,2 \+21,3 @@/); assert.match(reverse, /\+gone/);
    const replacement = changed(parsed).filter(l => ['old', 'new'].includes(l.text)).map(l => l.id);
    const both = selectPatch(parsed, [...replacement, line.id]);
    assert.match(both, /@@ -1,3 \+1,3 @@/); assert.match(both, /@@ -20,3 \+20,2 @@/);
});

test('line selection rejects malformed patches, stale ids, duplicates and empty selections', () => {
    const text = header + '@@ -1 +1 @@\n-old\n+new\n';
    const parsed = parsePatch(text), id = changed(parsed)[0].id;
    assert.throws(() => parsePatch(text.slice(0, -1)), /不完整/);
    assert.throws(() => parsePatch(text.replace('@@ -1 +1 @@', '@@ -1,2 +1 @@')), /行数/);
    assert.throws(() => parsePatch(text.replace('index aaaaaaa..bbbbbbb 100644', 'old mode 100644\nnew mode 100755')), /模式/);
    assert.throws(() => selectPatch(parsed, []), /请选择/);
    assert.throws(() => selectPatch(parsed, ['99:1']), /失效/);
    assert.throws(() => selectPatch(parsed, [id, id]), /失效/);
    assert.throws(() => selectPatch(parsed, [1]), /请选择/);
});

test('partial selection cannot leave a no-newline marker in the middle of resulting text', () => {
    const parsed = parsePatch(header + '@@ -1 +1,2 @@\n-old\n\\ No newline at end of file\n+new\n+tail\n');
    assert.throws(() => selectPatch(parsed, [changed(parsed).find(l => l.text === 'tail').id]), /换行相互依赖/);
    assert.doesNotThrow(() => selectPatch(parsed, changed(parsed).map(l => l.id)));
    const eof = parsePatch(header + '@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n');
    assert.doesNotThrow(() => selectPatch(eof, changed(eof).map(l => l.id), true));
});

function assertEdgesReachParents(commits, graph) {
    for (let i = 0; i < commits.length; i++) {
        const edges = graph.rows[i].edges.filter(e => e.parent);
        assert.deepEqual(edges.map(e => e.parent), commits[i].parents);
        for (const edge of edges) {
            let column = edge.to, reached;
            for (let j = i + 1; j < commits.length; j++) {
                if (graph.rows[j].column === column && graph.rows[j].incoming) { reached = commits[j].sha; break; }
                const continuation = graph.rows[j].edges.find(e => !e.parent && e.from === column);
                assert.ok(continuation, `missing lane for ${edge.parent}`); column = continuation.to;
            }
            assert.equal(reached || graph.pending[column], edge.parent);
        }
    }
}

test('commit graph preserves real merge parents, joins and separate branch tips', () => {
    const commits = [
        { sha: 'merge', parents: ['left', 'right'] },
        { sha: 'left', parents: ['base'] },
        { sha: 'other-tip', parents: ['right'] },
        { sha: 'right', parents: ['base'] },
        { sha: 'base', parents: [] },
    ];
    const graph = layoutGraph(commits);
    assertEdgesReachParents(commits, graph); assert.deepEqual(graph.pending, []); assert.ok(graph.width > 1);
    assert.equal(graph.rows[2].incoming, false);
});

test('commit graph handles octopus merges, disconnected roots and paginated continuations', () => {
    const commits = [
        { sha: 'octopus', parents: ['a', 'b', 'c'] },
        { sha: 'a', parents: ['root'] },
        { sha: 'b', parents: ['root'] },
        { sha: 'c', parents: ['root'] },
        { sha: 'island', parents: [] },
        { sha: 'root', parents: [] },
    ];
    const full = layoutGraph(commits);
    assertEdgesReachParents(commits, full);
    for (let count = 1; count < commits.length; count++) {
        const partial = layoutGraph(commits.slice(0, count));
        assert.deepEqual(partial.rows, full.rows.slice(0, count));
        assertEdgesReachParents(commits.slice(0, count), partial);
    }
    assert.deepEqual(layoutGraph([]), { rows: [], pending: [], width: 1 });
});


test('exact patch application preserves unselected replacements on either side', () => {
    const parsed=parsePatch(header+'@@ -1,3 +1,3 @@\n first\n-old\n+new\n last\n'),source='first\nnew\nlast\n';
    const old=changed(parsed).find(line=>line.text==='old').id,next=changed(parsed).find(line=>line.text==='new').id;
    assert.equal(applyPatchText(source,parsePatch(selectPatch(parsed,[next],true))),'first\nlast\n');
    assert.equal(applyPatchText(source,parsePatch(selectPatch(parsed,[old],true))),'first\nold\nnew\nlast\n');
    assert.equal(applyPatchText(source,parsePatch(selectPatch(parsed,[old,next],true))),'first\nold\nlast\n');
});

test('exact reverse patches retain earlier unselected hunks while using disk coordinates', () => {
    const parsed=parsePatch(header+'@@ -1,3 +1,4 @@\n first\n-old\n+new\n+extra\n last\n@@ -20,3 +21,2 @@\n left\n-gone\n right\n');
    const source=['first','new','extra','last',...Array.from({length:16},(_,i)=>'f'+i),'left','right'].join('\n')+'\n';
    const line=changed(parsed).find(line=>line.text==='gone');
    assert.equal(applyPatchText(source,parsePatch(selectPatch(parsed,[line.id],true))),source.replace('left\nright\n','left\ngone\nright\n'));
});

test('exact patch application handles zero-count insertion and removal of all text', () => {
    const parsed=parsePatch(header+'@@ -0,0 +1,1 @@\n+first\n');
    assert.equal(applyPatchText('',parsed),'first\n');
    assert.equal(applyPatchText('first\n',parsePatch(selectPatch(parsed,changed(parsed).map(line=>line.id),true))),'');
});

test('exact reverse patch preserves missing final newline after a paired replacement', () => {
    const parsed=parsePatch(header+'@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n');
    assert.equal(applyPatchText('new',parsePatch(selectPatch(parsed,changed(parsed).map(line=>line.id),true))),'old');
});

test('exact patch application refuses stale context, overlaps and offsets past EOF', () => {
    const hunk='@@ -1,1 +1,1 @@\n-old\n+new\n';
    assert.throws(()=>applyPatchText('different\n',parsePatch(header+hunk)),/上下文/);
    assert.throws(()=>applyPatchText('old\nold\n',parsePatch(header+hunk+hunk)),/重叠/);
    assert.throws(()=>applyPatchText('old\n',parsePatch(header+'@@ -5,1 +5,1 @@\n-old\n+new\n')),/超出/);
});

test('exact patch rejects implicit concatenation after a no-newline context', () => {
    const parsed=parsePatch(header+'@@ -1,1 +1,2 @@\n old\n\\ No newline at end of file\n+tail\n');
    assert.throws(()=>applyPatchText('old',parsed),/无换行/);
});

test('exact patch preserves a large unchanged prefix and Unicode text without normalizing it', () => {
    const prefix='unchanged\n'.repeat(100000),parsed=parsePatch(header+'@@ -100001,1 +100001,1 @@\n-old😀\t\n+new😀\t\n');
    assert.equal(applyPatchText(prefix+'new😀\t\n',parsePatch(selectPatch(parsed,changed(parsed).map(line=>line.id),true))),prefix+'old😀\t\n');
});
