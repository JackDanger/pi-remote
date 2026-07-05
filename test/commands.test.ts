import { describe, expect, it } from "vitest";
import {
  CLEAR_COMMAND,
  collectCommands,
  MODEL_COMMAND,
  NAME_COMMAND,
  NEW_COMMAND,
  REMOTE_EXECUTABLE_ENGINE_BUILTINS,
} from "../src/commands.js";

const engineBuiltins = [
  { name: "settings", description: "Open settings menu" },
  { name: "compact", description: "Manually compact the session context" },
  { name: "quit", description: "Quit pi" },
  { name: "new", description: "Start a new session" },
];

describe("collectCommands", () => {
  it("keeps only remotely executable engine builtins and adds the remote builtins", () => {
    const result = collectCommands({
      engineBuiltins,
      extensionCommands: [],
      promptTemplates: [],
      skills: [],
    });
    expect(result).toEqual([
      {
        name: "compact",
        description: "Manually compact the session context",
        source: "builtin",
        argHint: "[instructions]",
      },
      CLEAR_COMMAND,
      NEW_COMMAND,
      MODEL_COMMAND,
      NAME_COMMAND,
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
      NEW_COMMAND,
      MODEL_COMMAND,
      NAME_COMMAND,
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
    expect(result.filter((c) => c.name === "compact")).toEqual([
      {
        name: "compact",
        description: "Manually compact the session context",
        source: "builtin",
        argHint: "[instructions]",
      },
    ]);
    expect(result.filter((c) => c.name === "clear")).toEqual([CLEAR_COMMAND]);
  });

  it("shadows the engine's new/model/name builtins with the remote implementations", () => {
    const result = collectCommands({
      engineBuiltins: [
        { name: "new", description: "Start a new session" },
        { name: "model", description: "Select model (opens selector UI)" },
        { name: "name", description: "Set session display name" },
      ],
      extensionCommands: [],
      promptTemplates: [],
      skills: [],
    });
    expect(result.find((c) => c.name === "new")).toEqual(NEW_COMMAND);
    expect(result.find((c) => c.name === "model")).toEqual(MODEL_COMMAND);
    expect(result.find((c) => c.name === "name")).toEqual(NAME_COMMAND);
  });

  it("declares arg hints on the commands that accept arguments", () => {
    expect(MODEL_COMMAND.argHint).toBe("[pattern]");
    expect(NAME_COMMAND.argHint).toBe("<title>");
    expect(CLEAR_COMMAND.argHint).toBeUndefined();
    expect(NEW_COMMAND.argHint).toBeUndefined();
  });

  it("declares the remote-executable builtin allowlist explicitly", () => {
    expect([...REMOTE_EXECUTABLE_ENGINE_BUILTINS]).toEqual(["compact"]);
  });
});
