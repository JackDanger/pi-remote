import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expandTilde, loadConfig, parseModelRef } from "../src/config.js";

function withConfigFile(contents: object): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-test-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify(contents));
  return file;
}

describe("parseModelRef", () => {
  it("splits provider and model id on the first slash", () => {
    expect(parseModelRef("myprovider/my-model")).toEqual({ provider: "myprovider", modelId: "my-model" });
    expect(parseModelRef("openai/org/model")).toEqual({ provider: "openai", modelId: "org/model" });
  });

  it("rejects strings without a provider/model split", () => {
    expect(() => parseModelRef("nomodel")).toThrow(/Invalid model reference/);
    expect(() => parseModelRef("/leading")).toThrow(/Invalid model reference/);
    expect(() => parseModelRef("trailing/")).toThrow(/Invalid model reference/);
  });
});

describe("expandTilde", () => {
  it("expands leading tilde to the home directory", () => {
    expect(expandTilde("~/x")).toBe(path.join(os.homedir(), "x"));
    expect(expandTilde("/abs/x")).toBe("/abs/x");
  });
});

describe("loadConfig", () => {
  it("uses defaults when nothing is configured", () => {
    const config = loadConfig({ PI_REMOTE_CONFIG: "/nonexistent/config.json" });
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(3141);
    expect(config.workspaceRoot).toBe(path.join(os.homedir(), "pi-workspaces"));
    expect(config.agentDir).toBeUndefined();
    expect(config.defaultModel).toBeUndefined();
  });

  it("reads the config file", () => {
    const file = withConfigFile({ host: "0.0.0.0", port: 9999, defaultModel: "p/m", workspaceRoot: "/ws" });
    const config = loadConfig({ PI_REMOTE_CONFIG: file });
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(9999);
    expect(config.defaultModel).toEqual({ provider: "p", modelId: "m" });
    expect(config.workspaceRoot).toBe("/ws");
  });

  it("lets env override the config file", () => {
    const file = withConfigFile({ host: "0.0.0.0", port: 9999 });
    const config = loadConfig({
      PI_REMOTE_CONFIG: file,
      PI_REMOTE_HOST: "127.0.0.1",
      PI_REMOTE_PORT: "4000",
      PI_REMOTE_DEFAULT_MODEL: "a/b",
    });
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(4000);
    expect(config.defaultModel).toEqual({ provider: "a", modelId: "b" });
  });

  it("rejects invalid ports", () => {
    expect(() => loadConfig({ PI_REMOTE_CONFIG: "/nonexistent", PI_REMOTE_PORT: "notaport" })).toThrow(/Invalid port/);
    expect(() => loadConfig({ PI_REMOTE_CONFIG: "/nonexistent", PI_REMOTE_PORT: "70000" })).toThrow(/Invalid port/);
  });

  it("defaults the shutdown grace to two minutes", () => {
    const config = loadConfig({ PI_REMOTE_CONFIG: "/nonexistent/config.json" });
    expect(config.shutdownGraceMs).toBe(120_000);
  });

  it("reads the shutdown grace from the config file and lets env override it", () => {
    const file = withConfigFile({ shutdownGraceMs: 30_000 });
    expect(loadConfig({ PI_REMOTE_CONFIG: file }).shutdownGraceMs).toBe(30_000);
    expect(loadConfig({ PI_REMOTE_CONFIG: file, PI_REMOTE_SHUTDOWN_GRACE_MS: "5000" }).shutdownGraceMs).toBe(5000);
  });

  it("defaults telemetry on, reads it from the config file, and lets env override it", () => {
    expect(loadConfig({ PI_REMOTE_CONFIG: "/nonexistent/config.json" }).telemetry).toBe(true);
    const file = withConfigFile({ telemetry: false });
    expect(loadConfig({ PI_REMOTE_CONFIG: file }).telemetry).toBe(false);
    expect(loadConfig({ PI_REMOTE_CONFIG: file, PI_REMOTE_TELEMETRY: "true" }).telemetry).toBe(true);
    expect(loadConfig({ PI_REMOTE_CONFIG: "/nonexistent", PI_REMOTE_TELEMETRY: "0" }).telemetry).toBe(false);
    expect(() => loadConfig({ PI_REMOTE_CONFIG: "/nonexistent", PI_REMOTE_TELEMETRY: "maybe" })).toThrow(
      /Invalid boolean/,
    );
  });

  it("defaults the HTTP idle timeout to 30 minutes", () => {
    expect(loadConfig({ PI_REMOTE_CONFIG: "/nonexistent/config.json" }).httpIdleTimeoutMs).toBe(1_800_000);
  });

  it("reads the HTTP idle timeout from the config file and lets env override it", () => {
    const file = withConfigFile({ httpIdleTimeoutMs: 60_000 });
    expect(loadConfig({ PI_REMOTE_CONFIG: file }).httpIdleTimeoutMs).toBe(60_000);
    expect(loadConfig({ PI_REMOTE_CONFIG: file, PI_REMOTE_HTTP_IDLE_TIMEOUT_MS: "120000" }).httpIdleTimeoutMs).toBe(
      120_000,
    );
  });

  it("accepts disabled and zero HTTP idle timeouts", () => {
    expect(loadConfig({ PI_REMOTE_CONFIG: "/nonexistent", PI_REMOTE_HTTP_IDLE_TIMEOUT_MS: "disabled" }).httpIdleTimeoutMs).toBe(0);
    const file = withConfigFile({ httpIdleTimeoutMs: "disabled" });
    expect(loadConfig({ PI_REMOTE_CONFIG: file }).httpIdleTimeoutMs).toBe(0);
    expect(loadConfig({ PI_REMOTE_CONFIG: "/nonexistent", PI_REMOTE_HTTP_IDLE_TIMEOUT_MS: "0" }).httpIdleTimeoutMs).toBe(0);
  });

  it("rejects invalid HTTP idle timeouts", () => {
    expect(() => loadConfig({ PI_REMOTE_CONFIG: "/nonexistent", PI_REMOTE_HTTP_IDLE_TIMEOUT_MS: "soon" })).toThrow(
      /Invalid HTTP idle timeout/,
    );
    expect(() => loadConfig({ PI_REMOTE_CONFIG: "/nonexistent", PI_REMOTE_HTTP_IDLE_TIMEOUT_MS: "-5" })).toThrow(
      /Invalid HTTP idle timeout/,
    );
  });

  it("rejects invalid shutdown grace values", () => {
    expect(() => loadConfig({ PI_REMOTE_CONFIG: "/nonexistent", PI_REMOTE_SHUTDOWN_GRACE_MS: "soon" })).toThrow(
      /Invalid milliseconds/,
    );
    expect(() => loadConfig({ PI_REMOTE_CONFIG: "/nonexistent", PI_REMOTE_SHUTDOWN_GRACE_MS: "-1" })).toThrow(
      /Invalid milliseconds/,
    );
  });
});
