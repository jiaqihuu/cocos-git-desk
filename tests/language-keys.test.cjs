const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GitDesk } = require('../dist/git');

const work = path.resolve(__dirname, '../.test-work');
process.env.GIT_CONFIG_NOSYSTEM = '1';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd();
async function write(repo, name, content) { await fs.mkdir(path.dirname(path.join(repo, name)), { recursive: true }); await fs.writeFile(path.join(repo, name), content); }
const json = value => JSON.stringify(value, null, 2) + '\n';
async function fixture(t) {
    await fs.mkdir(work, { recursive: true });
    const base = await fs.mkdtemp(path.join(work, 'lang-'));
    const repo = path.join(base, 'project'); await fs.mkdir(repo, { recursive: true });
    git(repo, 'init', '-b', 'dev'); git(repo, 'config', 'user.name', 'Seed Author'); git(repo, 'config', 'user.email', 't@example.invalid'); git(repo, 'config', 'commit.gpgSign', 'false');
    const dir = 'assets/resources/language/json/';
    await write(repo, dir + 'en.json', json({ txt_a: 'Hi {1}', txt_old: 'Old' })); await write(repo, dir + 'zh.json', json({ txt_a: '你好', txt_old: '舊' }));
    await write(repo, dir + 'zh_CN.json', json({ txt_a: '你好 {1}', txt_old: '旧' })); await write(repo, dir + 'th.json', json({ txt_a: 'สวัสดี {1}' }));
    await write(repo, 'assets/hall/script/View.ts', 'export const a = i18n.t("txt_a");\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'seed keys');
    const desk = new GitDesk(repo, path.join(base, 'cache'), { async checkEditor() {}, async beforeWorktreeChange() {}, async afterWorktreeChange() {} });
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    return { repo, desk, dir, base };
}
// What main.ts passes from git-desk.config.json (i18n section); the tool itself never hard-codes a key pattern.
const i18n = { keyPattern: '\\btxt_[a-z0-9_]+\\b', languages: ['en', 'zh', 'zh_CN', 'th'] };
test('keys added by the uncommitted change are discovered with usages, fallback coverage and a CSV draft', async t => {
    const { repo, desk, dir } = await fixture(t);
    await write(repo, 'assets/hall/script/View.ts', 'export const a = i18n.t("txt_a");\nexport const b = i18n.format("txt_new", 3);\n');
    await write(repo, dir + 'en.json', json({ txt_a: 'Hi {1}', txt_old: 'Old', txt_new: 'New {1}' }));
    await write(repo, 'assets/hall/script/Fresh.ts', 'i18n.t("txt_untracked");\n');
    const audit = await desk.languageKeys('.', { ...i18n, csv: true });
    assert.match(audit.source, /未提交改动/); assert.deepEqual(audit.languages, ['en', 'zh', 'zh_CN', 'th']);
    assert.deepEqual(audit.keys.map(k => k.key), ['txt_new', 'txt_untracked']);
    const fresh = audit.keys[0];
    assert.equal(fresh.usageCount, 1); assert.deepEqual(fresh.usages[0], { file: 'assets/hall/script/View.ts', line: 2, text: 'export const b = i18n.format("txt_new", 3);' });
    assert.deepEqual(fresh.local, { en: 'New {1}', zh: null, zh_CN: null, th: null }); assert.deepEqual(fresh.missing, ['zh', 'zh_CN', 'th']); assert.equal(fresh.firstSeen, null, 'not committed yet');
    assert.equal(audit.keys[1].usageCount, 1); assert.equal(audit.keys[1].usages[0].file, 'assets/hall/script/Fresh.ts');
    const rows = audit.csv.trim().split('\n');
    assert.deepEqual(rows, ['key,en,zh', 'txt_new,New {1},', 'txt_untracked,,'], 'default columns, one row per key that lacks a language');
    const custom = await desk.languageKeys('.', { ...i18n, keys: ['txt_new', 'txt_a'], csv: 'all', csvColumns: ['key', 'usage', 'th', 'status'] });
    assert.deepEqual(custom.csv.trim().split('\n'), ['key,usage,th,status', 'txt_new,assets/hall/script/View.ts:2,,missing: zh zh_CN th', 'txt_a,assets/hall/script/View.ts:1,สวัสดี {1},present']);
    assert.equal((await desk.languageKeys('.', { ...i18n, keys: ['txt_a'], csv: true })).csv, 'key,en,zh\n', 'csv=missing leaves out keys every language has');
    assert.match(audit.note, /i18n\.csvColumns/); assert.doesNotMatch(audit.note, /amsl|amsa/i);
});
test('a per-language layout drafts one row per key and language with custom headers and status texts', async t => {
    const { repo, desk, dir } = await fixture(t);
    await write(repo, 'assets/hall/script/View.ts', 'export const a = i18n.t("txt_a");\nexport const b = i18n.format("txt_new", 3);\n');
    await write(repo, dir + 'en.json', json({ txt_a: 'Hi {1}', txt_old: 'Old', txt_new: 'New, "quoted" {1}' }));
    // The shape a translation back end may import: key, scene, language, text, status, with its own headers.
    const columns = ['key', { field: 'usage', header: '使用场景' }, { field: 'language', header: '语言' }, { field: 'text', header: '文案' }, { field: 'status', header: '状态' }];
    const status = { missing: '待翻译', present: '本地已有-待后台确认' };
    const missing = await desk.languageKeys('.', { ...i18n, keys: ['txt_new'], csv: true, csvLayout: 'perLanguage', csvColumns: columns, csvStatus: status });
    assert.deepEqual(missing.csv.trim().split('\n'), ['key,使用场景,语言,文案,状态', 'txt_new,assets/hall/script/View.ts:2,zh,,待翻译', 'txt_new,assets/hall/script/View.ts:2,zh_CN,,待翻译', 'txt_new,assets/hall/script/View.ts:2,th,,待翻译'], 'csv=missing keeps only the languages that lack the key');
    const all = (await desk.languageKeys('.', { ...i18n, keys: ['txt_new'], csv: 'all', csvLayout: 'perLanguage', csvColumns: columns, csvStatus: status })).csv.trim().split('\n');
    assert.equal(all.length, 5); assert.equal(all[1], 'txt_new,assets/hall/script/View.ts:2,en,"New, ""quoted"" {1}",本地已有-待后台确认', 'present languages are kept and quoted as CSV');
    const defaults = await desk.languageKeys('.', { ...i18n, keys: ['txt_a'], csv: 'all', csvLayout: 'perLanguage' });
    assert.deepEqual(defaults.csv.trim().split('\n').slice(0, 2), ['key,usage,language,text,status', 'txt_a,assets/hall/script/View.ts:1,en,Hi {1},present']);
});
test('explicit keys report history, placeholder mismatches and since-revision discovery', async t => {
    const { repo, desk } = await fixture(t);
    const seed = git(repo, 'rev-parse', '--short', 'HEAD');
    const audit = await desk.languageKeys('.', { ...i18n, keys: ['txt_a', 'txt_old', 'txt_none'] });
    const [a, old, none] = audit.keys;
    assert.equal(a.firstSeen.commit, seed); assert.equal(a.firstSeen.author, 'Seed Author'); assert.equal(a.firstSeen.subject, 'seed keys');
    assert.deepEqual(a.placeholders, { en: ['{1}'], zh: [], zh_CN: ['{1}'], th: ['{1}'] }); assert.equal(a.placeholderMismatch, true);
    assert.deepEqual(old.missing, ['th']); assert.equal(old.usageCount, 0); assert.equal(old.placeholderMismatch, false);
    assert.deepEqual(none.missing, ['en', 'zh', 'zh_CN', 'th']); assert.equal(none.firstSeen, null);
    assert.equal((await desk.languageKeys('.', { ...i18n, keys: ['txt_a'], history: false })).keys[0].firstSeen, 'skipped');
    await write(repo, 'assets/hall/script/View.ts', 'i18n.t("txt_a");\ni18n.t("txt_later");\nconst other = "lab_not_matched";\n'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'later');
    const since = await desk.languageKeys('.', { ...i18n, since: seed, history: false });
    assert.deepEqual(since.keys.map(k => k.key), ['txt_later'], 'only the configured pattern counts as a key'); assert.match(since.source, new RegExp('自 ' + seed));
    assert.equal(since.csv, undefined);
});
test('the key pattern, fallback directory and languages come from the options; nothing is assumed', async t => {
    const { repo, desk } = await fixture(t);
    await assert.rejects(desk.languageKeys('.', {}), /i18n\.keyPattern/, 'no pattern configured: a clear error instead of a guessed one');
    await assert.rejects(desk.languageKeys('.', { keyPattern: '(' }), /不是合法的正则表达式/);
    const found = await desk.languageKeys('.', { keyPattern: '\\btxt_[a-z]+\\b', keys: ['txt_a'], history: false });
    assert.deepEqual(found.languages, ['en', 'th', 'zh', 'zh_CN'], 'without languages every json file in the directory is audited');
    await write(repo, 'assets/hall/script/Loud.ts', 'i18n.t("TXT_Shout");\n');
    assert.deepEqual((await desk.languageKeys('.', { keyPattern: '\\btxt_[a-z]+\\b', history: false })).keys, [], 'a bare pattern is case-sensitive');
    const flagged = await desk.languageKeys('.', { keyPattern: '/\\btxt_[a-z]+\\b/i', history: false });
    assert.deepEqual(flagged.keys.map(k => k.key), ['TXT_Shout'], 'a /body/flags pattern keeps its flags');
    await write(repo, 'i18n/fr.json', json({ txt_a: 'Salut {1}' }));
    const moved = await desk.languageKeys('.', { keyPattern: '\\btxt_[a-z]+\\b', directory: 'i18n', keys: ['txt_a'], history: false });
    assert.deepEqual(moved.languages, ['fr']); assert.deepEqual(moved.files, { fr: 'i18n/fr.json' }); assert.deepEqual(moved.keys[0].local, { fr: 'Salut {1}' });
    await assert.rejects(desk.languageKeys('.', { keyPattern: '\\btxt_[a-z]+\\b', directory: 'missing/dir', keys: ['txt_a'] }), /missing\/dir/);
});
