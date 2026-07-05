import { describe, expect, it } from "vitest";
import {
  commandForText,
  groupCommands,
  matchCommands,
  paletteQuery,
  parseFreshSessionCommand,
  selectionFor,
  type CommandEntry,
} from "../web/src/command-palette.js";

const commands: CommandEntry[] = [
  { name: "compact", description: "Manually compact the session context", source: "builtin", argHint: "[instructions]" },
  { name: "clear", description: "Start a fresh session in this workspace", source: "builtin" },
  { name: "name", description: "Rename this session", source: "builtin", argHint: "<title>" },
  { name: "solvency", description: "Solvency provider status", source: "extension" },
  { name: "review", source: "prompt" },
  { name: "skill:brief", description: "Write a briefing", source: "skill" },
  { name: "skill:cluster", description: "Cluster status", source: "skill" },
];

describe("paletteQuery", () => {
  it("is active from the first slash and tracks the typed name", () => {
    expect(paletteQuery("/")).toBe("");
    expect(paletteQuery("/co")).toBe("co");
    expect(paletteQuery("/skill:br")).toBe("skill:br");
  });

  it("deactivates once arguments start or when the text is not a command", () => {
    expect(paletteQuery("/compact keep the plan")).toBeUndefined();
    expect(paletteQuery("/compact ")).toBeUndefined();
    expect(paletteQuery("/multi\nline")).toBeUndefined();
    expect(paletteQuery("hello")).toBeUndefined();
    expect(paletteQuery("")).toBeUndefined();
    expect(paletteQuery(" /compact")).toBeUndefined();
  });
});

describe("matchCommands", () => {
  it("returns everything for the bare slash", () => {
    expect(matchCommands(commands, "")).toHaveLength(commands.length);
  });

  it("ranks prefix matches before substring matches", () => {
    expect(matchCommands(commands, "c").map((c) => c.name)).toEqual([
      "compact",
      "clear",
      "solvency",
      "skill:cluster",
    ]);
    expect(matchCommands(commands, "brief").map((c) => c.name)).toEqual(["skill:brief"]);
  });

  it("matches case-insensitively and yields nothing for garbage", () => {
    expect(matchCommands(commands, "CLE").map((c) => c.name)).toEqual(["clear"]);
    expect(matchCommands(commands, "zzz")).toEqual([]);
  });
});

describe("groupCommands", () => {
  it("separates skills from every other source, preserving order", () => {
    const { primary, skills } = groupCommands(matchCommands(commands, ""));
    expect(primary.map((c) => c.name)).toEqual(["compact", "clear", "name", "solvency", "review"]);
    expect(skills.map((c) => c.name)).toEqual(["skill:brief", "skill:cluster"]);
  });

  it("keeps match ranking within each group", () => {
    const { primary, skills } = groupCommands(matchCommands(commands, "c"));
    expect(primary.map((c) => c.name)).toEqual(["compact", "clear", "solvency"]);
    expect(skills.map((c) => c.name)).toEqual(["skill:cluster"]);
  });
});

describe("selectionFor", () => {
  it("executes builtins whose arguments are optional or absent", () => {
    expect(selectionFor(commands[0])).toEqual({ kind: "execute", text: "/compact" });
    expect(selectionFor(commands[1])).toEqual({ kind: "execute", text: "/clear" });
  });

  it("inserts with a trailing space when the builtin requires an argument", () => {
    expect(selectionFor(commands[2])).toEqual({ kind: "insert", text: "/name " });
  });

  it("inserts extension, prompt, and skill commands so args can follow", () => {
    expect(selectionFor(commands[3])).toEqual({ kind: "insert", text: "/solvency " });
    expect(selectionFor(commands[4])).toEqual({ kind: "insert", text: "/review " });
    expect(selectionFor(commands[5])).toEqual({ kind: "insert", text: "/skill:brief " });
  });
});

describe("commandForText", () => {
  it("recognizes a registered command with or without args", () => {
    expect(commandForText(commands, "/solvency")?.name).toBe("solvency");
    expect(commandForText(commands, "/solvency verbose")?.name).toBe("solvency");
    expect(commandForText(commands, "/skill:brief the estate")?.name).toBe("skill:brief");
  });

  it("returns undefined for unknown commands and plain text", () => {
    expect(commandForText(commands, "/unknown")).toBeUndefined();
    expect(commandForText(commands, "hello")).toBeUndefined();
    expect(commandForText(commands, "/")).toBeUndefined();
    expect(commandForText(commands, "/solvencyx")).toBeUndefined();
  });
});

describe("parseFreshSessionCommand", () => {
  it("recognizes exactly /clear and /new", () => {
    expect(parseFreshSessionCommand("/clear")).toBe(true);
    expect(parseFreshSessionCommand("/new")).toBe(true);
    expect(parseFreshSessionCommand("/clear now")).toBe(false);
    expect(parseFreshSessionCommand("/clearx")).toBe(false);
    expect(parseFreshSessionCommand("clear")).toBe(false);
  });
});
