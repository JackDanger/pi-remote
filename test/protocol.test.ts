import { describe, expect, it } from "vitest";
import { parseClientRequest, ProtocolError } from "../src/protocol.js";

describe("parseClientRequest", () => {
  it("accepts well-formed requests", () => {
    expect(parseClientRequest(JSON.stringify({ id: 1, type: "sessions.list" }))).toEqual({
      id: 1,
      type: "sessions.list",
    });
    expect(
      parseClientRequest(JSON.stringify({ id: 2, type: "session.prompt", sessionId: "s", text: "hi" })),
    ).toMatchObject({ type: "session.prompt", sessionId: "s", text: "hi" });
  });

  it("rejects non-JSON", () => {
    expect(() => parseClientRequest("{nope")).toThrow(ProtocolError);
  });

  it("rejects missing id", () => {
    expect(() => parseClientRequest(JSON.stringify({ type: "sessions.list" }))).toThrow(/numeric id/);
  });

  it("rejects unknown types", () => {
    expect(() => parseClientRequest(JSON.stringify({ id: 1, type: "bogus" }))).toThrow(/Unknown request type/);
  });

  it("rejects missing required fields", () => {
    expect(() => parseClientRequest(JSON.stringify({ id: 1, type: "session.prompt", sessionId: "s" }))).toThrow(
      /requires string field "text"/,
    );
    expect(() => parseClientRequest(JSON.stringify({ id: 1, type: "sessions.resume", path: "" }))).toThrow(
      /requires string field "path"/,
    );
  });
});
