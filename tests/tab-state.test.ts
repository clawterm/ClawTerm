import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createDefaultTabState,
  createDefaultPaneState,
  computeFolderTitle,
  formatElapsed,
  parseStatusLine,
  deriveClaudeAttention,
  type TabState,
  type StatusLineData,
} from "../src/tab-state";

function makeState(overrides: Partial<TabState> = {}): TabState {
  return { ...createDefaultTabState(), ...overrides };
}

describe("createDefaultTabState", () => {
  it("returns idle state with default folder", () => {
    const state = createDefaultTabState();
    expect(state.folderName).toBe("~");
    expect(state.isIdle).toBe(true);
    expect(state.needsAttention).toBe(false);
    expect(state.serverPort).toBeNull();
    expect(state.projectName).toBeNull();
    expect(state.lastError).toBeNull();
  });

  it("returns independent objects", () => {
    const a = createDefaultTabState();
    const b = createDefaultTabState();
    a.folderName = "changed";
    expect(b.folderName).toBe("~");
  });
});

describe("computeFolderTitle", () => {
  it("returns /projectName when set", () => {
    expect(computeFolderTitle(makeState({ projectName: "myapp" }))).toBe("/myapp");
  });

  it("returns /folderName when no project", () => {
    expect(computeFolderTitle(makeState({ folderName: "src" }))).toBe("/src");
  });

  it("returns ~ for home directory", () => {
    expect(computeFolderTitle(makeState({ folderName: "~" }))).toBe("~");
  });

  it("returns / for root", () => {
    expect(computeFolderTitle(makeState({ folderName: "/" }))).toBe("/");
  });

  it("prefers projectName over folderName", () => {
    expect(computeFolderTitle(makeState({ folderName: "dir", projectName: "App" }))).toBe("/App");
  });
});

describe("createDefaultPaneState", () => {
  it("returns idle state", () => {
    const state = createDefaultPaneState();
    expect(state.folderName).toBe("~");
    expect(state.isIdle).toBe(true);
    expect(state.serverPort).toBeNull();
    expect(state.gitBranch).toBeNull();
  });
});

describe("parseStatusLine", () => {
  it("returns null for invalid JSON", () => {
    expect(parseStatusLine("not json")).toBeNull();
    expect(parseStatusLine("")).toBeNull();
    expect(parseStatusLine("null")).toBeNull();
    expect(parseStatusLine("[]")).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    expect(parseStatusLine(JSON.stringify({}))).toBeNull();
    expect(parseStatusLine(JSON.stringify({ session_id: "s1" }))).toBeNull();
    expect(parseStatusLine(JSON.stringify({ model: { id: "x" } }))).toBeNull();
  });

  it("parses a minimal payload (only required fields)", () => {
    const json = JSON.stringify({
      session_id: "s1",
      model: { id: "claude-opus-4-7", display_name: "Claude Opus 4.7" },
    });
    const parsed = parseStatusLine(json);
    expect(parsed).not.toBeNull();
    expect(parsed!.sessionId).toBe("s1");
    expect(parsed!.model.id).toBe("claude-opus-4-7");
    expect(parsed!.model.displayName).toBe("Claude Opus 4.7");
    expect(parsed!.cost).toBeUndefined();
    expect(parsed!.contextWindow).toBeUndefined();
    expect(parsed!.effort).toBeUndefined();
    expect(parsed!.thinking).toBeUndefined();
    expect(parsed!.rateLimits).toBeUndefined();
    expect(parsed!.vim).toBeUndefined();
  });

  it("parses a full payload (snake_case)", () => {
    const json = JSON.stringify({
      session_id: "s2",
      model: { id: "x", display_name: "X" },
      cost: {
        total_cost_usd: 1.23,
        total_duration_ms: 1000,
        total_api_duration_ms: 800,
        total_lines_added: 10,
        total_lines_removed: 5,
      },
      context_window: {
        total_input_tokens: 100,
        total_output_tokens: 50,
        context_window_size: 200000,
        used_percentage: 42.5,
        remaining_percentage: 57.5,
      },
      exceeds_200k_tokens: false,
      effort: { level: "high" },
      thinking: { enabled: true },
      rate_limits: {
        five_hour: { used_percentage: 25, resets_at: 1000 },
        seven_day: { used_percentage: 5, resets_at: 2000 },
      },
      vim: { mode: "INSERT" },
      agent: { name: "default" },
      worktree: { name: "feat-x", branch: "feat-x" },
      output_style: { name: "default" },
    });
    const parsed = parseStatusLine(json);
    expect(parsed).not.toBeNull();
    expect(parsed!.cost?.totalCostUsd).toBe(1.23);
    expect(parsed!.contextWindow?.usedPercentage).toBe(42.5);
    expect(parsed!.exceeds200kTokens).toBe(false);
    expect(parsed!.effort?.level).toBe("high");
    expect(parsed!.thinking?.enabled).toBe(true);
    expect(parsed!.rateLimits?.fiveHour?.usedPercentage).toBe(25);
    expect(parsed!.rateLimits?.sevenDay?.usedPercentage).toBe(5);
    expect(parsed!.vim?.mode).toBe("INSERT");
    expect(parsed!.agent?.name).toBe("default");
    expect(parsed!.worktree?.branch).toBe("feat-x");
    expect(parsed!.outputStyle?.name).toBe("default");
  });

  it("tolerates absent optional sections (rate_limits, effort, vim, agent, worktree)", () => {
    const json = JSON.stringify({
      session_id: "s3",
      model: { id: "x", display_name: "X" },
      context_window: {
        total_input_tokens: 0,
        total_output_tokens: 0,
        context_window_size: 200000,
        used_percentage: null,
        remaining_percentage: null,
      },
    });
    const parsed = parseStatusLine(json);
    expect(parsed).not.toBeNull();
    // null used_percentage coerces to 0 so a fresh session renders the bar
    // empty instead of skipping it entirely.
    expect(parsed!.contextWindow?.usedPercentage).toBe(0);
    expect(parsed!.contextWindow?.remainingPercentage).toBe(100);
    expect(parsed!.rateLimits).toBeUndefined();
    expect(parsed!.effort).toBeUndefined();
    expect(parsed!.vim).toBeUndefined();
    expect(parsed!.agent).toBeUndefined();
    expect(parsed!.worktree).toBeUndefined();
  });

  it("rejects unknown effort and vim mode values rather than letting them through", () => {
    const parsed = parseStatusLine(
      JSON.stringify({
        session_id: "s4",
        model: { id: "x", display_name: "X" },
        effort: { level: "extreme" },
        vim: { mode: "NORMAL_BAD" },
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.effort).toBeUndefined();
    expect(parsed!.vim).toBeUndefined();
  });

  it("drops cost block when any required cost field is missing", () => {
    const parsed = parseStatusLine(
      JSON.stringify({
        session_id: "s5",
        model: { id: "x", display_name: "X" },
        cost: { total_cost_usd: 1 },
      }),
    );
    expect(parsed!.cost).toBeUndefined();
  });
});

describe("deriveClaudeAttention", () => {
  const make = (overrides: Partial<StatusLineData> = {}): StatusLineData => ({
    sessionId: "s",
    model: { id: "x", displayName: "X" },
    ...overrides,
  });

  it("returns null when no panes have status", () => {
    expect(deriveClaudeAttention([])).toBeNull();
    expect(deriveClaudeAttention([make()])).toBeNull();
  });

  it("flags context-near-limit at 85%", () => {
    const sl = make({
      contextWindow: { inputTokens: 1, outputTokens: 1, contextWindowSize: 200000, usedPercentage: 85, remainingPercentage: 15 },
    });
    expect(deriveClaudeAttention([sl])).toBe("context-near-limit");
  });

  it("flags rate-limit-near at 90% (fiveHour or sevenDay)", () => {
    const five = make({ rateLimits: { fiveHour: { usedPercentage: 90, resetsAt: 0 } } });
    const seven = make({ rateLimits: { sevenDay: { usedPercentage: 95, resetsAt: 0 } } });
    expect(deriveClaudeAttention([five])).toBe("rate-limit-near");
    expect(deriveClaudeAttention([seven])).toBe("rate-limit-near");
  });

  it("flags compaction-imminent only when exceeds_200k AND ctx ≥95%", () => {
    const onlyFlag = make({ exceeds200kTokens: true });
    const onlyCtx = make({
      contextWindow: { inputTokens: 1, outputTokens: 1, contextWindowSize: 200000, usedPercentage: 96, remainingPercentage: 4 },
    });
    const both = make({
      exceeds200kTokens: true,
      contextWindow: { inputTokens: 1, outputTokens: 1, contextWindowSize: 200000, usedPercentage: 96, remainingPercentage: 4 },
    });
    expect(deriveClaudeAttention([onlyFlag])).toBeNull();
    expect(deriveClaudeAttention([onlyCtx])).toBe("context-near-limit");
    expect(deriveClaudeAttention([both])).toBe("compaction-imminent");
  });

  it("picks the highest-rank signal across panes", () => {
    const ctxNear = make({
      contextWindow: { inputTokens: 1, outputTokens: 1, contextWindowSize: 200000, usedPercentage: 86, remainingPercentage: 14 },
    });
    const compact = make({
      exceeds200kTokens: true,
      contextWindow: { inputTokens: 1, outputTokens: 1, contextWindowSize: 200000, usedPercentage: 96, remainingPercentage: 4 },
    });
    expect(deriveClaudeAttention([ctxNear, compact])).toBe("compaction-imminent");
  });
});

describe("formatElapsed", () => {
  // Frozen clock — Date.now() is read both inside the test and inside
  // formatElapsed, so without freezing the test could flake on a slow
  // CI runner if the wall clock crosses a second between the two reads.
  const NOW = 1_700_000_000_000;
  beforeEach(() => vi.useFakeTimers().setSystemTime(NOW));
  afterEach(() => vi.useRealTimers());

  const at = (offsetMs: number) => NOW - offsetMs;

  it("uses M:SS for the first hour", () => {
    expect(formatElapsed(at(0))).toBe("0:00");
    expect(formatElapsed(at(45 * 1000))).toBe("0:45");
    expect(formatElapsed(at(75 * 1000))).toBe("1:15");
    expect(formatElapsed(at(59 * 60 * 1000))).toBe("59:00");
  });

  it("uses H:MM:SS between 1 hour and 24 hours", () => {
    expect(formatElapsed(at(60 * 60 * 1000))).toBe("1:00:00");
    expect(formatElapsed(at(23 * 60 * 60 * 1000 + 30 * 60 * 1000))).toBe("23:30:00");
  });

  it("caps at Nd Hh past 24 hours so width stays bounded", () => {
    expect(formatElapsed(at(24 * 60 * 60 * 1000))).toBe("1d 0h");
    expect(formatElapsed(at(7 * 24 * 60 * 60 * 1000 + 14 * 60 * 60 * 1000))).toBe("7d 14h");
  });
});
