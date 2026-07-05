import { describe, expect, it } from "vitest";
import { CLEAR_COMMAND, collectCommands, REMOTE_EXECUTABLE_ENGINE_BUILTINS } from "../src/commands.js";

const engineBuiltins = [
  { name: "settings", description: "Open settings menu" },
  { name: "compact", description: "Manually compact the session context" },
  { name: "quit", description: "Quit pi" },
  { name: "new", description: "Start a new session" },
];

describe("collectCommands", () => {
  it("keeps only remotely executable engine builtins and adds /clear", () => {
    const result = collectCommands({
      engineBuiltins,
      extensionCommands: [],
      promptTemplates: [],
      skills: [],
    });
    expect(result).toEqual([
      { name: "compact", description: "Manually compact the session context", source: "builtin" },
      CLEAR_COMMAND,
    ]);
  });

  it("labels extension, prompt, and skill commands with their source", () => {
    const result = collectCommands({
      engineBuiltins: [],
      extensionCommands: [{ invocationName: "solvency", description: "Solvency status" }],
      promptTemplates: [{ name: "review", description: "Review template" }],
      skills: [{ name: "brief", description: "Write a briefing" }],
    });
    expect(result).toEqual([
      CLEAR_COMMAND,
      { name: "solvency", description: "Solvency status", source: "extension" },
      { name: "review", description: "Review template", source: "prompt" },
      { name: "skill:brief", description: "Write a briefing", source: "skill" },
    ]);
  });

  it("dedupes by name, keeping the earliest source in execution priority order", () => {
    const result = collectCommands({
      engineBuiltins,
      extensionCommands: [{ invocationName: "compact", description: "extension compact" }],
      promptTemplates: [{ name: "clear", description: "prompt clear" }],
      skills: [],
    });
    expect(result).toEqual([
      { name: "compact", description: "Manually compact the session context", source: "builtin" },
      CLEAR_COMMAND,
    ]);
  });

  it("declares the remote-executable builtin allowlist explicitly", () => {
    expect([...REMOTE_EXECUTABLE_ENGINE_BUILTINS]).toEqual(["compact"]);
  });
});
