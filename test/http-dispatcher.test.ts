import fs from "node:fs";
import { configureHttpDispatcher, DEFAULT_HTTP_IDLE_TIMEOUT_MS } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { applyHttpIdleTimeout, formatHttpIdleTimeout } from "../src/http-dispatcher.js";

describe("applyHttpIdleTimeout", () => {
  it("passes the resolved timeout to configureHttpDispatcher", () => {
    const configure = vi.fn();
    applyHttpIdleTimeout(1_800_000, configure);
    expect(configure).toHaveBeenCalledTimes(1);
    expect(configure).toHaveBeenCalledWith(1_800_000);
  });

  it("passes zero through for a disabled timeout", () => {
    const configure = vi.fn();
    applyHttpIdleTimeout(0, configure);
    expect(configure).toHaveBeenCalledTimes(1);
    expect(configure).toHaveBeenCalledWith(0);
  });

  it("defaults to the pi engine's configureHttpDispatcher exported from the package root", () => {
    expect(typeof configureHttpDispatcher).toBe("function");
    applyHttpIdleTimeout(1_800_000);
  });
});

describe("pi engine http-dispatcher export", () => {
  it("exposes a default idle timeout that would kill slow-prefill turns", () => {
    expect(DEFAULT_HTTP_IDLE_TIMEOUT_MS).toBe(300_000);
  });
});

describe("startup wiring", () => {
  it("configures the dispatcher from config before creating the pi environment", () => {
    const source = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const applyIndex = source.indexOf("applyHttpIdleTimeout(config.httpIdleTimeoutMs)");
    const environmentIndex = source.indexOf("createPiEnvironment(config)");
    expect(applyIndex).toBeGreaterThan(-1);
    expect(environmentIndex).toBeGreaterThan(applyIndex);
  });
});

describe("formatHttpIdleTimeout", () => {
  it("labels zero as disabled", () => {
    expect(formatHttpIdleTimeout(0)).toBe("disabled");
    expect(formatHttpIdleTimeout(1_800_000)).toBe("1800000ms");
  });
});
