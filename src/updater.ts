import { check } from "@tauri-apps/plugin-updater";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { logger } from "./logger";
import { trapFocus } from "./utils";
import { showToast } from "./toast";
import type { Config } from "./config";

type Update = NonNullable<Awaited<ReturnType<typeof check>>>;
type UpdateMode = Config["updates"]["mode"];

/** UI/lifecycle state of the in-flight update.
 *   idle        — no update detected
 *   available   — detected; bundle not yet downloaded
 *   downloading — download() in flight
 *   staged      — bundle on disk; install() not yet called
 *   installing  — install() in flight (during click-install or during quit)
 *   failed      — terminal error; user can retry via the manual-download link */
type UpdateState = "idle" | "available" | "downloading" | "staged" | "installing" | "failed";

const JUST_UPDATED_KEY = "clawterm_last_update_ts";
const RELEASES_URL = "https://github.com/clawterm/clawterm/releases/latest";
const CHECK_FAILURE_THRESHOLD = 3;
/** Hard cap on the install() call during onCloseRequested so a hung Tauri
 *  install can't keep the window alive forever. */
const QUIT_INSTALL_TIMEOUT_MS = 30_000;

let manualCheckInProgress = false;
let consecutiveCheckFailures = 0;
let updateMode: UpdateMode = "download";
let updateState: UpdateState = "idle";
let pendingUpdate: Update | null = null;

export function startUpdateChecker(config: Config): void {
  updateMode = config.updates.mode;
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

  // Then check periodically — skip while we already have something pending,
  // staged, or in flight, so a new check can't clobber an in-progress flow.
  const intervalMs = config.updates.checkIntervalMs;
  setInterval(() => {
    if (updateState === "idle" || updateState === "failed") checkForUpdates();
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
      handleDetected(update);
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
    handleDetected(update);
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

/** Update detected — dispatch by mode. */
function handleDetected(update: Update): void {
  pendingUpdate = update;
  setState("available");
  logger.debug(`Update available: ${update.version}`);

  if (updateMode === "auto") {
    showToast(`Updating to v${update.version}…`, "info");
    showUpdateNotice(update.version, update.body ?? "");
    installPending({ relaunchAfter: true });
  } else if (updateMode === "download") {
    showUpdateNotice(update.version, update.body ?? "");
    // Silent background download — the notice will switch to "Install Now"
    // when it lands; failures fall back to the manual-download link.
    downloadPending().catch(() => {});
  } else {
    // "manual" — show the notice; user must click Download.
    showUpdateNotice(update.version, update.body ?? "");
  }
}

/** Fetch the bundle without installing. Used by mode=download on detection
 *  and by mode=manual after the user clicks Download. */
async function downloadPending(): Promise<void> {
  const latest = pendingUpdate;
  if (!latest) return;
  if (updateState !== "available") return;
  setState("downloading");
  try {
    let totalBytes = 0;
    let downloadedBytes = 0;
    await latest.download((event) => {
      if (event.event === "Started") {
        totalBytes = event.data.contentLength ?? 0;
        downloadedBytes = 0;
        updateNoticeProgress("Downloading…", totalBytes ? 0 : undefined);
      } else if (event.event === "Progress") {
        downloadedBytes += event.data.chunkLength;
        if (totalBytes) {
          const pct = Math.round((downloadedBytes / totalBytes) * 100);
          updateNoticeProgress(`Downloading… ${pct}%`, pct);
        } else {
          updateNoticeProgress("Downloading…");
        }
      }
    });
    setState("staged");
    renderNoticeForState();
  } catch (e) {
    logger.warn("Update download failed:", e);
    setState("failed");
    resetUpdateNotice();
    showToast("Update download failed — opening download page…", "error");
    try {
      await openUrl(RELEASES_URL);
    } catch {
      showToast(`Download manually: ${RELEASES_URL}`, "error");
    }
  }
}

/** Install a downloaded (or downloads-then-installs) bundle. `relaunchAfter`
 *  controls whether to immediately relaunch — false during the quit hook,
 *  since the user is already on their way out. */
async function installPending({ relaunchAfter }: { relaunchAfter: boolean }): Promise<void> {
  const latest = pendingUpdate;
  if (!latest) {
    logger.debug("No pending update to install");
    return;
  }
  setState("installing");
  updateNoticeProgress("Installing…");
  try {
    if (updateMode === "auto") {
      // Auto path: combined download+install (current behavior, preserved).
      let totalBytes = 0;
      let downloadedBytes = 0;
      await latest.downloadAndInstall((event) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength ?? 0;
          downloadedBytes = 0;
          updateNoticeProgress("Downloading…", totalBytes ? 0 : undefined);
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          if (totalBytes) {
            const pct = Math.round((downloadedBytes / totalBytes) * 100);
            updateNoticeProgress(`Downloading… ${pct}%`, pct);
          } else {
            updateNoticeProgress("Downloading…");
          }
        } else if (event.event === "Finished") {
          updateNoticeProgress("Installing…", 100);
        }
      });
    } else {
      await latest.install();
    }
    localStorage.setItem(JUST_UPDATED_KEY, String(Date.now()));
    // Bump the .app bundle mtime so the macOS Dock re-reads the icon on
    // relaunch. Otherwise IconServices keeps the pre-update icon cached
    // even though the new bundle is on disk. Non-fatal if it fails —
    // worst case is the old behavior (stale Dock icon). (#533)
    await invoke("refresh_macos_bundle_icon_cache").catch((e) =>
      logger.debug("Bundle icon cache refresh failed (non-fatal):", e),
    );
    if (relaunchAfter) {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    }
  } catch (e) {
    logger.warn("Update install failed:", e);
    localStorage.removeItem(JUST_UPDATED_KEY);
    setState("failed");
    pendingUpdate = null;
    resetUpdateNotice();
    if (relaunchAfter) {
      showToast("Update failed — opening download page…", "error");
      try {
        await openUrl(RELEASES_URL);
      } catch {
        showToast(`Download manually: ${RELEASES_URL}`, "error");
      }
    }
    throw e;
  }
}

/** True if a downloaded bundle is sitting on disk waiting to be applied. */
export function hasStagedUpdate(): boolean {
  return updateState === "staged";
}

/** Apply a staged update during window close. Returns when install resolves
 *  or the timeout fires — never rejects so the quit path is always unblocked.
 *  Called from main.ts's onCloseRequested hook in the main window. */
export async function installStagedOnQuit(): Promise<void> {
  if (!hasStagedUpdate()) return;
  logger.debug("[updater] installing staged update during quit");
  try {
    await Promise.race([
      installPending({ relaunchAfter: false }),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("install timeout")), QUIT_INSTALL_TIMEOUT_MS),
      ),
    ]);
    logger.debug("[updater] staged install complete — next launch is on the new version");
  } catch (e) {
    logger.warn("[updater] staged install failed during quit (proceeding with quit anyway):", e);
  }
}

function setState(next: UpdateState): void {
  if (updateState === next) return;
  logger.debug(`[updater] state: ${updateState} -> ${next}`);
  updateState = next;
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
  titleEl.textContent = `Install ${version}`;

  const bodyEl = document.createElement("div");
  bodyEl.className = "update-dialog-body";
  bodyEl.textContent =
    "Installing now closes all terminals immediately. The update is already downloaded — it will apply automatically when you next quit ClawTerm, no action needed.";

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

  const laterBtn = document.createElement("button");
  laterBtn.className = "btn btn--secondary update-dialog-btn";
  laterBtn.textContent = "Install on Next Quit";

  const confirmBtn = document.createElement("button");
  confirmBtn.className = "btn btn--primary update-dialog-btn";
  confirmBtn.textContent = "Install & Restart";

  actionsEl.appendChild(laterBtn);
  actionsEl.appendChild(confirmBtn);
  dialog.appendChild(actionsEl);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const removeTrap = trapFocus(dialog);
  const dismiss = () => {
    removeTrap();
    overlay.remove();
  };

  laterBtn.addEventListener("click", dismiss);
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

/** Update the notice's button label and (if known) the progress-bar fill.
 *  Omit `pct` for indeterminate states — the textual label carries the
 *  signal alone. `pct` of 100 is allowed and fills the bar. (#529) */
function updateNoticeProgress(text: string, pct?: number): void {
  const btn = document.querySelector(".update-notice-action") as HTMLButtonElement | null;
  if (btn) {
    btn.textContent = text;
    btn.disabled = true;
  }
  const fill = document.querySelector(".update-notice-progress-fill") as HTMLElement | null;
  if (fill && pct !== undefined && Number.isFinite(pct)) {
    const clamped = Math.max(0, Math.min(100, pct));
    fill.style.width = `${clamped}%`;
  }
}

function resetUpdateNotice(): void {
  const notice = document.querySelector(".update-notice");
  if (!notice) return;
  notice.classList.remove("installing");
  // Clear the progress fill so a retry doesn't briefly show the failed
  // attempt's last percentage before the next Started event lands. (#529)
  const fill = notice.querySelector(".update-notice-progress-fill") as HTMLElement | null;
  if (fill) fill.style.width = "0%";
  const btn = notice.querySelector(".update-notice-action") as HTMLButtonElement | null;
  if (btn) {
    btn.textContent = "Download";
    btn.disabled = false;
    btn.onclick = () => openUrl(RELEASES_URL);
  }
}

function showUpdateNotice(version: string, releaseNotes: string): void {
  const footer = document.getElementById("sidebar-footer");
  if (!footer) return;

  // If a notice already exists, update its version text and re-render for state
  const existing = footer.querySelector(".update-notice");
  if (existing) {
    const ver = existing.querySelector(".update-notice-version");
    if (ver) ver.textContent = version;
    renderNoticeForState();
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
  const ver = document.createElement("span");
  ver.className = "update-notice-version";
  ver.textContent = version;
  text.appendChild(label);
  text.appendChild(ver);

  const btn = document.createElement("button");
  btn.className = "btn btn--primary update-notice-action";

  // Thin green progress bar along the bottom edge of the notice. Width is
  // driven by updateNoticeProgress(). (#529)
  const progress = document.createElement("div");
  progress.className = "update-notice-progress";
  const progressFill = document.createElement("div");
  progressFill.className = "update-notice-progress-fill";
  progress.appendChild(progressFill);

  notice.appendChild(dot);
  notice.appendChild(text);
  notice.appendChild(btn);
  notice.appendChild(progress);

  footer.insertBefore(notice, footer.firstChild);

  // Click handler dispatches by current state — capture releaseNotes for the
  // confirm dialog.
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (updateState === "available") {
      downloadPending().catch(() => {});
    } else if (updateState === "staged") {
      showUpdateConfirm(version, releaseNotes, () => {
        installPending({ relaunchAfter: true });
      });
    }
  });

  renderNoticeForState();
}

/** Update the notice label + button to match `updateState`. Pure render —
 *  safe to call any number of times. */
function renderNoticeForState(): void {
  const notice = document.querySelector(".update-notice") as HTMLElement | null;
  if (!notice) return;
  const label = notice.querySelector(".update-notice-label") as HTMLElement | null;
  const btn = notice.querySelector(".update-notice-action") as HTMLButtonElement | null;
  if (!label || !btn) return;

  // Drive the progress-bar visibility/data-state attribute alongside the
  // label and button. Fill width is set inline by updateNoticeProgress(). (#529)
  notice.setAttribute("data-state", updateState);

  switch (updateState) {
    case "available":
      label.textContent = "Update available";
      btn.textContent = "Download";
      btn.disabled = false;
      notice.classList.remove("installing");
      break;
    case "downloading":
      label.textContent = "Update available";
      btn.textContent = "Downloading…";
      btn.disabled = true;
      notice.classList.remove("installing");
      break;
    case "staged":
      label.textContent = "Update ready — applies on quit";
      btn.textContent = "Install Now";
      btn.disabled = false;
      notice.classList.remove("installing");
      break;
    case "installing":
      label.textContent = "Update ready";
      btn.textContent = "Installing…";
      btn.disabled = true;
      notice.classList.add("installing");
      break;
    case "failed":
    case "idle":
      // No-op — failed leaves the manual-download fallback from
      // resetUpdateNotice(); idle should never have a notice mounted.
      break;
  }
}
