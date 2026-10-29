import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import type { RepositoryUpdate, Task } from './types';
import { t, MessageError } from './i18n';

const limit = 2 * 1024 * 1024;

export function updateResultTime(task: Task): { timestamp: string; label: string } {
    const timestamp = task.finishedAt || task.startedAt;
    if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return { timestamp: '', label: '' };
    const value = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).format(new Date(timestamp));
    return { timestamp, label: t(task.status === 'running' ? 'misc.results.startedAt' : task.status === 'success' ? 'misc.results.finishedAt' : 'misc.results.endedAt', { time: value }) };
}

// Rows compare by phaseId; results saved without it (older versions) compare by the displayed text.
const isPhase = (row: RepositoryUpdate, id: 'stopped' | 'notRun') => row.phaseId ? row.phaseId === id : row.phase === t('misc.update.phase.' + id);
/** Shows legacy pre-flight failures (saved before rows were marked unstarted) as unstarted repositories. */
export function updateResultForDisplay(task: Task): Task {
    const rows = task.repositories;
    if (task.status !== 'failed' || !(task.kind === 'updateAll' || task.title === t('git.updateAllTitle')) || !rows?.length
        || !rows.every(row => row.status === 'failed' && isPhase(row, 'stopped') && row.detail === t('git.repoChangedAfterPreview'))) return task;
    return { ...task, recovery: 'repreview', repositories: rows.map(row => ({ ...row, status: 'skipped', phase: t('misc.update.phase.notRun'), phaseId: 'notRun', detail: t('misc.results.stalePreviewAborted') })) };
}

export function updateResultCounts(rows: NonNullable<Task['repositories']>): string {
    return t('misc.results.counts', {
        success: rows.filter(row => row.status === 'success').length,
        failed: rows.filter(row => row.status === 'failed').length,
        skipped: rows.filter(row => row.status === 'skipped' && !isPhase(row, 'notRun')).length,
        notRun: rows.filter(row => row.status === 'skipped' && isPhase(row, 'notRun')).length,
    });
}

function isResult(value: unknown): value is Task {
    if (!value || typeof value !== 'object') return false;
    const task = value as Record<string, unknown>;
    return (task.recovery === undefined || task.recovery === 'repreview') && typeof task.id === 'string' && typeof task.title === 'string' && typeof task.log === 'string'
        && (task.status === 'success' || task.status === 'failed')
        && typeof task.startedAt === 'string' && Number.isFinite(Date.parse(task.startedAt))
        && typeof task.finishedAt === 'string' && Number.isFinite(Date.parse(task.finishedAt))
        && Array.isArray(task.repositories) && task.repositories.length <= 200 && task.repositories.every(row =>
            row && typeof row === 'object' && typeof row.id === 'string' && typeof row.phase === 'string'
            && typeof row.detail === 'string' && ['queued', 'running', 'success', 'failed', 'skipped'].includes(row.status)
            && (row.branch === undefined || typeof row.branch === 'string') && (row.head === undefined || typeof row.head === 'string')
            && (row.phaseId === undefined || typeof row.phaseId === 'string') && (row.codes === undefined || (Array.isArray(row.codes) && row.codes.every((code: unknown) => typeof code === 'string'))))
        && (task.kind === undefined || task.kind === 'updateAll');
}

export class UpdateResultStore {
    private readonly filename: string;
    private readonly project: string;

    constructor(cache: string, project: string) {
        this.project = path.resolve(project);
        const key = createHash('sha256').update(this.project).digest('hex');
        this.filename = path.join(cache, 'update-results', key + '.json');
    }

    read(): Task | undefined {
        try {
            if (fs.statSync(this.filename).size > limit) throw new MessageError('misc.results.tooLarge');
            const saved = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
            if (saved?.version !== 1 || saved.project !== this.project || !isResult(saved.task)) throw new MessageError('misc.results.invalidFormat');
            return saved.task;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(t('misc.results.cannotRead'), error);
            return undefined;
        }
    }

    save(task: Task): boolean {
        const temporary = this.filename + '.' + randomUUID() + '.tmp';
        try {
            if (!isResult(task)) throw new MessageError('misc.results.onlyFinished');
            const content = JSON.stringify({ version: 1, project: this.project, task });
            if (Buffer.byteLength(content) > limit) throw new MessageError('misc.results.tooLarge');
            fs.mkdirSync(path.dirname(this.filename), { recursive: true });
            fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            fs.renameSync(temporary, this.filename);
            return true;
        } catch (error) {
            console.warn(t('misc.results.cannotSave'), error);
            return false;
        } finally {
            try { fs.unlinkSync(temporary); } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(t('misc.results.cannotCleanTemp'), error);
            }
        }
    }
}
