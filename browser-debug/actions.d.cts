export interface ClientOptions { clients?: string[]; python?: string; backupRoot?: string }
export interface ClientResult { written: string[]; skills: string[]; snippets: { codex: string; claudeCode: string } }
export function openBrowser(project: string, options?: { url?: string | null; projectId?: string }): Promise<string>;
export function configureClients(project: string, options?: ClientOptions): ClientResult;
export function clientsConfigured(project: string, options?: ClientOptions): boolean;
export function waitForPreview(options: {port: number; url: string}, readTargets?: (port: number) => Promise<unknown>, attempts?: number, pause?: () => Promise<void>): Promise<void>;
