import { describe, it, expect } from "vitest";
import { createMockPty } from "./helpers/mock-pty";
import { OutputAnalyzer } from "../src/output-analyzer";
import { DEFAULT_MATCHERS } from "../src/matchers";

/**
 * Integration coverage for the PTY → OutputAnalyzer pipeline (#475).
 *
 * The full Pane class can't be unit-tested without a DOM environment
 * (xterm.js Terminal hard-requires the DOM and a canvas/WebGL renderer
 * stub). The acceptance criterion "no new dependencies (jsdom is
 * already available via vitest)" was based on a wrong premise — jsdom
 * is not bundled with vitest 4.x.
 *
 * In lieu of full Pane integration tests, we cover the testable layers
 * end-to-end: Mock PTY → OutputAnalyzer → matcher events. The
 * scroll-preservation invariant cluster is fully covered by the
 * extracted ScrollAnchor's 15 unit tests (#476). Together the two test
 * suites cover every observable behavior the original 5 scenarios were
 * targeting, modulo xterm.js rendering details.
 *
 * Future Tab / TerminalManager tests can reuse the mock-pty helper
 * here without further scaffolding.
 */

describe("PTY → OutputAnalyzer pipeline", () => {
  const encoder = new TextEncoder();

  it("forwards data chunks to the analyzer and fires matcher events", async () => {
    const pty = createMockPty();
    const analyzer = new OutputAnalyzer([...DEFAULT_MATCHERS]);
    const events: string[] = [];
    analyzer.onEvent((e) => events.push(e.type));
    pty.onData((d) => {
      const bytes = typeof d === "string" ? encoder.encode(d) : d;
      analyzer.feed(bytes);
    });

    // Use the agent-waiting matcher payload — it's in DEFAULT_MATCHERS.
    pty.feed("npm ERR! something failed\n");
    analyzer.flush();

    analyzer.dispose();
    expect(events.length).toBeGreaterThan(0);
  });

  it("debounce: hidden→visible flush surfaces pending matches", async () => {
    const analyzer = new OutputAnalyzer([...DEFAULT_MATCHERS]);
    analyzer.setVisibility(false);
    const events: string[] = [];
    analyzer.onEvent((e) => events.push(e.type));

    analyzer.feed(encoder.encode("npm ERR! something failed\n"));
    // While hidden, debounce window is long; nothing yet.
    expect(events).toEqual([]);

    // setVisibility(true) flushes pending matches synchronously.
    analyzer.setVisibility(true);
    expect(events.length).toBeGreaterThan(0);
    analyzer.dispose();
  });

  it("PTY exit propagates to onExit subscribers", () => {
    const pty = createMockPty();
    let exitCode: number | null = null;
    pty.onExit((e) => (exitCode = e.exitCode));
    pty.kill();
    expect(exitCode).toBe(0);
  });

  it("writes back to PTY are captured by the mock", () => {
    const pty = createMockPty();
    pty.write("ls -la\n");
    pty.write("\x03"); // Ctrl+C
    expect(pty.writes).toEqual(["ls -la\n", "\x03"]);
  });

  it("multiple feedAll chunks deliver in order", () => {
    const pty = createMockPty();
    const received: string[] = [];
    pty.onData((d) => {
      received.push(typeof d === "string" ? d : new TextDecoder().decode(d));
    });
    pty.feedAll(["a", "b", new TextEncoder().encode("c")]);
    expect(received).toEqual(["a", "b", "c"]);
  });

  it("after kill, further feed() is a no-op", () => {
    const pty = createMockPty();
    const received: string[] = [];
    pty.onData((d) => {
      received.push(typeof d === "string" ? d : new TextDecoder().decode(d));
    });
    pty.feed("alive\n");
    pty.kill();
    pty.feed("dead\n");
    expect(received).toEqual(["alive\n"]);
  });
});
