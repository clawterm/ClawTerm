/**
 * Minimal mock for tauri-pty's IPty surface — emits pre-fab Uint8Array chunks
 * to consumers that subscribe via onData/onExit. Used by integration tests
 * that drive the Pane → OutputAnalyzer → write-queue chain without booting
 * a real PTY.
 *
 * Designed to be reusable across future Tab and TerminalManager tests,
 * so the API matches the slice of IPty those classes use.
 */

type DataHandler = (data: string | Uint8Array) => void;
type ExitHandler = (e: { exitCode: number }) => void;

export interface MockPty {
  pid: number;
  /** Subscribe to PTY data — receives the chunks passed to feed(). */
  onData(fn: DataHandler): { dispose(): void };
  /** Subscribe to PTY exit. */
  onExit(fn: ExitHandler): { dispose(): void };
  /** Capture writes back into the PTY for later inspection. */
  write(data: string): void;
  /** Resize ack — captured for tests that assert resize behavior. */
  resize(cols: number, rows: number): void;
  /** Force the PTY to terminate; fires onExit handlers. */
  kill(): void;

  // Test-only surface
  feed(chunk: Uint8Array | string): void;
  feedAll(chunks: Array<Uint8Array | string>): void;
  readonly writes: string[];
  readonly resizes: Array<{ cols: number; rows: number }>;
}

export function createMockPty(pid = 12345): MockPty {
  const dataHandlers = new Set<DataHandler>();
  const exitHandlers = new Set<ExitHandler>();
  const writes: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  let killed = false;

  const encoder = new TextEncoder();
  const toBytes = (chunk: Uint8Array | string): Uint8Array =>
    typeof chunk === "string" ? encoder.encode(chunk) : chunk;

  return {
    pid,
    onData(fn) {
      dataHandlers.add(fn);
      return {
        dispose() {
          dataHandlers.delete(fn);
        },
      };
    },
    onExit(fn) {
      exitHandlers.add(fn);
      return {
        dispose() {
          exitHandlers.delete(fn);
        },
      };
    },
    write(data) {
      writes.push(data);
    },
    resize(cols, rows) {
      resizes.push({ cols, rows });
    },
    kill() {
      if (killed) return;
      killed = true;
      for (const fn of exitHandlers) fn({ exitCode: 0 });
    },
    feed(chunk) {
      if (killed) return;
      const bytes = toBytes(chunk);
      for (const fn of dataHandlers) fn(bytes);
    },
    feedAll(chunks) {
      for (const c of chunks) this.feed(c);
    },
    get writes() {
      return writes;
    },
    get resizes() {
      return resizes;
    },
  };
}
