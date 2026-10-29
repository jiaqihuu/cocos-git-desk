'use strict';
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { projectOptions, configureClients, clientsConfigured, browserCandidates, browserArgs } = require('./setup.cjs');
function targets(port) {
    return new Promise(resolve => {
        let settled = false;
        const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
        const timer = setTimeout(() => { finish(null); req.destroy(); }, 1000);
        const req = http.get({ hostname: '127.0.0.1', port, path: '/json/list' }, response => {
            let data = '';
            response.on('data', chunk => { data += chunk; if (data.length > 1024 * 1024) { finish(null); req.destroy(); } });
            response.on('end', () => { try { finish(JSON.parse(data)); } catch { finish(null); } });
            response.on('error', () => finish(null));
            response.on('aborted', () => finish(null));
        });
        req.on('error', () => finish(null));
    });
}
async function waitForPreview(options, readTargets = targets, attempts = 12, pause = () => new Promise(resolve => setTimeout(resolve, 250))) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        const tabs = await readTargets(options.port);
        if (Array.isArray(tabs) && tabs.some(tab => tab.type === 'page' && tab.url === options.url)) return;
        if (attempt + 1 < attempts) await pause();
    }
    throw Error('The browser started but has not connected to the preview page yet. Make sure the Creator preview server is running, then retry.');
}
let opening;
// The external browser is a convenience for full DevTools; AI tools only observe the embedded preview.
async function openBrowser(project, options = {}) {
    if (opening) return opening;
    opening = (async () => {
        const resolved = projectOptions(project, options);
        const existing = await targets(resolved.port);
        if (Array.isArray(existing)) {
            if (existing.some(tab => tab.type === 'page' && tab.url === resolved.url)) return 'The debug page is already open; switch to the debug browser.';
            throw Error('The debugging port is used by another page; close that debug browser and retry.');
        }
        const binary = browserCandidates().find(file => fs.existsSync(file));
        if (!binary) throw Error('Chrome or Edge was not found. The page debug panel of the ordinary Preview still works.');
        fs.mkdirSync(resolved.profile, { recursive: true });
        await new Promise((resolve, reject) => {
            const child = spawn(binary, browserArgs(resolved), { detached: true, stdio: 'ignore', shell: false });
            child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
        });
        await waitForPreview(resolved);
        return 'Opened the preview browser; the in-page debug panel still works there, AI tools only observe the embedded preview.';
    })();
    try { return await opening; } finally { opening = undefined; }
}
module.exports = { openBrowser, configureClients, clientsConfigured, waitForPreview };
