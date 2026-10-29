const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseBlame } = require('../dist/blame');

const sha = 'a'.repeat(40);
function entry({ hash = sha, original = 1, line = 1, group = 1, name = 'file.txt', text = 'code', extra = '' } = {}) {
    return `${hash} ${original} ${line}${group === undefined ? '' : ' ' + group}\n` +
        'author 作者 Name\nauthor-mail <author@example.invalid>\nauthor-time 1704067200\nauthor-tz +0800\n' +
        'committer Commit Bot\ncommitter-mail <bot@example.invalid>\ncommitter-time 1704067260\ncommitter-tz -0700\n' +
        `summary subject <script>\n${extra}filename ${name}\n\t${text}\n`;
}

test('blame parser keeps complete metadata, original positions and content whitespace for every line', () => {
    const raw = entry({ original: 9, line: 201, text: '  before\t \r', extra: 'boundary\nfuture-tag unknown metadata\n' }) +
        entry({ original: 10, line: 202, text: '' }).replace(`${sha} 10 202 1`, `${sha} 10 202`);
    const lines = parseBlame(raw);
    assert.deepEqual(lines[0], { line: 201, originalLine: 9, sha, author: '作者 Name', email: 'author@example.invalid', date: '2024-01-01T00:00:00.000Z', summary: 'subject <script>', originalPath: 'file.txt', boundary: true, text: '  before\t \r' });
    assert.equal(lines[1].line, 202); assert.equal(lines[1].text, ''); assert.equal(lines[1].boundary, false);
    assert.deepEqual(parseBlame(''), []);
    assert.equal(parseBlame(entry({ hash: 'b'.repeat(64), text: '\tvalue' }))[0].sha.length, 64);
});

test('blame parser decodes Git C paths as UTF-8 bytes instead of JSON or character octal values', () => {
    const name = '"old \\344\\270\\255\\346\\226\\207\\t\\n\\r\\b\\f\\v\\a\\\\\\\".txt"';
    const lines = parseBlame(entry({ name, extra: `previous ${'b'.repeat(40)} ${name}\n` }));
    assert.equal(lines[0].originalPath, 'old 中文\t\n\r\b\f\v\x07\\".txt');
    assert.equal(parseBlame(entry({ name: '"中文 😀\\tname.txt"' }))[0].originalPath, '中文 😀\tname.txt');
    assert.equal(parseBlame(entry({ name: ' path with spaces.txt ' }))[0].originalPath, ' path with spaces.txt ');
});

test('blame parser rejects truncated output and missing or repeated line metadata', () => {
    const valid = entry();
    for (const raw of [
        valid.slice(0, -1), valid.slice(0, valid.indexOf('\tcode')), valid.replace('author 作者 Name\n', ''),
        valid.replace('filename file.txt\n', ''), valid.replace('summary subject <script>\n', ''),
        valid.replace('author-mail <author@example.invalid>\n', 'author-mail <author@example.invalid>\nauthor-mail <other@example.invalid>\n'),
        valid + `${sha} 2 2\n\tmissing metadata\n`,
    ]) assert.throws(() => parseBlame(raw), /行来源/);
});

test('blame parser rejects invalid commit IDs, unsafe integer positions and nonsequential final lines', () => {
    for (const hash of ['a'.repeat(39), 'a'.repeat(41), 'a'.repeat(63), 'g'.repeat(40), '0'.repeat(40)]) assert.throws(() => parseBlame(entry({ hash })), /标识|行号/);
    for (const changes of [{ original: 0 }, { line: 0 }, { line: -1 }, { group: 0 }, { line: '9007199254740992' }]) assert.throws(() => parseBlame(entry(changes)), /行号/);
    assert.throws(() => parseBlame(entry() + entry({ original: 2, line: 3 })), /不连续/);
    assert.throws(() => parseBlame(entry({ extra: 'previous invalid file.txt\n' })), /前序/);
});

test('blame parser rejects malformed quoting, invalid UTF-8 bytes and NUL pathnames', () => {
    for (const name of ['"unterminated', '"ok" trailing', '"bad\\x41"', '"bad\\u4e2d"', '"bad\\12"', '"bad\\400"', '"bad\\377"', '"bad\\300\\257"', '"bad\\000"', '""', 'bad\tname', 'bad\\name', '\ud800']) {
        assert.throws(() => parseBlame(entry({ name })), /路径/, name);
    }
});

test('blame parser rejects invalid dates, email envelopes and boundary records without hiding damage', () => {
    const valid = entry();
    for (const raw of [
        valid.replace('author-time 1704067200', 'author-time not-a-date'),
        valid.replace('author-time 1704067200', 'author-time 9007199254740992'),
        valid.replace('author-tz +0800', 'author-tz +1260'),
        valid.replace('committer-tz -0700', 'committer-tz +2400'),
        valid.replace('author-mail <author@example.invalid>', 'author-mail author@example.invalid'),
        entry({ extra: 'boundary yes\n' }), entry({ extra: 'boundary\nboundary\n' }),
    ]) assert.throws(() => parseBlame(raw), /行来源/);
});
