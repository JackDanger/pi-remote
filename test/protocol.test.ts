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

  it("accepts ping", () => {
    expect(parseClientRequest(JSON.stringify({ id: 9, type: "ping" }))).toEqual({ id: 9, type: "ping" });
  });

  it("accepts session.rename", () => {
    expect(
      parseClientRequest(JSON.stringify({ id: 3, type: "session.rename", sessionId: "s", name: "n" })),
    ).toMatchObject({ type: "session.rename", sessionId: "s", name: "n" });
    expect(() =>
      parseClientRequest(JSON.stringify({ id: 3, type: "session.rename", sessionId: "s", name: "" })),
    ).toThrow(/requires string field "name"/);
  });

  it("accepts valid image attachments and allows empty text with images", () => {
    const images = [{ data: "aGk=", mimeType: "image/jpeg" }];
    expect(
      parseClientRequest(JSON.stringify({ id: 4, type: "session.prompt", sessionId: "s", text: "look", images })),
    ).toMatchObject({ images });
    expect(
      parseClientRequest(JSON.stringify({ id: 5, type: "session.steer", sessionId: "s", text: "", images })),
    ).toMatchObject({ type: "session.steer", text: "" });
  });

  it("rejects malformed image attachments", () => {
    const base = { id: 6, type: "session.prompt", sessionId: "s", text: "x" };
    expect(() => parseClientRequest(JSON.stringify({ ...base, images: "nope" }))).toThrow(/must be an array/);
    expect(() => parseClientRequest(JSON.stringify({ ...base, images: [{ data: "" }] }))).toThrow(/Each image/);
    expect(() =>
      parseClientRequest(JSON.stringify({ ...base, images: [{ data: "aGk=", mimeType: "text/plain" }] })),
    ).toThrow(/Each image/);
    expect(() =>
      parseClientRequest(
        JSON.stringify({ ...base, images: Array(9).fill({ data: "aGk=", mimeType: "image/png" }) }),
      ),
    ).toThrow(/At most 8 images/);
    expect(() =>
      parseClientRequest(
        JSON.stringify({ id: 7, type: "session.abort", sessionId: "s", images: [{ data: "aGk=", mimeType: "image/png" }] }),
      ),
    ).toThrow(/does not accept images/);
  });

  it("rejects empty text without images", () => {
    expect(() =>
      parseClientRequest(JSON.stringify({ id: 8, type: "session.prompt", sessionId: "s", text: "", images: [] })),
    ).toThrow(/requires string field "text"/);
  });

  it("accepts session.compact with and without instructions", () => {
    expect(parseClientRequest(JSON.stringify({ id: 10, type: "session.compact", sessionId: "s" }))).toMatchObject({
      type: "session.compact",
      sessionId: "s",
    });
    expect(
      parseClientRequest(
        JSON.stringify({ id: 11, type: "session.compact", sessionId: "s", instructions: "keep the plan" }),
      ),
    ).toMatchObject({ type: "session.compact", sessionId: "s", instructions: "keep the plan" });
  });

  it("accepts session.compact_abort and requires its sessionId", () => {
    expect(
      parseClientRequest(JSON.stringify({ id: 14, type: "session.compact_abort", sessionId: "s" })),
    ).toMatchObject({ type: "session.compact_abort", sessionId: "s" });
    expect(() => parseClientRequest(JSON.stringify({ id: 15, type: "session.compact_abort" }))).toThrow(
      /requires string field "sessionId"/,
    );
  });

  it("rejects session.compact without a sessionId", () => {
    expect(() => parseClientRequest(JSON.stringify({ id: 12, type: "session.compact" }))).toThrow(
      /requires string field "sessionId"/,
    );
    expect(() => parseClientRequest(JSON.stringify({ id: 13, type: "session.compact", sessionId: "" }))).toThrow(
      /requires string field "sessionId"/,
    );
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
