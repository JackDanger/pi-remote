import { describe, expect, it } from "vitest";
import {
  insertionFor,
  matchCommands,
  paletteQuery,
  parseClearCommand,
  type CommandEntry,
} from "../web/src/command-palette.js";

const commands: CommandEntry[] = [
  { name: "compact", description: "Manually compact the session context", source: "builtin" },
  { name: "clear", description: "Start a fresh session in this workspace", source: "builtin" },
  { name: "solvency", description: "Solvency provider status", source: "extension" },
  { name: "review", source: "prompt" },
  { name: "skill:brief", description: "Write a briefing", source: "skill" },
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
    expect(matchCommands(commands, "c").map((c) => c.name)).toEqual(["compact", "clear", "solvency"]);
    expect(matchCommands(commands, "brief").map((c) => c.name)).toEqual(["skill:brief"]);
  });

  it("matches case-insensitively and yields nothing for garbage", () => {
    expect(matchCommands(commands, "CLE").map((c) => c.name)).toEqual(["clear"]);
    expect(matchCommands(commands, "zzz")).toEqual([]);
  });
});

describe("insertionFor", () => {
  it("inserts the invocation with a trailing space so args can follow", () => {
    expect(insertionFor(commands[0])).toBe("/compact ");
    expect(insertionFor(commands[4])).toBe("/skill:brief ");
  });
});

describe("parseClearCommand", () => {
  it("recognizes exactly /clear", () => {
    expect(parseClearCommand("/clear")).toBe(true);
    expect(parseClearCommand("/clear now")).toBe(false);
    expect(parseClearCommand("/clearx")).toBe(false);
    expect(parseClearCommand("clear")).toBe(false);
  });
});
