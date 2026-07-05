export type ConfigureHttpDispatcher = (timeoutMs?: number) => void;
export declare function applyHttpIdleTimeout(timeoutMs: number, configure?: ConfigureHttpDispatcher): void;
export declare function formatHttpIdleTimeout(timeoutMs: number): string;
