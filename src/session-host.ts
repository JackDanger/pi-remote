import type { SessionObserver } from "./telemetry.js";

export interface ModelSnapshot {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
}

/** Matches Pi's ImageContent shape structurally, without importing the SDK here. */
export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

/** The slice of Pi's AgentSession that SessionHost drives; AgentSession satisfies it structurally. */
export interface HostableSession {
  sessionId: string;
  sessionFile: string | undefined;
  sessionName?: string | undefined;
  model: { provider: string; id: string; name?: string } | undefined;
  thinkingLevel: string;
  isStreaming: boolean;
  messages: unknown[];
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string, options?: { images?: ImageContent[] }): Promise<void>;
  steer(text: string, images?: ImageContent[]): Promise<void>;
  followUp(text: string, images?: ImageContent[]): Promise<void>;
  abort(): Promise<void>;
  setThinkingLevel(level: never): void;
  setSessionName(name: string): void;
  dispose(): void;
}

export interface SessionOpenRequest {
  workspace?: string;
  sessionPath?: string;
  model?: string;
}

export interface OpenedSession {
  session: HostableSession;
  workspace: string;
}

export type SessionFactory = (request: SessionOpenRequest) => Promise<OpenedSession>;

export interface PersistedSessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  modified: Date;
  messageCount: number;
  firstMessage: string;
}

export interface SessionHostDeps {
  factory: SessionFactory;
  listPersisted: () => Promise<PersistedSessionInfo[]>;
  deletePersisted: (path: string) => Promise<void>;
  setSessionModel: (session: HostableSession, provider: string, modelId: string) => Promise<void>;
}

export interface AttachedClient {
  send(payload: unknown): void;
}

export interface SessionSummary {
  sessionId: string;
  path?: string;
  name?: string;
  workspace: string;
  active: boolean;
  streaming: boolean;
  modified: string;
  messageCount: number;
  firstMessage: string;
}

export interface AttachState {
  summary: SessionSummary;
  messages: unknown[];
  model?: ModelSnapshot;
  thinkingLevel: string;
}

interface LiveSession {
  session: HostableSession;
  workspace: string;
  clients: Set<AttachedClient>;
  unsubscribe: () => void;
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`No live session "${sessionId}" — attach after sessions.create or sessions.resume`);
  }
}

export class ServerDrainingError extends Error {
  constructor() {
    super("Server is shutting down — not accepting new work");
  }
}

/**
 * Outcome of a drain: `drained` sessions finished their running turn within the
 * deadline; `forced` sessions were still streaming when the deadline hit and must
 * be disposed mid-turn.
 */
export interface DrainResult {
  drained: string[];
  forced: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SessionHost {
  private readonly live = new Map<string, LiveSession>();
  private draining = false;

  constructor(
    private readonly deps: SessionHostDeps,
    private readonly observer?: SessionObserver,
  ) {}

  get isDraining(): boolean {
    return this.draining;
  }

  streamingSessionIds(): string[] {
    return [...this.live.entries()].filter(([, entry]) => entry.session.isStreaming).map(([id]) => id);
  }

  /**
   * Stop accepting new work and wait for every currently-running turn to finish.
   *
   * Drain waits only for the sessions streaming when it starts, and only until each
   * is first observed idle. Queued steers/followups that would begin a new turn do
   * not extend the drain: a session observed idle once is considered drained even if
   * it starts streaming again. Sessions still streaming at the deadline are returned
   * as `forced` for the caller to dispose. Attached clients keep receiving events
   * throughout.
   */
  async drain(deadlineMs: number, pollIntervalMs = 250): Promise<DrainResult> {
    this.draining = true;
    const pending = new Set(this.streamingSessionIds());
    const drained: string[] = [];
    const deadline = Date.now() + deadlineMs;
    while (pending.size > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await sleep(Math.min(pollIntervalMs, remainingMs));
      for (const id of [...pending]) {
        const entry = this.live.get(id);
        if (!entry || !entry.session.isStreaming) {
          pending.delete(id);
          drained.push(id);
        }
      }
    }
    return { drained, forced: [...pending] };
  }

  async createSession(workspace: string | undefined, model: string | undefined): Promise<SessionSummary> {
    this.rejectNewWorkWhileDraining();
    const opened = await this.deps.factory({ workspace, model });
    return this.adopt(opened);
  }

  async resumeSession(path: string): Promise<SessionSummary> {
    this.rejectNewWorkWhileDraining();
    for (const entry of this.live.values()) {
      if (entry.session.sessionFile === path) {
        return this.summarizeLive(entry);
      }
    }
    const opened = await this.deps.factory({ sessionPath: path });
    return this.adopt(opened);
  }

  async listSessions(): Promise<SessionSummary[]> {
    const persisted = await this.deps.listPersisted();
    const byPath = new Map<string, SessionSummary>();
    for (const info of persisted) {
      byPath.set(info.path, {
        sessionId: info.id,
        path: info.path,
        name: info.name,
        workspace: info.cwd,
        active: false,
        streaming: false,
        modified: info.modified.toISOString(),
        messageCount: info.messageCount,
        firstMessage: info.firstMessage,
      });
    }
    for (const entry of this.live.values()) {
      const summary = this.summarizeLive(entry);
      if (summary.path) byPath.set(summary.path, summary);
      else byPath.set(`live:${summary.sessionId}`, summary);
    }
    return [...byPath.values()].sort((a, b) => b.modified.localeCompare(a.modified));
  }

  async deleteSession(path: string): Promise<void> {
    for (const [id, entry] of this.live) {
      if (entry.session.sessionFile === path) {
        this.dropLive(id, entry);
      }
    }
    await this.deps.deletePersisted(path);
  }

  attach(sessionId: string, client: AttachedClient): AttachState {
    const entry = this.mustGetLive(sessionId);
    entry.clients.add(client);
    return {
      summary: this.summarizeLive(entry),
      messages: entry.session.messages,
      model: toModelSnapshot(entry.session.model),
      thinkingLevel: entry.session.thinkingLevel,
    };
  }

  detach(sessionId: string, client: AttachedClient): void {
    this.live.get(sessionId)?.clients.delete(client);
  }

  detachEverywhere(client: AttachedClient): void {
    for (const entry of this.live.values()) {
      entry.clients.delete(client);
    }
  }

  prompt(sessionId: string, text: string, images?: ImageContent[]): void {
    this.rejectNewWorkWhileDraining();
    const entry = this.mustGetLive(sessionId);
    const steering = entry.session.isStreaming;
    this.observer?.promptSent(sessionId, steering ? "steer" : "prompt", formatModel(entry.session.model));
    const run = steering
      ? entry.session.steer(text, images)
      : entry.session.prompt(text, images?.length ? { images } : undefined);
    run.catch((error: unknown) => this.broadcastError(sessionId, error));
  }

  steer(sessionId: string, text: string, images?: ImageContent[]): void {
    this.rejectNewWorkWhileDraining();
    const entry = this.mustGetLive(sessionId);
    this.observer?.promptSent(sessionId, "steer", formatModel(entry.session.model));
    entry.session.steer(text, images).catch((error: unknown) => this.broadcastError(sessionId, error));
  }

  followUp(sessionId: string, text: string, images?: ImageContent[]): void {
    this.rejectNewWorkWhileDraining();
    const entry = this.mustGetLive(sessionId);
    this.observer?.promptSent(sessionId, "followup", formatModel(entry.session.model));
    entry.session.followUp(text, images).catch((error: unknown) => this.broadcastError(sessionId, error));
  }

  async abort(sessionId: string): Promise<void> {
    await this.mustGetLive(sessionId).session.abort();
  }

  async setModel(sessionId: string, provider: string, modelId: string): Promise<ModelSnapshot | undefined> {
    const entry = this.mustGetLive(sessionId);
    const before = formatModel(entry.session.model);
    await this.deps.setSessionModel(entry.session, provider, modelId);
    const after = formatModel(entry.session.model);
    if (after !== before) this.observer?.modelSwitched(sessionId, before, after);
    return toModelSnapshot(entry.session.model);
  }

  setThinkingLevel(sessionId: string, level: string): string {
    const entry = this.mustGetLive(sessionId);
    entry.session.setThinkingLevel(level as never);
    return entry.session.thinkingLevel;
  }

  rename(sessionId: string, name: string): string {
    const entry = this.mustGetLive(sessionId);
    entry.session.setSessionName(name);
    return entry.session.sessionName ?? name;
  }

  liveSessionIds(): string[] {
    return [...this.live.keys()];
  }

  disposeAll(): void {
    for (const [id, entry] of this.live) {
      this.dropLive(id, entry);
    }
  }

  private adopt(opened: OpenedSession): SessionSummary {
    const { session, workspace } = opened;
    const existing = this.live.get(session.sessionId);
    if (existing) return this.summarizeLive(existing);
    const entry: LiveSession = {
      session,
      workspace,
      clients: new Set(),
      unsubscribe: () => {},
    };
    entry.unsubscribe = session.subscribe((event) => {
      this.observer?.sessionEvent(session.sessionId, event);
      const payload = { type: "session_event", sessionId: session.sessionId, event };
      for (const client of entry.clients) {
        client.send(payload);
      }
    });
    this.live.set(session.sessionId, entry);
    return this.summarizeLive(entry);
  }

  private dropLive(id: string, entry: LiveSession): void {
    entry.unsubscribe();
    entry.session.dispose();
    entry.clients.clear();
    this.live.delete(id);
  }

  private rejectNewWorkWhileDraining(): void {
    if (this.draining) throw new ServerDrainingError();
  }

  private mustGetLive(sessionId: string): LiveSession {
    const entry = this.live.get(sessionId);
    if (!entry) throw new SessionNotFoundError(sessionId);
    return entry;
  }

  private summarizeLive(entry: LiveSession): SessionSummary {
    const { session } = entry;
    const messages = session.messages;
    const firstUser = messages.find(
      (m): m is { role: string; content: unknown } =>
        typeof m === "object" && m !== null && (m as { role?: string }).role === "user",
    );
    return {
      sessionId: session.sessionId,
      path: session.sessionFile,
      name: session.sessionName ?? undefined,
      workspace: entry.workspace,
      active: true,
      streaming: session.isStreaming,
      modified: new Date().toISOString(),
      messageCount: messages.length,
      firstMessage: extractText(firstUser?.content),
    };
  }

  private broadcastError(sessionId: string, error: unknown): void {
    const entry = this.live.get(sessionId);
    if (!entry) return;
    const payload = {
      type: "session_error",
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    };
    for (const client of entry.clients) {
      client.send(payload);
    }
  }
}

function formatModel(model: { provider: string; id: string } | undefined): string {
  return model ? `${model.provider}/${model.id}` : "unknown";
}

function toModelSnapshot(
  model: { provider: string; id: string; name?: string; reasoning?: boolean } | undefined,
): ModelSnapshot | undefined {
  return model
    ? { provider: model.provider, id: model.id, name: model.name, reasoning: model.reasoning }
    : undefined;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content.slice(0, 200);
  if (Array.isArray(content)) {
    const texts = content
      .filter((c): c is { type: string; text: string } => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text);
    return texts.join(" ").slice(0, 200);
  }
  return "";
}
