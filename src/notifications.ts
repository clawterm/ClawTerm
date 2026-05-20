import { logger } from "./logger";
import { showToast } from "./toast";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

export interface NotificationsConfig {
  enabled: boolean;
}

export const DEFAULT_NOTIFICATIONS_CONFIG: NotificationsConfig = {
  enabled: true,
};

export class NotificationManager {
  private config: NotificationsConfig;
  private permissionGranted = false;
  /** True after the user has been told once that the OS is blocking notifications.
   *  Stops the toast from re-appearing on every OSC after a single denial. (#550) */
  private surfacedDenial = false;
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
   *  Settings between sessions of using the app. (#550) */
  async recheckPermission() {
    try {
      const granted = await isPermissionGranted();
      if (granted && !this.permissionGranted) {
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

    const body = text ? `${tabTitle}: ${text}` : `${tabTitle} needs attention`;
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
