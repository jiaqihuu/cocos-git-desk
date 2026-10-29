const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const i18n = require('../dist/i18n');
const { localizeElement } = require('../dist/panel-i18n');

const decode = text => text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const ATTRIBUTES = { 'data-i18n-title': 'title', 'data-i18n-aria': 'aria-label', 'data-i18n-placeholder': 'placeholder' };
// Every static text in a panel's markup names a message id whose Chinese text is the inline original.
function checkMarkup(file) {
    const html = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    let checked = 0;
    for (const match of html.matchAll(/<([a-z0-9-]+)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*\/?>/g)) {
        const [whole, tag, source] = match, attrs = {};
        for (const attr of source.matchAll(/([^\s=>]+)(?:="([^"]*)")?/g)) attrs[attr[1]] = attr[2] ?? '';
        for (const [data, real] of Object.entries(ATTRIBUTES)) if (data in attrs) {
            checked++;
            assert.ok(i18n.has(attrs[data]), file + ': unknown id ' + attrs[data]);
            assert.equal(i18n.t(attrs[data]), decode(attrs[real] || ''), file + ': ' + attrs[data]);
        }
        if ('data-i18n' in attrs) {
            checked++;
            const rest = html.slice(match.index + whole.length), inner = rest.slice(0, rest.indexOf('</' + tag));
            const own = inner.includes('<') ? (inner.slice(0, inner.indexOf('<')) + inner.slice(inner.lastIndexOf('>') + 1)).trim() : inner;
            assert.ok(i18n.has(attrs['data-i18n']), file + ': unknown id ' + attrs['data-i18n']);
            assert.equal(i18n.t(attrs['data-i18n']), decode(own), file + ': ' + attrs['data-i18n']);
        }
    }
    return { html, checked };
}
test('panel markup names a message id for every static text and keeps the Chinese original inline', () => {
    const { html, checked } = checkMarkup('static/panel.html');
    assert.ok(checked > 300);
    const uncovered = html.replace(/<([a-z0-9-]+)[^>]*\sdata-i18n="[^"]*"[^>]*>[^<]*/g, '').replace(/\s(title|aria-label|placeholder)="[^"]*"/g, '').replace(/<[a-z][^>]*>|<\/[a-z0-9-]+>/gi, '\n');
    assert.deepEqual(uncovered.split('\n').map(line => line.trim()).filter(line => /[一-鿿]/.test(line) && !/^<|[{}]/.test(line)).filter(line => !/^(允许此合并提交纳入已暂存的子模块指针|本次提交包含已暂存的子模块指针|恢复原暂存区状态)$/.test(line)), []);
});
function fakeElement(dataset, attrs, childNodes) {
    const element = { dataset, attrs: new Map(Object.entries(attrs)), childNodes, get children() { return childNodes.filter(node => node.nodeType === 1); },
        getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }, setAttribute(name, value) { this.attrs.set(name, String(value)); },
        set textContent(value) { childNodes.splice(0, childNodes.length, { nodeType: 3, textContent: value }); }, get textContent() { return childNodes.map(node => node.textContent).join(''); } };
    return element;
}
test('localizeElement replaces own text and attributes but keeps child controls', () => {
    i18n.register('zh', { 'test.panelLabel': '标签', 'test.panelTitle': '提示' });
    i18n.register('en', { 'test.panelLabel': 'Label', 'test.panelTitle': 'Hint' });
    const input = { nodeType: 1, textContent: '' };
    const label = fakeElement({ i18n: 'test.panelLabel' }, {}, [{ nodeType: 3, textContent: '  ' }, input, { nodeType: 3, textContent: '标签' }]);
    const leaf = fakeElement({ i18n: 'test.panelLabel' }, { 'data-i18n-title': 'test.panelTitle', 'data-i18n-aria': 'test.panelTitle', title: '提示', 'aria-label': '提示' }, []);
    const root = { querySelectorAll: selector => selector === '[data-i18n]' ? [label, leaf] : [leaf].filter(element => element.attrs.has(selector.slice(1, -1))) };
    i18n.setLanguage('en');
    try { localizeElement(root); } finally { i18n.setLanguage(undefined); }
    assert.equal(label.childNodes[1], input); assert.equal(label.childNodes[2].textContent, 'Label'); assert.equal(label.childNodes[0].textContent, '  ');
    assert.equal(leaf.textContent, 'Label'); assert.equal(leaf.getAttribute('title'), 'Hint'); assert.equal(leaf.getAttribute('aria-label'), 'Hint');
});
module.exports = { checkMarkup };
