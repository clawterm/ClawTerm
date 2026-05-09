# Clawterm brand assets

Source files for the Clawterm wordmark / icon. The committed PNGs and OG image should always derive from these.

## Files

- `clawterm.svg` — canonical mark (TBD; see [#501](https://github.com/clawterm/clawterm/issues/501)).

## Regenerating bitmap assets

App icon (`src-tauri/icons/`):

- `32x32.png`, `128x128.png`, `128x128@2x.png` (256×256), `icon.icns` (macOS), `icon.ico` (Windows).
- Export from `clawterm.svg` at the listed sizes; build the icns/ico via `tauri icon` or a vector editor's batch export.

Favicon (`docs/`):

- `favicon.svg` (copy of `clawterm.svg` simplified for small sizes), `favicon.png` (32×32).

GitHub social preview (OG image):

- 1280×640 PNG. GitHub repo Settings → Social preview. Re-upload after any wordmark change.

## Screenshots

`docs/screenshots/clawterm.png` is the canonical README hero. Per `docs/brand.md` the demo content should be a project with three tabs in mixed states (running / waiting / errored), one tab expanded with a split. ~1280×800 native macOS chrome cropped.

When updating, retake the hero plus any supporting screenshots in the same session so the chrome / wallpaper / window dimensions stay consistent.
