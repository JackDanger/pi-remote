import { describe, expect, it } from "vitest";
import {
  activityForAssistantEvent,
  finishedTurnStats,
  formatDuration,
  formatTokenCount,
  formatTokensPerSec,
  liveTurnStats,
  statusLabel,
  type TelemetrySnapshot,
} from "../web/src/turn-stats.js";

function snapshot(overrides: Partial<TelemetrySnapshot> = {}): TelemetrySnapshot {
  return {
    phase: "responding",
    turnSeq: 1,
    model: "solvency/qwen-fast",
    elapsedMs: 12000,
    ttftMs: 2100,
    promptTokens: 6000,
    cachedTokens: 39000,
    completionTokens: 320,
    tokensPerSec: 62,
    cacheHitRatio: 0.867,
    outcome: null,
    ...overrides,
  };
}

describe("formatTokenCount", () => {
  it("keeps counts under 1k verbatim", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("shows one decimal up to 10k and whole k above", () => {
    expect(formatTokenCount(1000)).toBe("1.0k");
    expect(formatTokenCount(1849)).toBe("1.8k");
    expect(formatTokenCount(12400)).toBe("12k");
    expect(formatTokenCount(45000)).toBe("45k");
  });
});

describe("formatTokensPerSec", () => {
  it("shows one decimal below 10 and whole numbers from 10 up", () => {
    expect(formatTokensPerSec(9.94)).toBe("9.9");
    expect(formatTokensPerSec(10)).toBe("10");
    expect(formatTokensPerSec(62.4)).toBe("62");
  });
});

describe("formatDuration", () => {
  it("scales from tenths of seconds through minutes", () => {
    expect(formatDuration(2100)).toBe("2.1s");
    expect(formatDuration(42000)).toBe("42s");
    expect(formatDuration(59400)).toBe("59s");
    expect(formatDuration(60000)).toBe("1m00s");
    expect(formatDuration(90000)).toBe("1m30s");
  });
});

describe("liveTurnStats", () => {
  it("joins elapsed, rate, tokens, and ttft", () => {
    expect(liveTurnStats(snapshot(), 0)).toBe("12s · 62 tok/s · 320 tok · ttft 2.1s");
  });

  it("extrapolates elapsed time past the snapshot receive time", () => {
    expect(liveTurnStats(snapshot({ elapsedMs: 12000 }), 3000)).toContain("15s");
  });

  it("omits rate, tokens, and ttft before the first token", () => {
    const waiting = snapshot({ phase: "waiting", elapsedMs: 1500, ttftMs: null, completionTokens: 0, tokensPerSec: null });
    expect(liveTurnStats(waiting, 0)).toBe("1.5s");
  });
});

describe("finishedTurnStats", () => {
  it("summarizes tokens, duration, rate, ttft, prompt size, and cache hit", () => {
    const finished = snapshot({ phase: "idle", elapsedMs: 42000, completionTokens: 1849, outcome: "ok" });
    expect(finishedTurnStats(finished)).toBe("1.8k tok in 42s · 62 tok/s · ttft 2.1s · prompt 45k · cache 87%");
  });

  it("omits prompt and cache segments when the turn reported no usage", () => {
    const bare = snapshot({
      phase: "idle",
      elapsedMs: 5000,
      completionTokens: 0,
      promptTokens: 0,
      cachedTokens: 0,
      tokensPerSec: null,
      ttftMs: null,
      cacheHitRatio: null,
      outcome: "error",
    });
    expect(finishedTurnStats(bare)).toBe("0 tok in 5.0s");
  });
});

describe("statusLabel", () => {
  it("maps finished outcomes to done/stopped/error", () => {
    expect(statusLabel(false, { kind: "idle" }, "ok")).toBe("done");
    expect(statusLabel(false, { kind: "idle" }, undefined)).toBe("done");
    expect(statusLabel(false, { kind: "idle" }, "aborted")).toBe("stopped");
    expect(statusLabel(false, { kind: "idle" }, "error")).toBe("error");
  });

  it("maps live activity to its word, with the tool name when running a tool", () => {
    expect(statusLabel(true, { kind: "waiting" }, null)).toBe("waiting");
    expect(statusLabel(true, { kind: "thinking" }, null)).toBe("thinking");
    expect(statusLabel(true, { kind: "writing" }, null)).toBe("writing");
    expect(statusLabel(true, { kind: "tool", toolName: "bash" }, null)).toBe("bash");
    expect(statusLabel(true, { kind: "tool" }, null)).toBe("tool");
  });
});

describe("activityForAssistantEvent", () => {
  it("classifies thinking, text, and toolcall stream events", () => {
    expect(activityForAssistantEvent("thinking_delta")).toEqual({ kind: "thinking" });
    expect(activityForAssistantEvent("text_delta")).toEqual({ kind: "writing" });
    expect(activityForAssistantEvent("toolcall_start")).toEqual({ kind: "writing" });
  });

  it("leaves non-content events unclassified", () => {
    expect(activityForAssistantEvent("start")).toBeUndefined();
    expect(activityForAssistantEvent("")).toBeUndefined();
  });
});
