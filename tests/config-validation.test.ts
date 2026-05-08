import { describe, it, expect, vi } from "vitest";
import { DEFAULT_CONFIG, isUnbound, matchesKeybinding, validateConfig } from "../src/config";

describe("validateConfig", () => {
  // Get a valid base config to modify
  function baseConfig() {
    return {
      shell: "/bin/zsh",
      font: { family: "Menlo", size: 14, lineHeight: 1.3 },
      cursor: { style: "bar" as const, blink: true },
      sidebar: { width: 200, position: "left" as const },
      maxTabs: 20,
      theme: {
        sidebar: {
          background: "#000000", border: "rgba(255, 255, 255, 0.08)",
          tabActive: "rgba(255, 255, 255, 0.1)", tabHover: "rgba(255, 255, 255, 0.06)",
          tabText: "rgba(255, 255, 255, 0.45)", tabTextActive: "rgba(255, 255, 255, 0.9)",
          accentColor: "#0a84ff",
        },
        terminal: {
          background: "#000000", foreground: "#f8f8f2", cursor: "#f8f8f2",
          cursorAccent: "#000000", selectionBackground: "#44475a", selectionForeground: "#ffffff",
          black: "#000000", red: "#ff5555", green: "#00ff87", yellow: "#ffff00",
          blue: "#5f87ff", magenta: "#ff00ff", cyan: "#00ffff", white: "#f8f8f2",
          brightBlack: "#545454", brightRed: "#ff4444", brightGreen: "#00ff00",
          brightYellow: "#ffff55", brightBlue: "#87afff", brightMagenta: "#ff87ff",
          brightCyan: "#55ffff", brightWhite: "#ffffff",
        },
      },
      keybindings: {
        newTab: "cmd+t", closeTab: "cmd+w", nextTab: "cmd+shift+]",
        prevTab: "cmd+shift+[", reloadConfig: "cmd+shift+r", cycleAttention: "cmd+shift+a",
        search: "cmd+f", quickSwitch: "cmd+p",
      },
      outputAnalysis: { enabled: true, bufferSize: 4096 },
      notifications: {
        enabled: true,
        sound: true,
        types: {
          completion: { enabled: true, sound: false },
          agentWaiting: { enabled: true, sound: true },
          serverStarted: { enabled: true, sound: false },
          serverCrashed: { enabled: true, sound: true },
          error: { enabled: true, sound: false },
        },
      },
      advanced: {
        pollIntervalMs: 2000,
        backgroundPollIntervalMs: 5000,
        healthCheckIntervalMs: 10000,
        ipcTimeoutMs: 5000,
      },
    };
  }

  it("returns valid config unchanged", () => {
    const config = baseConfig();
    const result = validateConfig(config as any);
    expect(result.font.size).toBe(14);
    expect(result.cursor.style).toBe("bar");
  });

  it("rejects font.size out of range and logs warning", () => {
    const config = baseConfig();
    config.font.size = 200;
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = validateConfig(config as any);
    expect(result.font.size).toBe(14); // default
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("rejects invalid cursor style", () => {
    const config = baseConfig();
    (config.cursor as any).style = "blink-blink";
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = validateConfig(config as any);
    expect(result.cursor.style).toBe("bar");
    spy.mockRestore();
  });

  it("rejects empty shell", () => {
    const config = baseConfig();
    config.shell = "";
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = validateConfig(config as any);
    expect(result.shell).toBeTruthy(); // reset to platform default
    spy.mockRestore();
  });

  it("rejects sidebar width out of range", () => {
    const config = baseConfig();
    config.sidebar.width = 50;
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = validateConfig(config as any);
    expect(result.sidebar.width).toBe(200);
    spy.mockRestore();
  });

  it("preserves valid worktree config through validation", () => {
    const config = baseConfig() as any;
    config.worktree = {
      directory: ".my-worktrees",
      postCreateHooks: ["npm install"],
      autoCleanup: true,
      defaultAgent: "claude",
    };
    const result = validateConfig(config as any);
    expect(result.worktree.directory).toBe(".my-worktrees");
    expect(result.worktree.postCreateHooks).toEqual(["npm install"]);
    expect(result.worktree.autoCleanup).toBe(true);
    expect(result.worktree.defaultAgent).toBe("claude");
  });

  it("worktree config is provided by deepMerge before validation", () => {
    // validateConfig does not add missing top-level sections — deepMerge
    // in loadConfig handles that. This test verifies that a config with
    // worktree section already present passes through validation intact.
    const config = baseConfig() as any;
    config.worktree = {
      directory: ".clawterm-worktrees",
      postCreateHooks: [],
      autoCleanup: false,
      defaultAgent: "",
    };
    const result = validateConfig(config as any);
    // Legacy in-repo string round-trips unchanged — the resolver
    // (worktree-base.ts) is what interprets the string at use time.
    expect(result.worktree.directory).toBe(".clawterm-worktrees");
  });

  it("default worktree.directory is empty string (auto mode, #416)", () => {
    // The default flipped from ".clawterm-worktrees" (legacy in-repo) to ""
    // (auto: sibling-of-repo) in #416 to fix the parent-tool walk problem
    // (#415). The empty string is the resolver's signal for auto mode.
    expect(DEFAULT_CONFIG.worktree.directory).toBe("");
  });

  it("collects field names of corrections when sink provided", () => {
    const config = baseConfig() as any;
    config.font.size = 200;
    (config.cursor as any).style = "blink-blink";
    const corrections: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    validateConfig(config as any, corrections);
    spy.mockRestore();
    expect(corrections).toContain("font.size");
    expect(corrections).toContain("cursor.style");
  });

  describe("unbind syntax (#484)", () => {
    it("isUnbound recognizes null, undefined, empty string", () => {
      expect(isUnbound(null)).toBe(true);
      expect(isUnbound(undefined)).toBe(true);
      expect(isUnbound("")).toBe(true);
      expect(isUnbound("   ")).toBe(true);
    });

    it("isUnbound recognizes the documented keywords case-insensitively", () => {
      for (const v of ["none", "None", "NONE", "clear", "Unbound", "DISABLED", " disabled "]) {
        expect(isUnbound(v)).toBe(true);
      }
    });

    it("isUnbound rejects normal binding strings and non-strings", () => {
      expect(isUnbound("cmd+t")).toBe(false);
      expect(isUnbound("ctrl+shift+a")).toBe(false);
      expect(isUnbound(42)).toBe(false);
      expect(isUnbound({})).toBe(false);
    });

    it("validateConfig normalizes unbind values to empty string without warning", () => {
      const config = baseConfig() as any;
      config.keybindings.newTab = null;
      config.keybindings.closeTab = "none";
      config.keybindings.nextTab = "DISABLED";
      config.keybindings.prevTab = "";
      const corrections: string[] = [];
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = validateConfig(config as any, corrections);
      spy.mockRestore();
      expect(result.keybindings.newTab).toBe("");
      expect(result.keybindings.closeTab).toBe("");
      expect(result.keybindings.nextTab).toBe("");
      expect(result.keybindings.prevTab).toBe("");
      expect(corrections.filter((c) => c.startsWith("keybindings."))).toEqual([]);
    });

    it("validateConfig still corrects malformed (non-unbind) bindings", () => {
      const config = baseConfig() as any;
      config.keybindings.newTab = "not a real binding!@#";
      const corrections: string[] = [];
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      validateConfig(config as any, corrections);
      spy.mockRestore();
      expect(corrections).toContain("keybindings.newTab");
    });

    it("matchesKeybinding short-circuits on empty binding", () => {
      const event = {
        key: "t",
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
      } as unknown as KeyboardEvent;
      expect(matchesKeybinding(event, "")).toBe(false);
    });
  });
});
