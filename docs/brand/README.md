# ClawTerm brand assets

Source files for the ClawTerm wordmark / icon. Every committed PNG, `.icns`, and OG image in the repo derives from these — never edit the bitmaps by hand.

## Files

- `clawterm.svg` — canonical mark (chevron on dark canvas, 512×512). Source of truth for the app icon and favicon.
- `og-image.svg` — GitHub social preview / OG image variant. 1280×640, wordmark + tagline beside the mark.
- `og-image.png` — committed rasterisation of `og-image.svg`. Re-upload to repo Settings → Social preview after any change (GitHub doesn't pull this automatically).

## Regenerating bitmap assets

Run from the repo root on macOS — uses built-in `sips` and `iconutil`, no extra tooling needed. The SVG is the only source; everything else falls out of it.

App icon (`src-tauri/icons/`):

```bash
sips -s format png -z 32 32   docs/brand/clawterm.svg --out src-tauri/icons/32x32.png
sips -s format png -z 128 128 docs/brand/clawterm.svg --out src-tauri/icons/128x128.png
sips -s format png -z 256 256 docs/brand/clawterm.svg --out src-tauri/icons/128x128@2x.png
sips -s format png -z 512 512 docs/brand/clawterm.svg --out src-tauri/icons/icon.png
```

macOS `.icns` (multi-resolution bundle):

```bash
ICONSET="/tmp/ClawTerm.iconset"
rm -rf "$ICONSET" && mkdir -p "$ICONSET"
sips -s format png -z 16 16     docs/brand/clawterm.svg --out "$ICONSET/icon_16x16.png"
sips -s format png -z 32 32     docs/brand/clawterm.svg --out "$ICONSET/icon_16x16@2x.png"
sips -s format png -z 32 32     docs/brand/clawterm.svg --out "$ICONSET/icon_32x32.png"
sips -s format png -z 64 64     docs/brand/clawterm.svg --out "$ICONSET/icon_32x32@2x.png"
sips -s format png -z 128 128   docs/brand/clawterm.svg --out "$ICONSET/icon_128x128.png"
sips -s format png -z 256 256   docs/brand/clawterm.svg --out "$ICONSET/icon_128x128@2x.png"
sips -s format png -z 256 256   docs/brand/clawterm.svg --out "$ICONSET/icon_256x256.png"
sips -s format png -z 512 512   docs/brand/clawterm.svg --out "$ICONSET/icon_256x256@2x.png"
sips -s format png -z 512 512   docs/brand/clawterm.svg --out "$ICONSET/icon_512x512.png"
sips -s format png -z 1024 1024 docs/brand/clawterm.svg --out "$ICONSET/icon_512x512@2x.png"
iconutil -c icns -o src-tauri/icons/icon.icns "$ICONSET"
```

Favicon (`docs/`):

```bash
cp docs/brand/clawterm.svg docs/favicon.svg
sips -s format png -z 32 32 docs/brand/clawterm.svg --out docs/favicon.png
```

GitHub social preview:

```bash
sips -s format png -z 640 1280 docs/brand/og-image.svg --out docs/brand/og-image.png
```

Then upload `docs/brand/og-image.png` to **repo Settings → General → Social preview** — this step is manual and can't be scripted via `gh`.

## Screenshots — needs human action

The README hero (`docs/screenshots/clawterm.png`) and any supporting shots are *not* generated — they're captured from a running ClawTerm install. Per `docs/brand.md`:

- Same window dimensions as the existing image (~1280×800, native macOS chrome cropped).
- Same demo content: a project with three tabs in mixed states (running / waiting / errored), one tab expanded showing a split.
- Dark wallpaper, traffic lights visible, no other windows.
- Take the hero and every `docs/screenshots/*.png` in the same session so the chrome / wallpaper / window dimensions stay consistent.

Currently the only screenshot in the repo is the legacy hero — capturing the supporting set (tab list, split panes, command palette, update flow) called out in #501's acceptance criteria still needs a manual retake session.
