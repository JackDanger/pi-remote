export interface CompactCommand {
  instructions?: string;
}

export function parseCompactCommand(trimmedText: string): CompactCommand | undefined {
  if (trimmedText === "/compact") return {};
  if (!trimmedText.startsWith("/compact ")) return undefined;
  const instructions = trimmedText.slice("/compact ".length).trim();
  return instructions ? { instructions } : {};
}

export type CompactGate = { allowed: true } | { allowed: false; reason: string };

export function gateCompact(streaming: boolean, compacting: boolean): CompactGate {
  if (streaming) return { allowed: false, reason: "finish or stop the current turn first" };
  if (compacting) return { allowed: false, reason: "already compacting" };
  return { allowed: true };
}
