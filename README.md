# Mi Theme Studio

Mi Theme Studio is a local desktop workspace for browsing and editing Xiaomi MIUI theme packages. It gives the old package-centric workflow a clean asset library, image previews, editable XML metadata, and one-click `.mtz` export.

## What it does

- Opens existing `.mtz` and ZIP packages, or starts a clean theme shell.
- Keeps package files in their existing folders and lets you browse common theme areas.
- Previews image assets, edits XML/MAML/text files, and replaces or removes package files.
- Edits the title, author, designer, version, and description in `description.xml`.
- Adds new files to a category folder and exports the result as an `.mtz` archive.
- Works locally; packages are not uploaded to a service.

The editor focuses on package and resource editing. It does not emulate the MIUI lock screen or install/apply themes to a phone.

## Run from source

Requires Node.js 22.12 or newer.

```sh
npm install
npm start
```

Windows installers are published on the [GitHub Releases page](https://github.com/JMJAJ/mi-theme-studio/releases).

## Package notes

An `.mtz` theme is a ZIP archive. The included editor preserves files and paths, and recognizes common resource folders such as `icons/`, `wallpaper/`, lock screen resources, and system resources. Theme metadata is read from `description.xml`; many packages also contain `plugin_config.xml` and MAML XML resources.

Some theme packages use device-specific formats or conventions. This editor preserves those files, but does not validate that every package is installable on every MIUI/HyperOS version.

## Project contents

The repository contains a fresh implementation. It does not include the bundled Xiaomi applications, their Electron archive, resource catalogs, plugin packs, or extracted assets used during format research.

See [the reverse-engineering notes](docs/reverse-engineering.md) for the format and application structure observations that informed this project.

## License

MIT. See [LICENSE](LICENSE).
