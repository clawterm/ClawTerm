import { trapFocus } from "./utils";

export interface NotificationRecord {
  tabId: string;
  tabTitle: string;
  text: string;
  timestamp: number;
  acknowledged: boolean;
}

const MAX_RECORDS = 50;

/** In-memory store of recent OSC 9;2 events with a small panel for
 *  reviewing what happened while away. Capped at 50 entries (LRU); not
 *  persisted across restarts — these are ephemeral signals, not history.
 *  (#554) */
export class NotificationTray {
  private records: NotificationRecord[] = [];
  private listeners: Set<() => void> = new Set();
  /** Callback to switch to a tab when a tray entry is clicked. Provided
   *  by TerminalManager. */
  onFocusTab: ((tabId: string) => void) | null = null;

  push(record: Omit<NotificationRecord, "acknowledged">) {
    const r: NotificationRecord = { ...record, acknowledged: false };
    this.records.push(r);
    while (this.records.length > MAX_RECORDS) {
      this.records.shift();
    }
    this.emit();
  }

  /** Mark every record for a tab acknowledged. Called when the tab is
   *  focused — the user has seen what was waiting. */
  acknowledgeTab(tabId: string) {
    let changed = false;
    for (const r of this.records) {
      if (r.tabId === tabId && !r.acknowledged) {
        r.acknowledged = true;
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  /** Drop records for a tab — called from TerminalManager when a tab is
   *  permanently closed so the tray doesn't show entries pointing to
   *  dead tabs. */
  clearTab(tabId: string) {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.tabId !== tabId);
    if (this.records.length !== before) this.emit();
  }

  unreadCount(): number {
    let n = 0;
    for (const r of this.records) if (!r.acknowledged) n++;
    return n;
  }

  snapshot(): NotificationRecord[] {
    return this.records.slice().reverse();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  clearAcknowledged() {
    const before = this.records.length;
    this.records = this.records.filter((r) => !r.acknowledged);
    if (this.records.length !== before) this.emit();
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}

/** Render the tray panel. Reuses the palette-modal frame; lays out as a
 *  list of NotificationRecord rows, each click-to-focus. Subscribes to
 *  the store so newly-arriving events appear without a re-open. */
export function showNotificationTray(tray: NotificationTray): void {
  document.querySelector(".notification-tray-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "palette-overlay notification-tray-overlay";

  const modal = document.createElement("div");
  modal.className = "palette-modal notification-tray-modal";

  const header = document.createElement("div");
  header.className = "notification-tray-header";
  const title = document.createElement("span");
  title.textContent = "Notifications";
  const clearBtn = document.createElement("button");
  clearBtn.className = "btn btn--secondary notification-tray-clear-btn";
  clearBtn.textContent = "Clear read";
  header.appendChild(title);
  header.appendChild(clearBtn);

  const list = document.createElement("div");
  list.className = "notification-tray-list";

  function render() {
    list.textContent = "";
    const records = tray.snapshot();
    if (records.length === 0) {
      const empty = document.createElement("div");
      empty.className = "notification-tray-empty";
      empty.textContent = "No recent notifications.";
      list.appendChild(empty);
      return;
    }
    for (const r of records) {
      const row = document.createElement("button");
      row.className = "notification-tray-row" + (r.acknowledged ? " ack" : "");
      const titleEl = document.createElement("div");
      titleEl.className = "notification-tray-row-title";
      titleEl.textContent = r.tabTitle;
      const textEl = document.createElement("div");
      textEl.className = "notification-tray-row-text";
      textEl.textContent = r.text || "needs attention";
      const ageEl = document.createElement("div");
      ageEl.className = "notification-tray-row-age";
      ageEl.textContent = formatAge(Date.now() - r.timestamp);
      row.appendChild(titleEl);
      row.appendChild(textEl);
      row.appendChild(ageEl);
      row.addEventListener("click", () => {
        if (tray.onFocusTab) tray.onFocusTab(r.tabId);
        dismiss();
      });
      list.appendChild(row);
    }
  }

  modal.appendChild(header);
  modal.appendChild(list);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const removeTrap = trapFocus(modal);
  const unsubscribe = tray.subscribe(render);
  const dismiss = () => {
    removeTrap();
    unsubscribe();
    overlay.remove();
  };

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) dismiss();
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") dismiss();
  });
  clearBtn.addEventListener("click", () => {
    tray.clearAcknowledged();
  });

  render();
}

function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
