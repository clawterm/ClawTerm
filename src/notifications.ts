import { logger } from "./logger";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

export interface NotificationsConfig {
  enabled: boolean;
  sound: boolean;
}

export const DEFAULT_NOTIFICATIONS_CONFIG: NotificationsConfig = {
  enabled: true,
  sound: true,
};

export class NotificationManager {
  private config: NotificationsConfig;
  private audioCtx: AudioContext | null = null;
  private permissionGranted = false;
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

  /** The single notification surface — fires on OSC 9;2 from an agent
   *  (Claude Code etc.). `text` is the agent's message; the user sees
   *  *why* attention is requested, not just *that* attention is requested.
   *  Caller is expected to suppress for active/muted tabs (#547). */
  notifyAgentAttention(text: string, tabTitle: string, tabId: string) {
    logger.debug(`[notifyAgentAttention] tab=${tabId} title=${tabTitle}`);
    if (!this.config.enabled) return;

    if (this.permissionGranted) {
      const body = text ? `${tabTitle}: ${text}` : `${tabTitle} needs attention`;
      this.sendWithClickSupport("ClawTerm", body, tabId);
    }

    if (this.config.sound) {
      this.playAttentionTone();
    }
  }

  /** Send a notification with click-to-focus support.
   *  Prefers the Web Notification API (reliable onclick in webviews).
   *  Falls back to the Tauri plugin if the Web API is unavailable. */
  private sendWithClickSupport(title: string, body: string, tabId: string) {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        const webNotif = new Notification(title, { body, tag: tabId });
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

  private getAudioContext(): AudioContext {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext();
    }
    return this.audioCtx;
  }

  dispose() {
    if (this.audioCtx) {
      this.audioCtx.close();
      this.audioCtx = null;
    }
    this.onFocusTab = null;
  }

  /** Two-tone chime for agent attention. */
  private playAttentionTone() {
    try {
      const ctx = this.getAudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.frequency.value = 880;
      osc.type = "sine";
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);

      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.frequency.value = 1100;
      osc2.type = "sine";
      gain2.gain.setValueAtTime(0.15, ctx.currentTime + 0.15);
      gain2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.45);
      osc2.start(ctx.currentTime + 0.15);
      osc2.stop(ctx.currentTime + 0.45);
    } catch (e) {
      logger.debug("Audio playback failed:", e);
    }
  }
}
