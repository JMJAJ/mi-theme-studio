# Format and application notes

These notes summarize observations from the editor packages and the Theme Manager APK in the local, ignored `source/` folder. They describe file formats and high-level behavior only; no Xiaomi application code, templates or assets are included in this repository.

## Package format

- An `.mtz` is a ZIP archive. Its root contains `description.xml` and often `plugin_config.xml`.
- `description.xml` uses a `MIUI-Theme` root with simple fields such as `title`, `designer`, `author`, `version`, `uiVersion`, `miuiAdapterVersion`, `description` and `keywords`. Localized variants may appear as repeated elements with attributes.
- Components are stored at the root as **nested ZIP archives without an extension**: `icons`, `lockscreen`, `com.android.systemui`, `framework-res`, `com.android.settings`, `com.miui.home`, per-app overlays such as `com.android.contacts`, and widget/clock components (`clock_*`, `photoframe_*`). The desktop editors keep these as folders while editing and pack them on export.
- Plain folders hold wallpapers (`wallpaper/default_wallpaper.*`, `default_lock_wallpaper.*`), store previews (`preview/`), fonts (`fonts/`), sounds (`ringtones/`) and boot animations (`boots/*.zip`, which must stay uncompressed).
- Inside components, drawables follow Android conventions (`res/drawable-xxhdpi/...`, nine-patch `.9.png`). Icons are named after package or activity names.
- MAML manifests (`manifest.xml`) reference images with `src` attributes; numbered images (`digit.png` → `digit_0.png`…) and expression-based names are resolved at runtime.

## Editor packages

- The older editor is a Java/SWT application with a bundled JRE, resource catalogs, per-version templates (component folders with `configure/page_*.xml` editor pages and preview images), plugin packs and Android tooling.
- The newer global editor is an Electron application with separate renderer bundles for desktop, template, MAML, nine-patch, wallpaper, preview and resource flows; templates and plugin resources sit outside the application archive.

## Theme Manager (global 3.0.5.19)

- The online catalog is an API, not bundled themes. UI/list data comes from `https://api.zhuti.intl.xiaomi.com/app/v9/` (and `/app/v1.9/` for details); marketplace operations use `https://thm.market.intl.xiaomi.com/thm/`.
- Full themes use the resource type `Compound`. Images are served from `https://t17.market.mi-img.com/`.
- Verified anonymous routes and their limits are documented in [online-catalog.md](online-catalog.md).
- Theme Manager keeps downloaded theme records as JSON `.mrm` files under `theme/.data/meta/theme/`, local component modules under `theme/.data/content/<resourceCode>/<localId>.mrc`, local preview images under `theme/.data/preview/theme/<localId>/`, and rights records under `theme/.data/rights/theme/`. Parent metadata includes localized names/authors, product IDs, preview filenames, and subresource IDs. Cached modules may be ZIP component archives or plain image/XML/audio files. The desktop gallery can assemble supported modules already on the phone into an in-memory reference; it leaves device cache files and rights records untouched and does not call store download/rights routes.

## Implications for this editor

Mi Theme Studio treats a theme as a map of paths to bytes with component archives expanded one level. It edits the conventions above, leaves everything else untouched, and writes an archive with the same paths, order and compression. Structural validation reflects these conventions but cannot guarantee installability on a particular MIUI/HyperOS build.
