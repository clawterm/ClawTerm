import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ScrollAnchor } from "../src/scroll-anchor";
import { logger } from "../src/logger";

interface FakeBuffer {
  baseY: number;
  viewportY: number;
  length: number;
}

function makeFakeTerminal(buf: FakeBuffer) {
  const calls: { type: "scrollToBottom" } | { type: "scrollToLine"; line: number } | null = null;
  const log: Array<{ type: string; line?: number }> = [];
  return {
    buffer: { active: buf },
    scrollToBottom: () => log.push({ type: "scrollToBottom" }),
    scrollToLine: (line: number) => log.push({ type: "scrollToLine", line }),
    _calls: calls,
    _log: log,
  };
}

describe("ScrollAnchor", () => {
  let buf: FakeBuffer;
  let term: ReturnType<typeof makeFakeTerminal>;
  let anchor: ScrollAnchor;

  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
    buf = { baseY: 100, viewportY: 100, length: 5000 };
    term = makeFakeTerminal(buf);
    // ScrollAnchor only touches buffer.active and the two scrollTo methods,
    // so a structurally compatible stub is sufficient.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    anchor = new ScrollAnchor(term as any, "test-pane");
  });

  it("starts not locked, not fitting, not scrolled up", () => {
    expect(anchor.isLocked).toBe(false);
    expect(anchor.isFitting).toBe(false);
    expect(anchor.isUserScrolledUp).toBe(false);
    expect(anchor.isScrolledUp).toBe(false);
  });

  it("currentDistance returns live distance when not locked", () => {
    buf.viewportY = 95;
    expect(anchor.currentDistance()).toBe(5);
    buf.viewportY = 100;
    expect(anchor.currentDistance()).toBe(0);
  });

  it("currentDistance returns locked anchor when locked, even if buffer mutates", () => {
    buf.viewportY = 95;
    anchor.lock();
    expect(anchor.currentDistance()).toBe(5);
    // Buffer state changes mid-lock — locked anchor must not move.
    buf.baseY = 200;
    buf.viewportY = 200;
    expect(anchor.currentDistance()).toBe(5);
  });

  it("ensureFlushAnchor snapshots once and holds across calls until cleared", () => {
    buf.viewportY = 95;
    expect(anchor.ensureFlushAnchor()).toBe(5);
    // Distance changes — anchor must remain at original snapshot.
    buf.viewportY = 100;
    expect(anchor.ensureFlushAnchor()).toBe(5);
    anchor.clearFlushAnchor();
    expect(anchor.ensureFlushAnchor()).toBe(0);
  });

  it("restore(0) without userScrolledUp scrolls to bottom", () => {
    anchor.restore(0);
    expect(term._log).toEqual([{ type: "scrollToBottom" }]);
  });

  it("restore(0) with userScrolledUp uses scrollToLine to keep position", () => {
    anchor.setUserScrolledUp(true);
    anchor.restore(0);
    expect(term._log).toEqual([{ type: "scrollToLine", line: buf.baseY }]);
  });

  it("restore(distance) computes baseY - distance and clamps at 0", () => {
    buf.baseY = 50;
    anchor.restore(10);
    expect(term._log).toEqual([{ type: "scrollToLine", line: 40 }]);
    anchor.restore(1000); // beyond available scrollback
    expect(term._log[1]).toEqual({ type: "scrollToLine", line: 0 });
  });

  it("unlock restores the locked distance", () => {
    buf.viewportY = 90;
    anchor.lock();
    // Buffer grows during the lock window
    buf.baseY = 150;
    buf.viewportY = 150;
    anchor.unlock();
    // Distance was 10; restore at baseY=150 → line 140
    expect(term._log).toEqual([{ type: "scrollToLine", line: 140 }]);
    expect(anchor.isLocked).toBe(false);
  });

  it("unlock fires invariant warning when buffer length changed and trim wasn't noted", () => {
    anchor.lock();
    buf.length = 4000; // shrunk during lock window outside the known #305 path
    anchor.unlock();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("unlock suppresses invariant warning when noteTrimmedDuringHide() was called", () => {
    anchor.lock();
    anchor.noteTrimmedDuringHide();
    buf.length = 1000;
    anchor.unlock();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("trim flag only suppresses one transition", () => {
    anchor.lock();
    anchor.noteTrimmedDuringHide();
    buf.length = 1000;
    anchor.unlock();
    expect(logger.warn).not.toHaveBeenCalled();

    // Next hide/show — buffer changes again but flag must have cleared
    anchor.lock();
    buf.length = 500;
    anchor.unlock();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("abandon clears state without restoring scroll", () => {
    buf.viewportY = 90;
    anchor.lock();
    buf.baseY = 200;
    anchor.abandon();
    expect(anchor.isLocked).toBe(false);
    expect(term._log).toEqual([]);
  });

  it("unlock is a no-op when not locked", () => {
    anchor.unlock();
    expect(term._log).toEqual([]);
  });

  it("setFitting toggles isFitting", () => {
    anchor.setFitting(true);
    expect(anchor.isFitting).toBe(true);
    anchor.setFitting(false);
    expect(anchor.isFitting).toBe(false);
  });
});
