import type { Terminal } from "@xterm/xterm";
import type { WebglAddon } from "@xterm/addon-webgl";
import { logger } from "./logger";

/**
 * Global LRU pool for WebGL contexts — limits total GPU contexts to avoid
 * browser exhaustion (#135) while keeping recently-used tabs' contexts alive
 * to eliminate create/destroy overhead on tab switch (#290).
 */
/** Ceiling on concurrent WebGL contexts (#290). Sized to leave headroom
 *  below the browser's hard limit (typically 8-16 — exhausting it kills
 *  all contexts at once). Exported so the memory-diagnostics modal can
 *  surface "active/max" (#566). */
export const WEBGL_POOL_MAX = 6;

class WebGLPool {
  private lru: WebGLManager[] = [];
  private readonly maxContexts = WEBGL_POOL_MAX;

  /** Register a manager as actively using a WebGL context. */
  touch(manager: WebGLManager): void {
    const idx = this.lru.indexOf(manager);
    if (idx !== -1) this.lru.splice(idx, 1);
    this.lru.push(manager);

    // Evict oldest if at capacity.
    // IMPORTANT: shift() removes the victim from lru BEFORE calling
    // deactivate(), so deactivate()'s pool.remove(this) is a safe no-op.
    while (this.lru.length > this.maxContexts) {
      const victim = this.lru.shift()!;
      logger.debug(`[webgl.pool] evicting pane=${victim.id} (${this.lru.length + 1} > ${this.maxContexts})`);
      victim.deactivate();
    }
  }

  /** Remove a manager from the pool (on dispose or deactivate). */
  remove(manager: WebGLManager): void {
    const idx = this.lru.indexOf(manager);
    if (idx !== -1) this.lru.splice(idx, 1);
  }
}

/** Shared pool instance */
const pool = new WebGLPool();

/**
 * Manages WebGL + Image addon lifecycle for a terminal pane.
 * Extracted from Pane to isolate GPU-related concerns.
 * Uses a shared LRU pool to keep recently-used contexts alive (#290).
 */
/** Per-pane image-storage cap (#565). The xterm.js ImageAddon defaults to
 *  128 MB per pane, which on an 8-pane workspace can pin ~1 GB to images
 *  alone. 32 MB still holds several screenshot-sized PNGs while keeping
 *  the worst-case multi-pane footprint bounded. The cap is FIFO-evicted,
 *  so an active image-heavy session sees older bitmaps replaced with the
 *  placeholder glyph rather than failing. */
const IMAGE_STORAGE_LIMIT_MB = 32;

interface ImageAddonHandle {
  dispose(): void;
  reset(): void;
  readonly storageUsage: number;
}

export class WebGLManager {
  private webglAddon: WebglAddon | null = null;
  private imageAddon: ImageAddonHandle | null = null;
  private deferredTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly id: string,
    private readonly terminal: Terminal,
    private readonly getElement: () => HTMLDivElement,
    private readonly getLastOutputAt: () => number,
    private readonly isDisposed: () => boolean,
  ) {}

  get active(): boolean {
    return this.webglAddon != null;
  }

  /**
   * Activate WebGL + Image addons. Defers activation during active output
   * to avoid scroll jumps from xterm.js reflow races.
   */
  activate(force = false): void {
    if (this.isDisposed() || this.webglAddon) {
      // Already active — just touch the pool to mark as recently used
      if (this.webglAddon) pool.touch(this);
      return;
    }
    const el = this.getElement();
    if (el.offsetWidth === 0 || el.offsetHeight === 0) return;

    if (!force) {
      const outputAge = Date.now() - this.getLastOutputAt();
      // Defer 200ms longer than Pane.fit() (300ms) so the two reflow-heavy
      // operations land on separate frames once output settles. (#460)
      if (outputAge < 500) {
        if (!this.deferredTimer) {
          this.deferredTimer = setTimeout(() => {
            this.deferredTimer = null;
            this.activate();
          }, 500);
        }
        return;
      }
    }

    // Lazy-load addons for bundle splitting (#317)
    this.loadAddons();
  }

  private async loadAddons(): Promise<void> {
    try {
      const { WebglAddon } = await import("@xterm/addon-webgl");
      if (this.isDisposed() || this.webglAddon) return; // Check again after await
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        logger.debug(`[pane.webgl] pane=${this.id} context lost, falling back to canvas`);
        this.deactivate(/* contextLost */ true);
      });
      this.terminal.loadAddon(webgl);
      this.webglAddon = webgl;
      // Register with pool — may evict oldest context
      pool.touch(this);
    } catch (e) {
      logger.debug(`[pane.webgl] pane=${this.id} WebGL failed, using canvas: ${e}`);
    }

    if (!this.imageAddon) {
      try {
        const { ImageAddon } = await import("@xterm/addon-image");
        if (this.isDisposed()) return;
        const img = new ImageAddon({ storageLimit: IMAGE_STORAGE_LIMIT_MB });
        this.terminal.loadAddon(img);
        this.imageAddon = img;
      } catch {
        // Image addon may fail if WebGL is unavailable
      }
    }
  }

  /** Reset image storage for this pane (FIFO-evicts all stored bitmaps).
   *  Surfaced via the "Reset Pane Images" command palette entry as a manual
   *  escape hatch for when a session has pinned a lot of image memory and
   *  the user wants to reclaim it without closing the pane. (#565) */
  resetImages(): void {
    this.imageAddon?.reset();
  }

  /** Current image-addon storage usage in MB (0 if the addon isn't loaded
   *  or no images are stored). Surfaced by the memory-diagnostics command
   *  to attribute RAM growth per pane. (#565, #566) */
  getImageStorageMb(): number {
    return this.imageAddon?.storageUsage ?? 0;
  }

  /**
   * Dispose WebGL + Image addons to free GPU contexts.
   * When contextLost is true, forces a terminal refresh so the viewport
   * doesn't stay black after falling back to canvas.
   */
  deactivate(contextLost = false): void {
    pool.remove(this);
    const hadWebgl = !!this.webglAddon;
    if (this.webglAddon) {
      try {
        this.webglAddon.dispose();
      } catch {
        /* already disposed */
      }
      this.webglAddon = null;
    }
    if (this.imageAddon) {
      try {
        this.imageAddon.dispose();
      } catch {
        /* already disposed */
      }
      this.imageAddon = null;
    }
    if (contextLost && hadWebgl && !this.isDisposed()) {
      requestAnimationFrame(() => {
        if (!this.isDisposed()) {
          this.terminal.refresh(0, this.terminal.rows - 1);
        }
      });
    }
  }

  /** Cancel any pending deferred activation timer. */
  cancelDeferred(): void {
    if (this.deferredTimer) {
      clearTimeout(this.deferredTimer);
      this.deferredTimer = null;
    }
  }

  dispose(): void {
    this.cancelDeferred();
    this.deactivate();
  }
}
