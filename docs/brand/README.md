# ClawTerm brand assets

Source files for the ClawTerm wordmark / icon. Every committed PNG, `.icns`, and OG image in the repo derives from `logoclawterm.png` — never edit the bitmaps by hand.

## Files

- `logoclawterm.png` — **canonical raster source, 1024×1024.** The 2×2 command grid with the bottom-right tile lit Command Green. AI-generated; PNG is the source of truth.
- `favicon.svg` — vector form of the mark for browser favicon use. Raster trace (~1.2 MB); fine because browsers cache the favicon after the first hit. Not used in the `.icns` pipeline.
- `favicon.ico` — multi-size legacy favicon (32 / 48).
- `favicon-96x96.png` — small PNG favicon.
- `apple-touch-icon.png` — 180×180 for iOS home-screen pinning.
- `web-app-manifest-192x192.png`, `web-app-manifest-512x512.png` — PWA manifest icons.
- `og-image.png` — GitHub social preview / OG image. 1280×640, mock terminal + wordmark + tagline. Re-upload to repo Settings → Social preview after any change (GitHub doesn't pull this automatically).

The mark is AI-generated; we don't ship a hand-clean SVG source. A clean vector source is a possible follow-up but is not required for the rest of the brand to land.

**Mark rule:** the active tile is always bottom-right and always Command Green `#7CFF4F`. A regenerated mark that moves or recolors the active tile is a logo rule violation.

## Regenerating bitmap assets

Run from the repo root on macOS — uses built-in `sips` and `iconutil`, no extra tooling needed. `logoclawterm.png` is the only source; every Tauri-bundled bitmap falls out of it.

App icon (`src-tauri/icons/`):

```bash
sips -s format png -z 32 32     docs/brand/logoclawterm.png --out src-tauri/icons/32x32.png
sips -s format png -z 128 128   docs/brand/logoclawterm.png --out src-tauri/icons/128x128.png
sips -s format png -z 256 256   docs/brand/logoclawterm.png --out src-tauri/icons/128x128@2x.png
sips -s format png -z 512 512   docs/brand/logoclawterm.png --out src-tauri/icons/icon.png
```

macOS `.icns` (multi-resolution bundle):

```bash
ICONSET="/tmp/ClawTerm.iconset"
rm -rf "$ICONSET" && mkdir -p "$ICONSET"
sips -s format png -z 16 16     docs/brand/logoclawterm.png --out "$ICONSET/icon_16x16.png"
sips -s format png -z 32 32     docs/brand/logoclawterm.png --out "$ICONSET/icon_16x16@2x.png"
sips -s format png -z 32 32     docs/brand/logoclawterm.png --out "$ICONSET/icon_32x32.png"
sips -s format png -z 64 64     docs/brand/logoclawterm.png --out "$ICONSET/icon_32x32@2x.png"
sips -s format png -z 128 128   docs/brand/logoclawterm.png --out "$ICONSET/icon_128x128.png"
sips -s format png -z 256 256   docs/brand/logoclawterm.png --out "$ICONSET/icon_128x128@2x.png"
sips -s format png -z 256 256   docs/brand/logoclawterm.png --out "$ICONSET/icon_256x256.png"
sips -s format png -z 512 512   docs/brand/logoclawterm.png --out "$ICONSET/icon_256x256@2x.png"
sips -s format png -z 512 512   docs/brand/logoclawterm.png --out "$ICONSET/icon_512x512.png"
cp                              docs/brand/logoclawterm.png "$ICONSET/icon_512x512@2x.png"
iconutil -c icns -o src-tauri/icons/icon.icns "$ICONSET"
```

The 1024 → 16 px downscale is the worst-case test for visual fidelity — check the result in Finder Get Info at 16 px and confirm the green active tile still reads as green, not muddy. If it aliases into the panel grey, drop in a hand-tuned smaller-source variant for the `icon_16x16.png` / `icon_16x16@2x.png` entries.

Browser favicons (`docs/`):

```bash
cp docs/brand/favicon.svg          docs/favicon.svg
cp docs/brand/favicon.ico          docs/favicon.ico
cp docs/brand/favicon-96x96.png    docs/favicon-96x96.png
cp docs/brand/apple-touch-icon.png docs/apple-touch-icon.png
cp docs/brand/web-app-manifest-192x192.png docs/web-app-manifest-192x192.png
cp docs/brand/web-app-manifest-512x512.png docs/web-app-manifest-512x512.png
```

In-app favicon (`public/`):

```bash
cp docs/brand/favicon.svg public/favicon.svg
```

Vite copies anything in `public/` to the build output unchanged, so the bundled `.app` picks it up automatically.

GitHub social preview:

The new `og-image.png` should be composited in a vector editor (Figma / Sketch / Pixelmator) — a dark Mac terminal window with traffic lights, the wordmark beside it, and exactly one green-active element visible (e.g. an active tab). Export as 1280×640 PNG and replace `docs/brand/og-image.png`. Then upload it to **repo Settings → General → Social preview** — this step is manual and can't be scripted via `gh`.

## Screenshots — needs human action

The README hero (`docs/screenshots/clawterm.png`) and any supporting shots are *not* generated — they're captured from a running ClawTerm install. Per `docs/brand.md`:

- Same window dimensions as the existing image (~1280×800, native macOS chrome cropped).
- Same demo content: a project with three tabs in mixed states (running / waiting / errored), one tab expanded showing a split.
- Dark wallpaper, traffic lights visible, no other windows.
- Take the hero and every `docs/screenshots/*.png` in the same session so the chrome / wallpaper / window dimensions stay consistent.

After the `--accent` flip in #527 the hero needs a fresh capture so the public README image matches the new look — the existing screenshot still shows the old near-white accent system.
