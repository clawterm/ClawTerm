import { type OutputEvent, type OutputMatcher, DEFAULT_MATCHERS } from "./matchers";

/** Fixed-capacity ring buffer with O(1) push past capacity. (#463)
 *  Iterates in chronological order (oldest first). */
class RingBuffer<T> implements Iterable<T> {
  private readonly slots: (T | undefined)[];
  private writeIdx = 0;
  length = 0;

  constructor(private readonly capacity: number) {
    this.slots = new Array(capacity);
  }

  push(item: T): void {
    this.slots[this.writeIdx] = item;
    this.writeIdx = (this.writeIdx + 1) % this.capacity;
    if (this.length < this.capacity) this.length++;
  }

  clear(): void {
    this.slots.fill(undefined);
    this.writeIdx = 0;
    this.length = 0;
  }

  *[Symbol.iterator](): IterableIterator<T> {
    const start = this.length < this.capacity ? 0 : this.writeIdx;
    for (let i = 0; i < this.length; i++) {
      yield this.slots[(start + i) % this.capacity] as T;
    }
  }
}

// prettier-ignore
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[\x20-\x2f][\x40-\x7e]|\x08/g; // eslint-disable-line no-control-regex

/** Reuse a single TextDecoder to avoid per-chunk allocation */
const decoder = new TextDecoder();

/** Debounce interval for regex matching when the pane is visible (ms) */
const MATCH_DEBOUNCE_VISIBLE_MS = 100;
/** Debounce interval for regex matching when the pane is hidden (ms).
 *  Tab/sidebar indicators driven by matchers still fire — just at 1Hz
 *  instead of 10Hz, which matters when many parked agents stream output. (#469) */
const MATCH_DEBOUNCE_HIDDEN_MS = 1000;

/** Max number of events to retain in history */
const MAX_EVENT_HISTORY = 200;

/** Cap pendingText fed into the ANSI regex per debounce tick (#466).
 *  Comfortably exceeds the 2KB matchText window plus the 256-byte overlap,
 *  so every matcher still sees a complete match window — but bursts of
 *  100KB+ (agent tool dumps, long file contents) no longer drag the giant
 *  ANSI alternation across every byte. */
const ANSI_INPUT_CAP = 8192;

export class OutputAnalyzer {
  private matchers: OutputMatcher[];
  private lastFired: Map<string, number> = new Map();
  private overlapWindow = "";
  private listener: ((event: OutputEvent) => void) | null = null;

  /** Pending text accumulated between debounced match runs */
  private pendingText = "";
  private matchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Current debounce interval — adjusted by setVisibility() (#469) */
  private debounceMs: number = MATCH_DEBOUNCE_VISIBLE_MS;

  /** Stored event history with positions for timeline rendering */
  readonly eventHistory = new RingBuffer<OutputEvent>(MAX_EVENT_HISTORY);

  /** Current terminal line (set externally by Pane) */
  currentLine = 0;
  /** Total scrollback lines (set externally by Pane) */
  totalLines = 0;

  constructor(customMatchers?: OutputMatcher[]) {
    this.matchers = customMatchers ?? DEFAULT_MATCHERS;
  }

  onEvent(fn: (event: OutputEvent) => void) {
    this.listener = fn;
  }

  feed(data: Uint8Array) {
    const text = decoder.decode(data, { stream: true });
    this.pendingText += text;
    if (!this.matchTimer) {
      this.matchTimer = setTimeout(() => this.runMatchers(), this.debounceMs);
    }
  }

  /** Tell the analyzer whether its owning pane is visible. Hidden panes use
   *  a longer debounce so background agents don't fire matchers 10×/sec
   *  apiece. On visible→hidden, an in-flight short timer is left to drain
   *  (its work is already cheap with #466's input cap). On hidden→visible,
   *  any pending text is flushed immediately so the user sees the latest
   *  state on tab focus. (#469) */
  setVisibility(visible: boolean): void {
    const next = visible ? MATCH_DEBOUNCE_VISIBLE_MS : MATCH_DEBOUNCE_HIDDEN_MS;
    if (next === this.debounceMs) return;
    this.debounceMs = next;
    if (visible && this.matchTimer && this.pendingText) {
      clearTimeout(this.matchTimer);
      this.matchTimer = null;
      this.runMatchers();
    }
  }

  private runMatchers() {
    this.matchTimer = null;
    const truncated =
      this.pendingText.length > ANSI_INPUT_CAP ? this.pendingText.slice(-ANSI_INPUT_CAP) : this.pendingText;
    const clean = truncated.replace(ANSI_RE, "");
    this.pendingText = "";

    const rawMatchText = this.overlapWindow + clean;
    const matchText = rawMatchText.length > 2048 ? rawMatchText.slice(-2048) : rawMatchText;

    const now = Date.now();
    for (const matcher of this.matchers) {
      const lastTime = this.lastFired.get(matcher.id) ?? 0;
      if (now - lastTime < matcher.cooldownMs) continue;

      const match = matchText.match(matcher.pattern);
      if (match) {
        this.lastFired.set(matcher.id, now);

        const event: OutputEvent = {
          type: matcher.type,
          detail: match[0],
          timestamp: now,
          line: this.currentLine,
          ...(matcher.extract?.(match) ?? {}),
        };

        this.eventHistory.push(event);

        this.listener?.(event);
      }
    }

    this.overlapWindow = clean.length >= 256 ? clean.slice(-256) : (this.overlapWindow + clean).slice(-256);
  }

  /** Force-run any pending matchers immediately (useful for tests). */
  flush() {
    if (this.matchTimer) {
      clearTimeout(this.matchTimer);
      this.matchTimer = null;
    }
    if (this.pendingText) {
      this.runMatchers();
    }
  }

  dispose() {
    if (this.matchTimer) {
      clearTimeout(this.matchTimer);
      this.matchTimer = null;
    }
    this.listener = null;
    this.pendingText = "";
    this.overlapWindow = "";
    this.lastFired.clear();
    this.eventHistory.clear();
  }
}
