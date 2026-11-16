# Mi Theme Studio

Mi Theme Studio is a local desktop studio for creating, inspecting, previewing and packaging MIUI / HyperOS `.mtz` theme packages. It is built with **Tauri v2** (Rust backend) and **React + TypeScript**.

It is an independent, unofficial tool and is not affiliated with Xiaomi.

## What works today

**Packages**
- Opens `.mtz` / `.zip` packages safely: entries are decoded in memory with size limits, unsafe paths (`..`, absolute, drive letters) are skipped and reported, and nothing is extracted to disk.
- Component archives inside the package (`icons`, `lockscreen`, `com.android.systemui`, `framework-res`, boot animation zips, …) are expanded so their files can be browsed and edited.
- Saving keeps every entry's path, order and compression method. Untouched component archives are written back byte-for-byte; edited ones are rebuilt. Files the editor does not understand are preserved.
- Saves are atomic (temp file + rename), re-read and verified entry by entry, and the previous file is copied to a backups folder first.

**Editing**
- Explorer tree with filtering (images, XML, changed, problems), multi-selection, keyboard navigation, context menus, drag-to-move and dropping files from Windows.
- Component views (icons, wallpapers, lock screen, system UI, framework, fonts, sounds, …) with thumbnail grids, density filters and sorting.
- `description.xml` form editor that preserves comments, order and unknown fields; CodeMirror XML/text editor with live well-formedness checks; image viewer with fit/zoom/pan; font and audio previews.
- Rename, duplicate, move, delete, replace, export single files, create component archives, pack a plain folder into a component archive.
- Undo/redo for every change with a clickable history, unsaved-change indicators, and a periodic recovery copy of unsaved work.
- Reference packages: open another `.mtz` read-only and copy resources into your project with conflict handling; the source is recorded in the package report.

**Validation and reports**
- XML syntax, image header/extension mismatches, empty files, case collisions, MAML image references (`src="…"`, including numbered variants), components stored as folders instead of archives, missing metadata.
- Markdown package report (metadata, components, problems, reused resources, limitations).
- Checks are structural and the app says so: a clean report does not guarantee a package installs on a particular device.

**Preview**
- Static home and lock screen mockups built from the package's wallpapers and icons at the connected phone's real resolution (or presets). They are labelled as static mockups: MAML, theme fonts and system UI are not rendered.
- Package `preview/` images.
- Real device screenshots over ADB, labelled with capture time; optional refresh every 5 s, explicitly not a live mirror.

**Device (ADB)** — native backend only, never from the web view
- Finds `adb.exe` (Settings, `ANDROID_HOME`/`ANDROID_SDK_ROOT`, `PATH`, `%USERPROFILE%\Desktop\platform-tools` and similar folders, the default Android SDK location) or lets you choose it.
- Device list with unauthorized / offline / multiple-device states, device details (model, HyperOS/MIUI and Android version, resolution, density, Theme Manager version), screenshots with timeouts and cancellation, and an ADB command log.
- **Themes on device** browses Theme Manager's cached theme names, authors, component lists and local preview images over ADB. Open a cached theme as a read-only reference, then copy selected components into your project with source attribution in the report.
- *Copy package to device* (after explicit confirmation) to `/sdcard/Download/MiThemeStudio/`, verified by comparing file sizes. Installing or applying a theme is **not** automated.

**Theme store**
- Browse Theme Manager's shelves and categories, search, and open any theme for its screenshots, description, designer, tags, size and version.
- Download free themes (verified by SHA-1; paid themes are refused) and keep them in a local library.
- Apply all or selected parts of a downloaded theme (icons, lock screen, wallpapers, system UI, fonts…) to your project as one undoable change, or open the whole theme as a new project.
- The **On device** tab lists themes already cached by Theme Manager on a connected phone, including local preview images. It assembles supported cached modules into an in-memory reference; it does not download themes from the service or change the phone. See [docs/device-integration.md](docs/device-integration.md) and [docs/online-catalog.md](docs/online-catalog.md).

See the in-app **Roadmap** view or [TODO.md](TODO.md) for planned work.

## Run from source

Requirements: Node.js 22.12+, Rust (stable, MSVC toolchain), Visual Studio C++ build tools and the WebView2 runtime (preinstalled on Windows 10/11).

```sh
npm install
npm start            # tauri dev: Vite dev server + native app
npm run build:win    # release build + installer in release/
```

Tests and checks:

```sh
npm run typecheck    # TypeScript
npm test             # frontend unit tests (Vitest)
npm run test:rust    # Rust unit tests: archive safety, round trips, metadata, history, validation, ADB parsing, process timeouts
```

Opt-in live checks (not part of the default test run):

```sh
# read-only device smoke test: lists devices, reads properties, captures one screenshot in memory
MTS_DEVICE_SMOKE=1 cargo test --manifest-path src-tauri/Cargo.toml --test device_smoke -- --ignored --nocapture
# fetches live store pages, search and a theme detail
MTS_STORE_LIVE=1 cargo test --manifest-path src-tauri/Cargo.toml --lib store::tests::live -- --ignored --nocapture
```

Windows installers are built by the GitHub Actions workflow and published on the [Releases page](https://github.com/JMJAJ/mi-theme-studio/releases). The installer is per-user. The first Tauri installer replaces the previous Electron install in its existing per-user folder; later updates reuse the registered Tauri install folder, even if the install-directory page is changed.

## Project layout

```
src/                     React + TypeScript UI
  components/shell/      top bar, menus, navigator, status bar
  components/explorer/   package tree and reference package panel
  components/views/      dashboard, component grids, editors, preview, device, build, catalog, roadmap
  components/inspector/  properties inspector
  components/dock/       problems, output, ADB log, builds, history
  components/dialogs/    modal dialogs and command palette
  state/                 store (zustand), actions, command registry
  lib/                   typed native API, path/tree helpers, formatting, shortcuts
src-tauri/src/           Rust backend
  package/               archive I/O, path safety, blobs, description.xml
  project/               in-memory workspace, undo/redo, classification, snapshots
  validation.rs          structural checks and reports
  storage/               settings, recents, recovery copy, backups, atomic writes
  adb/                   adb discovery, process runner (timeout/cancel), parsers, device operations
  store/                 theme store client (listings, details, verified downloads)
  commands.rs, protocol.rs, state.rs   Tauri commands, `themeres:` preview protocol, app state
docs/                    format notes, architecture, device and catalog notes
```

More detail: [docs/architecture.md](docs/architecture.md), [docs/device-integration.md](docs/device-integration.md), [docs/reverse-engineering.md](docs/reverse-engineering.md).

## Local research inputs

The ignored `source/` folder holds the user's local Xiaomi editor applications, APKs, plugin packs and reverse-engineering inputs. It is private, never packaged and never published; application code lives in the directories above.

## License

MIT. See [LICENSE](LICENSE).
