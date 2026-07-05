import http from "node:http";
import type { ModelSnapshot, SessionHost } from "./session-host.js";
import { type TelemetrySnapshot } from "./protocol.js";
export interface ServerOptions {
    host: string;
    port: number;
    sessionHost: SessionHost;
    listModels: () => ModelSnapshot[];
    workspaceRoot: string;
    webRoot: string;
    renderMetrics?: () => string;
    latestTelemetry?: (sessionId: string) => TelemetrySnapshot | undefined;
}
export declare function cacheControlFor(filePath: string): string;
export declare function startServer(options: ServerOptions): http.Server;
