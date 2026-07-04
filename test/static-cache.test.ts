import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cacheControlFor, startServer } from "../src/server.js";
import { SessionHost } from "../src/session-host.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function get(port: number, pathname: string, requestHeaders: Record<string, string> = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: pathname, headers: requestHeaders }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += String(chunk)));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      })
      .on("error", reject);
  });
}

describe("cacheControlFor", () => {
  it("marks fingerprinted bundles immutable", () => {
    expect(cacheControlFor("/web/dist/app.0123abcd45.js")).toBe("public, max-age=31536000, immutable");
    expect(cacheControlFor("/web/dist/app.deadbeef00.css")).toBe("public, max-age=31536000, immutable");
  });

  it("requires revalidation for the app shell", () => {
    expect(cacheControlFor("/web/dist/index.html")).toBe("no-cache");
    expect(cacheControlFor("/web/dist/app.js")).toBe("no-cache");
    expect(cacheControlFor("/web/dist/app.css")).toBe("no-cache");
    expect(cacheControlFor("/web/dist/manifest.webmanifest")).toBe("no-cache");
  });

  it("lets icons cache for a day", () => {
    expect(cacheControlFor("/web/dist/icons/icon-180.png")).toBe("public, max-age=86400");
  });
});

describe("static file cache headers", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
    servers.length = 0;
  });

  async function listen(webRoot: string): Promise<number> {
    const host = new SessionHost({
      factory: async () => {
        throw new Error("unused");
      },
      listPersisted: async () => [],
      deletePersisted: async () => {},
      setSessionModel: async () => {},
    });
    const server = startServer({
      host: "127.0.0.1",
      port: 0,
      sessionHost: host,
      listModels: () => [],
      workspaceRoot: "/ws",
      webRoot,
    });
    servers.push(server);
    await new Promise((resolve) => server.on("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    return address.port;
  }

  function makeWebRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-static-"));
    fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
    fs.writeFileSync(path.join(dir, "app.0123abcd45.js"), "export {};");
    fs.writeFileSync(path.join(dir, "app.js"), "export {};");
    fs.mkdirSync(path.join(dir, "icons"));
    fs.writeFileSync(path.join(dir, "icons", "icon-180.png"), Buffer.from([0x89, 0x50]));
    return dir;
  }

  it("serves the shell with no-cache plus validators and honors If-None-Match", async () => {
    const port = await listen(makeWebRoot());
    const index = await get(port, "/");
    expect(index.status).toBe(200);
    expect(index.headers["cache-control"]).toBe("no-cache");
    expect(index.headers.etag).toBeTruthy();
    expect(index.headers["last-modified"]).toBeTruthy();

    const revalidated = await get(port, "/", { "if-none-match": String(index.headers.etag) });
    expect(revalidated.status).toBe(304);
    expect(revalidated.body).toBe("");
  });

  it("serves fingerprinted bundles as immutable and icons as day-cacheable", async () => {
    const port = await listen(makeWebRoot());
    const hashed = await get(port, "/app.0123abcd45.js");
    expect(hashed.status).toBe(200);
    expect(hashed.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    const plain = await get(port, "/app.js");
    expect(plain.headers["cache-control"]).toBe("no-cache");

    const icon = await get(port, "/icons/icon-180.png");
    expect(icon.headers["cache-control"]).toBe("public, max-age=86400");
  });

  it("returns fresh content with a changed ETag after the file is rewritten", async () => {
    const webRoot = makeWebRoot();
    const port = await listen(webRoot);
    const before = await get(port, "/");
    fs.writeFileSync(path.join(webRoot, "index.html"), "<html><body>v2</body></html>");
    const after = await get(port, "/", { "if-none-match": String(before.headers.etag) });
    expect(after.status).toBe(200);
    expect(after.body).toContain("v2");
    expect(after.headers.etag).not.toBe(before.headers.etag);
  });
});

describe("build-web asset fingerprinting", () => {
  it("emits hashed bundle names and rewrites index.html to reference them", () => {
    execFileSync(process.execPath, [path.join(repoRoot, "scripts", "build-web.mjs")], { cwd: repoRoot });
    const distDir = path.join(repoRoot, "web", "dist");
    const files = fs.readdirSync(distDir);
    const hashedJs = files.find((f) => /^app\.[0-9a-f]{10}\.js$/.test(f));
    const hashedCss = files.find((f) => /^app\.[0-9a-f]{10}\.css$/.test(f));
    expect(hashedJs).toBeTruthy();
    expect(hashedCss).toBeTruthy();
    expect(files).toContain("app.js");
    expect(files).toContain("app.css");

    const html = fs.readFileSync(path.join(distDir, "index.html"), "utf8");
    expect(html).toContain(`src="${hashedJs}"`);
    expect(html).toContain(`href="${hashedCss}"`);
    expect(html).not.toContain('src="app.js"');

    expect(fs.readFileSync(path.join(distDir, hashedJs as string))).toEqual(
      fs.readFileSync(path.join(distDir, "app.js")),
    );
  });
});
