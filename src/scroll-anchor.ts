import type { Terminal } from "@xterm/xterm";
import { logger } from "./logger";

/** Encapsulates Pane's scroll-preservation invariants (#476).
 *
 *  Pre-extraction, eight loosely-coupled fields on Pane coordinated scroll
 *  behavior across hide/show cycles, write callbacks, and fitAddon reflows.
 *  Each was added in response to a real regression (#184/#305/#419/#432/#437).
 *
 *  Behavior is byte-identical to the inlined version. The change is
 *  encapsulation only — the relationship between the eight pieces of state
 *  was previously legible only to whoever last touched it. Now it is named.
 *
 *  Concepts
 *  ────────
 *  • locked: a tab-hide / tab-show critical section. While locked, onScroll
 *    is suppressed, fitCore reads the locked anchor instead of the live
 *    buffer, and unlock() does the single authoritative scroll restoration.
 *  • userScrolledUp: a *persistent* user-intent flag. True while the user is
 *    above the bottom; survives writes that would otherwise auto-follow.
 *  • scrolledUp: passive observer of viewport position; identical to
 *    userScrolledUp under steady state but they decouple briefly during
 *    programmatic scrolls.
 *  • fitting: suppresses onScroll side-effects during programmatic mutations.
 *  • flush anchor: lazily snapshotted per flush-sequence and held across
 *    chunks so a multi-frame flush restores to the same target.
 *  • trimmedDuringHide: gate for the #305 hidden-tab scrollback trim — without
 *    this, the lock-window invariant tripwire fires on every tab switch.
 */
export class ScrollAnchor {
  private fitting = false;
  private locked = false;
  private lockedDistance: number | null = null;
  private lockedBufferLen: number | null = null;
  private trimmedDuringHide_ = false;
  private userScrolled = false;
  private scrolledUp = false;
  private flushDistance: number | null = null;

  constructor(
    private readonly terminal: Terminal,
    private readonly paneId: string,
  ) {}

  // ── State queries ──────────────────────────────────────────────────────
  get isLocked(): boolean {
    return this.locked;
  }
  get isFitting(): boolean {
    return this.fitting;
  }
  get isUserScrolledUp(): boolean {
    return this.userScrolled;
  }
  get isScrolledUp(): boolean {
    return this.scrolledUp;
  }

  // ── State setters (named so call sites read like ops, not assignments) ──
  setFitting(value: boolean): void {
    this.fitting = value;
  }
  setUserScrolledUp(value: boolean): void {
    this.userScrolled = value;
  }
  setScrolledUp(value: boolean): void {
    this.scrolledUp = value;
  }

  /** Mark the next observed buffer-length change as the known #305 trim, so
   *  the lock-window tripwire suppresses its warning for that one transition. */
  noteTrimmedDuringHide(): void {
    this.trimmedDuringHide_ = true;
  }

  /** Compute the current distance-from-bottom in lines. When locked, returns
   *  the lock-time anchor so concurrent buffer mutations can't move the target. */
  currentDistance(): number {
    if (this.locked && this.lockedDistance !== null) return this.lockedDistance;
    const buf = this.terminal.buffer.active;
    return Math.max(0, buf.baseY - buf.viewportY);
  }

  /** Lazy snapshot held across chunks of a multi-frame flush. */
  ensureFlushAnchor(): number {
    if (this.flushDistance === null) this.flushDistance = this.currentDistance();
    return this.flushDistance;
  }

  /** End of flush sequence — drop the hold so the next sequence starts fresh. */
  clearFlushAnchor(): void {
    this.flushDistance = null;
  }

  /** Restore scroll to a saved distance-from-bottom.
   *  Callers must manage the fitting flag themselves — every call site
   *  already wraps a wider critical section that needs the flag held
   *  beyond the duration of this single scroll mutation. */
  restore(distance: number): void {
    if (distance === 0 && !this.userScrolled) {
      this.terminal.scrollToBottom();
    } else {
      const max = this.terminal.buffer.active.baseY;
      const target = Math.max(0, max - distance);
      this.terminal.scrollToLine(target);
    }
  }

  /** Acquire a scroll lock. Captures current distance-from-bottom and buffer
   *  length; prevents updateScrollState from churning user intent while the
   *  tab is in transition. (#184) */
  lock(): void {
    this.locked = true;
    const buf = this.terminal.buffer.active;
    this.lockedDistance = Math.max(0, buf.baseY - buf.viewportY);
    this.lockedBufferLen = buf.length;
  }

  /** Release the lock and perform the single authoritative scroll restoration.
   *  Trips a warning if the buffer length changed during the lock window
   *  outside the known #305 hidden-tab trim path. */
  unlock(): void {
    if (!this.locked) return;
    this.locked = false;
    const buf = this.terminal.buffer.active;
    if (!this.trimmedDuringHide_ && this.lockedBufferLen !== null && buf.length !== this.lockedBufferLen) {
      logger.warn(
        `[pane ${this.paneId}] scroll-lock invariant: buffer length changed during lock ` +
          `(was ${this.lockedBufferLen}, now ${buf.length}). ` +
          `Distance-from-bottom restoration will compensate, but this indicates ` +
          `a code path mutating the buffer during hide/show — investigate.`,
      );
    }
    this.trimmedDuringHide_ = false;
    if (this.lockedDistance !== null) {
      this.fitting = true;
      try {
        this.restore(this.lockedDistance);
      } finally {
        this.fitting = false;
      }
    }
    this.lockedDistance = null;
    this.lockedBufferLen = null;
  }

  /** Release the lock without restoring (user wheel-up superseded). (#437) */
  abandon(): void {
    this.locked = false;
    this.lockedDistance = null;
    this.lockedBufferLen = null;
    this.trimmedDuringHide_ = false;
  }
}
