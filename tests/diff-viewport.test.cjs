const test = require('node:test');
const assert = require('node:assert/strict');
const { diffRowOffsets, diffVisibleRange } = require('../dist/diff-viewport');

test('mixed diff rows remain covered at top, middle and end of a large patch', () => {
    const rows = Array.from({ length: 15000 }, (_, index) => ({ text: String(index), height: index % 101 === 0 ? 36 : 21 }));
    const offsets = diffRowOffsets(rows), height = 600;
    for (const top of [0, 21, 500, 42000, offsets.at(-1) - height]) {
        const [start, end] = diffVisibleRange(offsets, top, height);
        const visible = rows.map((_, index) => index).filter(index => offsets[index + 1] > top && offsets[index] < top + height);
        assert(visible.every(index => index >= start && index < end));
        assert(end - start < 65, 'viewport work should stay bounded as patch grows');
    }
});

test('empty and hidden viewports produce valid ranges and retain an initial buffer', () => {
    assert.deepEqual(diffVisibleRange([0], 0, 0), [0, 0]);
    const offsets = diffRowOffsets(Array.from({ length: 1000 }, () => ({ text: '', height: 20 })));
    const [start, end] = diffVisibleRange(offsets, 0, 0);
    assert.equal(start, 0); assert(end > 0 && end < 30);
    const final = diffVisibleRange(offsets, offsets.at(-1) - 600, 600);
    assert.equal(final[1], 1000);
});

test('a viewport crossing a hunk and EOF note includes both row types', () => {
    const rows = [
        ...Array.from({ length: 50 }, () => ({ text: 'context', height: 21 })),
        { text: '@@ -51,1 +51,1 @@', height: 36 },
        { text: '+last line', height: 21 },
        { text: '\\ 文件结尾无换行', height: 21 }
    ];
    const offsets = diffRowOffsets(rows), [start, end] = diffVisibleRange(offsets, 1050, 78);
    assert(start <= 50); assert.equal(end, rows.length);
    assert.equal(offsets.at(-1), 1128);
});
