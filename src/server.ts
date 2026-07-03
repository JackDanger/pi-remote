import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { ModelSnapshot, SessionHost } from "./session-host.js";
import { type ClientRequest, parseClientRequest, ProtocolError } from "./protocol.js";

export interface ServerOptions {
  host: string;
  port: number;
  sessionHost: SessionHost;
  listModels: () => ModelSnapshot[];
  workspaceRoot: string;
  webRoot: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

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
  res.writeHead(200, { "content-type": CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

async function dispatch(
  request: ClientRequest,
  options: ServerOptions,
  client: { send(payload: unknown): void },
): Promise<unknown> {
  const { sessionHost } = options;
  switch (request.type) {
    case "sessions.list":
      return { sessions: await sessionHost.listSessions(), workspaceRoot: options.workspaceRoot };
    case "sessions.create":
      return { session: await sessionHost.createSession(request.workspace, request.model) };
    case "sessions.resume":
      return { session: await sessionHost.resumeSession(request.path) };
    case "sessions.delete":
      await sessionHost.deleteSession(request.path);
      return {};
    case "session.attach":
      return sessionHost.attach(request.sessionId, client);
    case "session.detach":
      sessionHost.detach(request.sessionId, client);
      return {};
    case "session.prompt":
      sessionHost.prompt(request.sessionId, request.text);
      return {};
    case "session.steer":
      sessionHost.steer(request.sessionId, request.text);
      return {};
    case "session.followup":
      sessionHost.followUp(request.sessionId, request.text);
      return {};
    case "session.abort":
      await sessionHost.abort(request.sessionId);
      return {};
    case "session.set_model":
      return { model: await sessionHost.setModel(request.sessionId, request.provider, request.modelId) };
    case "session.set_thinking":
      return { thinkingLevel: sessionHost.setThinkingLevel(request.sessionId, request.level) };
    case "models.list":
      return { models: options.listModels() };
  }
}

export function startServer(options: ServerOptions): http.Server {
  const httpServer = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, liveSessions: options.sessionHost.liveSessionIds().length }));
      return;
    }
    serveStatic(options.webRoot, req, res);
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

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
        const result = await dispatch(request, options, client);
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
