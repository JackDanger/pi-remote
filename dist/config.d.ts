export interface ModelRef {
    provider: string;
    modelId: string;
}
export interface Config {
    host: string;
    port: number;
    workspaceRoot: string;
    agentDir?: string;
    defaultModel?: ModelRef;
    shutdownGraceMs: number;
    telemetry: boolean;
    httpIdleTimeoutMs: number;
}
export declare const DEFAULT_SHUTDOWN_GRACE_MS = 120000;
export declare const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 1800000;
export declare function parseModelRef(value: string): ModelRef;
export declare function expandTilde(p: string): string;
export declare function parseHttpIdleTimeoutMs(value: string | number, source: string): number;
export declare function defaultConfigPath(env?: NodeJS.ProcessEnv): string;
export declare function loadConfig(env?: NodeJS.ProcessEnv): Config;
