# Installation and updates

ClawTerm ships pre-built binaries for macOS (Apple Silicon and Intel), Windows (x64), and Linux (x64, `.deb` and `.AppImage`).

## macOS

One-liner installer (downloads the latest DMG, verifies the SHA-256 checksum against the release's `checksums-universal-apple-darwin.txt`, copies `ClawTerm.app` into `/Applications`, and clears the quarantine flag):

```bash
curl -fsSL https://raw.githubusercontent.com/clawterm/clawterm/main/install.sh | bash
```

If you'd rather install by hand, download `Clawterm_<version>_universal.dmg` from the [latest release](https://github.com/clawterm/clawterm/releases/latest) — a single universal build that runs on both Apple Silicon and Intel Macs.

Mount the DMG and drag `ClawTerm.app` into `/Applications`.

> **Gatekeeper note:** ClawTerm is not yet Apple-notarized. If macOS refuses to launch it, clear the quarantine flag once:
>
> ```bash
> xattr -cr /Applications/ClawTerm.app
> ```
>
> Tracking issue: [#378](https://github.com/clawterm/clawterm/issues/378).

## Windows

```powershell
irm https://raw.githubusercontent.com/clawterm/clawterm/main/install.ps1 | iex
```

The script downloads the latest `Clawterm_<version>_x64-setup.exe`, verifies the SHA-256 checksum, and runs the installer.

You can also download the installer manually from the [latest release](https://github.com/clawterm/clawterm/releases/latest).

> **SmartScreen note:** ClawTerm is not yet Authenticode-signed. Windows may show a SmartScreen warning the first time you run the installer. Click **More info → Run anyway**. Tracking issue: [#379](https://github.com/clawterm/clawterm/issues/379).

## Linux

Download either package from the [latest release](https://github.com/clawterm/clawterm/releases/latest):

- Debian/Ubuntu → `Clawterm_<version>_amd64.deb` — install with `sudo apt install ./Clawterm_<version>_amd64.deb`
- Other distros → `Clawterm_<version>_amd64.AppImage` — `chmod +x` and run directly

### Building from source

```bash
git clone https://github.com/clawterm/clawterm.git
cd clawterm
npm install
npm run tauri build
```

Requirements:

- [Rust](https://rustup.rs/)
- [Node.js](https://nodejs.org/) 18+
- Tauri system dependencies — see the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/) for your distro

The built binary lands in `src-tauri/target/release/`.

## Verifying checksums manually

Each platform's release artifacts ship with a `checksums-<target>.txt` file:

- macOS → `checksums-universal-apple-darwin.txt`
- Windows → `checksums-x86_64-pc-windows-msvc.txt`
- Linux → `checksums-x86_64-unknown-linux-gnu.txt`

**macOS / Linux:**

```bash
shasum -a 256 -c checksums-universal-apple-darwin.txt --ignore-missing
```

**Windows (PowerShell):**

```powershell
Get-FileHash -Algorithm SHA256 .\Clawterm_1.2.0_x64-setup.exe
# Compare the hash against the matching line in checksums-x86_64-pc-windows-msvc.txt
```

The one-liner installers above do this automatically and abort on mismatch.

## Updates

ClawTerm checks for updates automatically once an hour by default. When a new version is available, a dialog appears with the release notes and an **Install** button.

Update behaviour is controlled by the `updates` section in `config.json` — see [configuration.md → updates](../reference/configuration.md#updates) for the full schema. Summary:

- `updates.autoCheck` — turn auto-checking on or off
- `updates.checkIntervalMs` — how often to poll (5 minutes to 24 hours)
- `updates.autoInstall` — silently install updates without prompting

You can also trigger a manual update check from the settings page.

### Re-running the install script

Running the same one-liner again performs an in-place upgrade:

```bash
curl -fsSL https://raw.githubusercontent.com/clawterm/clawterm/main/install.sh | bash
```

If the installed version already matches the latest release, the script exits without doing any work.

## Uninstalling

**macOS:**

```bash
curl -fsSL https://raw.githubusercontent.com/clawterm/clawterm/main/install.sh | bash -s -- --uninstall
```

This removes `/Applications/ClawTerm.app` and prompts before deleting `~/.config/clawterm` (so your config survives unless you say otherwise).

**Windows:**

```powershell
irm https://raw.githubusercontent.com/clawterm/clawterm/main/install.ps1 | iex -ArgumentList '--uninstall'
```

Or uninstall from **Settings → Apps** like any other Windows app. The config at `%APPDATA%\clawterm` is left in place unless you remove it manually.

**Manual cleanup paths:**

| Platform | App | Config |
| --- | --- | --- |
| macOS | `/Applications/ClawTerm.app` | `~/.config/clawterm/` |
| Windows | Uninstalled via Add/Remove Programs | `%APPDATA%\clawterm\` |
| Linux | `/usr/bin/clawterm` (`.deb`) or wherever you placed the `.AppImage` | `~/.config/clawterm/` |
