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
});
