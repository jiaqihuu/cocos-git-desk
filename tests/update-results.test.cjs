const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { UpdateResultStore, updateResultTime } = require('../dist/update-results');
const { GitDesk } = require('../dist/git');

function folder(t) {
    const value = fs.mkdtempSync(path.resolve(__dirname, '../.cache/result-test-'));
    t.after(() => fs.rmSync(value, { recursive: true, force: true }));
    return value;
}
function task(status = 'success') {
    return { id: 'job', title: '快进更新全部仓库', status, log: '完成', startedAt: '2026-10-23T17:59:00.000Z', finishedAt: '2026-10-23T18:00:00.000Z', repositories: [{ id: '.', status, phase: '结束', detail: '', branch: 'dev' }] };
}

test('completed result persists by project and replacement survives reopening the store', t => {
    const cache = folder(t), project = path.join(cache, 'project-a'), store = new UpdateResultStore(cache, project);
    assert.equal(store.read(), undefined);
    assert.equal(store.save(task()), true);
    assert.deepEqual(new UpdateResultStore(cache, project).read(), task());
    assert.equal(new UpdateResultStore(cache, path.join(cache, 'project-b')).read(), undefined);
    assert.equal(store.save(task('failed')), true);
    assert.deepEqual(new UpdateResultStore(cache, project).read(), task('failed'));
    assert.equal(fs.readdirSync(path.join(cache, 'update-results')).filter(name => name.endsWith('.tmp')).length, 0);
});

test('corrupt or running results are not presented as completed history', t => {
    const cache = folder(t), store = new UpdateResultStore(cache, path.join(cache, 'project'));
    const warn = console.warn; console.warn = () => {};
    try {
        assert.equal(store.save(task('running')), false);
        assert.equal(store.read(), undefined);
        assert.equal(store.save(task()), true);
        const filename = path.join(cache, 'update-results', fs.readdirSync(path.join(cache, 'update-results'))[0]);
        fs.writeFileSync(filename, '{broken');
        assert.equal(store.read(), undefined);
    } finally { console.warn = warn; }
});

test('result time includes a concrete date and Shanghai timezone, including midnight rollover', () => {
    assert.equal(updateResultTime(task()).label, '完成于 2026-10-24 02:00:00（UTC+08:00）');
    assert.equal(updateResultTime(task('failed')).label, '结束于 2026-10-24 02:00:00（UTC+08:00）');
    assert.equal(updateResultTime({ ...task(), status: 'running', finishedAt: undefined }).label, '开始于 2026-10-24 01:59:00（UTC+08:00）');
});

test('background task completion saves history independently of the panel and later ordinary tasks', async t => {
    const cache = folder(t), project = path.join(cache, 'project'), host = {};
    const desk = new GitDesk(project, cache, host);
    desk.run = async () => { for (const row of desk.taskState.repositories || []) { row.status = 'success'; row.phase = '已完成'; } };
    desk.plans.set('update', { request: { action: 'updateAll' }, public: { title: '更新', expiresAt: Date.now() + 60000 }, projectUpdate: { entries: [{ id: '.', branch: 'dev', detail: '' }] } });
    desk.execute('update'); await new Promise(resolve => setImmediate(resolve));
    const stored = new UpdateResultStore(cache, project).read();
    assert.equal(stored.status, 'success'); assert.ok(stored.finishedAt);
    desk.plans.set('ordinary', { request: { action: 'fetch' }, public: { title: '普通操作', expiresAt: Date.now() + 60000 } });
    desk.execute('ordinary'); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(new UpdateResultStore(cache, project).read(), stored);
    const reopened = new GitDesk(project, cache, host); reopened.scan = async () => [];
    const snapshot = await reopened.snapshot();
    assert.equal(snapshot.task, null); assert.deepEqual(snapshot.lastProjectUpdate, stored);
    snapshot.lastProjectUpdate.repositories[0].detail = 'client mutation';
    assert.equal((await reopened.snapshot()).lastProjectUpdate.repositories[0].detail, '');
});

test('legacy preflight failures display as unstarted repositories without rewriting original evidence', () => {
    const {updateResultForDisplay,updateResultCounts}=require('../dist/update-results');
    const original={...task('failed'),log:'预览后仓库发生变化，请重新确认操作。',repositories:[{id:'.',status:'failed',phase:'已停止',detail:'预览后仓库发生变化，请重新确认操作。'}]};
    const shown=updateResultForDisplay(original);
    assert.equal(shown.recovery,'repreview');assert.equal(shown.repositories[0].phase,'未执行');assert.equal(shown.repositories[0].status,'skipped');
    assert.equal(original.repositories[0].status,'failed');assert.equal(shown.log,original.log);
    assert.match(updateResultCounts(shown.repositories),/失败 0 · 跳过 0 · 未执行 1/);
    const realFailure={...original,repositories:[{id:'.',status:'failed',phase:'未完成',detail:'恢复 Stash 冲突'}]};
    assert.equal(updateResultForDisplay(realFailure),realFailure);
});
test('project preflight abort preserves real failures and marks only queued repositories unstarted', async t => {
    const {ProjectUpdateStateChangedError}=require('../dist/project-update');
    const cache=folder(t),desk=new GitDesk(path.join(cache,'project'),cache,{});
    desk.run=async()=>{throw new ProjectUpdateStateChangedError('仓库 lib：预览后本地状态变化（文件内容）');};
    desk.plans.set('update',{request:{action:'updateAll'},public:{title:'快进更新全部仓库',expiresAt:Date.now()+60000},projectUpdate:{entries:[{id:'.',branch:'dev',detail:''},{id:'lib',branch:'dev',detail:''}]}});
    desk.execute('update');await new Promise(resolve=>setImmediate(resolve));
    const result=desk.task();assert.equal(result.recovery,'repreview');assert.ok(result.repositories.every(row=>row.status==='skipped'&&row.phase==='未执行'));
    const saved=new UpdateResultStore(cache,path.join(cache,'project')).read();assert.equal(saved.recovery,'repreview');
});
