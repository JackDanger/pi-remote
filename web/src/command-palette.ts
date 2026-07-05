export type CommandSource = "builtin" | "extension" | "prompt" | "skill";

export interface CommandEntry {
  name: string;
  description?: string;
  source: CommandSource;
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

export function insertionFor(command: CommandEntry): string {
  return `/${command.name} `;
}

export function parseClearCommand(trimmedText: string): boolean {
  return trimmedText === "/clear";
}
