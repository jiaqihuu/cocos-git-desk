'use strict';
const { projectOptions } = require('./setup.cjs');
const { InspectorFrames } = require('./inspector-frames.cjs');
// A loading-phase failure: the runtime inspector shows it as waiting, not as an error.
function notConnected() { const error = Error('The preview is not connected yet'); error.code = 'PREVIEW_NOT_CONNECTED'; return error; }
function allowedUrl(value, expected) {
    try { const u = new URL(value), e = new URL(expected); return u.origin === e.origin && u.pathname === e.pathname; } catch { return false; }
}
// Owns the dedicated preview webview: validates it, attaches the CDP debugger, fans events out to
// in-process listeners and runs page evaluations for the inspector and the MCP tools.
class EmbeddedPreview {
    // options: url (git-desk.config.json preview.url), projectId, controlName (the page control object the
    // project bridge installs, if any) and engineVersions (which engines the inspector may be injected into).
    constructor(project, electron, logger = console, options = {}) {
        this.options = projectOptions(project, { url: options.url, projectId: options.projectId }); this.electron = electron;
        this.logger = logger;
        this.controlName = options.controlName || '__COCOS_GIT_DESK_PREVIEW_CONTROL__';
        this.engineVersions = options.engineVersions || ['3.8.x'];
        // persist: keeps localStorage, cookies and IndexedDB on disk, so the preview keeps its signed-in (or guest)
        // account across Creator restarts instead of starting as a new player every launch.
        this.partition = 'persist:cocos-git-desk-' + this.options.id;
        this.generation = 0; this.guest = null; this.listeners = new Set();
    }
    onEvent(listener) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    async bind(id) {
        const guest = this.electron.webContents.fromId(id);
        if (!guest || guest.isDestroyed() || guest.getType() !== 'webview' || guest.session !== this.electron.session.fromPartition(this.partition)
            || !guest.hostWebContents || !guest.hostWebContents.getURL().startsWith('file://')
            || !(guest.getURL() === 'about:blank' || allowedUrl(guest.getURL(),this.options.url))) throw Error('Not the dedicated preview page of this project');
        if (this.guest === guest) return;
        this.release(); this.inspector = new InspectorFrames(guest, { engineVersions: this.engineVersions }); this.guest = guest; this.guestId = guest.id; this.guestDebugger = guest.debugger; this.generation++;
        this.onMessage = (_event, method, params) => {
            if (this.guest !== guest || guest.isDestroyed() || !allowedUrl(guest.getURL(),this.options.url)) return;
            if (method === 'Page.frameNavigated' && !params?.frame?.parentId) this.generation++;
            for (const listener of this.listeners) {
                try { listener(method, params || {}); } catch (error) { this.logger.error('[Git Desk] Preview event listener failed: ' + String(error && error.message || error)); }
            }
        };
        this.onNavigate = (event, url) => { if (!allowedUrl(url,this.options.url)) event.preventDefault(); };
        this.onConsole = (_event, level, message, line, sourceId) => {
            if(this.guest !== guest || guest.isDestroyed() || !allowedUrl(guest.getURL(),this.options.url))return;
            const text = plainConsoleText(message);
            const method = consoleMethod(level, text);
            const source = typeof sourceId === 'string' && sourceId ? `\n    ${sourceId}${Number.isFinite(line)&&line>0?':'+line:''}` : '';
            (this.logger[method] || this.logger.log)('[Git Desk] '+text+source);
        };
        this.onDestroyed = () => this.release();
        guest.setWindowOpenHandler(() => ({action:'deny'}));
        guest.on('will-navigate',this.onNavigate); guest.on('will-redirect',this.onNavigate);
        guest.on('console-message',this.onConsole);
        guest.once('destroyed',this.onDestroyed);
        try {
            guest.debugger.attach('1.3'); guest.debugger.on('message',this.onMessage);
            for (const method of ['Runtime.enable','Log.enable','Network.enable','Page.enable']) {
                if (this.guest !== guest) throw Error('The preview panel was closed');
                await guest.debugger.sendCommand(method);
            }
            if (this.guest !== guest) throw Error('The preview panel was closed');
        } catch (error) { if (this.guest === guest) this.release(); throw error; }
    }
    inspectorFrames() { if(!this.inspector)throw notConnected();return this.inspector.list(); }
    inspectorCall(id,method,args) { if(!this.inspector)throw notConnected();return this.inspector.call(id,method,args); }
    status() {
        const guest = this.guest;
        return { present:!!guest && !guest.isDestroyed(), connected:!!guest && !guest.isDestroyed() && guest.debugger.isAttached() && allowedUrl(guest.getURL(),this.options.url),
            targetId:guest ? 'embedded-' + guest.id + '-' + this.generation : null, generation:this.generation };
    }
    // One CDP command against the current page; a page change during the call invalidates the result.
    async command(method, params = {}) {
        const guest = this.guest, state = this.status();
        if (!state.connected) throw Error('The embedded preview is not connected');
        const result = await guest.debugger.sendCommand(method, params);
        if (guest !== this.guest || !this.status().connected || state.targetId !== this.status().targetId) throw Error('The preview changed during the query');
        return result;
    }
    async evaluate(expression, { awaitPromise = true } = {}) {
        const response = await this.command('Runtime.evaluate', { expression, returnByValue: true, silent: true, awaitPromise });
        // CDP's description is "Error: message\n    at <anonymous>:7:48"; callers and the panel only need the message.
        if (response && response.exceptionDetails) throw Error(String(response.exceptionDetails.exception && response.exceptionDetails.exception.description || response.exceptionDetails.text || 'Page evaluation failed').split('\n')[0].replace(/^(Uncaught )?\w*Error: /, ''));
        return response && response.result ? response.result.value : undefined;
    }
    async screenshot() {
        const response = await this.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        if (!response || !response.data) throw Error('Screenshot failed');
        return Buffer.from(response.data, 'base64');
    }
    async pageStatus() {
        const state = this.status();
        if (!state.connected) return {...state,recording:null};
        const name = JSON.stringify(this.controlName);
        const value = await this.evaluate('window[' + name + '] ? window[' + name + '].status() : null', { awaitPromise: false });
        return {...state,recording:value || null};
    }
    // Layout of the preview page in CSS pixels, independent of the current zoom factor.
    async pageMetrics() {
        const state = this.status();
        if (!state.connected) return null;
        const value = await this.evaluate("(()=>{const g=document.querySelector('#GameDiv'),t=document.querySelector('.toolbar');return {width:g?g.offsetWidth:0,height:g?g.offsetHeight:0,toolbar:t?t.offsetHeight:0};})()", { awaitPromise: false });
        return value && Number.isFinite(value.width) && Number.isFinite(value.height) ? {width:value.width,height:value.height,toolbar:Number.isFinite(value.toolbar)?value.toolbar:0} : null;
    }
    release(id) {
        const guest = this.guest; if (!guest || id !== undefined && this.guestId !== id) return false;
        this.inspector?.close(); this.inspector=null;
        const debuggerSession = this.guestDebugger;
        this.guest = null; this.guestDebugger = null; this.guestId = undefined; this.generation++;
        guest.removeListener('will-navigate',this.onNavigate); guest.removeListener('will-redirect',this.onNavigate); guest.removeListener('destroyed',this.onDestroyed);
        guest.removeListener('console-message',this.onConsole);
        // The WebContents debugger getter throws after the destroyed event.
        debuggerSession.removeListener('message',this.onMessage);
        if (!guest.isDestroyed() && debuggerSession.isAttached()) debuggerSession.detach();
        return true;
    }
    async close() { this.release(); this.listeners.clear(); }
}
// Electron hands console-message the arguments joined, not printf-formatted. Game loggers that
// start with a DevTools format string ("%c%s…", "color:#…;") would otherwise show that verbatim.
const consoleFormat = /^(?:%[csdifoO])+[^\s]*\s+(?:(?:[a-z-]+\s*:\s*[^;]+;\s*)+)?/;
function plainConsoleText(message) {
    const text = String(message);
    return text.startsWith('%') ? text.replace(consoleFormat, '') : text;
}
// Some game loggers print every category through console.log with a bracketed tag such as
// [错误日志]; the tag decides the Creator console level so the console filters stay meaningful.
// Real warn/error levels win. Untagged lines keep their own level.
const tagLevels = { '错误日志': 'error', '警告日志': 'warn', '标准日志': 'log', '业务日志': 'log', '视图日志': 'log' };
const tagPattern = /^\s*(?:\[[^\]]{0,40}\]\s*)?\[([^\]]{1,12}日志)\]/;
function consoleMethod(level, text) {
    const base = level === 3 ? 'error' : level === 2 ? 'warn' : level === 0 ? 'debug' : 'log';
    if (level === 2 || level === 3) return base;
    const tag = tagPattern.exec(text)?.[1];
    return tag ? (tagLevels[tag] || 'info') : base;
}
module.exports = {EmbeddedPreview, allowedUrl, plainConsoleText, consoleMethod};
