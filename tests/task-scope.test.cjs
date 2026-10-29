const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GitDesk } = require('../dist/git');
const { AgentBridge } = require('../dist/agent');
const git = (cwd, ...args) => execFileSync('git', args, {cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
async function fixture(t) {
    const base=await fs.mkdtemp(path.resolve(__dirname,'../.cache/task-scope-')),repo=path.join(base,'repo');
    await fs.mkdir(repo);t.after(()=>fs.rm(base,{recursive:true,force:true}));
    git(repo,'init','-b','dev');git(repo,'config','user.name','Fixture');git(repo,'config','user.email','fixture@example.invalid');
    await fs.writeFile(path.join(repo,'existing.txt'),'base\n');git(repo,'add','.');git(repo,'commit','-m','base');
    const service=new GitDesk(repo,path.join(base,'cache'),{checkEditor:async()=>{},beforeWorktreeChange:async()=>{},afterWorktreeChange:async()=>{}});
    const agent=new AgentBridge(service,async()=>({}));
    const call=(op,args={})=>agent.handle('.',{kind:'agent',protocol:1,op,...args});
    return {base,repo,service,agent,call};
}
test('task baseline survives reload; unchanged existing edits and mixed same-status bytes remain distinct',async t=>{
    const f=await fixture(t);await fs.writeFile(path.join(f.repo,'existing.txt'),'user edit\n');
    const task=await f.service.scopeStart('.','task',['own.txt']);
    await fs.writeFile(path.join(f.repo,'own.txt'),'new\n');
    let review=await f.service.scopeReview('.',task.id,[]);
    assert.equal(review.files.find(x=>x.path==='existing.txt').classification,'preExisting');
    assert.equal(review.files.find(x=>x.path==='own.txt').classification,'observedSinceStart');
    await fs.writeFile(path.join(f.repo,'existing.txt'),'user plus AI\n');
    review=await f.service.scopeReview('.',task.id,[]);
    assert.equal(review.files.find(x=>x.path==='existing.txt').classification,'mixed');
    const reloaded=new GitDesk(f.repo,path.join(f.base,'cache'),{checkEditor:async()=>{}});
    assert.equal((await reloaded.scopeList('.'))[0].id,task.id);
    assert.equal((await reloaded.scopeReview('.',task.id,[])).files.find(x=>x.path==='existing.txt').classification,'mixed');
});
test('commit check inspects entire index and rejects outside scope, related meta and baseline contamination without writes',async t=>{
    const f=await fixture(t);await fs.writeFile(path.join(f.repo,'existing.txt'),'user edit\n');
    const task=await f.service.scopeStart('.','task',['own.txt','own.txt.meta','existing.txt']);
    await fs.writeFile(path.join(f.repo,'own.txt'),'new');await fs.writeFile(path.join(f.repo,'own.txt.meta'),'meta');git(f.repo,'add','own.txt','existing.txt');
    const before=git(f.repo,'diff','--cached','--raw');
    let review=await f.service.scopeReview('.',task.id);
    assert(review.blockers.some(x=>x.code==='RELATED_PATH_MISSING'));
    assert(review.blockers.some(x=>x.code==='MIXED_CHANGES'));
    await fs.writeFile(path.join(f.repo,'outside.txt'),'other');git(f.repo,'add','outside.txt');
    review=await f.service.scopeReview('.',task.id);
    assert(review.blockers.some(x=>x.code==='OUTSIDE_SCOPE'));
    assert.notEqual(git(f.repo,'diff','--cached','--raw'),before);
    const checked=await f.call('commitCheck',{id:task.id});assert.equal(checked.ok,true);assert.equal(checked.data.result.canProceed,false);
    const status=(await f.service.snapshot(true)).repositories[0];
    const result=await f.call('prepare',{taskId:task.id,operation:{action:'commit',version:status.version,message:'scoped'}});
    assert.equal(result.ok,false);assert.equal(result.code,'SCOPE_BLOCKED');assert.equal(git(f.repo,'log','-1','--format=%s'),'base');
});
test('scoped prepare binds actual expanded paths and rejects byte changes before execute; valid scoped commit works',async t=>{
    const f=await fixture(t),task=await f.service.scopeStart('.','task',['own.txt']);await fs.writeFile(path.join(f.repo,'own.txt'),'new');
    let status=(await f.service.snapshot(true)).repositories[0];
    let prepared=await f.call('prepare',{taskId:task.id,operation:{action:'stage',version:status.version,paths:['own.txt']}});
    assert.equal(prepared.ok,true,JSON.stringify(prepared));
    await fs.writeFile(path.join(f.repo,'own.txt'),'changed after preview');
    let result=await f.call('execute',{token:prepared.data.result.plan.token,digest:prepared.data.result.digest});
    assert.equal(result.ok,false);assert.equal(result.code,'SCOPE_CHANGED');assert.equal(git(f.repo,'diff','--cached','--name-only'),'');
    git(f.repo,'add','own.txt');status=(await f.service.snapshot(true)).repositories[0];
    prepared=await f.call('prepare',{taskId:task.id,operation:{action:'commit',version:status.version,message:'scoped'}});
    assert.equal(prepared.ok,true,JSON.stringify(prepared));
    result=await f.call('execute',{token:prepared.data.result.plan.token,digest:prepared.data.result.digest});assert.equal(result.ok,true);
    for(let n=0;n<200&&f.service.task()?.status==='running';n++)await new Promise(r=>setTimeout(r,10));
    assert.equal(f.service.task().status,'success',f.service.task().log);assert.equal(git(f.repo,'log','-1','--format=%s'),'scoped');
    assert.equal((await f.service.scopeReview('.',task.id)).headChanged,true);
    assert.equal((await f.service.scopeReview('.',task.id)).canContinue,true);
});
test('task scopes reject traversal, missing IDs and wrong repository; submodule pointers require explicit permission',async t=>{
    const {TaskScopeStore}=require('../dist/task-scope');const f=await fixture(t);
    await assert.rejects(f.service.scopeStart('.','bad',['../escape']));
    const store=new TaskScopeStore(path.join(f.base,'scopes'),f.repo);
    const state={repo:'.',head:'a',branch:'dev',version:'v',files:[]};const task=await store.start(state,'pointer',['module']);
    const current={...state,files:[{path:'module',index:'M',worktree:' ',submodule:true,conflict:false,fingerprint:'a'.repeat(64)}]};
    assert((await store.review(current,task.id)).blockers.some(x=>x.code==='SUBMODULE_POINTER'));
    assert.equal((await store.review(current,task.id,undefined,true)).canProceed,true);
    await assert.rejects(store.review({...current,repo:'module'},task.id));
    await assert.rejects(store.review(current,'../escape'));
    const old={path:'old.txt',index:' ',worktree:'M',conflict:false,submodule:false,fingerprint:'b'.repeat(64)};
    const renameTask=await store.start({...state,files:[old]},'rename',['old.txt','new.txt']);
    const renamed={...old,path:'new.txt',oldPath:'old.txt',index:'R',fingerprint:'c'.repeat(64)};
    assert.equal((await store.review({...state,files:[renamed]},renameTask.id)).files[0].classification,'mixed');
});
test('backend-expanded meta scope is checked before any staging',async t=>{
    const f=await fixture(t),task=await f.service.scopeStart('.','asset',['own.txt']);
    await fs.writeFile(path.join(f.repo,'own.txt'),'new');await fs.writeFile(path.join(f.repo,'own.txt.meta'),'meta');
    const status=(await f.service.snapshot(true)).repositories[0];
    const plan=await f.call('prepare',{taskId:task.id,operation:{action:'stage',version:status.version,paths:['own.txt']}});
    assert.equal(plan.ok,false);assert.equal(plan.code,'SCOPE_BLOCKED');assert.match(plan.error,/own.txt.meta/);
    assert.equal(git(f.repo,'diff','--cached','--name-only'),'');
});

test('expired HEAD and branch baselines are archived intact and stop consuming repository capacity',async t=>{
    const {TaskScopeStore}=require('../dist/task-scope'),f=await fixture(t),cache=path.join(f.base,'capacity');
    const store=new TaskScopeStore(cache,f.repo),state={repo:'.',head:'old',branch:'dev',version:'v',files:[]};
    const old=[];
    for(let n=0;n<32;n++) old.push(await store.start(state,'old '+n,['own.txt']));
    const source=path.join(cache,'agent-tasks'),before=await fs.readFile(path.join(source,old[0].id+'.json'));
    const other=await store.start({...state,repo:'module'},'other repo',['own.txt']);
    assert.equal((await fs.readdir(source)).length,33);
    const current={...state,head:'new'};
    await store.start(current,'new HEAD',['own.txt']);
    assert.equal((await store.list('.',current)).length,1);
    assert.equal((await store.list('module',state))[0].id,other.id);
    const archived=path.join(cache,'agent-task-archives','expired');
    assert.equal((await fs.readdir(archived)).length,32);
    assert.deepEqual(await fs.readFile(path.join(archived,old[0].id+'.json')),before);
    await assert.rejects(store.review(current,old[0].id,[]),/ENOENT/);
    const branchTask=await store.start({...current,branch:'feature'},'new branch',['own.txt']);
    assert.equal((await store.list('.'))[0].id,branchTask.id);
    assert.equal((await fs.readdir(archived)).length,33);
    for(let n=1;n<32;n++) await store.start({...current,branch:'feature'},'current '+n,['own.txt']);
    await assert.rejects(store.start({...current,branch:'feature'},'full',['own.txt']),/32 项有效任务/);
    assert.equal((await store.list('module')).length,1);
    const isolated=new TaskScopeStore(path.join(f.base,'isolated'),f.repo);
    await isolated.start({...current,branch:'feature'},'isolated context',['own.txt']);
    assert.equal((await isolated.list('.')).length,1);
});
test('scope list reports HEAD changes without moving compatible baselines; new tasks keep pre-existing edits protected',async t=>{
    const f=await fixture(t),old=await f.service.scopeStart('.','old',['existing.txt']);
    git(f.repo,'commit','--allow-empty','-m','next HEAD');
    await fs.writeFile(path.join(f.repo,'existing.txt'),'unsubmitted user edit');
    const listed=await f.call('scopeList');
    assert.equal(listed.ok,true);
    assert.equal(listed.data.result[0].headChanged,true);
    assert.equal(listed.data.result[0].branch,'dev');
    assert.equal(typeof listed.data.result[0].head,'string');
    const record=path.join(f.base,'cache','agent-tasks',old.id+'.json'),before=await fs.readFile(record);
    assert.equal((await f.service.scopeReview('.',old.id,[])).headChanged,true);
    assert.deepEqual(await fs.readFile(record),before);
    const next=await f.service.scopeStart('.','next',['existing.txt']);
    const review=await f.service.scopeReview('.',next.id,['existing.txt']);
    assert(review.blockers.some(x=>x.code==='PREEXISTING_CHANGES'));
    assert.equal((await f.service.scopeList('.')).find(item=>item.id===next.id).headChanged,false);
    assert.equal((await f.service.scopeList('.')).find(item=>item.id===old.id).canContinue,true);
    assert.deepEqual(await fs.readFile(record),before);
    assert.equal(git(f.repo,'diff','--cached','--name-only'),'');
    assert.equal(await fs.readFile(path.join(f.repo,'existing.txt'),'utf8'),'unsubmitted user edit');
});
test('invalid paths and conflicting archive targets preserve original task evidence',async t=>{
    const {TaskScopeStore}=require('../dist/task-scope'),f=await fixture(t),cache=path.join(f.base,'archive-failure');
    const store=new TaskScopeStore(cache,f.repo),state={repo:'.',head:'old',branch:'dev',version:'v',files:[]};
    const old=await store.start(state,'old',['own.txt']),source=path.join(cache,'agent-tasks',old.id+'.json');
    const before=await fs.readFile(source),current={...state,head:'new'};
    await assert.rejects(store.start(current,'invalid',['../escape']));
    assert.deepEqual(await fs.readFile(source),before);
    const archive=path.join(cache,'agent-task-archives','expired');await fs.mkdir(archive,{recursive:true});
    const target=path.join(archive,old.id+'.json');await fs.writeFile(target,'existing evidence');
    await assert.rejects(store.start(current,'conflict',['own.txt']),/EEXIST/);
    assert.deepEqual(await fs.readFile(source),before);
    assert.equal(await fs.readFile(target,'utf8'),'existing evidence');
    assert.equal((await fs.readdir(path.dirname(source))).length,1);
});
test('damaged baseline identity stops creation instead of being archived as expired',async t=>{
    const {TaskScopeStore}=require('../dist/task-scope'),f=await fixture(t),cache=path.join(f.base,'damaged');
    const store=new TaskScopeStore(cache,f.repo),state={repo:'.',head:'old',branch:'dev',version:'v',files:[]};
    const old=await store.start(state,'old',['own.txt']),source=path.join(cache,'agent-tasks',old.id+'.json');
    const damaged=JSON.parse(await fs.readFile(source,'utf8'));delete damaged.baseline.head;
    await fs.writeFile(source,JSON.stringify(damaged));const before=await fs.readFile(source);
    await assert.rejects(store.start({...state,head:'new'},'new',['own.txt']),/已损坏/);
    assert.deepEqual(await fs.readFile(source),before);
});

test('unrelated fast-forward HEAD preserves the original task; overlapping commits and branch changes block it',async t=>{
    const f=await fixture(t),task=await f.service.scopeStart('.','continue',['own.txt']);
    const filename=path.join(f.base,'cache/agent-tasks',task.id+'.json'),original=JSON.parse(await fs.readFile(filename,'utf8')).baseline;
    await fs.writeFile(path.join(f.repo,'own.txt'),'task work');
    await fs.writeFile(path.join(f.repo,'other.txt'),'other work');git(f.repo,'add','other.txt');git(f.repo,'commit','-m','unrelated');
    let review=await f.service.scopeReview('.',task.id,['own.txt']);
    assert.equal(review.headChanged,true);assert.equal(review.canContinue,true);assert.equal(review.canProceed,true);
    const listed=await f.service.scopeList('.');assert.equal(listed[0].canContinue,true);
    await f.service.scopeStart('.','another',['another.txt']);await fs.stat(filename);
    assert.deepEqual(JSON.parse(await fs.readFile(filename,'utf8')).baseline,original);
    git(f.repo,'add','own.txt');git(f.repo,'commit','-m','external overlap');
    assert((await f.service.scopeReview('.',task.id,[])).blockers.some(b=>b.code==='HEAD_CHANGED'));
    git(f.repo,'switch','-c','different');assert.equal((await f.service.scopeReview('.',task.id,[])).canContinue,false);
});
test('one task supports multiple scoped commits and keeps uncommitted work classified against its original baseline',async t=>{
    const f=await fixture(t),task=await f.service.scopeStart('.','split delivery',['one.txt','two.txt']);
    const filename=path.join(f.base,'cache/agent-tasks',task.id+'.json'),baseline=JSON.parse(await fs.readFile(filename,'utf8')).baseline;
    await fs.writeFile(path.join(f.repo,'one.txt'),'one');await fs.writeFile(path.join(f.repo,'two.txt'),'two');
    const run=async(action,fields)=>{
        const status=(await f.service.snapshot(true)).repositories[0];
        const preview=await f.call('prepare',{taskId:task.id,operation:{action,version:status.version,...fields}});
        assert.equal(preview.ok,true,JSON.stringify(preview));
        const started=await f.call('execute',{token:preview.data.result.plan.token,digest:preview.data.result.digest});assert.equal(started.ok,true,JSON.stringify(started));
        for(let n=0;n<500&&f.service.task()?.status==='running';n++)await new Promise(r=>setTimeout(r,10));
        assert.equal(f.service.task().status,'success',f.service.task().log);
    };
    await run('stage',{paths:['one.txt']});await run('commit',{message:'first'});
    let review=await f.service.scopeReview('.',task.id,['two.txt']);assert.equal(review.canProceed,true,JSON.stringify(review.blockers));
    assert.equal(review.files.find(x=>x.path==='two.txt').classification,'observedSinceStart');
    await run('stage',{paths:['two.txt']});await run('commit',{message:'second'});
    const saved=JSON.parse(await fs.readFile(filename,'utf8'));assert.deepEqual(saved.baseline,baseline);assert.equal(saved.commits.length,2);
    assert.equal((await f.service.scopeReview('.',task.id,[])).canContinue,true);
    const reloaded=new GitDesk(f.repo,path.join(f.base,'cache'),{checkEditor:async()=>{}});
    assert.equal((await reloaded.scopeReview('.',task.id,[])).canContinue,true);
});
test('task extension snapshots only newly added paths and never rebaselines existing task edits',async t=>{
    const f=await fixture(t);await fs.writeFile(path.join(f.repo,'existing.txt'),'user work');
    const task=await f.service.scopeStart('.','extend',['own.txt']);
    await fs.writeFile(path.join(f.repo,'own.txt'),'task work');
    const filename=path.join(f.base,'cache/agent-tasks',task.id+'.json'),baseline=JSON.parse(await fs.readFile(filename,'utf8')).baseline;
    const extended=await f.call('scopeExtend',{id:task.id,paths:['own.txt','existing.txt','extra.txt','extra.txt.meta']});assert.equal(extended.ok,true,JSON.stringify(extended));
    assert.deepEqual(extended.data.result.added,['existing.txt','extra.txt','extra.txt.meta']);
    await fs.writeFile(path.join(f.repo,'extra.txt'),'new');await fs.writeFile(path.join(f.repo,'extra.txt.meta'),'meta');
    let review=await f.service.scopeReview('.',task.id,['own.txt','extra.txt','extra.txt.meta']);assert.equal(review.canProceed,true,JSON.stringify(review.blockers));
    assert.equal(review.files.find(x=>x.path==='own.txt').classification,'observedSinceStart');
    assert.equal(review.files.find(x=>x.path==='existing.txt').classification,'preExisting');
    await fs.writeFile(path.join(f.repo,'existing.txt'),'user plus more');
    review=await f.service.scopeReview('.',task.id,['existing.txt']);assert(review.blockers.some(b=>b.code==='MIXED_CHANGES'));
    assert.deepEqual(JSON.parse(await fs.readFile(filename,'utf8')).baseline,baseline);
    assert.equal((await f.call('scopeExtend',{id:task.id,paths:['../escape']})).ok,false);
});
test('unrelated same-status saves do not invalidate a scoped stage plan; additional staged content still does',async t=>{
    const f=await fixture(t);await fs.writeFile(path.join(f.repo,'existing.txt'),'before');
    const task=await f.service.scopeStart('.','narrow snapshot',['own.txt']);await fs.writeFile(path.join(f.repo,'own.txt'),'own');
    let status=(await f.service.snapshot(true)).repositories[0];
    let preview=await f.call('prepare',{taskId:task.id,operation:{action:'stage',version:status.version,paths:['own.txt']}});
    assert.equal(preview.ok,true,JSON.stringify(preview));await fs.writeFile(path.join(f.repo,'existing.txt'),'unrelated save with same status');
    let result=await f.call('execute',{token:preview.data.result.plan.token,digest:preview.data.result.digest});assert.equal(result.ok,true,JSON.stringify(result));
    for(let n=0;n<500&&f.service.task()?.status==='running';n++)await new Promise(r=>setTimeout(r,10));assert.equal(f.service.task().status,'success',f.service.task().log);
    status=(await f.service.snapshot(true)).repositories[0];
    preview=await f.call('prepare',{taskId:task.id,operation:{action:'commit',version:status.version,message:'own'}});
    assert.equal(preview.ok,true,JSON.stringify(preview));git(f.repo,'add','existing.txt');
    result=await f.call('execute',{token:preview.data.result.plan.token,digest:preview.data.result.digest});assert.equal(result.ok,false);
    assert.equal(git(f.repo,'log','-1','--format=%s'),'base');
});
test('unrelated oversized saved files do not block a small task but required oversized files still block',async t=>{
    const f=await fixture(t);await fs.writeFile(path.join(f.repo,'large.bin'),Buffer.alloc(17*1024*1024));
    const task=await f.service.scopeStart('.','small',['own.txt']);await fs.writeFile(path.join(f.repo,'own.txt'),'small');
    assert.equal((await f.service.scopeReview('.',task.id,['own.txt'])).canProceed,true);
    await assert.rejects(f.service.scopeStart('.','large',['large.bin']),/快照过大/);
    await assert.rejects(f.service.scopeExtend('.',task.id,['large.bin']),/快照过大/);
});
test('a commit hook changing the previewed tree reports an uncertain completed write without advancing task provenance',async t=>{
    const f=await fixture(t),task=await f.service.scopeStart('.','guard hooks',['own.txt']);await fs.writeFile(path.join(f.repo,'own.txt'),'own');git(f.repo,'add','own.txt');
    await fs.writeFile(path.join(f.repo,'.git/hooks/pre-commit'),'#!/bin/sh\nprintf hook > hook.txt\ngit add hook.txt\n',{mode:0o755});
    const status=(await f.service.snapshot(true)).repositories[0];
    const preview=await f.call('prepare',{taskId:task.id,operation:{action:'commit',version:status.version,message:'hook changed tree'}});assert.equal(preview.ok,true,JSON.stringify(preview));
    assert.equal((await f.call('execute',{token:preview.data.result.plan.token,digest:preview.data.result.digest})).ok,true);
    for(let n=0;n<500&&f.service.task()?.status==='running';n++)await new Promise(r=>setTimeout(r,10));
    assert.equal(f.service.task().status,'failed');assert.match(f.service.task().log,/提交可能已生成/);
    assert.equal(git(f.repo,'log','-1','--format=%s'),'hook changed tree');
    const saved=JSON.parse(await fs.readFile(path.join(f.base,'cache/agent-tasks',task.id+'.json'),'utf8'));assert.equal(saved.commits,undefined);
});

test('index changes during editor preparation stop commit before any new HEAD is created',async t=>{
    const f=await fixture(t),task=await f.service.scopeStart('.','editor race',['own.prefab']);
    await fs.writeFile(path.join(f.repo,'own.prefab'),'own');git(f.repo,'add','own.prefab');
    const status=(await f.service.snapshot(true)).repositories[0],head=git(f.repo,'rev-parse','HEAD');
    const preview=await f.call('prepare',{taskId:task.id,operation:{action:'commit',version:status.version,message:'must not commit'}});assert.equal(preview.ok,true,JSON.stringify(preview));
    f.service.host.checkEditor=async()=>{await fs.writeFile(path.join(f.repo,'other.txt'),'other');git(f.repo,'add','other.txt');};
    assert.equal((await f.call('execute',{token:preview.data.result.plan.token,digest:preview.data.result.digest})).ok,true);
    for(let n=0;n<500&&f.service.task()?.status==='running';n++)await new Promise(r=>setTimeout(r,10));
    assert.equal(f.service.task().status,'failed');assert.match(f.service.task().log,/重新预览提交/);assert.equal(git(f.repo,'rev-parse','HEAD'),head);
    assert.match(git(f.repo,'diff','--cached','--name-only'),/other.txt/);
});

test('pure script commits do not require saving unrelated scenes while serialized resource commits keep the editor guard',async t=>{
    const f=await fixture(t),task=await f.service.scopeStart('.','editor scope',['code.ts','view.prefab']);
    f.service.host.checkEditor=async()=>{throw new Error('unsaved scene');};
    await fs.writeFile(path.join(f.repo,'code.ts'),'export const value = 1;');git(f.repo,'add','code.ts');
    let status=(await f.service.snapshot(true)).repositories[0];
    let preview=await f.call('prepare',{taskId:task.id,operation:{action:'commit',version:status.version,message:'script only'}});
    assert.equal(preview.ok,true,JSON.stringify(preview));
    assert.equal((await f.call('execute',{token:preview.data.result.plan.token,digest:preview.data.result.digest})).ok,true);
    for(let n=0;n<500&&f.service.task()?.status==='running';n++)await new Promise(r=>setTimeout(r,10));assert.equal(f.service.task().status,'success',f.service.task().log);
    const head=git(f.repo,'rev-parse','HEAD');await fs.writeFile(path.join(f.repo,'view.prefab'),'serialized');git(f.repo,'add','view.prefab');
    status=(await f.service.snapshot(true)).repositories[0];
    preview=await f.call('prepare',{taskId:task.id,operation:{action:'commit',version:status.version,message:'resource'}});
    assert.equal(preview.ok,false);assert.match(preview.error,/unsaved scene/);assert.equal(git(f.repo,'rev-parse','HEAD'),head);
});

async function finishTask(service) {
    for (let n=0;n<500 && service.task()?.status==='running';n++) await new Promise(r=>setTimeout(r,10));
    assert.equal(service.task()?.status,'success',service.task()?.log);
}
test('changes query with an empty index is informational; commit check still blocks',async t=>{
    const f=await fixture(t), task=await f.service.scopeStart('.','observe',['own.txt']);
    const changes=await f.call('scopeChanges',{id:task.id});
    assert.equal(changes.ok,true);assert.equal(changes.data.result.canProceed,true);
    assert.equal(changes.data.result.blockers.length,0);
    const check=await f.call('commitCheck',{id:task.id});
    assert.equal(check.data.result.canProceed,false);assert.equal(check.data.result.blockers[0].code,'EMPTY_SCOPE');
});
test('ordinary stage and commit ignore unrelated disk edits and retain complete index checks',async t=>{
    const f=await fixture(t),task=await f.service.scopeStart('.','local',['own.txt']);
    await fs.writeFile(path.join(f.repo,'own.txt'),'mine');
    let status=(await f.service.snapshot(true)).repositories[0];
    const scopes=[],scan=f.service.scan.bind(f.service);f.service.scan=(force,scope)=>{scopes.push(scope);return scan(force,scope);};
    let p=await f.call('prepare',{taskId:task.id,operation:{action:'stage',version:status.version,paths:['own.txt']}});
    assert.equal(p.ok,true,JSON.stringify(p));assert(scopes.length>0);assert(scopes.every(x=>x==='.'),'single-repo prepare must not rescan every submodule');
    await fs.writeFile(path.join(f.repo,'unrelated.txt'),'other work');
    let r=await f.call('execute',{token:p.data.result.plan.token,digest:p.data.result.digest});assert.equal(r.ok,true,JSON.stringify(r));await finishTask(f.service);
    assert.equal(git(f.repo,'diff','--cached','--name-only'),'own.txt');
    status=(await f.service.snapshot(true)).repositories[0];
    p=await f.call('prepare',{taskId:task.id,operation:{action:'commit',version:status.version,message:'local'}});assert.equal(p.ok,true,JSON.stringify(p));
    await fs.writeFile(path.join(f.repo,'unrelated.txt'),'changed again');
    r=await f.call('execute',{token:p.data.result.plan.token,digest:p.data.result.digest});assert.equal(r.ok,true,JSON.stringify(r));await finishTask(f.service);
    assert.equal(git(f.repo,'show','--format=','--name-only','HEAD'),'own.txt');assert.equal(await fs.readFile(path.join(f.repo,'unrelated.txt'),'utf8'),'changed again');
});
test('new related meta after stage preview remains a hard stop',async t=>{
    const f=await fixture(t),task=await f.service.scopeStart('.','local',['own.txt','own.txt.meta']);
    await fs.writeFile(path.join(f.repo,'own.txt'),'mine');const status=(await f.service.snapshot(true)).repositories[0];
    const p=await f.call('prepare',{taskId:task.id,operation:{action:'stage',version:status.version,paths:['own.txt']}});assert.equal(p.ok,true,JSON.stringify(p));
    await fs.writeFile(path.join(f.repo,'own.txt.meta'),'new meta');
    const r=await f.call('execute',{token:p.data.result.plan.token,digest:p.data.result.digest});
    if(r.ok){for(let n=0;n<500&&f.service.task()?.status==='running';n++)await new Promise(r=>setTimeout(r,10));assert.equal(f.service.task().status,'failed');}
    assert.equal(git(f.repo,'diff','--cached','--name-only'),'');
});

test('a selected gitlink binds the child HEAD, not merely parent status or directory mtime',async t=>{
    const f=await fixture(t),child=path.join(f.base,'child');await fs.mkdir(child);
    git(child,'init','-b','dev');git(child,'config','user.name','Fixture');git(child,'config','user.email','fixture@example.invalid');
    await fs.writeFile(path.join(child,'file.txt'),'one');git(child,'add','.');git(child,'commit','-m','one');
    git(f.repo,'-c','protocol.file.allow=always','submodule','add',child,'module');git(f.repo,'commit','-am','module');
    const mod=path.join(f.repo,'module');git(mod,'config','user.name','Fixture');git(mod,'config','user.email','fixture@example.invalid');
    await fs.writeFile(path.join(mod,'file.txt'),'two');git(mod,'commit','-am','two');
    let status=(await f.service.snapshot(true)).repositories.find(x=>x.id==='.');
    const p=await f.service.prepare({repo:'.',action:'stage',version:status.version,paths:['module'],includePointers:true});
    await fs.writeFile(path.join(mod,'file.txt'),'three');git(mod,'commit','-am','three');
    f.service.execute(p.token);for(let n=0;n<500&&f.service.task()?.status==='running';n++)await new Promise(r=>setTimeout(r,10));
    assert.equal(f.service.task().status,'failed');assert.equal(git(f.repo,'diff','--cached','--name-only'),'');
});

test('attribute changes affecting selected paths invalidate stage before filters run',async t=>{
    const f=await fixture(t);await fs.writeFile(path.join(f.repo,'own.txt'),'mine');
    const status=(await f.service.snapshot(true)).repositories[0];
    const plan=await f.service.prepare({repo:'.',action:'stage',version:status.version,paths:['own.txt']});
    await fs.writeFile(path.join(f.repo,'.gitattributes'),'*.txt text eol=crlf');f.service.execute(plan.token);
    for(let n=0;n<500&&f.service.task()?.status==='running';n++)await new Promise(r=>setTimeout(r,10));
    assert.equal(f.service.task().status,'failed');assert.equal(git(f.repo,'diff','--cached','--name-only'),'');
});

test('finished tasks are archived automatically when the capacity is reached',async t=>{
    const {TaskScopeStore}=require('../dist/task-scope'),f=await fixture(t),cache=path.join(f.base,'auto');
    const store=new TaskScopeStore(cache,f.repo),state={repo:'.',head:'old',branch:'dev',version:'v',files:[]};
    const tasks=[];for(let n=0;n<32;n++)tasks.push(await store.start(state,'task '+n,['own'+n+'.txt']));
    // Two tasks have recorded commits; one of them still carries an uncommitted edit inside its scope.
    await store.recordCommit(tasks[3].id,'.','old','old','dev',['own3.txt']);await store.recordCommit(tasks[5].id,'.','old','old','dev',['own5.txt']);
    const dirty={...state,files:[{path:'own5.txt',index:' ',worktree:'M',conflict:false,submodule:false,fingerprint:'a'.repeat(64)}]};
    const started=await store.start(dirty,'next',['next.txt']);
    assert.deepEqual(started.archived.map(item=>item.id),[tasks[3].id]);assert.match(started.archived[0].reason,/自动归档/);
    assert.deepEqual(await fs.readdir(path.join(cache,'agent-task-archives','completed')),[tasks[3].id+'.json']);
    assert.equal((await store.list('.',state)).length,32);assert.ok((await store.list('.',state)).some(item=>item.id===tasks[5].id),'a finished task with edits in scope stays');
    await assert.rejects(store.start(dirty,'overflow',['more.txt']),/没有可自动归档的已完成任务/);
    assert.equal((await store.start(state,'after commit',['later.txt'])).archived.map(item=>item.id).join(),tasks[5].id,'once its scope is clean the other finished task goes too');
});
