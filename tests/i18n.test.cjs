const { test } = require('node:test');
const assert = require('node:assert/strict');
const i18n = require('../dist/i18n');

test('npm test preloads the Chinese language for every test process', () => {
    assert.equal(process.env.GIT_DESK_LANG, 'zh');
    assert.equal(i18n.language(), 'zh');
});
test('every message id exists in both languages', () => {
    assert.deepEqual(i18n.missing(), { en: [], zh: [] });
});
test('translation fills placeholders, falls back across languages and keeps unknown ids', () => {
    i18n.register('zh', { 'test.greeting': '你好，{name}', 'test.zhOnly': '仅中文' });
    i18n.register('en', { 'test.greeting': 'Hello, {name}', 'test.enOnly': 'English only' });
    i18n.setLanguage('en');
    try {
        assert.equal(i18n.t('test.greeting', { name: 'A' }), 'Hello, A');
        assert.equal(i18n.t('test.zhOnly'), '仅中文');
        assert.equal(i18n.t('test.unknown'), 'test.unknown');
        assert.equal(i18n.t('test.greeting'), 'Hello, {name}');
        const error = new i18n.MessageError('test.greeting', { name: 'B' });
        assert.equal(error.message, 'Hello, B'); assert.equal(error.id, 'test.greeting');
    } finally { i18n.setLanguage(undefined); }
    assert.equal(i18n.t('test.enOnly'), 'English only');
    assert.throws(() => i18n.register('en', { 'test.greeting': 'other' }), /duplicate/);
});
test('language detection prefers the forced value, then the environment, then the editor', () => {
    const saved = process.env.GIT_DESK_LANG;
    try {
        process.env.GIT_DESK_LANG = 'en'; assert.equal(i18n.language(), 'en');
        delete process.env.GIT_DESK_LANG;
        globalThis.Editor = { I18n: { getLanguage: () => 'zh-CN' } }; assert.equal(i18n.language(), 'zh');
        globalThis.Editor = { I18n: { getLanguage: () => 'fr' } }; assert.equal(i18n.language(), 'en');
        delete globalThis.Editor; assert.equal(i18n.language(), 'en');
        i18n.setLanguage('zh'); process.env.GIT_DESK_LANG = 'en'; assert.equal(i18n.language(), 'zh');
    } finally { i18n.setLanguage(undefined); if (saved === undefined) delete process.env.GIT_DESK_LANG; else process.env.GIT_DESK_LANG = saved; }
});
