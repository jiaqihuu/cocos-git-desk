const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const {tooltipTitle,setTooltipTitle,TOOLTIP_DELAY_MS}=require('../dist/panel-tooltips');
function fixtureFrom(name){const file=path.join(__dirname,name),context={exports:{},require:name=>name==='node:test'?()=>{}:createRequire(file)(name),__dirname};vm.runInNewContext(fs.readFileSync(file,'utf8')+'\nexports.fixture=fixture;',context);return context.exports.fixture();}
test('diff views and no-op selection/filter buttons are hidden only without applicable content',()=>{
 const {c,get}=fixtureFrom('control-updates.test.cjs');c.updateButtons();assert.equal(get('patch-tab').hidden,true);assert.equal(get('sides-tab').hidden,true);assert.equal(get('working-filter-clear').hidden,true);assert.equal(get('lines-clear').hidden,true);
 c.currentFile={area:'worktree'};c.currentDiff={before:{text:'a'},after:{text:'b'},partial:{hunks:[]}};c.selectedLines.add('line');c.workingFilter.text='a';c.updateButtons();assert.equal(get('patch-tab').hidden,false);assert.equal(get('sides-tab').hidden,false);assert.equal(get('lines-clear').hidden,false);assert.equal(get('working-filter-clear').hidden,false);
 c.busy=true;c.updateButtons();assert.equal(get('patch-tab').hidden,false);assert.equal(get('line-action').disabled,true);c.busy=false;c.currentFile={area:'tree'};c.updateButtons();assert.equal(get('patch-tab').hidden,true);
});
test('history displays seconds and timezone and invalidates same-day time edits',()=>{
 const {c}=fixtureFrom('detail-refresh.test.cjs');c.commits[0].date='2026-10-25T10:02:03+08:00';c.renderHistory();const row=c.el('commit-list').children[0];assert.match(row.children[1].children[1].textContent,/10:02:03\+08:00/);assert.match(tooltipTitle(row),/10:02:03/);c.commits[0].date='2026-10-25T11:02:03+08:00';c.renderHistory();assert.notEqual(c.el('commit-list').children[0],row);
});
test('custom tooltip titles retain context without restoring native browser titles',()=>{
 const e={title:'',dataset:{gdTooltip:'old'}};setTooltipTitle(e,'new\ncontext');assert.equal(tooltipTitle(e),'new\ncontext');assert.equal(e.title,'');e.title='external title';assert.equal(tooltipTitle(e),'external title');assert.equal(TOOLTIP_DELAY_MS,150);
});
test('empty panes yield space while drafts, staged files, errors and selected details stay accessible',()=>{
 const {c,get,app}=fixtureFrom('control-updates.test.cjs');for(const id of ['viewer-tools','file-title','commit-box','log','toggle-log','message'])get(id);for(const id of ['merge-tools','commit-inspector','file-compare-tools'])get(id).hidden=true;c.drafts=new Map();c.renderContextualRegions();assert(app.classList.contains('viewer-empty'));assert.equal(get('commit-box').hidden,true);
 c.drafts.set('.', {message:'keep my draft'});get('message').value='keep my draft';c.renderContextualRegions();assert.equal(get('commit-box').hidden,false);assert.equal(get('message').value,'keep my draft');c.drafts.set('.',{message:'',error:'save failed'});c.renderContextualRegions();assert.equal(get('commit-box').hidden,false);
 c.drafts.clear();c.details.repo.files=[{index:'M',worktree:' ',path:'a'}];c.renderContextualRegions();assert.equal(get('commit-box').hidden,false);c.details.repo.files=[];c.currentFile={path:'a',area:'worktree'};c.currentDiff={};c.renderContextualRegions();assert.equal(app.classList.contains('viewer-empty'),false);assert.equal(get('viewer-tools').hidden,false);
 c.currentDiff=undefined;c.currentFile=undefined;get('commit-inspector').hidden=false;c.renderContextualRegions();assert.equal(app.classList.contains('viewer-empty'),false);assert.equal(get('viewer-tools').hidden,true);
});
test('modal dismissal cancels only idle confirmations and never grants approval',()=>{
 const {c,get}=fixtureFrom('control-updates.test.cjs');let canceled=0,logs=0,results=0;c.cancelDialog=()=>canceled++;c.toggleLog=()=>logs++;c.closeProjectUpdate=()=>results++;c.updateButtons=()=>{};c.scopeReviewRequests=[];c.scopeReviewEpoch=0;get('scope-reviews-open').focus=()=>{};get('scope-review-modal').hidden=false;c.scopeReview={id:'pending'};
 c.busy=true;c.dismissModal('modal');assert.equal(canceled,0);c.busy=false;c.planning=true;c.dismissModal('amend-modal');assert.equal(canceled,0);c.planning=false;c.dismissModal('modal');assert.equal(canceled,1);
 c.dismissModal('scope-review-modal');assert.equal(c.scopeReview,undefined);assert.equal(get('scope-review-modal').hidden,true);assert.equal(c.scopeReviewEpoch,1);c.dismissModal('log-dialog');assert.equal(logs,1);c.dismissModal('project-update-progress');assert.equal(results,1);
});
