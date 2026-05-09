import { invokeWithTimeout, trapFocus } from "./utils";
import { logger } from "./logger";

export interface WorktreeDialogResult {
  branch: string;
  baseBranch: string;
  createBranch: boolean;
  worktreeDir: string;
  launchAgent: string;
}

interface BranchInfo {
  name: string;
  commit: string;
  is_remote: boolean;
  has_worktree: boolean;
}

let overlay: HTMLDivElement | null = null;

export interface WorktreeDialogOptions {
  /** Dialog title — defaults to "New Agent Tab" */
  title?: string;
  /** Whether to show the agent launcher input — defaults to true */
  showAgent?: boolean;
  /** Button label — defaults to "Create Tab" */
  buttonLabel?: string;
}

/**
 * @param repoRoot         Absolute path to the main repository root.
 * @param worktreeBaseDir  **Resolved absolute** path to the directory that
 *                         will contain the new worktree subdirectory. The
 *                         caller (worktree-actions) is responsible for
 *                         calling resolveWorktreeBase() — the dialog itself
 *                         is mode-agnostic. (#416)
 */
export function showWorktreeDialog(
  repoRoot: string,
  worktreeBaseDir: string,
  defaultAgent: string,
  onResult: (result: WorktreeDialogResult) => void,
  options?: WorktreeDialogOptions,
): void {
  if (overlay) {
    dismissDialog();
    return;
  }

  overlay = document.createElement("div");
  overlay.className = "palette-overlay";

  const modal = document.createElement("div");
  modal.className = "palette-modal worktree-modal";

  const showAgent = options?.showAgent !== false;

  // Title
  const title = document.createElement("div");
  title.className = "worktree-title";
  title.textContent = options?.title ?? "New Agent Tab";

  // Search input
  const input = document.createElement("input");
  input.className = "palette-input";
  input.type = "text";
  input.placeholder = "Search branches or type new name\u2026";

  // Branch list
  const list = document.createElement("div");
  list.className = "palette-list worktree-list";

  // New branch section
  const newSection = document.createElement("div");
  newSection.className = "worktree-new-section";
  newSection.style.display = "none";

  const baseLabel = document.createElement("label");
  baseLabel.className = "worktree-label";
  baseLabel.textContent = "Base branch:";
  const baseSelect = document.createElement("select");
  baseSelect.className = "worktree-select";

  const agentRow = document.createElement("div");
  agentRow.className = "worktree-agent-row";
  const agentLabel = document.createElement("label");
  agentLabel.className = "worktree-label";
  agentLabel.textContent = "Launch agent:";
  const agentInput = document.createElement("input");
  agentInput.className = "worktree-agent-input";
  agentInput.type = "text";
  agentInput.placeholder = "e.g. claude, aider (empty = none)";
  agentInput.value = defaultAgent;
  agentRow.appendChild(agentLabel);
  agentRow.appendChild(agentInput);

  newSection.appendChild(baseLabel);
  newSection.appendChild(baseSelect);

  // Buttons
  const btnRow = document.createElement("div");
  btnRow.className = "worktree-buttons";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn btn--secondary worktree-btn";
  cancelBtn.textContent = "Cancel";
  const createBtn = document.createElement("button");
  createBtn.className = "btn btn--primary worktree-btn";
  createBtn.textContent = options?.buttonLabel ?? "Create Tab";
  createBtn.disabled = true;
  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(createBtn);

  modal.appendChild(title);
  modal.appendChild(input);
  modal.appendChild(list);
  modal.appendChild(newSection);
  if (showAgent) modal.appendChild(agentRow);
  modal.appendChild(btnRow);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  let branches: BranchInfo[] = [];
  let filtered: BranchInfo[] = [];
  let selectedIdx = 0;
  let selectedBranch: string | null = null;
  let isNewBranch = false;

  // Load branches
  invokeWithTimeout<BranchInfo[]>("list_branches", { repoDir: repoRoot }, 5000)
    .then((result) => {
      branches = result;
      filtered = branches;
      // Populate base branch select
      const localBranches = branches.filter((b) => !b.is_remote);
      for (const b of localBranches) {
        const opt = document.createElement("option");
        opt.value = b.name;
        opt.textContent = b.name;
        if (b.name === "main" || b.name === "master") opt.selected = true;
        baseSelect.appendChild(opt);
      }
      render();
    })
    .catch((e) => {
      logger.debug("Failed to list branches:", e);
      list.textContent = "Failed to load branches";
    });

  function sanitizeBranchForDir(name: string): string {
    return name.replace(/[/\\:*?"<>|]/g, "-").replace(/^-+|-+$/g, "");
  }

  function render() {
    list.innerHTML = "";
    const query = input.value.trim().toLowerCase();

    if (query) {
      filtered = branches.filter((b) => b.name.toLowerCase().includes(query));
    } else {
      filtered = branches;
    }

    // Check if query matches exactly an existing branch
    const exactMatch = branches.some((b) => b.name.toLowerCase() === query);
    isNewBranch = query.length > 0 && !exactMatch;

    if (isNewBranch) {
      // Show "create new branch" option first
      const item = document.createElement("div");
      item.className = "palette-item" + (selectedIdx === 0 ? " selected" : "");
      item.innerHTML = `<span class="worktree-create-label">Create branch:</span> <strong>${escapeHtml(input.value.trim())}</strong>`;
      item.addEventListener("click", () => {
        selectNewBranch(input.value.trim());
      });
      list.appendChild(item);
      newSection.style.display = "";
    } else {
      newSection.style.display = "none";
    }

    const offset = isNewBranch ? 1 : 0;
    // Group: local first, then remote
    const local = filtered.filter((b) => !b.is_remote);
    const remote = filtered.filter((b) => b.is_remote);

    if (local.length > 0) {
      const header = document.createElement("div");
      header.className = "worktree-group-header";
      header.textContent = "Local";
      list.appendChild(header);
    }
    for (let i = 0; i < local.length; i++) {
      list.appendChild(createBranchItem(local[i], i + offset));
    }
    if (remote.length > 0) {
      const header = document.createElement("div");
      header.className = "worktree-group-header";
      header.textContent = "Remote";
      list.appendChild(header);
    }
    for (let i = 0; i < remote.length; i++) {
      list.appendChild(createBranchItem(remote[i], local.length + i + offset));
    }

    if (filtered.length === 0 && !isNewBranch) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No matching branches. Type a name to create one.";
      list.appendChild(empty);
    }

    // Update create button state
    createBtn.disabled = !selectedBranch && !isNewBranch;
  }

  function createBranchItem(b: BranchInfo, idx: number): HTMLElement {
    const item = document.createElement("div");
    item.className = "palette-item" + (idx === selectedIdx ? " selected" : "");

    let label = b.name;
    if (b.has_worktree) label += " \u2022 has worktree";

    item.textContent = label;
    if (b.has_worktree) {
      item.classList.add("worktree-existing");
    }

    item.addEventListener("click", () => {
      selectedIdx = idx;
      selectedBranch = b.name;
      isNewBranch = false;
      // Base branch selector is only relevant for new branches
      newSection.style.display = "none";
      createBtn.disabled = false;
      render();
    });

    return item;
  }

  function selectNewBranch(name: string) {
    selectedBranch = name;
    isNewBranch = true;
    newSection.style.display = "";
    createBtn.disabled = false;
  }

  function submit() {
    const branch = isNewBranch ? input.value.trim() : selectedBranch;
    if (!branch) return;

    const dirName = sanitizeBranchForDir(branch);
    // worktreeBaseDir is already a resolved absolute path (#416) — caller
    // ran it through resolveWorktreeBase() before opening the dialog.
    const worktreeDir = `${worktreeBaseDir}/${dirName}`;
    const baseBranch = baseSelect.value || "main";

    dismissDialog();
    onResult({
      branch,
      baseBranch,
      createBranch: isNewBranch,
      worktreeDir,
      launchAgent: agentInput.value.trim(),
    });
  }

  // Event handlers
  input.addEventListener("input", () => {
    selectedIdx = 0;
    selectedBranch = null;
    render();
  });

  input.addEventListener("keydown", (e) => {
    const totalItems = filtered.length + (isNewBranch ? 1 : 0);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, totalItems - 1);
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, 0);
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (isNewBranch && selectedIdx === 0) {
        selectNewBranch(input.value.trim());
        submit();
      } else {
        const offset = isNewBranch ? 1 : 0;
        const idx = selectedIdx - offset;
        const local = filtered.filter((b) => !b.is_remote);
        const remote = filtered.filter((b) => b.is_remote);
        const all = [...local, ...remote];
        if (idx >= 0 && idx < all.length) {
          selectedBranch = all[idx].name;
          isNewBranch = false;
          submit();
        }
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      dismissDialog();
    }
  });

  cancelBtn.addEventListener("click", dismissDialog);
  createBtn.addEventListener("click", submit);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) dismissDialog();
  });

  const releaseFocus = trapFocus(modal);
  input.focus();

  // Store cleanup for dismiss
  (overlay as HTMLDivElement & { _releaseFocus?: () => void })._releaseFocus = releaseFocus;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function dismissDialog() {
  if (overlay) {
    const o = overlay as HTMLDivElement & { _releaseFocus?: () => void };
    o._releaseFocus?.();
    overlay.remove();
    overlay = null;
  }
}
