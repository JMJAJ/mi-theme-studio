# Mi Theme Studio TODO

## Online themes and remixing

- [ ] Map the Xiaomi Theme Manager 3.0.5.19 global catalog and download flow from the supplied APK; verify which candidate service calls work in the app.
- [ ] Add an online catalog with search, category filters, cover previews, theme details, and download progress.
- [ ] Keep a downloaded theme open as a separate reference so it never replaces the theme being edited.
- [ ] Let users select and copy images, icons, wallpapers, XML/MAML, and other resources from a reference theme into their project.
- [ ] Preview copied files and resolve path/name conflicts before changing the project.
- [ ] Preserve source theme attribution and metadata where possible; make package ownership and reuse clear.
- [ ] Support local `.mtz` reference themes alongside catalog downloads.

## ADB phone connection and live preview

- [x] Check ADB connectivity: one authorized device is visible; its identifier is not stored in the project.
- [ ] Add a device picker with connect/disconnect state, model, screen resolution, and MIUI/HyperOS version.
- [ ] Show a live phone screen in the editor; compare ADB screen capture streaming with an optional `scrcpy` integration.
- [ ] Add a device preview mode for wallpaper, icons, and lock-screen assets at the phone’s actual resolution.
- [ ] Investigate supported Theme Manager intents/ADB commands for sending and previewing a theme without root.
- [ ] Require confirmation before applying a theme or changing the phone’s active theme; provide a way back to the previous theme.
- [ ] Test the complete connect, preview, send, apply, and recovery flow with the connected Xiaomi phone.

## Editor and package quality

- [ ] Add a MAML preview/runtime for lock screens, clocks, and widgets.
- [ ] Show package compatibility and missing-resource checks before export.
- [ ] Add undo/redo for asset and metadata edits.
- [ ] Add sample-package round-trip checks for representative MIUI and HyperOS themes.

## Research notes

- The supplied Theme Manager APK contains the global Xiaomi theme service host `api.zhuti.intl.xiaomi.com`; its real catalog endpoints, login requirements, and download permissions still need validation.
- All editor implementation files now live in `source/`.
