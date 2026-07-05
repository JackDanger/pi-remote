import { formatDuration, formatTokenCount, formatTokensPerSec } from "./turn-stats.js";

export const COMPACTING_LABEL = "Compacting context…";

export interface CompactionStateSnapshot {
  reason: string;
  startedAt: number;
  tokensSoFar: number;
  elapsedMs: number;
}

export interface CompactionResultSnapshot {
  summary: string;
  tokensBefore: number;
  estimatedTokensAfter?: number;
}

export interface CompactionEndEvent {
  result?: CompactionResultSnapshot;
  aborted?: boolean;
  willRetry?: boolean;
  errorMessage?: string;
}

export type CompactionOutcome =
  | { kind: "done"; result: CompactionResultSnapshot }
  | { kind: "canceled" }
  | { kind: "empty"; message: string }
  | { kind: "failed"; message: string };

const NOTHING_TO_COMPACT = /nothing to compact|already compacted|session too small/i;

export function classifyCompactionEnd(event: CompactionEndEvent): CompactionOutcome {
  if (event.aborted) return { kind: "canceled" };
  if (event.errorMessage) {
    if (NOTHING_TO_COMPACT.test(event.errorMessage)) {
      return { kind: "empty", message: "Nothing to compact (session already small)" };
    }
    return { kind: "failed", message: event.errorMessage };
  }
  if (event.result && typeof event.result.tokensBefore === "number") {
    return { kind: "done", result: event.result };
  }
  return { kind: "failed", message: "Compaction failed" };
}

export function compactionResultTitle(tokensBefore?: number, estimatedTokensAfter?: number): string {
  if (tokensBefore === undefined) return "Context compacted";
  if (estimatedTokensAfter === undefined) {
    return `Context compacted · ${formatTokenCount(tokensBefore)} tokens summarized`;
  }
  const base = `Context compacted · ${formatTokenCount(tokensBefore)} → ${formatTokenCount(estimatedTokensAfter)} tokens`;
  const percentSaved = tokensBefore > 0 ? Math.round((1 - estimatedTokensAfter / tokensBefore) * 100) : 0;
  return percentSaved >= 1 ? `${base} (−${percentSaved}%)` : base;
}

export function compactionTokensPerSec(tokensSoFar: number, elapsedMs: number): number | undefined {
  if (tokensSoFar <= 0 || elapsedMs < 1000) return undefined;
  return tokensSoFar / (elapsedMs / 1000);
}

export function compactingStats(startedAt: number | undefined, tokensSoFar: number | undefined, now: number): string {
  const parts: string[] = [];
  if (tokensSoFar !== undefined && tokensSoFar > 0) parts.push(`${formatTokenCount(tokensSoFar)} tok`);
  if (startedAt !== undefined) {
    const elapsedMs = Math.max(0, now - startedAt);
    parts.push(formatDuration(elapsedMs));
    const rate = tokensSoFar === undefined ? undefined : compactionTokensPerSec(tokensSoFar, elapsedMs);
    if (rate !== undefined) parts.push(`${formatTokensPerSec(rate)} tok/s`);
  }
  return parts.join(" · ");
}

export function compactionStartFromSnapshot(nowMs: number, snapshot: { elapsedMs: number }): number {
  return nowMs - Math.max(0, snapshot.elapsedMs);
}

interface RoleAndSummary {
  role?: string;
  summary?: string;
}

export function compactionApplied(previous: ReadonlyArray<RoleAndSummary>, next: ReadonlyArray<RoleAndSummary>): boolean {
  const nextFirst = next[0];
  if (nextFirst?.role !== "compactionSummary") return false;
  const previousFirst = previous[0];
  return previousFirst?.role !== "compactionSummary" || previousFirst.summary !== nextFirst.summary;
}
