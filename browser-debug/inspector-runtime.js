// Loaded only through the extension's frame injection (inspector-frames.cjs wraps it as a CommonJS module).
(function (factory) { module.exports = factory; })(function createRuntimeInspector({ cc, scan, safeText, sessionId, document, window }) {
    const { UITransform, Canvas, Asset, Node, Component, Vec2, Vec3, js, isValid } = cc;
    let lastMove=0, pageHovered='';
    let selected = '', candidates = [], picking = false, linked = false, running = false, timer, overlay, outline, hoverOutline, hovered = "", picks = 0;
    const history = [];
    let reads = new WeakMap();
    // The host scan stays authoritative; the index only spares a rescan between
    // two snapshots and every hit is re-validated through isValid.
    let byId = new Map();
    const valid = node => node && isValid(node, true);
    function scanIndexed() { const result = scan(); byId = new Map(result.nodes.map(item => [item.node.uuid, item])); return result; }
    function peek(uuid) { const item = uuid ? byId.get(uuid) : undefined; return item && valid(item.node) ? item.node : null; }
    function lookup(uuid) { const node = peek(uuid); if (node) return node; scanIndexed(); return peek(uuid); }
    const componentIds = new WeakMap(); let nextComponentId = 0;
    const componentId = component => { if(!componentIds.has(component))componentIds.set(component, String(++nextComponentId));return componentIds.get(component); };
    let valueBudget = 2000;
    const path = node => { const names = []; for (let p = node; p; p = p.parent) names.unshift(p.name); return safeText(names.join('/')); };
    const check = session => { if (session !== sessionId) throw Error('The preview reloaded; select the node again'); };
    function source(asset) {
        return asset instanceof Asset && valid(asset) ? { uuid: asset.uuid || '', name: safeText(asset.name || ''), type: js.getClassName(asset) } : null;
    }
    const scriptId=/^(?:[0-9a-f]{8}-[0-9a-f-]{27}|[0-9a-f]{2}[A-Za-z0-9+/]{20})$/i;
    const projectScripts=node=>node.components.filter(valid).map(component=>({type:js.getClassName(component),script:js.getClassId(component,false)||''})).filter(item=>scriptId.test(item.script)||!String(item.type).startsWith('cc.'));
    // The tree row icon follows the most specific built-in component, as Creator's hierarchy does.
    const kinds=[['cc.Canvas','canvas'],['cc.Camera','camera'],['cc.Button','button'],['cc.ScrollView','scroll'],['cc.EditBox','edit'],['cc.Toggle','toggle'],['cc.ProgressBar','progress'],['cc.Slider','slider'],['cc.Layout','layout'],['cc.Mask','mask'],['cc.Label','label'],['cc.RichText','label'],['cc.Sprite','sprite'],['cc.Widget','widget'],['cc.Animation','animation'],['cc.AudioSource','audio'],['cc.ParticleSystem2D','particle'],['cc.MeshRenderer','mesh'],['cc.Light','light']];
    function kindOf(node) {
        const names=new Set(node.components.filter(valid).map(component=>js.getClassName(component)));
        for(const [type,kind] of kinds)if(names.has(type))return kind;
        return 'node';
    }
    function info(node, depth) {
        return { uuid: node.uuid, parent: node.parent?.uuid || '', name: safeText(node.name), path: path(node), depth,
            active: node.active, activeInHierarchy: node.activeInHierarchy, isPrefab: !!node.prefab?.asset, childCount: node.children?.length || 0,
            kind: kindOf(node), scripts: projectScripts(node).length > 0 };
    }
    function valueInfo(value, depth = 0) {
        if (--valueBudget < 0) return '[read budget exhausted]';
        if (value == null || typeof value === 'boolean') return value;
        if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
        if (typeof value === 'string') return safeText(value);
        if (value instanceof Asset) return { kind: 'asset', ...source(value) };
        if (value instanceof Node) return { kind: 'node', uuid: valid(value) ? value.uuid : '', name: safeText(value.name || '') };
        if (value instanceof Component) return { kind: 'component', uuid: valid(value.node) ? value.node.uuid : '', name: js.getClassName(value) };
        if (depth >= 2) return '[object]';
        if (Array.isArray(value)) return { kind: 'array', count: value.length, items: value.slice(0, 16).map(v => valueInfo(v, depth + 1)) };
        if (cc.Color && value instanceof cc.Color)return {r:value.r,g:value.g,b:value.b,a:value.a};
        if (value instanceof Vec3)return {x:value.x,y:value.y,z:value.z};
        if (value instanceof Vec2)return {x:value.x,y:value.y};
        return '[object: not expanded]';
    }
    const sensitive = key => /password|token|authorization|cookie|secret|email|account|phone/i.test(key);
    // A password EditBox's text never leaves the page: string/_string of the box and of the Label it renders
    // into report only the length. Field names alone cannot tell, so the box's flag decides.
    const masked = text => '[password hidden, length '+String(text??'').length+']';
    const passwordBox = edit => !!edit && !!cc.EditBox?.InputFlag && edit instanceof cc.EditBox && edit.inputFlag===cc.EditBox.InputFlag.PASSWORD;
    function secret(component,key,node=component?.node) {
        if(key!=='string' && key!=='_string' || !cc.EditBox || !component)return false;
        if(component instanceof cc.EditBox)return passwordBox(component);
        for(let p=node,depth=0;p && depth<16;p=p.parent,depth++)if((p.components||[]).some(edit=>passwordBox(edit) && edit.textLabel===component))return true;
        return false;
    }
    // Turning a password box into a plain one would let the next read return the plaintext.
    const flagLocked = (component,key) => /^_?inputFlag$/.test(key) && passwordBox(component);
    function descriptor(object, key) {
        for (let p=object, depth=0;p && depth<12;p=Object.getPrototypeOf(p),depth++) {
            const value=Object.getOwnPropertyDescriptor(p,key);if(value)return value;
        }
    }
    function fieldsOf(component, all=false) {
        const serialized = component.constructor.__props__ || [];
        const names = [...new Set([...serialized,...Object.keys(component)])];
        return names.filter(key => key!=='node' && key!=='__proto__' && key!=='constructor' && !key.startsWith('__') && !sensitive(key)
            && (all || !key.startsWith('_') || serialized.includes(key))).slice(0,all?200:80);
    }
    function editable(value) {
        return ['boolean','string'].includes(typeof value) || typeof value==='number' && Number.isFinite(value)
            || value instanceof Vec2 || value instanceof Vec3 || cc.Color && value instanceof cc.Color;
    }
    function fieldInfo(component,key,node) {
        const d=descriptor(component,key);if(!d || typeof d.value==='function')return null;
        const attrs=(cc.CCClass || cc.Class)?.Attr?.attr(component.constructor,key) || {},hidden=secret(component,key,node),locked=hidden || flagLocked(component,key);
        // A read cached before the box became a password box is masked too.
        if(!Object.hasOwn(d,'value')){const cached=reads.get(component)?.get(key);return cached?{name:key,accessor:true,editable:!locked && !!d.set && editable(cached.raw) && attrs.readonly!==true,value:hidden?masked(cached.raw):cached.value,enumList:attrs.enumList}:{name:key,getter:true,editable:false,value:'[accessor: click to read]',enumList:attrs.enumList};}
        return {name:key,value:hidden?masked(d.value):valueInfo(d.value),editable:!locked && !key.startsWith('_') && !!d.writable && editable(d.value) && attrs.readonly!==true,enumList:attrs.enumList};
    }
    // Direct asset references of a node's components, read from plain data fields only (no accessors).
    function assetsOf(components) {
        const seen=new Map();
        for(const component of components){
            for(const key of fieldsOf(component,false)){
                const d=descriptor(component,key);if(!d||!Object.hasOwn(d,'value'))continue;
                for(const value of Array.isArray(d.value)?d.value.slice(0,16):[d.value]){
                    const asset=source(value);if(!asset||!asset.uuid||seen.has(asset.uuid))continue;
                    seen.set(asset.uuid,asset);if(seen.size>=40)return [...seen.values()];
                }
            }
        }
        return [...seen.values()];
    }
    // The nearest ancestor carrying project scripts is the view that owns a plain child node.
    function ownerOf(node) {
        for(let parent=node.parent,depth=0;parent&&depth<64;parent=parent.parent,depth++){
            const scripts=projectScripts(parent);
            if(scripts.length)return {uuid:parent.uuid,name:safeText(parent.name),path:path(parent),components:scripts.slice(0,8)};
        }
        return null;
    }
    function details(node,all=false,expanded=null) {
        valueBudget = 2000;
        const live=node.components.filter(valid).slice(0,40);
        const components = live.map(component => {
            const names=expanded && !expanded.has(componentId(component)) ? [] : fieldsOf(component,all);
            return { id:componentId(component), type:js.getClassName(component), script:js.getClassId(component,false)||'',
                enabled:component.enabled,enabledInHierarchy:component.enabledInHierarchy,
                fields:names.map(key=>fieldInfo(component,key,node)).filter(Boolean),fieldsLimited:names.length>=(all?200:80) };
        });
        const prefab=source(node.prefab?.asset);
        return {...info(node),position:valueInfo(node.position),scale:valueInfo(node.scale),rotation:valueInfo(node.eulerAngles),
            prefab,prefabFileId:node.prefab?.fileId||'',assets:assetsOf(live),owner:ownerOf(node),components,componentsLimited:node.components.length>40};
    }
    function target(uuid,id) {
        const node=lookup(uuid);
        if(!node)throw Error('The node was destroyed; select again');
        if(!id)return node;
        const component=node.components.find(c=>valid(c) && componentId(c)===id);
        if(!component)throw Error('The component was removed; select again');return component;
    }
    function readField(object,key,id) {
        if(!id){if(!['name','active','position','scale','rotation'].includes(key))throw Error('Unsupported node property');return key==='rotation'?object.eulerAngles:object[key];}
        if(key!=='enabled' && !fieldsOf(object,true).includes(key))throw Error('The field is not accessible');
        const d=descriptor(object,key);if(!d)throw Error('The property was removed');
        return object[key];
    }
    function assign(object,key,value,id) {
        const old=readField(object,key,id);
        if(typeof old==='number'){if(typeof value!=='number'||!Number.isFinite(value))throw Error('Enter a finite number');}
        else if(typeof old==='string'){if(typeof value!=='string'||value.length>4096)throw Error('The text is invalid or too long');}
        else if(typeof old==='boolean'){if(typeof value!=='boolean')throw Error('Enter a boolean');}
        else if(old instanceof Vec2 || old instanceof Vec3 || cc.Color && old instanceof cc.Color){
            const keys=cc.Color && old instanceof cc.Color?['r','g','b','a']:old instanceof Vec3?['x','y','z']:['x','y'];
            if(!value || keys.some(k=>typeof value[k]!=='number'||!Number.isFinite(value[k])))throw Error('Invalid vector or color values');
            if(keys[0]==='r' && keys.some(k=>value[k]<0||value[k]>255))throw Error('Color channels range from 0 to 255');
            const copy=old.clone();for(const k of keys)copy[k]=value[k];value=copy;
        } else throw Error('This type cannot be edited here; use DevTools');
        if(!id && ['position','rotation','scale'].includes(key))object[{position:'setPosition',rotation:'setRotationFromEuler',scale:'setScale'}[key]](value);
        else {
            if(id && key.startsWith('_'))throw Error('Internal fields are read-only; edit the public property instead');
            const d=descriptor(object,key);if(d && !d.writable && !d.set)throw Error('Read-only property');
            if(id && (cc.CCClass || cc.Class)?.Attr?.attr(object.constructor,key)?.readonly)throw Error('Read-only property');
            object[key]=value;
        }
    }
    function edit(request,session) {
        check(session);valueBudget=2000;const {uuid,id='',field,value,expected}=request;
        // The conflict check and undo would need the plaintext, so masked text is not editable here.
        const object=target(uuid,id);if(secret(object,field,lookup(uuid)))throw Error('A password box does not reveal its content and cannot be edited in the inspector');
        if(flagLocked(object,field))throw Error('The input type of a password box cannot be changed in the inspector');
        const before=valueInfo(readField(object,field,id));
        if(JSON.stringify(before)!==JSON.stringify(expected))throw Error('The property changed; refresh and retry');
        assign(object,field,value,id);
        const after=valueInfo(readField(object,field,id));if(reads.has(object))reads.get(object).delete(field);history.push({uuid,id,field,before,after});if(history.length>50)history.shift();return true;
    }
    function canvasInfo() {
        const element = document.querySelector('#GameCanvas');
        if (!element || !element.width || !element.height) return null;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 ? { element, rect } : null;
    }
    function bounds(node) {
        const transform = node.getComponent(UITransform), c = canvasInfo();
        if (!transform || !c || !node.activeInHierarchy) return null;
        const camera = cc.director?.root?.batcher2D?.getFirstRenderCamera(node);
        if (!camera || !(camera.visibility & node.layer)) return null;
        const x = -transform.anchorX * transform.width, y = -transform.anchorY * transform.height;
        const corners = [[x,y],[x+transform.width,y],[x+transform.width,y+transform.height],[x,y+transform.height]].map(([px,py]) => {
            const world = transform.convertToWorldSpaceAR(new Vec3(px,py,0));
            const point = camera.worldToScreen(new Vec3(), world);
            return { x: c.rect.left + point.x / c.element.width * c.rect.width, y: c.rect.top + (1 - point.y / c.element.height) * c.rect.height };
        });
        return { left: Math.min(...corners.map(p=>p.x)), top: Math.min(...corners.map(p=>p.y)),
            right: Math.max(...corners.map(p=>p.x)), bottom: Math.max(...corners.map(p=>p.y)) };
    }
    function draw() {
        if (!running) return;
        const c = canvasInfo();
        if (overlay) {
            overlay.style.display = picking && c ? 'block' : 'none';
            if (c) Object.assign(overlay.style,{ left:c.rect.left+'px',top:c.rect.top+'px',width:c.rect.width+'px',height:c.rect.height+'px' });
        }
        for (const [id, marker, prefix] of [[selected,outline,'Selected'],[hovered!==selected?hovered:'',hoverOutline,'Hover']]) {
            // Outside pick mode the game stays clean: tree selection only refreshes the panels.
            const node = picking ? peek(id) : null;
            const rect = node ? bounds(node) : null;
            marker.style.display = rect ? 'block' : 'none';
            if (rect) {
                Object.assign(marker.style,{left:rect.left+'px',top:rect.top+'px',width:Math.max(2,rect.right-rect.left)+'px',height:Math.max(2,rect.bottom-rect.top)+'px'});
                marker.children[0].textContent = `${prefix}: ${safeText(node.name)} · ${Math.round(rect.right-rect.left)} × ${Math.round(rect.bottom-rect.top)}`;
                Object.assign(marker.children[0].style,{position:'fixed',left:Math.max(0,c.rect.left,Math.min(rect.left,Math.min(c.rect.right,window.innerWidth)-220))+'px',top:Math.max(0,c.rect.top,Math.min(rect.top-24,Math.min(c.rect.bottom,window.innerHeight)-24))+'px'});
            }
        }
    }
    function hitAt(x,y,nodes) {
        const c = canvasInfo(); if (!c) return [];
        const point = new Vec2((x-c.rect.left)*c.element.width/c.rect.width,(c.rect.bottom-y)*c.element.height/c.rect.height);
        const hits = nodes.filter(({node}) => node.activeInHierarchy && node.getComponent(UITransform)?.hitTest(point)).reverse();
        // Canvas and empty layout layers have hit rectangles too, but do not cover
        // the UI visually. Keep them available as fallback candidates only.
        const rendered = [], containers = [];
        for (const item of hits) {
            const renderer = cc.UIRenderer && item.node.getComponent(cc.UIRenderer);
            (renderer?.enabledInHierarchy ? rendered : containers).push(item);
        }
        // Among pure containers prefer the more specific descendant. Rendered
        // siblings retain reverse traversal order (the later UI draws on top).
        containers.sort((a,b) => b.depth-a.depth);
        return [...rendered,...containers].map(({node})=>node.uuid);
    }
    // picks lets the host tell a canvas click apart from a selection made in the tree.
    function pickAt(x,y) { const nodes=scanIndexed().nodes;candidates=hitAt(x,y,nodes);selected=candidates[0]||'';hovered='';if(selected)picks++;draw(); }
    const suppress = event => { event.preventDefault(); event.stopImmediatePropagation(); };
    const trackHover = event => {
        // Passive hover only runs in pick mode so a parked cursor never keeps a highlight on the game.
        if(!picking){leavePage();return;}
        const c=canvasInfo();
        if(!c || event.target!==c.element && event.target!==overlay){leavePage();return;}
        if(Date.now()-lastMove<60)return;lastMove=Date.now();
        const nodes=scanIndexed().nodes;pageHovered=hovered=hitAt(event.clientX,event.clientY,nodes)[0]||'';draw();
    };
    const leavePage = () => {if(pageHovered){pageHovered='';hovered='';draw();}};
    const pointerOut = event => {if(!event.relatedTarget)leavePage();};
    const move = event => {suppress(event);};
    const pointer = event => { suppress(event); if(event.button===0)pickAt(event.clientX,event.clientY); };
    // Outside pick mode a plain click still reports the node under the cursor while the game keeps the input.
    const passivePick = event => { if(!linked||picking||event.button!==0)return;const c=canvasInfo();if(!c||event.target!==c.element)return;pickAt(event.clientX,event.clientY); };
    const escape = event => { if(picking && event.key==='Escape'){ suppress(event);picking=false;draw(); } };
    function start() {
        if (running) return; running = true;
        overlay = document.createElement('div');outline = document.createElement('div');hoverOutline = document.createElement('div');
        overlay.setAttribute('aria-label','Runtime node picking');overlay.title='Click to select a node; Esc leaves pick mode';
        Object.assign(overlay.style,{position:'fixed',zIndex:'2147483646',cursor:'crosshair',background:'transparent',touchAction:'none'});
        for (const [marker,color] of [[outline,'#54b9ff'],[hoverOutline,'#ffcc66']]) {
            Object.assign(marker.style,{position:'fixed',zIndex:'2147483647',pointerEvents:'none',border:'2px solid '+color,background:color+'22',boxSizing:'border-box'});
            const label=document.createElement('span');Object.assign(label.style,{background:'#18212d',color,padding:'3px 6px',font:'12px sans-serif',whiteSpace:'nowrap',maxWidth:'320px',overflow:'hidden',textOverflow:'ellipsis',pointerEvents:'none'});marker.append(label);
        }
        for (const type of ['pointerdown','pointermove','pointerup','mousedown','mouseup','click','dblclick','contextmenu','touchstart','touchmove','touchend','wheel']) overlay.addEventListener(type,type==='pointerup'?pointer:type==='pointermove'?move:suppress,{passive:false});
        window.addEventListener('keydown',escape,true);window.addEventListener('pointermove',trackHover,{capture:true,passive:true});window.addEventListener('pointerout',pointerOut,true);window.addEventListener('blur',leavePage);window.addEventListener('pointerdown',passivePick,{capture:true,passive:true});document.body.append(overlay,outline,hoverOutline);
        timer = window.setInterval(draw,150);draw();
    }
    function close() {
        reads=new WeakMap();byId=new Map();pageHovered='';running=false;picking=false;selected='';hovered='';candidates=[];history.length=0;window.clearInterval(timer);
        window.removeEventListener('keydown',escape,true);window.removeEventListener('pointermove',trackHover,{capture:true});window.removeEventListener('pointerout',pointerOut,true);window.removeEventListener('blur',leavePage);window.removeEventListener('pointerdown',passivePick,{capture:true});if(window.$gd0)delete window.$gd0;overlay?.remove();outline?.remove();hoverOutline?.remove();overlay=null;outline=null;hoverOutline=null;
    }
    return Object.freeze({
        snapshot(options={}) {
            start();linked=options.link===true;options={...options,reveal:options.reveal||!!selected&&options.selected!==undefined&&options.selected!==selected};const result=scanIndexed();
            if(pageHovered&&!result.nodes.some(item=>item.node.uuid===pageHovered)){pageHovered='';hovered='';}
            const revealHover=!!pageHovered&&options.hovered!==pageHovered&&!options.reveal;
            const revealTarget=revealHover?pageHovered:options.reveal?selected:'';
            const query=revealHover?'':String(options.contains||'').slice(0,200).toLowerCase();
            const ancestors=[];let chosen=result.nodes.find(item=>item.node.uuid===(revealTarget||selected))?.node;for(let p=chosen?.parent;p;p=p.parent)ancestors.push(p.uuid);
            const collapsed=new Set(Array.isArray(options.collapsed)?options.collapsed:[]);if(revealTarget)for(const uuid of ancestors)collapsed.delete(uuid);
            const matches=result.nodes.filter(({node})=>{if(query)return true;for(let p=node.parent;p;p=p.parent)if(collapsed.has(p.uuid))return false;return true;}).filter(({node})=>{if(!query)return true;const text=path(node).toLowerCase();if(text.includes(query))return true;let at=0;for(const c of text)if(c===query[at])at++;return at===query.length;});
            let offset=Math.max(0,Math.min(Number.isSafeInteger(options.offset)?options.offset:0,matches.length));
            if(revealTarget){const index=matches.findIndex(item=>item.node.uuid===revealTarget);if(index>=0)offset=Math.floor(index/200)*200;}
            const byId=new Map(result.nodes.map(item=>[item.node.uuid,item]));
            const node=selected && byId.get(selected)?.node;
            if(selected&&!node){selected='';candidates=[];}
            const state = { sessionId, picking, selected, hovered:pageHovered, revealHover, ancestors:revealTarget?ancestors:[], nodes:matches.slice(offset,offset+200).map(({node,depth})=>info(node,depth)),
                offset,total:matches.length,scanLimitReached:result.scanLimitReached,
                candidates:candidates.map(uuid=>byId.get(uuid)).filter(Boolean).slice(0,100).map(({node,depth})=>info(node,depth)),
                highlightMessage:picking&&node&&!bounds(node)?(!node.activeInHierarchy?'The node is inactive and not visible on screen':!node.getComponent(UITransform)?'The node has no UITransform; its screen bounds cannot be marked':'No render camera or canvas is available; screen bounds cannot be marked'):'',
                candidateCount:candidates.length, picks, undoCount:history.length, version:cc.VERSION || '', detail:node?details(node,options.all===true,Array.isArray(options.components)?new Set(options.components):null):null };
            // Identical snapshots only travel as a digest; the panel keeps its last full copy.
            const text=JSON.stringify(state);let hash=0x811c9dc5;for(let i=0;i<text.length;i++){hash^=text.charCodeAt(i);hash=Math.imul(hash,0x01000193)>>>0;}
            const digest=hash.toString(16)+':'+text.length;
            if(options.digest===digest)return {sessionId,digest,unchanged:true};
            state.digest=digest;return state;
        },
        select(uuid, session) { check(session);if(!lookup(uuid))throw Error('The node was destroyed; select again');selected=uuid;pageHovered='';hovered='';draw();return true; },
        pick(value,session) {check(session);start();picking=value===true;if(!picking){pageHovered='';hovered='';}draw();return picking;},
        hover(uuid,session){check(session);pageHovered='';hovered=uuid?target(uuid).uuid:'';draw();return true;},
        edit,
        undo(session){check(session);valueBudget=2000;const last=history[history.length-1];if(!last)throw Error('Nothing to undo');const object=target(last.uuid,last.id);
            // An undo must not do what edit refuses: write a password box's text or turn it back into a plain box.
            if(secret(object,last.field,lookup(last.uuid)))throw Error('A password box does not reveal its content and cannot be edited in the inspector');if(flagLocked(object,last.field))throw Error('The input type of a password box cannot be changed in the inspector');if(JSON.stringify(valueInfo(readField(object,last.field,last.id)))!==JSON.stringify(last.after))throw Error('The game changed the property; it cannot be undone');assign(object,last.field,last.before,last.id);history.pop();return true;},
        read(uuid,id,key,session){check(session);valueBudget=2000;const object=target(uuid,id),raw=readField(object,key,id),value=secret(object,key,lookup(uuid))?masked(raw):valueInfo(raw);if(!reads.has(object))reads.set(object,new Map());reads.get(object).set(key,{raw,value});return value;},
        print(uuid,id,session,options){
            check(session);const object=target(uuid,id),node=target(uuid);window.$gd0=object;
            // Creator's console receives this line as plain text; the object itself stays reachable as $gd0.
            window.console.log('[Git Desk] $gd0 = '+(id?js.getClassName(object):'node '+safeText(node.name))+' · '+path(node)+' (type $gd0 in the preview DevTools to inspect it)');
            if(!options?.snapshot)return '$gd0';
            const data=details(node,options.all===true);
            return {kind:id?'component':'node',name:id?js.getClassName(object):safeText(node.name),path:path(node),
                sessionId,reference:'$gd0',data:id?data.components.find(component=>component.id===id):data};
        },
        // Read-only queries for AI tools: no overlay, no selection or hover change, bounded output.
        hierarchy(options={}) {
            const result=scanIndexed();const query=String(options.contains||'').slice(0,200).toLowerCase();const activeOnly=options.activeOnly===true;
            const matches=result.nodes.filter(({node})=>(!activeOnly||node.activeInHierarchy)&&(!query||path(node).toLowerCase().includes(query)));
            const offset=Math.max(0,Math.min(Number.isSafeInteger(options.offset)?options.offset:0,matches.length)),limit=Math.max(1,Math.min(Number.isSafeInteger(options.limit)?options.limit:200,500));
            return {sessionId,selected,offset,total:matches.length,scanLimitReached:result.scanLimitReached,truncated:offset+limit<matches.length,nodes:matches.slice(offset,offset+limit).map(({node,depth})=>info(node,depth))};
        },
        // Flattened UI layout in design pixels with a top-left origin, as design tools measure: one row
        // per node with a UITransform, so an AI can diff positions and sizes against the design.
        layout(options={}) {
            const result=scanIndexed();const query=String(options.contains||'').slice(0,200).toLowerCase();
            const activeOnly=options.activeOnly!==false,limit=Math.max(1,Math.min(Number.isSafeInteger(options.limit)?options.limit:300,1000)),maxDepth=Number.isSafeInteger(options.maxDepth)?options.maxDepth:100;
            const rootNode=options.root?target(options.root):null;
            const view=cc.view,visible=view&&typeof view.getVisibleSize==='function'?view.getVisibleSize():null,design=view&&typeof view.getDesignResolutionSize==='function'?view.getDesignResolutionSize():null;
            const height=visible?visible.height:0,round=value=>Math.round(value*10)/10;
            const hex=color=>{const h=n=>Math.max(0,Math.min(255,Math.round(n))).toString(16).padStart(2,'0');return '#'+h(color.r)+h(color.g)+h(color.b)+(color.a<255?h(color.a):'');};
            const under=node=>{if(!rootNode)return true;for(let p=node;p;p=p.parent)if(p===rootNode)return true;return false;};
            const rows=[];let truncated=false;
            for(const {node,depth} of result.nodes){
                if(depth>maxDepth||(activeOnly&&!node.activeInHierarchy)||!under(node))continue;
                const transform=node.getComponent(UITransform);if(!transform)continue;
                if(query&&!path(node).toLowerCase().includes(query))continue;
                if(rows.length>=limit){truncated=true;break;}
                const rect=transform.getBoundingBoxToWorld();
                const label=cc.Label?node.getComponent(cc.Label):null,sprite=cc.Sprite?node.getComponent(cc.Sprite):null,opacity=cc.UIOpacity?node.getComponent(cc.UIOpacity):null;
                const color=(label||sprite)?.color;
                const row={uuid:node.uuid,name:safeText(node.name),path:path(node),depth,kind:kindOf(node),
                    x:round(rect.x),y:round(height-rect.y-rect.height),width:round(rect.width),height:round(rect.height),
                    anchor:{x:transform.anchorX,y:transform.anchorY},scale:{x:node.scale?.x??1,y:node.scale?.y??1},layer:node.layer,opacity:opacity?opacity.opacity:null};
                if(label){row.fontSize=label.fontSize;if(options.includeText===true)row.text=secret(label,'string',node)?masked(label.string):safeText(String(label.string??''));}
                if(sprite)row.sprite=sprite.spriteFrame?safeText(String(sprite.spriteFrame.name||'')):'';
                if(color)row.color=hex(color);
                rows.push(row);
            }
            return {sessionId,coordinates:'design px, origin top-left (y down), as design tools measure',design:design?{width:design.width,height:design.height}:null,visible:visible?{width:visible.width,height:visible.height}:null,total:rows.length,truncated,scanLimitReached:result.scanLimitReached,nodes:rows};
        },
        inspect(uuid,session,options={}){check(session);const node=target(uuid);const data=details(node,options.all===true,null);if(options.componentId){const component=data.components.find(item=>item.id===options.componentId);if(!component)throw Error('The component was removed; query again');return {sessionId,node:info(node,0),component};}return {sessionId,...data};},
        destroy(uuid,session){check(session);const node=target(uuid);if(!node.parent)throw Error('The scene root cannot be destroyed');node.destroy();selected='';hovered='';candidates=[];return true;},
        close,
    });
});
