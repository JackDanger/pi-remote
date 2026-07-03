export interface ModelSnapshot {
  provider: string;
  id: string;
  name?: string;
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
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  setThinkingLevel(level: never): void;
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

export class SessionHost {
  private readonly live = new Map<string, LiveSession>();

  constructor(private readonly deps: SessionHostDeps) {}

  async createSession(workspace: string | undefined, model: string | undefined): Promise<SessionSummary> {
    const opened = await this.deps.factory({ workspace, model });
    return this.adopt(opened);
  }

  async resumeSession(path: string): Promise<SessionSummary> {
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

  prompt(sessionId: string, text: string): void {
    const entry = this.mustGetLive(sessionId);
    const run = entry.session.isStreaming ? entry.session.steer(text) : entry.session.prompt(text);
    run.catch((error: unknown) => this.broadcastError(sessionId, error));
  }

  steer(sessionId: string, text: string): void {
    const entry = this.mustGetLive(sessionId);
    entry.session.steer(text).catch((error: unknown) => this.broadcastError(sessionId, error));
  }

  followUp(sessionId: string, text: string): void {
    const entry = this.mustGetLive(sessionId);
    entry.session.followUp(text).catch((error: unknown) => this.broadcastError(sessionId, error));
  }

  async abort(sessionId: string): Promise<void> {
    await this.mustGetLive(sessionId).session.abort();
  }

  async setModel(sessionId: string, provider: string, modelId: string): Promise<ModelSnapshot | undefined> {
    const entry = this.mustGetLive(sessionId);
    await this.deps.setSessionModel(entry.session, provider, modelId);
    return toModelSnapshot(entry.session.model);
  }

  setThinkingLevel(sessionId: string, level: string): string {
    const entry = this.mustGetLive(sessionId);
    entry.session.setThinkingLevel(level as never);
    return entry.session.thinkingLevel;
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

function toModelSnapshot(
  model: { provider: string; id: string; name?: string } | undefined,
): ModelSnapshot | undefined {
  return model ? { provider: model.provider, id: model.id, name: model.name } : undefined;
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
