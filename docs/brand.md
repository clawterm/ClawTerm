# Clawterm brand

Source of truth for what Clawterm *is* in brand terms — position, voice, color, type, mark, screenshots. Update this file before changing anything user-visible. The CI lint at `scripts/lint-tokens.sh` enforces the color/font tokens; the rest is on us.

## Position

Clawterm is a terminal for the agent era. Not an AI assistant for a terminal — a fast, native terminal that *expects* you to be running multiple agents and gives you the chrome to keep track of them.

**Reads as:** calm, dense, professional — closer to Ghostty's monastic restraint than Warp's product-y gradients. Agent-aware features (status dots, attention indicators, OSC notifications) feel like instrumentation, not personality.

**Closest references:** Ghostty's restraint + Linear's information density + Raycast's command-palette discipline.

**What we are not:** Warp (block-based, AI-first marketing, gradients, animation flair). iTerm2 (legacy chrome, bevels, native macOS styling). Hyper (web-first, theme marketplace, plugin maximalism).

## Voice

- Direct, technical, lowercase-friendly headings
- No exclamation points, no marketing puff
- Reference voice: the README's "Highlights" section
- In-app strings should match that register

## Visual axes

- **Dark, not pitch-black.** `--bg-base: #0c0c0e`, surface `#131316`, elevated `#1a1a1e`.
- **Achromatic by default, color only for state.** Accent is intentionally near-white (`rgba(240, 240, 244, 0.8)`). Color appears only for status: red error, green success, orange warning. `--color-purple-signal` is a fourth signal hue used for Claude compaction indicators — kept as a tokenized exception rather than expanded into a full status tier.
- **Generous negative space, dense type.** Small font sizes (12–14px primary, 10–11px chrome), tight letter-spacing, breathing room around clusters.
- **Restraint over decoration.** No gradients. No glows beyond the minimal `box-shadow` calls that mark "compaction imminent." No glass-morphism / backdrop-filter. The existing `--shadow-sm` / `--shadow-lg` are the only depth cues.

## Color tokens

Defined in `src/style.css :root`. Reference via `var(--*)` only — the lint script fails CI on hardcoded hex values outside `:root`.

| Token | Value | Use |
|---|---|---|
| `--bg-base` | `#0c0c0e` | App background |
| `--bg-surface` | `#131316` | Panel surface |
| `--bg-elevated` | `#1a1a1e` | Focused pane, hover |
| `--bg-modal` | `rgba(19, 19, 22, 0.97)` | Modal background |
| `--accent` | `rgba(240, 240, 244, 0.8)` | Brand accent (near-white) |
| `--color-red` | `#e5484d` | Error state |
| `--color-green` | `#30a46c` | Success state |
| `--color-orange` | `#f5a623` | Warning state |
| `--color-purple-signal` | `#bf7af0` | Claude compaction signal — single special-case hue |
| `--badge-info-bg` / `--badge-info-text` | rgba(95,135,255,0.18) / `#a8c0ff` | High-effort badge |
| `--badge-warn-bg` / `--badge-warn-text` | rgba(229,72,77,0.18) / `#ff8a8e` | Max-effort badge |

Adding a new color? Add the token to `:root`, document semantic intent here, then use it.

## Type

- **UI:** Inter Variable / Inter / system sans
- **Mono:** JetBrains Mono Variable / JetBrains Mono / SF Mono
- **Scale:** `--font-2xs` 8 · `--font-xs` 10 · `--font-sm` 11 · `--font-base` 12 · `--font-md` 13 · `--font-lg` 14 · `--font-2xl` 20
- **Weights:** `--font-weight-medium` 510 · `--font-weight-semibold` 590 (these are tuned to Inter Variable; non-variable fallbacks coerce to 500/600)
- **Letter-spacing:** `--letter-spacing-normal` (-0.01em) by default, `--letter-spacing-wide` (0.02em) for uppercase chrome (footer effort badges, status dots)

## Spacing

Strict 4pt grid (#493). The scale is 4 / 8 / 12 / 16 / 20 / 24 / 32 → `--space-1` (2) · `--space-2` (4) · `--space-3` (8) · `--space-4` (12) · `--space-5` (16) · `--space-6` (20) · `--space-7` (24) · `--space-8` (32).

No off-grid values. The CI lint guards against new violations.

## Naming

The product name is **Clawterm** — lowercase t. Not "ClawTerm", not "ClawTerminal", not "clawterm" mid-sentence (use the capitalized form when referring to the product). The CI lint at `scripts/lint-name.sh` fails on `ClawTerm` mixed-case in any tracked file outside this `brand.md`.

## Mark

App icon, favicon, and OG image should derive from a single source SVG so they stay in sync. Today they're committed independently; consolidating to a single source SVG is tracked separately.

## Screenshots

The README hero and `docs/screenshots/clawterm.png` are the canonical product images. When updating:

- Same window dimensions as the existing image (1280×800-ish, native macOS chrome cropped).
- Same demo content: a project with three tabs in mixed states (running / waiting / errored), one tab expanded showing a split.
- Dark wallpaper, traffic lights visible, no other windows.
- Take both the hero and `docs/screenshots/*.png` in the same session — they should look like the same Clawterm.

## Non-goals

- Logo redesign — the current mark is fine.
- New illustrations or marketing motion graphics.
- Color expansion beyond the documented tokens.
