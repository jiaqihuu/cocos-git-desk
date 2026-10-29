const test=require('node:test'),assert=require('node:assert/strict');
const {readSplits,restoreSplits,PreviewDockSize}=require('../dist/preview-dock-size');
class Element extends EventTarget {
 constructor(tag,width=100,height=100){super();this.tagName=tag;this.width=width;this.height=height;this.children=[];this.attrs={};this.style={};}
 append(child){this.children.push(child);child.parentElement=this;return child;}
 getRootNode(){return this.root||{};}
 getAttribute(key){return this.attrs[key]??null;}
 hasAttribute(key){return key in this.attrs;}
 getBoundingClientRect(){return {width:this.width,height:this.height};}
}
class Shadow {constructor(host){this.host=host;}}
function fixture(t){
 const oldElement=global.HTMLElement,oldShadow=global.ShadowRoot;global.HTMLElement=Element;global.ShadowRoot=Shadow;
 t.after(()=>{global.HTMLElement=oldElement;global.ShadowRoot=oldShadow;});
 const outer=new Element('DOCK-LAYOUT',1000,800);outer.attrs.direction='row';
 const left=outer.append(new Element('DOCK-LAYOUT',200,800));
 const center=outer.append(new Element('DOCK-LAYOUT',600,800));center.attrs.direction='column';
 const right=outer.append(new Element('DOCK-LAYOUT',200,800));
 const preview=center.append(new Element('DOCK-LAYOUT',600,600));
 const consolePane=center.append(new Element('DOCK-LAYOUT',600,200));
 const panel=preview.append(new Element('PANEL-FRAME'));
 const root=new Element('DIV');root.root=new Shadow(panel);
 root.ownerDocument=new EventTarget();const frames=new Map();let next=0;
 root.ownerDocument.defaultView={requestAnimationFrame:fn=>{frames.set(++next,fn);return next;},cancelAnimationFrame:id=>frames.delete(id)};
 const tick=()=>{const pending=[...frames.values()];frames.clear();for(const fn of pending)fn();};
 const settle=()=>{tick();tick();};
 return {root,left,center,right,preview,consolePane,tick,settle};
}
test('restores both axes in place after another tab resizes shared splits',t=>{
 const f=fixture(t),memory=new PreviewDockSize(f.root);t.after(()=>memory.close());memory.show();f.settle();memory.hide();
 f.preview.height=400;f.consolePane.height=400;f.center.width=400;f.right.width=400;
 memory.show();f.settle();assert.equal(f.preview.style.flex,'0.75 1 0%');assert.equal(f.consolePane.style.flex,'0.25 1 0%');assert.equal(f.center.style.flex,'0.6 1 0%');
 assert.equal(f.preview.children[0].tagName,'PANEL-FRAME');
});
test('remembers new preview sizes, ignores repeated show, and stops after close',t=>{
 const f=fixture(t),memory=new PreviewDockSize(f.root);memory.show();f.settle();
 f.preview.height=640;f.consolePane.height=160;memory.hide();f.preview.height=300;f.consolePane.height=500;memory.show();f.settle();
 assert.equal(f.preview.style.flex,'0.8 1 0%');f.preview.style.flex='manual';memory.show();f.settle();assert.equal(f.preview.style.flex,'manual');
 memory.close();memory.hide();memory.show();f.settle();assert.equal(f.preview.style.flex,'manual');
});
test('changed docking structure or minimized siblings invalidate saved geometry',t=>{
 const f=fixture(t),saved=readSplits(f.root);f.center.children.reverse();assert.equal(restoreSplits(saved,readSplits(f.root)),false);
 assert.equal(f.preview.style.flex,undefined);f.consolePane.attrs.minimize='';assert.equal(restoreSplits(saved,readSplits(f.root)),false);
});

test('restores after Creator overwrites flex in its show layout pass',t=>{
 const f=fixture(t),memory=new PreviewDockSize(f.root);t.after(()=>memory.close());
 memory.show();f.settle();memory.hide();
 f.preview.height=400;f.consolePane.height=400;memory.show();
 f.tick(); // Creator completes its deferred layout after the show callback.
 f.preview.style.flex='0.5 1 0%';f.consolePane.style.flex='0.5 1 0%';
 f.tick();assert.equal(f.preview.style.flex,'0.75 1 0%');
});
test('rapid hide cancels restoration without replacing the saved size',t=>{
 const f=fixture(t),memory=new PreviewDockSize(f.root);t.after(()=>memory.close());
 memory.show();f.settle();memory.hide();f.preview.height=400;f.consolePane.height=400;
 memory.show();f.tick();memory.hide();f.settle();assert.equal(f.preview.style.flex,undefined);
 memory.show();f.settle();assert.equal(f.preview.style.flex,'0.75 1 0%');
 memory.hide();memory.show();memory.close();f.preview.style.flex='closed';f.settle();assert.equal(f.preview.style.flex,'closed');
});
test('starting a divider drag cancels pending restore and saves the user size',t=>{
 const f=fixture(t),memory=new PreviewDockSize(f.root);t.after(()=>memory.close());
 memory.show();f.settle();memory.hide();memory.show();
 const event=new Event('pointerdown');event.composedPath=()=>[new Element('DOCK-RESIZE')];
 f.root.ownerDocument.dispatchEvent(event);f.preview.height=640;f.consolePane.height=160;
 f.root.ownerDocument.dispatchEvent(new Event('pointerup'));f.settle();
 assert.equal(f.preview.style.flex,undefined);memory.hide();f.preview.height=400;f.consolePane.height=400;
 memory.show();f.settle();assert.equal(f.preview.style.flex,'0.8 1 0%');
});
