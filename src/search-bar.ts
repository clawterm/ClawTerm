import type { SearchAddon } from "@xterm/addon-search";

export class SearchBar {
  private element: HTMLDivElement;
  private input: HTMLInputElement;
  private countLabel: HTMLSpanElement;
  private searchAddon: SearchAddon;
  private visible = false;
  private onClose: (() => void) | null = null;
  private resultsDisposable: { dispose(): void } | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private listenerAbort = new AbortController();

  constructor(container: HTMLElement, searchAddon: SearchAddon, onClose?: () => void) {
    this.onClose = onClose ?? null;
    this.searchAddon = searchAddon;

    this.element = document.createElement("div");
    this.element.className = "search-bar";
    this.element.style.display = "none";

    this.input = document.createElement("input");
    this.input.className = "search-input";
    this.input.type = "text";
    this.input.placeholder = "Search...";
    this.input.setAttribute("aria-label", "Search terminal");

    this.countLabel = document.createElement("span");
    this.countLabel.className = "search-count";
    this.countLabel.setAttribute("aria-live", "polite");

    const signal = this.listenerAbort.signal;

    const prevBtn = document.createElement("button");
    prevBtn.className = "btn btn--icon search-btn";
    prevBtn.textContent = "\u25B2";
    prevBtn.title = "Previous (Shift+Enter)";
    prevBtn.addEventListener("click", () => this.findPrev(), { signal });

    const nextBtn = document.createElement("button");
    nextBtn.className = "btn btn--icon search-btn";
    nextBtn.textContent = "\u25BC";
    nextBtn.title = "Next (Enter)";
    nextBtn.addEventListener("click", () => this.findNext(), { signal });

    const closeBtn = document.createElement("button");
    closeBtn.className = "btn btn--icon search-btn search-close";
    closeBtn.textContent = "\u00D7";
    closeBtn.addEventListener("click", () => this.hide(), { signal });

    this.element.appendChild(this.input);
    this.element.appendChild(this.countLabel);
    this.element.appendChild(prevBtn);
    this.element.appendChild(nextBtn);
    this.element.appendChild(closeBtn);
    container.appendChild(this.element);

    this.resultsDisposable = this.searchAddon.onDidChangeResults((e) => {
      if (e.resultCount === 0) {
        this.countLabel.textContent = this.input.value ? "No results" : "";
      } else if (e.resultIndex === -1) {
        this.countLabel.textContent = `${e.resultCount}+`;
      } else {
        this.countLabel.textContent = `${e.resultIndex + 1} of ${e.resultCount}`;
      }
    });

    this.input.addEventListener(
      "input",
      () => {
        if (this.searchTimer) clearTimeout(this.searchTimer);
        const term = this.input.value;
        if (!term) {
          this.searchAddon.clearDecorations();
          this.countLabel.textContent = "";
          return;
        }
        this.searchTimer = setTimeout(() => {
          this.searchTimer = null;
          this.searchAddon.findNext(term, { incremental: true });
        }, 150);
      },
      { signal },
    );

    this.input.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (e.shiftKey) {
            this.findPrev();
          } else {
            this.findNext();
          }
        }
        if (e.key === "Escape") {
          this.hide();
        }
      },
      { signal },
    );
  }

  toggle() {
    if (this.visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  show() {
    this.visible = true;
    this.element.style.display = "flex";
    this.input.focus();
    this.input.select();
  }

  hide() {
    this.visible = false;
    this.element.style.display = "none";
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.searchAddon.clearDecorations();
    this.countLabel.textContent = "";
    this.onClose?.();
  }

  private findNext() {
    if (this.input.value) {
      this.searchAddon.findNext(this.input.value);
    }
  }

  private findPrev() {
    if (this.input.value) {
      this.searchAddon.findPrevious(this.input.value);
    }
  }

  dispose() {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.listenerAbort.abort();
    this.resultsDisposable?.dispose();
    this.element.remove();
    // Break references for GC after disposal — the object must not be used after this.
    const self = this as unknown as Record<string, unknown>;
    self.searchAddon = null;
    self.input = null;
    self.countLabel = null;
    self.element = null;
  }
}
