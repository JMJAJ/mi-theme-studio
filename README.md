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
[FAQ](#faq) ·
[Keyboard shortcuts](#keyboard-shortcuts) ·
[Build from source](#build-from-source) ·
[Documentation](#documentation)

</div>

---

Mi Theme Studio is a free, open-source **MIUI and HyperOS theme editor** for Windows: a theme maker and `.mtz` file editor for **Xiaomi, Redmi and POCO** phones. Open a theme, change its wallpapers, icons, lock screen, fonts and sounds, see the result on a phone frame or on your real phone, and export a package that is verified entry by entry.

Everything runs locally. Packages are edited in memory, saves are atomic and backed up, and files the editor does not understand are written back untouched.

> [!IMPORTANT]
> **Phone support.** Full customization on rooted phones is the stable path. On normal (non-rooted) phones, a whole theme can be applied through Theme Manager's own editor entry point when the phone's factory build has it. The experimental **Permanent apply (AOD)** path works on one HyperOS 3 / Android 16 phone for theme files, wallpaper and MAML lock screen. On Theme Manager 3.0.5.19, its calls to regenerate customized icons do not reliably populate the customized icon cache, and the launcher's private home-clock cache is not rebuilt reliably, so icons and clock may remain stock. A `.19` update installed after applying through Theme Manager 3.0.5.16 can retain the launcher state created by `.16`; that does not show that a clean `.19` AOD apply generated it. The AOD path needs ADB, `com.miui.aod`, the AOD settings provider and always-on display, and deliberately blocks the framework's periodic validation. It is not a Xiaomi-supported API and has not been tested across Xiaomi's whole range. The app checks the provider and asks for explicit confirmation before changing the phone. Designing, editing and exporting themes on your PC works the same either way.

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
- The MAML Guide's **Try it** page can use live weather from a connected phone, or an online weather lookup when the phone does not share it.
- Live screen mirroring and screenshots of a connected phone.

### Theme store

- Browse shelves and categories, search, and open any theme for its screenshots, description, designer, tags, size and version.
- Download free themes, fonts, wallpapers and ringtones, verified against the store's SHA-1, into a local library. Paid items are never downloaded, and store entitlements are never granted or transferred. The optional permanent AOD apply is a separate local-validation workaround for a theme you already have; it is not a store licence.
- Apply all or selected parts of a download to your theme as a single undoable change, or open it whole as a new project.

### Phone

- Detects devices over ADB, including unauthorized, offline and multiple-device states, and shows model, HyperOS / MIUI and Android version, resolution and density.
- **Rooted phones: full customization.** Every part of the theme is applied, including icons, system UI, fonts and lock screen, with a backup you can restore.
- **Normal phones (work in progress).** **Try on phone** places the theme in Theme Manager's local library and applies it, without root. Theme Manager applies wallpapers, lock screen and sounds from locally imported themes; other parts need a licence that Xiaomi only issues for unmodified store themes, so they may be refused.
- **Non-root one-click apply.** When Theme Manager has its editor entry point (`ApplyThemeForScreenshot`, the one Xiaomi's desktop theme editor uses), the whole package is applied directly. Some store updates removed it; **Enable non-root apply** removes Theme Manager's update with Android's package manager so the factory build already on the phone is used again. No root, no APK patching. This **clears Theme Manager's app data**: imported and downloaded themes disappear from My themes (store purchases stay on your Xiaomi account and can be downloaded again), and the app asks before doing it. A later store update removes the entry point again until you re-run it. Phones whose factory build lacks the entry point are reported as unsupported for this path.
- **Permanent apply (AOD), experimental.** For setups where the editor entry point is unavailable, this writes theme files and a sticky validation blocker through the AOD/System UI MAML path. On a build with the editor entry point the real theme files are applied first; otherwise the package is extracted to `/data/local/tmp`, every real top-level file is copied into `/data/system/theme`, and the wallpaper is set through `WallpaperManager`. The AOD manifest calls `IconCustomizer`, but on the `.19` AOD-only path those calls did not populate `/data/system/theme_magic/customized_icons`; the launcher's private home-clock cache is not rebuilt reliably either. So files being present on disk does not mean home icons and clock changed. The confirmed `.19`-only result is theme files, wallpaper and MAML lock screen; icons and home clock may remain stock. It also installs the theme's MAML lockscreen (`lockscreen`/`lockstyle` archive), sets the lock wallpaper type to `maml`, and updates `lock.xml`; one reboot is required so the wallpaper service loads the MAML lockscreen. It then sends the framework configuration change and `ACTION_THEME_CHANGED`, restarts System UI and the launcher, and installs the sticky boot-animation blocker. The blocker makes `ThemeReceiver`'s 2-hour validation hang at `/data/system/theme/boots/bootanimation.zip -> /dev/input/event0` instead of restoring the default theme. No root, no APK patching. It requires USB debugging, `com.miui.aod`, shell-writable secure settings and always-on display. On the test phone, Theme Manager 3.0.5.16 applied all three visual parts; a `.19` update installed afterward retained that `.16`-created state. That is not a clean `.19` AOD success. The real 2-hour validation on `.19` is still being checked. It mutates `/data/system/theme` and AOD settings, and leaves a validation worker blocked; **Remove AOD blocker** restores the AOD category and asks AOD to remove the sticky blocker. Use only with themes you own or are authorized to use.
- **Force apply (non-root).** Theme Manager skips parts (system UI, Settings, status bar, AOD, overlays) when the theme declares an older `uiVersion` than the part needs. Force apply raises the `uiVersion` of the copy sent to the phone to the newest format the phone renders, so every part is copied. The project file is never changed. Parts made for another format can render wrong; go back from Themes → My themes. Hidden on rooted phones, which already get every part.
- Non-root apply checks the cases that cannot work and says so instead of failing silently: Second space or another active user, Theme Manager's storage folder not created yet, and Theme Manager falling back to the file picker.
- Compares the theme's format with the phone's (`theme_compatibility.xml`) and warns before applying a theme made for a newer system, in the store, on the Phone page and on Try on phone.
- Browse themes already cached on the phone and open them as read-only references.
- Copy a package to the phone after confirmation, verified by file size.

#### Supported Theme Manager versions

Standard non-root apply and Force apply depend on Theme Manager's editor entry point. **Permanent apply (AOD)** is a separate experimental path that does not use that activity; it depends on the phone's AOD provider instead. The app checks the editor entry point before standard apply, and checks the AOD provider before changing anything for the permanent path.

| Theme Manager | Standard non-root apply | Permanent AOD |
| --- | --- | --- |
| 3.0.5.16-global | ✅ Verified | ✅ Verified on the test phone through Theme Manager |
| 3.0.5.19-global update installed after a `.16` apply | ❌ No entry point | ⚠️ AOD writes files, wallpaper and lock screen; any visible icons/home clock can be inherited from `.16` caches |
| Factory build 3.0.5.19-global or later | ❌ No entry point; Android rejects a downgrade below the factory version without root | ⚠️ AOD files, wallpaper and lock screen; icons/home clock are not reliably prepared. Factory-image device not physically tested |
| China builds | ⚠️ Untested | ⚠️ Untested |
| Older global builds (MIUI 14 and earlier) | ⚠️ Untested | ⚠️ Untested |

### Preserving an applied theme when updating to 3.0.5.19

If the phone is still on the factory **3.0.5.16** build, apply the theme there through Theme Manager first, then install the 3.0.5.19 update over it. The update keeps `/data/system/theme`, `/data/system/theme_magic`, `lock.xml`, the MAML lockscreen and launcher caches built by `.16`. Do not reapply after the update; keep the blocker or the AOD keep-alive so the 2-hour check does not reset the theme. This is the verified non-root route on this phone for lockscreen, home icons and home clock across the update. A clean `.19` AOD-only apply has not achieved the icons and home clock. Settings/System UI still obey the theme-format limits below.

Theme packages also declare a `uiVersion`. A theme made for older MIUI (for example `uiVersion` 15) may provide Settings, System UI, status-bar or clock archives that HyperOS 3 applications no longer load. The files are copied and the theme-change sequence is sent, but those old parts remain stock. This is a theme compatibility limit; it is not fixed by root or by the AOD path.

Rooted phones apply every part, whatever the Theme Manager version. If you test another version, please open an issue with your phone model, HyperOS / MIUI version and Theme Manager version (Settings → Apps → Themes).

### Check and export

- Validation for XML syntax, image header and extension mismatches, empty files, case collisions, missing MAML image references, component layout and metadata.
- Byte-preserving export: untouched component archives are written back exactly, edited ones are rebuilt, and every save is re-read and verified.
- Markdown package report covering metadata, components, problems and reused resources.

Checks are structural. A clean report does not guarantee that a package installs on a particular device.

## FAQ

**How do I open or edit an `.mtz` file?**
An `.mtz` file is a MIUI / HyperOS theme package (a ZIP archive with nested component archives). Open it in Mi Theme Studio with `Ctrl+O`, edit any part, and save. Untouched parts are written back byte for byte.

**Can I make my own Xiaomi theme from scratch?**
Yes. `Ctrl+N` creates a new theme, or you can start from a free theme downloaded from the built-in store and change it.

**Does it work with both MIUI and HyperOS themes?**
It reads and writes the shared `.mtz` format used by MIUI and HyperOS, and warns when a theme was made for a newer system than your phone (`theme_compatibility.xml`).

**Do I need root to apply a theme?**
Rooted phones get every part applied. On normal phones, the whole theme can be applied without root if the phone's factory Theme Manager build has the editor entry point (**Enable non-root apply**, then **Try on phone** or **Force apply**). If it does not, the experimental **Permanent apply (AOD)** can work on supported phones (the app checks for `com.miui.aod`, the settings provider and writable secure settings). Otherwise wallpapers, lock screens and sounds work through Theme Manager and other parts may be refused. The AOD path is device-specific, leaves AOD on a custom category and should be removed with **Remove AOD blocker** before switching approaches.

**Does it work on macOS or Linux?**
Not yet; current releases are Windows 10 / 11 only.

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
- **Permanent apply (AOD) is invasive.** It is a confirmed, experimental operation that writes `/data/system/theme`, changes AOD secure settings and leaves a sticky boot-animation symlink to `/dev/input/event0`. That intentionally makes the framework's 2-hour validation worker block, which can affect system responsiveness and battery until the blocker is removed. It also relies on a device-specific AOD provider and is not a universal Xiaomi supported API. Use it only on a phone you own or are authorized to modify, and keep **Remove AOD blocker** available.

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

- [Lock screen & widget guide (MAML)](docs/maml/README.md): formulas, date formats, variables, recipes, with pictures
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
