export interface EmbeddedOptions { url?: string | null; projectId?: string; controlName?: string; engineVersions?: readonly string[] }
export class EmbeddedPreview {
    constructor(project: string, electron: unknown, logger?: Pick<Console,'log'|'debug'|'warn'|'error'|'info'>, options?: EmbeddedOptions);
    partition: string;
    controlName: string;
    engineVersions: readonly string[];
    options: {url: string; root: string; id: string; port: number; profile: string};
    onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void;
    bind(id: number): Promise<void>;
    release(id?: number): boolean;
    status(): {present: boolean; connected: boolean; targetId: string | null; generation: number};
    inspectorFrames(): unknown;
    inspectorCall(id:string,method:string,args:unknown[]): Promise<unknown>;
    command(method: string, params?: Record<string, unknown>): Promise<unknown>;
    evaluate(expression: string, options?: {awaitPromise?: boolean}): Promise<unknown>;
    screenshot(): Promise<Buffer>;
    pageStatus(): Promise<unknown>;
    pageMetrics(): Promise<{width:number;height:number;toolbar:number}|null>;
    close(): Promise<void>;
}
export function allowedUrl(value: string, expected: string): boolean;
export function plainConsoleText(message: unknown): string;
export function consoleMethod(level: number, text: string): string;
