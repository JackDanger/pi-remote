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
});
