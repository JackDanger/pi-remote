export interface ImageAttachment {
    data: string;
    mimeType: string;
}
export type ClientRequest = {
    id: number;
    type: "sessions.list";
} | {
    id: number;
    type: "sessions.create";
    workspace?: string;
    model?: string;
} | {
    id: number;
    type: "sessions.resume";
    path: string;
} | {
    id: number;
    type: "sessions.delete";
    path: string;
} | {
    id: number;
    type: "session.attach";
    sessionId: string;
} | {
    id: number;
    type: "session.detach";
    sessionId: string;
} | {
    id: number;
    type: "session.prompt";
    sessionId: string;
    text: string;
    images?: ImageAttachment[];
} | {
    id: number;
    type: "session.steer";
    sessionId: string;
    text: string;
    images?: ImageAttachment[];
} | {
    id: number;
    type: "session.followup";
    sessionId: string;
    text: string;
    images?: ImageAttachment[];
} | {
    id: number;
    type: "session.command";
    sessionId: string;
    text: string;
} | {
    id: number;
    type: "session.abort";
    sessionId: string;
} | {
    id: number;
    type: "session.compact";
    sessionId: string;
    instructions?: string;
} | {
    id: number;
    type: "session.compact_abort";
    sessionId: string;
} | {
    id: number;
    type: "session.set_model";
    sessionId: string;
    provider: string;
    modelId: string;
} | {
    id: number;
    type: "session.set_thinking";
    sessionId: string;
    level: string;
} | {
    id: number;
    type: "session.rename";
    sessionId: string;
    name: string;
} | {
    id: number;
    type: "commands.list";
    sessionId: string;
} | {
    id: number;
    type: "models.list";
} | {
    id: number;
    type: "ping";
};
export type RequestType = ClientRequest["type"];
export declare const MAX_IMAGES_PER_MESSAGE = 8;
export declare class ProtocolError extends Error {
}
export declare function parseClientRequest(raw: string): ClientRequest;
export interface OkResponse {
    id: number;
    ok: true;
    result: unknown;
}
export interface ErrorResponse {
    id: number;
    ok: false;
    error: string;
}
export type ServerResponse = OkResponse | ErrorResponse;
export interface SessionEventPush {
    type: "session_event";
    sessionId: string;
    event: unknown;
}
export type TurnPhase = "waiting" | "responding" | "idle";
export type TurnOutcome = "ok" | "error" | "aborted";
export interface TelemetrySnapshot {
    phase: TurnPhase;
    turnSeq: number;
    model: string;
    elapsedMs: number;
    ttftMs: number | null;
    promptTokens: number;
    cachedTokens: number;
    completionTokens: number;
    tokensPerSec: number | null;
    cacheHitRatio: number | null;
    outcome: TurnOutcome | null;
}
export interface SessionTelemetryPush {
    type: "session_telemetry";
    sessionId: string;
    telemetry: TelemetrySnapshot;
}
export interface SessionErrorPush {
    type: "session_error";
    sessionId: string;
    error: string;
}
export interface SessionsChangedPush {
    type: "sessions_changed";
}
export type ServerPush = SessionEventPush | SessionTelemetryPush | SessionErrorPush | SessionsChangedPush;
