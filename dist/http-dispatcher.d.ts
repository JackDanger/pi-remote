export interface HttpDispatcherModule {
    configureHttpDispatcher: (timeoutMs?: number) => void;
}
export declare function resolveHttpDispatcherModulePath(): string;
export declare function loadHttpDispatcherModule(): Promise<HttpDispatcherModule>;
export declare function applyHttpIdleTimeout(timeoutMs: number, load?: () => Promise<HttpDispatcherModule>): Promise<void>;
export declare function formatHttpIdleTimeout(timeoutMs: number): string;
