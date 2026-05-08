/**
 * OSC sequence handlers for terminal notifications.
 *
 * Claude Code emits OSC 9;2 (desktop notification) escape sequences.
 * xterm.js routes OSC sequences by their integer prefix.
 */

import type { Terminal, IDisposable } from "@xterm/xterm";
import { logger } from "./logger";

// ── Types ──

export interface OscNotificationEvent {
  /** Notification text from the agent */
  text: string;
}

// ── Parsers ──

/** Cap untrusted PTY notification text — anything longer is almost certainly malformed
 *  output, and a runaway sequence shouldn't be free to inject unbounded strings into
 *  the DOM (toasts) or system notification surface. */
const OSC_NOTIFICATION_MAX_LEN = 512;

/**
 * Parse an OSC 9;2 desktop notification sequence.
 * Data arrives as "2;TEXT" (the "9;" prefix is consumed by xterm.js routing).
 */
export function parseOsc9_2(data: string): OscNotificationEvent | null {
  // data is "2;TEXT"
  if (!data.startsWith("2;")) return null;
  let text = data.slice(2);
  if (!text) return null;
  if (text.length > OSC_NOTIFICATION_MAX_LEN) {
    text = text.slice(0, OSC_NOTIFICATION_MAX_LEN) + "…";
  }
  return { text };
}

// ── Registration ──

export interface OscHandlerCallbacks {
  onNotification: (event: OscNotificationEvent) => void;
}

/**
 * Register OSC 9 sub-handlers on an xterm.js Terminal instance.
 * Returns disposables that the caller should track for cleanup.
 */
export function registerOscHandlers(terminal: Terminal, callbacks: OscHandlerCallbacks): IDisposable[] {
  const disposable = terminal.parser.registerOscHandler(9, (data: string) => {
    if (data.startsWith("2;")) {
      const event = parseOsc9_2(data);
      if (event) {
        logger.debug(`[osc] 9;2 notification="${event.text}"`);
        callbacks.onNotification(event);
      }
    }
    return false;
  });

  return [disposable];
}
