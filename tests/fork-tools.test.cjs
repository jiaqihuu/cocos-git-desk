const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { previewForkTool, executeForkTool } = require('../dist/fork-tools');
const { GitDesk } = require('../dist/git');
const git = (cwd, ...args) => execFileSync('git', ['-c','protocol.file.allow=always',...args], { cwd, encoding:'utf8', stdio:['ignore','pipe','pipe'] }).trim();
const runner = async (cwd,args,allowed=[0]) => {
    try { return { stdout:execFileSync('git',['-c','protocol.file.allow=always',...args],{cwd,stdio:['ignore','pipe','pipe']}) }; }
    catch(error) { if(allowed.includes(error.status))return { stdout:error.stdout };throw error; }
};
async function fixture(t) {
    const base=await fs.mkdtemp(path.resolve(__dirname,'../.cache/native-tools-'));
    t.after(()=>fs.rm(base,{recursive:true,force:true}));
    const remote=path.join(base,'remote.git'),seed=path.join(base,'seed'),repo=path.join(base,'项目 space'),cache=path.join(base,'cache');
    await fs.mkdir(seed);git(base,'init','--bare',remote);git(seed,'init','-b','release');
    for(const root of [seed]){git(root,'config','user.name','Fixture');git(root,'config','user.email','fixture@example.invalid');}
    await fs.writeFile(path.join(seed,'file.txt'),'base\n');git(seed,'add','file.txt');git(seed,'commit','-m','base');git(seed,'remote','add','server',remote);git(seed,'push','-u','server','release');
    git(base,'clone','--branch','release',remote,repo);git(repo,'config','user.name','Fixture');git(repo,'config','user.email','fixture@example.invalid');git(repo,'remote','rename','origin','server');
    return {base,remote,seed,repo,cache};
}
const preview=(f,action,branch='release')=>previewForkTool(f.repo,f.cache,action,{branch},runner);
const execute=(f,p)=>executeForkTool(p,f.cache,()=>{},runner,()=>{});

test('all three native previews need no project scripts, Fork configuration, dev branch or Terminal',async t=>{
    const f=await fixture(t),head=git(f.repo,'rev-parse','HEAD'),index=await fs.readFile(path.join(f.repo,'.git/index'));
    for(const action of ['forkSmartGit','forkResetPreferred','forkResetDev']){
        const p=await preview(f,action);assert.equal(p.targets[0].branch,'release');assert.equal(p.root,f.repo);
    }
    assert.equal(git(f.repo,'rev-parse','HEAD'),head);assert.deepEqual(await fs.readFile(path.join(f.repo,'.git/index')),index);
    assert.equal(git(f.repo,'status','--porcelain'),'');
});

test('preserve variant discards tracked edits but retains untracked and ignored files',async t=>{
    const f=await fixture(t);await fs.writeFile(path.join(f.repo,'file.txt'),'dirty\n');await fs.writeFile(path.join(f.repo,'untracked.txt'),'keep');
    await fs.writeFile(path.join(f.repo,'.git/info/exclude'),'ignored/\n');await fs.mkdir(path.join(f.repo,'ignored'));await fs.writeFile(path.join(f.repo,'ignored/cache'),'keep');
    const p=await preview(f,'forkResetPreferred');await execute(f,p);
    assert.equal(await fs.readFile(path.join(f.repo,'file.txt'),'utf8'),'base\n');assert.equal(await fs.readFile(path.join(f.repo,'untracked.txt'),'utf8'),'keep');assert.equal(await fs.readFile(path.join(f.repo,'ignored/cache'),'utf8'),'keep');
});

test('clean variant removes ordinary untracked content and preserves ignored and independent nested repos',async t=>{
    const f=await fixture(t);await fs.writeFile(path.join(f.repo,'file.txt'),'dirty\n');await fs.writeFile(path.join(f.repo,'remove.txt'),'remove');
    await fs.writeFile(path.join(f.repo,'.git/info/exclude'),'ignored.txt\n');await fs.writeFile(path.join(f.repo,'ignored.txt'),'keep');
    const independent=path.join(f.repo,'nested');await fs.mkdir(independent);git(independent,'init');
    const p=await preview(f,'forkResetDev');await execute(f,p);
    await assert.rejects(fs.access(path.join(f.repo,'remove.txt')),/ENOENT/);assert.equal(await fs.readFile(path.join(f.repo,'ignored.txt'),'utf8'),'keep');await fs.access(path.join(independent,'.git'));
});

test('switch uses an explicit non-dev branch, retains untracked files, and does not reset local history',async t=>{
    const f=await fixture(t),head=git(f.repo,'rev-parse','HEAD');git(f.repo,'branch','feature');await fs.writeFile(path.join(f.repo,'note.txt'),'keep');
    const p=await preview(f,'forkSmartGit','feature');await execute(f,p);
    assert.equal(git(f.repo,'branch','--show-current'),'feature');assert.equal(git(f.repo,'rev-parse','HEAD'),head);assert.equal(await fs.readFile(path.join(f.repo,'note.txt'),'utf8'),'keep');
});

test('local edits after preview and moved remote target stop before resetting work files',async t=>{
    const f=await fixture(t);const p=await preview(f,'forkResetDev');await fs.writeFile(path.join(f.repo,'later.txt'),'keep');
    await assert.rejects(execute(f,p),/状态.*变化/);assert.equal(await fs.readFile(path.join(f.repo,'later.txt'),'utf8'),'keep');
    const q=await preview(f,'forkResetPreferred');await fs.writeFile(path.join(f.seed,'new.txt'),'remote');git(f.seed,'add','new.txt');git(f.seed,'commit','-m','advance');git(f.seed,'push');
    const head=git(f.repo,'rev-parse','HEAD');await assert.rejects(execute(f,q),/远端目标已变化/);assert.equal(git(f.repo,'rev-parse','HEAD'),head);
});

test('destructive preview rejects ignored collisions and other-worktree branch ownership',async t=>{
    const f=await fixture(t);git(f.seed,'switch','-c','collision');await fs.writeFile(path.join(f.seed,'blocked.txt'),'remote');git(f.seed,'add','blocked.txt');git(f.seed,'commit','-m','collision');git(f.seed,'push','server','collision');git(f.repo,'fetch','server');
    await fs.writeFile(path.join(f.repo,'.git/info/exclude'),'blocked.txt\n');await fs.writeFile(path.join(f.repo,'blocked.txt'),'ignored');
    await assert.rejects(preview(f,'forkResetDev','collision'),/覆盖/);
    git(f.repo,'worktree','add','-b','occupied',path.join(f.base,'worktree'),'release');
    await assert.rejects(preview(f,'forkSmartGit','occupied'),/worktree/);
    assert.equal(await fs.readFile(path.join(f.repo,'blocked.txt'),'utf8'),'ignored');
});

test('service validates native tool request and maintains prepare-token-execute protection',async t=>{
    const f=await fixture(t),desk=new GitDesk(f.repo,f.cache,{checkEditor:async()=>{},beforeWorktreeChange:async()=>{},afterWorktreeChange:async()=>{}});
    const repo=(await desk.snapshot()).repositories[0];
    await assert.rejects(desk.prepare({repo:repo.id,version:repo.version,action:'forkResetDev'}),/目标分支/);
    const p=await desk.prepare({repo:repo.id,version:repo.version,action:'forkResetPreferred',branch:'release'});
    assert.equal(p.title,'强制同步项目（保留未跟踪文件）');assert.ok(p.repositories[0].includes('release'));assert.ok(p.warnings.some(w=>w.includes('覆盖')));
    assert.equal(git(f.repo,'status','--porcelain'),'');
});

test('native project reset operates initialized submodules without project helpers, including when launched from a child selection',async t=>{
    const f=await fixture(t),childRemote=path.join(f.base,'child.git');git(f.base,'clone','--bare',f.remote,childRemote);
    git(f.repo,'submodule','add','-b','release',childRemote,'lib');git(f.repo,'commit','-m','module');git(f.repo,'push','server','release');
    await fs.writeFile(path.join(f.repo,'file.txt'),'root dirty');await fs.writeFile(path.join(f.repo,'lib/file.txt'),'child dirty');await fs.writeFile(path.join(f.repo,'lib/remove.txt'),'remove');
    const desk=new GitDesk(f.repo,f.cache,{checkEditor:async()=>{},beforeWorktreeChange:async()=>{},afterWorktreeChange:async()=>{}});
    const child=(await desk.snapshot()).repositories.find(r=>r.id==='lib');
    const p=await desk.prepare({repo:'lib',version:child.version,action:'forkResetDev',branch:'release'});
    assert.equal(p.repositories.length,2);assert.ok(p.paths.includes('lib/remove.txt'));
    desk.execute(p.token);
    for(let i=0;i<1500&&desk.task().status==='running';i++)await new Promise(r=>setTimeout(r,100));
    assert.equal(desk.task().status,'success',desk.task().log);
    assert.equal(await fs.readFile(path.join(f.repo,'file.txt'),'utf8'),'base\n');assert.equal(await fs.readFile(path.join(f.repo,'lib/file.txt'),'utf8'),'base\n');
    await assert.rejects(fs.access(path.join(f.repo,'lib/remove.txt')),/ENOENT/);
    assert.ok(desk.task().repositories.every(row=>row.status==='success'));
});

test('tracked content changes during fetch are detected even when dirty status stays the same',async t=>{
    const f=await fixture(t);await fs.writeFile(path.join(f.repo,'file.txt'),'before');const p=await preview(f,'forkResetPreferred');
    const changing=async(cwd,args,allowed)=>{const result=await runner(cwd,args,allowed);if(args[0]==='fetch')await fs.writeFile(path.join(f.repo,'file.txt'),'after fetch');return result;};
    await assert.rejects(executeForkTool(p,f.cache,()=>{},changing,()=>{}),/文件内容已变化/);
    assert.equal(await fs.readFile(path.join(f.repo,'file.txt'),'utf8'),'after fetch');
});

test('reset rejects target files over a directory containing an independent nested repository',async t=>{
    const f=await fixture(t);git(f.seed,'switch','-c','collision');await fs.writeFile(path.join(f.seed,'bag'),'remote');git(f.seed,'add','bag');git(f.seed,'commit','-m','collision');git(f.seed,'push','server','collision');git(f.repo,'fetch','server');
    const nested=path.join(f.repo,'bag/nested');await fs.mkdir(nested,{recursive:true});git(nested,'init');
    await assert.rejects(preview(f,'forkResetDev','collision'),/覆盖/);await fs.access(path.join(nested,'.git'));
});
