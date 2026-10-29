const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { previewProjectUpdate, executeProjectUpdate } = require('../dist/project-update');
function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim(); }
async function fixture(t) {
    const parent=path.resolve(__dirname,'../.cache/test-project-update');await fs.mkdir(parent,{recursive:true});
    const base=await fs.mkdtemp(path.join(parent,'case-')),remote=path.join(base,'remote.git'),seed=path.join(base,'seed'),repo=path.join(base,'project'),cache=path.join(base,'cache');
    t.after(()=>fs.rm(base,{recursive:true,force:true}));
    await fs.mkdir(seed);git(base,'init','--bare',remote);git(seed,'init','-b','main');
    git(seed,'config','user.name','Git Desk Test');git(seed,'config','user.email','test@example.invalid');
    await fs.writeFile(path.join(seed,'file.txt'),'base\n');git(seed,'add','.');git(seed,'commit','-m','initial');git(seed,'remote','add','origin',remote);git(seed,'push','-u','origin','main');git(base,'clone','--branch','main',remote,repo);
    git(repo,'config','user.name','Git Desk Test');git(repo,'config','user.email','test@example.invalid');
    return {base,seed,repo,cache};
}
async function advance(f, name='other.txt') {
    await fs.writeFile(path.join(f.seed,name),'upstream change\n');git(f.seed,'add','.');git(f.seed,'commit','-m','upstream');git(f.seed,'push');return git(f.seed,'rev-parse','HEAD');
}
test('local preview does not fetch or mutate refs, index, files or stash',async t=>{
    const f=await fixture(t),before=git(f.repo,'rev-parse','refs/remotes/origin/main');await advance(f);
    const index=await fs.readFile(path.join(f.repo,'.git/index'));const plan=await previewProjectUpdate(f.repo,f.cache);
    assert.equal(plan.entries[0].id,'.');assert.equal(plan.entries[0].branch,'main');
    assert.equal(git(f.repo,'rev-parse','refs/remotes/origin/main'),before);assert.deepEqual(await fs.readFile(path.join(f.repo,'.git/index')),index);
    assert.equal(git(f.repo,'stash','list'),'');assert.equal(await fs.readFile(path.join(f.repo,'file.txt'),'utf8'),'base\n');
});
test('execute emits per-repository progress, fast-forwards and preserves unrelated edits',async t=>{
    const f=await fixture(t),target=await advance(f);await fs.writeFile(path.join(f.repo,'file.txt'),'local edit\n');
    const plan=await previewProjectUpdate(f.repo,f.cache),rows=[];await executeProjectUpdate(plan,f.cache,row=>rows.push(row),()=>{});
    assert.ok(rows.some(row=>row.status==='running'));assert.equal(rows.at(-1).status,'success');assert.equal(rows.at(-1).head,target);
    assert.equal(await fs.readFile(path.join(f.repo,'file.txt'),'utf8'),'local edit\n');assert.equal(git(f.repo,'rev-parse','HEAD'),target);
});
test('editing the same dirty path after preview stops the entire operation before fetch',async t=>{
    const f=await fixture(t);await fs.writeFile(path.join(f.repo,'file.txt'),'first edit\n');const plan=await previewProjectUpdate(f.repo,f.cache);
    const before=git(f.repo,'rev-parse','refs/remotes/origin/main');await advance(f);await fs.writeFile(path.join(f.repo,'file.txt'),'later edit\n');
    await assert.rejects(executeProjectUpdate(plan,f.cache,()=>{},()=>{}),/状态变化/);
    assert.equal(git(f.repo,'rev-parse','refs/remotes/origin/main'),before);assert.equal(await fs.readFile(path.join(f.repo,'file.txt'),'utf8'),'later edit\n');
});
test('divergence is reported as failed without rewriting local commits',async t=>{
    const f=await fixture(t);await advance(f);await fs.writeFile(path.join(f.repo,'local.txt'),'local\n');git(f.repo,'add','.');git(f.repo,'commit','-m','local');
    const before=git(f.repo,'rev-parse','HEAD'),plan=await previewProjectUpdate(f.repo,f.cache),rows=[];
    await assert.rejects(executeProjectUpdate(plan,f.cache,row=>rows.push(row),()=>{}),/未全部完成/);
    assert.ok(rows.some(row=>row.status==='failed'&&row.detail.includes('分叉')));assert.equal(git(f.repo,'rev-parse','HEAD'),before);
});
test('initialized submodules each receive an independent final progress result',async t=>{
    const f=await fixture(t),child=path.join(f.repo,'deps/lib'),remote=path.join(f.base,'remote.git');
    const childRemote=path.join(f.base,'child-remote.git'),childSeed=path.join(f.base,'child-seed');
    git(f.base,'clone','--bare',remote,childRemote);git(f.base,'clone','--branch','main',childRemote,childSeed);
    git(childSeed,'config','user.name','Git Desk Test');git(childSeed,'config','user.email','test@example.invalid');
    git(f.repo,'-c','protocol.file.allow=always','submodule','add','-b','main',childRemote,'deps/lib');
    git(f.repo,'commit','-m','add module');git(f.repo,'push','origin','main');git(f.seed,'pull','--ff-only');
    await advance(f);const target=await advance({seed:childSeed}),plan=await previewProjectUpdate(f.repo,f.cache),rows=[];
    assert.deepEqual(plan.entries.map(row=>row.id),['.','deps/lib']);
    await executeProjectUpdate(plan,f.cache,row=>rows.push(row),()=>{});
    for(const id of ['.','deps/lib'])assert.ok(rows.some(row=>row.id===id&&row.status==='success'));
    assert.equal(git(child,'rev-parse','HEAD'),target);assert.equal(git(f.repo,'diff','--cached','--name-only'),'');
});

test('missing remote branch is skipped without failing or rewriting the local branch',async t=>{
    const f=await fixture(t),before=git(f.repo,'rev-parse','HEAD');
    git(f.repo,'switch','-c','local-only');
    const plan=await previewProjectUpdate(f.repo,f.cache),rows=[];
    await executeProjectUpdate(plan,f.cache,row=>rows.push(row),()=>{});
    assert.equal(rows.at(-1).status,'skipped');
    assert.equal(git(f.repo,'rev-parse','HEAD'),before);
    assert.ok(!rows.some(row=>row.status==='failed'));
});

test('uninitialized module is skipped without failing the initialized repositories',async t=>{
    const f=await fixture(t);
    git(f.repo,'-c','protocol.file.allow=always','submodule','add','-b','main',path.join(f.base,'remote.git'),'deps/lib');
    git(f.repo,'commit','-m','add module');git(f.repo,'submodule','deinit','-f','deps/lib');
    const plan=await previewProjectUpdate(f.repo,f.cache),rows=[];
    await executeProjectUpdate(plan,f.cache,row=>rows.push(row),()=>{});
    assert.ok(rows.some(row=>row.id==='deps/lib'&&row.status==='skipped'));
    assert.ok(rows.some(row=>row.id==='.'&&row.status==='success'));
    assert.ok(!rows.some(row=>row.status==='failed'));
});

async function finishDeskUpdate(desk, plan) {
    desk.execute(plan.token);
    const started = Date.now();
    while (desk.task().status === 'running') {
        if (Date.now() - started > 30000) throw new Error('update test timeout');
        await new Promise(resolve => setTimeout(resolve, 15));
    }
    return desk.task();
}
async function deskUpdateFixture(t) {
    const f = await fixture(t);
    const { GitDesk } = require('../dist/git');
    f.desk = new GitDesk(f.repo, f.cache, { async checkEditor() {}, async beforeWorktreeChange() {}, async afterWorktreeChange() {} });
    const state = await f.desk.snapshot(true);
    f.plan = await f.desk.prepare({ repo: '.', action: 'updateAll', version: state.repositories[0].version });
    return f;
}
test('index cache refresh does not reject a semantically unchanged project update', async t => {
    const f = await deskUpdateFixture(t), index = path.join(f.repo, '.git/index');
    const before = await fs.readFile(index), future = new Date(Date.now() + 5000);
    await fs.utimes(path.join(f.repo, 'file.txt'), future, future);
    git(f.repo, 'update-index', '--refresh');
    assert.notDeepEqual(await fs.readFile(index), before, 'the raw index must actually change');
    const result = await finishDeskUpdate(f.desk, f.plan);
    assert.equal(result.status, 'success', result.log);
    assert.equal(result.repositories[0].status, 'success');
    assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'base\n');
});
test('project update reports repository and staged changes without fetching or failing unstarted rows', async t => {
    const f = await deskUpdateFixture(t), remote = git(f.repo, 'rev-parse', 'refs/remotes/origin/main');
    await advance(f);
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'staged\n'); git(f.repo, 'add', 'file.txt');
    const result = await finishDeskUpdate(f.desk, f.plan);
    assert.equal(result.status, 'failed'); assert.equal(result.recovery, 'repreview');
    assert.match(result.log, /仓库 \./); assert.match(result.log, /暂存区条目/);
    assert.equal(result.repositories[0].status, 'skipped'); assert.equal(result.repositories[0].phase, '未执行');
    assert.equal(git(f.repo, 'rev-parse', 'refs/remotes/origin/main'), remote);
    assert.equal(git(f.repo, 'show', ':file.txt'), 'staged');
    assert.throws(() => f.desk.execute(f.plan.token), /过期/);
});
test('same-status dirty bytes and index flags remain protected by project update validation', async t => {
    const f = await fixture(t); await fs.writeFile(path.join(f.repo, 'file.txt'), 'first\n');
    let plan = await previewProjectUpdate(f.repo, f.cache);
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'later\n');
    await assert.rejects(executeProjectUpdate(plan, f.cache, () => {}, () => {}), /仓库 \..*文件内容/);
    plan = await previewProjectUpdate(f.repo, f.cache);
    git(f.repo, 'update-index', '--assume-unchanged', 'file.txt');
    await assert.rejects(executeProjectUpdate(plan, f.cache, () => {}, () => {}), /索引标记/);
});
