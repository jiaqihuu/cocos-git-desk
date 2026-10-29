const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareEditorForGit, checkEditorState, EditorPreparationRequiredError } = require('../dist/editor-preparation');
const { GitDesk } = require('../dist/git');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const clone = value => JSON.parse(JSON.stringify(value));
function fixture({ dirty = false, prefab = true } = {}) {
    let state = { dirty, scenes: [{ uuid: 'active', name: prefab ? 'Thing.prefab' : 'main.scene', type: prefab ? 'prefab' : 'scene', dirty }] }, current = 'active';
    const calls = [], data = { consent: true, failSave: false, failClose: false, locked: false };
    const host = {
        assertIdle() { if (data.locked) throw Error('busy'); },
        async confirm(detail) { calls.push(['confirm', detail]); return data.consent; },
        async request(channel, message, ...args) {
            calls.push([message, ...args]);
            if (message === 'query-dirty') return state.dirty;
            if (message === 'multi-scene-query') return clone(state.scenes);
            if (message === 'query-current-scene') return current;
            if (message === 'multi-save-all-scene') { if (!data.failSave) { state.dirty = false; state.scenes.forEach(s => { s.dirty = false; }); } return undefined; }
            if (message === 'multi-scene-focus') { current = args[0]; return undefined; }
            if (message === 'close-scene') {
                if (data.failClose) return false;
                state.scenes = state.scenes.filter(s => s.uuid !== current);
                // A dirty underlying scene is invisible until the Prefab closes.
                state.scenes.push({ uuid: 'underlying-' + current, name: 'underlying.scene', type: 'scene', dirty: true });
                current = 'underlying-' + current; state.dirty = true; return true;
            }
            throw Error('unexpected: ' + message);
        },
    };
    return { host, data, calls, state: () => state };
}
const writes = f => f.calls.filter(([m]) => ['multi-save-all-scene', 'close-scene', 'multi-scene-focus'].includes(m));
test('clean scene proceeds without dialog or writes; dirty state yields structured requirement', async () => {
    const f = fixture({ prefab: false }); assert.equal(await prepareEditorForGit(true, f.host), true); assert.equal(writes(f).length, 0); assert.ok(!f.calls.some(([m]) => m === 'confirm'));
    const g = fixture({ dirty: true }); await assert.rejects(checkEditorState(g.host.request, true), e => e instanceof EditorPreparationRequiredError && e.worktreeChange); assert.equal(writes(g).length, 0);
});
test('cancel never saves, exits or retries Git', async () => {
    const f = fixture({ dirty: true }); f.data.consent = false; assert.equal(await prepareEditorForGit(true, f.host), false); assert.equal(writes(f).length, 0); assert.equal(f.state().dirty, true);
});
test('consent saves Prefab then exits, then saves previously hidden underlying scene', async () => {
    const f = fixture({ dirty: true }); assert.equal(await prepareEditorForGit(true, f.host), true);
    assert.deepEqual(writes(f).map(([m]) => m), ['multi-save-all-scene', 'close-scene', 'multi-save-all-scene']);
    assert.ok(f.state().scenes.every(s => !s.dirty && s.type === 'scene')); assert.equal(f.state().dirty, false);
});
test('save-only operation leaves clean Prefab open; failure or save-as cancellation stops before closing', async () => {
    const f = fixture({ dirty: true }); assert.equal(await prepareEditorForGit(false, f.host), true); assert.equal(f.state().scenes[0].type, 'prefab'); assert.ok(!f.calls.some(([m]) => m === 'close-scene'));
    const g = fixture({ dirty: true }); g.data.failSave = true; await assert.rejects(prepareEditorForGit(true, g.host), /保存未完成/); assert.ok(!g.calls.some(([m]) => m === 'close-scene'));
});
test('close cancellation, tab change during confirmation, invalid state and busy host fail closed', async () => {
    const f = fixture(); f.data.failClose = true; await assert.rejects(prepareEditorForGit(true, f.host), /退出 Prefab 未完成/);
    const g = fixture(); g.host.confirm = async () => { g.state().scenes.push({ uuid: 'other', name: 'other.scene', type: 'scene', dirty: false }); return true; }; await assert.rejects(prepareEditorForGit(true, g.host), /标签已变化/); assert.equal(writes(g).length, 0);
    const h = fixture(); h.data.locked = true; await assert.rejects(prepareEditorForGit(true, h.host), /busy/); assert.equal(h.calls.length, 0);
    const i = fixture(); i.host.request = async () => null; await assert.rejects(prepareEditorForGit(true, i.host), /无法确认/);
});
test('multiple Prefab tabs focus and close exact targets; no ordinary scene is closed', async () => {
    const f = fixture(); f.state().scenes.push({ uuid: 'second', name: 'second.prefab', type: 'prefab', dirty: false });
    assert.equal(await prepareEditorForGit(true, f.host), true); assert.equal(f.calls.filter(([m]) => m === 'close-scene').length, 2);
    assert.ok(f.calls.some(([m, id]) => m === 'multi-scene-focus' && id === 'second')); assert.ok(f.state().scenes.every(s => s.type === 'scene'));
});
test('Git prepare and execute refuse work while editor recovery is active', async () => {
    const desk = new GitDesk('/nonexistent-fixture', path.resolve(__dirname, '../.cache/editor-preparation-test'), { assertAvailable() { throw Error('editor preparation busy'); }, checkEditor: async () => {}, beforeWorktreeChange: async () => {}, afterWorktreeChange: async () => {} });
    await assert.rejects(desk.prepare({ action: 'updateAll', repo: '.', version: 'v' }), /editor preparation busy/); assert.throws(() => desk.execute('none'), /editor preparation busy/);
});
function panelFixture(answer = true, drift = false) {
    const filename = path.resolve(__dirname, '../dist/panel.js'), code = fs.readFileSync(filename, 'utf8') + '\nmodule.exports.TestController = Controller;';
    const calls = [], repo = { id: '.', head: 'a'.repeat(40), branch: 'dev', path: '/fixture', version: 'before' };
    const context = { exports: {}, module: { exports: {} }, require: createRequire(filename), __dirname: path.dirname(filename), Editor: { Message: { async request(pkg, method, ...args) {
        calls.push([method, ...args]);
        if (method === 'prepare') return calls.filter(([m]) => m === 'prepare').length === 1 ? { ok: false, code: 'EDITOR_PREPARATION_REQUIRED', worktreeChange: true, error: 'save needed' } : { ok: true, data: { token: 'new-plan', paths: args[0].paths, title: 'fresh preview' } };
        if (method === 'prepare-editor') return { ok: true, data: answer };
        if (method === 'details') return { ok: true, data: { repo: { ...repo, version: 'after', head: drift ? 'b'.repeat(40) : repo.head } } };
        throw Error('unexpected: ' + method);
    } } } };
    vm.runInNewContext(code, context, { filename });
    const fake = { closed: false, epoch: 1, dialogEpoch: 1, selectionEpoch: 1, diffEpoch: 1, repoId: '.', details: { repo }, snapshot: { repositories: [repo] }, mode: 'working', renderRepos() {}, renderFiles() {}, updateButtons() {}, el() { return { hidden: false }; } };
    return { run: context.module.exports.TestController.prototype.requestPlan.bind(fake), calls };
}
test('panel resumes with new repo version but original paths/revision/line selection; never executes Git', async () => {
    const f = panelFixture(), operation = { action: 'discardLines', repo: '.', version: 'before', paths: ['fixed.txt'], revision: 'c'.repeat(40), lines: { path: 'fixed.txt', version: 'fixed-version', ids: ['line-1'] } };
    assert.equal((await f.run(operation)).token, 'new-plan'); const again = f.calls.filter(([m]) => m === 'prepare')[1][1];
    assert.equal(again.version, 'after'); assert.deepEqual(again.paths, operation.paths); assert.equal(again.revision, operation.revision); assert.deepEqual(again.lines, operation.lines); assert.equal(operation.version, 'before'); assert.ok(!f.calls.some(([m]) => m === 'execute'));
});
test('panel cancellation does not re-prepare; branch or commit drift prevents continuation', async () => {
    const f = panelFixture(false); assert.equal(await f.run({ action: 'updateAll', repo: '.', version: 'before' }), undefined); assert.equal(f.calls.filter(([m]) => m === 'prepare').length, 1);
    const g = panelFixture(true, true); await assert.rejects(g.run({ action: 'updateAll', repo: '.', version: 'before' }), /提交已变化/); assert.equal(g.calls.filter(([m]) => m === 'prepare').length, 1);
});
test('discard flow closes dirty tabs via Creator, never saves or writes Git, and preserves clean scenes',async()=>{
 const f=fixture({dirty:true});f.data.consent='discard';
 f.state().scenes.push({uuid:'clean',name:'clean.scene',type:'scene',dirty:false});
 const request=f.host.request;
 f.host.request=async(channel,message,...args)=>{
  if(message==='close-scene'){
   const current=await request(channel,'query-current-scene');f.calls.push(['close-scene']);
   f.state().scenes=f.state().scenes.filter(s=>s.uuid!==current);f.state().dirty=false;return true;
  }
  return request(channel,message,...args);
 };
 assert.equal(await prepareEditorForGit(true,f.host),true);
 assert.deepEqual(f.state().scenes.map(s=>s.uuid),['clean']);
 assert.equal(f.calls.some(([m])=>m==='multi-save-all-scene'),false);
});
test('discard cancellation or changed tabs stop before continuing',async()=>{
 const f=fixture({dirty:true});f.data.consent='discard';f.data.failClose=true;
 await assert.rejects(prepareEditorForGit(true,f.host),/关闭已取消/);assert.equal(f.state().dirty,true);
 assert.equal(f.calls.some(([m])=>m==='multi-save-all-scene'),false);
 const g=fixture({dirty:true});g.host.confirm=async()=>{g.state().scenes.push({uuid:'new',type:'scene',dirty:true});return 'discard';};
 await assert.rejects(prepareEditorForGit(true,g.host),/标签已变化/);assert.equal(writes(g).length,0);
});
