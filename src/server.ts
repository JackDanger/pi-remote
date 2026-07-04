import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { ImageContent, ModelSnapshot, SessionHost } from "./session-host.js";
import {
  type ClientRequest,
  type ImageAttachment,
  parseClientRequest,
  ProtocolError,
  type TelemetrySnapshot,
} from "./protocol.js";

export interface ServerOptions {
  host: string;
  port: number;
  sessionHost: SessionHost;
  listModels: () => ModelSnapshot[];
  workspaceRoot: string;
  webRoot: string;
  renderMetrics?: () => string;
  latestTelemetry?: (sessionId: string) => TelemetrySnapshot | undefined;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
};

const FINGERPRINTED_ASSET = /\.[0-9a-f]{8,}\.(?:js|css)$/;
const CACHEABLE_MEDIA_EXTENSIONS = new Set([".png", ".svg", ".ico"]);

export function cacheControlFor(filePath: string): string {
  if (FINGERPRINTED_ASSET.test(filePath)) return "public, max-age=31536000, immutable";
  if (CACHEABLE_MEDIA_EXTENSIONS.has(path.extname(filePath))) return "public, max-age=86400";
  return "no-cache";
}

function serveStatic(webRoot: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const resolved = path.resolve(webRoot, `.${requested}`);
  if (!resolved.startsWith(path.resolve(webRoot) + path.sep) && resolved !== path.resolve(webRoot, "index.html")) {
    res.writeHead(403).end();
    return;
  }
  const filePath = fs.existsSync(resolved) ? resolved : path.join(webRoot, "index.html");
  if (!fs.existsSync(filePath)) {
    res.writeHead(404).end("not found");
    return;
  }
  const stats = fs.statSync(filePath);
  const etag = `"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`;
  const headers = {
    "content-type": CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream",
    "cache-control": cacheControlFor(filePath),
    etag,
    "last-modified": stats.mtime.toUTCString(),
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers).end();
    return;
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

function toImageContents(images: ImageAttachment[] | undefined): ImageContent[] | undefined {
  return images?.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }));
}

async function dispatch(
  request: ClientRequest,
  options: ServerOptions,
  client: { send(payload: unknown): void },
  sessionsChanged: () => void,
): Promise<unknown> {
  const { sessionHost } = options;
  switch (request.type) {
    case "sessions.list":
      return { sessions: await sessionHost.listSessions(), workspaceRoot: options.workspaceRoot };
    case "sessions.create": {
      const session = await sessionHost.createSession(request.workspace, request.model);
      sessionsChanged();
      return { session };
    }
    case "sessions.resume":
      return { session: await sessionHost.resumeSession(request.path) };
    case "sessions.delete":
      await sessionHost.deleteSession(request.path);
      sessionsChanged();
      return {};
    case "session.attach": {
      const state = sessionHost.attach(request.sessionId, client);
      const telemetry = options.latestTelemetry?.(request.sessionId);
      return telemetry ? { ...state, telemetry } : state;
    }
    case "session.detach":
      sessionHost.detach(request.sessionId, client);
      return {};
    case "session.prompt":
      sessionHost.prompt(request.sessionId, request.text, toImageContents(request.images));
      return {};
    case "session.steer":
      sessionHost.steer(request.sessionId, request.text, toImageContents(request.images));
      return {};
    case "session.followup":
      sessionHost.followUp(request.sessionId, request.text, toImageContents(request.images));
      return {};
    case "session.abort":
      await sessionHost.abort(request.sessionId);
      return {};
    case "session.compact":
      sessionHost.compact(request.sessionId, request.instructions);
      return {};
    case "session.set_model":
      return { model: await sessionHost.setModel(request.sessionId, request.provider, request.modelId) };
    case "session.set_thinking":
      return { thinkingLevel: sessionHost.setThinkingLevel(request.sessionId, request.level) };
    case "session.rename": {
      const name = sessionHost.rename(request.sessionId, request.name);
      sessionsChanged();
      return { name };
    }
    case "models.list":
      return { models: options.listModels() };
    case "ping":
      return {};
  }
}

export function startServer(options: ServerOptions): http.Server {
  const httpServer = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          liveSessions: options.sessionHost.liveSessionIds().length,
          draining: options.sessionHost.isDraining,
        }),
      );
      return;
    }
    if (req.url === "/metrics" && options.renderMetrics) {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(options.renderMetrics());
      return;
    }
    serveStatic(options.webRoot, req, res);
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  const broadcastSessionsChanged = (): void => {
    for (const socket of wss.clients) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "sessions_changed" }));
      }
    }
  };

  wss.on("connection", (socket: WebSocket) => {
    const client = {
      send(payload: unknown): void {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(payload));
        }
      },
    };

    socket.on("message", (data: Buffer | string) => {
      void handleMessage(String(data));
    });

    async function handleMessage(raw: string): Promise<void> {
      let request: ClientRequest;
      try {
        request = parseClientRequest(raw);
      } catch (error) {
        client.send({ id: -1, ok: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      try {
        const result = await dispatch(request, options, client, broadcastSessionsChanged);
        client.send({ id: request.id, ok: true, result });
      } catch (error) {
        const message = error instanceof ProtocolError || error instanceof Error ? error.message : String(error);
        client.send({ id: request.id, ok: false, error: message });
      }
    }

    socket.on("close", () => {
      options.sessionHost.detachEverywhere(client);
    });
  });

  httpServer.listen(options.port, options.host);
  return httpServer;
}
