import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { applyHttpIdleTimeout, formatHttpIdleTimeout, loadHttpDispatcherModule } from "../src/http-dispatcher.js";

describe("applyHttpIdleTimeout", () => {
  it("passes the resolved timeout to configureHttpDispatcher", async () => {
    const configureHttpDispatcher = vi.fn();
    await applyHttpIdleTimeout(1_800_000, async () => ({ configureHttpDispatcher }));
    expect(configureHttpDispatcher).toHaveBeenCalledTimes(1);
    expect(configureHttpDispatcher).toHaveBeenCalledWith(1_800_000);
  });

  it("passes zero through for a disabled timeout", async () => {
    const configureHttpDispatcher = vi.fn();
    await applyHttpIdleTimeout(0, async () => ({ configureHttpDispatcher }));
    expect(configureHttpDispatcher).toHaveBeenCalledTimes(1);
    expect(configureHttpDispatcher).toHaveBeenCalledWith(0);
  });
});

describe("loadHttpDispatcherModule", () => {
  it("reaches the real pi module even though the package exports map hides it", async () => {
    const dispatcherModule = await loadHttpDispatcherModule();
    expect(typeof dispatcherModule.configureHttpDispatcher).toBe("function");
  });

  it("targets a pi library whose default idle timeout would kill slow-prefill turns", async () => {
    const dispatcherModule = (await loadHttpDispatcherModule()) as { DEFAULT_HTTP_IDLE_TIMEOUT_MS?: number } & Awaited<
      ReturnType<typeof loadHttpDispatcherModule>
    >;
    expect(dispatcherModule.DEFAULT_HTTP_IDLE_TIMEOUT_MS).toBe(300_000);
  });

  it("applies a real timeout end to end without throwing", async () => {
    await applyHttpIdleTimeout(1_800_000);
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
