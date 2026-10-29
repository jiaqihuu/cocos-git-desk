// Runs without tests/zh.cjs: the default language outside a Chinese editor must be English.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const i18n = require('../dist/i18n');
test('English is the default language and every id has an English text', () => {
    delete process.env.GIT_DESK_LANG;
    assert.equal(i18n.language(), 'en');
    assert.deepEqual(i18n.missing().en, []);
});
