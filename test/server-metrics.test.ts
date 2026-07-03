import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type HostableSession, SessionHost } from "../src/session-host.js";
import { startServer } from "../src/server.js";
import { Telemetry } from "../src/telemetry.js";

class FakeSession implements HostableSession {
  sessionId = "s1";
  sessionFile: string | undefined = undefined;
  sessionName: string | undefined = undefined;
  model: { provider: string; id: string } | undefined = { provider: "solvency", id: "qwen-fast" };
  thinkingLevel = "off";
  isStreaming = false;
  messages: unknown[] = [];
  private listeners = new Set<(event: unknown) => void>();

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: unknown): void {
    for (const l of this.listeners) l(event);
  }

  async prompt(): Promise<void> {}
  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  async abort(): Promise<void> {}
  setThinkingLevel(): void {}
  setSessionName(): void {}
  dispose(): void {}
}

function makeHost(fake: FakeSession, telemetry: Telemetry): SessionHost {
  return new SessionHost(
    {
      factory: async () => ({ session: fake, workspace: "/ws" }),
      listPersisted: async () => [],
      deletePersisted: async () => {},
      setSessionModel: async (session, provider, modelId) => {
        (session as FakeSession).model = { provider, id: modelId };
      },
    },
    telemetry,
  );
}

function makeTelemetry(host: () => SessionHost, logs: string[]): Telemetry {
  return new Telemetry({
    liveSessions: () => host().liveSessionIds().length,
    streamingSessions: () => host().streamingSessionIds().length,
    emitLog: (line) => logs.push(line),
  });
}

async function get(port: number, pathname: string): Promise<{ status: number; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: pathname }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += String(chunk)));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, contentType: String(res.headers["content-type"] ?? ""), body }),
        );
      })
      .on("error", reject);
  });
}

describe("SessionHost telemetry wiring", () => {
  it("feeds prompts, session events, and model switches into the observer", async () => {
    const fake = new FakeSession();
    const logs: string[] = [];
    let host!: SessionHost;
    const telemetry = makeTelemetry(() => host, logs);
    host = makeHost(fake, telemetry);
    await host.createSession("ws", undefined);

    host.prompt("s1", "hello");
    fake.emit({ type: "agent_start" });
    fake.emit({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "solvency",
        model: "qwen-fast",
        stopReason: "stop",
        usage: { input: 11, output: 22, cacheRead: 33, cacheWrite: 0, totalTokens: 66 },
      },
    });
    fake.emit({ type: "agent_end" });
    await host.setModel("s1", "solvency", "qwen-strong");

    const parsed = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.find((l) => l.event === "prompt")).toMatchObject({ model: "solvency/qwen-fast", kind: "prompt" });
    expect(parsed.find((l) => l.event === "turn")).toMatchObject({
      prompt_tokens: 11,
      completion_tokens: 22,
      cached_tokens: 33,
      outcome: "ok",
      session_id: "s1",
    });
    expect(parsed.find((l) => l.event === "model_switch")).toMatchObject({
      from: "solvency/qwen-fast",
      to: "solvency/qwen-strong",
    });
    const metrics = telemetry.renderMetrics();
    expect(metrics).toContain('pi_remote_turns_total{model="solvency/qwen-fast",outcome="ok"} 1');
    expect(metrics).toContain("pi_remote_live_sessions 1");
  });
});

describe("GET /metrics", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
    servers.length = 0;
  });

  async function listen(renderMetrics?: () => string): Promise<number> {
    const fake = new FakeSession();
    const logs: string[] = [];
    let host!: SessionHost;
    const telemetry = makeTelemetry(() => host, logs);
    host = makeHost(fake, telemetry);
    const server = startServer({
      host: "127.0.0.1",
      port: 0,
      sessionHost: host,
      listModels: () => [],
      workspaceRoot: "/ws",
      webRoot: fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-test-")),
      renderMetrics: renderMetrics ?? (() => telemetry.renderMetrics()),
    });
    servers.push(server);
    await new Promise((resolve) => server.on("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    return address.port;
  }

  it("serves the Prometheus exposition unauthenticated without breaking /healthz", async () => {
    const port = await listen();
    const metrics = await get(port, "/metrics");
    expect(metrics.status).toBe(200);
    expect(metrics.contentType).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(metrics.body).toContain("# TYPE pi_remote_turns_total counter");
    expect(metrics.body).toContain("pi_remote_live_sessions 0");

    const healthz = await get(port, "/healthz");
    expect(healthz.status).toBe(200);
    expect(JSON.parse(healthz.body)).toMatchObject({ ok: true });
  });
});
