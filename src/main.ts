#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createPiEnvironment } from "./pi.js";
import type { SessionTelemetryPush } from "./protocol.js";
import { SessionHost } from "./session-host.js";
import { startServer } from "./server.js";
import { Telemetry } from "./telemetry.js";

const config = loadConfig();
const environment = createPiEnvironment(config);
const telemetry: Telemetry | undefined = config.telemetry
  ? new Telemetry({
      liveSessions: () => sessionHost.liveSessionIds().length,
      streamingSessions: () => sessionHost.streamingSessionIds().length,
      onSnapshot: (sessionId, snapshot) => {
        const push: SessionTelemetryPush = { type: "session_telemetry", sessionId, telemetry: snapshot };
        sessionHost.pushToAttached(sessionId, push);
      },
    })
  : undefined;
const sessionHost: SessionHost = new SessionHost(environment.hostDeps, telemetry);

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "dist");

await environment.warmup();

const server = startServer({
  host: config.host,
  port: config.port,
  sessionHost,
  listModels: environment.listModels,
  workspaceRoot: environment.workspaceRoot,
  webRoot,
  renderMetrics: telemetry ? () => telemetry.renderMetrics() : undefined,
  latestTelemetry: telemetry ? (sessionId) => telemetry.snapshot(sessionId) : undefined,
});

server.on("listening", () => {
  console.log(`pi-remote listening on http://${config.host}:${config.port}`);
  if (config.host !== "127.0.0.1" && config.host !== "localhost" && config.host !== "::1") {
    console.warn(
      `WARNING: bound to ${config.host} — pi-remote has NO authentication; anyone who can reach this port can run arbitrary commands as this user. Front it with an authenticating reverse proxy.`,
    );
  }
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    console.warn(`${signal} received again — forcing immediate exit`);
    sessionHost.disposeAll();
    process.exit(1);
  }
  shuttingDown = true;
  const streaming = sessionHost.streamingSessionIds();
  console.log(
    `${signal} received — draining ${streaming.length} running turn(s), grace ${config.shutdownGraceMs}ms (send ${signal} again to force exit)`,
  );
  server.close();
  const { forced } = await sessionHost.drain(config.shutdownGraceMs);
  if (forced.length > 0) {
    console.warn(`drain deadline exceeded — force-stopping sessions still streaming: ${forced.join(", ")}`);
  }
  sessionHost.disposeAll();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
