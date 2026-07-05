export type CommandSource = "builtin" | "extension" | "prompt" | "skill";

export interface CommandEntry {
  name: string;
  description?: string;
  source: CommandSource;
  argHint?: string;
}

export function paletteQuery(composerText: string): string | undefined {
  if (!composerText.startsWith("/")) return undefined;
  const rest = composerText.slice(1);
  if (/[\s]/.test(rest)) return undefined;
  return rest;
}

export function matchCommands(commands: readonly CommandEntry[], query: string): CommandEntry[] {
  const needle = query.toLowerCase();
  const prefix: CommandEntry[] = [];
  const substring: CommandEntry[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(needle)) prefix.push(command);
    else if (name.includes(needle)) substring.push(command);
  }
  return [...prefix, ...substring];
}

export interface GroupedCommands {
  primary: CommandEntry[];
  skills: CommandEntry[];
}

export function groupCommands(matches: readonly CommandEntry[]): GroupedCommands {
  const primary: CommandEntry[] = [];
  const skills: CommandEntry[] = [];
  for (const command of matches) {
    (command.source === "skill" ? skills : primary).push(command);
  }
  return { primary, skills };
}

export type PaletteSelection = { kind: "execute"; text: string } | { kind: "insert"; text: string };

export function selectionFor(command: CommandEntry): PaletteSelection {
  const requiresArg = command.argHint?.startsWith("<") ?? false;
  if (command.source === "builtin" && !requiresArg) return { kind: "execute", text: `/${command.name}` };
  return { kind: "insert", text: `/${command.name} ` };
}

export function commandForText(commands: readonly CommandEntry[], trimmedText: string): CommandEntry | undefined {
  if (!trimmedText.startsWith("/")) return undefined;
  const invoked = trimmedText.slice(1).split(/\s/, 1)[0];
  if (!invoked) return undefined;
  return commands.find((command) => command.name === invoked);
}

export function parseFreshSessionCommand(trimmedText: string): boolean {
  return trimmedText === "/clear" || trimmedText === "/new";
}
