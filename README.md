<div align="center">

<img src="assets/icon.png" alt="Mi Theme Studio" width="112" height="112">

# Mi Theme Studio

**Design, inspect, preview and package MIUI / HyperOS themes on your desktop.**

[![Latest release](https://img.shields.io/github/v/release/JMJAJ/mi-theme-studio?label=release&color=ff6a1a)](https://github.com/JMJAJ/mi-theme-studio/releases/latest)
[![Build](https://img.shields.io/github/actions/workflow/status/JMJAJ/mi-theme-studio/build-windows.yml?label=build)](https://github.com/JMJAJ/mi-theme-studio/actions/workflows/build-windows.yml)
[![Downloads](https://img.shields.io/github/downloads/JMJAJ/mi-theme-studio/total?color=2ea44f)](https://github.com/JMJAJ/mi-theme-studio/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078d4)](#install)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[**Download**](https://github.com/JMJAJ/mi-theme-studio/releases/latest) ·
[Features](#features) ·
[Keyboard shortcuts](#keyboard-shortcuts) ·
[Build from source](#build-from-source) ·
[Documentation](#documentation)

</div>

---

Mi Theme Studio is a desktop editor for `.mtz` theme packages. Open a theme, change its wallpapers, icons, lock screen, fonts and sounds, see the result on a phone frame or on your real phone, and export a package that is verified entry by entry.

Everything runs locally. Packages are edited in memory, saves are atomic and backed up, and files the editor does not understand are written back untouched.

> [!NOTE]
> Mi Theme Studio is an independent, unofficial tool. It is not affiliated with, endorsed by or sponsored by Xiaomi. MIUI, HyperOS and Xiaomi are trademarks of their respective owners.

## Install

1. Open the [latest release](https://github.com/JMJAJ/mi-theme-studio/releases/latest).
2. Download one of:
   - **`Mi Theme Studio_<version>_x64-setup.exe`**: per-user installer, no administrator rights needed.
   - **`Mi Theme Studio_<version>_x64-portable.zip`**: unzip and run `Mi Theme Studio.exe`, no setup.

**Requirements:** Windows 10 or 11 (64-bit) with the WebView2 runtime, which is preinstalled on current Windows. Phone features need USB debugging enabled; a copy of `adb` is bundled.

## Features

### Design

- Every part of a theme (wallpapers, lock screen, icons, home screen, status bar, fonts, clocks, sounds, previews) is a visual card built from the theme's own artwork. Open one to browse, replace or add assets.
- Wallpaper cropping, sound trimming, a nine-patch editor with stretch and padding rulers, and an icon coverage view.
- `description.xml` form editor that preserves comments, field order and unknown fields.
- Undo and redo for every change, with a clickable history and a recovery copy of unsaved work.

### Files

- Full package tree with filters (images, XML, changed, problems), multi-selection, drag to move, and drop from Windows Explorer.
- Editors and viewers for XML and text (CodeMirror, live well-formedness checks), images (fit, zoom, pan), fonts and audio.
- Find and replace across the package.
- Reference packages: open another `.mtz` read-only and copy resources into your theme, with the source recorded in the package report.

### Preview

- Home and lock screen on a phone frame, at your connected phone's resolution or a preset, following the part you are editing.
- Still preview of MAML lock screens, clocks and widgets. It is an approximation, not the phone's runtime.
- Live screen mirroring and screenshots of a connected phone.

### Theme store

- Browse shelves and categories, search, and open any theme for its screenshots, description, designer, tags, size and version.
- Download free themes, fonts, wallpapers and ringtones, verified against the store's SHA-1, into a local library. Paid items are never downloaded and rights protection is never bypassed.
- Apply all or selected parts of a download to your theme as a single undoable change, or open it whole as a new project.

### Phone

- Detects devices over ADB, including unauthorized, offline and multiple-device states, and shows model, HyperOS / MIUI and Android version, resolution and density.
- **Try on phone** places the theme in Theme Manager's local library and applies it, without root. Theme Manager applies wallpapers, lock screen and sounds from locally imported themes; other parts need a license that is only issued for store themes.
- Browse themes already cached on the phone and open them as read-only references.
- Copy a package to the phone after confirmation, verified by file size.

### Check and export

- Validation for XML syntax, image header and extension mismatches, empty files, case collisions, missing MAML image references, component layout and metadata.
- Byte-preserving export: untouched component archives are written back exactly, edited ones are rebuilt, and every save is re-read and verified.
- Markdown package report covering metadata, components, problems and reused resources.

Checks are structural. A clean report does not guarantee that a package installs on a particular device.

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| Command palette | `Ctrl+K` |
| Go to file | `Ctrl+P` |
| Design / Files / Store / Phone / Check | `Ctrl+1` … `Ctrl+5` |
| New theme / Open package | `Ctrl+N` / `Ctrl+O` |
| Save / Save as / Export a copy | `Ctrl+S` / `Ctrl+Shift+S` / `Ctrl+E` |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Y` |
| Find in files | `Ctrl+Shift+F` |
| Validate package | `Ctrl+Shift+B` |
| Try on phone | `Ctrl+Shift+T` |
| Capture device screenshot | `Ctrl+Alt+S` |
| Toggle phone preview | `Ctrl+Alt+P` |
| Zoom in / out / reset | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |
| Settings | `Ctrl+,` |

## Safety

- Packages are decoded in memory with size limits. Unsafe entry paths (`..`, absolute paths, drive letters) are skipped and reported, and nothing is extracted to disk.
- Saves write to a temporary file and rename it into place, after copying the previous file to a backups folder.
- ADB runs only from the native backend, never from the web view, with timeouts and cancellation. Every command is shown in the ADB log.
- Anything that writes to the phone asks for confirmation first.

## Build from source

**Prerequisites:** Node.js 22.12 or newer, Rust (stable, MSVC toolchain), Visual Studio C++ build tools, and the WebView2 runtime.

```sh
git clone https://github.com/JMJAJ/mi-theme-studio.git
cd mi-theme-studio
npm install
npm start            # development: Vite dev server + native app
npm run build:win    # release build: installer and portable zip in release/
```

`npm run build:win` bumps the patch version on every run so the installer always replaces the installed copy. Use `npm run version:bump minor` for a minor bump.

### Tests

```sh
npm run typecheck    # TypeScript
npm test             # frontend unit tests (Vitest)
npm run test:rust    # backend unit tests
```

<details>
<summary>Opt-in live checks</summary>

These are not part of the default test run.

```sh
# Read-only device smoke test: lists devices, reads properties, captures one screenshot in memory
MTS_DEVICE_SMOKE=1 cargo test --manifest-path src-tauri/Cargo.toml --test device_smoke -- --ignored --nocapture

# Round-trips real packages: byte-identical export, reopen, single-edit locality, validation
MTS_SAMPLES="path/to/folder-of-mtz" cargo test --manifest-path src-tauri/Cargo.toml --lib project::samples -- --ignored --nocapture

# Fetches live store pages, search and a theme detail
MTS_STORE_LIVE=1 cargo test --manifest-path src-tauri/Cargo.toml --lib store::tests::live -- --ignored --nocapture
```

</details>

<details>
<summary>UI preview in a browser</summary>

Runs the real UI with Tauri IPC mocked and data exported from a real theme.

```sh
MTS_FIXTURE_IN=path/to/theme.mtz MTS_FIXTURE_OUT=src-tauri/target/ui-fixture cargo test --manifest-path src-tauri/Cargo.toml --lib export_ui_fixture -- --ignored
npx vite --config scripts/ui-preview/vite.config.ts   # http://localhost:5199/scripts/ui-preview/index.html
```

</details>

## Project layout

```
src/                     React + TypeScript UI
  components/shell/      top bar, menus, navigator, phone panel, status bar
  components/explorer/   package tree and reference package panel
  components/views/      design, component grids, editors, preview, store, phone, check
  components/inspector/  properties inspector
  components/dock/       problems, output, ADB log, builds, history
  components/dialogs/    modal dialogs and command palette
  state/                 store (zustand), actions, command registry
  lib/                   typed native API, MAML evaluator, path and formatting helpers
src-tauri/src/           Rust backend
  package/               archive I/O, path safety, blobs, description.xml
  project/               in-memory workspace, undo/redo, classification, snapshots
  validation.rs          structural checks and reports
  storage/               settings, recents, recovery copy, backups, atomic writes
  adb/                   adb discovery, process runner, parsers, device operations
  store/                 theme store client (listings, details, verified downloads)
docs/                    format notes, architecture, device and store notes
```

## Documentation

- [Architecture](docs/architecture.md)
- [Device integration](docs/device-integration.md)
- [Theme store](docs/online-catalog.md)
- [Format notes](docs/reverse-engineering.md)
- [Roadmap](TODO.md)

## Built with

[Tauri 2](https://tauri.app) · [Rust](https://www.rust-lang.org) · [React](https://react.dev) · [TypeScript](https://www.typescriptlang.org) · [CodeMirror](https://codemirror.net) · [scrcpy](https://github.com/Genymobile/scrcpy) (bundled for screen mirroring, Apache-2.0)

## Contributing

Bug reports and pull requests are welcome. Please open an [issue](https://github.com/JMJAJ/mi-theme-studio/issues) first for larger changes, and run `npm run typecheck`, `npm test` and `npm run test:rust` before submitting.

## License

[MIT](LICENSE) © JMJAJ
