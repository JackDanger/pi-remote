export type ConnState = "connecting" | "online" | "offline";

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
}

export class ConnectionLostError extends Error {
  constructor(readonly sentBeforeLoss: boolean) {
    super("Connection lost");
    this.name = "ConnectionLostError";
  }
}

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;

export const RESPONSE_PROBE_AFTER_MS = 30_000;
export const PROBE_TIMEOUT_MS = 10_000;
export const PING_INTERVAL_MS = 25_000;
export const ONLINE_WAIT_MS = 60_000;
const MAX_RECONNECT_RETRIES = 2;
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8000;

const IDEMPOTENT_TYPES = new Set([
  "ping",
  "models.list",
  "commands.list",
  "sessions.list",
  "sessions.resume",
  "session.attach",
  "session.detach",
  "session.set_model",
  "session.set_thinking",
  "session.rename",
]);

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface OnlineWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Rpc {
  private socket?: SocketLike;
  private nextId = 1;
  private pending = new Map<number, PendingEntry>();
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private probeInFlight = false;
  private onlineWaiters: OnlineWaiter[] = [];
  onPush: (msg: Record<string, unknown>) => void = () => {};
  onStateChange: (state: ConnState) => void = () => {};

  constructor(private readonly createSocket: () => SocketLike) {}

  connect(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.onStateChange("connecting");
    const socket = this.createSocket();
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.onStateChange("online");
      this.startPing();
      for (const waiter of this.onlineWaiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.ok) entry.resolve(msg.result);
        else entry.reject(new Error(String(msg.error)));
        return;
      }
      this.onPush(msg);
    };
    socket.onclose = () => this.handleSocketDown(socket);
  }

  kick(): void {
    if (this.socket && (this.socket.readyState === SOCKET_OPEN || this.socket.readyState === SOCKET_CONNECTING)) {
      return;
    }
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.connect();
  }

  get connected(): boolean {
    return this.socket?.readyState === SOCKET_OPEN;
  }

  request<T>(type: string, params: Record<string, unknown> = {}): Promise<T> {
    if (IDEMPOTENT_TYPES.has(type)) return this.requestWithReconnectRetry<T>(type, params);
    return this.send<T>(type, params);
  }

  private async requestWithReconnectRetry<T>(type: string, params: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.whenOnline();
        return await this.send<T>(type, params);
      } catch (error) {
        if (!(error instanceof ConnectionLostError) || attempt >= MAX_RECONNECT_RETRIES) throw error;
      }
    }
  }

  private whenOnline(): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter: OnlineWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.onlineWaiters = this.onlineWaiters.filter((w) => w !== waiter);
          reject(new ConnectionLostError(false));
        }, ONLINE_WAIT_MS),
      };
      this.onlineWaiters.push(waiter);
    });
  }

  private send<T>(type: string, params: Record<string, unknown>): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      return Promise.reject(new ConnectionLostError(false));
    }
    const id = this.nextId++;
    socket.send(JSON.stringify({ id, type, ...params }));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: setTimeout(() => this.onResponseOverdue(id), RESPONSE_PROBE_AFTER_MS),
      });
    });
  }

  private onResponseOverdue(id: number): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    entry.timer = setTimeout(() => this.onResponseOverdue(id), RESPONSE_PROBE_AFTER_MS);
    this.probeLiveness();
  }

  private probeLiveness(): void {
    if (this.probeInFlight) return;
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) return;
    this.probeInFlight = true;
    const id = this.nextId++;
    const settle = (): void => {
      this.probeInFlight = false;
    };
    this.pending.set(id, {
      resolve: settle,
      reject: settle,
      timer: setTimeout(() => {
        this.pending.delete(id);
        this.probeInFlight = false;
        this.dropSocket(socket);
      }, PROBE_TIMEOUT_MS),
    });
    socket.send(JSON.stringify({ id, type: "ping" }));
  }

  private dropSocket(socket: SocketLike): void {
    if (this.socket !== socket) return;
    socket.close();
    this.handleSocketDown(socket);
  }

  private handleSocketDown(socket: SocketLike): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.stopPing();
    this.probeInFlight = false;
    this.onStateChange("offline");
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(new ConnectionLostError(true));
    }
    this.reconnectTimer = setTimeout(() => this.connect(), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.probeLiveness(), PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== undefined) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }
}
