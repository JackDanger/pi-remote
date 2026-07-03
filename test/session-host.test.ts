import { describe, expect, it } from "vitest";
import {
  type HostableSession,
  type ImageContent,
  type PersistedSessionInfo,
  SessionHost,
  SessionNotFoundError,
} from "../src/session-host.js";

class FakeSession implements HostableSession {
  sessionId: string;
  sessionFile: string | undefined;
  sessionName: string | undefined = undefined;
  model: { provider: string; id: string } | undefined = { provider: "fake", id: "model" };
  thinkingLevel = "off";
  isStreaming = false;
  messages: unknown[] = [];
  disposed = false;
  prompts: string[] = [];
  promptImages: ImageContent[][] = [];
  steers: string[] = [];
  steerImages: ImageContent[][] = [];
  followUps: string[] = [];
  aborted = 0;
  private listeners = new Set<(event: unknown) => void>();

  constructor(id: string, file?: string) {
    this.sessionId = id;
    this.sessionFile = file;
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: unknown): void {
    for (const l of this.listeners) l(event);
  }

  async prompt(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    this.prompts.push(text);
    this.promptImages.push(options?.images ?? []);
  }

  async steer(text: string, images?: ImageContent[]): Promise<void> {
    this.steers.push(text);
    this.steerImages.push(images ?? []);
  }

  async followUp(text: string): Promise<void> {
    this.followUps.push(text);
  }

  async abort(): Promise<void> {
    this.aborted++;
  }

  setThinkingLevel(level: never): void {
    this.thinkingLevel = level;
  }

  setSessionName(name: string): void {
    this.sessionName = name;
  }

  dispose(): void {
    this.disposed = true;
  }
}

class Recorder {
  received: unknown[] = [];
  send(payload: unknown): void {
    this.received.push(payload);
  }
}

function makeHost(sessions: Map<string, FakeSession>, persisted: PersistedSessionInfo[] = []) {
  const deleted: string[] = [];
  const host = new SessionHost({
    factory: async (request) => {
      const key = request.sessionPath ?? request.workspace ?? "default";
      const session = sessions.get(key);
      if (!session) throw new Error(`no fake session for ${key}`);
      return { session, workspace: request.workspace ?? "/ws" };
    },
    listPersisted: async () => persisted,
    deletePersisted: async (path) => {
      deleted.push(path);
    },
    setSessionModel: async (session, provider, modelId) => {
      (session as FakeSession).model = { provider, id: modelId };
    },
  });
  return { host, deleted };
}

describe("SessionHost", () => {
  it("creates a session and fans events out to every attached client", async () => {
    const fake = new FakeSession("s1", "/sessions/s1.jsonl");
    const { host } = makeHost(new Map([["ws-a", fake]]));
    const summary = await host.createSession("ws-a", undefined);
    expect(summary.sessionId).toBe("s1");
    expect(summary.active).toBe(true);

    const clientA = new Recorder();
    const clientB = new Recorder();
    host.attach("s1", clientA);
    host.attach("s1", clientB);

    fake.emit({ type: "agent_start" });
    expect(clientA.received).toEqual([{ type: "session_event", sessionId: "s1", event: { type: "agent_start" } }]);
    expect(clientB.received).toHaveLength(1);

    host.detach("s1", clientB);
    fake.emit({ type: "agent_end" });
    expect(clientA.received).toHaveLength(2);
    expect(clientB.received).toHaveLength(1);
  });

  it("routes prompt to steer while the session is streaming", async () => {
    const fake = new FakeSession("s1");
    const { host } = makeHost(new Map([["ws-a", fake]]));
    await host.createSession("ws-a", undefined);

    host.prompt("s1", "first");
    fake.isStreaming = true;
    host.prompt("s1", "second");

    expect(fake.prompts).toEqual(["first"]);
    expect(fake.steers).toEqual(["second"]);
  });

  it("passes image attachments through prompt and steer", async () => {
    const fake = new FakeSession("s1");
    const { host } = makeHost(new Map([["ws-a", fake]]));
    await host.createSession("ws-a", undefined);
    const images: ImageContent[] = [{ type: "image", data: "aGk=", mimeType: "image/png" }];

    host.prompt("s1", "look at this", images);
    expect(fake.promptImages).toEqual([images]);

    fake.isStreaming = true;
    host.prompt("s1", "and this", images);
    expect(fake.steerImages).toEqual([images]);
  });

  it("renames a live session", async () => {
    const fake = new FakeSession("s1");
    const { host } = makeHost(new Map([["ws-a", fake]]));
    await host.createSession("ws-a", undefined);
    expect(host.rename("s1", "My project")).toBe("My project");
    expect(fake.sessionName).toBe("My project");
    expect(() => host.rename("nope", "x")).toThrow(SessionNotFoundError);
  });

  it("merges live and persisted sessions, deduped by path", async () => {
    const fake = new FakeSession("s1", "/sessions/s1.jsonl");
    const persisted: PersistedSessionInfo[] = [
      {
        path: "/sessions/s1.jsonl",
        id: "s1",
        cwd: "/ws",
        modified: new Date("2026-01-01"),
        messageCount: 3,
        firstMessage: "old view",
      },
      {
        path: "/sessions/s2.jsonl",
        id: "s2",
        cwd: "/other",
        modified: new Date("2026-01-02"),
        messageCount: 1,
        firstMessage: "dormant",
      },
    ];
    const { host } = makeHost(new Map([["ws-a", fake]]), persisted);
    await host.createSession("ws-a", undefined);

    const sessions = await host.listSessions();
    expect(sessions).toHaveLength(2);
    const live = sessions.find((s) => s.sessionId === "s1");
    const dormant = sessions.find((s) => s.sessionId === "s2");
    expect(live?.active).toBe(true);
    expect(dormant?.active).toBe(false);
  });

  it("resume returns the existing live session for the same path", async () => {
    const fake = new FakeSession("s1", "/sessions/s1.jsonl");
    const { host } = makeHost(new Map([["ws-a", fake]]));
    await host.createSession("ws-a", undefined);
    const summary = await host.resumeSession("/sessions/s1.jsonl");
    expect(summary.sessionId).toBe("s1");
    expect(host.liveSessionIds()).toEqual(["s1"]);
  });

  it("delete disposes the live session and removes the file", async () => {
    const fake = new FakeSession("s1", "/sessions/s1.jsonl");
    const { host, deleted } = makeHost(new Map([["ws-a", fake]]));
    await host.createSession("ws-a", undefined);
    await host.deleteSession("/sessions/s1.jsonl");
    expect(fake.disposed).toBe(true);
    expect(deleted).toEqual(["/sessions/s1.jsonl"]);
    expect(host.liveSessionIds()).toEqual([]);
  });

  it("detachEverywhere removes a client from all sessions", async () => {
    const fakeA = new FakeSession("sa");
    const fakeB = new FakeSession("sb");
    const { host } = makeHost(
      new Map([
        ["ws-a", fakeA],
        ["ws-b", fakeB],
      ]),
    );
    await host.createSession("ws-a", undefined);
    await host.createSession("ws-b", undefined);
    const client = new Recorder();
    host.attach("sa", client);
    host.attach("sb", client);
    host.detachEverywhere(client);
    fakeA.emit({ type: "agent_start" });
    fakeB.emit({ type: "agent_start" });
    expect(client.received).toHaveLength(0);
  });

  it("throws SessionNotFoundError for unknown live sessions", () => {
    const { host } = makeHost(new Map());
    expect(() => host.prompt("nope", "hi")).toThrow(SessionNotFoundError);
  });
});
