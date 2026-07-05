import type { TelemetrySnapshot } from "./protocol.js";
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
export declare class Telemetry implements SessionObserver {
    private readonly registry;
    private readonly sessions;
    private readonly now;
    private readonly wallClock;
    private readonly emitLog;
    private readonly onSnapshot?;
    private readonly promptTokens;
    private readonly cachedTokens;
    private readonly completionTokens;
    private readonly ttftSeconds;
    private readonly durationSeconds;
    private readonly cacheHitRatio;
    private readonly turnsTotal;
    constructor(deps: TelemetryDeps);
    renderMetrics(): string;
    snapshot(sessionId: string): TelemetrySnapshot | undefined;
    promptSent(sessionId: string, kind: PromptKind, model: string): void;
    modelSwitched(sessionId: string, from: string, to: string): void;
    sessionEvent(sessionId: string, event: unknown): void;
    private stateFor;
    private beginTurn;
    private observeFirstToken;
    private observeStreamProgress;
    private accumulateUsage;
    private finishTurn;
    private emitSnapshot;
    private log;
}
