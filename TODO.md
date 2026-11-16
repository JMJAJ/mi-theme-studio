# Mi Theme Studio TODO

## Done in the Tauri rewrite

- [x] Tauri v2 + React + TypeScript shell (menus, navigator, explorer, tabs, inspector, dock, status bar, command palette, shortcuts).
- [x] Safe `.mtz`/`.zip` import with limits and unsafe-path reporting; nested component archives expanded.
- [x] Byte-preserving export with verification, atomic writes and backups; package report.
- [x] `description.xml` form editor that preserves unknown fields and comments; XML/text editor; image, font and audio previews.
- [x] Rename/duplicate/move/delete/replace, multi-select, drag to move, drop files from Windows.
- [x] Undo/redo with history; unsaved indicators; recovery copy of unsaved work.
- [x] Validation: XML syntax, image headers, MAML image references, component layout, metadata.
- [x] Local reference packages with copy-to-project and attribution.
- [x] ADB: discovery, device states, details, screenshots (timeout/cancel), confirmed + verified copy to device.
- [x] Browse Theme Manager's cached theme names, authors, component lists and local previews over ADB (read-only).
- [x] Open supported modules from an already cached phone theme as a read-only reference, with title/author metadata and existing copy attribution.
- [x] Theme store: shelves, categories, search, theme details, verified free downloads, apply all or selected parts.

## Online themes and remixing

- [x] Product lists for shelves/subjects (needs Theme Manager's client parameters; see docs/online-catalog.md).
- [x] Theme details with screenshots, description, designer and stats.
- [x] Downloads of free themes, SHA-1 verified; paid themes refused, rights/DRM never bypassed.
- [x] Open supported modules from an already cached Theme Manager theme as a read-only reference with attribution.
- [x] Open a downloaded store theme as a reference, apply selected parts, or open it whole as a new project.
- [ ] Fonts, wallpapers and ringtones from the store (other product types).
- [ ] Extend `.mrc` to MTZ component mapping for more regional resource types and verify licensing terms for reuse/export. The cache reference reads already-present files only; it does not call store download or rights endpoints.
- [x] Search (`/thm/search/v2/npage`, `category=Compound`).

## Device

- [ ] Live screen mirroring (evaluate an optional `scrcpy` integration); today the preview uses screenshots and says so.
- [ ] Investigate supported Theme Manager intents for opening/applying a pushed `.mtz` without root.
- [ ] Apply flow only with explicit confirmation, a way back to the previous theme, and verification on the device.
- [ ] Device-resolution preview of individual resources (e.g. icon masks at the device's density).

## Editor and package quality

- [ ] MAML runtime preview for lock screens, clocks and widgets.
- [ ] Nine-patch editor and stretch-area overlay.
- [ ] Template-based "new component" scaffolds (with user-supplied templates; vendor templates are not bundled).
- [ ] Round-trip checks against representative MIUI and HyperOS sample packages.
- [x] Multi-file find-and-replace across text and XML files (inside component archives too), one undoable change, XML kept well-formed.

## Research notes

- Local reverse-engineering inputs live in the ignored `source/research-inputs/` folder and stay private.
- Catalog findings are summarized in docs/online-catalog.md; device findings in docs/device-integration.md.
