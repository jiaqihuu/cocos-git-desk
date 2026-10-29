const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
fs.mkdirSync(path.resolve(__dirname, '../.cache'), { recursive: true });
const { createRequire } = require('node:module');
const { WarningPreferences, groupPlanWarnings, canRepeatUpdate } = require('../dist/panel-warnings');

test('repeat update requires separate confirmation, unchanged guidance and a fresh safe plan', () => {
    const plan = { token: 'single-use', warnings: ['规则'], generalWarnings: ['规则'], paths: [], expiresAt: 200, repeatConfirmationKey: 'project-scope-rules' };
    assert.equal(canRepeatUpdate('updateAll', plan, true, ['规则'], 100), true);
    assert.equal(canRepeatUpdate('updateAll', plan, false, ['规则'], 100), false);
    assert.equal(canRepeatUpdate('updateAll', plan, true, [], 100), false);
    assert.equal(canRepeatUpdate('forkResetDev', plan, true, ['规则'], 100), false);
    for (const change of [{ expiresAt: 50 }, { repeatConfirmationKey: undefined }, { generalWarnings: undefined }, { paths: ['file.txt'] }, { patch: 'patch' }, { warnings: ['规则', '本次风险'] }]) {
        assert.equal(canRepeatUpdate('updateAll', { ...plan, ...change }, true, ['规则'], 100), false);
    }
});

test('reading warnings does not grant repeat execution; changed scope requires new confirmation', t => {
    const folder = fs.mkdtempSync(path.resolve(__dirname, '../.cache/warning-test-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const files = ['warnings.json', 'legacy.json', 'confirmations.json'].map(name => path.join(folder, name));
    const preferences = new WarningPreferences(...files);
    preferences.acknowledge('updateAll', ['已读说明']);
    assert.equal(preferences.confirmedUpdate('scope-a'), false);
    preferences.confirmUpdate('scope-a');
    const reopened = new WarningPreferences(...files);
    assert.equal(reopened.confirmedUpdate('scope-a'), true);
    assert.equal(reopened.confirmedUpdate('scope-b'), false);
});

test('panel repeat path executes only a current reviewed plan and never bypasses a new risk or changed context', async () => {
    const filename = path.resolve(__dirname, '../dist/panel.js');
    const context = { exports: {}, module: { exports: {} }, require: createRequire(filename), __dirname: path.dirname(filename), Editor: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.Controller = Controller;', context, { filename });
    const run = context.module.exports.Controller.prototype.prepareWorktreeOperation;
    async function fixture({ confirmed = true, risk = false, drift = false } = {}) {
        const nodes = new Map(), calls = [];
        const plan = { token: 'fresh-token', title: 'preview', description: '', paths: [], warnings: risk ? ['规则', '新风险'] : ['规则'], generalWarnings: ['规则'], repeatConfirmationKey: 'scope', expiresAt: Date.now() + 60000 };
        const fake = {
            details: { repo: { version: 'v1' } }, closed: false, busy: false, planning: false, repoId: '.', epoch: 1, dialogEpoch: 0,
            el(id) { if (!nodes.has(id)) nodes.set(id, { hidden: true }); return nodes.get(id); },
            cancelDialog() { this.dialogEpoch++; }, updateButtons() {}, error(error) { throw error; },
            warningPreferences: { read: () => ['规则'], confirmedUpdate: () => confirmed },
            async requestPlan() { if (drift) this.epoch++; return plan; },
            async executePlan(value) { calls.push(value.token); }, renderPlanWarnings() {},
        };
        await run.call(fake, { repo: '.', version: 'v1', action: 'updateAll' });
        return { calls, visible: !fake.el('modal').hidden };
    }
    assert.deepEqual((await fixture()).calls, ['fresh-token']);
    for (const input of [{ confirmed: false }, { risk: true }]) {
        const result = await fixture(input); assert.deepEqual(result.calls, []); assert.equal(result.visible, true);
    }
    const changed = await fixture({ drift: true }); assert.deepEqual(changed.calls, []); assert.equal(changed.visible, false);
});

test('only explicitly classified, previously acknowledged guidance folds', () => {
    const plan = { warnings: ['通用说明', '本次扩展范围', '新增通用说明'], generalWarnings: ['通用说明', '新增通用说明'] };
    const result = groupPlanWarnings(plan, ['通用说明', '本次扩展范围']);
    assert.deepEqual(result.known, ['通用说明']);
    assert.deepEqual(result.fresh, ['本次扩展范围', '新增通用说明']);
    assert.deepEqual(result.general, ['通用说明', '新增通用说明']);
    assert.deepEqual(groupPlanWarnings({ warnings: ['旧服务提示'] }, ['旧服务提示']).fresh, ['旧服务提示']);
});

test('first preview and changed guidance remain visible', () => {
    const plan = { warnings: ['说明 v2', '当前风险'], generalWarnings: ['说明 v2'] };
    assert.deepEqual(groupPlanWarnings(plan, []).fresh, plan.warnings);
    assert.deepEqual(groupPlanWarnings(plan, ['说明 v1']).fresh, plan.warnings);
    assert.deepEqual(groupPlanWarnings(plan, ['说明 v2']).fresh, ['当前风险']);
});

test('acknowledgment survives reload and stays isolated by operation', t => {
    const folder = fs.mkdtempSync(path.resolve(__dirname, '../.cache/warning-test-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const filename = path.join(folder, 'preferences.json'), legacy = path.join(folder, 'legacy.json');
    const preferences = new WarningPreferences(filename, legacy);
    assert.deepEqual(preferences.read('pull'), []);
    assert.equal(fs.existsSync(filename), false);
    preferences.acknowledge('pull', ['通用说明']);
    preferences.acknowledge('push', ['推送说明']);
    const reopened = new WarningPreferences(filename, legacy);
    assert.deepEqual(reopened.read('pull'), ['通用说明']);
    assert.deepEqual(reopened.read('push'), ['推送说明']);
    assert.deepEqual(reopened.read('switch'), []);
});

test('legacy update preference applies only to updateAll and does not hide a new warning', t => {
    const folder = fs.mkdtempSync(path.resolve(__dirname, '../.cache/warning-test-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const filename = path.join(folder, 'preferences.json'), legacy = path.join(folder, 'legacy.json');
    fs.writeFileSync(legacy, JSON.stringify(['旧说明']));
    const preferences = new WarningPreferences(filename, legacy);
    assert.deepEqual(preferences.read('updateAll'), ['旧说明']);
    assert.deepEqual(preferences.read('pull'), []);
    const result = groupPlanWarnings({ warnings: ['旧说明', '新风险'], generalWarnings: ['旧说明'] }, preferences.read('updateAll'));
    assert.deepEqual(result.known, ['旧说明']); assert.deepEqual(result.fresh, ['新风险']);
    preferences.acknowledge('updateAll', ['新说明']);
    assert.deepEqual(preferences.read('updateAll'), ['新说明']);
});

test('invalid preference data leaves all guidance visible', t => {
    const folder = fs.mkdtempSync(path.resolve(__dirname, '../.cache/warning-test-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const filename = path.join(folder, 'preferences.json');
    fs.writeFileSync(filename, '{"pull":[7]}');
    const original = console.warn; console.warn = () => {};
    try {
        const preferences = new WarningPreferences(filename, path.join(folder, 'missing'));
        assert.deepEqual(groupPlanWarnings({ warnings: ['说明'], generalWarnings: ['说明'] }, preferences.read('pull')).fresh, ['说明']);
    } finally { console.warn = original; }
});
