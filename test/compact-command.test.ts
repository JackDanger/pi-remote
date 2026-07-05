import { describe, expect, it } from "vitest";
import { gateCompact, parseCompactCommand } from "../web/src/compact-command.js";

describe("parseCompactCommand", () => {
  it("matches a bare /compact", () => {
    expect(parseCompactCommand("/compact")).toEqual({});
  });

  it("extracts trimmed instructions after /compact ", () => {
    expect(parseCompactCommand("/compact keep the migration plan")).toEqual({
      instructions: "keep the migration plan",
    });
    expect(parseCompactCommand("/compact   spaced out  ")).toEqual({ instructions: "spaced out" });
  });

  it("treats /compact followed by only whitespace as instruction-less", () => {
    expect(parseCompactCommand("/compact   ")).toEqual({});
  });

  it("leaves normal messages containing slashes alone", () => {
    expect(parseCompactCommand("look at src/app.ts please")).toBeUndefined();
    expect(parseCompactCommand("run /compact when you get a chance")).toBeUndefined();
  });

  it("leaves other slash-words and near-misses alone", () => {
    expect(parseCompactCommand("/compaction")).toBeUndefined();
    expect(parseCompactCommand("/help")).toBeUndefined();
    expect(parseCompactCommand("/ compact")).toBeUndefined();
  });
});

describe("gateCompact", () => {
  it("allows compaction when idle", () => {
    expect(gateCompact(false, false)).toEqual({ allowed: true });
  });

  it("blocks while a turn is streaming", () => {
    expect(gateCompact(true, false)).toEqual({ allowed: false, reason: "finish or stop the current turn first" });
  });

  it("blocks while a compaction is already running", () => {
    expect(gateCompact(false, true)).toEqual({ allowed: false, reason: "already compacting" });
  });

  it("reports the streaming turn first when both are in flight", () => {
    expect(gateCompact(true, true)).toEqual({ allowed: false, reason: "finish or stop the current turn first" });
  });
});
