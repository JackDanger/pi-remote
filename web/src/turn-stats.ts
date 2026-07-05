export type TurnPhase = "waiting" | "responding" | "idle";

export type TurnOutcome = "ok" | "error" | "aborted";

export interface TelemetrySnapshot {
  phase: TurnPhase;
  turnSeq: number;
  model: string;
  elapsedMs: number;
  ttftMs: number | null;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  tokensPerSec: number | null;
  cacheHitRatio: number | null;
  outcome: TurnOutcome | null;
}

export interface TurnActivity {
  kind: "idle" | "waiting" | "thinking" | "writing" | "tool";
  toolName?: string;
}

export function activityForAssistantEvent(eventType: string): TurnActivity | undefined {
  if (eventType.startsWith("thinking_")) return { kind: "thinking" };
  if (eventType.startsWith("text_") || eventType.startsWith("toolcall_")) return { kind: "writing" };
  return undefined;
}

export function statusLabel(streaming: boolean, activity: TurnActivity, outcome: TurnOutcome | null | undefined): string {
  if (!streaming) {
    switch (outcome) {
      case "error":
        return "error";
      case "aborted":
        return "stopped";
      default:
        return "done";
    }
  }
  switch (activity.kind) {
    case "thinking":
      return "thinking";
    case "writing":
      return "writing";
    case "tool":
      return activity.toolName ?? "tool";
    default:
      return "waiting";
  }
}

export function formatTokenCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
}

export function formatTokensPerSec(tokensPerSec: number): string {
  return tokensPerSec >= 10 ? String(Math.round(tokensPerSec)) : tokensPerSec.toFixed(1);
}

export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m${String(rest).padStart(2, "0")}s`;
}

export function liveTurnStats(snapshot: TelemetrySnapshot, msSinceSnapshot: number): string {
  const parts = [formatDuration(snapshot.elapsedMs + msSinceSnapshot)];
  if (snapshot.tokensPerSec !== null) parts.push(`${formatTokensPerSec(snapshot.tokensPerSec)} tok/s`);
  if (snapshot.completionTokens > 0) parts.push(`${formatTokenCount(snapshot.completionTokens)} tok`);
  if (snapshot.ttftMs !== null) parts.push(`ttft ${formatDuration(snapshot.ttftMs)}`);
  return parts.join(" · ");
}

export function finishedTurnStats(snapshot: TelemetrySnapshot): string {
  const parts = [`${formatTokenCount(snapshot.completionTokens)} tok in ${formatDuration(snapshot.elapsedMs)}`];
  if (snapshot.tokensPerSec !== null) parts.push(`${formatTokensPerSec(snapshot.tokensPerSec)} tok/s`);
  if (snapshot.ttftMs !== null) parts.push(`ttft ${formatDuration(snapshot.ttftMs)}`);
  const promptTotal = snapshot.promptTokens + snapshot.cachedTokens;
  if (promptTotal > 0) parts.push(`prompt ${formatTokenCount(promptTotal)}`);
  if (snapshot.cacheHitRatio !== null) parts.push(`cache ${Math.round(snapshot.cacheHitRatio * 100)}%`);
  return parts.join(" · ");
}
