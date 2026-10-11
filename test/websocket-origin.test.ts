import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { DEFAULT_ALLOWED_ORIGINS, loadConfig, parseAllowedOrigins } from "../src/config.js";
import type { SessionHost } from "../src/session-host.js";
import { startServer } from "../src/server.js";

const idleSessionHost = {
  detachEverywhere: () => {},
  liveSessionIds: () => [],
  isDraining: false,
} as unknown as SessionHost;

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  servers.length = 0;
});

async function listen(allowedOrigins: readonly string[]): Promise<number> {
  const server = startServer({
    host: "127.0.0.1",
    port: 0,
    sessionHost: idleSessionHost,
    listModels: () => [],
    workspaceRoot: "/ws",
    webRoot: fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-test-")),
    allowedOrigins,
  });
  servers.push(server);
  await new Promise((resolve) => server.on("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

function upgradeStatus(port: number, origin: string | undefined): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: "/ws",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...(origin === undefined ? {} : { Origin: origin }),
      },
    });
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.end();
  });
}

describe("WebSocket origin allowlist", () => {
  it("upgrades a connection from an allowed origin", async () => {
    const port = await listen(DEFAULT_ALLOWED_ORIGINS);
    expect(await upgradeStatus(port, "https://bixby")).toBe(101);
  });

  it("refuses a foreign origin with 403 before upgrading", async () => {
    const port = await listen(DEFAULT_ALLOWED_ORIGINS);
    expect(await upgradeStatus(port, "https://evil.example")).toBe(403);
    expect(await upgradeStatus(port, "http://bixby")).toBe(403);
    expect(await upgradeStatus(port, "null")).toBe(403);
  });

  it("refuses an upgrade that carries no origin", async () => {
    const port = await listen(DEFAULT_ALLOWED_ORIGINS);
    expect(await upgradeStatus(port, undefined)).toBe(403);
  });

  it("honors the configured list instead of the default", async () => {
    const config = loadConfig({
      PI_REMOTE_CONFIG: "/nonexistent/config.json",
      PI_REMOTE_ALLOWED_ORIGINS: "http://127.0.0.1:3141, https://pi.example.com/",
    });
    const port = await listen(config.allowedOrigins);
    expect(await upgradeStatus(port, "http://127.0.0.1:3141")).toBe(101);
    expect(await upgradeStatus(port, "https://pi.example.com")).toBe(101);
    expect(await upgradeStatus(port, "https://bixby")).toBe(403);
  });

  it("lets an allowed client exchange messages end to end", async () => {
    const port = await listen(["https://bixby"]);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: "https://bixby" });
    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.on("error", reject);
      socket.on("open", () => socket.send(JSON.stringify({ id: 7, type: "ping" })));
      socket.on("message", (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    });
    socket.close();
    expect(reply).toEqual({ id: 7, ok: true, result: {} });
  });
});

describe("parseAllowedOrigins", () => {
  it("normalizes entries to serialized origins and drops duplicates", () => {
    expect(parseAllowedOrigins("https://Bixby/, https://bixby:443,http://localhost:3141", "test")).toEqual([
      "https://bixby",
      "http://localhost:3141",
    ]);
    expect(parseAllowedOrigins(["https://a.example", "https://b.example"], "test")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  it("rejects entries that are not bare origins", () => {
    expect(() => parseAllowedOrigins("bixby", "test")).toThrow(/Invalid origin/);
    expect(() => parseAllowedOrigins("https://bixby/pi", "test")).toThrow(/Invalid origin/);
    expect(() => parseAllowedOrigins("*", "test")).toThrow(/Invalid origin/);
    expect(() => parseAllowedOrigins(" , ", "test")).toThrow(/No allowed origins/);
  });

  it("defaults to https://bixby and reads the config file", () => {
    expect(loadConfig({ PI_REMOTE_CONFIG: "/nonexistent/config.json" }).allowedOrigins).toEqual(["https://bixby"]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-test-"));
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ allowedOrigins: ["http://localhost:3141"] }));
    expect(loadConfig({ PI_REMOTE_CONFIG: file }).allowedOrigins).toEqual(["http://localhost:3141"]);
  });
});
