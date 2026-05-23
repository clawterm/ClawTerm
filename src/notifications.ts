import { logger } from "./logger";
import { showToast } from "./toast";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

export interface NotificationsConfig {
  enabled: boolean;
  /** Opt-in: fire a banner when a long-running shell command finishes
   *  in a backgrounded tab. Detected via the PID heuristic
   *  (foreground transitions back to the shell). Default off — some
   *  users find these distracting. (#552 phase 1) */
  commandCompletion: boolean;
  /** Minimum command duration before completion notifications fire,
   *  in milliseconds. Suppresses every-prompt noise; only fires when a
   *  command was actually long-running. (#552) */
  commandCompletionThresholdMs: number;
}

export const DEFAULT_NOTIFICATIONS_CONFIG: NotificationsConfig = {
  enabled: true,
  commandCompletion: false,
  commandCompletionThresholdMs: 30_000,
};

/** Minimum gap between consecutive system banners for the same tab. A
 *  misbehaving agent (or a bad Claude Code hook) can emit OSC 9;2 in a
 *  loop; without this, the user gets a banner storm. The sidebar dot
 *  still updates idempotently — only the *banner* is throttled. (#551) */
const PER_TAB_COOLDOWN_MS = 4000;

export class NotificationManager {
  private config: NotificationsConfig;
  private permissionGranted = false;
  /** True after the user has been told once that the OS is blocking notifications.
   *  Stops the toast from re-appearing on every OSC after a single denial. (#550) */
  private surfacedDenial = false;
  /** When each tab last fired a system banner — used for per-tab cooldown. (#551) */
  private lastSentAt: Map<string, number> = new Map();
  private notifCounter = 0;
  /** Set this callback to handle notification clicks (focus a tab). */
  onFocusTab: ((tabId: string) => void) | null = null;

  constructor(config?: NotificationsConfig) {
    this.config = config ?? DEFAULT_NOTIFICATIONS_CONFIG;
    this.initPermission();
  }

  updateConfig(config: NotificationsConfig) {
    this.config = config;
  }

  private async initPermission() {
    try {
      this.permissionGranted = await isPermissionGranted();
      if (!this.permissionGranted) {
        const result = await requestPermission();
        this.permissionGranted = result === "granted";
      }
    } catch (e) {
      logger.debug("Failed to init notification permission:", e);
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        this.permissionGranted = true;
      }
    }
  }

  /** Re-check OS notification permission. Call this when the window regains
   *  focus — the user may have granted permission externally in System
   *  Settings between sessions of using the app. Short-circuits when
   *  permission is already granted to avoid IPC on every alt-tab. (#550) */
  async recheckPermission() {
    if (this.permissionGranted) return;
    try {
      const granted = await isPermissionGranted();
      if (granted) {
        logger.debug("Notification permission was granted externally");
        this.surfacedDenial = false;
      }
      this.permissionGranted = granted;
    } catch (e) {
      logger.debug("recheckPermission failed:", e);
    }
  }

  /** Returns true when notifications are enabled in config AND the OS
   *  has granted permission — used by status surfaces (settings UI #553)
   *  to show "Notifications disabled by system". */
  get isOperational(): boolean {
    return this.config.enabled && this.permissionGranted;
  }

  /** The single notification surface — fires on OSC 9;2 from an agent
   *  (Claude Code etc.). `text` is the agent's message; the user sees
   *  *why* attention is requested, not just *that* attention is requested.
   *  Caller is expected to suppress for active/muted tabs (#547). */
  notifyAgentAttention(text: string, tabTitle: string, tabId: string) {
    logger.debug(`[notifyAgentAttention] tab=${tabId} title=${tabTitle}`);
    if (!this.config.enabled) return;
    if (!this.permissionGranted) {
      this.surfaceDenialOnce();
      return;
    }

    // Same-tab Web Notifications with `tag: tabId` already replace each
    // other at the OS level, so without throttling, a looping agent burns
    // through notification-center retention with redundant replacements
    // — and on platforms without tag-coalescing, stacks visible banners
    // until the user is overwhelmed. (#551)
    const now = Date.now();
    const last = this.lastSentAt.get(tabId) ?? 0;
    if (now - last < PER_TAB_COOLDOWN_MS) {
      logger.debug(`[notifyAgentAttention] cooldown hit for tab=${tabId} (${now - last}ms)`);
      return;
    }
    this.lastSentAt.set(tabId, now);

    const body = text ? `${tabTitle}: ${text}` : `${tabTitle} needs attention`;
    this.sendWithClickSupport("ClawTerm", body, tabId);
  }

  /** Drop a tab's cooldown record when the tab closes — keeps the map
   *  from growing unbounded across long sessions. (#551) */
  clearTab(tabId: string) {
    this.lastSentAt.delete(tabId);
  }

  /** Opt-in: notify when a long-running shell command finishes in a
   *  backgrounded tab. Gated behind `notifications.commandCompletion`
   *  and a duration threshold so every-prompt noise doesn't leak. (#552) */
  notifyCommandComplete(processName: string, durationMs: number, tabTitle: string, tabId: string) {
    if (!this.config.enabled || !this.config.commandCompletion) return;
    if (durationMs < this.config.commandCompletionThresholdMs) return;
    if (!this.permissionGranted) {
      this.surfaceDenialOnce();
      return;
    }
    // Re-use the per-tab banner cooldown so a flurry of short subprocesses
    // in a script doesn't fire multiple banners. (#551)
    const now = Date.now();
    const last = this.lastSentAt.get(tabId) ?? 0;
    if (now - last < PER_TAB_COOLDOWN_MS) return;
    this.lastSentAt.set(tabId, now);

    const body = `${tabTitle}: ${processName} finished (${formatDuration(durationMs)})`;
    this.sendWithClickSupport("ClawTerm", body, tabId);
  }

  /** Tell the user once per session that the OS is blocking notifications.
   *  Without this, denied permission is a silent failure — the user sees
   *  the sidebar dot but never a banner, and reasonably concludes the app
   *  is broken. (#550) */
  private surfaceDenialOnce() {
    if (this.surfacedDenial) return;
    this.surfacedDenial = true;
    showToast(
      "System notifications are blocked. Enable in System Settings → Notifications → Clawterm.",
      "warn",
      8000,
    );
  }

  /** Send a notification with click-to-focus support.
   *  Prefers the Web Notification API (reliable onclick in webviews).
   *  Falls back to the Tauri plugin if the Web API is unavailable. */
  private sendWithClickSupport(title: string, body: string, tabId: string) {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        const webNotif = new Notification(title, { body, tag: tabId, silent: true });
        webNotif.onclick = () => {
          if (this.onFocusTab) {
            this.onFocusTab(tabId);
          }
          webNotif.close();
        };
        return;
      } catch (e) {
        logger.debug("Web Notification failed, trying Tauri native:", e);
      }
    }

    try {
      this.notifCounter++;
      sendNotification({
        id: this.notifCounter,
        title,
        body,
        group: tabId,
        extra: { tabId },
      });
    } catch (e) {
      logger.debug("Native notification also failed:", e);
    }
  }

  dispose() {
    this.onFocusTab = null;
  }
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m < 60) return `${m}m ${sec}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
