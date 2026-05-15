import { describe, it, expect } from "vitest";
import { isTrustedAgentForeground } from "../src/trust-gate";

describe("isTrustedAgentForeground (#519)", () => {
  it("trusts the immediate foreground when it is a known agent", () => {
    expect(isTrustedAgentForeground("claude", [])).toBe(true);
  });

  it("does not trust a bare shell foreground", () => {
    expect(isTrustedAgentForeground("zsh", [])).toBe(false);
    expect(isTrustedAgentForeground("bash", [])).toBe(false);
  });

  it("does not trust an unknown name with no ancestors", () => {
    expect(isTrustedAgentForeground("node", [])).toBe(false);
  });

  it("trusts a tool subshell whose ancestor is a known agent", () => {
    // claude spawns zsh to run a Bash tool: foreground is zsh, but the
    // session driver is claude.
    expect(
      isTrustedAgentForeground("zsh", [
        { name: "zsh" },
        { name: "claude" },
      ]),
    ).toBe(true);
  });

  it("trusts a multi-level descendant of a known agent", () => {
    expect(
      isTrustedAgentForeground("node", [
        { name: "node" },
        { name: "bash" },
        { name: "claude" },
      ]),
    ).toBe(true);
  });

  it("does not trust when no ancestor matches", () => {
    expect(
      isTrustedAgentForeground("node", [
        { name: "node" },
        { name: "zsh" },
      ]),
    ).toBe(false);
  });

  it("handles empty foreground name without crashing", () => {
    expect(isTrustedAgentForeground("", [])).toBe(false);
    expect(
      isTrustedAgentForeground("", [{ name: "claude" }]),
    ).toBe(true);
  });
});
