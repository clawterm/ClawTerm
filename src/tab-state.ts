import { setBounded } from "./utils";

/** Structured git status from the Rust backend */
export interface GitStatusInfo {
  branch: string;
  modified: number;
  staged: number;
  untracked: number;
  ahead: number;
  behind: number;
  is_worktree: boolean;
  /** Lines added in the working tree (incl. new untracked files), used
   *  by the +N -M badge in the footer. 0 when nothing is pending. (#559) */
  lines_added: number;
  /** Lines removed in the working tree vs HEAD. */
  lines_removed: number;
}

/**
 * Claude Code statusLine protocol data, parsed from the JSON the
 * `statusline.sh` writer dumps after every assistant turn. Fields
 * the writer doesn't include are left undefined; we never fabricate.
 */
export interface StatusLineData {
  sessionId: string;
  model: { id: string; displayName: string };
  cost?: {
    totalCostUsd: number;
    totalDurationMs: number;
    totalApiDurationMs: number;
    totalLinesAdded: number;
    totalLinesRemoved: number;
  };
  contextWindow?: {
    /** Lifetime totals across the session — Claude Code names these
     *  `total_input_tokens` / `total_output_tokens` in the payload. */
    inputTokens: number;
    outputTokens: number;
    contextWindowSize: number;
    /** Claude Code emits this as nullable while the session is between
     *  turns; we coerce null → 0 in parse so callers can render the bar
     *  immediately instead of waiting for the first API response. */
    usedPercentage: number;
    remainingPercentage: number;
  };
  exceeds200kTokens?: boolean;
  effort?: { level: "low" | "medium" | "high" | "xhigh" | "max" };
  thinking?: { enabled: boolean };
  rateLimits?: {
    fiveHour?: { usedPercentage: number; resetsAt: number };
    sevenDay?: { usedPercentage: number; resetsAt: number };
  };
  vim?: { mode: "NORMAL" | "INSERT" | "VISUAL" | "VISUAL LINE" };
  agent?: { name: string };
  worktree?: { name: string; branch?: string };
  outputStyle?: { name: string };
}

// Type guards used by parseStatusLine.
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const obj = (parent: Record<string, unknown>, k: string): Record<string, unknown> | undefined => {
  const v = parent[k];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
};

/**
 * Parse Claude Code's statusLine JSON into our shape. Returns null if
 * the payload is malformed or missing required fields. Tolerant of
 * missing optional fields — the writer omits sections that don't apply.
 *
 * Claude Code emits snake_case (per the documented schema) so we don't
 * accept camelCase variants — wider tolerance would be dead code.
 */
export function parseStatusLine(json: string): StatusLineData | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const sessionId = str(r.session_id);
  const modelObj = obj(r, "model");
  const modelId = str(modelObj?.id);
  const modelDisplay = str(modelObj?.display_name);
  if (!sessionId || !modelId || !modelDisplay) return null;

  const out: StatusLineData = {
    sessionId,
    model: { id: modelId, displayName: modelDisplay },
  };

  const costObj = obj(r, "cost");
  if (costObj) {
    const totalCostUsd = num(costObj.total_cost_usd);
    const totalDurationMs = num(costObj.total_duration_ms);
    const totalApiDurationMs = num(costObj.total_api_duration_ms);
    const totalLinesAdded = num(costObj.total_lines_added);
    const totalLinesRemoved = num(costObj.total_lines_removed);
    if (
      totalCostUsd !== undefined &&
      totalDurationMs !== undefined &&
      totalApiDurationMs !== undefined &&
      totalLinesAdded !== undefined &&
      totalLinesRemoved !== undefined
    ) {
      out.cost = {
        totalCostUsd,
        totalDurationMs,
        totalApiDurationMs,
        totalLinesAdded,
        totalLinesRemoved,
      };
    }
  }

  const ctx = obj(r, "context_window");
  if (ctx) {
    const inputTokens = num(ctx.total_input_tokens);
    const outputTokens = num(ctx.total_output_tokens);
    const contextWindowSize = num(ctx.context_window_size);
    if (inputTokens !== undefined && outputTokens !== undefined && contextWindowSize !== undefined) {
      const usedPercentage = num(ctx.used_percentage) ?? 0;
      out.contextWindow = {
        inputTokens,
        outputTokens,
        contextWindowSize,
        usedPercentage,
        remainingPercentage: num(ctx.remaining_percentage) ?? 100 - usedPercentage,
      };
    }
  }

  const exceeds = bool(r.exceeds_200k_tokens);
  if (exceeds !== undefined) out.exceeds200kTokens = exceeds;

  const effortLevel = str(obj(r, "effort")?.level);
  if (
    effortLevel === "low" ||
    effortLevel === "medium" ||
    effortLevel === "high" ||
    effortLevel === "xhigh" ||
    effortLevel === "max"
  ) {
    out.effort = { level: effortLevel };
  }

  const thinkingEnabled = bool(obj(r, "thinking")?.enabled);
  if (thinkingEnabled !== undefined) out.thinking = { enabled: thinkingEnabled };

  const rl = obj(r, "rate_limits");
  if (rl) {
    const window = (key: string) => {
      const w = obj(rl, key);
      if (!w) return undefined;
      const used = num(w.used_percentage);
      const resets = num(w.resets_at);
      return used !== undefined && resets !== undefined
        ? { usedPercentage: used, resetsAt: resets }
        : undefined;
    };
    const five = window("five_hour");
    const seven = window("seven_day");
    if (five || seven) {
      out.rateLimits = {};
      if (five) out.rateLimits.fiveHour = five;
      if (seven) out.rateLimits.sevenDay = seven;
    }
  }

  const vimMode = str(obj(r, "vim")?.mode);
  if (vimMode === "NORMAL" || vimMode === "INSERT" || vimMode === "VISUAL" || vimMode === "VISUAL LINE") {
    out.vim = { mode: vimMode };
  }

  const agentName = str(obj(r, "agent")?.name);
  if (agentName) out.agent = { name: agentName };

  const wtObj = obj(r, "worktree");
  const wtName = str(wtObj?.name);
  if (wtName) {
    out.worktree = { name: wtName };
    const wtBranch = str(wtObj?.branch);
    if (wtBranch) out.worktree.branch = wtBranch;
  }

  const styleName = str(obj(r, "output_style")?.name);
  if (styleName) out.outputStyle = { name: styleName };

  return out;
}

export type ClaudeAttention = "rate-limit-near" | "compaction-imminent" | null;

const ATTENTION_RANK: Record<NonNullable<ClaudeAttention>, number> = {
  "compaction-imminent": 2,
  "rate-limit-near": 1,
};
const rankAttention = (a: ClaudeAttention): number => (a ? ATTENTION_RANK[a] : 0);

/**
 * Aggregate Claude attention signal across panes. Returns the most
 * urgent signal (compaction-imminent > rate-limit-near).
 *
 * Context-near-limit (≥85%) is no longer surfaced as a dot — the
 * sidebar context bar (#507) renders the same threshold in crit color,
 * making the dot redundant.
 */
export function deriveClaudeAttention(panes: readonly StatusLineData[]): ClaudeAttention {
  let best: ClaudeAttention = null;

  for (const sl of panes) {
    let signal: ClaudeAttention = null;
    const used = sl.contextWindow?.usedPercentage;

    if (sl.exceeds200kTokens && used != null && used >= 95) {
      signal = "compaction-imminent";
    } else {
      const five = sl.rateLimits?.fiveHour?.usedPercentage ?? 0;
      const seven = sl.rateLimits?.sevenDay?.usedPercentage ?? 0;
      if (five >= 90 || seven >= 90) signal = "rate-limit-near";
    }
    if (rankAttention(signal) > rankAttention(best)) best = signal;
  }
  return best;
}

/**
 * Max `usedPercentage` across panes — the value the sidebar bar
 * renders. Returns null when no pane has a Claude statusLine, so the
 * renderer can hide the bar entirely rather than show "0%". (#507)
 */
export function deriveClaudeContextPct(panes: readonly StatusLineData[]): number | null {
  let max: number | null = null;
  for (const sl of panes) {
    const used = sl.contextWindow?.usedPercentage;
    if (used == null) continue;
    if (max == null || used > max) max = used;
  }
  return max;
}

/** Per-pane state — tracks each pane independently */
export interface PaneState {
  folderName: string;
  isIdle: boolean;
  serverPort: number | null;
  lastError: string | null;
  /** Git branch this pane is on (per-pane tracking for worktree isolation) */
  gitBranch: string | null;
  /** Structured git status for this pane's CWD */
  gitStatus: GitStatusInfo | null;
  /** Claude Code statusLine data — context usage, cost, model (#348) */
  statusLine: StatusLineData | null;
  /** Foreground process RSS in bytes — null when the syscall fails or
   *  hasn't reported yet. Surfaced as the per-pane memory badge. (#560) */
  residentSize: number | null;
}

export function createDefaultPaneState(): PaneState {
  return {
    folderName: "~",
    isIdle: true,
    serverPort: null,
    lastError: null,
    gitBranch: null,
    gitStatus: null,
    statusLine: null,
    residentSize: null,
  };
}

/** Bucket-quantize a diff line count for the +N/-N badge. Mirrors the
 *  display-quantization strategy of formatResidentSize: the key only
 *  changes when the visible bucket flips, so a 1-line edit during active
 *  typing doesn't trigger a full footer repaint. Returns "" for n<=0 so
 *  the badge collapses cleanly. (#562) */
export function formatDiffCount(n: number): string {
  if (n <= 0) return "";
  if (n < 10) return String(n);
  if (n < 100) return `${Math.floor(n / 10) * 10}+`;
  if (n < 1000) return `${Math.floor(n / 100) * 100}+`;
  return "1k+";
}

/** Format a byte count as a short human-readable badge string ("156M",
 *  "1.2G", "42K"). Mirrors htop's display style — base-1024 units to
 *  match the macOS Memory column convention. Returns "" for null/zero
 *  so the badge collapses cleanly. (#560) */
export function formatResidentSize(bytes: number | null): string {
  if (bytes == null || bytes <= 0) return "";
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytes >= GB) {
    const v = bytes / GB;
    return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}G`;
  }
  if (bytes >= MB) return `${Math.round(bytes / MB)}M`;
  if (bytes >= KB) return `${Math.round(bytes / KB)}K`;
  return `${bytes}B`;
}

/** Notification type for background tab badges */
export type NotificationType = "error" | "server-started" | "server-crashed" | null;

export interface TabState {
  folderName: string;
  isIdle: boolean;
  needsAttention: boolean;
  serverPort: number | null;
  projectName: string | null;
  lastError: string | null;
  gitBranch: string | null;
  /** Structured git status (modified/staged/ahead/behind counts) */
  gitStatus: GitStatusInfo | null;
  /** Notification type for background badges — persists until tab is focused */
  notification: NotificationType;
  /** Aggregated Claude Code attention signal across panes. */
  claudeAttention: ClaudeAttention;
  /** Max context-window `usedPercentage` across panes; null when no pane has
   *  a Claude statusLine. Sidebar renders the bar from this. (#507) */
  claudeContextPct: number | null;
}

export function createDefaultTabState(): TabState {
  return {
    folderName: "~",
    isIdle: true,
    needsAttention: false,
    serverPort: null,
    projectName: null,
    lastError: null,
    gitBranch: null,
    gitStatus: null,
    notification: null,
    claudeAttention: null,
    claudeContextPct: null,
  };
}

/** Tab title shown in sidebar — project or folder name with a leading slash */
export function computeFolderTitle(state: TabState): string {
  const folder = state.projectName || state.folderName || "~";
  if (folder === "~" || folder === "/") return folder;
  return `/${folder}`;
}

/** Format elapsed time as compact M:SS, H:MM:SS, or Nd Hh past 24 hours
 *  (#335, #506). The day-bucketed form caps the string to ≤6 characters
 *  so a multi-day pane doesn't push the truncatable footer items into
 *  ellipsis just because nobody closed the tab. */
export function formatElapsed(startMs: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  const s = secs % 60;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}:${s.toString().padStart(2, "0")}`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) {
    return `${hrs}:${(mins % 60).toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

/** Deterministic branch color, drawn from the same brand-tuned bright
 *  ANSI hues the terminal renders (#525, #527). Reusing the terminal
 *  palette keeps branch labels and terminal text in the same visual
 *  family — calmer than the previous saturated iOS palette. */
const BRANCH_COLORS = [
  "#F07178",
  "#3DD68C",
  "#FFD666",
  "#82AAFF",
  "#D4A0FF",
  "#7DD3FC",
  "#A8C0FF",
  "#FF8A8E",
];
const BRANCH_COLOR_CACHE_MAX = 256;
const branchColorCache = new Map<string, string>();

/** Diagnostic accessor: number of distinct branches that have been
 *  color-assigned this session, paired with the bounded ceiling. Surfaced
 *  by the memory-diagnostics command (#566). */
export function getBranchColorCacheSize(): { size: number; max: number } {
  return { size: branchColorCache.size, max: BRANCH_COLOR_CACHE_MAX };
}

export function branchColor(branch: string): string {
  const cached = branchColorCache.get(branch);
  if (cached !== undefined) return cached;
  let hash = 0;
  for (let i = 0; i < branch.length; i++) {
    hash = ((hash << 5) - hash + branch.charCodeAt(i)) | 0;
  }
  const color = BRANCH_COLORS[Math.abs(hash) % BRANCH_COLORS.length];
  setBounded(branchColorCache, branch, color, BRANCH_COLOR_CACHE_MAX);
  return color;
}
