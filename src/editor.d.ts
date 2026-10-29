// Signatures checked against Creator 3.8.8's installed editor and message declarations.
declare namespace Editor {
    namespace Project { const path: string; }
    namespace Panel {
        function open(name: string): Promise<boolean>;
        function close(name: string): Promise<void>;
        function has(name: string): Promise<boolean>;
        function openBeside(anchor: string, name: string): Promise<boolean>;
        function focus(name: string): Promise<boolean>;
    }
    namespace Dialog {
        function warn(message: string, options?: { title?: string; detail?: string; buttons?: string[]; default?: number; cancel?: number }): Promise<{ response: number; checkboxChecked: boolean }>;
    }
    namespace Message {
        function request<T = unknown>(name: string, message: string, ...args: unknown[]): Promise<T>;
        function broadcast(message: string, ...args: unknown[]): void;
        function addBroadcastListener(message: string, listener: (...args: unknown[]) => void): void;
        function removeBroadcastListener(message: string, listener: (...args: unknown[]) => void): void;
    }
    namespace Selection {
        function update(type: 'asset' | 'node', ids: string[]): void;
        function getSelected(type: 'asset' | 'node'): string[];
    }
    namespace Profile {
        function getConfig(pkg: string, key?: string, type?: string): Promise<unknown>;
    }
}
declare namespace Editor {
    namespace I18n {
        function t(key: string, obj?: Record<string, unknown>): string;
        function getLanguage(): string;
    }
}
