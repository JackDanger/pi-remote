import { describe, expect, it } from "vitest";
import {
  COMPACTING_LABEL,
  classifyCompactionEnd,
  compactingStats,
  compactionApplied,
  compactionResultTitle,
  compactionStartFromSnapshot,
  compactionTokensPerSec,
} from "../web/src/compaction-view.js";

describe("classifyCompactionEnd", () => {
  it("returns done with the result for a successful compaction", () => {
    const result = { summary: "## Summary\nWe did things.", firstKeptEntryId: "e9", tokensBefore: 39350, estimatedTokensAfter: 31416 };
    expect(classifyCompactionEnd({ result, aborted: false, willRetry: false })).toEqual({ kind: "done", result });
  });

  it("returns canceled when the engine reports an abort", () => {
    expect(classifyCompactionEnd({ result: undefined, aborted: true, willRetry: false })).toEqual({ kind: "canceled" });
  });

  it("treats too-small and already-compacted sessions as a calm empty state", () => {
    expect(
      classifyCompactionEnd({ aborted: false, errorMessage: "Compaction failed: Nothing to compact (session too small)" }),
    ).toEqual({ kind: "empty", message: "Nothing to compact (session already small)" });
    expect(classifyCompactionEnd({ aborted: false, errorMessage: "Compaction failed: Already compacted" })).toEqual({
      kind: "empty",
      message: "Nothing to compact (session already small)",
    });
  });

  it("surfaces other error messages as failures", () => {
    expect(classifyCompactionEnd({ aborted: false, errorMessage: "Compaction failed: model timeout" })).toEqual({
      kind: "failed",
      message: "Compaction failed: model timeout",
    });
  });

  it("fails safe when neither result nor errorMessage is present", () => {
    expect(classifyCompactionEnd({ aborted: false })).toEqual({ kind: "failed", message: "Compaction failed" });
  });
});

describe("compactionResultTitle", () => {
  it("shows before → after with percent saved", () => {
    expect(compactionResultTitle(39350, 31416)).toBe("Context compacted · 39k → 31k tokens (−20%)");
    expect(compactionResultTitle(8200, 4100)).toBe("Context compacted · 8.2k → 4.1k tokens (−50%)");
  });

  it("omits the percent when nothing was saved", () => {
    expect(compactionResultTitle(1000, 1000)).toBe("Context compacted · 1.0k → 1.0k tokens");
    expect(compactionResultTitle(1000, 1200)).toBe("Context compacted · 1.0k → 1.2k tokens");
  });

  it("shows only the before count when the after estimate is unknown", () => {
    expect(compactionResultTitle(39350)).toBe("Context compacted · 39k tokens summarized");
  });

  it("degrades to a plain label without token data", () => {
    expect(compactionResultTitle()).toBe("Context compacted");
  });
});

describe("compactionTokensPerSec", () => {
  it("divides tokens by elapsed seconds", () => {
    expect(compactionTokensPerSec(3200, 14000)).toBeCloseTo(228.57, 1);
    expect(compactionTokensPerSec(500, 2000)).toBe(250);
  });

  it("withholds a rate until a full second has elapsed", () => {
    expect(compactionTokensPerSec(120, 999)).toBeUndefined();
    expect(compactionTokensPerSec(120, 0)).toBeUndefined();
  });

  it("withholds a rate without tokens", () => {
    expect(compactionTokensPerSec(0, 5000)).toBeUndefined();
  });
});

describe("compactingStats", () => {
  it("shows tokens, elapsed, and rate mid-compaction", () => {
    expect(compactingStats(0, 3200, 14000)).toBe("3.2k tok · 14s · 229 tok/s");
  });

  it("shows only elapsed before the first progress event", () => {
    expect(compactingStats(1000, undefined, 43000)).toBe("42s");
    expect(compactingStats(0, 0, 90000)).toBe("1m30s");
  });

  it("shows tokens without a rate when the start time is unknown", () => {
    expect(compactingStats(undefined, 3200, 14000)).toBe("3.2k tok");
  });

  it("is empty with no data and never shows a negative duration", () => {
    expect(compactingStats(undefined, undefined, 5000)).toBe("");
    expect(compactingStats(9000, undefined, 5000)).toBe("0.0s");
  });
});

describe("compactionStartFromSnapshot", () => {
  it("reconstructs the local start time from the server-reported elapsed", () => {
    expect(compactionStartFromSnapshot(100000, { elapsedMs: 14000 })).toBe(86000);
  });

  it("clamps a negative elapsed to now", () => {
    expect(compactionStartFromSnapshot(100000, { elapsedMs: -50 })).toBe(100000);
  });

  it("keeps the local elapsed ticking forward from the reconstructed start", () => {
    const attachedAt = 100000;
    const startedAt = compactionStartFromSnapshot(attachedAt, { elapsedMs: 14000 });
    expect(compactingStats(startedAt, 3200, attachedAt + 2000)).toBe("3.2k tok · 16s · 200 tok/s");
  });
});

describe("compactionApplied", () => {
  it("detects a fresh compaction summary leading the resynced log", () => {
    const previous = [{ role: "user" }, { role: "assistant" }];
    const next = [{ role: "compactionSummary", summary: "## Goal" }, { role: "assistant" }];
    expect(compactionApplied(previous, next)).toBe(true);
  });

  it("detects a re-compaction that replaced the previous summary", () => {
    const previous = [{ role: "compactionSummary", summary: "old" }, { role: "assistant" }];
    const next = [{ role: "compactionSummary", summary: "new" }, { role: "assistant" }];
    expect(compactionApplied(previous, next)).toBe(true);
    expect(compactionApplied(next, next)).toBe(false);
  });

  it("reports no compaction when the log still starts with ordinary messages", () => {
    expect(compactionApplied([{ role: "user" }], [{ role: "user" }, { role: "assistant" }])).toBe(false);
    expect(compactionApplied([], [])).toBe(false);
  });
});

describe("COMPACTING_LABEL", () => {
  it("names the in-progress state the status bar renders", () => {
    expect(COMPACTING_LABEL).toBe("Compacting context…");
  });
});
