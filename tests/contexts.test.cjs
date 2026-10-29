const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const {execFileSync}=require('node:child_process');
const {GitDesk}=require('../dist/git');const {WorkspaceContexts}=require('../dist/contexts');const {mcpQuery}=require('../dist/mcp-bridge');const {parseWorktrees}=require('../dist/worktrees');
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1'},stdio:['pipe','pipe','pipe']}).trim();
const wait=async f=>{for(let n=0;n<500&&f()?.status==='running';n++)await new Promise(r=>setTimeout(r,10));const t=f();assert.equal(t.status,'success',t.log);return t;};
const ok=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r.data.result;};
async function fixture(t){const base=await fs.realpath(await fs.mkdtemp(path.join(require('node:os').tmpdir(),'git-desk-context-fixture-')));t.after(()=>fs.rm(base,{recursive:true,force:true}));const repo=path.join(base,'repo');await fs.mkdir(repo);git(repo,'init','-b','dev');git(repo,'config','user.name','Fixture');git(repo,'config','user.email','fixture@example.invalid');await fs.writeFile(path.join(repo,'file.txt'),'base\n');await fs.writeFile(path.join(repo,'.gitignore'),'ignored\n');git(repo,'add','.');git(repo,'commit','-m','base');let manager;const service=new GitDesk(repo,path.join(base,'cache'),{checkEditor:async()=>{},assertAvailable:()=>{if(manager?.externallyBusy())throw Error('other context busy');},beforeWorktreeChange:async()=>{},afterWorktreeChange:async()=>{}});manager=new WorkspaceContexts(service,async()=>({}),undefined,{queueMs:300});const call=(op,args={},context='creator')=>manager.handle('.',{kind:'agent',protocol:1,op,...args},context);return {base,repo,service,manager,call,head:git(repo,'rev-parse','HEAD')};}
async function create(f){const dest=path.join(f.base,'isolated space');const plan=ok(await f.call('worktreePrepare',{mode:'create',path:dest,branch:'codex/test',revision:f.head}));await assert.rejects(fs.stat(dest));ok(await f.call('worktreeExecute',{token:plan.token,digest:plan.digest}));await wait(()=>f.manager.worktrees.task);const contexts=ok(await f.call('contexts')).contexts;return contexts[0];}
async function action(f,context,operation,taskId){const snap=ok(await f.call('status',{},context));const repo=snap.repository||snap;const service=await f.manager.service(context);const version=(await service.snapshot(true)).repositories[0].version;const prepared=ok(await f.call('prepare',{operation:{...operation,version},...(taskId?{taskId}:{})},context));ok(await f.call('execute',{token:prepared.plan.token,digest:prepared.digest},context));return wait(()=>service.task());}
test('worktree parser preserves spaces and newlines; catalogue separates human approval from MCP',()=>{assert.equal(parseWorktrees('worktree /a b\nc\0HEAD ab\0branch refs/heads/dev\0locked reason\0\0')[0].path,'/a b\nc');assert.equal(mcpQuery('git_desk_query',{context:'x',op:'diff',arguments:{path:'file.txt'}}).context,'x');assert.throws(()=>mcpQuery('git_desk_scope_review',{mode:'approve',id:'x'}));assert.throws(()=>mcpQuery('git_desk_query',{op:'status',arguments:{context:'x'}}));});
test('create isolated worktree, scope stage/commit/push to local bare remote; original dirty content and index unchanged',async t=>{const f=await fixture(t);await fs.writeFile(path.join(f.repo,'file.txt'),'user dirty\n');git(f.repo,'add','file.txt');await fs.writeFile(path.join(f.repo,'file.txt'),'user unstaged\n');const before=git(f.repo,'diff','--cached'),status=git(f.repo,'status','--porcelain');const c=await create(f);assert.equal(await fs.readFile(path.join(c.root,'file.txt'),'utf8'),'base\n');assert.equal(ok(await f.call('status',{},c.id)).context,undefined);const task=ok(await f.call('scopeStart',{title:'isolated task',paths:['file.txt']},c.id));await fs.writeFile(path.join(c.root,'file.txt'),'isolated edit\n');await action(f,c.id,{action:'stage',paths:['file.txt']},task.id);await action(f,c.id,{action:'commit',message:'isolated commit'},task.id);const remote=path.join(f.base,'remote.git');git(f.base,'init','--bare',remote);git(c.root,'remote','add','origin',remote);git(c.root,'config','branch.codex/test.remote','origin');git(c.root,'config','branch.codex/test.merge','refs/heads/codex/test');await action(f,c.id,{action:'push',remote:'origin'});assert.equal(git(remote,'rev-parse','refs/heads/codex/test'),git(c.root,'rev-parse','HEAD'));assert.equal(git(f.repo,'rev-parse','HEAD'),f.head);assert.equal(git(f.repo,'diff','--cached'),before);assert.equal(git(f.repo,'status','--porcelain'),status);assert.equal(await fs.readFile(path.join(f.repo,'file.txt'),'utf8'),'user unstaged\n');});
test('registration, no fallback, stale plans, noforce removal and branch preservation',async t=>{const f=await fixture(t);assert.equal((await f.call('contextRegister',{path:f.repo})).ok,false);const unrelated=path.join(f.base,'other');git(f.base,'clone',f.repo,unrelated);assert.equal((await f.call('contextRegister',{path:unrelated})).ok,false);assert.equal((await f.call('status',{},'missing')).ok,false);const c=await create(f);await fs.writeFile(path.join(c.root,'ignored'),'keep');assert.equal((await f.call('worktreePrepare',{mode:'remove',targetContext:c.id})).ok,false);await fs.unlink(path.join(c.root,'ignored'));git(f.repo,'worktree','lock',c.root);assert.equal((await f.call('worktreePrepare',{mode:'remove',targetContext:c.id})).ok,false);git(f.repo,'worktree','unlock',c.root);const plan=ok(await f.call('worktreePrepare',{mode:'remove',targetContext:c.id}));ok(await f.call('worktreeExecute',{token:plan.token,digest:plan.digest}));await wait(()=>f.manager.worktrees.task);assert.equal(git(f.repo,'rev-parse','codex/test'),f.head);assert.equal((await f.call('status',{},c.id)).ok,false);await assert.rejects(fs.stat(c.root));const stale=ok(await f.call('worktreePrepare',{mode:'create',path:path.join(f.base,'stale'),branch:'codex/stale',revision:f.head}));git(f.repo,'branch','other');ok(await f.call('worktreeExecute',{token:stale.token,digest:stale.digest}));for(let i=0;i<5000&&f.manager.worktrees.task.status==='running';i++)await new Promise(r=>setTimeout(r,10));assert.equal(f.manager.worktrees.task.status,'failed');await assert.rejects(fs.stat(path.join(f.base,'stale')));});
test('human review keeps original baseline, rejects stale edits and cannot be approved by MCP; valid full-file staging retains approval',async t=>{const f=await fixture(t);await fs.writeFile(path.join(f.repo,'file.txt'),'existing dirty\n');const task=ok(await f.call('scopeStart',{title:'review existing',paths:['new.txt']}));const request=ok(await f.call('scopeReviewRequest',{taskId:task.id,paths:['file.txt']}));assert.equal((await f.call('scopeApprove',{id:request.id,confirmed:true})).ok,false);let record=await f.manager.reviews.view(request.id);assert.match(record.patch,/existing dirty/);await fs.writeFile(path.join(f.repo,'file.txt'),'changed after review\n');await assert.rejects(f.manager.reviewDecision(record.id,record.digest,true),/变化/);const fresh=ok(await f.call('scopeReviewRequest',{taskId:task.id,paths:['file.txt']}));record=await f.manager.reviews.view(fresh.id);await f.manager.reviewDecision(record.id,record.digest,true);let review=await f.service.scopeReview('.',task.id,['file.txt']);assert.equal(review.canProceed,true);assert.equal(review.files[0].humanReviewed,true);assert.equal(review.files[0].classification,'mixed');await action(f,'creator',{action:'stage',paths:['file.txt']},task.id);review=await f.service.scopeReview('.',task.id);assert.equal(review.canProceed,true,JSON.stringify(review.blockers));assert.equal(review.files[0].humanReviewed,true);await fs.writeFile(path.join(f.repo,'file.txt'),'another edit');assert.equal((await f.service.scopeReview('.',task.id)).canProceed,false);const again=new WorkspaceContexts(f.service,async()=>({}));assert((await again.reviews.list()).some(r=>r.id===fresh.id&&r.status==='approved'));});
test('common queries have bounded pages and reject stale diff versions',async t=>{const f=await fixture(t);git(f.repo,'branch','codex/one');git(f.repo,'branch','codex/two');let page=ok(await f.call('branches',{limit:1}));assert.equal(page.entries.length,1);assert.equal(page.nextOffset,1);assert.equal((await f.call('branches',{offset:1,limit:1})).ok,false);assert.equal(ok(await f.call('branches',{offset:1,limit:1,version:page.version})).entries.length,1);await fs.writeFile(path.join(f.repo,'file.txt'),'new content\n');page=ok(await f.call('diff',{path:'file.txt',view:'after',limit:3}));assert.equal(page.text,'new');await fs.writeFile(path.join(f.repo,'file.txt'),'different\n');assert.equal((await f.call('diff',{path:'file.txt',view:'after',offset:3,version:page.version})).ok,false);assert.equal(ok(await f.call('history',{scope:'all'})).commits.length,1);assert.equal(ok(await f.call('commitFiles',{revision:f.head})).total,2);});
test('isolated contexts persist, external worktrees can only be forgotten and tokens never cross contexts',async t=>{const f=await fixture(t),c=await create(f);const other=path.join(f.base,'external');git(f.repo,'worktree','add','-b','codex/external',other,f.head);const e=ok(await f.call('contextRegister',{path:other}));assert.equal((await f.call('worktreePrepare',{mode:'remove',targetContext:e.id})).ok,false);assert.equal((await new WorkspaceContexts(f.service,async()=>({})).worktrees.get(c.id)).root,c.root);const task=ok(await f.call('scopeStart',{title:'t',paths:['file.txt']},c.id));await fs.writeFile(path.join(c.root,'file.txt'),'test');const version=(await (await f.manager.service(c.id)).snapshot(true)).repositories[0].version;const plan=ok(await f.call('prepare',{taskId:task.id,operation:{action:'stage',version,paths:['file.txt']}},c.id));assert.equal((await f.call('execute',{token:plan.plan.token,digest:plan.digest})).ok,false);assert.equal(git(f.repo,'diff','--cached'),'');ok(await f.call('contextForget',{},e.id));assert.equal(await fs.readFile(path.join(other,'file.txt'),'utf8'),'base\n');});
test('human approval never authorizes transformed filtered staging or partial index edits',async t=>{const f=await fixture(t);await fs.writeFile(path.join(f.repo,'file.txt'),'approved content\n');const task=ok(await f.call('scopeStart',{title:'review',paths:['file.txt']}));const a=ok(await f.call('scopeReviewRequest',{taskId:task.id,paths:['file.txt']}));const row=await f.manager.reviews.view(a.id);await f.manager.reviewDecision(row.id,row.digest,true);const oid=execFileSync('git',['hash-object','-w','--stdin'],{cwd:f.repo,input:'different index\n',encoding:'utf8'}).trim();git(f.repo,'update-index','--cacheinfo','100644,'+oid+',file.txt');const result=await f.service.scopeReview('.',task.id);assert.equal(result.canProceed,false);assert.equal(result.files[0].humanReviewed,false);});
test('cross-context write lease blocks Creator operations until isolated job ends',async t=>{const f=await fixture(t),c=await create(f);const service=await f.manager.service(c.id);service.taskState={id:'hold',status:'running',title:'hold',startedAt:new Date().toISOString(),log:''};const version=(await f.service.snapshot(true)).repositories[0].version;await assert.rejects(f.service.prepare({repo:'.',action:'fetch',version,remote:'origin'}),/busy/);assert.equal((await f.call('scopeStart',{title:'t',paths:['file.txt']})).ok,false);service.taskState.status='success';assert.equal(f.manager.running(),false);});
test('initialized submodule worktree registers against child common directory and cannot remove gitlink trees',async t=>{const f=await fixture(t),child=path.join(f.base,'child');git(f.base,'clone',f.repo,child);git(f.repo,'-c','protocol.file.allow=always','submodule','add',child,'modules/part');git(f.repo,'commit','-am','module');const module=path.join(f.repo,'modules/part'),sha=git(module,'rev-parse','HEAD'),destination=path.join(f.base,'module-worktree');const plan=ok(await f.call('worktreePrepare',{mode:'create',baseRepo:'modules/part',path:destination,branch:'codex/module',revision:sha}));ok(await f.call('worktreeExecute',{token:plan.token,digest:plan.digest}));await wait(()=>f.manager.worktrees.task);const entries=ok(await f.call('contexts',{baseRepo:'modules/part'}));assert.equal(entries.contexts[0].baseRepo,'modules/part');assert.equal(entries.contexts[0].root,destination);assert.equal((await f.call('status',{},entries.contexts[0].id)).ok,true);assert.equal(git(module,'branch','--show-current'),'dev');});
test('historical diff fragments keep stable versions across temporary comparison paths',async t=>{const f=await fixture(t);await fs.writeFile(path.join(f.repo,'file.txt'),'next\n');git(f.repo,'commit','-am','next');const sha=git(f.repo,'rev-parse','HEAD');const page=ok(await f.call('diff',{path:'file.txt',area:'commit',revision:sha,view:'patch',limit:7}));const second=ok(await f.call('diff',{path:'file.txt',area:'commit',revision:sha,view:'patch',limit:7,offset:7,version:page.version}));assert.equal(second.version,page.version);assert.equal(second.offset,7);});
test('completed worktree lifecycle task remains readable without task ID and after reload',async t=>{const f=await fixture(t);await create(f);const status=ok(await f.call('task'));assert.equal(status.status,'success');assert.equal(status.id,f.manager.worktrees.task.id);for(let i=0;i<50;i++){const raw=JSON.parse(await fs.readFile(path.join(f.base,'cache/workspaces/worktree-task.json'),'utf8'));if(raw.task.status==='success')break;await new Promise(r=>setTimeout(r,10));}const manager=new WorkspaceContexts(f.service,async()=>({}));const reloaded=ok(await manager.handle('.',{kind:'agent',protocol:1,op:'task'}));assert.equal(reloaded.status,'success');assert.equal(reloaded.id,status.id);});

test('review notes and reasons persist; notification failure keeps the original request pending',async t=>{const f=await fixture(t);await fs.writeFile(path.join(f.repo,'file.txt'),'existing dirty\n');const task=ok(await f.call('scopeStart',{title:'审阅既有改动',paths:['new.txt']}));const notes={summary:'纳入先前修复的具体内容',focus:'确认原有改动属于本任务',validation:'未运行游戏'};let notified;const manager=new WorkspaceContexts(f.service,async()=>({}),async id=>{notified=id;throw new Error('panel unavailable');});const result=ok(await manager.handle('.',{kind:'agent',protocol:1,op:'scopeReviewRequest',taskId:task.id,paths:['file.txt'],review:notes}));assert.equal(result.id,notified);assert.equal(result.notification,'failed');assert.equal(result.notificationError,'panel unavailable');const saved=await manager.reviews.view(result.id);assert.deepEqual(saved.review,notes);assert.equal(saved.sections.length,2);assert.deepEqual(saved.sections.map(s=>s.area),['index','worktree']);assert(saved.patch.slice(saved.sections[1].start,saved.sections[1].start+saved.sections[1].length).includes('existing dirty'));assert.match(saved.files[0].reasons.join(' '),/任务开始前已有改动/);assert.match(saved.files[0].reasons.join(' '),/最初声明/);assert.equal(saved.status,'pending');assert.equal(git(f.repo,'diff','--cached'),'');assert.equal(git(f.repo,'rev-parse','HEAD'),f.head);});
test('review schema rejects incomplete notes and allows notes through MCP request mapping',async t=>{const f=await fixture(t);await fs.writeFile(path.join(f.repo,'file.txt'),'dirty\n');const task=ok(await f.call('scopeStart',{title:'t',paths:['file.txt']}));const invalid=await f.call('scopeReviewRequest',{taskId:task.id,paths:['file.txt'],review:{summary:'missing fields'}});assert.equal(invalid.ok,false);assert.equal((await f.manager.reviews.list()).length,0);const notes={summary:'具体改动',focus:'归属',validation:'未验证'};assert.deepEqual(mcpQuery('git_desk_scope_review',{mode:'request',taskId:task.id,paths:['file.txt'],review:notes}).query.review,notes);});

test('isolated workspaces inherit project review policy and only explicit workspace settings override it',async t=>{
    const f=await fixture(t);await fs.mkdir(path.join(f.base,'cache'),{recursive:true});
    await fs.writeFile(path.join(f.base,'cache/agent-settings.json'),JSON.stringify({requireHumanReview:false}));
    const c=await create(f),service=await f.manager.service(c.id);
    await fs.writeFile(path.join(c.root,'file.txt'),'existing workspace edit');
    const task=await service.scopeStart('.','inherited',['file.txt']);
    let review=await service.scopeReview('.',task.id,['file.txt']);assert.equal(review.humanReviewRequired,false);assert.equal(review.reviewPolicySource,'project');assert.equal(review.canProceed,true);
    let capabilities=ok(await f.call('capabilities',{},c.id));assert.deepEqual(capabilities.taskScopes.reviewPolicy,{required:false,source:'project'});
    await fs.writeFile(path.join(service.cache,'agent-settings.json'),JSON.stringify({requireHumanReview:true}));
    review=await service.scopeReview('.',task.id,['file.txt']);assert.equal(review.humanReviewRequired,true);assert.equal(review.reviewPolicySource,'workspace');assert.equal(review.canProceed,false);
    await fs.writeFile(path.join(service.cache,'agent-settings.json'),'{}');assert.equal((await service.scopeReview('.',task.id,['file.txt'])).humanReviewRequired,false);
    await fs.writeFile(path.join(service.cache,'agent-settings.json'),JSON.stringify({requireHumanReview:'invalid'}));await assert.rejects(service.scopeReview('.',task.id,['file.txt']),/布尔值/);
});
test('expired review records are archived intact when creating another request and do not occupy the active queue',async t=>{
    const f=await fixture(t);await fs.writeFile(path.join(f.repo,'file.txt'),'existing edit');
    const task=ok(await f.call('scopeStart',{title:'review archive',paths:['file.txt']}));
    const first=ok(await f.call('scopeReviewRequest',{taskId:task.id,paths:['file.txt']}));
    const directory=path.join(f.base,'cache/workspaces/scope-reviews'),filename=path.join(directory,first.id+'.json');
    const stale=JSON.parse(await fs.readFile(filename,'utf8'));stale.expiresAt=Date.now()-1000;await fs.writeFile(filename,JSON.stringify(stale));const bytes=await fs.readFile(filename);
    const second=ok(await f.call('scopeReviewRequest',{taskId:task.id,paths:['file.txt']}));
    assert.notEqual(second.id,first.id);
    assert.deepEqual(await fs.readFile(path.join(f.base,'cache/workspaces/scope-review-archives',first.id+'.json')),bytes);
    assert.equal((await f.manager.reviews.list()).length,1);
    assert.equal(git(f.repo,'rev-parse','HEAD'),f.head);assert.equal(git(f.repo,'diff','--cached'),'');
});

// Exercise the public context route, including versioned MCP conflict metadata.
async function mergeFixture(t, conflict = false, submodule = false) {
    const f = await fixture(t);
    if (submodule) {
        const child = path.join(f.base, 'child');
        git(f.base, 'clone', f.repo, child);
        git(f.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'modules/part');
        git(f.repo, 'commit', '-am', 'module');
    }
    git(f.repo, 'switch', '-c', 'topic');
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'incoming\n');
    git(f.repo, 'commit', '-am', 'incoming');
    f.target = git(f.repo, 'rev-parse', 'HEAD');
    git(f.repo, 'switch', 'dev');
    await fs.writeFile(path.join(f.repo, conflict ? 'file.txt' : 'ours.txt'), 'ours\n');
    git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'ours');
    f.head = git(f.repo, 'rev-parse', 'HEAD');
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'user staged\n'); git(f.repo, 'add', 'file.txt');
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'user unstaged\n');
    const before = [git(f.repo, 'diff', '--cached'), git(f.repo, 'diff'), git(f.repo, 'status', '--porcelain')];
    f.assertSource = async () => {
        assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
        assert.deepEqual([git(f.repo, 'diff', '--cached'), git(f.repo, 'diff'), git(f.repo, 'status', '--porcelain')], before);
        assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'user unstaged\n');
    };
    f.context = await create(f);
    f.service.host.checkEditor = async () => { throw Error('Creator has unsaved scene'); };
    f.service.host.beforeWorktreeChange = async () => { throw Error('must not change Creator'); };
    return f;
}
test('isolated clean merge finishes without touching dirty Creator, including uninitialized unrelated submodule', async t => {
    const f = await mergeFixture(t, false, true), c = f.context;
    const caps = ok(await f.call('capabilities', {}, c.id));
    for (const name of ['beginMerge', 'resolveConflict', 'finishMerge', 'abortMerge']) assert(caps.workspaces.isolatedActions.includes(name));
    await action(f, c.id, { action: 'beginMerge', revision: f.target });
    assert.equal(git(c.root, 'rev-parse', 'HEAD'), f.head);
    const state = ok(await f.call('merge', {}, c.id)); assert.equal(state.canFinish, true);
    await action(f, c.id, { action: 'finishMerge', mergeVersion: state.version, message: 'merge isolated' });
    assert.equal(git(c.root, 'rev-list', '--parents', '-n', '1', 'HEAD'), [git(c.root, 'rev-parse', 'HEAD'), f.head, f.target].join(' '));
    assert.equal(await fs.readFile(path.join(c.root, 'file.txt'), 'utf8'), 'incoming\n');
    await assert.rejects(fs.stat(path.join(c.root, 'modules/part/.git')));
    await f.assertSource();
});
test('isolated conflict metadata allows resolve and finish through the same context', async t => {
    const f = await mergeFixture(t, true), c = f.context;
    await action(f, c.id, { action: 'beginMerge', revision: f.target });
    assert.equal(ok(await f.call('merge', {}, c.id)).canFinish, false);
    await fs.writeFile(path.join(c.root, 'file.txt'), 'reviewed resolution\n');
    const diff = ok(await f.call('diff', { path: 'file.txt', area: 'conflict', view: 'summary' }, c.id));
    assert.equal(diff.conflict.resolution, 'content'); assert(diff.conflict.version);
    await action(f, c.id, { action: 'resolveConflict', resolution: { path: 'file.txt', version: diff.conflict.version, mode: diff.conflict.resolution } });
    const state = ok(await f.call('merge', {}, c.id)); assert.equal(state.canFinish, true);
    await action(f, c.id, { action: 'finishMerge', mergeVersion: state.version, message: 'resolve isolated' });
    assert.equal(git(c.root, 'show', 'HEAD:file.txt'), 'reviewed resolution');
    await f.assertSource();
});
test('isolated merge abort survives service reload and rejects cross-context tokens', async t => {
    const f = await mergeFixture(t, true), c = f.context;
    const version = (await (await f.manager.service(c.id)).snapshot(true)).repositories[0].version;
    const plan = ok(await f.call('prepare', { operation: { action: 'beginMerge', version, revision: f.target } }, c.id));
    assert.equal((await f.call('execute', { token: plan.plan.token, digest: plan.digest })).ok, false);
    ok(await f.call('execute', { token: plan.plan.token, digest: plan.digest }, c.id));
    await wait(() => f.manager.displayTask());
    f.manager = new WorkspaceContexts(f.service, async () => ({}), undefined, { queueMs: 300 });
    f.call = (op, args = {}, context = 'creator') => f.manager.handle('.', { kind: 'agent', protocol: 1, op, ...args }, context);
    const state = ok(await f.call('merge', {}, c.id)); assert.equal(state.canAbort, true, state.abortReason);
    await action(f, c.id, { action: 'abortMerge', mergeVersion: state.abortVersion });
    assert.equal(git(c.root, 'status', '--porcelain'), ''); assert.equal(git(c.root, 'rev-parse', 'HEAD'), f.head);
    assert.equal(await fs.readFile(path.join(c.root, 'file.txt'), 'utf8'), 'ours\n');
    await f.assertSource();
});

// All new flows pass the MCP argument mapper, not only the context router.
function throughMcp(f) {
    const route = f.call;
    f.call = (op, args = {}, context = 'creator') => {
        const name = ({ prepare: 'git_desk_prepare', execute: 'git_desk_execute', scopeStart: 'git_desk_task_start', worktreePrepare: 'git_desk_worktree_prepare', worktreeExecute: 'git_desk_worktree_execute', contexts: 'git_desk_context_list' })[op] || 'git_desk_query';
        const input = name === 'git_desk_query' ? { op, arguments: args, context } : { ...args, context };
        const mapped = mcpQuery(name, input);
        return f.manager.handle(mapped.repo, mapped.query, mapped.context);
    };
}
test('native MCP merge handles large files, more than fifty paths and rename detection in one operation', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.repo, 'rename.txt'), 'a\nb\nc\n'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'seed rename');
    git(f.repo, 'switch', '-c', 'topic'); git(f.repo, 'mv', 'rename.txt', 'renamed.txt');
    for (let n = 0; n < 55; n++) await fs.writeFile(path.join(f.repo, `added-${n}.txt`), 'incoming\n');
    await fs.writeFile(path.join(f.repo, 'large.txt'), Buffer.alloc(6 * 1024 * 1024, 97));
    git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'incoming'); const target = git(f.repo, 'rev-parse', 'HEAD');
    git(f.repo, 'switch', 'dev'); await fs.writeFile(path.join(f.repo, 'rename.txt'), 'a\nb\nchanged\n'); git(f.repo, 'commit', '-am', 'edit');
    f.head = git(f.repo, 'rev-parse', 'HEAD'); const c = await create(f); throughMcp(f);
    await action(f, c.id, { action: 'merge', revision: target });
    assert.equal(git(c.root, 'status', '--porcelain'), '');
    assert.equal(git(c.root, 'show', 'HEAD:renamed.txt'), 'a\nb\nchanged');
    assert.equal(git(c.root, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
    assert.equal((await fs.stat(path.join(c.root, 'large.txt'))).size, 6 * 1024 * 1024);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
});
test('native merge fast forwards without synthetic merge commit and reports operation metrics', async t => {
    const f = await fixture(t), c = await create(f); await fs.writeFile(path.join(f.repo, 'file.txt'), 'next\n'); git(f.repo, 'commit', '-am', 'next');
    const target = git(f.repo, 'rev-parse', 'HEAD'); throughMcp(f);
    const svc = await f.manager.service(c.id), version = (await svc.snapshot(true)).repositories[0].version;
    const plan = ok(await f.call('prepare', { operation: { action: 'merge', version, revision: target } }, c.id));
    assert(plan.plan.metrics.gitCalls > 0); assert(plan.plan.metrics.elapsedMs >= 0); assert.equal(plan.plan.metrics.networkGitMs, 0);
    ok(await f.call('execute', { token: plan.plan.token, digest: plan.digest }, c.id)); const task = await wait(() => svc.task());
    assert.equal(git(c.root, 'rev-parse', 'HEAD'), target); assert(task.metrics.gitCalls > 0); assert(task.metrics.gitMs > 0);
});
test('native conflict can be finished via actual authenticated MCP HTTP transport', async t => {
    const f = await mergeFixture(t, true), c = f.context; throughMcp(f);
    await action(f, c.id, { action: 'merge', revision: f.target });
    await fs.writeFile(path.join(c.root, 'file.txt'), 'resolved native\n');
    const diff = ok(await f.call('diff', { path: 'file.txt', area: 'conflict' }, c.id));
    await action(f, c.id, { action: 'resolveConflict', resolution: { path: 'file.txt', version: diff.conflict.version, mode: 'content' } });
    const state = ok(await f.call('merge', {}, c.id));
    const { startMcpBridge } = require('../dist/mcp-bridge');
    const cache = path.join(f.base, 'http-cache'); const bridge = await startMcpBridge(cache, f.repo, (repo, query, context) => f.manager.handle(repo, query, context));
    t.after(() => bridge.close()); const info = JSON.parse(await fs.readFile(path.join(cache, 'agent-connection.json'), 'utf8'));
    const rpc = async (name, args) => { const r = await fetch(`http://127.0.0.1:${info.port}/rpc`, { method: 'POST', headers: { Authorization: 'Bearer ' + info.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: { ...args, context: c.id } }) }); return ok(await r.json()); };
    const version = (await (await f.manager.service(c.id)).snapshot(true)).repositories[0].version;
    const prepared = await rpc('git_desk_prepare', { operation: { action: 'finishMerge', version, mergeVersion: state.version, message: 'resolved through MCP' } });
    await rpc('git_desk_execute', { token: prepared.plan.token, digest: prepared.digest }); await wait(() => f.manager.displayTask());
    assert.equal(git(c.root, 'show', 'HEAD:file.txt'), 'resolved native'); await f.assertSource();
});
test('native conflicting merge aborts from recorded clean start', async t => {
    const f = await mergeFixture(t, true), c = f.context; throughMcp(f);
    await action(f, c.id, { action: 'merge', revision: f.target });
    const state = ok(await f.call('merge', {}, c.id)); assert.equal(state.canAbort, true, state.abortReason);
    await action(f, c.id, { action: 'abortMerge', mergeVersion: state.abortVersion });
    assert.equal(git(c.root, 'status', '--porcelain'), ''); assert.equal(git(c.root, 'rev-parse', 'HEAD'), f.head); await f.assertSource();
});
test('selected commit previews without changing index and commits exactly the expanded scope', async t => {
    const f = await fixture(t); throughMcp(f);
    const scope = ok(await f.call('scopeStart', { title: 'selected', paths: ['file.txt', 'file.txt.meta'] }));
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'selected\n'); await fs.writeFile(path.join(f.repo, 'file.txt.meta'), '{}\n');
    await fs.writeFile(path.join(f.repo, 'unrelated.txt'), 'keep\n');
    const before = git(f.repo, 'ls-files', '--stage'); const version = (await f.service.snapshot(true)).repositories[0].version;
    const prepared = ok(await f.call('prepare', { taskId: scope.id, operation: { action: 'commitSelected', version, paths: ['file.txt'], message: 'selected commit' } }));
    assert.equal(git(f.repo, 'ls-files', '--stage'), before); assert.deepEqual(prepared.plan.paths.sort(), ['file.txt', 'file.txt.meta']);
    ok(await f.call('execute', { token: prepared.plan.token, digest: prepared.digest })); await wait(() => f.service.task());
    assert.equal(git(f.repo, 'show', 'HEAD:file.txt'), 'selected'); assert.equal(git(f.repo, 'show', 'HEAD:file.txt.meta'), '{}');
    assert.match(git(f.repo, 'status', '--porcelain'), /unrelated.txt/);
});
test('selected commit refuses unrelated staged files and stale reviewed content', async t => {
    const f = await fixture(t); throughMcp(f);
    const scope = ok(await f.call('scopeStart', { title: 'selected', paths: ['file.txt'] }));
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'selected\n'); await fs.writeFile(path.join(f.repo, 'other.txt'), 'other\n'); git(f.repo, 'add', 'other.txt');
    let version = (await f.service.snapshot(true)).repositories[0].version;
    assert.equal((await f.call('prepare', { taskId: scope.id, operation: { action: 'commitSelected', version, paths: ['file.txt'], message: 'selected' } })).ok, false);
    git(f.repo, 'reset', 'HEAD', '--', 'other.txt'); version = (await f.service.snapshot(true)).repositories[0].version;
    const plan = ok(await f.call('prepare', { taskId: scope.id, operation: { action: 'commitSelected', version, paths: ['file.txt'], message: 'selected' } }));
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'newer\n');
    assert.equal((await f.call('execute', { token: plan.plan.token, digest: plan.digest })).ok, false);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head); assert.equal(git(f.repo, 'diff', '--cached'), '');
});
test('selected commit hook failure leaves staged work and does not retry', async t => {
    const f = await fixture(t); throughMcp(f);
    const scope = ok(await f.call('scopeStart', { title: 'hook', paths: ['file.txt'] }));
    const hooks = path.join(f.base, 'hooks'); await fs.mkdir(hooks); await fs.writeFile(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 }); git(f.repo, 'config', 'core.hooksPath', hooks);
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'keep staged\n');
    const version = (await f.service.snapshot(true)).repositories[0].version;
    const plan = ok(await f.call('prepare', { taskId: scope.id, operation: { action: 'commitSelected', version, paths: ['file.txt'], message: 'hook' } }));
    ok(await f.call('execute', { token: plan.plan.token, digest: plan.digest }));
    for (let i = 0; i < 5000 && f.service.task().status === 'running'; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(f.service.task().status, 'failed'); assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head); assert.equal(git(f.repo, 'show', ':file.txt'), 'keep staged');
});
test('clean worktree with uninitialized submodule can be removed, populated directory cannot', async t => {
    const f = await mergeFixture(t, false, true), c = f.context; throughMcp(f);
    await fs.writeFile(path.join(c.root, 'modules/part/keep.txt'), 'keep');
    assert.equal((await f.call('worktreePrepare', { mode: 'remove', targetContext: c.id })).ok, false);
    await fs.unlink(path.join(c.root, 'modules/part/keep.txt'));
    const plan = ok(await f.call('worktreePrepare', { mode: 'remove', targetContext: c.id }));
    ok(await f.call('worktreeExecute', { token: plan.token, digest: plan.digest })); await wait(() => f.manager.worktrees.task);
    await assert.rejects(fs.stat(c.root)); assert.equal(git(f.repo, 'rev-parse', 'codex/test'), f.head); await f.assertSource();
});

test('selected resource commit rechecks newly unsaved editor state before staging', async t => {
    const f = await fixture(t); throughMcp(f);
    const scope = ok(await f.call('scopeStart', { title: 'resource', paths: ['file.txt.meta'] }));
    await fs.writeFile(path.join(f.repo, 'file.txt.meta'), '{}\n');
    const version = (await f.service.snapshot(true)).repositories[0].version;
    const plan = ok(await f.call('prepare', { taskId: scope.id, operation: { action: 'commitSelected', version, paths: ['file.txt.meta'], message: 'resource' } }));
    f.service.host.checkEditor = async () => { throw Error('unsaved scene'); };
    ok(await f.call('execute', { token: plan.plan.token, digest: plan.digest }));
    for (let i = 0; i < 5000 && f.service.task().status === 'running'; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(f.service.task().status, 'failed'); assert.match(f.service.task().log, /unsaved scene/);
    assert.equal(git(f.repo, 'diff', '--cached'), ''); assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
});
test('native merge keeps unrelated unstaged edits and refuses overlapping or staged ones', async t => {
    const f = await fixture(t);
    git(f.repo, 'checkout', '-q', '-b', 'feature'); await fs.writeFile(path.join(f.repo, 'other.txt'), 'feature\n'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-q', '-m', 'feature');
    const target = git(f.repo, 'rev-parse', 'HEAD'); git(f.repo, 'checkout', '-q', 'dev');
    await fs.writeFile(path.join(f.repo, 'notes.txt'), 'wip\n'); await fs.writeFile(path.join(f.repo, 'file.txt'), 'local edit\n');
    const version = async () => (await f.service.snapshot(true)).repositories[0].version;
    const plan = ok(await f.call('prepare', { operation: { action: 'merge', version: await version(), revision: target } }));
    assert.match(plan.plan.warnings.join('\n'), /保留 2 个与合并内容不重叠的未暂存改动：file.txt、notes.txt/);
    ok(await f.call('execute', { token: plan.plan.token, digest: plan.digest })); await wait(() => f.service.task());
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), target); assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'local edit\n'); assert.equal(await fs.readFile(path.join(f.repo, 'notes.txt'), 'utf8'), 'wip\n');
    git(f.repo, 'checkout', '-q', '-b', 'feature2'); git(f.repo, 'stash', '-q'); await fs.writeFile(path.join(f.repo, 'file.txt'), 'feature2\n'); git(f.repo, 'commit', '-q', '-am', 'feature2');
    const overlapping = git(f.repo, 'rev-parse', 'HEAD'); git(f.repo, 'checkout', '-q', 'dev'); git(f.repo, 'stash', 'pop', '-q');
    const refused = await f.call('prepare', { operation: { action: 'merge', version: await version(), revision: overlapping } });
    assert.equal(refused.ok, false); assert.match(refused.error, /与合并内容重叠：file.txt/);
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'base\n'); git(f.repo, 'add', 'notes.txt');
    const staged = await f.call('prepare', { operation: { action: 'merge', version: await version(), revision: overlapping } });
    assert.equal(staged.ok, false); assert.match(staged.error, /已暂存改动（notes.txt）/);
});

test('a mutation queued behind a running task proceeds once it ends instead of being refused', async t => {
    const f = await fixture(t);
    f.service.taskState = { id: 'hold', status: 'running', title: 'hold', startedAt: new Date().toISOString(), log: '' };
    setTimeout(() => { f.service.taskState.status = 'success'; }, 120);
    const started = Date.now(); const reply = await f.call('scopeStart', { title: 'queued', paths: ['file.txt'] });
    assert.equal(reply.ok, true, JSON.stringify(reply)); assert.ok(Date.now() - started >= 100, 'waited for the task');
    f.service.taskState = { id: 'hold2', status: 'running', title: 'hold', startedAt: new Date().toISOString(), log: '' };
    const refused = await f.call('scopeStart', { title: 'blocked', paths: ['file.txt'] });
    assert.equal(refused.ok, false); assert.match(refused.error, /已有 Git 操作或预览正在处理/);
    const status = ok(await f.call('task', { waitMs: 150 })); assert.equal(status.requiresPolling, true); assert.ok(status.waitedMs >= 100);
    f.service.taskState.status = 'success';
});
