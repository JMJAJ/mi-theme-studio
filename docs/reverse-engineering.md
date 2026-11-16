# Format and application notes

These notes summarize observations from the two editor packages in the local workspace. They describe file formats and high-level behavior only; no bundled application code or vendor assets are included in this repository.

## Package format

- The sample `.mtz` opens as a ZIP archive.
- Its root contains `description.xml` and `plugin_config.xml`.
- `description.xml` uses a `MIUI-Theme` root with fields such as `title`, `author`, `designer`, `version`, `description`, `uiVersion`, and adapter version.
- Plugin resources are represented as directories of XML/MAML, images, and supporting files. Observed families include icons, clocks, wallpaper, and lock screen resources.
- MAML XML describes screen elements and behaviors, while plugin `manifest.xml` / `description.xml` files describe reusable editor components.

## Editor packages

- The older editor is a Java/SWT application distributed with a JAR, bundled Java runtime, resource catalogs, templates, plugin packs, and Android tooling.
- The newer global editor is an Electron application. Its package exposes distinct renderer bundles for the desktop, template, MAML, nine-patch, wallpaper, preview, and resource browsing flows. The main process creates the windows and routes local file and window operations through IPC.
- The newer package keeps templates and plugin resources outside its application archive, which indicates the editor's UI and the theme payload are separate layers.

## Implications for this editor

Mi Theme Studio treats a theme as an archive of paths and bytes. It uses the XML metadata conventions above for the fields it edits, leaves other resources untouched, and re-exports an archive with the same paths. Rich MAML rendering, Android installation, device pairing, and vendor service integration are outside the current scope.
