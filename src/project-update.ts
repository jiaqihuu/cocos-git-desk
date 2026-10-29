import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { RepositoryUpdate, UpdatePhase } from './types';
import { t, has, MessageError } from './i18n';

export interface ProjectUpdatePreview {
    root: string;
    entries: { id: string; state: string; branch: string; detail: string; checks?: Record<string, string> }[];
    scripts: string;
}
export class ProjectUpdateStateChangedError extends Error {}
// The update scripts send structured messages ({id, params} or {join, items}, ids under `misc.update.`)
// next to an English `detail`; render them in the editor language and fall back to `detail` if malformed.
export function renderUpdateMessage(node: unknown, depth = 0): string {
    if (typeof node === 'string') return node;
    if (depth > 12 || !node || typeof node !== 'object' || Array.isArray(node)) throw new Error('invalid update message');
    const value = node as { id?: unknown; params?: unknown; join?: unknown; items?: unknown };
    if (value.join !== undefined) {
        if ((value.join !== 'lines' && value.join !== 'list') || !Array.isArray(value.items) || value.items.length > 200) throw new Error('invalid update message');
        return value.items.map(item => renderUpdateMessage(item, depth + 1)).join(value.join === 'lines' ? '\n  ' : t('misc.update.listSeparator'));
    }
    if (typeof value.id !== 'string' || !/^[A-Za-z][\w.]{0,80}$/.test(value.id) || !has('misc.update.' + value.id)) throw new Error('invalid update message');
    const params: Record<string, string> = {};
    if (value.params !== undefined) {
        if (!value.params || typeof value.params !== 'object' || Array.isArray(value.params)) throw new Error('invalid update message');
        for (const [key, item] of Object.entries(value.params)) params[key] = renderUpdateMessage(item, depth + 1);
    }
    return t('misc.update.' + value.id, params);
}
function localized(event: { detail?: unknown; message?: unknown }): string {
    if (event.message !== undefined) try { return renderUpdateMessage(event.message); } catch { /* keep the English detail */ }
    return String(event.detail);
}
function codes(value: unknown): string[] | undefined {
    return Array.isArray(value) && value.length <= 50 && value.every(code => typeof code === 'string' && /^\w{1,80}$/.test(code)) && value.length ? [...value] : undefined;
}
const runner = path.resolve(__dirname, '../scripts/project-update.py');
const source = path.resolve(__dirname, '../scripts/update_all_current_branches.py');
async function scriptVersion(): Promise<string> {
    const hash = createHash('sha256');
    for (const filename of [runner, source]) hash.update(await fs.readFile(filename));
    return hash.digest('hex');
}

async function invoke(root: string, cache: string, preview?: ProjectUpdatePreview, progress?: (row: RepositoryUpdate) => void, log?: (text: string) => void): Promise<ProjectUpdatePreview | undefined> {
    const temporary = path.join(cache, 'project-update');
    await fs.mkdir(temporary, { recursive: true });
    const environment = { ...process.env };
    for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_GRAFT_FILE', 'GIT_SHALLOW_FILE']) delete environment[key];
    for (const key of Object.keys(environment)) if (key.startsWith('PYTHON')) delete environment[key];
    return new Promise((resolve, reject) => {
        const child = spawn(process.env.COCOS_GIT_DESK_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-I', '-B', runner, '--repo', root, ...(preview ? ['--execute'] : [])], {
            cwd: path.dirname(runner), shell: false, windowsHide: true,
            env: { ...environment, PATH: process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || ''].join(path.delimiter) : process.env.PATH,
                GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_LITERAL_PATHSPECS: '1', GIT_DESK_TEMP: temporary,
                GIT_DESK_GIT: process.env.COCOS_GIT_DESK_GIT || 'git', PYTHONIOENCODING: 'utf-8', LC_ALL: 'C' },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let buffer = '', failure = '', stateChanged = false, stderr = '', result: ProjectUpdatePreview | undefined;
        const known = new Set(preview?.entries.map(entry => entry.id)), terminal = new Set<string>();
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', (value: string) => {
            buffer += value;
            if (buffer.length > 1024 * 1024) { failure = t('misc.update.outputOverLimit'); child.kill(); return; }
            let end: number;
            while ((end = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
                try {
                    const event = JSON.parse(line);
                    if (event.kind === 'error') { failure = localized(event).slice(0, 8000); stateChanged = event.code === 'PROJECT_UPDATE_STATE_CHANGED'; }
                    else if (event.kind === 'preview' && !preview) {
                        if (event.root !== root || !Array.isArray(event.entries) || !event.entries.length || event.entries.length > 200) throw new MessageError('misc.update.invalidScope');
                        const ids = new Set<string>();
                        for (const entry of event.entries) {
                            if (typeof entry.id !== 'string' || ids.has(entry.id) || typeof entry.state !== 'string' || (entry.state && !/^[a-f0-9]{64}$/.test(entry.state)) || typeof entry.branch !== 'string' || typeof entry.detail !== 'string') throw new MessageError('misc.update.invalidSnapshot');
                            if (entry.checks !== undefined && (!entry.checks || typeof entry.checks !== 'object' || Array.isArray(entry.checks) || Object.keys(entry.checks).length > 16 || Object.entries(entry.checks).some(([name, value]) => name.length > 80 || typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)))) throw new MessageError('misc.update.invalidChecks');
                            entry.detail = localized(entry).slice(0, 1000);
                            delete entry.message; delete entry.codes;
                            ids.add(entry.id);
                        }
                        result = { root, entries: event.entries, scripts: '' };
                    } else if (event.kind === 'progress' && preview) {
                        if (!known.has(event.id) || !['running', 'success', 'failed', 'skipped'].includes(event.status) || typeof event.phase !== 'string' || typeof event.detail !== 'string') throw new MessageError('misc.update.invalidProgress');
                        if (event.status !== 'running') terminal.add(event.id);
                        const phaseId = /^\w{1,40}$/.test(event.phase) && has('misc.update.phase.' + event.phase) ? event.phase as UpdatePhase : undefined;
                        progress?.({ id: event.id, status: event.status, phase: (phaseId ? t('misc.update.phase.' + phaseId) : event.phase).slice(0, 100), ...(phaseId ? { phaseId } : {}), detail: localized(event).slice(0, 1000), ...(codes(event.codes) ? { codes: codes(event.codes) } : {}), branch: typeof event.branch === 'string' ? event.branch.slice(0, 200) : undefined, head: typeof event.head === 'string' ? event.head : undefined });
                    } else throw new MessageError('misc.update.unknownEvent');
                } catch (error) { failure = error instanceof Error ? error.message : String(error); child.kill(); }
            }
        });
        child.stderr.on('data', (value: string) => { stderr = (stderr + value).slice(-8000); log?.(value); });
        child.stdin.on('error', error => { failure ||= t('misc.update.cannotSendSnapshot', { message: error.message }); });
        child.on('error', error => reject(new MessageError('misc.update.cannotStart', { message: error.message })));
        child.on('close', code => {
            if (preview && terminal.size !== known.size) failure ||= t('misc.update.endedEarly');
            if (failure || code !== 0 || buffer.trim() || (!preview && !result)) reject(stateChanged ? new ProjectUpdateStateChangedError(failure) : new Error(failure || t('misc.update.incomplete', { code, stderr })));
            else resolve(result);
        });
        child.stdin.end(preview ? JSON.stringify(preview) : '');
    });
}
export async function previewProjectUpdate(root: string, cache: string): Promise<ProjectUpdatePreview> {
    const scripts = await scriptVersion(), result = await invoke(root, cache);
    if (!result || scripts !== await scriptVersion()) throw new MessageError('misc.update.scriptsChangedDuringPreview');
    return { ...result, scripts };
}
export async function executeProjectUpdate(preview: ProjectUpdatePreview, cache: string, progress: (row: RepositoryUpdate) => void, log: (text: string) => void): Promise<void> {
    if (preview.scripts !== await scriptVersion()) throw new MessageError('misc.update.scriptsChanged');
    await invoke(preview.root, cache, preview, progress, log);
}
