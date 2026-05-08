/** Lightweight performance instrumentation (#307).
 *  Records timing data for key code paths. Access via command palette
 *  "Show Performance Stats" or `perfMetrics.getSummary()` in console. */

interface MetricEntry {
  count: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
}

class PerfMetrics {
  private metrics = new Map<string, MetricEntry>();

  record(label: string, ms: number): void {
    const m = this.metrics.get(label) ?? { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
    m.count++;
    m.totalMs += ms;
    m.maxMs = Math.max(m.maxMs, ms);
    m.lastMs = ms;
    this.metrics.set(label, m);
  }

  getSummary(): string {
    if (this.metrics.size === 0) return "No performance data collected yet.";
    const lines = ["Label                        Count    Avg     Max    Last"];
    lines.push("─".repeat(60));
    for (const [label, m] of [...this.metrics.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs)) {
      const avg = (m.totalMs / m.count).toFixed(1);
      const name = label.padEnd(28);
      lines.push(
        `${name} ${String(m.count).padStart(5)}  ${avg.padStart(6)}ms ${m.maxMs.toFixed(1).padStart(6)}ms ${m.lastMs.toFixed(1).padStart(6)}ms`,
      );
    }
    return lines.join("\n");
  }

  reset(): void {
    this.metrics.clear();
  }
}

export const perfMetrics = new PerfMetrics();

/** Time a synchronous function and record the result. */
export function timed<T>(label: string, fn: () => T): T {
  const start = performance.now();
  const result = fn();
  perfMetrics.record(label, performance.now() - start);
  return result;
}
