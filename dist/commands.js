export const REMOTE_EXECUTABLE_ENGINE_BUILTINS = new Set(["compact"]);
const ENGINE_BUILTIN_ARG_HINTS = {
    compact: "[instructions]",
};
export const CLEAR_COMMAND = {
    name: "clear",
    description: "Start a fresh session in this workspace (this one stays in the session list)",
    source: "builtin",
};
export const NEW_COMMAND = {
    name: "new",
    description: "Start a fresh session in this workspace (alias of /clear)",
    source: "builtin",
};
export const MODEL_COMMAND = {
    name: "model",
    description: "Switch model — bare /model opens the picker, /model <pattern> matches by name",
    source: "builtin",
    argHint: "[pattern]",
};
export const NAME_COMMAND = {
    name: "name",
    description: "Rename this session",
    source: "builtin",
    argHint: "<title>",
};
const REMOTE_BUILTIN_COMMANDS = [CLEAR_COMMAND, NEW_COMMAND, MODEL_COMMAND, NAME_COMMAND];
export function collectCommands(sources) {
    const ordered = [
        ...sources.engineBuiltins
            .filter((b) => REMOTE_EXECUTABLE_ENGINE_BUILTINS.has(b.name))
            .map((b) => ({
            name: b.name,
            description: b.description,
            source: "builtin",
            ...(ENGINE_BUILTIN_ARG_HINTS[b.name] ? { argHint: ENGINE_BUILTIN_ARG_HINTS[b.name] } : {}),
        })),
        ...REMOTE_BUILTIN_COMMANDS,
        ...sources.extensionCommands.map((c) => ({
            name: c.invocationName,
            description: c.description,
            source: "extension",
        })),
        ...sources.promptTemplates.map((t) => ({ name: t.name, description: t.description, source: "prompt" })),
        ...sources.skills.map((s) => ({ name: `skill:${s.name}`, description: s.description, source: "skill" })),
    ];
    const seen = new Set();
    return ordered.filter((command) => {
        if (seen.has(command.name))
            return false;
        seen.add(command.name);
        return true;
    });
}
//# sourceMappingURL=commands.js.map