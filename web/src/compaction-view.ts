import { formatDuration, formatTokenCount } from "./turn-stats.js";

export const COMPACTING_LABEL = "Compacting context…";

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

export function compactingElapsed(startedAt: number | undefined, now: number): string {
  return startedAt === undefined ? "" : formatDuration(Math.max(0, now - startedAt));
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
