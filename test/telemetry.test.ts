import { describe, expect, it } from "vitest";
import { Counter, Gauge, Histogram, MetricsRegistry } from "../src/metrics.js";
import { Telemetry } from "../src/telemetry.js";

interface Harness {
  telemetry: Telemetry;
  logs: Record<string, unknown>[];
  clock: { value: number };
}

function makeTelemetry(gauges: { live?: () => number; streaming?: () => number } = {}): Harness {
  const logs: Record<string, unknown>[] = [];
  const clock = { value: 0 };
  const telemetry = new Telemetry({
    liveSessions: gauges.live ?? (() => 0),
    streamingSessions: gauges.streaming ?? (() => 0),
    now: () => clock.value,
    wallClock: () => "2026-01-01T00:00:00.000Z",
    emitLog: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { telemetry, logs, clock };
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
