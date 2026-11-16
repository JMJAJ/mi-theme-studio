# Device integration (ADB)

## Implemented

| Operation | Command(s) | Notes |
|---|---|---|
| Locate adb | — | Settings → `ANDROID_HOME`/`ANDROID_SDK_ROOT` → `PATH` → `%USERPROFILE%\Desktop\platform-tools`, `%USERPROFILE%\OneDrive\Desktop\platform-tools`, `%USERPROFILE%\platform-tools`, `%USERPROFILE%\Downloads\platform-tools` → `%LOCALAPPDATA%\Android\Sdk\platform-tools` → `C:\platform-tools`. The project's `source/` folder is never searched. |
| Device list | `adb devices -l` | Polled every 5 s while the window is visible; routine polls are not logged unless they fail. |
| Details | `shell getprop`, `shell wm size`, `shell wm density`, `shell pm list packages com.android.thememanager`, `shell dumpsys package com.android.thememanager` | Read-only. |
| Screenshot | `exec-out screencap -p` | 25 s timeout, cancellable, PNG signature checked. Kept in memory (last 12) and saved only on request. |
| Copy package | `shell mkdir -p /sdcard/Download/MiThemeStudio`, `push`, `shell stat -c %s` | Requires an explicit confirmation in the UI and `confirmed: true` in the native command. Success is reported only when the remote size matches. |
| Restart server | `kill-server`, `start-server` | |

All commands run through `src-tauri/src/adb/runner.rs` (timeouts, cancellation, bounded output, no console window). Error text such as `unauthorized`, `offline` or `more than one device` is mapped to actionable messages.

Verified on 2026-11-16 against a connected Xiaomi device (HyperOS 3, Android 16) with the opt-in smoke test (`MTS_DEVICE_SMOKE=1 cargo test --test device_smoke -- --ignored`). No device identifiers are stored in the repository.

## Theme Manager cache browser

The **Online themes → On device** tab browses themes already cached on the selected phone. It reads Theme Manager's `.data/meta/theme/*.mrm` JSON records and `.data/preview/theme/<localId>/` images through `adb exec-out cat`. The current app-specific path is `/sdcard/Android/data/com.android.thememanager/files/MIUI/theme`; the legacy `/sdcard/MIUI/theme` path is also checked.

**Open as reference** reads supported `.mrc` modules that are already in the Theme Manager cache and assembles them into a temporary in-memory MTZ view. It maps known resource codes to common MTZ paths, preserves theme title and author, and warns about missing or unsupported modules. The reference stays read-only; selected files can be copied into the active project through the existing attribution workflow. This does not modify the phone, call store download or rights endpoints, or read/change `.mra` rights records. Unknown resource types still need mapping work.

## Applying themes and opening Theme Manager

Findings (Theme Manager global 3.0.5.19, verified read-only on a HyperOS 3.0 / Android 16 phone):

- **Xiaomi's desktop editor** applies themes by pushing the package and starting `com.android.thememanager/com.android.thememanager.ApplyThemeForScreenshot` with `-e api_called_from ThemeEditor -e theme_file_path <path>`. Builds that declare `com.android.thememanager.support3.0` use a two-step flow: remove `/sdcard/Download/auto/temp.mtz`, start with `-e ver2_step ver2_step_init`, wait a second, push to `/sdcard/Android/data/com.android.thememanager/files/temp.mtz`, start again with `-e ver2_step ver2_step_apply`. Older builds push to `/sdcard/temp.mtz` and start once.
- **That activity is not in the global build.** `cmd package resolve-activity --components -n …ApplyThemeForScreenshot` returns "No activity found" and the support marker is absent, so desktop apply is not possible there.
- **Deep links** (`theme://zhuti.xiaomi.com/…`) are exported and resolve: `/detail/<moduleId>` (store item page), `/settingstheme`, `/settingsfont`, `/settingswallpaper`, `/search`, `/uipages/…`. `ViewLocalResource://view.local.resource#<localId>` opens an already-imported theme by Theme Manager's own local ID, not by file path.
- Local imports go through `theme/.data/import/theme/` pairs of metadata records written by Theme Manager itself; the app does not fabricate those.

What the app does:

- **Device → Apply on phone** is shown only when `ApplyThemeForScreenshot` resolves. It asks for confirmation, exports the project, runs the flow above with a verified push, then takes a screenshot so the result can be checked. The previous theme stays installed and can be re-applied from Theme Manager → My themes; the app does not try to switch back automatically (that would need Theme Manager's private state). On builds without the entry point the button is disabled and explained. The apply flow follows Xiaomi's tool but has not been exercised on a phone that supports it.
- **Open Theme Manager on phone** and, in the store, **Open in Theme Manager on phone** start the deep links above. Paid themes can be bought there.
- Support detection is read-only: `dumpsys package com.android.thememanager` and `cmd package resolve-activity`.

## Not implemented (intentionally)

- **Live mirroring** is implemented with the bundled scrcpy (see below).

## Live mirroring

The installer bundles scrcpy 3.3.1 (Genymobile, Apache-2.0; FFmpeg/libusb LGPL, SDL zlib), fetched by `scripts/fetch-scrcpy.mjs` from the official release and checked against a pinned SHA-256. **Mirror screen** (Device page, Preview, Device menu) starts it for the selected phone with `--serial <serial> --stay-awake --no-audio --max-fps 60` and `ADB=<the app's adb>`, so only one adb server version runs. The mirror window is interactive. Its output goes to the ADB log; it is closed with **Stop mirroring** or when the app exits. The bundled `adb.exe` is also the last adb candidate, so the app works without a separate platform-tools install.
