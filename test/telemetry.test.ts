import { describe, expect, it } from "vitest";
import { Counter, Gauge, Histogram, MetricsRegistry } from "../src/metrics.js";
import type { TelemetrySnapshot } from "../src/protocol.js";
import { Telemetry } from "../src/telemetry.js";

interface Harness {
  telemetry: Telemetry;
  logs: Record<string, unknown>[];
  snapshots: { sessionId: string; snapshot: TelemetrySnapshot }[];
  clock: { value: number };
}

function makeTelemetry(gauges: { live?: () => number; streaming?: () => number } = {}): Harness {
  const logs: Record<string, unknown>[] = [];
  const snapshots: { sessionId: string; snapshot: TelemetrySnapshot }[] = [];
  const clock = { value: 0 };
  const telemetry = new Telemetry({
    liveSessions: gauges.live ?? (() => 0),
    streamingSessions: gauges.streaming ?? (() => 0),
    now: () => clock.value,
    wallClock: () => "2026-01-01T00:00:00.000Z",
    emitLog: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
    onSnapshot: (sessionId, snapshot) => snapshots.push({ sessionId, snapshot }),
  });
  return { telemetry, logs, snapshots, clock };
}

function textDeltaEvent(delta: string) {
  return {
    type: "message_update",
    message: { role: "assistant", provider: "solvency", model: "qwen-fast" },
    assistantMessageEvent: { type: "text_delta", delta },
  };
}

function assistantUsageEvent(usage: Partial<Record<string, number>>, stopReason = "stop") {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      provider: "solvency",
      model: "qwen-fast",
      stopReason,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, ...usage },
    },
  };
}

function metricValue(exposition: string, series: string): number | undefined {
  const line = exposition.split("\n").find((l) => l.startsWith(`${series} `));
  return line ? Number(line.slice(series.length + 1)) : undefined;
}

describe("Telemetry token accounting", () => {
  it("increments prompt/cached/completion counters from a usage event, labeled by model", () => {
    const { telemetry } = makeTelemetry();
    telemetry.sessionEvent("s1", { type: "agent_start" });
    telemetry.sessionEvent("s1", assistantUsageEvent({ input: 7263, cacheRead: 11429, output: 137 }));
    telemetry.sessionEvent("s1", { type: "agent_end" });

    const out = telemetry.renderMetrics();
    expect(metricValue(out, 'pi_remote_turn_prompt_tokens_total{model="solvency/qwen-fast"}')).toBe(7263);
    expect(metricValue(out, 'pi_remote_turn_cached_tokens_total{model="solvency/qwen-fast"}')).toBe(11429);
    expect(metricValue(out, 'pi_remote_turn_completion_tokens_total{model="solvency/qwen-fast"}')).toBe(137);
  });

  it("sums usage across multiple assistant messages within one turn", () => {
    const { telemetry, logs } = makeTelemetry();
    telemetry.sessionEvent("s1", { type: "agent_start" });
    telemetry.sessionEvent("s1", assistantUsageEvent({ input: 100, cacheRead: 0, output: 10 }));
    telemetry.sessionEvent("s1", assistantUsageEvent({ input: 20, cacheRead: 110, output: 5 }));
    telemetry.sessionEvent("s1", { type: "agent_end" });

    const turn = logs.find((l) => l.event === "turn");
    expect(turn).toMatchObject({ prompt_tokens: 120, cached_tokens: 110, completion_tokens: 15 });
    const out = telemetry.renderMetrics();
    expect(metricValue(out, 'pi_remote_turn_prompt_tokens_total{model="solvency/qwen-fast"}')).toBe(120);
  });

  it("observes the cache hit ratio per turn", () => {
    const { telemetry } = makeTelemetry();
    telemetry.sessionEvent("s1", { type: "agent_start" });
    telemetry.sessionEvent("s1", assistantUsageEvent({ input: 25, cacheRead: 75, output: 1 }));
    telemetry.sessionEvent("s1", { type: "agent_end" });

    const out = telemetry.renderMetrics();
    expect(metricValue(out, 'pi_remote_turn_cache_hit_ratio_sum{model="solvency/qwen-fast"}')).toBe(0.75);
    expect(metricValue(out, 'pi_remote_turn_cache_hit_ratio_count{model="solvency/qwen-fast"}')).toBe(1);
  });
});

describe("Telemetry turn timing", () => {
  it("records TTFT from prompt-accepted to the first assistant content event, and turn duration to agent_end", () => {
    const { telemetry, logs, clock } = makeTelemetry();
    telemetry.promptSent("s1", "prompt", "solvency/qwen-fast");
    clock.value = 500;
    telemetry.sessionEvent("s1", { type: "agent_start" });
    clock.value = 2000;
    telemetry.sessionEvent("s1", {
      type: "message_update",
      message: { role: "assistant", provider: "solvency", model: "qwen-fast" },
      assistantMessageEvent: { type: "text_delta", delta: "H" },
    });
    telemetry.sessionEvent("s1", assistantUsageEvent({ input: 10, output: 40 }));
    clock.value = 6000;
    telemetry.sessionEvent("s1", { type: "agent_end" });

    const out = telemetry.renderMetrics();
    expect(metricValue(out, 'pi_remote_turn_ttft_seconds_sum{model="solvency/qwen-fast"}')).toBe(2);
    expect(metricValue(out, 'pi_remote_turn_ttft_seconds_count{model="solvency/qwen-fast"}')).toBe(1);
    expect(metricValue(out, 'pi_remote_turn_duration_seconds_sum{model="solvency/qwen-fast"}')).toBe(6);
    expect(logs.find((l) => l.event === "first_token")).toMatchObject({ ttft_ms: 2000, turn_seq: 1 });
    expect(logs.find((l) => l.event === "turn")).toMatchObject({
      ttft_ms: 2000,
      duration_ms: 6000,
      tokens_per_sec: 10,
      outcome: "ok",
    });
  });

  it("ignores the stream-open event when measuring TTFT", () => {
    const { telemetry, clock } = makeTelemetry();
    telemetry.sessionEvent("s1", { type: "agent_start" });
    clock.value = 1000;
    telemetry.sessionEvent("s1", {
      type: "message_update",
      message: { role: "assistant", provider: "solvency", model: "qwen-fast" },
      assistantMessageEvent: { type: "start" },
    });
    clock.value = 3000;
    telemetry.sessionEvent("s1", {
      type: "message_update",
      message: { role: "assistant", provider: "solvency", model: "qwen-fast" },
      assistantMessageEvent: { type: "thinking_delta", delta: "…" },
    });
    telemetry.sessionEvent("s1", { type: "agent_end" });

    const out = telemetry.renderMetrics();
    expect(metricValue(out, 'pi_remote_turn_ttft_seconds_sum{model="solvency/qwen-fast"}')).toBe(3);
  });

  it("only the first content event of a turn counts as first token", () => {
    const { telemetry, logs } = makeTelemetry();
    telemetry.sessionEvent("s1", { type: "agent_start" });
    const update = {
      type: "message_update",
      message: { role: "assistant", provider: "p", model: "m" },
      assistantMessageEvent: { type: "text_delta", delta: "x" },
    };
    telemetry.sessionEvent("s1", update);
    telemetry.sessionEvent("s1", update);
    expect(logs.filter((l) => l.event === "first_token")).toHaveLength(1);
  });
});

describe("Telemetry outcomes and lifecycle logs", () => {
  it("labels turns_total by model and outcome from the last stopReason", () => {
    const { telemetry } = makeTelemetry();
    for (const stopReason of ["stop", "error", "aborted"]) {
      telemetry.sessionEvent("s1", { type: "agent_start" });
      telemetry.sessionEvent("s1", assistantUsageEvent({ input: 1, output: 1 }, stopReason));
      telemetry.sessionEvent("s1", { type: "agent_end" });
    }
    const out = telemetry.renderMetrics();
    expect(metricValue(out, 'pi_remote_turns_total{model="solvency/qwen-fast",outcome="ok"}')).toBe(1);
    expect(metricValue(out, 'pi_remote_turns_total{model="solvency/qwen-fast",outcome="error"}')).toBe(1);
    expect(metricValue(out, 'pi_remote_turns_total{model="solvency/qwen-fast",outcome="aborted"}')).toBe(1);
  });

  it("increments turn_seq per session and logs prompt and model_switch events", () => {
    const { telemetry, logs } = makeTelemetry();
    telemetry.promptSent("s1", "prompt", "a/b");
    telemetry.sessionEvent("s1", { type: "agent_start" });
    telemetry.sessionEvent("s1", { type: "agent_end" });
    telemetry.modelSwitched("s1", "a/b", "c/d");
    telemetry.promptSent("s1", "followup", "c/d");
    telemetry.sessionEvent("s1", { type: "agent_start" });
    telemetry.sessionEvent("s1", { type: "agent_end" });

    expect(logs.find((l) => l.event === "prompt")).toMatchObject({ session_id: "s1", model: "a/b", kind: "prompt" });
    expect(logs.find((l) => l.event === "model_switch")).toMatchObject({ from: "a/b", to: "c/d" });
    expect(logs.filter((l) => l.event === "turn").map((l) => l.turn_seq)).toEqual([1, 2]);
    expect(logs.every((l) => typeof l.ts === "string")).toBe(true);
  });

  it("ignores events with no active turn and non-assistant messages", () => {
    const { telemetry, logs } = makeTelemetry();
    telemetry.sessionEvent("s1", assistantUsageEvent({ input: 99, output: 99 }));
    telemetry.sessionEvent("s1", { type: "agent_end" });
    telemetry.sessionEvent("s1", { type: "agent_start" });
    telemetry.sessionEvent("s1", { type: "message_end", message: { role: "user", content: "hi" } });
    telemetry.sessionEvent("s1", { type: "agent_end" });

    expect(telemetry.renderMetrics()).not.toContain("pi_remote_turn_prompt_tokens_total{");
    expect(logs.filter((l) => l.event === "turn")).toHaveLength(1);
  });
});

describe("Telemetry live snapshots", () => {
  it("emits waiting → responding → idle snapshots across a turn", () => {
    const { telemetry, snapshots, clock } = makeTelemetry();
    telemetry.promptSent("s1", "prompt", "solvency/qwen-fast");
    telemetry.sessionEvent("s1", { type: "agent_start" });
    expect(snapshots[0].snapshot).toMatchObject({
      phase: "waiting",
      turnSeq: 1,
      elapsedMs: 0,
      ttftMs: null,
      tokensPerSec: null,
      outcome: null,
    });

    clock.value = 1000;
    telemetry.sessionEvent("s1", textDeltaEvent("hola"));
    expect(snapshots[1].snapshot).toMatchObject({ phase: "responding", ttftMs: 1000 });

    clock.value = 2000;
    telemetry.sessionEvent("s1", textDeltaEvent("x".repeat(40)));
    expect(snapshots[2].snapshot).toMatchObject({ completionTokens: 11, tokensPerSec: 11, elapsedMs: 2000 });

    telemetry.sessionEvent("s1", assistantUsageEvent({ input: 100, cacheRead: 300, output: 50 }));
    expect(snapshots[3].snapshot).toMatchObject({
      completionTokens: 50,
      promptTokens: 100,
      cachedTokens: 300,
      cacheHitRatio: 0.75,
      tokensPerSec: 50,
    });

    clock.value = 3000;
    telemetry.sessionEvent("s1", { type: "agent_end" });
    expect(snapshots[4].snapshot).toMatchObject({
      phase: "idle",
      outcome: "ok",
      elapsedMs: 3000,
      ttftMs: 1000,
      completionTokens: 50,
      tokensPerSec: 25,
    });
    expect(snapshots).toHaveLength(5);
    expect(snapshots.every((s) => s.sessionId === "s1")).toBe(true);
  });

  it("throttles streaming-delta snapshots to the emission interval", () => {
    const { telemetry, snapshots, clock } = makeTelemetry();
    telemetry.sessionEvent("s1", { type: "agent_start" });
    clock.value = 100;
    telemetry.sessionEvent("s1", textDeltaEvent("a"));
    clock.value = 200;
    telemetry.sessionEvent("s1", textDeltaEvent("b"));
    clock.value = 300;
    telemetry.sessionEvent("s1", textDeltaEvent("c"));
    expect(snapshots).toHaveLength(2);
    clock.value = 599;
    telemetry.sessionEvent("s1", textDeltaEvent("d"));
    expect(snapshots).toHaveLength(2);
    clock.value = 600;
    telemetry.sessionEvent("s1", textDeltaEvent("e"));
    expect(snapshots).toHaveLength(3);
    expect(snapshots[2].snapshot.completionTokens).toBe(1);
  });

  it("stacks a fresh streamed-char estimate on top of the exact count after each usage report", () => {
    const { telemetry, snapshots, clock } = makeTelemetry();
    telemetry.sessionEvent("s1", { type: "agent_start" });
    clock.value = 1000;
    telemetry.sessionEvent("s1", textDeltaEvent("x".repeat(40)));
    clock.value = 1600;
    telemetry.sessionEvent("s1", textDeltaEvent("x".repeat(40)));
    expect(snapshots.at(-1)?.snapshot.completionTokens).toBe(20);

    telemetry.sessionEvent("s1", assistantUsageEvent({ input: 10, output: 50 }));
    expect(snapshots.at(-1)?.snapshot.completionTokens).toBe(50);

    clock.value = 2200;
    telemetry.sessionEvent("s1", textDeltaEvent("y".repeat(80)));
    expect(snapshots.at(-1)?.snapshot.completionTokens).toBe(70);
  });

  it("reports null tokensPerSec and cacheHitRatio for a turn that produced nothing", () => {
    const { telemetry, snapshots, clock } = makeTelemetry();
    telemetry.sessionEvent("s1", { type: "agent_start" });
    expect(snapshots[0].snapshot.cacheHitRatio).toBeNull();
    clock.value = 5000;
    telemetry.sessionEvent("s1", { type: "agent_end" });
    expect(snapshots.at(-1)?.snapshot).toMatchObject({
      phase: "idle",
      outcome: "ok",
      completionTokens: 0,
      tokensPerSec: null,
      cacheHitRatio: null,
    });
  });

  it("snapshot() serves the live turn while active and the final turn afterwards", () => {
    const { telemetry, clock } = makeTelemetry();
    expect(telemetry.snapshot("nope")).toBeUndefined();

    telemetry.sessionEvent("s1", { type: "agent_start" });
    clock.value = 1000;
    telemetry.sessionEvent("s1", textDeltaEvent("hey"));
    clock.value = 4000;
    expect(telemetry.snapshot("s1")).toMatchObject({ phase: "responding", elapsedMs: 4000, ttftMs: 1000 });

    telemetry.sessionEvent("s1", assistantUsageEvent({ input: 10, output: 30 }, "aborted"));
    clock.value = 5000;
    telemetry.sessionEvent("s1", { type: "agent_end" });
    clock.value = 60000;
    expect(telemetry.snapshot("s1")).toMatchObject({
      phase: "idle",
      outcome: "aborted",
      elapsedMs: 5000,
      completionTokens: 30,
    });
  });
});

describe("Prometheus exposition format", () => {
  it("renders HELP/TYPE headers, escaped labels, and gauges from live callbacks", () => {
    const { telemetry } = makeTelemetry({ live: () => 3, streaming: () => 2 });
    const out = telemetry.renderMetrics();
    expect(out).toContain("# HELP pi_remote_live_sessions ");
    expect(out).toContain("# TYPE pi_remote_live_sessions gauge");
    expect(metricValue(out, "pi_remote_live_sessions")).toBe(3);
    expect(metricValue(out, "pi_remote_streaming_sessions")).toBe(2);
    expect(out).toContain("# TYPE pi_remote_turns_total counter");
    expect(out).toContain("# TYPE pi_remote_turn_ttft_seconds histogram");
  });

  it("renders cumulative histogram buckets ending in +Inf", () => {
    const registry = new MetricsRegistry();
    const histogram = registry.register(new Histogram("h", "help", [1, 5], ["model"]));
    histogram.observe({ model: "m" }, 0.5);
    histogram.observe({ model: "m" }, 3);
    histogram.observe({ model: "m" }, 100);
    const out = registry.render();
    expect(metricValue(out, 'h_bucket{model="m",le="1"}')).toBe(1);
    expect(metricValue(out, 'h_bucket{model="m",le="5"}')).toBe(2);
    expect(metricValue(out, 'h_bucket{model="m",le="+Inf"}')).toBe(3);
    expect(metricValue(out, 'h_sum{model="m"}')).toBe(103.5);
    expect(metricValue(out, 'h_count{model="m"}')).toBe(3);
  });

  it("escapes label values and renders unlabeled counters", () => {
    const registry = new MetricsRegistry();
    const counter = registry.register(new Counter("c", "help", ["model"]));
    counter.inc({ model: 'we"ird\\mo\ndel' }, 2);
    registry.register(new Gauge("g", "help", () => 7));
    const out = registry.render();
    expect(out).toContain('c{model="we\\"ird\\\\mo\\ndel"} 2');
    expect(out).toContain("g 7");
  });
});
