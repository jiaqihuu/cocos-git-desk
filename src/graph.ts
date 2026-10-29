import { Commit } from './types';

export interface GraphEdge { from: number; to: number; parent?: string; }
export interface GraphRow { column: number; incoming: boolean; width: number; edges: GraphEdge[]; }
export interface CommitGraph { rows: GraphRow[]; pending: string[]; width: number; }

// Replaying the same topological prefix gives identical lanes on every page.
export function layoutGraph(commits: Pick<Commit, 'sha' | 'parents'>[]): CommitGraph {
    const rows: GraphRow[] = [];
    let lanes: string[] = [], width = 1;
    for (const commit of commits) {
        let column = lanes.indexOf(commit.sha);
        const incoming = column >= 0;
        if (!incoming) { column = lanes.length; lanes.push(commit.sha); }
        const before = [...lanes], after = lanes.filter(sha => sha !== commit.sha);
        const parents = [...new Set(commit.parents)];
        let insertion = Math.min(column, after.length);
        for (const parent of parents) {
            if (!after.includes(parent)) after.splice(insertion++, 0, parent);
        }
        const edges: GraphEdge[] = before.flatMap((sha, from) => sha === commit.sha ? [] : [{ from, to: after.indexOf(sha) }]);
        for (const parent of parents) edges.push({ from: column, to: after.indexOf(parent), parent });
        const rowWidth = Math.max(before.length, after.length, 1);
        rows.push({ column, incoming, edges, width: rowWidth });
        width = Math.max(width, rowWidth); lanes = after;
    }
    return { rows, pending: lanes, width };
}
