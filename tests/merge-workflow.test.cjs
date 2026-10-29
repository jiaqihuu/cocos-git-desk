const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GitDesk } = require('../dist/git');
const { MergeStateChangedError } = require('../dist/types');
const { DraftStore } = require('../dist/drafts');
const { RecoveryStore } = require('../dist/recovery');

const work = path.resolve(__dirname, '../.test-work');
process.env.GIT_ALLOW_PROTOCOL = 'file';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(work, 'merge-workflow-no-global-config');
const git = (cwd, ...args) => execFileSync('git', ['--literal-pathspecs', ...args], {
    cwd, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
}).trimEnd();

async function fixture(t, seed = true) {
    await fs.mkdir(work, { recursive: true });
    const base = await fs.mkdtemp(path.join(work, 'merge-workflow-'));
    t.after(async () => { await fs.rm(base, { recursive: true, force: true }); });
    const repo = path.join(base, 'project'); await fs.mkdir(repo);
    git(repo, 'init', '-b', 'dev');
    git(repo, 'config', 'user.name', 'Git Desk Test');
    git(repo, 'config', 'user.email', 'git-desk@example.invalid');
    git(repo, 'config', 'commit.gpgSign', 'false');
    git(repo, 'config', 'core.hooksPath', path.join(base, 'no-hooks'));
    if (seed) {
        await fs.writeFile(path.join(repo, 'file.txt'), 'first\n');
        git(repo, 'add', '.'); git(repo, 'commit', '-m', 'initial');
    }
    const calls = { check: 0, before: 0, after: 0, dirtyEditor: false, duringBefore: undefined };
    const desk = new GitDesk(repo, path.join(base, 'cache'), {
        async checkEditor() { calls.check++; if (calls.dirtyEditor) throw new Error('unsaved scene'); },
        async beforeWorktreeChange() { calls.before++; if (calls.duringBefore) await calls.duringBefore(); },
        async afterWorktreeChange() { calls.after++; },
    });
    return { base, repo, desk, calls };
}

async function plan(desk, action, args = {}) {
    const snapshot = await desk.snapshot(true);
    return desk.prepare({ repo: '.', version: snapshot.repositories[0].version, action, ...args });
}

async function finish(desk, preview) {
    desk.execute(preview.token);
    const start = Date.now();
    while (desk.task().status === 'running') {
        if (Date.now() - start > 30000) throw new Error('task test timeout');
        await new Promise(resolve => setTimeout(resolve, 15));
    }
    return desk.task();
}

async function perform(desk, action, args) {
    const result = await finish(desk, await plan(desk, action, args));
    assert.equal(result.status, 'success', result.log);
    return result;
}


// These scenarios are test source only; no fixtures have been executed for this batch.
const tip=repo=>git(repo,'rev-parse','HEAD');
const index=repo=>execFileSync('git',['ls-files','--stage','-z'],{cwd:repo});
async function branches(repo,{conflict=false,fastForward=false}={}){
    git(repo,'switch','-c','topic');await fs.writeFile(path.join(repo,'file.txt'),'incoming\n');git(repo,'add','.');git(repo,'commit','-m','topic');const target=tip(repo);
    git(repo,'switch','dev');
    if(!fastForward){await fs.writeFile(path.join(repo,conflict?'file.txt':'ours.txt'),'ours\n');git(repo,'add','.');git(repo,'commit','-m','ours');}
    return {target,head:tip(repo)};
}
async function begin(f,options){const state=await branches(f.repo,options);await perform(f.desk,'beginMerge',{revision:state.target});return state;}
async function abortPlan(desk){const state=await desk.mergeState('.');assert.equal(state.canAbort,true,state.abortReason);return plan(desk,'abortMerge',{mergeVersion:state.abortVersion});}

test('clean divergent merge stays pending with HEAD unchanged and can finish through existing commit flow',async t=>{
    const f=await fixture(t),{head,target}=await begin(f);
    assert.equal(tip(f.repo),head);assert.equal(git(f.repo,'rev-parse','MERGE_HEAD'),target);
    const state=await f.desk.mergeState('.');assert.equal(state.canFinish,true);assert.equal(state.canAbort,true);
    await perform(f.desk,'finishMerge',{mergeVersion:state.version,message:'reviewed merge'});
    assert.equal(git(f.repo,'rev-list','--parents','-n','1','HEAD'),[tip(f.repo),head,target].join(' '));
});

test('fast-forwardable target still stops at no-ff no-commit rather than moving the branch',async t=>{
    const f=await fixture(t),{head,target}=await begin(f,{fastForward:true});
    assert.equal(tip(f.repo),head);assert.equal(git(f.repo,'rev-parse','MERGE_HEAD'),target);
    assert.equal((await f.desk.mergeState('.')).canAbort,true);
});

test('expected merge conflicts are a pending task outcome with separate finish and abort eligibility',async t=>{
    const f=await fixture(t),{head}=await begin(f,{conflict:true});const state=await f.desk.mergeState('.');
    assert.equal(tip(f.repo),head);assert.equal(state.canFinish,false);assert.equal(state.canAbort,true);assert.ok(state.conflicts>0);
    assert.ok((await fs.readFile(path.join(f.repo,'file.txt'),'utf8')).includes('<<<<<<<'));
});

test('abort discards merge results and restores the recorded clean HEAD and index',async t=>{
    const f=await fixture(t),{head}=await begin(f,{conflict:true}),original=index(f.repo),originalRaw=await fs.readFile(path.join(f.repo,'.git','index'));
    const preview=await abortPlan(f.desk);assert.ok(preview.paths.includes('file.txt'));
    const task=await finish(f.desk,preview);assert.equal(task.status,'success',task.log);assert.equal(tip(f.repo),head);assert.equal(git(f.repo,'status','--porcelain'),'');
    assert.notDeepEqual(index(f.repo),original);
    await assert.rejects(fs.stat(path.join(f.desk.cache,'recovery')),e=>e.code==='ENOENT');
});

test('index-only conflict solution solution is discarded by explicitly confirmed abort',async t=>{
    const f=await fixture(t);await begin(f,{conflict:true});const staged='index only solution\n';
    const oid=execFileSync('git',['hash-object','-w','--stdin'],{cwd:f.repo,input:staged,encoding:'utf8'}).trim();git(f.repo,'update-index','--cacheinfo','100644,'+oid+',file.txt');
    const task=await finish(f.desk,await abortPlan(f.desk));assert.equal(task.status,'success',task.log);
    assert.equal(git(f.repo,'status','--porcelain'),'');
    assert.ok(!(await fs.readFile(path.join(f.repo,'file.txt'),'utf8')).includes('<<<<<<<'));
});

test('external merge without an active plugin journal can finish but cannot claim safe abort',async t=>{
    const f=await fixture(t),{target}=await branches(f.repo);git(f.repo,'merge','--no-ff','--no-commit',target);
    const state=await f.desk.mergeState('.');assert.equal(state.canFinish,true);assert.equal(state.canAbort,false);assert.match(state.abortReason,/起点/);
    await assert.rejects(plan(f.desk,'abortMerge',{mergeVersion:'0'.repeat(64)}));
});

test('durable active journal allows abort after a new service instance is created',async t=>{
    const f=await fixture(t);await begin(f,{conflict:true});
    const service=new GitDesk(f.repo,path.join(f.base,'cache'),{checkEditor:async()=>{},beforeWorktreeChange:async()=>{},afterWorktreeChange:async()=>{}});
    const result=await finish(service,await abortPlan(service));assert.equal(result.status,'success',result.log);
});

test('prepared journal after interruption is not promoted into automatic abort permission',async t=>{
    const f=await fixture(t);await begin(f,{conflict:true});const store=new DraftStore(path.join(f.base,'cache','merge-sessions')),draft=await store.read(f.repo),data=JSON.parse(draft.message);
    data.phase='prepared';await store.save(f.repo,JSON.stringify(data),draft.version);
    const state=await f.desk.mergeState('.');assert.equal(state.canAbort,false);assert.match(state.abortReason,/起点/);
});

test('changed ORIG_HEAD blocks safe abort without modifying the merge',async t=>{
    const f=await fixture(t),{target}=await begin(f,{conflict:true});git(f.repo,'update-ref','ORIG_HEAD',target);
    const state=await f.desk.mergeState('.');assert.equal(state.canAbort,false);assert.match(state.abortReason,/ORIG_HEAD/);assert.equal(git(f.repo,'rev-parse','MERGE_HEAD'),target);
});

test('changes after abort preview invalidate the task and retain the new edit',async t=>{
    const f=await fixture(t);await begin(f,{conflict:true});const preview=await abortPlan(f.desk);
    await fs.writeFile(path.join(f.repo,'file.txt'),'late edit');const task=await finish(f.desk,preview);assert.equal(task.status,'failed');assert.equal(await fs.readFile(path.join(f.repo,'file.txt'),'utf8'),'late edit');
});

test('dirty worktree and dirty index are refused before recording a merge start',async t=>{
    const f=await fixture(t),{target}=await branches(f.repo);await fs.writeFile(path.join(f.repo,'file.txt'),'dirty');
    await assert.rejects(plan(f.desk,'beginMerge',{revision:target}),/改动/);git(f.repo,'add','.');await assert.rejects(plan(f.desk,'beginMerge',{revision:target}),/改动/);
    const store=new DraftStore(path.join(f.base,'cache','merge-sessions'));assert.equal((await store.read(f.repo)).message,'');
});

test('untracked files after a merge require separate preservation before abort',async t=>{
    const f=await fixture(t);await begin(f,{conflict:true});await fs.writeFile(path.join(f.repo,'new.txt'),'private');
    const state=await f.desk.mergeState('.');assert.equal(state.canAbort,false);assert.match(state.abortReason,/未跟踪/);
});

test('autostash markers and incompatible merge options are refused',async t=>{
    const f=await fixture(t),{target}=await branches(f.repo);git(f.repo,'config','branch.dev.mergeOptions','-Xours');await assert.rejects(plan(f.desk,'beginMerge',{revision:target}),/mergeOptions/);
    git(f.repo,'config','--unset','branch.dev.mergeOptions');await perform(f.desk,'beginMerge',{revision:target});await fs.writeFile(path.join(f.repo,'.git','MERGE_AUTOSTASH'),tip(f.repo)+'\n');
    const state=await f.desk.mergeState('.');assert.equal(state.canAbort,false);assert.match(state.abortReason,/MERGE_AUTOSTASH/);
});

test('target expressions, incidental form fields and already-contained commits are rejected',async t=>{
    const f=await fixture(t),{target,head}=await branches(f.repo);
    await assert.rejects(plan(f.desk,'beginMerge',{revision:'topic'}));
    await assert.rejects(plan(f.desk,'beginMerge',{revision:target,paths:['file.txt']}));
    await assert.rejects(plan(f.desk,'beginMerge',{revision:head}),/已包含/);
});

test('custom attributes, symlink source and missing parent directories stop merge before mutation',async t=>{
    const f=await fixture(t),{target}=await branches(f.repo);await fs.writeFile(path.join(f.repo,'.gitattributes'),'file.txt merge=custom\n');git(f.repo,'add','.');git(f.repo,'commit','-m','attributes');
    await assert.rejects(plan(f.desk,'beginMerge',{revision:target}));
    const g=await fixture(t);git(g.repo,'switch','-c','nested');await fs.mkdir(path.join(g.repo,'folder'));await fs.writeFile(path.join(g.repo,'folder/new.txt'),'incoming');git(g.repo,'add','.');git(g.repo,'commit','-m','nested');const nested=tip(g.repo);git(g.repo,'switch','dev');
    await assert.rejects(plan(g.desk,'beginMerge',{revision:nested}));
    if(process.platform!=='win32'){
        const h=await fixture(t);git(h.repo,'switch','-c','link-source');await fs.unlink(path.join(h.repo,'file.txt'));await fs.symlink('outside',path.join(h.repo,'file.txt'));git(h.repo,'add','.');git(h.repo,'commit','-m','link');const targetLink=tip(h.repo);git(h.repo,'switch','dev');
        await assert.rejects(plan(h.desk,'beginMerge',{revision:targetLink}),/链接/);
    }
});

test('unborn, detached and shallow merge starts are rejected without creating a journal',async t=>{
    const f=await fixture(t),{target}=await branches(f.repo);git(f.repo,'switch','--detach');await assert.rejects(plan(f.desk,'beginMerge',{revision:target}),/本地分支/);
    const empty=await fixture(t,false);await assert.rejects(plan(empty.desk,'beginMerge',{revision:target}));
    git(f.repo,'switch','dev');await fs.writeFile(path.join(f.repo,'.git','shallow'),tip(f.repo)+'\n');await assert.rejects(plan(f.desk,'beginMerge',{revision:target}),/浅克隆/);
});

test('unsaved editor and preparation-time changes prevent merge execution',async t=>{
    const f=await fixture(t),{target}=await branches(f.repo);f.calls.dirtyEditor=true;await assert.rejects(plan(f.desk,'beginMerge',{revision:target}),/unsaved/);f.calls.dirtyEditor=false;
    const preview=await plan(f.desk,'beginMerge',{revision:target});f.calls.duringBefore=()=>fs.writeFile(path.join(f.repo,'file.txt'),'late edit');
    const result=await finish(f.desk,preview);assert.equal(result.status,'failed');assert.equal(await fs.readFile(path.join(f.repo,'file.txt'),'utf8'),'late edit');
});


test('special index flags introduced after merge stop abort rather than conceal workfiles',async t=>{
    const f=await fixture(t);await begin(f);git(f.repo,'update-index','--assume-unchanged','ours.txt');await fs.writeFile(path.join(f.repo,'ours.txt'),'hidden edit');
    const state=await f.desk.mergeState('.');assert.equal(state.canAbort,false);assert.match(state.abortReason,/特殊索引/);
});

test('a single-use merge plan cannot be reused to start another task',async t=>{
    const f=await fixture(t),{target}=await branches(f.repo),preview=await plan(f.desk,'beginMerge',{revision:target});
    const result=await finish(f.desk,preview);assert.equal(result.status,'success',result.log);assert.throws(()=>f.desk.execute(preview.token));
});
