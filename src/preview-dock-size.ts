interface Split {
    parent: HTMLElement;
    children: HTMLElement[];
    direction: string;
    ratios: number[];
}
function parentOf(node: HTMLElement): HTMLElement | null {
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode();
    return root instanceof ShadowRoot && root.host instanceof HTMLElement ? root.host : null;
}
export function readSplits(root: HTMLElement): Split[] {
    const splits: Split[] = [];
    for (let node: HTMLElement | null = root; node; node = parentOf(node)) {
        if (node.tagName !== 'DOCK-LAYOUT') continue;
        const parent = node.parentElement;
        if (!parent || parent.tagName !== 'DOCK-LAYOUT') continue;
        const direction = parent.getAttribute('direction');
        if (direction !== 'row' && direction !== 'column') continue;
        const children = Array.from(parent.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child.tagName === 'DOCK-LAYOUT');
        if (children.length < 2 || children.some(child => child.hasAttribute('minimize'))) continue;
        const sizes = children.map(child => direction === 'row' ? child.getBoundingClientRect().width : child.getBoundingClientRect().height);
        const total = sizes.reduce((sum, size) => sum + size, 0);
        if (sizes.some(size => size <= 0) || !Number.isFinite(total)) continue;
        splits.push({parent, children, direction, ratios:sizes.map(size => size / total)});
    }
    return splits;
}
export function restoreSplits(saved: Split[], current: Split[]): boolean {
    if (!saved.length || saved.length !== current.length || saved.some((split, index) => {
        const now = current[index]!;
        return split.parent !== now.parent || split.direction !== now.direction || split.children.length !== now.children.length
            || split.children.some((child, i) => child !== now.children[i]);
    })) return false;
    // Only resize existing containers. Layout.apply destroys the embedded webview.
    for (const split of [...saved].reverse()) split.children.forEach((child, index) => {
        child.style.flex = `${split.ratios[index]} 1 0%`;
    });
    return true;
}
export class PreviewDockSize {
    private saved: Split[] = [];
    private visible = false;
    private closed = false;
    private frame?: number;
    private dragging = false;
    private restoring = false;
    private readonly window: Window;
    constructor(private root: HTMLElement) {
        this.window = root.ownerDocument.defaultView!;
        root.ownerDocument.addEventListener('pointerdown', this.down, true);
        root.ownerDocument.addEventListener('pointerup', this.up, true);
    }
    private down = (event: PointerEvent): void => {
        this.dragging = this.visible && event.composedPath().some(node => node instanceof HTMLElement && node.tagName === 'DOCK-RESIZE');
        if (this.dragging) this.cancelFrame();
    };
    private up = (): void => {
        if (!this.dragging) return;
        this.dragging = false;
        if (this.frame !== undefined) this.window.cancelAnimationFrame(this.frame);
        this.frame = this.window.requestAnimationFrame(() => {
            this.frame = undefined;
            if (!this.closed && this.visible) this.saved = readSplits(this.root);
        });
    };
    private cancelFrame(): void {
        if (this.frame !== undefined) this.window.cancelAnimationFrame(this.frame);
        this.frame = undefined;
        this.restoring = false;
    }
    show(): void {
        if (this.closed || this.visible) return;
        this.visible = true;
        this.restoring = true;
        // Creator emits show before updating dock constraints and flex values.
        // Restore after that update, without rebuilding the panel/webview.
        this.frame = this.window.requestAnimationFrame(() => {
            this.frame = this.window.requestAnimationFrame(() => {
                this.frame = undefined;
                if (this.closed || !this.visible) return;
                const current = readSplits(this.root);
                if (!restoreSplits(this.saved, current)) this.saved = current;
                this.restoring = false;
            });
        });
    }
    hide(): void {
        if (this.closed || !this.visible) return;
        // A rapid tab switch must not save another tab's geometry while restore
        // is pending. Normal hide still reads the shared, nonzero dock bounds.
        if (!this.restoring) {
            const current = readSplits(this.root);
            if (current.length) this.saved = current;
        }
        this.cancelFrame();
        this.visible = false;
        this.dragging = false;
    }
    close(): void {
        this.closed = true;
        this.cancelFrame();
        this.root.ownerDocument.removeEventListener('pointerdown', this.down, true);
        this.root.ownerDocument.removeEventListener('pointerup', this.up, true);
        this.saved = [];
    }
}
