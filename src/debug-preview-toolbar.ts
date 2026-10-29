import { BrowserDebugFeedback, TransientNotice } from './browser-debug-feedback';
import type { Reply } from './types';
import { t } from './i18n';
import { attr, html } from './panel-i18n';

export const template = `<div class="debug-preview-toolbar"><button id="git-desk-open" type="button" title="${attr('panel.toolbar.openGitTitle')}"><span>Git Desk</span></button><button id="debug-preview-open" type="button" title="${attr('panel.toolbar.openPreviewTitle')}"><ui-icon value="scene" aria-hidden="true"></ui-icon><span>${html('panel.toolbar.preview')}</span></button><div id="debug-preview-result" role="status" aria-live="polite" hidden></div></div>`;
export const style = `
:host { display:flex; align-items:center; margin-left:8px; }
.debug-preview-toolbar { position:relative; display:flex; align-items:center; gap:6px; }
button { display:flex; align-items:center; gap:4px; height:24px; padding:0 8px; white-space:nowrap; cursor:pointer; font:inherit; color:var(--color-default-contrast); background:var(--color-normal-fill); border:1px solid var(--color-default-border); border-radius:calc(var(--size-normal-radius) * 2px); }
button:hover { background:var(--color-hover-fill); }
button:disabled { opacity:.6; cursor:wait; }
#debug-preview-result { position:absolute; top:30px; right:0; width:280px; max-width:70vw; padding:8px 10px; border:1px solid var(--color-default-border); border-radius:4px; background:var(--color-normal-fill); color:var(--color-default-contrast); white-space:normal; z-index:1000; }
#debug-preview-result[hidden] { display:none; }
`;
export const $ = { wrap:'.debug-preview-toolbar', button:'#debug-preview-open', gitButton:'#git-desk-open', result:'#debug-preview-result' };
interface Toolbar {
    $: {wrap:HTMLElement; button:HTMLButtonElement; gitButton:HTMLButtonElement; result:HTMLElement};
    dispose?:()=>void;
}
export function ready(this:Toolbar):void {
    this.dispose?.();
    const {wrap,button,gitButton,result}=this.$;
    const notice=new TransientNotice(result);
    const feedback=new BrowserDebugFeedback((message,pending,failed)=>{
        button.disabled=pending;
        gitButton.disabled=pending;
        gitButton.setAttribute('aria-busy',String(pending));
        button.setAttribute('aria-busy',String(pending));
        notice.show(message,pending,failed);
    });
    const open=()=>void feedback.run(t('panel.toolbar.openingPreview'),async()=>{
        const reply=await Editor.Message.request<Reply<string>>('cocos-git-desk','debug-preview-open');
        if(!reply.ok)throw Error(reply.error);
        return reply.data;
    });
    const openGit=()=>void feedback.run(t('panel.toolbar.openingGit'),async()=>{
        // Creator may return false when focusing an already open docked panel.
        await Editor.Message.request<boolean>('cocos-git-desk','open');
        return t('panel.toolbar.gitOpened');
    });
    const stopDoubleClick=(event:Event)=>event.stopPropagation();
    const outside=(event:Event)=>{if(!event.composedPath().includes(wrap))notice.hide();};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')notice.hide();};
    button.addEventListener('click',open);
    gitButton.addEventListener('click',openGit);
    wrap.addEventListener('dblclick',stopDoubleClick);
    wrap.ownerDocument.addEventListener('pointerdown',outside);
    wrap.ownerDocument.addEventListener('keydown',escape);
    this.dispose=()=>{
        feedback.dispose();
        notice.dispose();
        button.removeEventListener('click',open);
        gitButton.removeEventListener('click',openGit);
        wrap.removeEventListener('dblclick',stopDoubleClick);
        wrap.ownerDocument.removeEventListener('pointerdown',outside);
        wrap.ownerDocument.removeEventListener('keydown',escape);
    };
}
export function close(this:Toolbar):void {this.dispose?.();this.dispose=undefined;}
