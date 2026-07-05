import { describe, expect, it } from "vitest";
import {
  parseModelCommand,
  parseNameCommand,
  resolveModelPattern,
  type ModelChoice,
} from "../web/src/local-commands.js";

describe("parseModelCommand", () => {
  it("returns an empty pattern for bare /model", () => {
    expect(parseModelCommand("/model")).toEqual({});
  });

  it("captures the pattern after /model", () => {
    expect(parseModelCommand("/model qwen")).toEqual({ pattern: "qwen" });
    expect(parseModelCommand("/model  sonnet 4.5 ")).toEqual({ pattern: "sonnet 4.5" });
  });

  it("rejects non-model text", () => {
    expect(parseModelCommand("/models")).toBeUndefined();
    expect(parseModelCommand("model qwen")).toBeUndefined();
    expect(parseModelCommand("hello")).toBeUndefined();
  });
});

describe("parseNameCommand", () => {
  it("captures the title after /name", () => {
    expect(parseNameCommand("/name Estate research")).toEqual({ title: "Estate research" });
  });

  it("returns an empty title for bare /name so the caller can show usage", () => {
    expect(parseNameCommand("/name")).toEqual({ title: "" });
    expect(parseNameCommand("/name   ")).toEqual({ title: "" });
  });

  it("rejects non-name text", () => {
    expect(parseNameCommand("/names x")).toBeUndefined();
    expect(parseNameCommand("name x")).toBeUndefined();
  });
});

describe("resolveModelPattern", () => {
  const models: ModelChoice[] = [
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    { provider: "solvency", id: "qwen-fast", name: "Qwen3 Fast" },
  ];

  it("matches a unique substring", () => {
    expect(resolveModelPattern(models, "haiku")).toEqual({ kind: "match", model: models[1] });
    expect(resolveModelPattern(models, "qwen")).toEqual({ kind: "match", model: models[2] });
  });

  it("prefers an exact id or name over partial matches", () => {
    expect(resolveModelPattern(models, "claude-sonnet-4-5")).toEqual({ kind: "match", model: models[0] });
    expect(resolveModelPattern(models, "Claude Haiku 4.5")).toEqual({ kind: "match", model: models[1] });
  });

  it("matches provider/id form", () => {
    expect(resolveModelPattern(models, "solvency/qwen-fast")).toEqual({ kind: "match", model: models[2] });
  });

  it("is case-insensitive", () => {
    expect(resolveModelPattern(models, "HAIKU")).toEqual({ kind: "match", model: models[1] });
  });

  it("reports ambiguity with the candidate set", () => {
    const result = resolveModelPattern(models, "claude");
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.matches).toHaveLength(2);
    }
  });

  it("reports no match", () => {
    expect(resolveModelPattern(models, "gpt")).toEqual({ kind: "none" });
  });
});
