import { invoke } from "@tauri-apps/api/core";
import { logger } from "./logger";
import { modKey } from "./utils";
import { showToast } from "./toast";

// Re-export types so existing `import type { Config } from "./config"` still works
export type { Config, UserMatcher } from "./config-types";
import type { Config } from "./config-types";

/** Current config schema version. Bump when adding/changing config fields. */
const CONFIG_VERSION = 6;

/** Return the default shell. */
function defaultShell(): string {
  return "/bin/zsh";
}

/** Return appropriate default shell args based on shell name. */
function defaultShellArgs(shell: string): string[] {
  const basename = shell.split("/").pop()?.toLowerCase() ?? "";
  // Nushell uses -l, most POSIX shells support --login for sourcing profile files
  if (basename === "nu" || basename === "nushell") return ["-l"];
  return ["--login"];
}

/** Default font family — JetBrains Mono everywhere, system monospace as fallback. */
const defaultFontFamily = '"JetBrains Mono Variable", "JetBrains Mono", monospace';

const _defaultShell = defaultShell();

/**
 * ClawTerm's fixed terminal color palette — tuned to the brand dark palette.
 * Used by xterm.js for ANSI color rendering. Not user-configurable.
 */
export const TERMINAL_THEME = {
  background: "#07080A",
  foreground: "#F4F4F5",
  cursor: "#7CFF4F",
  cursorAccent: "#050607",
  selectionBackground: "#3A3A44",
  selectionForeground: "#ffffff",
  black: "#131316",
  red: "#E5484D",
  green: "#30A46C",
  yellow: "#F5A623",
  blue: "#5B8DEF",
  magenta: "#BF7AF0",
  cyan: "#4CC9F0",
  white: "#E0E0E4",
  brightBlack: "#5A5A66",
  brightRed: "#F07178",
  brightGreen: "#3DD68C",
  brightYellow: "#FFD666",
  brightBlue: "#82AAFF",
  brightMagenta: "#D4A0FF",
  brightCyan: "#7DD3FC",
  brightWhite: "#FAFAFA",
} as const;

export const DEFAULT_CONFIG: Config = {
  configVersion: CONFIG_VERSION,
  shell: _defaultShell,
  shellArgs: defaultShellArgs(_defaultShell),
  font: {
    family: defaultFontFamily,
    size: 14,
    lineHeight: 1.3,
  },
  cursor: {
    style: "bar",
    blink: false,
  },
  scrollback: 5000,
  copyOnSelect: false,
  sidebar: {
    width: 200,
    position: "left",
  },
  keybindings: {
    newTab: `${modKey}+t`,
    closeTab: `${modKey}+w`,
    nextTab: `${modKey}+shift+]`,
    prevTab: `${modKey}+shift+[`,
    reloadConfig: `${modKey}+shift+r`,
    cycleAttention: `${modKey}+shift+a`,
    search: `${modKey}+f`,
    quickSwitch: `${modKey}+p`,
    splitHorizontal: `${modKey}+d`,
    splitVertical: `${modKey}+shift+d`,
    closePane: `${modKey}+shift+w`,
    focusNextPane: `${modKey}+]`,
    focusPrevPane: `${modKey}+[`,
    commandPalette: `${modKey}+shift+p`,
    zoomIn: `${modKey}+=`,
    zoomOut: `${modKey}+-`,
    zoomReset: `${modKey}+0`,
    restoreTab: `${modKey}+shift+t`,
    nextProject: `${modKey}+alt+]`,
    prevProject: `${modKey}+alt+[`,
    newProject: "",
    newWindow: `${modKey}+n`,
    newWorktreeTab: `${modKey}+shift+n`,
    toggleWorkspacePanel: `${modKey}+shift+b`,
    jumpToBranch: `${modKey}+shift+g`,
  },
  quickCommands: {
    [`${modKey}+shift+c`]: "claude --dangerously-skip-permissions\n",
  },
  startupCommands: {},
  maxTabs: 20,
  maxPanes: 8,
  worktree: {
    // "" → auto: <parent-of-repo>/.clawterm-worktrees/<repo-name>/
    // Sibling-of-repo isolation prevents biome/vitest/tsc from walking into
    // worktree config files and breaking parent-repo tooling (#415, #416).
    // Power users can set an absolute path or a relative dir to opt back in
    // to a central cache or the legacy in-repo layout — see resolveWorktreeBase.
    directory: "",
    postCreateHooks: [],
    autoCleanup: false,
    defaultAgent: "",
  },
  outputAnalysis: {
    enabled: true,
    customMatchers: [],
    showEventGutter: false,
  },
  notifications: {
    enabled: true,
    commandCompletion: false,
    commandCompletionThresholdMs: 30_000,
  },
  updates: {
    autoCheck: true,
    checkIntervalMs: 3_600_000,
    mode: "download",
  },
  advanced: {
    pollIntervalMs: 1000,
    backgroundPollIntervalMs: 5000,
    healthCheckIntervalMs: 10000,
    ipcTimeoutMs: 5000,
  },
};

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object"
    ) {
      result[key] = deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

const CURSOR_STYLES = ["bar", "block", "underline"];

/** Values that explicitly disable a keybinding (#484). */
const UNBIND_KEYWORDS = new Set(["", "none", "clear", "unbound", "disabled"]);

/** True when the given value should be treated as "no keybinding". */
export function isUnbound(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v !== "string") return false;
  return UNBIND_KEYWORDS.has(v.trim().toLowerCase());
}

export function validateConfig(config: Config, corrections?: string[]): Config {
  const result = { ...config };
  const warn = (field: string, msg: string) => {
    logger.warn(`Config: invalid ${field} — ${msg}. Using default.`);
    corrections?.push(field);
  };

  // Shell
  if (typeof result.shell !== "string" || result.shell.length === 0) {
    warn("shell", "must be a non-empty string");
    result.shell = DEFAULT_CONFIG.shell;
  }

  // Shell args — default based on shell name if not explicitly set
  if (!Array.isArray(result.shellArgs)) {
    result.shellArgs = defaultShellArgs(result.shell);
  } else {
    result.shellArgs = result.shellArgs.filter((a) => typeof a === "string");
  }

  // Font
  if (typeof result.font.size !== "number" || result.font.size < 6 || result.font.size > 72) {
    warn("font.size", "must be 6–72");
    result.font = { ...result.font, size: DEFAULT_CONFIG.font.size };
  }
  if (
    typeof result.font.lineHeight !== "number" ||
    result.font.lineHeight < 0.5 ||
    result.font.lineHeight > 3
  ) {
    warn("font.lineHeight", "must be 0.5–3");
    result.font = { ...result.font, lineHeight: DEFAULT_CONFIG.font.lineHeight };
  }

  // Scrollback
  if (typeof result.scrollback !== "number" || result.scrollback < 100 || result.scrollback > 100000) {
    warn("scrollback", "must be 100–100000");
    result.scrollback = DEFAULT_CONFIG.scrollback;
  }

  // Cursor
  if (!CURSOR_STYLES.includes(result.cursor.style)) {
    warn("cursor.style", `must be one of: ${CURSOR_STYLES.join(", ")}`);
    result.cursor = { ...result.cursor, style: DEFAULT_CONFIG.cursor.style };
  }

  // Sidebar
  if (typeof result.sidebar.width !== "number" || result.sidebar.width < 100 || result.sidebar.width > 600) {
    warn("sidebar.width", "must be 100–600");
    result.sidebar = { ...result.sidebar, width: DEFAULT_CONFIG.sidebar.width };
  }
  if (result.sidebar.position !== "left" && result.sidebar.position !== "right") {
    warn("sidebar.position", "must be 'left' or 'right'");
    result.sidebar = { ...result.sidebar, position: DEFAULT_CONFIG.sidebar.position };
  }

  // Keybindings — validate format (modifier+key). Unbind values are
  // intentional opt-outs (#484) and normalize to "" without warning.
  const KEYBINDING_RE = /^(?:(?:cmd|ctrl|shift|alt|opt)\+)*[a-z0-9[\]\\/\-=`,.';\s]+$/i;
  if (result.keybindings) {
    for (const [key, val] of Object.entries(result.keybindings)) {
      if (isUnbound(val)) {
        (result.keybindings as Record<string, string>)[key] = "";
        continue;
      }
      if (typeof val !== "string" || !KEYBINDING_RE.test(val)) {
        warn(`keybindings.${key}`, `invalid format "${val}"`);
        const defaultVal = (DEFAULT_CONFIG.keybindings as Record<string, string>)[key];
        if (defaultVal) {
          (result.keybindings as Record<string, string>)[key] = defaultVal;
        }
      }
    }
  }

  // Quick commands — validate keybinding format and string values
  if (result.quickCommands && typeof result.quickCommands === "object") {
    for (const [key, val] of Object.entries(result.quickCommands)) {
      if (!KEYBINDING_RE.test(key)) {
        warn(`quickCommands key "${key}"`, "invalid keybinding format");
        delete (result.quickCommands as Record<string, string>)[key];
      } else if (typeof val !== "string") {
        warn(`quickCommands.${key}`, "value must be a string");
        delete (result.quickCommands as Record<string, string>)[key];
      }
    }
  }

  // Startup commands — validate string values
  if (result.startupCommands && typeof result.startupCommands === "object") {
    for (const [key, val] of Object.entries(result.startupCommands)) {
      if (typeof val !== "string") {
        warn(`startupCommands.${key}`, "value must be a string");
        delete (result.startupCommands as Record<string, string>)[key];
      }
    }
  }

  // Advanced numeric fields — clamp to sane ranges
  const clampNum = (field: keyof Config["advanced"], min: number, max: number) => {
    const val = result.advanced[field];
    if (typeof val !== "number" || val < min || val > max) {
      warn(`advanced.${field}`, `must be ${min}–${max}`);
      result.advanced = { ...result.advanced, [field]: DEFAULT_CONFIG.advanced[field] };
    }
  };

  // Clamp maxPanes — WebGL is now lazy (only active tab uses GPU contexts)
  // so we can allow more panes.  Still cap to prevent extreme resource usage.
  if (typeof result.maxPanes !== "number" || result.maxPanes < 1 || result.maxPanes > 16) {
    warn("maxPanes", "must be 1–16");
    result.maxPanes = DEFAULT_CONFIG.maxPanes;
  }

  clampNum("pollIntervalMs", 500, 30000);
  clampNum("backgroundPollIntervalMs", 1000, 60000);
  clampNum("healthCheckIntervalMs", 2000, 120000);
  clampNum("ipcTimeoutMs", 2000, 30000);

  // Update check interval — 5 minutes to 24 hours
  if (result.updates) {
    if (
      typeof result.updates.checkIntervalMs !== "number" ||
      result.updates.checkIntervalMs < 300_000 ||
      result.updates.checkIntervalMs > 86_400_000
    ) {
      warn("updates.checkIntervalMs", "must be 300000–86400000 (5 min – 24 hours)");
      result.updates = { ...result.updates, checkIntervalMs: DEFAULT_CONFIG.updates.checkIntervalMs };
    }
    const mode = result.updates.mode;
    if (mode !== "manual" && mode !== "download" && mode !== "auto") {
      warn("updates.mode", `must be "manual", "download", or "auto"`);
      result.updates = { ...result.updates, mode: DEFAULT_CONFIG.updates.mode };
    }
  }

  return result;
}

/**
 * Migrate config from older schema versions to the current version.
 * Each migration function handles one version bump. Runs in order
 * so configs from any past version reach the current schema.
 */
function migrateConfig(config: Record<string, unknown>): void {
  const version = typeof config.configVersion === "number" ? config.configVersion : 0;

  if (version >= CONFIG_VERSION) return;

  // Migration 0 → 1: add configVersion, updates section
  if (version < 1) {
    config.configVersion = 1;
    if (!config.updates) {
      config.updates = { autoCheck: true, checkIntervalMs: 3_600_000 };
    }
    logger.debug("Migrated config from v0 to v1");
  }

  // Migration 1 → 2: bump update check interval from aggressive 60s to 1h
  if (version < 2) {
    config.configVersion = 2;
    const updates = config.updates as Record<string, unknown> | undefined;
    if (updates && updates.checkIntervalMs === 60_000) {
      updates.checkIntervalMs = 3_600_000;
    }
    logger.debug("Migrated config from v1 to v2");
  }

  // Migration 2 → 3: drop legacy notifications.types subtree — only OSC 9;2
  // (agentWaiting) is a notification surface now. (#547)
  if (version < 3) {
    config.configVersion = 3;
    const notifications = config.notifications as Record<string, unknown> | undefined;
    if (notifications && "types" in notifications) {
      delete notifications.types;
    }
    logger.debug("Migrated config from v2 to v3");
  }

  // Migration 3 → 4: drop notifications.sound — the Web Audio chime
  // bypassed macOS Focus/DND and was redundant with the OS notification
  // sound. Notifications are now silent app-side; OS sound (if any) is
  // controlled by macOS notification settings.
  if (version < 4) {
    config.configVersion = 4;
    const notifications = config.notifications as Record<string, unknown> | undefined;
    if (notifications && "sound" in notifications) {
      delete notifications.sound;
    }
    logger.debug("Migrated config from v3 to v4");
  }

  // Migration 4 → 5: replace updates.autoInstall:boolean with updates.mode
  // tri-state. autoInstall:true → "auto" (preserve intent); false/absent →
  // "download" (auto-download in background, install on user click or on next
  // quit — same friction as before plus install-on-quit so long-running
  // sessions aren't interrupted). (#558)
  if (version < 5) {
    config.configVersion = 5;
    const updates = config.updates as Record<string, unknown> | undefined;
    if (updates && !("mode" in updates)) {
      updates.mode = updates.autoInstall === true ? "auto" : "download";
      delete updates.autoInstall;
    }
    logger.debug("Migrated config from v4 to v5");
  }

  // Migration 5 → 6: introduce notifications.commandCompletion (opt-in,
  // default false) + threshold. PID-heuristic completion banner for
  // long-running shell tasks in background tabs. (#552 phase 1)
  if (version < 6) {
    config.configVersion = 6;
    const notifications = config.notifications as Record<string, unknown> | undefined;
    if (notifications) {
      if (!("commandCompletion" in notifications)) {
        notifications.commandCompletion = false;
      }
      if (!("commandCompletionThresholdMs" in notifications)) {
        notifications.commandCompletionThresholdMs = 30_000;
      }
    }
    logger.debug("Migrated config from v5 to v6");
  }

  // Migration: strip legacy theme fields from user config
  delete config.theme;
}

export async function loadConfig(): Promise<Config> {
  try {
    const text = await invoke<string>("read_config");

    if (!text) {
      // No config file exists, write defaults
      await invoke("write_config", {
        contents: JSON.stringify(DEFAULT_CONFIG, null, 2),
      });
      return { ...DEFAULT_CONFIG };
    }

    const userConfig: Record<string, unknown> = JSON.parse(text);

    // Run migrations if config version is older than current
    migrateConfig(userConfig);

    // If user set a custom shell but didn't specify shellArgs, derive smart defaults
    if (userConfig.shell && !userConfig.shellArgs) {
      userConfig.shellArgs = defaultShellArgs(userConfig.shell as string);
    }

    // Strip legacy theme field from user config before merging
    delete userConfig.theme;

    const merged = deepMerge(
      DEFAULT_CONFIG as unknown as Record<string, unknown>,
      userConfig,
    ) as unknown as Config;

    const corrections: string[] = [];
    const validated = validateConfig(merged, corrections);

    // Check shell path exists and is executable on disk
    try {
      const shellOk = await invoke<boolean>("validate_shell", { path: validated.shell });
      if (!shellOk) {
        logger.warn(`Config: shell "${validated.shell}" not found or not executable. Using default.`);
        showToast(`Shell "${validated.shell}" not found — using ${DEFAULT_CONFIG.shell}`, "warn");
        validated.shell = DEFAULT_CONFIG.shell;
      }
    } catch (e) {
      logger.warn("Shell validation failed:", e);
    }

    if (corrections.length > 0) {
      const summary =
        corrections.length === 1
          ? `Config: invalid value for "${corrections[0]}" — reverted to default`
          : `Config: ${corrections.length} invalid values reverted to defaults (${corrections.slice(0, 3).join(", ")}${corrections.length > 3 ? ", …" : ""})`;
      showToast(summary, "warn", 6000);
    }

    return validated;
  } catch (e) {
    logger.warn("Failed to load config, using defaults:", e);
    showToast("Config file is invalid — using defaults", "warn");
    return { ...DEFAULT_CONFIG };
  }
}

/** Apply config-derived values to CSS custom properties. */
export function applyConfigToCSS(config: Config) {
  const root = document.documentElement;
  root.style.setProperty("--sidebar-width", `${config.sidebar.width}px`);
}

// Maps a key to its shifted counterpart for bindings like "cmd+=" that should
// also match when the user presses Cmd+Shift+= (which produces "+").
const SHIFTED_KEYS: Record<string, string> = {
  "=": "+",
  "-": "_",
  "[": "{",
  "]": "}",
  "\\": "|",
  ";": ":",
  "'": '"',
  ",": "<",
  ".": ">",
  "/": "?",
  "`": "~",
};

const MODIFIER_ONLY_KEYS = new Set(["Meta", "Control", "Shift", "Alt", "AltGraph"]);

/**
 * Build a binding string in our canonical format from a keydown event.
 * Returns null if the user only pressed modifiers (waiting for the chord).
 *
 * The key part is `e.key.toLowerCase()` — same vocabulary `matchesKeybinding`
 * compares against — so a string produced here round-trips through the matcher.
 */
export function eventToBinding(e: KeyboardEvent): string | null {
  if (MODIFIER_ONLY_KEYS.has(e.key)) return null;
  const parts: string[] = [];
  if (e.metaKey) parts.push("cmd");
  if (e.ctrlKey) parts.push("ctrl");
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");
  parts.push(e.key.toLowerCase());
  return parts.join("+");
}

export function matchesKeybinding(e: KeyboardEvent, binding: string): boolean {
  if (!binding) return false;
  const parts = binding.toLowerCase().split("+");
  const wantCmd = parts.includes("cmd");
  const wantCtrl = parts.includes("ctrl");
  const wantShift = parts.includes("shift");
  const wantAlt = parts.includes("alt") || parts.includes("opt");
  const key = parts[parts.length - 1];

  // cmd = metaKey (Mac ⌘), ctrl = ctrlKey — treated as distinct modifiers
  const cmdOk = wantCmd ? e.metaKey : !e.metaKey;
  const ctrlOk = wantCtrl ? e.ctrlKey : !e.ctrlKey;
  const altOk = wantAlt ? e.altKey : !e.altKey;
  const keyOk = e.key.toLowerCase() === key;

  // When Shift is not explicitly required by the binding but the user holds it,
  // accept the keypress if the resulting key matches the shifted variant of the
  // bound key (e.g. binding "cmd+=" also matches Cmd+Shift+= which produces "+").
  const shiftedKey = SHIFTED_KEYS[key];
  const shiftOk = wantShift ? e.shiftKey : !e.shiftKey || (shiftedKey !== undefined && e.key === shiftedKey);
  const keyOkFinal = keyOk || (!wantShift && e.key === shiftedKey);

  return cmdOk && ctrlOk && shiftOk && altOk && keyOkFinal;
}
