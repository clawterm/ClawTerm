let container: HTMLElement | null = null;

function ensureContainer(): HTMLElement {
  if (!container) {
    container = document.createElement("div");
    container.className = "toast-container";
    document.body.appendChild(container);
  }
  return container;
}

export type ToastLevel = "error" | "warn" | "info";

export function showToast(message: string, level: ToastLevel = "info", durationMs = 5000): void {
  const c = ensureContainer();

  const toast = document.createElement("div");
  toast.className = `toast toast-${level}`;
  toast.setAttribute("role", "alert");
  toast.textContent = message;

  const dismiss = document.createElement("button");
  dismiss.className = "btn btn--icon toast-dismiss";
  dismiss.textContent = "\u00d7";
  dismiss.setAttribute("aria-label", "Dismiss notification");
  dismiss.addEventListener("click", () => remove());
  toast.appendChild(dismiss);

  c.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => toast.classList.add("toast-visible"));

  const timer = setTimeout(() => remove(), durationMs);
  let removed = false;

  function remove() {
    if (removed) return;
    removed = true;
    clearTimeout(timer);
    toast.classList.remove("toast-visible");
    const fallback = setTimeout(() => toast.remove(), 300);
    toast.addEventListener(
      "transitionend",
      () => {
        clearTimeout(fallback);
        toast.remove();
      },
      { once: true },
    );
  }
}
