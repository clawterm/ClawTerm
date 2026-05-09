import { check } from "@tauri-apps/plugin-updater";
import { openUrl } from "@tauri-apps/plugin-opener";
import { logger } from "./logger";
import { trapFocus } from "./utils";
import { showToast } from "./toast";
import type { Config } from "./config";

const JUST_UPDATED_KEY = "clawterm_last_update_ts";
const RELEASES_URL = "https://github.com/clawterm/clawterm/releases/latest";
let updateFound = false;
let manualCheckInProgress = false;
let consecutiveCheckFailures = 0;
const CHECK_FAILURE_THRESHOLD = 3;
let autoInstallEnabled = false;
/** The pending update object from the last check — reused by installLatest
 *  to avoid a redundant network round-trip before downloading. */
let pendingUpdate: Awaited<ReturnType<typeof check>> = null;

export function startUpdateChecker(config: Config): void {
  autoInstallEnabled = config.updates.autoInstall ?? false;
  if (!config.updates.autoCheck) {
    logger.debug("Auto-update checking disabled via config");
    return;
  }

  // Skip the initial check if the app was just updated (within last 30s)
  const lastUpdate = parseInt(localStorage.getItem(JUST_UPDATED_KEY) || "0", 10);
  const justUpdated = Date.now() - lastUpdate < 30_000;

  if (justUpdated) {
    localStorage.removeItem(JUST_UPDATED_KEY);
    logger.debug("Skipping initial update check — app was just updated");
    import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion().then((v) => showToast(`Updated to v${v}`, "info", 8000)))
      .catch(() => {});
  } else {
    // First check after 3 seconds
    setTimeout(checkForUpdates, 3000);
  }

  // Then check periodically
  const intervalMs = config.updates.checkIntervalMs;
  setInterval(() => {
    if (!updateFound) checkForUpdates();
  }, intervalMs);
}

export async function manualCheckForUpdates(): Promise<void> {
  if (manualCheckInProgress) return;
  manualCheckInProgress = true;
  const btn = document.getElementById("update-btn");
  try {
    const update = await check();
    if (!update) {
      if (btn) {
        btn.classList.add("up-to-date");
        btn.title = "Up to date";
        setTimeout(() => {
          btn.classList.remove("up-to-date");
          btn.title = "Check for Updates";
        }, 2000);
      }
    } else {
      updateFound = true;
      pendingUpdate = update;
      logger.debug(`Update available: ${update.version}`);
      showUpdateNotice(update.version, update.body ?? "", () => installLatest());
    }
  } catch (e) {
    logger.warn("Manual update check failed:", e);
    showToast("Update check failed — check your connection and try again", "warn");
  } finally {
    manualCheckInProgress = false;
  }
}

async function checkForUpdates(): Promise<void> {
  try {
    const update = await check();
    consecutiveCheckFailures = 0;
    if (!update) return;

    updateFound = true;
    pendingUpdate = update;
    logger.debug(`Update available: ${update.version}`);
    if (autoInstallEnabled) {
      showToast(`Updating to v${update.version}\u2026`, "info");
      installLatest();
    } else {
      showUpdateNotice(update.version, update.body ?? "", () => installLatest());
    }
  } catch (e) {
    consecutiveCheckFailures++;
    if (consecutiveCheckFailures >= CHECK_FAILURE_THRESHOLD) {
      logger.warn(`Update check failed ${consecutiveCheckFailures} times in a row:`, e);
      if (consecutiveCheckFailures === CHECK_FAILURE_THRESHOLD) {
        showToast("Update checks are failing — check your network connection", "warn");
      }
    } else {
      logger.debug("Update check skipped:", e);
    }
  }
}

/**
 * Download and install the pending update. Uses the cached update object
 * from the last check() call to avoid a redundant network round-trip.
 */
async function installLatest(): Promise<void> {
  try {
    const latest = pendingUpdate;
    if (!latest) {
      logger.debug("No pending update to install");
      return;
    }
    logger.debug(`Installing version: ${latest.version}`);
    let totalBytes = 0;
    let downloadedBytes = 0;
    await latest.downloadAndInstall((event) => {
      if (event.event === "Started") {
        totalBytes = event.data.contentLength ?? 0;
        downloadedBytes = 0;
        updateNoticeProgress("Downloading\u2026");
      } else if (event.event === "Progress") {
        downloadedBytes += event.data.chunkLength;
        const pct = totalBytes ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
        updateNoticeProgress(totalBytes ? `Downloading\u2026 ${pct}%` : "Downloading\u2026");
      } else if (event.event === "Finished") {
        updateNoticeProgress("Installing\u2026");
      }
    });
    localStorage.setItem(JUST_UPDATED_KEY, String(Date.now()));
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    logger.warn("Update install failed:", e);
    localStorage.removeItem(JUST_UPDATED_KEY);
    // Allow re-detection so the update notice can reappear
    updateFound = false;
    pendingUpdate = null;
    // Reset the notice UI so the button becomes usable again
    resetUpdateNotice();
    showToast("Update failed — opening download page…", "error");
    try {
      await openUrl(RELEASES_URL);
    } catch {
      showToast(`Download manually: ${RELEASES_URL}`, "error");
    }
  }
}

/**
 * Render changelog markdown to HTML. Handles the subset used by
 * Keep a Changelog: h3 headings, bold, inline code, bullet lists, and PR links.
 * Content is from our own signed GitHub releases so XSS risk is minimal,
 * but we still escape HTML entities before applying formatting.
 */
function renderChangelog(md: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const lines = md.trim().split("\n");
  const out: string[] = [];
  let inList = false;

  for (const raw of lines) {
    const line = esc(raw);

    // Heading: ### Added, ### Fixed, ### Changed
    const h3 = line.match(/^#{1,3}\s+(.+)/);
    if (h3) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      const tag = line.startsWith("### ") ? "h3" : line.startsWith("## ") ? "h2" : "h3";
      out.push(`<${tag}>${inlineFormat(h3[1])}</${tag}>`);
      continue;
    }

    // Bullet item: - text
    const bullet = line.match(/^[-*]\s+(.+)/);
    if (bullet) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inlineFormat(bullet[1])}</li>`);
      continue;
    }

    // Blank line
    if (!line.trim()) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      continue;
    }

    // Plain paragraph
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
    out.push(`<p>${inlineFormat(line)}</p>`);
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

/** Apply inline formatting: bold, inline code, PR links */
function inlineFormat(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(
      /\(#(\d+)\)/g,
      '(<a href="https://github.com/clawterm/clawterm/issues/$1" target="_blank">#$1</a>)',
    );
}

function showUpdateConfirm(version: string, releaseNotes: string, onConfirm: () => void): void {
  document.querySelector(".update-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "update-overlay";

  const dialog = document.createElement("div");
  dialog.className = "update-dialog";

  const titleEl = document.createElement("div");
  titleEl.className = "update-dialog-title";
  titleEl.textContent = `Update to ${version}`;

  const bodyEl = document.createElement("div");
  bodyEl.className = "update-dialog-body";
  bodyEl.textContent = "This will close all terminals and restart the app.";

  dialog.appendChild(titleEl);

  // Release notes section — render as formatted HTML
  if (releaseNotes.trim()) {
    const notesEl = document.createElement("div");
    notesEl.className = "update-release-notes";
    notesEl.innerHTML = renderChangelog(releaseNotes);
    dialog.appendChild(notesEl);
  }

  dialog.appendChild(bodyEl);

  const actionsEl = document.createElement("div");
  actionsEl.className = "update-dialog-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn btn--secondary update-dialog-btn";
  cancelBtn.textContent = "Cancel";

  const confirmBtn = document.createElement("button");
  confirmBtn.className = "btn btn--primary update-dialog-btn";
  confirmBtn.textContent = "Update & Restart";

  actionsEl.appendChild(cancelBtn);
  actionsEl.appendChild(confirmBtn);
  dialog.appendChild(actionsEl);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const removeTrap = trapFocus(dialog);
  const dismiss = () => {
    removeTrap();
    overlay.remove();
  };

  cancelBtn.addEventListener("click", dismiss);
  confirmBtn.addEventListener("click", () => {
    dismiss();
    onConfirm();
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) dismiss();
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") dismiss();
  });

  confirmBtn.focus();
}

function updateNoticeProgress(text: string): void {
  const btn = document.querySelector(".update-notice-action") as HTMLButtonElement | null;
  if (btn) btn.textContent = text;
}

function resetUpdateNotice(): void {
  const notice = document.querySelector(".update-notice");
  if (!notice) return;
  notice.classList.remove("installing");
  const btn = notice.querySelector(".update-notice-action") as HTMLButtonElement | null;
  if (btn) {
    btn.textContent = "Download";
    btn.disabled = false;
    btn.onclick = () => openUrl(RELEASES_URL);
  }
}

function showUpdateNotice(version: string, releaseNotes: string, onInstall: () => void): void {
  const footer = document.getElementById("sidebar-footer");
  if (!footer) return;

  // If a notice already exists, update its version text and bail
  const existing = footer.querySelector(".update-notice");
  if (existing) {
    const ver = existing.querySelector(".update-notice-version");
    if (ver) ver.textContent = version;
    return;
  }

  const notice = document.createElement("div");
  notice.className = "update-notice";

  const dot = document.createElement("div");
  dot.className = "update-notice-dot";

  const text = document.createElement("div");
  text.className = "update-notice-text";
  const label = document.createElement("span");
  label.className = "update-notice-label";
  label.textContent = "Update available";
  const ver = document.createElement("span");
  ver.className = "update-notice-version";
  ver.textContent = version;
  text.appendChild(label);
  text.appendChild(ver);

  const btn = document.createElement("button");
  btn.className = "btn btn--primary update-notice-action";
  btn.textContent = "Update";

  notice.appendChild(dot);
  notice.appendChild(text);
  notice.appendChild(btn);

  footer.insertBefore(notice, footer.firstChild);

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    showUpdateConfirm(version, releaseNotes, () => {
      btn.textContent = "Installing\u2026";
      btn.disabled = true;
      notice.classList.add("installing");
      onInstall();
    });
  });
}
