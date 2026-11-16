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

## Not implemented (intentionally)

- **Applying a theme.** No supported, verified Theme Manager intent or command for installing/applying an `.mtz` from the desktop is known yet. A future implementation needs: a verified flow on current HyperOS, an explicit confirmation, a way back to the previous theme, and verification that the device actually switched. Until then the app only copies the file and tells the user to open it on the phone.
- **Live mirroring.** The preview can refresh screenshots every 5 seconds and labels this as not live. A real mirror (for example an optional `scrcpy` integration) is on the roadmap.
