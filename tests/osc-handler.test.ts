import { describe, it, expect } from "vitest";
import { parseOsc9_2 } from "../src/osc-handler";

describe("parseOsc9_2", () => {
  it("parses notification text", () => {
    const result = parseOsc9_2("2;Task completed");
    expect(result).toEqual({ text: "Task completed" });
  });

  it("handles notification with semicolons", () => {
    const result = parseOsc9_2("2;Agent waiting; please approve");
    expect(result).toEqual({ text: "Agent waiting; please approve" });
  });

  it("returns null for empty notification", () => {
    expect(parseOsc9_2("2;")).toBeNull();
  });

  it("returns null for non-notification data", () => {
    expect(parseOsc9_2("4;1;50")).toBeNull();
    expect(parseOsc9_2("")).toBeNull();
  });

  it("truncates oversized notification text", () => {
    const huge = "x".repeat(2000);
    const result = parseOsc9_2(`2;${huge}`);
    expect(result).not.toBeNull();
    expect(result!.text.length).toBeLessThanOrEqual(513);
    expect(result!.text.endsWith("…")).toBe(true);
  });

  it("does not split a UTF-16 surrogate pair on truncation (#492)", () => {
    // Pad to 511 chars, then place 🔥 (D83D DD25) so the cut at 512 lands
    // between the high and low surrogate. The fix drops to 511 and slices.
    const text = "a".repeat(511) + "🔥".repeat(50);
    const result = parseOsc9_2(`2;${text}`);
    expect(result).not.toBeNull();
    // The resulting string must be valid UTF-16 (no unpaired surrogates).
    // Round-trip through TextEncoder/Decoder fails on lone surrogates.
    const round = new TextDecoder("utf-16le", { fatal: true }).decode(
      new Uint16Array(Array.from(result!.text, (c) => c.charCodeAt(0))),
    );
    expect(round).toBe(result!.text);
  });
});
