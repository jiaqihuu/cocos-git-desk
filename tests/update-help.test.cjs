const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const {emptyDiffSide,sameDisplayedDiff,updateFailureHelp}=require('../dist/update-help');
const {SelectedFileObserver}=require('../dist/file-observer');

test('missing or zero-byte sides hide symmetrically, while notices/images/whitespace remain visible',()=>{
    for(const side of [{exists:false},{exists:true,text:''},{}])assert.equal(emptyDiffSide(side),true);
    for(const side of [{exists:true,text:'\n'},{notice:'LFS object missing'},{image:'data:image/png;base64,AA=='},{text:'content'}])assert.equal(emptyDiffSide(side),false);
    const left={before:{text:'old'},after:{exists:false},patch:'-old'};
    assert.equal(sameDisplayedDiff(left,{...left}),true);
    assert.equal(sameDisplayedDiff(left,{...left,after:{text:'new'}}),false);
    assert.equal(sameDisplayedDiff(left,{...left,partial:{version:'new',hunks:[]}}),false);
});
test('failure guidance routes divergence/stash/auth/network/unknown cases without inventing automatic repair',()=>{
    const help=detail=>updateFailureHelp({id:'.',status:'failed',phase:'未完成',detail});
    assert.equal(help('fatal: Not possible to fast-forward, aborting.').action,'sync');
    assert.equal(help('恢复临时 stash 后仍有未解决的冲突').action,'stash');
    assert.match(help('Permission denied (publickey)').title,/权限/);
    assert.match(help('Could not resolve host: server').title,/网络/);
    assert.match(help('fetch期间本地文件变化').title,/变化/);
    assert.equal(help('未配置上游').action,'branches');
    assert.match(help('LFS filter failed').title,/依赖/);
    assert.match(help('unexpected exit 143').steps,/原因不明/);
});
test('selected file observer catches save and atomic replacement, releases old directories and closes',async t=>{
    const dir=await fs.mkdtemp(path.resolve(__dirname,'../.cache/observe-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
    const file=path.join(dir,'selected.txt');await fs.writeFile(file,'old');let events=0;const observer=new SelectedFileObserver(()=>events++);t.after(()=>observer.close());observer.setFile(file);assert.equal(observer.active,true);
    const waitFor=async previous=>{for(let n=0;n<250&&events===previous;n++)await new Promise(r=>setTimeout(r,20));assert(events>previous);};
    await fs.writeFile(file,'new');await waitFor(0);const saved=events;
    const replacement=path.join(dir,'temp');await fs.writeFile(replacement,'replacement');await fs.rename(replacement,file);await waitFor(saved);
    observer.close();assert.equal(observer.active,false);await new Promise(r=>setTimeout(r,30));const closed=events;await fs.writeFile(file,'after close');await new Promise(r=>setTimeout(r,40));assert.equal(events,closed);
});
async function panelFixture() {
    const filename=path.resolve(__dirname,'../dist/panel.js');let next,hold;
    const context={exports:{},module:{exports:{}},require:createRequire(filename),__dirname:path.dirname(filename),Editor:{Message:{request:async()=>({ok:true,data:hold?await hold:next})}},setTimeout:()=>1,clearTimeout(){}};
    vm.runInNewContext(require('node:fs').readFileSync(filename,'utf8')+'\nmodule.exports.Controller=Controller;',context,{filename});
    const c=Object.create(context.module.exports.Controller.prototype);let renders=0,refreshes=0;const refreshArgs=[];
    const fields={modal:{hidden:true},'amend-modal':{hidden:true},'scope-review-modal':{hidden:true},'diff-view':{scrollTop:17,scrollLeft:8}};
    Object.assign(c,{closed:false,busy:false,planning:false,refreshing:false,diffLoading:false,blameActive:false,diffEpoch:1,currentFile:{repo:'.',path:'file.txt',area:'worktree'},currentDiff:{before:{text:'base'},after:{text:'first'},patch:'first'},selectedLines:new Set(['line1']),app:{ownerDocument:{hidden:false},getClientRects:()=>[{}]},el:id=>fields[id],renderDiff:()=>renders++,updateButtons(){},refresh:async(...args)=>{refreshArgs.push(args);refreshes++;}});
    return {c,fields,set:value=>next=value,hold:value=>hold=value,counts:()=>({renders,refreshes}),refreshCalls:()=>refreshArgs};
}
test('disk refresh updates same-status contents, invalidates stale line selections, and preserves scroll',async()=>{
    const {c,fields,set,counts}=await panelFixture();const changed={before:{text:'base'},after:{text:'second'},patch:'second'};set(changed);await c.refreshFromDisk();
    assert.equal(c.currentDiff.after.text,'second');assert.equal(c.selectedLines.size,0);assert.equal(fields['diff-view'].scrollTop,17);assert.deepEqual(counts(),{renders:1,refreshes:1});
    c.selectedLines.add('fresh');await c.refreshFromDisk();assert.equal(c.selectedLines.size,1);assert.deepEqual(counts(),{renders:1,refreshes:2});
});
test('disk refresh defers while modal/busy and discards a response if user starts a confirmation or changes file',async()=>{
    const f=await panelFixture();f.fields.modal.hidden=false;await f.c.refreshFromDisk();assert.equal(f.counts().refreshes,0);f.fields.modal.hidden=true;
    let release;f.hold(new Promise(resolve=>release=resolve));const pending=f.c.refreshFromDisk();f.fields.modal.hidden=false;release({before:{text:'base'},after:{text:'late'},patch:'late'});await pending;
    assert.equal(f.c.currentDiff.after.text,'first');assert.equal(f.c.diskRefreshPending,true);assert.equal(f.c.selectedLines.size,1);
});
test('failure assistance rereads repository state and only navigates; a running task prevents navigation',async()=>{
    const f=await panelFixture();let selected=0,mode='';f.c.repoId='.';f.c.selectRepo=async()=>selected++;f.c.setMode=async value=>mode=value;
    f.set({repositories:[{id:'.',initialized:true}],task:{status:'running'}});
    await assert.rejects(f.c.inspectUpdateFailure({id:'.'},'stash'));assert.equal(selected,0);
    f.set({repositories:[{id:'.',initialized:true}],task:null});await f.c.inspectUpdateFailure({id:'.'},'stash');assert.equal(selected,1);assert.equal(mode,'stash');
    f.set({repositories:[],task:null});await assert.rejects(f.c.inspectUpdateFailure({id:'missing'},'working'));assert.equal(selected,1);
});
test('project-level failures without a failed repository row still receive guidance',async()=>{
    const f=await panelFixture(),nodes=[];let helped;
    const container={ownerDocument:{createElement:()=>({dataset:{},remove(){this.removed=true;}})},append:node=>nodes.push(node),prepend:node=>nodes.unshift(node)};
    f.c.el=()=>container;f.c.renderUpdateFailure=(node,row)=>helped=row;
    const task={id:'stopped',status:'failed',log:'python process exited early'};
    f.c.renderGeneralUpdateFailure(task,[{id:'.',status:'queued'}]);assert.equal(nodes.length,1);assert.match(helped.phase,/项目级/);
    f.c.renderGeneralUpdateFailure(task,[{id:'.',status:'queued'}]);assert.equal(nodes.length,1);
    f.c.renderGeneralUpdateFailure(task,[{id:'.',status:'failed'}]);assert.equal(nodes[0].removed,true);
});


test('failure guidance distinguishes local write problems from remote permissions and covers SSH/network failures',()=>{
 const help=detail=>updateFailureHelp({id:'.',status:'failed',phase:'获取与检查',detail});
 for(const text of ['ssh: Could not resolve hostname git.example: nodename nor servname provided','Connection reset by peer','Connection closed by remote host','Network is unreachable','The remote end hung up unexpectedly','SSL certificate problem: certificate has expired']){
  assert.equal(help(text).action,'remotes',text);assert.match(help(text).title,/网络/);
 }
 for(const text of ['Unable to create .git/index.lock: File exists','cannot lock ref refs/remotes/origin/dev','fatal: could not open .git/FETCH_HEAD: Permission denied','fatal: cannot create directory at file: Permission denied','error: insufficient permission for adding an object to repository database','fatal: No space left on device']){
  assert.equal(help(text).action,'working',text);assert.doesNotMatch(help(text).title,/远端访问/);
 }
 for(const text of ['Permission denied (publickey)','Authentication failed','Repository not found','Saved working directory in stash. Authentication failed'])assert.equal(help(text).action,'remotes',text);
 for(const text of ['恢复临时 stash 后仍有未解决的冲突','git stash pop failed with conflicts','保留 Stash 等待人工处理'])assert.equal(help(text).action,'stash',text);
 assert.match(help('Unable to create .git/index.lock').steps,/不自动删除锁文件/);
 assert.match(help('SSL certificate problem').steps,/关闭证书校验/);
});

test('remote failure assistance opens current repository remote settings through local reads only',async()=>{
 const f=await panelFixture();let mode,loaded=0;f.c.repoId='.';f.c.selectRepo=async()=>{};f.c.setMode=async value=>mode=value;f.c.clearReflog=()=>{};f.c.loadRemotes=async()=>loaded++;
 f.fields['remote-workspace']={hidden:true};f.fields['reflog-workspace']={hidden:false};f.set({repositories:[{id:'.',initialized:true}],task:null});
 await f.c.inspectUpdateFailure({id:'.'},'remotes');assert.equal(mode,'working');assert.equal(loaded,1);assert.equal(f.fields['remote-workspace'].hidden,false);assert.equal(f.fields['reflog-workspace'].hidden,true);
});

test('failure navigation stops if a human review opens during repository selection',async()=>{
 const f=await panelFixture();let mode=0;f.c.repoId='.';f.c.selectRepo=async()=>{f.fields['scope-review-modal'].hidden=false;};f.c.setMode=async()=>mode++;f.set({repositories:[{id:'.',initialized:true}],task:null});
 await f.c.inspectUpdateFailure({id:'.'},'stash');assert.equal(mode,0);
});

test('remote failure navigation drops late response after repository selection changes',async()=>{
 const f=await panelFixture();let loaded=0;f.c.repoId='.';f.c.selectRepo=async()=>{};f.c.setMode=async()=>{f.c.repoId='other';};f.c.loadRemotes=async()=>loaded++;f.set({repositories:[{id:'.',initialized:true}],task:null});
 await f.c.inspectUpdateFailure({id:'.'},'remotes');assert.equal(loaded,0);
});


test('saved-file events use a scoped refresh while focus promotion retains a full refresh',async()=>{
 const f=await panelFixture();f.c.repoId='.';f.c.diskRefreshAll=false;f.set(f.c.currentDiff);
 f.c.queueDiskRefresh(false);await f.c.refreshFromDisk();assert.deepEqual(f.refreshCalls()[0],[false,true,'.']);
 f.c.queueDiskRefresh(false);f.c.queueDiskRefresh();f.c.queueDiskRefresh(false);await f.c.refreshFromDisk();assert.deepEqual(f.refreshCalls()[1],[false,true,undefined]);
 await f.c.refreshFromDisk(true);assert.deepEqual(f.refreshCalls()[2],[false,true,undefined]);
});

test('stale preview guidance provides an explicit repreview action without automatic writes', () => {
    const h = updateFailureHelp({id:'.',status:'failed',phase:'更新前中止',detail:'仓库 .：预览后本地状态变化（暂存区条目）'});
    assert.equal(h.action, 'repreview'); assert.match(h.steps, /只生成新预览/); assert.match(h.steps, /其他 Git 操作/);
});
test('repreview assistance reads fresh state and forces confirmation instead of executing', async () => {
    const f = await panelFixture(); let prepared, selected = 0;
    f.c.repoId = '.'; f.c.details = {repo:{id:'.',version:'old'}};
    f.c.selectRepo = async () => { selected++; f.c.details = {repo:{id:'.',version:'fresh'}}; };
    f.c.prepareWorktreeOperation = async (...args) => prepared = args;
    f.set({repositories:[{id:'.',initialized:true}],task:null});
    await f.c.inspectUpdateFailure({id:'.'}, 'repreview');
    assert.equal(selected, 1); assert.equal(prepared[0].version, 'fresh'); assert.equal(prepared[0].action, 'updateAll'); assert.equal(prepared[2], true);
});
test('recovery preview always shows confirmation even when repeat updates were previously approved', async () => {
    const f = await panelFixture(), fields = new Map(); let executes = 0;
    f.c.el = id => { if (!fields.has(id)) fields.set(id,{hidden:true}); return fields.get(id); };
    Object.assign(f.c, {repoId:'.',epoch:1,dialogEpoch:1,details:{repo:{version:'fresh'}},
        cancelDialog(){this.dialogEpoch++;}, requestPlan:async()=>({token:'new',title:'快进更新全部仓库',description:'scope',paths:[],warnings:[],generalWarnings:[],repeatConfirmationKey:'known',expiresAt:Date.now()+60000}),
        warningPreferences:{confirmedUpdate:()=>true,read:()=>[]}, executePlan:async()=>executes++, renderPlanWarnings(){},error(e){throw e;}});
    await f.c.prepareWorktreeOperation({repo:'.',version:'fresh',action:'updateAll'}, undefined, true);
    assert.equal(executes,0); assert.equal(f.c.el('modal').hidden,false); assert.equal(f.c.plan.token,'new');
});
