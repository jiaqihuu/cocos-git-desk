const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GitDesk } = require('../dist/git');
const { FileStateChangedError } = require('../dist/types');
const { RecoveryStore } = require('../dist/recovery');

const work = path.resolve(__dirname, '../.test-work');
process.env.GIT_ALLOW_PROTOCOL = 'file';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(work, 'recovery-no-global-config');
const git = (cwd, ...args) => execFileSync('git', [...(args[0] === 'stash' && args[1] === 'push' ? [] : ['--literal-pathspecs']), ...args], {
    cwd, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
}).trimEnd();

async function fixture(t, seed = true) {
    await fs.mkdir(work, { recursive: true });
    const base = await fs.mkdtemp(path.join(work, 'recovery-'));
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


// Source-only scenarios; do not execute until explicitly authorized.
const indexEntries = repo => execFileSync('git', ['ls-files','--stage','-z'], {cwd:repo});
const contents = (repo,name='file.txt') => fs.readFile(path.join(repo,name),'utf8');

test('discard restores index content and preserves staged content, other files without a local backup', async t => {
    const {repo,desk,calls}=await fixture(t);
    await fs.writeFile(path.join(repo,'file.txt'),'staged\n');git(repo,'add','file.txt');
    await fs.writeFile(path.join(repo,'file.txt'),'unstaged\r\n');
    await fs.writeFile(path.join(repo,'unrelated.txt'),'keep');
    const index=indexEntries(repo);
    const task=await perform(desk,'discardFiles',{paths:['file.txt']});
    assert.equal(await contents(repo),'staged\n');assert.deepEqual(indexEntries(repo),index);
    assert.equal(await contents(repo,'unrelated.txt'),'keep');assert.doesNotMatch(task.log,/备份 ID/);
    await assert.rejects(fs.stat(path.join(desk.cache,'recovery')),e=>e.code==='ENOENT');
    assert.equal(calls.before,1);assert.equal(calls.after,1);
});

test('discarding an unstaged deletion restores the indexed file without staging', async t => {
    const {repo,desk}=await fixture(t);await fs.unlink(path.join(repo,'file.txt'));
    await perform(desk,'discardFiles',{paths:['file.txt']});assert.equal(await contents(repo),'first\n');
    assert.equal(git(repo,'diff','--cached','--name-only'),'');
});

test('historical file restoration pins a full commit and keeps index entries unchanged', async t => {
    const {repo,desk}=await fixture(t),revision=git(repo,'rev-parse','HEAD');
    await fs.writeFile(path.join(repo,'file.txt'),'second\n');git(repo,'add','.');git(repo,'commit','-m','second');
    await fs.writeFile(path.join(repo,'file.txt'),'local\n');const index=indexEntries(repo);
    const preview=await plan(desk,'restoreFiles',{paths:['file.txt'],revision});assert.match(preview.description,new RegExp(revision));
    assert.equal((await finish(desk,preview)).status,'success');assert.equal(await contents(repo),'first\n');assert.deepEqual(indexEntries(repo),index);
});

test('related modified resource and meta paths are explicit in discard preview', async t => {
    const {repo,desk}=await fixture(t);await fs.writeFile(path.join(repo,'file.txt.meta'),'original-meta');git(repo,'add','.');git(repo,'commit','-m','meta');
    await fs.writeFile(path.join(repo,'file.txt'),'changed');await fs.writeFile(path.join(repo,'file.txt.meta'),'changed-meta');
    const preview=await plan(desk,'discardFiles',{paths:['file.txt']});assert.deepEqual(preview.paths,['file.txt','file.txt.meta']);
});

test('historical restoration includes source resource meta even if currently clean', async t => {
    const {repo,desk}=await fixture(t);await fs.writeFile(path.join(repo,'file.txt.meta'),'meta');git(repo,'add','.');git(repo,'commit','-m','meta');
    const preview=await plan(desk,'restoreFiles',{paths:['file.txt'],revision:git(repo,'rev-parse','HEAD')});assert.deepEqual(preview.paths,['file.txt','file.txt.meta']);
});

test('untracked, attributes, moving revisions and extra form scope are refused', async t => {
    const {repo,desk}=await fixture(t);await fs.writeFile(path.join(repo,'file.txt'),'local');await fs.writeFile(path.join(repo,'new.txt'),'private');
    await assert.rejects(plan(desk,'discardFiles',{paths:['new.txt']}));
    await assert.rejects(plan(desk,'restoreFiles',{paths:['file.txt'],revision:'HEAD'}));
    await assert.rejects(plan(desk,'discardFiles',{paths:['file.txt'],message:'incidental draft'}));
    await assert.rejects(plan(desk,'discardFiles',{paths:['.gitattributes']}));
});

test('custom filters and encoding transformations are refused before any backup or worktree operation', async t => {
    const {repo,desk,calls}=await fixture(t);await fs.writeFile(path.join(repo,'.gitattributes'),'file.txt filter=custom\n');await fs.writeFile(path.join(repo,'file.txt'),'local');
    await assert.rejects(plan(desk,'discardFiles',{paths:['file.txt']}),/过滤器/);assert.equal(calls.before,0);
});

test('symlink and hardlink work files are refused', async t => {
    if(process.platform==='win32')return t.skip('POSIX link fixture');
    const {repo,desk}=await fixture(t);await fs.unlink(path.join(repo,'file.txt'));await fs.symlink('outside',path.join(repo,'file.txt'));
    await assert.rejects(plan(desk,'discardFiles',{paths:['file.txt']}));
    await fs.unlink(path.join(repo,'file.txt'));await fs.writeFile(path.join(repo,'original'),'hard');await fs.link(path.join(repo,'original'),path.join(repo,'file.txt'));
    await assert.rejects(plan(desk,'discardFiles',{paths:['file.txt']}),/硬链接/);
});

test('edits after preview stop execution and do not create a backup', async t => {
    const {repo,desk}=await fixture(t);await fs.writeFile(path.join(repo,'file.txt'),'before');
    const preview=await plan(desk,'discardFiles',{paths:['file.txt']});await fs.writeFile(path.join(repo,'file.txt'),'after');
    assert.equal((await finish(desk,preview)).status,'failed');assert.equal(await contents(repo),'after');
});

test('unsaved editor and preparation-time changes stop overwriting', async t => {
    const {repo,desk,calls}=await fixture(t);await fs.writeFile(path.join(repo,'file.txt'),'local');calls.dirtyEditor=true;
    await assert.rejects(plan(desk,'discardFiles',{paths:['file.txt']}),/unsaved/);calls.dirtyEditor=false;
    const preview=await plan(desk,'discardFiles',{paths:['file.txt']});calls.duringBefore=()=>fs.writeFile(path.join(repo,'file.txt'),'late');
    assert.equal((await finish(desk,preview)).status,'failed');assert.equal(await contents(repo),'late');assert.equal(calls.after,1);
});

test('post-checkout hook failure reports partial failure without automatic recovery', async t => {
    if(process.platform==='win32')return t.skip('POSIX hook fixture');
    const {base,repo,desk}=await fixture(t);const hooks=path.join(base,'hooks');await fs.mkdir(hooks);await fs.writeFile(path.join(hooks,'post-checkout'),'#!/bin/sh\nexit 1\n',{mode:0o755});git(repo,'config','core.hooksPath',hooks);
    await fs.writeFile(path.join(repo,'file.txt'),'original disk');const task=await finish(desk,await plan(desk,'discardFiles',{paths:['file.txt']}));
    assert.equal(task.status,'failed');assert.equal(await contents(repo),'first\n');
});

test('per-file and path-count bounds fail before mutation', async t => {
    const {repo,desk}=await fixture(t);await fs.writeFile(path.join(repo,'file.txt'),Buffer.alloc(10*1024*1024+1));
    await assert.rejects(plan(desk,'discardFiles',{paths:['file.txt']}),/10 MiB/);
    await assert.rejects(plan(desk,'discardFiles',{paths:Array.from({length:51},(_,i)=>'f'+i)}),/1–50/);
});


test('literal Unicode, newline and pathspec-looking names stay in the explicit recovery scope', async t => {
    if(process.platform==='win32')return t.skip('POSIX filename fixture');
    const {repo,desk}=await fixture(t),names=['中文 空格.txt','line\nbreak.txt',':(glob)x','-dash.txt'];
    for(const name of names)await fs.writeFile(path.join(repo,name),'original');
    git(repo,'add','.');git(repo,'commit','-m','literal names');
    for(const name of names)await fs.writeFile(path.join(repo,name),'changed');
    const preview=await plan(desk,'discardFiles',{paths:names});assert.deepEqual(preview.paths,[...names].sort());
    const task=await finish(desk,preview);assert.equal(task.status,'success',task.log);
    for(const name of names)assert.equal(await contents(repo,name),'original');
});

test('missing parent files can be snapshotted as absent without creating directories',async t=>{
    const {base,repo}=await fixture(t),store=new RecoveryStore();assert.equal((await store.readDisk(repo,'missing/file.txt')).stamp.exists,false);
    await assert.rejects(fs.stat(path.join(repo,'missing')),e=>e.code==='ENOENT');await assert.rejects(store.filename(repo,'missing/file.txt'));
});


test('disk snapshots enforce caller limits while preserving the default recovery allowance', async t => {
    const { base, repo } = await fixture(t), store = new RecoveryStore();
    await assert.rejects(store.readDisk(repo, 'file.txt', 5), /单文件最多/);
    assert.equal((await store.readDisk(repo, 'file.txt', 6)).bytes.toString(), 'first\n');
    assert.equal((await store.readDisk(repo, 'file.txt')).bytes.toString(), 'first\n');
    for (const limit of [0, -1, NaN, 10 * 1024 * 1024 + 1]) await assert.rejects(store.readDisk(repo, 'file.txt', limit), /无效/);
});


async function stashSource(f) {
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'stash index\n'); git(f.repo, 'add', 'file.txt');
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'stash work\n');
    await fs.writeFile(path.join(f.repo, 'new.txt'), 'stash untracked\n');
    git(f.repo, 'stash', 'push', '-u', '-m', 'source');
    return { stashRef: 'stash@{0}', revision: git(f.repo, 'rev-parse', 'refs/stash') };
}

test('stash working snapshot recovery preserves current staging and stash', async t => {
    const f = await fixture(t), source = await stashSource(f);
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'current staged\n'); git(f.repo, 'add', 'file.txt');
    await fs.writeFile(path.join(f.repo, 'file.txt'), 'current disk\n'); await fs.writeFile(path.join(f.repo, 'other.txt'), 'keep');
    const index = indexEntries(f.repo), stashes = git(f.repo, 'stash', 'list', '--format=%H');
    const preview = await plan(f.desk, 'restoreStashFiles', { ...source, stashPart: 'tracked', paths: ['file.txt'] });
    assert.match(preview.description, new RegExp(source.revision)); assert.ok(preview.warnings.some(text => /保留整个 Stash/.test(text)));
    const task = await finish(f.desk, preview); assert.equal(task.status, 'success', task.log);
    assert.equal(await contents(f.repo), 'stash work\n'); assert.deepEqual(indexEntries(f.repo), index);
    assert.equal(git(f.repo, 'stash', 'list', '--format=%H'), stashes); assert.equal(await contents(f.repo, 'other.txt'), 'keep');
});

test('stash index snapshot recovery copies to worktree without restoring original staging', async t => {
    const f = await fixture(t), source = await stashSource(f), index = indexEntries(f.repo);
    await perform(f.desk, 'restoreStashFiles', { ...source, stashPart: 'index', paths: ['file.txt'] });
    assert.equal(await contents(f.repo), 'stash index\n'); assert.deepEqual(indexEntries(f.repo), index);
    assert.equal(git(f.repo, 'rev-parse', 'refs/stash'), source.revision);
});

test('stash untracked snapshot recovery creates only the selected absent file without a backup', async t => {
    const f = await fixture(t), source = await stashSource(f), index = indexEntries(f.repo);
    await perform(f.desk, 'restoreStashFiles', { ...source, stashPart: 'untracked', paths: ['new.txt'] });
    assert.equal(await contents(f.repo, 'new.txt'), 'stash untracked\n'); assert.deepEqual(indexEntries(f.repo), index);
    assert.equal(git(f.repo, 'rev-parse', 'refs/stash'), source.revision);
});

test('stash file recovery rejects mismatched identity, expressions, parts and unrelated form flags', async t => {
    const f = await fixture(t), source = await stashSource(f), valid = { ...source, stashPart: 'tracked', paths: ['file.txt'] };
    for (const extra of [{ revision: 'HEAD' }, { revision: git(f.repo, 'rev-parse', 'HEAD') }, { stashRef: 'stash@{1}' }, { stashRef: 'stash@{00}' }, { stashPart: 'all' }, { stashPart: undefined }, { restoreIndex: true }, { includeUntracked: true }, { paths: [] }]) await assert.rejects(plan(f.desk, 'restoreStashFiles', { ...valid, ...extra }));
     assert.equal(await contents(f.repo), 'first\n');
});

test('stash file recovery refuses missing parts or deleted source paths without deleting disk files', async t => {
    const f = await fixture(t); await fs.unlink(path.join(f.repo, 'file.txt')); git(f.repo, 'stash', 'push', '-m', 'delete');
    const source = { stashRef: 'stash@{0}', revision: git(f.repo, 'rev-parse', 'refs/stash') };
    await assert.rejects(plan(f.desk, 'restoreStashFiles', { ...source, stashPart: 'tracked', paths: ['file.txt'] }), /来源没有/);
    await assert.rejects(plan(f.desk, 'restoreStashFiles', { ...source, stashPart: 'untracked', paths: ['new.txt'] }), /没有未跟踪/);
    assert.equal(await contents(f.repo), 'first\n');
});

test('stash recovery never overwrites untracked or ignored name collisions', async t => {
    const f = await fixture(t), source = await stashSource(f);
    await fs.writeFile(path.join(f.repo, 'new.txt'), 'local unrelated\n');
    const request = { ...source, stashPart: 'untracked', paths: ['new.txt'] };
    await assert.rejects(plan(f.desk, 'restoreStashFiles', request), /不能覆盖/);
    await fs.writeFile(path.join(f.repo, '.git/info/exclude'), 'new.txt\n');
    await assert.rejects(plan(f.desk, 'restoreStashFiles', request), /不能覆盖/);
    assert.equal(await contents(f.repo, 'new.txt'), 'local unrelated\n');
});

test('stash recovery rejects absent parents instead of creating a directory tree', async t => {
    const f = await fixture(t); await fs.mkdir(path.join(f.repo, 'nested')); await fs.writeFile(path.join(f.repo, 'nested/new.txt'), 'new');
    git(f.repo, 'stash', 'push', '-u', '-m', 'nested'); const revision = git(f.repo, 'rev-parse', 'refs/stash');
    await assert.rejects(plan(f.desk, 'restoreStashFiles', { stashRef: 'stash@{0}', revision, stashPart: 'untracked', paths: ['nested/new.txt'] }));
    await assert.rejects(fs.stat(path.join(f.repo, 'nested')), {code:'ENOENT'});
});

test('stash recovery expands asset and meta companions from the same fixed snapshot', async t => {
    const f = await fixture(t); await fs.mkdir(path.join(f.repo, 'assets'));
    await fs.writeFile(path.join(f.repo, 'assets/a.txt'), 'base'); await fs.writeFile(path.join(f.repo, 'assets/a.txt.meta'), 'base meta'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-m', 'asset');
    await fs.writeFile(path.join(f.repo, 'assets/a.txt'), 'stash asset'); await fs.writeFile(path.join(f.repo, 'assets/a.txt.meta'), 'stash meta');
    git(f.repo, 'stash', 'push', '-m', 'asset'); const revision = git(f.repo, 'rev-parse', 'refs/stash');
    const preview = await plan(f.desk, 'restoreStashFiles', { stashRef:'stash@{0}',revision,stashPart:'tracked',paths:['assets/a.txt'] });
    assert.deepEqual(preview.paths, ['assets/a.txt','assets/a.txt.meta']); const task = await finish(f.desk, preview); assert.equal(task.status,'success',task.log);
    assert.equal(await contents(f.repo,'assets/a.txt'),'stash asset'); assert.equal(await contents(f.repo,'assets/a.txt.meta'),'stash meta');
});

test('stash list reorder invalidates a preview even without worktree changes', async t => {
    const f = await fixture(t), source = await stashSource(f);
    await fs.writeFile(path.join(f.repo,'file.txt'),'second stash'); git(f.repo,'stash','push','-m','second');
    const preview = await plan(f.desk,'restoreStashFiles',{...source,stashRef:'stash@{1}',stashPart:'tracked',paths:['file.txt']});
    const before = await contents(f.repo); git(f.repo,'stash','drop','stash@{0}');
    const task = await finish(f.desk,preview); assert.equal(task.status,'failed'); assert.match(task.log,/Stash|变化/);
    assert.equal(await contents(f.repo),before);
});

test('unsaved editor and a stash dropped during editor preparation stop recovery', async t => {
    const f = await fixture(t), source = await stashSource(f), request = {...source,stashPart:'tracked',paths:['file.txt']};
    f.calls.dirtyEditor = true; await assert.rejects(plan(f.desk,'restoreStashFiles',request),/unsaved/); f.calls.dirtyEditor = false;
    const preview = await plan(f.desk,'restoreStashFiles',request); f.calls.duringBefore=async()=>{git(f.repo,'stash','drop','stash@{0}');};
    const task = await finish(f.desk,preview); assert.equal(task.status,'failed'); assert.equal(await contents(f.repo),'first\n');

});

test('stash recovery refuses filters and source symlinks instead of silently transforming content', async t => {
    const f = await fixture(t), source = await stashSource(f);
    await fs.writeFile(path.join(f.repo,'.gitattributes'),'file.txt filter=blocked\n');
    await assert.rejects(plan(f.desk,'restoreStashFiles',{...source,stashPart:'tracked',paths:['file.txt']}),/过滤器/);
    await fs.unlink(path.join(f.repo,'.gitattributes'));
    if(process.platform!=='win32'){
        await fs.symlink('file.txt',path.join(f.repo,'link.txt'));git(f.repo,'add','link.txt');git(f.repo,'stash','push','-m','link');
        const revision=git(f.repo,'rev-parse','refs/stash');
        await assert.rejects(plan(f.desk,'restoreStashFiles',{stashRef:'stash@{0}',revision,stashPart:'tracked',paths:['link.txt']}),/非普通文件/);
    }
});

test('non-stash topology stored in the stash reflog is refused', async t => {
    const f = await fixture(t), revision = git(f.repo,'rev-parse','HEAD');
    git(f.repo,'update-ref','--create-reflog','-m','bogus','refs/stash',revision);
    await assert.rejects(plan(f.desk,'restoreStashFiles',{stashRef:'stash@{0}',revision,stashPart:'tracked',paths:['file.txt']}),/Stash 快照/);
});


async function lineFixture(t) {
    const f=await fixture(t),base=Array.from({length:24},(_,i)=>'base-'+i);
    await fs.writeFile(path.join(f.repo,'file.txt'),base.join('\n')+'\n');git(f.repo,'add','file.txt');git(f.repo,'commit','-m','lines');
    const staged=[...base];staged[0]='staged-0';await fs.writeFile(path.join(f.repo,'file.txt'),staged.join('\n')+'\n');git(f.repo,'add','file.txt');
    const working=[...staged];working[4]='work-4';working[18]='work-18';await fs.writeFile(path.join(f.repo,'file.txt'),working.join('\n')+'\n');
    return {...f,staged:staged.join('\n')+'\n',working:working.join('\n')+'\n'};
}
async function lineChoice(f,values) {
    const diff=await f.desk.diff({repo:'.',path:'file.txt',area:'worktree'});assert.ok(diff.partial,diff.partialReason);
    const lines=diff.partial.hunks.flatMap(h=>h.lines.filter(line=>line.id));
    return {path:'file.txt',version:diff.partial.version,ids:lines.filter(line=>!values || values.includes(line.text)).map(line=>line.id)};
}

test('selected unstaged line discard preserves staging and other hunks',async t=>{
    const f=await lineFixture(t),lines=await lineChoice(f,['base-4','work-4']),index=await fs.readFile(path.join(f.repo,'.git/index')),head=git(f.repo,'rev-parse','HEAD');
    const preview=await plan(f.desk,'discardLines',{lines});assert.deepEqual(preview.paths,['file.txt']);assert.match(preview.patch,/-work-4/);assert.match(preview.patch,/\+base-4/);assert.doesNotMatch(preview.patch,/work-18/);
    const task=await finish(f.desk,preview);assert.equal(task.status,'success',task.log);
    assert.equal(await contents(f.repo),f.working.replace('work-4\n','base-4\n'));assert.deepEqual(await fs.readFile(path.join(f.repo,'.git/index')),index);assert.equal(git(f.repo,'rev-parse','HEAD'),head);
});

test('discarding only added or only deleted lines has explicit independent replacement semantics',async t=>{
    for(const value of ['work-4','base-4']){
        const f=await lineFixture(t),lines=await lineChoice(f,[value]);await perform(f.desk,'discardLines',{lines});
        const expected=value==='work-4'?f.working.replace('work-4\n',''):f.working.replace('work-4\n','base-4\nwork-4\n');assert.equal(await contents(f.repo),expected);
    }
});

test('paired selected lines preserve the missing final newline',async t=>{
    const f=await fixture(t);await fs.writeFile(path.join(f.repo,'file.txt'),'same\nold');git(f.repo,'add','file.txt');git(f.repo,'commit','-m','no newline');await fs.writeFile(path.join(f.repo,'file.txt'),'same\nnew');
    const lines=await lineChoice(f);await perform(f.desk,'discardLines',{lines});assert.equal(await contents(f.repo),'same\nold');
});

test('all selected hunks restore index text while preserving executable mode',async t=>{
    const f=await lineFixture(t);
    if(process.platform!=='win32'){await fs.chmod(path.join(f.repo,'file.txt'),0o755);const oid=git(f.repo,'rev-parse',':file.txt');git(f.repo,'update-index','--cacheinfo','100755,'+oid+',file.txt');}
    const lines=await lineChoice(f),index=indexEntries(f.repo);await perform(f.desk,'discardLines',{lines});assert.equal(await contents(f.repo),f.staged);assert.deepEqual(indexEntries(f.repo),index);
    if(process.platform!=='win32')assert.equal((await fs.stat(path.join(f.repo,'file.txt'))).mode&0o777,0o755);
});

test('editing after selection or preview invalidates discard without creating a backup',async t=>{
    const f=await lineFixture(t),lines=await lineChoice(f,['base-4','work-4']),preview=await plan(f.desk,'discardLines',{lines});
    await fs.appendFile(path.join(f.repo,'file.txt'),'later edit\n');await assert.rejects(plan(f.desk,'discardLines',{lines}),/变化/);
    const task=await finish(f.desk,preview);assert.equal(task.status,'failed');assert.match(await contents(f.repo),/later edit/);
});

test('line discard rejects duplicate, stale, empty IDs and incidental form fields',async t=>{
    const f=await lineFixture(t),lines=await lineChoice(f,['base-4','work-4']);
    for(const invalid of [{...lines,ids:[]},{...lines,ids:['not-a-line']},{...lines,ids:[lines.ids[0],lines.ids[0]]},{...lines,version:'0'.repeat(64)},{...lines,extra:true}])await assert.rejects(plan(f.desk,'discardLines',{lines:invalid}));
    for(const extra of [{paths:['file.txt']},{restoreIndex:true},{revision:git(f.repo,'rev-parse','HEAD')}])await assert.rejects(plan(f.desk,'discardLines',{lines,...extra}),/只接受/);

});

test('line discard refuses CRLF, binary, invalid UTF8, filters and nonstandard POSIX permissions',async t=>{
    const f=await lineFixture(t),lines=await lineChoice(f);
    for(const bytes of [Buffer.from(f.working.replaceAll('\n','\r\n')),Buffer.from([0,1]),Buffer.from([0xff,0xfe])]){
        await fs.writeFile(path.join(f.repo,'file.txt'),bytes);await assert.rejects(plan(f.desk,'discardLines',{lines}),/UTF-8 LF/);
    }
    await fs.writeFile(path.join(f.repo,'file.txt'),f.working);await fs.writeFile(path.join(f.repo,'.gitattributes'),'file.txt filter=blocked\n');
    await assert.rejects(plan(f.desk,'discardLines',{lines}),/过滤器/);await fs.unlink(path.join(f.repo,'.gitattributes'));
    if(process.platform!=='win32'){await fs.chmod(path.join(f.repo,'file.txt'),0o640);await assert.rejects(plan(f.desk,'discardLines',{lines}),/644/);}
});

test('line discard refuses hidden index flags and forced CRLF attributes',async t=>{
    const f=await lineFixture(t),lines=await lineChoice(f);git(f.repo,'update-index','--assume-unchanged','file.txt');
    await assert.rejects(plan(f.desk,'discardLines',{lines}),/特殊索引/);git(f.repo,'update-index','--no-assume-unchanged','file.txt');
    await fs.writeFile(path.join(f.repo,'.gitattributes'),'file.txt eol=crlf\n');await assert.rejects(plan(f.desk,'discardLines',{lines}),/eol 属性/);
});

test('unexpected output after apply fails the task without creating a backup',async t=>{
    const f=await lineFixture(t),lines=await lineChoice(f),preview=await plan(f.desk,'discardLines',{lines}),run=f.desk.git.bind(f.desk);
    f.desk.git=async(repo,args,options)=>{const result=await run(repo,args,options);if(args.includes('apply')&&!args.includes('--check'))await fs.appendFile(path.join(repo,'file.txt'),'unexpected writer\n');return result;};
    const task=await finish(f.desk,preview);assert.equal(task.status,'failed');assert.match(task.log,/不等于预期/);
});

test('oversized selected patch is rejected before backup or mutation',async t=>{
    const f=await fixture(t);await fs.writeFile(path.join(f.repo,'file.txt'),'a'.repeat(70000)+'\n');git(f.repo,'add','file.txt');git(f.repo,'commit','-m','long line');await fs.writeFile(path.join(f.repo,'file.txt'),'b'.repeat(70000)+'\n');
    const lines=await lineChoice(f);await assert.rejects(plan(f.desk,'discardLines',{lines}),/128 KiB/);
});

test('discard leaves existing legacy backup files untouched and creates no new records', async t => {
    const f=await fixture(t),directory=path.join(f.desk.cache,'recovery','legacy');
    await fs.mkdir(directory,{recursive:true});
    const previous=path.join(directory,'record.json');await fs.writeFile(previous,'legacy user data');
    await fs.writeFile(path.join(f.repo,'file.txt'),'unstaged edit');
    await perform(f.desk,'discardFiles',{paths:['file.txt']});
    assert.equal(await fs.readFile(previous,'utf8'),'legacy user data');
    assert.deepEqual(await fs.readdir(path.join(f.desk.cache,'recovery')),['legacy']);
    assert.equal(f.desk.supportedActions().includes('restoreBackup'),false);
});
