import { Counter, Gauge, Histogram, MetricsRegistry } from "./metrics.js";
import type { TelemetrySnapshot, TurnOutcome, TurnPhase } from "./protocol.js";

export type PromptKind = "prompt" | "steer" | "followup" | "command";

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
  onSnapshot?: (sessionId: string, snapshot: TelemetrySnapshot) => void;
}

const TTFT_BUCKETS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 240];
const DURATION_BUCKETS = [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 1200];
const CACHE_RATIO_BUCKETS = [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 1];
const STREAMING_SNAPSHOT_INTERVAL_MS = 500;
const ESTIMATED_CHARS_PER_TOKEN = 4;

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
  streamedCharsSinceUsage: number;
  lastSnapshotAt: number;
  lastStopReason?: string;
}

interface SessionTelemetryState {
  nextSeq: number;
  pendingPromptAt?: number;
  turn?: ActiveTurn;
  lastFinalSnapshot?: TelemetrySnapshot;
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

function outcomeOf(stopReason: string | undefined): TurnOutcome {
  if (stopReason === "error") return "error";
  if (stopReason === "aborted") return "aborted";
  return "ok";
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function cacheHitRatioOf(turn: ActiveTurn): number | null {
  const promptDenominator = turn.promptTokens + turn.cachedTokens;
  return promptDenominator > 0 ? round(turn.cachedTokens / promptDenominator, 3) : null;
}

function estimatedTokens(streamedChars: number): number {
  return Math.round(streamedChars / ESTIMATED_CHARS_PER_TOKEN);
}

function adoptReportedModel(turn: ActiveTurn, message: unknown): void {
  const assistant = asAssistantMessage(message);
  if (assistant && typeof assistant.provider === "string" && typeof assistant.model === "string") {
    turn.model = `${assistant.provider}/${assistant.model}`;
  }
}

interface TurnReading {
  phase: TurnPhase;
  at: number;
  completionTokens: number;
  decodeStartedAt: number | undefined;
  outcome: TurnOutcome | null;
}

function liveReading(turn: ActiveTurn, at: number): TurnReading {
  return {
    phase: turn.firstTokenAt === undefined ? "waiting" : "responding",
    at,
    completionTokens: turn.completionTokens + estimatedTokens(turn.streamedCharsSinceUsage),
    decodeStartedAt: turn.firstTokenAt,
    outcome: null,
  };
}

function finishedReading(turn: ActiveTurn, endedAt: number, outcome: TurnOutcome): TurnReading {
  return {
    phase: "idle",
    at: endedAt,
    completionTokens: turn.completionTokens,
    decodeStartedAt: turn.firstTokenAt ?? turn.startedAt,
    outcome,
  };
}

function snapshotOf(turn: ActiveTurn, reading: TurnReading): TelemetrySnapshot {
  const decodeSeconds = reading.decodeStartedAt !== undefined ? (reading.at - reading.decodeStartedAt) / 1000 : 0;
  return {
    phase: reading.phase,
    turnSeq: turn.seq,
    model: turn.model,
    elapsedMs: Math.round(reading.at - turn.startedAt),
    ttftMs: turn.firstTokenAt !== undefined ? Math.round(turn.firstTokenAt - turn.startedAt) : null,
    promptTokens: turn.promptTokens,
    cachedTokens: turn.cachedTokens,
    completionTokens: reading.completionTokens,
    tokensPerSec:
      decodeSeconds > 0 && reading.completionTokens > 0 ? round(reading.completionTokens / decodeSeconds, 2) : null,
    cacheHitRatio: cacheHitRatioOf(turn),
    outcome: reading.outcome,
  };
}

export class Telemetry implements SessionObserver {
  private readonly registry = new MetricsRegistry();
  private readonly sessions = new Map<string, SessionTelemetryState>();
  private readonly now: () => number;
  private readonly wallClock: () => string;
  private readonly emitLog: (line: string) => void;
  private readonly onSnapshot?: (sessionId: string, snapshot: TelemetrySnapshot) => void;

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
    this.onSnapshot = deps.onSnapshot;
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

  snapshot(sessionId: string): TelemetrySnapshot | undefined {
    const state = this.sessions.get(sessionId);
    if (!state) return undefined;
    return state.turn ? snapshotOf(state.turn, liveReading(state.turn, this.now())) : state.lastFinalSnapshot;
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
        this.observeStreamProgress(sessionId, event);
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
      streamedCharsSinceUsage: 0,
      lastSnapshotAt: 0,
    };
    state.pendingPromptAt = undefined;
    this.emitSnapshot(sessionId, state.turn);
  }

  private observeFirstToken(sessionId: string, event: Record<string, unknown>): void {
    const turn = this.sessions.get(sessionId)?.turn;
    if (!turn || turn.firstTokenAt !== undefined) return;
    if (!asAssistantMessage(event.message)) return;
    const streamEvent = event.assistantMessageEvent;
    if (isRecord(streamEvent) && streamEvent.type === "start") return;
    turn.firstTokenAt = this.now();
    const ttftSeconds = (turn.firstTokenAt - turn.startedAt) / 1000;
    adoptReportedModel(turn, event.message);
    this.ttftSeconds.observe({ model: turn.model }, ttftSeconds);
    this.log({
      event: "first_token",
      session_id: sessionId,
      model: turn.model,
      turn_seq: turn.seq,
      ttft_ms: Math.round(ttftSeconds * 1000),
    });
    this.emitSnapshot(sessionId, turn);
  }

  private observeStreamProgress(sessionId: string, event: Record<string, unknown>): void {
    const turn = this.sessions.get(sessionId)?.turn;
    if (!turn || !asAssistantMessage(event.message)) return;
    const streamEvent = event.assistantMessageEvent;
    if (!isRecord(streamEvent) || typeof streamEvent.delta !== "string") return;
    turn.streamedCharsSinceUsage += streamEvent.delta.length;
    if (this.now() - turn.lastSnapshotAt >= STREAMING_SNAPSHOT_INTERVAL_MS) {
      this.emitSnapshot(sessionId, turn);
    }
  }

  private accumulateUsage(sessionId: string, message: unknown): void {
    const turn = this.sessions.get(sessionId)?.turn;
    const assistant = asAssistantMessage(message);
    if (!turn || !assistant) return;
    turn.lastStopReason = typeof assistant.stopReason === "string" ? assistant.stopReason : turn.lastStopReason;
    const usage = asUsage(assistant.usage);
    if (!usage) return;
    adoptReportedModel(turn, message);
    turn.promptTokens += usage.input;
    turn.cachedTokens += usage.cacheRead;
    turn.completionTokens += usage.output;
    turn.streamedCharsSinceUsage = 0;
    this.promptTokens.inc({ model: turn.model }, usage.input);
    this.cachedTokens.inc({ model: turn.model }, usage.cacheRead);
    this.completionTokens.inc({ model: turn.model }, usage.output);
    this.emitSnapshot(sessionId, turn);
  }

  private finishTurn(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    const turn = state?.turn;
    if (!state || !turn) return;
    state.turn = undefined;
    const endedAt = this.now();
    const outcome = outcomeOf(turn.lastStopReason);
    this.durationSeconds.observe({ model: turn.model }, (endedAt - turn.startedAt) / 1000);
    this.turnsTotal.inc({ model: turn.model, outcome });
    const promptDenominator = turn.promptTokens + turn.cachedTokens;
    if (promptDenominator > 0) {
      this.cacheHitRatio.observe({ model: turn.model }, turn.cachedTokens / promptDenominator);
    }
    const finalSnapshot = snapshotOf(turn, finishedReading(turn, endedAt, outcome));
    this.log({
      event: "turn",
      session_id: sessionId,
      model: turn.model,
      turn_seq: turn.seq,
      prompt_tokens: turn.promptTokens,
      cached_tokens: turn.cachedTokens,
      completion_tokens: turn.completionTokens,
      ttft_ms: finalSnapshot.ttftMs,
      duration_ms: finalSnapshot.elapsedMs,
      tokens_per_sec: finalSnapshot.tokensPerSec,
      outcome,
    });
    state.lastFinalSnapshot = finalSnapshot;
    this.onSnapshot?.(sessionId, finalSnapshot);
  }

  private emitSnapshot(sessionId: string, turn: ActiveTurn): void {
    if (!this.onSnapshot) return;
    turn.lastSnapshotAt = this.now();
    this.onSnapshot(sessionId, snapshotOf(turn, liveReading(turn, turn.lastSnapshotAt)));
  }

  private log(fields: Record<string, unknown>): void {
    this.emitLog(JSON.stringify({ ts: this.wallClock(), ...fields }));
  }
}
