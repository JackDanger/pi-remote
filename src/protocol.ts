export interface ImageAttachment {
  data: string;
  mimeType: string;
}

export type ClientRequest =
  | { id: number; type: "sessions.list" }
  | { id: number; type: "sessions.create"; workspace?: string; model?: string }
  | { id: number; type: "sessions.resume"; path: string }
  | { id: number; type: "sessions.delete"; path: string }
  | { id: number; type: "session.attach"; sessionId: string }
  | { id: number; type: "session.detach"; sessionId: string }
  | { id: number; type: "session.prompt"; sessionId: string; text: string; images?: ImageAttachment[] }
  | { id: number; type: "session.steer"; sessionId: string; text: string; images?: ImageAttachment[] }
  | { id: number; type: "session.followup"; sessionId: string; text: string; images?: ImageAttachment[] }
  | { id: number; type: "session.abort"; sessionId: string }
  | { id: number; type: "session.compact"; sessionId: string; instructions?: string }
  | { id: number; type: "session.compact_abort"; sessionId: string }
  | { id: number; type: "session.set_model"; sessionId: string; provider: string; modelId: string }
  | { id: number; type: "session.set_thinking"; sessionId: string; level: string }
  | { id: number; type: "session.rename"; sessionId: string; name: string }
  | { id: number; type: "models.list" }
  | { id: number; type: "ping" };

export type RequestType = ClientRequest["type"];

const REQUIRED_STRING_FIELDS: Record<RequestType, readonly string[]> = {
  "sessions.list": [],
  "sessions.create": [],
  "sessions.resume": ["path"],
  "sessions.delete": ["path"],
  "session.attach": ["sessionId"],
  "session.detach": ["sessionId"],
  "session.prompt": ["sessionId", "text"],
  "session.steer": ["sessionId", "text"],
  "session.followup": ["sessionId", "text"],
  "session.abort": ["sessionId"],
  "session.compact": ["sessionId"],
  "session.compact_abort": ["sessionId"],
  "session.set_model": ["sessionId", "provider", "modelId"],
  "session.set_thinking": ["sessionId", "level"],
  "session.rename": ["sessionId", "name"],
  "models.list": [],
  ping: [],
};

const IMAGE_CAPABLE_TYPES = new Set<RequestType>(["session.prompt", "session.steer", "session.followup"]);

export const MAX_IMAGES_PER_MESSAGE = 8;

export class ProtocolError extends Error {}

function validateImages(msg: Record<string, unknown>, type: RequestType): void {
  if (msg.images === undefined) return;
  if (!IMAGE_CAPABLE_TYPES.has(type)) {
    throw new ProtocolError(`Request "${type}" does not accept images`);
  }
  if (!Array.isArray(msg.images)) {
    throw new ProtocolError(`Request "${type}" field "images" must be an array`);
  }
  if (msg.images.length > MAX_IMAGES_PER_MESSAGE) {
    throw new ProtocolError(`At most ${MAX_IMAGES_PER_MESSAGE} images per message`);
  }
  for (const image of msg.images as unknown[]) {
    const record = image as Record<string, unknown> | null;
    if (
      typeof record !== "object" ||
      record === null ||
      typeof record.data !== "string" ||
      record.data === "" ||
      typeof record.mimeType !== "string" ||
      !record.mimeType.startsWith("image/")
    ) {
      throw new ProtocolError(`Each image needs base64 "data" and an image/* "mimeType"`);
    }
  }
}

export function parseClientRequest(raw: string): ClientRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProtocolError("Message is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ProtocolError("Message must be a JSON object");
  }
  const msg = parsed as Record<string, unknown>;
  if (typeof msg.id !== "number") {
    throw new ProtocolError("Message must carry a numeric id");
  }
  const type = msg.type;
  if (typeof type !== "string" || !(type in REQUIRED_STRING_FIELDS)) {
    throw new ProtocolError(`Unknown request type "${String(type)}"`);
  }
  for (const field of REQUIRED_STRING_FIELDS[type as RequestType]) {
    const emptyAllowed = field === "text" && Array.isArray(msg.images) && msg.images.length > 0;
    if (typeof msg[field] !== "string" || (msg[field] === "" && !emptyAllowed)) {
      throw new ProtocolError(`Request "${type}" requires string field "${field}"`);
    }
  }
  validateImages(msg, type as RequestType);
  return msg as unknown as ClientRequest;
}

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
