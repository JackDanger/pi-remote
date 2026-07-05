import type { CommandInfo } from "./session-host.js";
export interface NamedDescribed {
    name: string;
    description?: string;
}
export interface CommandSources {
    engineBuiltins: ReadonlyArray<{
        name: string;
        description: string;
    }>;
    extensionCommands: ReadonlyArray<{
        invocationName: string;
        description?: string;
    }>;
    promptTemplates: ReadonlyArray<NamedDescribed>;
    skills: ReadonlyArray<NamedDescribed>;
}
export declare const REMOTE_EXECUTABLE_ENGINE_BUILTINS: ReadonlySet<string>;
export declare const CLEAR_COMMAND: CommandInfo;
export declare const NEW_COMMAND: CommandInfo;
export declare const MODEL_COMMAND: CommandInfo;
export declare const NAME_COMMAND: CommandInfo;
export declare function collectCommands(sources: CommandSources): CommandInfo[];
