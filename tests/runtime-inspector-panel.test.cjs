const test=require('node:test'),assert=require('node:assert/strict');
const {RuntimeInspectorView,hierarchyTemplate,propertiesTemplate,toolbarTemplate,inspectorActionsTemplate}=require('../dist/runtime-inspector-panel');
class Element extends EventTarget {
 constructor(tag='div'){super();this.tagName=tag.toUpperCase();this.attrs={};this.style={};this.value='';this.textContent='';this.children=[];this.dataset={};this.className='';this.title='';this.innerHTML='';this.classList={add:name=>{this.className=(this.className+' '+name).trim();}};}
 prepend(...items){this.children.unshift(...items);for(const item of items)item.parent=this;}
 setAttribute(k,v){this.attrs[k]=v;}replaceChildren(...items){this.children=items;for(const item of items)item.parent=this;}append(...items){this.children.push(...items);for(const item of items)item.parent=this;}querySelectorAll(){return [];}
 remove(){const list=this.parent?.children;if(list)list.splice(list.indexOf(this),1);}
 insertAdjacentHTML(){}focus(){}contains(el){return this.children.includes(el);}getBoundingClientRect(){return {top:0};}
 get firstElementChild(){return this.children[0];}
}
const hubState=(over={})=>({serial:1,closed:false,frame:'main',options:{contains:'',offset:0,link:true,collapsed:[],components:[]},snapshot:null,message:'',capture:null,capturePending:false,...over});
const snapshot=(over={})=>({sessionId:'s',selected:'',nodes:[],candidates:[],candidateCount:0,detail:null,offset:0,total:0,scanLimitReached:false,picking:false,...over});
function fixture(t,options={}){
 const elements=new Map(),log={updates:[],actions:[],hovers:[],reads:[],navigations:[],views:[]};
 const root=new Element();root.ownerDocument={createElement:tag=>new Element(tag),hidden:false};
 root.querySelector=selector=>{if(options.missing?.includes(selector))return null;if(!elements.has(selector))elements.set(selector,new Element(selector==='#inspector-search'?'input':selector==='#inspector-frame'?'select':'div'));return elements.get(selector);};
 const client={view:async visible=>{log.views.push(visible);if(options.viewError)throw Error(options.viewError);},state:async()=>{if(options.viewError)throw Error(options.viewError);return options.state?options.state():hubState();},update:async change=>{log.updates.push(change);},action:async(method,args)=>{log.actions.push([method,args]);return options.actionResult??true;},hover:async(...args)=>{log.hovers.push(args);},read:async(...args)=>{log.reads.push(args);},navigate:async(...args)=>{log.navigations.push(args);return 'located';}};
 const view=new RuntimeInspectorView(root,client,options.passive===true);t.after(()=>view.close());
 return {root,view,client,log,elements,element:id=>root.querySelector('#'+id)};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('templates split the inspector into toolbar, hierarchy and properties surfaces',()=>{
 assert.match(toolbarTemplate,/id="inspector-pick"/);assert.match(toolbarTemplate,/id="inspector-capture"/);assert.doesNotMatch(toolbarTemplate,/inspector-frame|inspector-keys|inspector-tree/);
 assert.match(hierarchyTemplate,/id="inspector-tree"/);assert.doesNotMatch(hierarchyTemplate,/id="inspector-detail"/);
 assert.match(propertiesTemplate,/id="inspector-detail"/);
 assert.match(inspectorActionsTemplate,/id="inspector-capture"[^>]*title="DrawCall[^"]+"[^>]*aria-label[^>]*><svg/);assert.doesNotMatch(inspectorActionsTemplate,/inspector-undo|>撤销<|>DrawCall</);
});
test('starting a view registers it, fetches the current state and renders; hiding unregisters and clears',async t=>{
 const f=fixture(t,{state:()=>hubState({snapshot:snapshot({nodes:[{uuid:'a',name:'a',path:'a',depth:0,activeInHierarchy:true}],total:1})})});
 f.view.start();await flush();assert.deepEqual(f.log.views,[true]);assert.equal(f.element('inspector-tree').children.length,1);
 f.view.setVisible(false);await flush();assert.deepEqual(f.log.views,[true,false]);assert.equal(f.element('inspector-tree').children.length,0);
 f.view.setVisible(true);await flush();assert.deepEqual(f.log.views,[true,false,true]);assert.equal(f.element('inspector-tree').children.length,1);
});
test('a view that failed to register shows the reason and retries when the hub publishes again',async t=>{
 const f=fixture(t,{viewError:'请先打开调试预览，再打开运行时检查器'});
 f.view.start();await flush();assert.match(f.root.querySelector('.inspector-message').textContent,/请先打开调试预览/);
 f.view.update(hubState());await flush();assert.deepEqual(f.log.views,[true,true]);
 f.view.update(hubState({closed:true,message:'调试预览已关闭'}));assert.equal(f.root.querySelector('.inspector-message').textContent,'调试预览已关闭');
});
test('passive views never register but still follow published states',async t=>{
 const f=fixture(t,{passive:true});f.view.start();await flush();assert.deepEqual(f.log.views,[]);
 f.view.update(hubState({options:{contains:'',offset:0,link:false,collapsed:[],components:[]}}));assert.equal(f.element('inspector-link').attrs['aria-pressed'],'false');
 f.view.setVisible(false);f.view.setVisible(true);await flush();assert.deepEqual(f.log.views,[]);
});
test('search, paging, folding and link changes go to the hub instead of local state',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t);
 f.view.update(hubState({options:{contains:'',offset:200,link:true,collapsed:[],components:[]},snapshot:snapshot({nodes:[{uuid:'a',name:'a',path:'a',depth:0,childCount:1,activeInHierarchy:true}],total:401,offset:200})}));
 const search=f.element('inspector-search');search.value='abc';search.dispatchEvent(new Event('input'));t.mock.timers.tick(200);await flush();
 f.element('inspector-next').dispatchEvent(new Event('click'));f.element('inspector-prev').dispatchEvent(new Event('click'));f.element('inspector-link').dispatchEvent(new Event('click'));
 f.element('inspector-tree').children[0].dispatchEvent(new Event('dblclick'));f.element('inspector-tree').children[0].children[0].dispatchEvent(new Event('click'));await flush();
 assert.deepEqual(f.log.updates,[{contains:'abc'},{offset:400},{offset:0},{link:false},{fold:'a'},{fold:'a'}]);assert.equal(f.element('inspector-tree').children[0].children[0].textContent,'▾','the arrow folds without selecting');assert.equal(f.log.actions.length,0);
});
test('new selection scrolls into view without resetting manual scroll on later polls',t=>{
 const f=fixture(t),tree=f.element('inspector-tree');
 tree.scrollTop=30;tree.clientHeight=100;tree.getBoundingClientRect=()=>({top:50});
 f.root.ownerDocument.createElement=tag=>{const element=new Element(tag);element.getBoundingClientRect=()=>({top:350});return element;};
 const state=hubState({snapshot:snapshot({selected:'child',nodes:[{uuid:'child',name:'child',path:'root/child',depth:1,activeInHierarchy:true}],total:1})});
 f.view.update(state);assert.equal(tree.scrollTop,280);
 tree.scrollTop=10;f.view.update({...state,serial:2});assert.equal(tree.scrollTop,10);
});
test('hover and selection update existing tree rows without rebuilding their handlers',t=>{
 const f=fixture(t);let builds=0;
 f.view.nodeButton=(node,parent)=>{builds++;const row=new Element('button');row.dataset.uuid=node.uuid;parent.append(row);};
 const tree=f.element('inspector-tree');tree.clientHeight=100;tree.scrollTop=0;
 const base=snapshot({nodes:[{uuid:'one',name:'one'}],total:1});
 f.view.update(hubState({snapshot:base}));const row=tree.children[0];
 f.view.update(hubState({serial:2,snapshot:{...base,hovered:'one'}}));f.view.update(hubState({serial:3,snapshot:{...base,selected:'one'}}));
 assert.equal(builds,1);assert.equal(tree.children[0],row);assert.equal(row.attrs['aria-selected'],'true');assert.equal(row.dataset.hovered,'false');
});
test('tree hover coalesces into one request per settled row and skips repeated targets',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t);
 f.view.update(hubState({snapshot:snapshot({nodes:[{uuid:'a',name:'a',path:'a',depth:0,activeInHierarchy:true},{uuid:'b',name:'b',path:'b',depth:0,activeInHierarchy:true}],total:2})}));
 const [a,b]=f.element('inspector-tree').children;
 a.dispatchEvent(new Event('mouseenter'));a.dispatchEvent(new Event('mouseleave'));b.dispatchEvent(new Event('mouseenter'));t.mock.timers.tick(80);await flush();
 assert.deepEqual(f.log.hovers,[['main','b','s']]);
 b.dispatchEvent(new Event('mouseleave'));b.dispatchEvent(new Event('mouseenter'));t.mock.timers.tick(80);await flush();assert.equal(f.log.hovers.length,1);
 b.dispatchEvent(new Event('mouseleave'));t.mock.timers.tick(80);await flush();assert.deepEqual(f.log.hovers.at(-1),['main','','s']);
});
test('unrelated detail or hover updates preserve unchanged DOM sections',t=>{
 const f=fixture(t),state=hubState({snapshot:snapshot()});f.view.update(state);
 const tree=f.element('inspector-tree'),detail=f.element('inspector-detail'),candidates=f.element('inspector-candidates');
 let trees=0,details=0,choices=0;
 for(const [element,count]of [[tree,()=>trees++],[detail,()=>details++],[candidates,()=>choices++]]){const original=element.replaceChildren.bind(element);element.replaceChildren=(...args)=>{count();original(...args);};}
 f.view.update(hubState({serial:2,snapshot:snapshot({highlightMessage:'changed'})}));assert.equal(trees,0);assert.equal(details,1);assert.equal(choices,0);
 f.view.update(hubState({serial:3,snapshot:snapshot({highlightMessage:'changed',hovered:'other'})}));assert.equal(details,1);assert.equal(choices,0);
 f.view.update(hubState({serial:4,snapshot:snapshot({sessionId:'next'})}));assert.ok(trees>0,'a new page session rebuilds the tree');
});
test('focused active checkbox can toggle repeatedly using the last successful value',async t=>{
 const f=fixture(t),parent=new Element(),requests=[];let active=true;
 f.client.action=async(method,args)=>{requests.push(args[0]);assert.equal(args[0].expected,active);active=args[0].value;return true;};
 f.view.editor('active',true,parent,'node','','session');const input=parent.children[0].children[0];
 input.checked=false;input.dispatchEvent(new Event('change'));await flush();assert.equal(active,false);
 input.checked=true;input.dispatchEvent(new Event('change'));await flush();assert.equal(active,true);
 assert.deepEqual(requests.map(r=>r.expected),[true,false]);
});
test('pending checkbox writes do not enqueue a second stale edit',async t=>{
 const f=fixture(t),parent=new Element();let finish,count=0;
 f.client.action=()=>{count++;return new Promise(resolve=>finish=resolve);};
 f.view.editor('active',true,parent,'node','','session');const input=parent.children[0].children[0];
 input.checked=false;input.dispatchEvent(new Event('change'));input.checked=true;input.dispatchEvent(new Event('change'));
 assert.equal(count,1);finish(true);await flush();
});
test('a focused property editor defers re-rendering until focus leaves the detail section',t=>{
 const f=fixture(t),detail=f.element('inspector-detail');
 const item={uuid:'n',name:'node',path:'root/node',active:true,position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},scale:{x:1,y:1,z:1},components:[]};
 f.view.update(hubState({snapshot:snapshot({selected:'n',detail:item})}));const first=detail.children.length;assert.ok(first>0);
 const input=new Element('input');detail.children.push(input);f.root.ownerDocument.activeElement=input;
 f.view.update(hubState({serial:2,snapshot:snapshot({selected:'n',detail:{...item,name:'renamed'}})}));assert.equal(detail.children.length,first+1,'render is deferred while editing');
 f.root.ownerDocument.activeElement=null;f.root.dispatchEvent(new Event('focusout'));assert.equal(detail.children[0].children[0].textContent,'renamed');
});
test('collapsed component fields render on expansion and report the toggle to the hub',async t=>{
 const f=fixture(t);
 const item={uuid:'n',name:'node',path:'root/node',active:true,position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},scale:{x:1,y:1,z:1},components:[{id:'c',type:'Example',enabled:true,enabledInHierarchy:true,fields:[{name:'count',value:1,editable:true}]}]};
 f.view.update(hubState({snapshot:snapshot({selected:'n',detail:item})}));
 const detail=f.element('inspector-detail');let section=detail.children.find(el=>el.tagName==='DETAILS');assert.equal(section.children.length,1);
 section.isConnected=true;section.open=true;section.dispatchEvent(new Event('toggle'));await flush();assert.deepEqual(f.log.updates,[{component:{id:'c',open:true}}]);
 item.components[0].fields[0].value=2;f.view.update(hubState({serial:2,options:{contains:'',offset:0,all:false,collapsed:[],components:['c']},snapshot:snapshot({selected:'n',detail:item})}));
 section=detail.children.find(el=>el.tagName==='DETAILS');assert.equal(section.open,true,'expansion survives a re-render');
 const field=section.children.find(el=>el.className==='inspector-field');assert.equal(field.children[0].children[0].value,'2');
 const count=section.children.length;section.open=false;section.dispatchEvent(new Event('toggle'));section.open=true;section.dispatchEvent(new Event('toggle'));assert.equal(section.children.length,count);
});
test('DrawCall details are lazy and closing prevents pending expansion work',t=>{
 const f=fixture(t);const result={frame:1,drawCalls:1,triangles:1,note:'test',gpuCalls:[{index:0,method:'draw',args:[]}],uiBatches:[{index:0,nodes:['n'],texture:1}],submissions:[{node:'n',path:'root/n',reasons:[]}]};
 f.view.update(hubState({capture:{pending:false,error:'',result}}));const bar=f.element('inspector-render').children[0];assert.equal(bar.className,'inspector-render-bar');const section=f.element('inspector-render').children[1];
 const gpu=section.children[2],batch=section.children[3],entries=section.children[4];
 assert.equal(gpu.children.length,1);assert.equal(batch.children.length,1);assert.equal(entries.children.length,2);
 for(const el of [gpu,batch]){el.open=true;el.dispatchEvent(new Event('toggle'));assert.equal(el.children.length,2);el.dispatchEvent(new Event('toggle'));assert.equal(el.children.length,2);}
 f.view.close();entries.open=true;entries.dispatchEvent(new Event('toggle'));assert.equal(entries.children.length,2);
});
test('node actions sit in the title row as icon buttons; prefab, script and asset references navigate through the client',async t=>{
 const f=fixture(t);
 const item={uuid:'node-id',parent:'root',name:'node',path:'root/node',active:true,prefab:{uuid:'prefab-id',name:'Login',type:'cc.Prefab'},prefabFileId:'file-id',assets:[{uuid:'sprite-id',name:'bg',type:'cc.SpriteFrame'}],position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},scale:{x:1,y:1,z:1},components:[{id:'c',type:'LoginView',script:'fcmR3XADNLgJ1ByKhqcC5Z',enabled:true,enabledInHierarchy:true,fields:[]}]};
 f.view.update(hubState({snapshot:snapshot({selected:'node-id',detail:item})}));
 const detail=f.element('inspector-detail'),heading=detail.children[0],title=heading.children[0];
 assert.equal(detail.children.some(el=>el.className==='inspector-node-actions'),false,'no separate action row');
 const tools=title.children.find(el=>el.className==='inspector-title-actions');const icons=tools.children;assert.equal(icons.length,3);assert.ok(icons.every(el=>el.title&&el.attrs['aria-label']===el.title&&String(el.innerHTML).startsWith('<svg')));
 assert.equal(icons[1].id,'inspector-undo');assert.equal(icons[1].hidden,true);assert.ok(icons[2].className.includes('inspector-danger'));
 const origin=heading.children.find(el=>el.className==='inspector-origin');assert.equal(origin.children[0].textContent,'Prefab · Login');
 const prefab=origin.children.find(el=>el.className.includes('inspector-prefab'));assert.match(prefab.title,/资源管理器中定位/);prefab.dispatchEvent(new Event('click'));await flush();
 assert.deepEqual(f.log.navigations,[['prefab-id','prefab','file-id']]);
 const resources=detail.children.find(el=>el.className==='inspector-resources');
 assert.deepEqual(resources.children.filter(el=>el.className==='inspector-subtitle').map(el=>el.textContent),['脚本','引用资源']);
 const rows=resources.children.filter(el=>el.className==='inspector-resource');assert.equal(rows.length,2);
 assert.equal(rows[0].children[0].textContent,'LoginView');rows[0].children[1].dispatchEvent(new Event('click'));rows[0].children[2].dispatchEvent(new Event('click'));
 assert.equal(rows[1].children[0].textContent,'bg');assert.equal(rows[1].children[1].textContent,'SpriteFrame');rows[1].children[2].dispatchEvent(new Event('click'));await flush();
 assert.deepEqual(f.log.navigations.slice(1),[['fcmR3XADNLgJ1ByKhqcC5Z','open',undefined],['fcmR3XADNLgJ1ByKhqcC5Z','reveal',undefined],['sprite-id','reveal',undefined]]);
 assert.equal(f.log.actions.length,0);
});
test('DrawCall results carry a close control and a pending capture can be cancelled',async t=>{
 const f=fixture(t);f.view.update(hubState({capture:{pending:true,error:'',result:null}}));
 const bar=f.element('inspector-render').children[0];const cancel=bar.children.find(el=>el.textContent==='取消');assert.ok(cancel);cancel.dispatchEvent(new Event('click'));await flush();
 assert.deepEqual(f.log.updates,[{capture:false}]);
 f.view.update(hubState({serial:2,capture:null}));assert.equal(f.element('inspector-render').children.length,0);
});
test('keyboard navigation and pick act on the hub state, destroy asks for confirmation',async t=>{
 const f=fixture(t);let confirmed=false;f.root.ownerDocument.defaultView={HTMLInputElement:class{},confirm:()=>confirmed};
 f.view.update(hubState({snapshot:snapshot({selected:'a',nodes:[{uuid:'a',name:'a',path:'a',depth:0,childCount:1,activeInHierarchy:true,active:true},{uuid:'b',parent:'a',name:'b',path:'a/b',depth:1,activeInHierarchy:true,active:true}],total:2,detail:{uuid:'a',name:'a',path:'a',active:true,position:{},rotation:{},scale:{},components:[]}})}));
 const tree=f.element('inspector-tree');const press=key=>{const event=new Event('keydown',{cancelable:true});event.key=key;tree.dispatchEvent(event);};
 press('ArrowDown');press('p');press('Delete');confirmed=true;press('Delete');await flush();
 assert.deepEqual(f.log.actions.map(a=>a[0]),['select','pick','destroy']);assert.deepEqual(f.log.actions[0][1],['b','s']);assert.deepEqual(f.log.actions[1][1],[true,'s']);
});
test('navigation results stay visible until the next operation instead of being wiped by state updates',async t=>{
 const f=fixture(t,{missing:['#status']});
 const item={uuid:'node-id',name:'node',path:'root/node',active:true,prefab:{uuid:'prefab-id',name:'Login',type:'cc.Prefab'},prefabFileId:'file-id',position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},scale:{x:1,y:1,z:1},components:[]};
 f.view.update(hubState({snapshot:snapshot({selected:'node-id',detail:item})}));
 f.element('inspector-detail').children[0].children.find(el=>el.className==='inspector-origin').children.find(el=>el.className.includes('inspector-prefab')).dispatchEvent(new Event('click'));await flush();
 const message=f.root.querySelector('.inspector-message');assert.equal(message.textContent,'located');
 f.view.update(hubState({serial:2,snapshot:snapshot({selected:'node-id',detail:item})}));assert.equal(message.textContent,'located','a state broadcast keeps the notice');
 f.view.update(hubState({serial:3,message:'选取中',snapshot:snapshot({selected:'node-id',detail:item})}));assert.equal(message.textContent,'选取中','hub messages take precedence');
 f.view.update(hubState({serial:4,snapshot:snapshot({selected:'node-id',detail:item})}));assert.equal(message.textContent,'located');
 await f.view.act('pick',[true,'s']);f.view.update(hubState({serial:5,snapshot:snapshot({selected:'node-id',detail:item})}));assert.equal(message.textContent,'','the next operation clears it');
});
test('the active checkbox lives in the heading, toggles through edit and reverts when the edit is refused',async t=>{
 const f=fixture(t,{actionResult:false});
 const item={uuid:'n',name:'node',path:'root/node',active:true,position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},scale:{x:1,y:1,z:1},components:[]};
 f.view.update(hubState({snapshot:snapshot({selected:'n',detail:item})}));
 const detail=f.element('inspector-detail');const title=detail.children[0].children[0];assert.equal(title.tagName,'H4');assert.equal(title.textContent,'node');
 const toggle=title.children[0];assert.equal(toggle.type,'checkbox');assert.equal(toggle.checked,true);
 assert.equal(detail.children.some(el=>el.className==='inspector-edit'&&el.textContent==='active '),false,'no separate active row');
 toggle.checked=false;toggle.dispatchEvent(new Event('change'));await flush();
 assert.deepEqual(f.log.actions,[['edit',[{uuid:'n',field:'active',value:false,expected:true},'s']]]);assert.equal(toggle.checked,true,'a refused edit restores the checkbox');
});
test('resource navigation shows immediate feedback before the editor answers',async t=>{
 const f=fixture(t,{missing:['#status']});let finish;f.client.navigate=()=>new Promise(resolve=>finish=resolve);
 const item={uuid:'n',name:'node',path:'root/node',active:true,assets:[{uuid:'sprite-id',name:'bg',type:'cc.SpriteFrame'}],position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},scale:{x:1,y:1,z:1},components:[]};
 f.view.update(hubState({snapshot:snapshot({selected:'n',detail:item})}));
 const row=f.element('inspector-detail').children.find(el=>el.className==='inspector-resources').children.find(el=>el.className==='inspector-resource');
 row.children[2].dispatchEvent(new Event('click'));await flush();assert.equal(f.root.querySelector('.inspector-message').textContent,'正在定位资源…');assert.equal(row.children[2].disabled,true);
 finish('已定位：db://assets/bg.png');await flush();assert.equal(f.root.querySelector('.inspector-message').textContent,'已定位：db://assets/bg.png');assert.equal(row.children[2].disabled,false);
});
test('undo lives in the title row and appears only with undo history; root nodes cannot be destroyed; capture hides without a frame',async t=>{
 const f=fixture(t);
 const item={uuid:'n',parent:'',name:'root',path:'root',active:true,position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},scale:{x:1,y:1,z:1},components:[]};
 f.view.update(hubState({frame:'',snapshot:snapshot({selected:'n',detail:item,undoCount:0})}));
 const detail=f.element('inspector-detail');const tools=()=>detail.children[0].children[0].children.find(el=>el.className==='inspector-title-actions');
 const undo=tools().children.find(el=>el.id==='inspector-undo');assert.ok(undo);assert.equal(undo.hidden,true);
 assert.equal(f.element('inspector-capture').hidden,true,'no frame, no DrawCall button');
 assert.equal(tools().children.some(el=>el.className.includes('inspector-danger')),false,'scene root has no destroy button');
 f.view.update(hubState({serial:2,snapshot:snapshot({selected:'n',detail:item,undoCount:2})}));assert.equal(undo.hidden,false,'undo history makes the button appear without rebuilding the detail');
 assert.equal(f.element('inspector-capture').hidden,false);
 undo.dispatchEvent(new Event('click'));await flush();assert.deepEqual(f.log.actions,[['undo',['s']]]);
 f.view.update(hubState({serial:3,snapshot:snapshot({selected:'c',detail:{...item,uuid:'c',parent:'n',name:'child',path:'root/child'},undoCount:0})}));
 assert.equal(tools().children.some(el=>el.className.includes('inspector-danger')),true);
});
test('project components without a script UUID still get script rows resolved by class name; built-ins do not',t=>{
 const f=fixture(t);
 const item={uuid:'n',parent:'p',name:'node',path:'root/node',active:true,position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},scale:{x:1,y:1,z:1},components:[{id:'a',type:'LoginView',script:'LoginView',enabled:true,enabledInHierarchy:true,fields:[]},{id:'b',type:'cc.Sprite',script:'cc.Sprite',enabled:true,enabledInHierarchy:true,fields:[]}]};
 f.view.update(hubState({snapshot:snapshot({selected:'n',detail:item})}));
 const rows=f.element('inspector-detail').children.find(el=>el.className==='inspector-resources').children.filter(el=>el.className==='inspector-resource');
 assert.equal(rows.length,1);assert.equal(rows[0].children[0].textContent,'LoginView');rows[0].children[1].dispatchEvent(new Event('click'));
 return flush().then(()=>assert.deepEqual(f.log.navigations,[['LoginView','open',undefined]]));
});
test('a view whose registration is refused keeps retrying while visible and stops when hidden or closed',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let refuse=true;const f=fixture(t);
 f.client.view=async()=>{f.log.views.push(refuse);if(refuse)throw Error('请先打开调试预览，再打开运行时检查器');};f.client.state=async()=>{if(refuse)throw Error('请先打开调试预览，再打开运行时检查器');return hubState();};
 f.view.start();await flush();assert.deepEqual(f.log.views,[true]);assert.match(f.root.querySelector('.inspector-message').textContent,/请先打开调试预览/);
 t.mock.timers.tick(2000);await flush();assert.equal(f.log.views.length,2,'retries after two seconds');
 refuse=false;t.mock.timers.tick(2000);await flush();await flush();assert.equal(f.log.views.length,3);assert.equal(f.root.querySelector('.inspector-message').textContent,'','a successful registration clears the hint');
 t.mock.timers.tick(4000);await flush();assert.equal(f.log.views.length,3,'no retries once registered');
 refuse=true;f.view.setVisible(false);f.view.setVisible(true);await flush();t.mock.timers.tick(2000);await flush();const attempts=f.log.views.length;
 f.view.setVisible(false);t.mock.timers.tick(4000);await flush();assert.equal(f.log.views.filter(v=>v===true).length,attempts-1,'hiding stops the retry loop');
});
test('the owning view is listed with a jump link and its scripts',async t=>{
 const f=fixture(t);
 const item={uuid:'n',parent:'p',name:'piece_node',path:'root/view/piece_node',active:true,position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},scale:{x:1,y:1,z:1},components:[{id:'b',type:'cc.Sprite',script:'cc.Sprite',enabled:true,enabledInHierarchy:true,fields:[]}],owner:{uuid:'view',name:'TournamentDetailsView',path:'root/view',components:[{type:'TournamentDetailsView',script:'fcmR3XADNLgJ1ByKhqcC5Z'},{type:'LayerUIElement',script:'LayerUIElement'}]}};
 f.view.update(hubState({snapshot:snapshot({selected:'n',detail:item})}));
 const resources=f.element('inspector-detail').children.find(el=>el.className==='inspector-resources');
 const title=resources.children.find(el=>el.className==='inspector-subtitle'&&el.textContent.startsWith('所在视图'));assert.equal(title.textContent,'所在视图 · TournamentDetailsView');
 const jump=title.children[0];assert.ok(String(jump.innerHTML).startsWith('<svg'));assert.match(jump.title,/选中 root\/view/);jump.dispatchEvent(new Event('click'));await flush();assert.deepEqual(f.log.actions,[['select',['view','s']]]);
 const rows=resources.children.filter(el=>el.className==='inspector-resource');assert.deepEqual(rows.map(r=>r.children[0].textContent),['TournamentDetailsView','LayerUIElement']);
 rows[1].children[2].dispatchEvent(new Event('click'));await flush();assert.deepEqual(f.log.navigations,[['LayerUIElement','reveal',undefined]]);
});
test('report() describes what the surface renders without a screenshot',t=>{
 const f=fixture(t);
 assert.deepEqual(f.view.report().hierarchy,{rows:0,names:[],selected:'',hovered:'',count:'',search:'',candidates:0},'an empty surface reports empty, not an error');
 const item={uuid:'n',parent:'root',name:'node',path:'root/node',active:true,prefab:{uuid:'p',name:'Login',type:'cc.Prefab'},prefabFileId:'f',position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},scale:{x:1,y:1,z:1},components:[{id:'c',type:'Example',enabled:true,enabledInHierarchy:true,fields:[]},{id:'d',type:'cc.Sprite',enabled:true,enabledInHierarchy:true,fields:[]}]};
 f.view.update(hubState({serial:7,options:{contains:'ab',offset:0,link:false,collapsed:[],components:['c']},snapshot:snapshot({selected:'n',picking:true,nodes:[{uuid:'root',name:'root',path:'root',depth:0,childCount:1,activeInHierarchy:true},{uuid:'n',name:'node',path:'root/node',depth:1,activeInHierarchy:true,scripts:true}],total:2,detail:item,undoCount:1})}));
 const report=f.view.report();
 assert.equal(report.serial,7);assert.equal(report.sessionId,'s');assert.equal(report.visible,true);
 assert.deepEqual(report.hierarchy.names,['root','node']);assert.equal(report.hierarchy.rows,2);assert.equal(report.hierarchy.selected,'n');assert.equal(report.hierarchy.search,'ab');assert.equal(report.hierarchy.count,'1–2 / 2');
 assert.equal(report.properties.node,'n');assert.equal(report.properties.title,'node');assert.equal(report.properties.components,2);assert.equal(report.properties.expanded,1);assert.equal(report.properties.undoVisible,true);
 assert.deepEqual(report.toolbar,{picking:true,link:false,capturePending:false});
 f.view.setVisible(false);assert.equal(f.view.report().visible,false);assert.equal(f.view.report().hierarchy.rows,0,'hidden surfaces are cleared');
});
