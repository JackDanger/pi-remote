#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createPiEnvironment } from "./pi.js";
import { SessionHost } from "./session-host.js";
import { startServer } from "./server.js";

const config = loadConfig();
const environment = createPiEnvironment(config);
const sessionHost = new SessionHost(environment.hostDeps);

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "dist");

await environment.warmup();

const server = startServer({
  host: config.host,
  port: config.port,
  sessionHost,
  listModels: environment.listModels,
  workspaceRoot: environment.workspaceRoot,
  webRoot,
});

server.on("listening", () => {
  console.log(`pi-remote listening on http://${config.host}:${config.port}`);
  if (config.host !== "127.0.0.1" && config.host !== "localhost" && config.host !== "::1") {
    console.warn(
      `WARNING: bound to ${config.host} — pi-remote has NO authentication; anyone who can reach this port can run arbitrary commands as this user. Front it with an authenticating reverse proxy.`,
    );
  }
});

function shutdown(): void {
  sessionHost.disposeAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
