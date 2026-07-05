import type { Config } from "./config.js";
import type { ModelSnapshot, SessionHostDeps } from "./session-host.js";
export interface PiEnvironment {
    hostDeps: SessionHostDeps;
    listModels: () => ModelSnapshot[];
    workspaceRoot: string;
    warmup: () => Promise<void>;
}
export declare function createPiEnvironment(config: Config): PiEnvironment;
