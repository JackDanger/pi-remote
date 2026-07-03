import { Counter, Gauge, Histogram, MetricsRegistry } from "./metrics.js";

export type PromptKind = "prompt" | "steer" | "followup";

/** Hooks SessionHost invokes so turn accounting can ride the existing event fan-out. */
export interface SessionObserver {
  promptSent(sessionId: string, kind: PromptKind, model: string): void;
  modelSwitched(sessionId: string, from: string, to: string): void;
  sessionEvent(sessionId: string, event: unknown): void;
}

export interface TelemetryDeps {
  liveSessions: () => number;
  streamingSessions: () => number;
  now?: () => number;
  wallClock?: () => string;
  emitLog?: (line: string) => void;
}

const TTFT_BUCKETS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 240];
const DURATION_BUCKETS = [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 1200];
const CACHE_RATIO_BUCKETS = [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 1];

interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface AssistantMessageLike {
  role: "assistant";
  provider?: string;
  model?: string;
  stopReason?: string;
  usage?: UsageLike;
}

interface ActiveTurn {
  seq: number;
  model: string;
  startedAt: number;
  firstTokenAt?: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  lastStopReason?: string;
}

interface SessionTelemetryState {
  nextSeq: number;
  pendingPromptAt?: number;
  turn?: ActiveTurn;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asAssistantMessage(value: unknown): AssistantMessageLike | undefined {
  if (!isRecord(value) || value.role !== "assistant") return undefined;
  return value as unknown as AssistantMessageLike;
}

function asUsage(value: unknown): UsageLike | undefined {
  if (!isRecord(value)) return undefined;
  const { input, output, cacheRead, cacheWrite } = value;
  if (
    typeof input !== "number" ||
    typeof output !== "number" ||
    typeof cacheRead !== "number" ||
    typeof cacheWrite !== "number"
  ) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite };
}

function outcomeOf(stopReason: string | undefined): "ok" | "error" | "aborted" {
  if (stopReason === "error") return "error";
  if (stopReason === "aborted") return "aborted";
  return "ok";
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Per-turn observability: Prometheus metrics (rendered by `renderMetrics`) plus
 * single-line JSON logs for prompt / first_token / model_switch / turn events.
 *
 * A "turn" is one full agent run: prompt accepted → `agent_end`. Token counts are
 * summed across every assistant message in the run; TTFT is prompt-accepted to the
 * first streamed assistant content event.
 */
export class Telemetry implements SessionObserver {
  private readonly registry = new MetricsRegistry();
  private readonly sessions = new Map<string, SessionTelemetryState>();
  private readonly now: () => number;
  private readonly wallClock: () => string;
  private readonly emitLog: (line: string) => void;

  private readonly promptTokens = this.registry.register(
    new Counter(
      "pi_remote_turn_prompt_tokens_total",
      "Fresh (uncached) prompt tokens processed, by model.",
      ["model"],
    ),
  );
  private readonly cachedTokens = this.registry.register(
    new Counter(
      "pi_remote_turn_cached_tokens_total",
      "Prompt tokens served from the provider cache, by model.",
      ["model"],
    ),
  );
  private readonly completionTokens = this.registry.register(
    new Counter("pi_remote_turn_completion_tokens_total", "Tokens generated, by model.", ["model"]),
  );
  private readonly ttftSeconds = this.registry.register(
    new Histogram(
      "pi_remote_turn_ttft_seconds",
      "Time from prompt accepted to first streamed assistant content event.",
      TTFT_BUCKETS,
      ["model"],
    ),
  );
  private readonly durationSeconds = this.registry.register(
    new Histogram(
      "pi_remote_turn_duration_seconds",
      "Time from prompt accepted to agent_end for the whole turn.",
      DURATION_BUCKETS,
      ["model"],
    ),
  );
  private readonly cacheHitRatio = this.registry.register(
    new Histogram(
      "pi_remote_turn_cache_hit_ratio",
      "cacheRead / (cacheRead + input) per turn — 1.0 means the whole prompt was served from cache.",
      CACHE_RATIO_BUCKETS,
      ["model"],
    ),
  );
  private readonly turnsTotal = this.registry.register(
    new Counter("pi_remote_turns_total", "Completed turns, by model and outcome.", ["model", "outcome"]),
  );

  constructor(deps: TelemetryDeps) {
    this.now = deps.now ?? (() => performance.now());
    this.wallClock = deps.wallClock ?? (() => new Date().toISOString());
    this.emitLog = deps.emitLog ?? ((line) => console.log(line));
    this.registry.register(
      new Gauge("pi_remote_live_sessions", "Sessions currently hosted in-process.", deps.liveSessions),
    );
    this.registry.register(
      new Gauge("pi_remote_streaming_sessions", "Hosted sessions currently running a turn.", deps.streamingSessions),
    );
  }

  renderMetrics(): string {
    return this.registry.render();
  }

  promptSent(sessionId: string, kind: PromptKind, model: string): void {
    const state = this.stateFor(sessionId);
    if (!state.turn) state.pendingPromptAt = this.now();
    this.log({ event: "prompt", session_id: sessionId, model, kind });
  }

  modelSwitched(sessionId: string, from: string, to: string): void {
    this.log({ event: "model_switch", session_id: sessionId, from, to });
  }

  sessionEvent(sessionId: string, event: unknown): void {
    if (!isRecord(event) || typeof event.type !== "string") return;
    switch (event.type) {
      case "agent_start":
        this.beginTurn(sessionId);
        return;
      case "message_update":
        this.observeFirstToken(sessionId, event);
        return;
      case "message_end":
        this.accumulateUsage(sessionId, event.message);
        return;
      case "agent_end":
        this.finishTurn(sessionId);
        return;
    }
  }

  private stateFor(sessionId: string): SessionTelemetryState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { nextSeq: 1 };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private beginTurn(sessionId: string): void {
    const state = this.stateFor(sessionId);
    state.turn = {
      seq: state.nextSeq++,
      model: "unknown",
      startedAt: state.pendingPromptAt ?? this.now(),
      promptTokens: 0,
      cachedTokens: 0,
      completionTokens: 0,
    };
    state.pendingPromptAt = undefined;
  }

  private observeFirstToken(sessionId: string, event: Record<string, unknown>): void {
    const turn = this.sessions.get(sessionId)?.turn;
    if (!turn || turn.firstTokenAt !== undefined) return;
    if (!asAssistantMessage(event.message)) return;
    const streamEvent = event.assistantMessageEvent;
    if (isRecord(streamEvent) && streamEvent.type === "start") return;
    turn.firstTokenAt = this.now();
    const ttftSeconds = (turn.firstTokenAt - turn.startedAt) / 1000;
    this.ttftSeconds.observe({ model: this.turnModel(turn, event.message) }, ttftSeconds);
    this.log({
      event: "first_token",
      session_id: sessionId,
      model: turn.model,
      turn_seq: turn.seq,
      ttft_ms: Math.round(ttftSeconds * 1000),
    });
  }

  private accumulateUsage(sessionId: string, message: unknown): void {
    const turn = this.sessions.get(sessionId)?.turn;
    const assistant = asAssistantMessage(message);
    if (!turn || !assistant) return;
    turn.lastStopReason = typeof assistant.stopReason === "string" ? assistant.stopReason : turn.lastStopReason;
    const usage = asUsage(assistant.usage);
    if (!usage) return;
    const model = this.turnModel(turn, message);
    turn.promptTokens += usage.input;
    turn.cachedTokens += usage.cacheRead;
    turn.completionTokens += usage.output;
    this.promptTokens.inc({ model }, usage.input);
    this.cachedTokens.inc({ model }, usage.cacheRead);
    this.completionTokens.inc({ model }, usage.output);
  }

  private finishTurn(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    const turn = state?.turn;
    if (!state || !turn) return;
    state.turn = undefined;
    const endedAt = this.now();
    const durationSeconds = (endedAt - turn.startedAt) / 1000;
    const outcome = outcomeOf(turn.lastStopReason);
    this.durationSeconds.observe({ model: turn.model }, durationSeconds);
    this.turnsTotal.inc({ model: turn.model, outcome });
    const promptDenominator = turn.promptTokens + turn.cachedTokens;
    if (promptDenominator > 0) {
      this.cacheHitRatio.observe({ model: turn.model }, turn.cachedTokens / promptDenominator);
    }
    const ttftMs = turn.firstTokenAt !== undefined ? turn.firstTokenAt - turn.startedAt : undefined;
    const decodeSeconds = (endedAt - (turn.firstTokenAt ?? turn.startedAt)) / 1000;
    this.log({
      event: "turn",
      session_id: sessionId,
      model: turn.model,
      turn_seq: turn.seq,
      prompt_tokens: turn.promptTokens,
      cached_tokens: turn.cachedTokens,
      completion_tokens: turn.completionTokens,
      ttft_ms: ttftMs !== undefined ? Math.round(ttftMs) : null,
      duration_ms: Math.round(durationSeconds * 1000),
      tokens_per_sec: decodeSeconds > 0 ? round(turn.completionTokens / decodeSeconds, 2) : null,
      outcome,
    });
  }

  private turnModel(turn: ActiveTurn, message: unknown): string {
    const assistant = asAssistantMessage(message);
    if (assistant && typeof assistant.provider === "string" && typeof assistant.model === "string") {
      turn.model = `${assistant.provider}/${assistant.model}`;
    }
    return turn.model;
  }

  private log(fields: Record<string, unknown>): void {
    this.emitLog(JSON.stringify({ ts: this.wallClock(), ...fields }));
  }
}
