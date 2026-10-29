import { t } from './i18n';
// Compares the running game's UI layout (runtime_inspector_layout rows) with design measurements, for
// example boxes read from Lanhu, so a review reports deltas per element instead of eyeballing screenshots.
export interface DesignItem { name: string; x: number; y: number; width: number; height: number; text?: string; fontSize?: number; color?: string; }
export interface RuntimeItem { uuid?: string; name: string; path: string; x: number; y: number; width: number; height: number; text?: string; fontSize?: number; color?: string; depth?: number; kind?: string; }
export interface CompareOptions { tolerance?: number; scale?: number; offsetX?: number; offsetY?: number; matchBy?: 'name' | 'path'; ignoreCase?: boolean; }
export interface LayoutMatch { design: string; runtime: string; path: string; how: 'exact' | 'case' | 'contains' | 'nearest'; expected: { x: number; y: number; width: number; height: number }; actual: { x: number; y: number; width: number; height: number }; dx: number; dy: number; dw: number; dh: number; within: boolean; text?: { design: string; runtime: string; same: boolean }; fontSize?: { design: number; runtime: number; same: boolean }; color?: { design: string; runtime: string; same: boolean }; }
export interface LayoutComparison { tolerance: number; scale: number; matched: LayoutMatch[]; offTolerance: LayoutMatch[]; unmatchedDesign: string[]; unmatchedRuntime: { name: string; path: string }[]; summary: { designItems: number; runtimeNodes: number; matched: number; withinTolerance: number; offTolerance: number; textMismatches: number }; note: string; }

const round = (value: number) => Math.round(value * 10) / 10;
const normalizeColor = (value: string) => { const text = value.trim().toLowerCase().replace(/^#/, ''); const hex = /^[0-9a-f]{3}$/.test(text) ? text.split('').map(c => c + c).join('') : text; return /^[0-9a-f]{6}([0-9a-f]{2})?$/.test(hex) ? '#' + (hex.length === 8 && hex.endsWith('ff') ? hex.slice(0, 6) : hex) : value.trim().toLowerCase(); };

export function compareLayout(runtime: RuntimeItem[], design: DesignItem[], options: CompareOptions = {}): LayoutComparison {
    const tolerance = Math.max(0, options.tolerance ?? 2), scale = options.scale && options.scale > 0 ? options.scale : 1, offsetX = options.offsetX ?? 0, offsetY = options.offsetY ?? 0;
    const matchBy = options.matchBy === 'path' ? 'path' : 'name', ignoreCase = options.ignoreCase !== false;
    const fold = (value: string) => ignoreCase ? value.trim().toLowerCase() : value.trim();
    const key = (item: RuntimeItem) => matchBy === 'path' ? item.path : item.name;
    const used = new Set<number>();
    const matched: LayoutMatch[] = [], unmatchedDesign: string[] = [];
    const expectedOf = (item: DesignItem) => ({ x: item.x * scale + offsetX, y: item.y * scale + offsetY, width: item.width * scale, height: item.height * scale });
    const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
    for (const item of design) {
        const expected = expectedOf(item);
        const candidates = (test: (value: string) => boolean) => runtime.map((node, index) => ({ node, index })).filter(({ node, index }) => !used.has(index) && test(key(node)));
        let how: LayoutMatch['how'] = 'exact';
        let found = candidates(value => value.trim() === item.name.trim());
        if (!found.length && ignoreCase) { found = candidates(value => fold(value) === fold(item.name)); how = 'case'; }
        if (!found.length) { const needle = fold(item.name); found = candidates(value => needle.length >= 3 && (fold(value).includes(needle) || needle.includes(fold(value)))); how = 'contains'; if (found.length > 1) found = []; }
        if (!found.length) { unmatchedDesign.push(item.name); continue; }
        if (found.length > 1) { found.sort((a, b) => distance(a.node, expected) - distance(b.node, expected)); how = 'nearest'; }
        const { node, index } = found[0]!;
        used.add(index);
        const dx = round(node.x - expected.x), dy = round(node.y - expected.y), dw = round(node.width - expected.width), dh = round(node.height - expected.height);
        const match: LayoutMatch = { design: item.name, runtime: node.name, path: node.path, how, expected: { x: round(expected.x), y: round(expected.y), width: round(expected.width), height: round(expected.height) }, actual: { x: round(node.x), y: round(node.y), width: round(node.width), height: round(node.height) }, dx, dy, dw, dh, within: [dx, dy, dw, dh].every(value => Math.abs(value) <= tolerance) };
        if (item.text !== undefined && node.text !== undefined) match.text = { design: item.text, runtime: node.text, same: item.text.trim() === node.text.trim() };
        if (item.fontSize !== undefined && node.fontSize !== undefined) match.fontSize = { design: round(item.fontSize * scale), runtime: node.fontSize, same: Math.abs(item.fontSize * scale - node.fontSize) <= 0.5 };
        if (item.color !== undefined && node.color !== undefined) match.color = { design: item.color, runtime: node.color, same: normalizeColor(item.color) === normalizeColor(node.color) };
        matched.push(match);
    }
    const unmatchedRuntime = runtime.filter((node, index) => !used.has(index) && node.width > 0 && node.height > 0).map(node => ({ name: node.name, path: node.path }));
    const offTolerance = matched.filter(item => !item.within);
    return { tolerance, scale, matched, offTolerance, unmatchedDesign, unmatchedRuntime,
        summary: { designItems: design.length, runtimeNodes: runtime.length, matched: matched.length, withinTolerance: matched.length - offTolerance.length, offTolerance: offTolerance.length, textMismatches: matched.filter(item => item.text && !item.text.same).length },
        note: t('inspector.layoutCompareNote') };
}
