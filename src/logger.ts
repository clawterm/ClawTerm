type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let minLevel: LogLevel = "debug";

/** In-memory circular buffer of recent log entries for export/debugging.
 *  Uses a head pointer instead of Array.splice() for O(1) append. */
const LOG_BUFFER_MAX = 2000;
const logBuffer: string[] = new Array(LOG_BUFFER_MAX);
let logHead = 0;
let logCount = 0;

function timestamp(): string {
  return new Date().toISOString();
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

function appendToBuffer(entry: string): void {
  logBuffer[logHead] = entry;
  logHead = (logHead + 1) % LOG_BUFFER_MAX;
  if (logCount < LOG_BUFFER_MAX) logCount++;
}

export const logger = {
  setLevel(level: LogLevel) {
    minLevel = level;
  },

  debug(msg: string, ...args: unknown[]) {
    const entry = `[${timestamp()}] DEBUG ${msg}`;
    appendToBuffer(entry);
    if (shouldLog("debug")) console.debug(entry, ...args);
  },

  info(msg: string, ...args: unknown[]) {
    const entry = `[${timestamp()}] INFO ${msg}`;
    appendToBuffer(entry);
    if (shouldLog("info")) console.info(entry, ...args);
  },

  warn(msg: string, ...args: unknown[]) {
    const entry = `[${timestamp()}] WARN ${msg}`;
    appendToBuffer(entry);
    if (shouldLog("warn")) console.warn(entry, ...args);
  },

  error(msg: string, ...args: unknown[]) {
    const entry = `[${timestamp()}] ERROR ${msg}`;
    appendToBuffer(entry);
    if (shouldLog("error")) console.error(entry, ...args);
  },

  /** Get all buffered log entries as a single string for export.
   *  Returns entries in chronological order (oldest first). */
  getBufferedLogs(): string {
    if (logCount < LOG_BUFFER_MAX) {
      return logBuffer.slice(0, logCount).join("\n");
    }
    // Circular: read from head (oldest) to head-1 (newest)
    return [...logBuffer.slice(logHead), ...logBuffer.slice(0, logHead)].join("\n");
  },

  /** Get the number of buffered entries. */
  getBufferSize(): number {
    return logCount;
  },

  /** Ring-buffer ceiling (#566). Surfaced by memory-diagnostics so long-session
   *  reports can show "X / Y" rather than just "X". */
  getBufferMax(): number {
    return LOG_BUFFER_MAX;
  },
};
