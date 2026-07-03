export type ClientRequest =
  | { id: number; type: "sessions.list" }
  | { id: number; type: "sessions.create"; workspace?: string; model?: string }
  | { id: number; type: "sessions.resume"; path: string }
  | { id: number; type: "sessions.delete"; path: string }
  | { id: number; type: "session.attach"; sessionId: string }
  | { id: number; type: "session.detach"; sessionId: string }
  | { id: number; type: "session.prompt"; sessionId: string; text: string }
  | { id: number; type: "session.steer"; sessionId: string; text: string }
  | { id: number; type: "session.followup"; sessionId: string; text: string }
  | { id: number; type: "session.abort"; sessionId: string }
  | { id: number; type: "session.set_model"; sessionId: string; provider: string; modelId: string }
  | { id: number; type: "session.set_thinking"; sessionId: string; level: string }
  | { id: number; type: "models.list" };

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
  "session.set_model": ["sessionId", "provider", "modelId"],
  "session.set_thinking": ["sessionId", "level"],
  "models.list": [],
};

export class ProtocolError extends Error {}

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
    if (typeof msg[field] !== "string" || msg[field] === "") {
      throw new ProtocolError(`Request "${type}" requires string field "${field}"`);
    }
  }
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

export interface SessionErrorPush {
  type: "session_error";
  sessionId: string;
  error: string;
}

export interface SessionsChangedPush {
  type: "sessions_changed";
}

export type ServerPush = SessionEventPush | SessionErrorPush | SessionsChangedPush;
