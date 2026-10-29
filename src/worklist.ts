import { Action, ChangedFile, Plan } from './types';

export function canApplyIndexPlan(action: Action, selected: readonly string[], plan: Plan): boolean {
    if ((action !== 'stage' && action !== 'unstage') || plan.directIndexAction !== action || plan.warnings.length || plan.patch || !selected.length || plan.expiresAt <= Date.now()) return false;
    const paths = new Set(selected);
    return paths.size === selected.length && plan.paths.length === paths.size && new Set(plan.paths).size === paths.size && plan.paths.every(name => paths.has(name));
}

export type WorkingArea = 'worktree' | 'index' | 'conflict';
export interface WorkingFilter {
    text: string;
    area: 'all' | WorkingArea;
    status: 'all' | 'modified' | 'added' | 'deleted' | 'renamed' | 'type' | 'untracked' | 'conflict';
    kind: 'all' | 'files' | 'meta' | 'submodules';
}
export interface WorkingRow { key: string; area: WorkingArea; file: ChangedFile; selectable: boolean; }

export function contextSelection(rows: readonly WorkingRow[], selected: ReadonlySet<string>, key: string): Set<string> {
    const target = rows.find(row => row.key === key);
    if (!target?.selectable) return new Set();
    return selected.has(key) ? new Set(selected) : new Set([key]);
}

export function selectedWholeFiles(rows: readonly WorkingRow[], selected: ReadonlySet<string>): string[] {
    return [...new Set(rows.filter(row => row.selectable && !row.file.conflict && !row.file.submodule && selected.has(row.key)).map(row => row.file.path))];
}

export function workingRows(files: readonly ChangedFile[], allowPointers: boolean): WorkingRow[] {
    const rows: WorkingRow[] = [];
    for (const file of files) {
        if (file.conflict) {
            rows.push({ key: 'conflict:' + file.path, area: 'conflict', file, selectable: false });
            continue;
        }
        const selectable = !file.submodule || allowPointers;
        if (file.worktree !== ' ') rows.push({ key: 'worktree:' + file.path, area: 'worktree', file, selectable });
        if (file.index !== ' ' && file.index !== '?') rows.push({ key: 'index:' + file.path, area: 'index', file, selectable });
    }
    return rows;
}

export function filterWorkingRows(rows: readonly WorkingRow[], filter: WorkingFilter): WorkingRow[] {
    const text = filter.text.toLowerCase();
    return rows.filter(row => {
        const file = row.file;
        if (filter.area !== 'all' && row.area !== filter.area) return false;
        if (!file.path.toLowerCase().includes(text) && !file.oldPath?.toLowerCase().includes(text)) return false;
        const meta = !file.submodule && file.path.endsWith('.meta');
        if (filter.kind === 'files' && (file.submodule || meta)) return false;
        if (filter.kind === 'meta' && !meta) return false;
        if (filter.kind === 'submodules' && !file.submodule) return false;
        if (row.area === 'conflict') return filter.status === 'all' || filter.status === 'conflict';
        const status = row.area === 'worktree' ? file.worktree : file.index;
        switch (filter.status) {
            case 'all': return true;
            case 'modified': return status === 'M';
            case 'added': return status === 'A';
            case 'deleted': return status === 'D';
            case 'renamed': return status === 'R' || status === 'C';
            case 'type': return status === 'T';
            case 'untracked': return status === '?';
            case 'conflict': return false;
        }
    });
}

export function reconcileSelection(selected: ReadonlySet<string>, rows: readonly WorkingRow[]): Set<string> {
    const valid = new Set(rows.filter(row => row.selectable).map(row => row.key));
    return new Set([...selected].filter(key => valid.has(key)));
}

export function selectVisible(selected: ReadonlySet<string>, visible: readonly WorkingRow[], checked: boolean): Set<string> {
    const result = new Set(selected);
    for (const row of visible) {
        if (row.selectable) {
            if (checked) result.add(row.key);
            else result.delete(row.key);
        }
    }
    return result;
}

export function selectedPaths(visible: readonly WorkingRow[], selected: ReadonlySet<string>, area: 'worktree' | 'index'): string[] {
    return [...new Set(visible.filter(row => row.area === area && row.selectable && selected.has(row.key)).map(row => row.file.path))];
}
