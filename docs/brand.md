# ClawTerm brand

Source of truth for what ClawTerm *is* in brand terms — position, voice, color, type, mark, naming, screenshots. Update this file before changing anything user-visible. The CI lints at `scripts/lint-tokens.sh` and `scripts/lint-name.sh` enforce the color/font tokens and the brand-name casing; the rest is on us.

## Position

ClawTerm is a Mac-native terminal workspace for focused technical workflows — the best way to run many AI agents at once and keep track of them.

**Reads as:** calm, dense, Mac-native, professional — closer to a system utility than a SaaS dashboard. Agent-aware features (status dots, attention indicators, OSC notifications) feel like instrumentation, not personality.

**Closest references:** Ghostty's restraint + Linear's information density + Raycast's command-palette discipline.

**What we are not:** Warp (block-based, AI-first marketing, gradients, animation flair). iTerm2 (legacy chrome, bevels). Hyper (web-first, theme marketplace, plugin maximalism).

## Personality

Mac-native, technical, calm, focused, precise, minimal.

Not: loud, cyberpunk, gaming, futuristic, SaaS, decorative.

## Voice

- Direct, technical, lowercase-friendly headings.
- No exclamation points, no "10x" copy, no buzzwords.
- Reference voice: the README's "Highlights" section.
- In-app strings should match that register.

## Naming

The product name is **ClawTerm** — capital T. Not "Clawterm", not "ClawTerminal".

- Brand / display name: **ClawTerm**
- App bundle / `.app`: `ClawTerm.app` for fresh installs
- Bundle id: `com.clawterm.terminal` (lowercase is fine in identifiers)
- Repo slug / URLs: `github.com/clawterm/clawterm` (lowercase by convention)
- File paths, npm/cargo crate names, CSS class names, env vars: lowercase `clawterm` is fine

`scripts/lint-name.sh` enforces `ClawTerm` (capital T) in tracked docs/UI files and fails CI on the old `Clawterm` form. Lowercase `clawterm` in identifier-safe contexts is allowed by word-boundary matching. `docs/brand.md` is exempt because it documents both spellings explicitly.

## Mark

Compact 2×2 terminal grid. Three quiet command tiles, each containing a `>_` prompt glyph. The bottom-right tile is **active**: green prompt glyph, green underline cursor, and a soft green outer glow.

The active tile is always bottom-right and always Command Green. A regeneration that moves or recolors it is a logo rule violation.

The canonical raster source is `docs/brand/logoclawterm.png` (1024×1024). The mark is AI-generated; PNG is the canonical format and the `.icns` / `src-tauri/icons/*.png` derivatives are downscaled via `sips`. A clean hand-built SVG source is a possible follow-up but not required.

## Color system

Defined in `src/style.css :root`. Reference via `var(--*)` only — the lint script fails CI on hardcoded hex values outside `:root`.

| Role       | Token              | Value                        | Use                              |
|------------|--------------------|------------------------------|----------------------------------|
| Background | `--bg-base`        | `#050607`                    | App background                   |
| Surface    | `--bg-surface`     | `#0B0D0E`                    | Panel surface (terminal interior runs one notch darker, `#07080A`, set in `src/config.ts`) |
| Panel      | `--bg-elevated`    | `#111315`                    | Sidebar, cards, title bar, focused pane, hover |
| Border     | `--border`         | `#22262A`                    | Solid separators                 |
| Border (overlay) | `--border-subtle` / `--border-default` | rgba 6% / 9% white | Subtle overlays on arbitrary surfaces |
| Text       | `--text-primary`   | rgba(244,244,245,0.9)        | Primary text                     |
| Muted text | `--text-secondary` | rgba(244,244,245,0.55)       | Secondary text                   |
| Dim text   | `--text-tertiary`  | rgba(244,244,245,0.35)       | Tertiary / disabled              |
| **Accent** | `--accent`         | **`#7CFF4F`** Command Green  | **Active state only** (see green-usage rule below) |

### Existing status tokens stay as is

- `--color-red` `#e5484d` — error state
- `--color-green` `#30a46c` — semantic success state (this is **not** Command Green; different semantics)
- `--color-orange` `#f5a623` — warning state
- `--color-purple-signal` `#bf7af0` — Claude compaction signal (single special-case hue)
- `--badge-info-*` / `--badge-warn-*` — footer effort badges

Adding a new color? Add the token to `:root`, document semantic intent here, then use it.

### Green-usage rule

**Command Green `#7CFF4F` only ever means *active / selected / running / ready / focused / executing*.** No decorative use.

> **At most one primary chrome element is green per screen** — active tab, focused pane, primary CTA, or focus ring.
>
> *Status indicators* (running dots, ready badges, success toasts) may repeat per subject — that's the indicator doing its job, not decoration.

**Allowed uses:** active prompt, terminal cursor, selected workspace, active tab indicator, primary execution action (e.g. "Run", "Open project"), ready-to-run action, focus ring, running/ready status dots.

**Forbidden uses:** large green backgrounds, decorative glow, marketing gradients, every icon, the full wordmark, hover states on secondary buttons, button emphasis on non-executing actions, "Save" buttons in settings (those are neutral).

## Type

ClawTerm is **all-mono**. Every glyph in the app — sidebar labels, buttons, dialog copy, headings, wordmark, terminal — is rendered in **JetBrains Mono**. The aesthetic is the technical voice of the brand: typewriter calm, archival precision, the typeface of well logs and field reports. There is no companion sans.

- **UI / body / wordmark:** `"JetBrains Mono Variable", "JetBrains Mono", "SFMono-Regular", ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace`
- **Terminal:** same stack.
- **Scale:** `--font-2xs` 8 · `--font-xs` 10 · `--font-sm` 11 · `--font-base` 12 · `--font-md` 13 · `--font-lg` 14 · `--font-2xl` 20
- **Weights:** `--font-weight-medium` 500 · `--font-weight-semibold` 600 — JetBrains Mono Variable accepts the full 100–800 axis range, but UI surfaces should snap to 400 / 500 / 600 / 700 for predictability.
- **Letter-spacing:** `--letter-spacing-normal` (0) by default — mono is already evenly spaced, no kerning compression. `--letter-spacing-wide` (0.04em) for uppercase chrome (footer effort badges, status dots).
- **Wordmark:** JetBrains Mono, weight 700, letter-spacing 0. No tracking adjustments — the wordmark inherits mono's natural rhythm.

Inter is retired. The dependency is removed from `package.json` and the `@font-face` block for Inter is dropped from `src/fonts.css`.

## Spacing

Strict 4pt grid (#493). The scale is 4 / 8 / 12 / 16 / 20 / 24 / 32 → `--space-1` (2) · `--space-2` (4) · `--space-3` (8) · `--space-4` (12) · `--space-5` (16) · `--space-6` (20) · `--space-7` (24) · `--space-8` (32).

No off-grid values. The CI lint guards against new violations.

## Screenshots

The README hero and `docs/screenshots/clawterm.png` are the canonical product images. When updating:

- Same window dimensions as the existing image (1280×800-ish, native macOS chrome cropped).
- Same demo content: a project with three tabs in mixed states (running / waiting / errored), one tab expanded showing a split.
- Dark wallpaper, traffic lights visible, no other windows.
- Take both the hero and `docs/screenshots/*.png` in the same session — they should look like the same ClawTerm.

## Non-goals

- Renaming the GitHub org or repo (`clawterm/clawterm` stays).
- Domain change. Custom domain is a separate decision.
- New illustrations or marketing motion graphics.
- Color expansion beyond the documented tokens.
- Hand-built clean SVG source for the mark — possible follow-up, not blocking.
