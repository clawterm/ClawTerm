import { openUrl } from "@tauri-apps/plugin-opener";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { trapFocus } from "./utils";
import { showToast } from "./toast";
import { logger } from "./logger";
import type { NotificationsConfig, NotificationManager } from "./notifications";

/** Small panel exposing the notification controls that used to be
 *  config-file-only: master enable/disable, OS permission status, and a
 *  pointer to the per-tab mute (still right-click). Invoked from the
 *  command palette. (#553)
 *
 *  Deliberately a focused mini-panel rather than a full settings window —
 *  see the issue for the path (a) vs (b) choice. Promote into a generic
 *  settings panel later if other features need one. */
export function showNotificationSettings({
  notifications,
  config,
  onChange,
}: {
  notifications: NotificationManager;
  config: NotificationsConfig;
  onChange: (next: NotificationsConfig) => void;
}): void {
  document.querySelector(".notification-settings-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "palette-overlay notification-settings-overlay";

  const modal = document.createElement("div");
  modal.className = "palette-modal notification-settings-modal";

  const title = document.createElement("div");
  title.className = "notification-settings-title";
  title.textContent = "Notification Settings";

  const body = document.createElement("div");
  body.className = "notification-settings-body";

  // Master enable/disable
  const enableRow = document.createElement("label");
  enableRow.className = "notification-settings-row";
  const enableCheckbox = document.createElement("input");
  enableCheckbox.type = "checkbox";
  enableCheckbox.checked = config.enabled;
  const enableLabel = document.createElement("span");
  enableLabel.textContent = "Enable system notifications";
  enableRow.appendChild(enableCheckbox);
  enableRow.appendChild(enableLabel);

  enableCheckbox.addEventListener("change", () => {
    const next: NotificationsConfig = { ...config, enabled: enableCheckbox.checked };
    onChange(next);
    notifications.updateConfig(next);
  });

  // Permission status
  const permRow = document.createElement("div");
  permRow.className = "notification-settings-status";
  const permLabel = document.createElement("span");
  permLabel.className = "notification-settings-status-label";
  permLabel.textContent = "OS permission:";
  const permValue = document.createElement("span");
  permValue.className = "notification-settings-status-value";
  permValue.textContent = "checking…";
  const permAction = document.createElement("button");
  permAction.className = "btn btn--secondary notification-settings-perm-btn";
  permAction.style.display = "none";

  permRow.appendChild(permLabel);
  permRow.appendChild(permValue);
  permRow.appendChild(permAction);

  async function refreshPermission() {
    try {
      const granted = await isPermissionGranted();
      if (granted) {
        permValue.textContent = "granted";
        permValue.classList.remove("denied");
        permValue.classList.add("granted");
        permAction.style.display = "none";
      } else {
        permValue.textContent = "denied";
        permValue.classList.remove("granted");
        permValue.classList.add("denied");
        permAction.textContent = "Open System Settings";
        permAction.style.display = "inline-flex";
        permAction.onclick = () => {
          openUrl("x-apple.systempreferences:com.apple.preference.notifications").catch(() => {
            showToast("Open System Settings → Notifications → ClawTerm to allow", "info", 6000);
          });
        };
      }
    } catch (e) {
      logger.debug("permission check failed:", e);
      permValue.textContent = "unknown";
    }
  }
  refreshPermission();

  // Per-tab mute hint
  const muteHint = document.createElement("div");
  muteHint.className = "notification-settings-hint";
  muteHint.textContent = "Per-tab mute: right-click any tab → Mute Notifications.";

  body.appendChild(enableRow);
  body.appendChild(permRow);
  body.appendChild(muteHint);

  modal.appendChild(title);
  modal.appendChild(body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const removeTrap = trapFocus(modal);
  const dismiss = () => {
    removeTrap();
    overlay.remove();
  };

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) dismiss();
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") dismiss();
  });

  // Re-check permission when the user comes back from System Settings.
  const onFocus = () => {
    refreshPermission();
    notifications.recheckPermission().catch(() => {});
  };
  window.addEventListener("focus", onFocus);
  overlay.addEventListener("remove" as keyof HTMLElementEventMap, () => {
    window.removeEventListener("focus", onFocus);
  });

  enableCheckbox.focus();

  // Best-effort: if the user clicked "enable" but permission isn't granted,
  // kick off the OS request — they'll see the system prompt.
  enableCheckbox.addEventListener("change", async () => {
    if (enableCheckbox.checked) {
      try {
        const granted = await isPermissionGranted();
        if (!granted) {
          await requestPermission();
          refreshPermission();
        }
      } catch {
        /* ignored */
      }
    }
  });
}
