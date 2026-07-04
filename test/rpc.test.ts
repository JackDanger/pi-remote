import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionLostError,
  PING_INTERVAL_MS,
  PROBE_TIMEOUT_MS,
  RESPONSE_PROBE_AFTER_MS,
  Rpc,
  type SocketLike,
} from "../web/src/rpc.js";

class FakeSocket implements SocketLike {
  readyState = 0;
  closed = false;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  answeredPings = new Set<number>();

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  reply(id: number, result: unknown = {}): void {
    this.onmessage?.({ data: JSON.stringify({ id, ok: true, result }) });
  }

  frames(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m.type === type);
  }

  lastFrame(type: string): Record<string, unknown> | undefined {
    return this.frames(type).at(-1);
  }

  answerOutstandingPings(): void {
    for (const frame of this.frames("ping")) {
      const id = frame.id as number;
      if (this.answeredPings.has(id)) continue;
      this.answeredPings.add(id);
      this.reply(id);
    }
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const rpc = new Rpc(() => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  const states: string[] = [];
  rpc.onStateChange = (state) => states.push(state);
  return { rpc, sockets, states };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Rpc liveness", () => {
  it("tears down the socket and reconnects when pings go unanswered", async () => {
    const { rpc, sockets, states } = harness();
    rpc.connect();
    sockets[0]!.open();
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    expect(sockets[0]!.frames("ping").length).toBe(1);
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    expect(sockets[0]!.closed).toBe(true);
    expect(states).toEqual(["connecting", "online", "offline"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets.length).toBe(2);
    expect(states).toEqual(["connecting", "online", "offline", "connecting"]);
  });

  it("keeps waiting on a slow response while pings prove the socket is alive", async () => {
    const { rpc, sockets, states } = harness();
    rpc.connect();
    sockets[0]!.open();
    const promise = rpc.request<{ done: boolean }>("session.attach", { sessionId: "s" });
    await vi.advanceTimersByTimeAsync(0);
    const requestId = sockets[0]!.lastFrame("session.attach")!.id as number;
    for (let elapsed = 0; elapsed < RESPONSE_PROBE_AFTER_MS * 3; elapsed += 1000) {
      await vi.advanceTimersByTimeAsync(1000);
      sockets[0]!.answerOutstandingPings();
    }
    expect(states).not.toContain("offline");
    expect(sockets.length).toBe(1);
    sockets[0]!.reply(requestId, { done: true });
    await expect(promise).resolves.toEqual({ done: true });
  });
});

describe("Rpc retry semantics", () => {
  it("retries an idempotent request transparently across a reconnect", async () => {
    const { rpc, sockets } = harness();
    rpc.connect();
    sockets[0]!.open();
    const promise = rpc.request<{ sessions: string[] }>("sessions.list");
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0]!.frames("sessions.list").length).toBe(1);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + PROBE_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(500);
    sockets[1]!.open();
    await vi.advanceTimersByTimeAsync(1);
    const retried = sockets[1]!.lastFrame("sessions.list");
    expect(retried).toBeDefined();
    sockets[1]!.reply(retried!.id as number, { sessions: ["a"] });
    await expect(promise).resolves.toEqual({ sessions: ["a"] });
  });

  it("waits for reconnect before sending an idempotent request issued while offline", async () => {
    const { rpc, sockets } = harness();
    rpc.connect();
    sockets[0]!.open();
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + PROBE_TIMEOUT_MS);
    const promise = rpc.request<Record<string, never>>("models.list");
    await vi.advanceTimersByTimeAsync(500);
    sockets[1]!.open();
    await vi.advanceTimersByTimeAsync(1);
    const frame = sockets[1]!.lastFrame("models.list");
    expect(frame).toBeDefined();
    sockets[1]!.reply(frame!.id as number);
    await expect(promise).resolves.toEqual({});
  });

  it("does not auto-resend session.prompt after a connection loss", async () => {
    const { rpc, sockets } = harness();
    rpc.connect();
    sockets[0]!.open();
    const promise = rpc.request("session.prompt", { sessionId: "s", text: "hi" });
    const outcome = promise.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + PROBE_TIMEOUT_MS);
    const error = await outcome;
    expect(error).toBeInstanceOf(ConnectionLostError);
    expect((error as ConnectionLostError).sentBeforeLoss).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    sockets[1]!.open();
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets[1]!.frames("session.prompt").length).toBe(0);
  });

  it("rejects a non-idempotent request immediately when offline, marked as never sent", async () => {
    const { rpc, sockets } = harness();
    rpc.connect();
    const outcome = rpc.request("session.prompt", { sessionId: "s", text: "hi" }).catch((error: unknown) => error);
    const error = await outcome;
    expect(error).toBeInstanceOf(ConnectionLostError);
    expect((error as ConnectionLostError).sentBeforeLoss).toBe(false);
    expect(sockets[0]!.frames("session.prompt").length).toBe(0);
  });

  it("never rejects with a raw timed-out message", async () => {
    const { rpc, sockets } = harness();
    rpc.connect();
    sockets[0]!.open();
    const outcome = rpc.request("session.steer", { sessionId: "s", text: "x" }).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + PROBE_TIMEOUT_MS);
    const error = (await outcome) as Error;
    expect(error.message).not.toMatch(/timed out/i);
    expect(error.message).toBe("Connection lost");
  });
});
