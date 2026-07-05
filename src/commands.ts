import type { CommandInfo } from "./session-host.js";

export interface NamedDescribed {
  name: string;
  description?: string;
}

export interface CommandSources {
  engineBuiltins: ReadonlyArray<{ name: string; description: string }>;
  extensionCommands: ReadonlyArray<{ invocationName: string; description?: string }>;
  promptTemplates: ReadonlyArray<NamedDescribed>;
  skills: ReadonlyArray<NamedDescribed>;
}

export const REMOTE_EXECUTABLE_ENGINE_BUILTINS: ReadonlySet<string> = new Set(["compact"]);

const ENGINE_BUILTIN_ARG_HINTS: Record<string, string> = {
  compact: "[instructions]",
};

export const CLEAR_COMMAND: CommandInfo = {
  name: "clear",
  description: "Start a fresh session in this workspace (this one stays in the session list)",
  source: "builtin",
};

export const NEW_COMMAND: CommandInfo = {
  name: "new",
  description: "Start a fresh session in this workspace (alias of /clear)",
  source: "builtin",
};

export const MODEL_COMMAND: CommandInfo = {
  name: "model",
  description: "Switch model — bare /model opens the picker, /model <pattern> matches by name",
  source: "builtin",
  argHint: "[pattern]",
};

export const NAME_COMMAND: CommandInfo = {
  name: "name",
  description: "Rename this session",
  source: "builtin",
  argHint: "<title>",
};

const REMOTE_BUILTIN_COMMANDS: readonly CommandInfo[] = [CLEAR_COMMAND, NEW_COMMAND, MODEL_COMMAND, NAME_COMMAND];

export function collectCommands(sources: CommandSources): CommandInfo[] {
  const ordered: CommandInfo[] = [
    ...sources.engineBuiltins
      .filter((b) => REMOTE_EXECUTABLE_ENGINE_BUILTINS.has(b.name))
      .map((b) => ({
        name: b.name,
        description: b.description,
        source: "builtin" as const,
        ...(ENGINE_BUILTIN_ARG_HINTS[b.name] ? { argHint: ENGINE_BUILTIN_ARG_HINTS[b.name] } : {}),
      })),
    ...REMOTE_BUILTIN_COMMANDS,
    ...sources.extensionCommands.map((c) => ({
      name: c.invocationName,
      description: c.description,
      source: "extension" as const,
    })),
    ...sources.promptTemplates.map((t) => ({ name: t.name, description: t.description, source: "prompt" as const })),
    ...sources.skills.map((s) => ({ name: `skill:${s.name}`, description: s.description, source: "skill" as const })),
  ];
  const seen = new Set<string>();
  return ordered.filter((command) => {
    if (seen.has(command.name)) return false;
    seen.add(command.name);
    return true;
  });
}
