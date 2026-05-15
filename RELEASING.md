# Releasing ClawTerm

This document covers how to ship a new version of ClawTerm — from writing changelog entries to watching the build succeed.

## Quick start

```bash
# 1. Write your changelog entries under ## [Unreleased] in CHANGELOG.md
# 2. Run the release script:
npm run release patch   # 1.0.4 → 1.0.5
npm run release minor   # 1.0.4 → 1.1.0
npm run release major   # 1.0.4 → 2.0.0
npm run release 1.2.3   # explicit version
```

That's it. The script handles everything else — version bumps, commits, tags, and push. GitHub Actions builds and publishes the release automatically.

## Prerequisites

Before running the release script:

1. **On the `main` branch** with a clean working tree (CHANGELOG.md edits are allowed)
2. **CHANGELOG.md** has entries under `## [Unreleased]` — the script refuses to release with an empty section
3. **Node.js 22+** and **Rust toolchain** installed (`rustup show` to verify)
4. **GitHub CLI** (`gh`) installed — used to verify secrets before push (optional but recommended)

### Required GitHub secrets

These must be configured at [Settings → Secrets → Actions](https://github.com/clawterm/clawterm/settings/secrets/actions):

| Secret | Purpose |
|--------|---------|
| `TAURI_SIGNING_PRIVATE_KEY` | Signs update bundles so the in-app updater can verify integrity |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the signing key |

Optional (for code signing — see issues #378, #379):

| Secret | Purpose |
|--------|---------|
| `APPLE_CERTIFICATE` | Base64-encoded .p12 certificate for macOS signing |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the Apple certificate |
| `APPLE_SIGNING_IDENTITY` | Developer ID Application identity |
| `APPLE_ID` | Apple ID email for notarization |
| `APPLE_PASSWORD` | App-specific password for notarization |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `WINDOWS_CERTIFICATE` | Base64-encoded .pfx certificate for Windows signing |
| `WINDOWS_CERTIFICATE_PASSWORD` | Password for the Windows certificate |

## What the release script does

`scripts/release.mjs` runs these steps in order:

| Step | What | Why |
|------|------|-----|
| 1 | Validate git state | Must be on `main`, clean working tree |
| 2 | Validate CHANGELOG | `[Unreleased]` section must have content |
| 3 | Bump versions | Updates `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` |
| 4 | Update CHANGELOG | Moves `[Unreleased]` content into a dated version section, updates compare links |
| 5 | Update lock files | Runs `npm install` and `cargo generate-lockfile` to sync lock files |
| 6 | Format code | Runs Prettier to catch any formatting drift |
| 7 | Preflight checks | Lint, format check, tests, typecheck — fails early before committing |
| 8 | Commit | Stages all changed files and commits with `"Bump version to X.Y.Z and update CHANGELOG"` |
| 9 | Tag | Creates `vX.Y.Z` tag (skips if tag already exists) |
| 10 | Verify secrets | Checks that required GitHub secrets are configured (skips if `gh` CLI unavailable) |
| 11 | Push | Pushes `main` branch and tags to origin (skips if already pushed) |

**If preflight fails**: no commit is created. Fix the issues and re-run the script — version bumps are preserved in the working tree.

**Idempotent**: steps 9–11 skip work that's already done, so you can safely re-run after a partial failure.

## What happens in CI

After the tag is pushed, the [Release workflow](https://github.com/clawterm/clawterm/actions/workflows/release.yml) triggers:

### Check job (Ubuntu)
1. Validates the tag version matches `package.json`
2. Validates all three version files are in sync
3. Runs frontend checks (lint, format, test, typecheck, build)

### Build jobs (parallel matrix)
Run on macOS, Windows, and Linux simultaneously:

| Platform | Target | Artifacts |
|----------|--------|-----------|
| macOS | `universal-apple-darwin` (ARM + Intel) | `.dmg`, `.app.tar.gz`, `.app.tar.gz.sig` |
| Windows | `x86_64-pc-windows-msvc` | `-setup.exe`, `-setup.exe.sig` |
| Linux | `x86_64-unknown-linux-gnu` | `.deb`, `.deb.sig`, `.AppImage`, `.AppImage.sig` |

Each build:
1. Compiles the Rust backend with `sccache` caching
2. Builds the frontend bundle
3. Produces signed Tauri bundles via `tauri-apps/tauri-action`
4. Generates a `checksums-<target>.txt` with SHA-256 hashes of the published binaries
5. Uploads everything to the draft GitHub Release
6. Publishes `latest.json` — the update manifest that running instances poll

The `publish` job then flips the draft to final once every platform succeeds.

**Build time**: ~10 minutes for macOS, ~8 minutes for Windows, ~6 minutes for Linux.

## How updates reach users

1. Running ClawTerm instances poll `latest.json` from GitHub Releases (default: every 1 hour)
2. The Tauri updater plugin compares the manifest version to the current app version
3. If a newer version exists, an update notice appears in the sidebar footer
4. User clicks "Update" → confirmation dialog → "Update & Restart"
5. The app downloads the new bundle, verifies its signature against the public key, installs, and relaunches

Users can also manually check via the update button in the sidebar footer.

## Troubleshooting

### Preflight checks fail
The script stops before committing. Fix the reported issues (lint errors, test failures, etc.) and re-run. Version bumps are already in the working tree — no need to undo them.

### Build fails on one platform
The release workflow uses `fail-fast: false`, so the other platform will still build. Check the [Actions tab](https://github.com/clawterm/clawterm/actions) for the failing job's logs. Fix and ship a patch release.

### Tag already exists
The script skips tag creation if it already exists. If you need to re-tag (e.g., after amending the release commit), delete the tag first:
```bash
git tag -d v1.0.5
git push origin :refs/tags/v1.0.5
```
Then re-run the script.

### Secrets missing
The script checks for required secrets via `gh secret list` before pushing. If secrets are missing, configure them at [Settings → Secrets → Actions](https://github.com/clawterm/clawterm/settings/secrets/actions) and re-run.

### Users not seeing the update
- The default check interval is 1 hour — users may need to wait or manually check
- Verify `latest.json` was published: check the [latest release](https://github.com/clawterm/clawterm/releases/latest) for a `latest.json` asset
- Check the user's config: `autoCheck` may be disabled in `~/.config/clawterm/config.json`

## Hotfix (shipping an emergency patch)

When a released version has a critical bug:

1. Fix the bug on `main`
2. Write a changelog entry under `## [Unreleased]`
3. Run `npm run release patch`
4. Monitor the build: `gh run watch`

Users will auto-detect the fix within the check interval (default: 1 hour). The entire process takes ~15 minutes from fix to availability.

## Rollback (emergency — broken updater or crash on startup)

Use rollback only when the app is so broken that users can't receive a patch update (e.g., crash on startup, broken updater).

### Steps

1. **Delete the broken GitHub Release** — go to [Releases](https://github.com/clawterm/clawterm/releases), find the broken version, click Edit → Delete
2. **Delete the broken tag**:
   ```bash
   git tag -d vX.Y.Z
   git push origin :refs/tags/vX.Y.Z
   ```
3. The `latest.json` endpoint (`/releases/latest/download/latest.json`) now automatically points to the previous release
4. Users who haven't updated yet will get the previous (good) version
5. Ship a fix as a new patch release as soon as possible

### Users who already updated

The Tauri updater cannot downgrade — users on the broken version must manually download a working version from the [Releases page](https://github.com/clawterm/clawterm/releases). Communicate this via:
- A notice on the GitHub Release description
- The project's issue tracker

### Prevention

- Always test the built `.dmg`/`.nsis` locally before releasing (download from the GitHub Release)
- The preflight checks in the release script catch most issues, but can't catch platform-specific runtime bugs

## Manual release (emergency only)

If the release script can't be used, follow these steps exactly. **Always prefer the script** — manual releases are error-prone (the v1.0.4 Cargo.toml drift was caused by a manual release).

1. Bump version in all three files (must match exactly):
   - `package.json` → `"version": "X.Y.Z"`
   - `src-tauri/Cargo.toml` → `version = "X.Y.Z"`
   - `src-tauri/tauri.conf.json` → `"version": "X.Y.Z"`
2. Update `CHANGELOG.md` — move `[Unreleased]` content into a new version section
3. Update lock files: `npm install --ignore-scripts` and `cd src-tauri && cargo generate-lockfile`
4. Run preflight: `npm run preflight`
5. Commit: `git add -A && git commit -m "Bump version to X.Y.Z and update CHANGELOG"`
6. Tag: `git tag vX.Y.Z`
7. Push: `git push origin main --tags`
