const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const filename = path.resolve(__dirname, '../dist/panel.js');
const context = { exports: {}, module: { exports: {} }, require: createRequire(filename), __dirname: path.dirname(filename), Editor: {} };
vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.Controller = Controller;', context, { filename });
const Controller = context.module.exports.Controller;

function fixture() {
    const fields = new Map(), row = { textContent: '', dataset: {}, querySelector() { return null; } };
    const c = Object.create(Controller.prototype);
    Object.assign(c, {
        app: { querySelector() { return null; }, querySelectorAll() { return []; } },
        busy: false, scopeReviewOpening: false, projectUpdateHidden: 'job', projectUpdateTask: 'job', projectUpdateRows: new Map([['.', row]]),
        el(id) {
            if (!fields.has(id)) fields.set(id, { hidden: true, textContent: '', dataset: {}, classList: { toggle() {}, remove() {} }, setAttribute() {}, replaceChildren() {}, focus() {} });
            return fields.get(id);
        }, updateButtons() {}, renderUpdateFailure() {}, renderGeneralUpdateFailure() {},
    });
    return c;
}
const task = status => ({ id: 'job', title: '快进更新', status, log: '', repositories: [{ id: '.', branch: 'dev', status: status === 'running' ? 'running' : 'success', phase: '更新' }] });

test('running update restores hidden progress, blocks close, then permits close after completion', () => {
    const c = fixture();
    c.renderTask(task('running'));
    assert.equal(c.el('project-update-progress').hidden, false);
    assert.equal(c.el('project-update-close').hidden, true);
    assert.equal(c.el('project-update-close').disabled, true);
    c.closeProjectUpdate();
    assert.equal(c.el('project-update-progress').hidden, false);
    assert.equal(c.projectUpdateHidden, '');
    c.renderTask(task('success'));
    assert.equal(c.el('project-update-close').hidden, false);
    assert.equal(c.el('project-update-close').disabled, false);
    c.closeProjectUpdate();
    assert.equal(c.el('project-update-progress').hidden, true);
    c.renderTask(task('success'));
    assert.equal(c.el('project-update-progress').hidden, true);
    c.renderTask(task('running'));
    assert.equal(c.el('project-update-progress').hidden, false);
});

test('each preview expands repositories and collapses files independently of the previous preview', () => {
    const c = fixture(); c.warningPreferences = { read: () => [] };
    const plan = { token: 'preview', description: '', paths: ['one.txt'], repositories: ['. · dev', 'module · dev'], warnings: [], generalWarnings: [] };
    for (let attempt = 0; attempt < 2; attempt++) {
        c.el('plan-repositories-wrap').open = false;
        c.el('plan-files-wrap').open = true;
        c.renderPlanWarnings(plan, 'forkSmartGit');
        assert.equal(c.el('plan-repositories-wrap').open, true);
        assert.equal(c.el('plan-repositories-count').textContent, '仓库 · 2');
        assert.equal(c.el('plan-files-wrap').open, false);
        assert.equal(c.el('plan-files-count').textContent, '文件 · 1');
    }
});

test('toolbar reopens the last update result after close and after a different task without changing task state', () => {
    const c = fixture();
    c.openProjectUpdate();
    assert.equal(c.el('project-update-progress').hidden, true);
    c.renderTask(task('success')); c.closeProjectUpdate();
    assert.equal(c.el('project-update-open').disabled, false);
    c.el('project-update-progress').classList.add = () => {};
    c.openProjectUpdate();
    assert.equal(c.el('project-update-progress').hidden, false);
    assert.equal(c.projectUpdateHidden, '');
    c.closeProjectUpdate();
    c.renderTask({ id: 'other-job', title: '其他操作', status: 'running', log: 'other task' });
    assert.equal(c.busy, true);
    assert.equal(c.el('project-update-progress').hidden, true);
    c.openProjectUpdate();
    assert.equal(c.el('project-update-progress').hidden, false);
    assert.equal(c.busy, true);
    assert.equal(c.taskId, 'other-job');
    assert.equal(c.el('log').textContent, 'other task');
    assert.match(c.el('project-update-summary').textContent, /已完成/);
});

test('toolbar entry is unavailable before any project update result exists', () => {
    const c = fixture(); c.projectUpdateRows.clear();
    c.renderTask(null);
    assert.equal(c.el('project-update-open').disabled, true);
    assert.equal(c.el('project-update-progress').hidden, true);
});

test('toolbar toggles ended results, reports state/time/counts, and keeps a running update visible', () => {
    const c = fixture();
    const result = { ...task('failed'), startedAt: '2026-10-23T18:00:00Z', finishedAt: '2026-10-23T18:01:00Z',
        repositories: [
            { id: '.', status: 'success', phase: '', detail: '' },
            { id: 'failed', status: 'failed', phase: '', detail: '' },
            { id: 'skipped', status: 'skipped', phase: '', detail: '' },
        ] };
    for (const row of result.repositories) c.projectUpdateRows.set(row.id, { textContent: '', dataset: {}, querySelector() { return null; } });
    c.renderTask(result);
    const button = c.el('project-update-open');
    assert.equal(button.dataset.state, 'failed');
    assert.match(button.title, /2026-10-24 02:01:00/);
    assert.match(button.title, /成功 1 · 失败 1 · 跳过 1/);
    c.closeProjectUpdate();
    c.toggleProjectUpdate(); assert.equal(c.el('project-update-progress').hidden, false);
    assert.match(button.title, /点击关闭/);
    c.toggleProjectUpdate(); assert.equal(c.el('project-update-progress').hidden, true);
    assert.match(button.title, /点击打开/);
    c.renderTask(task('running'));
    assert.equal(button.dataset.state, 'running');
    c.toggleProjectUpdate(); assert.equal(c.el('project-update-progress').hidden, false);
    c.renderTask(task('success')); assert.equal(button.dataset.state, 'success');
});

test('all-success completion hides results once and polling preserves manual reopening', () => {
    const c = fixture();
    c.renderTask(task('running')); c.renderTask(task('success'));
    assert.equal(c.el('project-update-progress').hidden, true);
    assert.equal(c.el('project-update-open').disabled, false);
    c.openProjectUpdate(); c.renderTask(task('success'));
    assert.equal(c.el('project-update-progress').hidden, false);
});

test('failed completion expands reasons once, and skipped results are hidden without failures', () => {
    const c = fixture(), box = c.el('project-update-progress');
    const removed = []; box.classList.remove = name => removed.push(name);
    c.renderTask(task('running')); removed.length = 0;
    c.renderTask({ ...task('failed'), repositories: [{ id: '.', status: 'failed', phase: '失败', detail: '具体原因' }] });
    assert.equal(box.hidden, false); assert.ok(removed.includes('collapsed'));
    c.closeProjectUpdate();
    c.renderTask({ ...task('failed'), repositories: [{ id: '.', status: 'failed', phase: '失败', detail: '具体原因' }] });
    assert.equal(box.hidden, true);
    c.renderTask(task('running'));
    c.renderTask({ ...task('success'), repositories: [{ id: '.', status: 'skipped', phase: '跳过', detail: '' }] });
    assert.equal(box.hidden, true);
});
