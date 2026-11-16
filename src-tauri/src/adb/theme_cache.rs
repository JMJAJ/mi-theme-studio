//! Read-only inventory of themes already cached by Theme Manager on a device.
//!
//! Theme Manager stores JSON metadata (`.mrm`) and preview images separately
//! from its component archives (`.mrc`). This module reads only the metadata
//! and local preview images. It never reads component payloads or rights data.

use super::{valid_serial, Adb};
use crate::error::{AppError, AppResult};
use crate::package::{blob::is_zip_magic, metadata, paths};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::io::{Cursor, Write};
use std::time::Duration;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const THEME_ROOTS: [&str; 2] = [
    "/sdcard/Android/data/com.android.thememanager/files/MIUI/theme",
    "/sdcard/MIUI/theme",
];
const MAX_THEME_RECORDS: usize = 200;
const MAX_METADATA_BYTES: usize = 256 * 1024;
const MAX_PREVIEW_BYTES: usize = 8 * 1024 * 1024;
const MAX_COMPONENT_BYTES: usize = 64 * 1024 * 1024;
const MAX_THEME_COMPONENT_BYTES: usize = 256 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedTheme {
    pub local_id: String,
    pub online_id: Option<String>,
    pub product_id: Option<String>,
    pub title: String,
    pub author: Option<String>,
    pub designer: Option<String>,
    pub description: Option<String>,
    pub version: Option<String>,
    pub size_bytes: Option<u64>,
    pub updated_time_ms: Option<u64>,
    pub components: Vec<String>,
    pub has_preview: bool,
}

pub struct ThemeReferencePackage {
    pub name: String,
    pub title: String,
    pub archive: Vec<u8>,
    pub warnings: Vec<String>,
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn localized(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(text) = value.as_str().map(str::trim).filter(|s| !s.is_empty()) {
        return Some(text.to_string());
    }
    let map = value.as_object()?;
    ["en_US", "en", "fallback"]
        .iter()
        .find_map(|key| {
            map.get(*key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
        .or_else(|| {
            map.values().find_map(|v| {
                v.as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            })
        })
}

fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn valid_preview_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name.is_ascii()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && ["jpg", "jpeg", "png", "webp"]
            .iter()
            .any(|ext| name.to_ascii_lowercase().ends_with(&format!(".{ext}")))
}

fn preview_names(metadata: &Value) -> Vec<String> {
    let mut names = Vec::new();
    for key in ["builtInThumbnails", "builtInPreviews"] {
        if let Some(locales) = metadata.get(key).and_then(Value::as_object) {
            for locale in ["en_US", "fallback"] {
                if let Some(files) = locales.get(locale).and_then(Value::as_array) {
                    names.extend(
                        files
                            .iter()
                            .filter_map(Value::as_str)
                            .filter(|name| valid_preview_name(name))
                            .map(str::to_string),
                    );
                }
            }
            if names.is_empty() {
                names.extend(
                    locales
                        .values()
                        .filter_map(Value::as_array)
                        .flatten()
                        .filter_map(Value::as_str)
                        .filter(|name| valid_preview_name(name))
                        .map(str::to_string),
                );
            }
        }
    }
    names.sort_by_key(|name| {
        if name.contains("launcher_0") {
            0
        } else if name.contains("lockscreen_0") {
            1
        } else {
            2
        }
    });
    names.dedup();
    names
}

fn record(metadata: &Value, file_id: &str) -> Option<CachedTheme> {
    let local_id = text(metadata, "localId")?;
    if local_id != file_id || !valid_id(&local_id) {
        return None;
    }
    let mut components = metadata
        .get("subResources")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|resource| text(resource, "resourceCode"))
        .filter(|name| {
            !name.is_empty()
                && name.len() <= 128
                && name.is_ascii()
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        })
        .collect::<Vec<_>>();
    components.sort();
    components.dedup();
    let title = localized(metadata.get("titles"))
        .or_else(|| text(metadata, "title"))
        .unwrap_or_else(|| "Untitled theme".into());
    Some(CachedTheme {
        local_id,
        online_id: text(metadata, "onlineId"),
        product_id: text(metadata, "productId"),
        title,
        author: localized(metadata.get("authors")),
        designer: localized(metadata.get("designers")),
        description: localized(metadata.get("descriptions")),
        version: text(metadata, "version"),
        size_bytes: metadata.get("size").and_then(Value::as_u64),
        updated_time_ms: metadata.get("updatedTime").and_then(Value::as_u64),
        components,
        has_preview: !preview_names(metadata).is_empty(),
    })
}

fn read_remote(adb: &Adb, serial: &str, path: &str, limit: usize) -> AppResult<Vec<u8>> {
    valid_serial(serial)?;
    let out = adb.exec(
        &["-s", serial, "exec-out", "cat", path],
        Duration::from_secs(15),
        None,
        true,
    )?;
    let out = adb.expect_ok(out, "read Theme Manager cache file")?;
    if out.stdout.len() > limit {
        return Err(AppError::new(
            "limit",
            "A Theme Manager cache file exceeded the safe read limit.",
        ));
    }
    Ok(out.stdout)
}

fn read_component(adb: &Adb, serial: &str, path: &str) -> AppResult<Vec<u8>> {
    valid_serial(serial)?;
    let out = adb.exec(
        &["-s", serial, "exec-out", "cat", path],
        Duration::from_secs(90),
        None,
        true,
    )?;
    let out = adb.expect_ok(out, "read a cached Theme Manager component")?;
    if out.stdout.len() > MAX_COMPONENT_BYTES {
        return Err(AppError::new(
            "limit",
            "A cached theme component exceeded the 64 MB per-module limit.",
        ));
    }
    Ok(out.stdout)
}

fn parse_metadata(bytes: &[u8]) -> AppResult<Value> {
    serde_json::from_slice(bytes).map_err(|e| {
        AppError::new(
            "device_theme",
            format!("Theme Manager returned invalid cached theme metadata: {e}"),
        )
    })
}

fn theme_root(adb: &Adb, serial: &str) -> AppResult<&'static str> {
    valid_serial(serial)?;
    for root in THEME_ROOTS {
        let meta_dir = format!("{root}/.data/meta/theme");
        match adb.shell(serial, &["test", "-d", &meta_dir], Duration::from_secs(8), None) {
            Ok(_) => return Ok(root),
            // A missing folder fails the test; anything else (adb gone, timeout) is the real problem.
            Err(e) if matches!(e.code, "adb_missing" | "timeout" | "cancelled") => return Err(e),
            Err(_) => {}
        }
    }
    Err(AppError::not_found(
        "Theme Manager's local theme cache was not found on this device. Open Theme Manager and download a theme, then refresh.",
    ))
}

pub fn list(adb: &Adb, serial: &str) -> AppResult<Vec<CachedTheme>> {
    let root = theme_root(adb, serial)?;
    let meta_dir = format!("{root}/.data/meta/theme");
    let listing = adb.shell(
        serial,
        &[
            "find",
            &meta_dir,
            "-maxdepth",
            "1",
            "-type",
            "f",
            "-name",
            "*.mrm",
        ],
        Duration::from_secs(15),
        None,
    )?;
    let mut ids = listing
        .stdout_text()
        .lines()
        .filter_map(|path| path.trim().rsplit('/').next())
        .filter_map(|name| name.strip_suffix(".mrm"))
        .filter(|id| valid_id(id))
        .map(str::to_string)
        .collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    ids.truncate(MAX_THEME_RECORDS);

    let mut themes = Vec::with_capacity(ids.len());
    for id in ids {
        let path = format!("{meta_dir}/{id}.mrm");
        let bytes = match read_remote(adb, serial, &path, MAX_METADATA_BYTES) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        let metadata = match parse_metadata(&bytes) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if let Some(theme) = record(&metadata, &id) {
            themes.push(theme);
        }
    }
    themes.sort_by(|a, b| {
        a.title
            .to_lowercase()
            .cmp(&b.title.to_lowercase())
            .then_with(|| a.local_id.cmp(&b.local_id))
    });
    Ok(themes)
}

pub fn preview(adb: &Adb, serial: &str, local_id: &str) -> AppResult<Vec<u8>> {
    if !valid_id(local_id) {
        return Err(AppError::invalid("Invalid cached theme ID."));
    }
    let root = theme_root(adb, serial)?;
    let meta_path = format!("{root}/.data/meta/theme/{local_id}.mrm");
    let metadata = parse_metadata(&read_remote(adb, serial, &meta_path, MAX_METADATA_BYTES)?)?;
    if text(&metadata, "localId").as_deref() != Some(local_id) {
        return Err(AppError::not_found(
            "That theme is no longer in the device cache.",
        ));
    }
    let names = preview_names(&metadata);
    if names.is_empty() {
        return Err(AppError::not_found(
            "This cached theme has no local preview images.",
        ));
    }
    let mut last_error = None;
    for name in names {
        let path = format!("{root}/.data/preview/theme/{local_id}/{name}");
        match read_remote(adb, serial, &path, MAX_PREVIEW_BYTES) {
            Ok(bytes) if is_image(&bytes) => return Ok(bytes),
            Ok(_) => {
                last_error = Some(AppError::new(
                    "device_theme",
                    "The cached preview is not a supported image.",
                ))
            }
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| AppError::not_found("No cached preview image was available.")))
}

/// Build an in-memory MTZ reference from modules already present in the
/// connected phone's Theme Manager cache. No store or rights endpoint is
/// called, and the device cache is never modified.
pub fn reference_package(
    adb: &Adb,
    serial: &str,
    local_id: &str,
) -> AppResult<ThemeReferencePackage> {
    if !valid_id(local_id) {
        return Err(AppError::invalid("Invalid cached theme ID."));
    }
    let root = theme_root(adb, serial)?;
    let meta_path = format!("{root}/.data/meta/theme/{local_id}.mrm");
    let metadata = parse_metadata(&read_remote(adb, serial, &meta_path, MAX_METADATA_BYTES)?)?;
    if text(&metadata, "localId").as_deref() != Some(local_id) {
        return Err(AppError::not_found(
            "That theme is no longer in the device cache.",
        ));
    }
    let title = localized(metadata.get("titles"))
        .or_else(|| text(&metadata, "title"))
        .unwrap_or_else(|| "Cached theme".into());
    let author = localized(metadata.get("authors")).unwrap_or_default();
    let designer = localized(metadata.get("designers")).unwrap_or_default();
    let version = text(&metadata, "version").unwrap_or_else(|| "1.0".into());
    let ui_version = metadata
        .get("platform")
        .and_then(Value::as_i64)
        .map(|n| n.to_string())
        .unwrap_or_else(|| "14".into());
    let adapter_version = metadata
        .get("miuiAdapterVersion")
        .and_then(Value::as_f64)
        .map(|n| n.to_string())
        .unwrap_or_else(|| "3.0".into());
    let description = localized(metadata.get("descriptions")).unwrap_or_default();
    let description_xml = metadata::update(
        Some(&metadata::default_description_xml(&title)),
        &[
            metadata::FieldUpdate {
                name: "designer".into(),
                value: designer,
            },
            metadata::FieldUpdate {
                name: "author".into(),
                value: author.clone(),
            },
            metadata::FieldUpdate {
                name: "version".into(),
                value: version,
            },
            metadata::FieldUpdate {
                name: "uiVersion".into(),
                value: ui_version,
            },
            metadata::FieldUpdate {
                name: "miuiAdapterVersion".into(),
                value: adapter_version,
            },
            metadata::FieldUpdate {
                name: "description".into(),
                value: description,
            },
        ],
    )?;

    let mut entries = vec![(
        metadata::DESCRIPTION_PATH.to_string(),
        description_xml.into_bytes(),
    )];
    let mut warnings = Vec::new();
    let mut seen = HashSet::new();
    let mut total_bytes = 0usize;
    let modules = metadata
        .get("subResources")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AppError::new(
                "device_theme",
                "The cached theme metadata has no component list.",
            )
        })?;
    for module in modules {
        let Some(code) = text(module, "resourceCode") else {
            continue;
        };
        let Some(module_id) = text(module, "localId") else {
            continue;
        };
        if !valid_id(&module_id) || !valid_resource_code(&code) {
            warnings.push(format!(
                "Skipped a module with an invalid identifier ({code})."
            ));
            continue;
        }
        if package_paths(&code, None).is_empty() {
            warnings.push(format!("Skipped unsupported resource `{code}`."));
            continue;
        }
        let remote_path = format!("{root}/.data/content/{code}/{module_id}.mrc");
        let bytes = match read_component(adb, serial, &remote_path) {
            Ok(bytes) => bytes,
            Err(error) => {
                warnings.push(format!(
                    "`{code}` could not be read from the cache: {}",
                    error.message
                ));
                continue;
            }
        };
        total_bytes = total_bytes.saturating_add(bytes.len());
        if total_bytes > MAX_THEME_COMPONENT_BYTES {
            return Err(AppError::new(
                "limit",
                "The cached theme exceeds the 256 MB total component limit.",
            ));
        }
        let mapped = package_paths(&code, Some(&bytes));
        if mapped.is_empty() {
            warnings.push(format!(
                "Skipped `{code}` because its cached data format is not supported."
            ));
            continue;
        }
        if bytes.is_empty_zip() {
            warnings.push(format!("Skipped empty cached component `{code}`."));
            continue;
        }
        for path in mapped {
            if !seen.insert(path.clone()) {
                warnings.push(format!(
                    "Skipped duplicate package path `{path}` from `{code}`."
                ));
                continue;
            }
            if let Err(issue) = paths::validate_project_path(&path) {
                warnings.push(format!(
                    "Skipped unsafe cache path `{path}`: {}.",
                    issue.describe()
                ));
                continue;
            }
            entries.push((path, bytes.clone()));
        }
    }
    if entries.len() == 1 {
        return Err(AppError::not_found(
            "No usable component archives were available in this cached theme.",
        ));
    }
    let archive = write_reference_archive(entries)?;
    let safe_title: String = title
        .chars()
        .filter(|c| !"\\/:*?\"<>|".contains(*c))
        .collect();
    let name = format!(
        "{} (Theme Manager cache).mtz",
        if safe_title.trim().is_empty() {
            "Cached theme"
        } else {
            safe_title.trim()
        }
    );
    Ok(ThemeReferencePackage {
        name,
        title,
        archive,
        warnings,
    })
}

fn valid_resource_code(code: &str) -> bool {
    !code.is_empty()
        && code.len() <= 128
        && code != "."
        && !code.contains("..")
        && code.is_ascii()
        && code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

fn image_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\xFF\xD8\xFF") {
        Some("jpg")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1A\n") {
        Some("png")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("webp")
    } else {
        None
    }
}

fn package_paths(code: &str, bytes: Option<&[u8]>) -> Vec<String> {
    let Some(bytes) = bytes else {
        return match code {
            "theme" => Vec::new(),
            "wallpaper" | "lockscreen" | "launcher" | "statusbar" | "framework" | "lockstyle"
            | "contact" | "mms" | "icons" | "fonts" | "ringtone" | "notification" | "alarm"
            | "bootaudio" | "bootanimation" | "framework-miui-res" | "miwallpaper" => {
                vec![code.into()]
            }
            "plugin_config.xml" => vec![code.into()],
            _ if valid_resource_code(code)
                && (code.starts_with("clock_")
                    || code.starts_with("photo_frame_")
                    || code.starts_with("photoframe_")
                    || code.contains('.')) =>
            {
                vec![code.into()]
            }
            _ => Vec::new(),
        };
    };
    match code {
        "theme" => Vec::new(),
        "wallpaper" => image_extension(bytes)
            .map(|ext| format!("wallpaper/default_wallpaper.{ext}"))
            .into_iter()
            .collect(),
        "lockscreen" => image_extension(bytes)
            .map(|ext| format!("wallpaper/default_lock_wallpaper.{ext}"))
            .into_iter()
            .collect(),
        "lockstyle" if is_zip_magic(bytes) => vec!["lockscreen".into()],
        "launcher" if is_zip_magic(bytes) => vec!["com.miui.home".into()],
        "statusbar" if is_zip_magic(bytes) => vec!["com.android.systemui".into()],
        "framework" if is_zip_magic(bytes) => vec!["framework-res".into()],
        "contact" if is_zip_magic(bytes) => vec!["com.android.contacts".into()],
        "mms" if is_zip_magic(bytes) => vec!["com.android.mms".into()],
        "fonts" if bytes.starts_with(b"\x00\x01\x00\x00") || bytes.starts_with(b"OTTO") => {
            vec!["fonts/Font.ttf".into()]
        }
        "ringtone" => audio_path("ringtones/ringtone", bytes),
        "notification" => audio_path("ringtones/notification", bytes),
        "alarm" => audio_path("ringtones/alarm", bytes),
        "bootaudio" => audio_path("boots/bootaudio", bytes),
        "bootanimation" if is_zip_magic(bytes) => vec!["boots/bootanimation.zip".into()],
        "plugin_config.xml"
            if bytes.starts_with(b"<?xml") || bytes.starts_with(b"<PluginConfig") =>
        {
            vec![code.into()]
        }
        _ if is_zip_magic(bytes) && valid_resource_code(code) => {
            let target = match code {
                "clock_1x2" | "clock_2x2" | "clock_2x4" | "clock_3x4" => code.to_string(),
                "photoframe_2x2" | "photoframe_2x4" | "photoframe_4x4" => code.to_string(),
                _ => code.to_string(),
            };
            vec![target]
        }
        _ => Vec::new(),
    }
}

fn audio_path(stem: &str, bytes: &[u8]) -> Vec<String> {
    let ext = if bytes.starts_with(b"OggS") {
        "ogg"
    } else if bytes.starts_with(b"ID3") || bytes.starts_with(&[0xFF, 0xFB]) {
        "mp3"
    } else {
        return Vec::new();
    };
    vec![format!("{stem}.{ext}")]
}

trait EmptyZip {
    fn is_empty_zip(&self) -> bool;
}

impl EmptyZip for Vec<u8> {
    fn is_empty_zip(&self) -> bool {
        if !is_zip_magic(self) {
            return false;
        }
        ZipArchive::new(Cursor::new(self))
            .map(|zip| zip.is_empty())
            .unwrap_or(false)
    }
}

fn write_reference_archive(entries: Vec<(String, Vec<u8>)>) -> AppResult<Vec<u8>> {
    let cursor = Cursor::new(Vec::<u8>::new());
    let mut writer = ZipWriter::new(cursor);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    for (path, bytes) in entries {
        writer.start_file(path, options)?;
        writer
            .write_all(&bytes)
            .map_err(|e| AppError::io("Could not compose a read-only theme reference", e))?;
    }
    writer
        .finish()
        .map(|cursor| cursor.into_inner())
        .map_err(Into::into)
}

fn is_image(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\xFF\xD8\xFF")
        || bytes.starts_with(b"\x89PNG\r\n\x1A\n")
        || bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_theme_manager_metadata_without_copying_payload_fields() {
        let id = "d03f91be-d845-44f1-8373-99e4790d3c0f";
        let metadata: Value = serde_json::from_str(&format!(r#"{{
            "localId":"{id}", "onlineId":"online", "productId":"product",
            "titles":{{"en_US":"Samurai","fallback":"Fallback"}},
            "authors":{{"fallback":"Author"}}, "size":1234,
            "subResources":[{{"resourceCode":"icons"}},{{"resourceCode":"launcher"}},{{"resourceCode":"icons"}}],
            "builtInThumbnails":{{"en_US":["en_US_icons_0.jpg","../outside.jpg"]}}
        }}"#)).unwrap();
        let theme = record(&metadata, id).unwrap();
        assert_eq!(theme.title, "Samurai");
        assert_eq!(theme.author.as_deref(), Some("Author"));
        assert_eq!(theme.components, vec!["icons", "launcher"]);
        assert!(theme.has_preview);
        assert_eq!(theme.size_bytes, Some(1234));
    }

    #[test]
    fn rejects_unsafe_ids_and_preview_names() {
        assert!(!valid_id("../theme"));
        assert!(!valid_id("d03f91be-d845-44f1-8373-99e4790d3c0f/../../x"));
        assert!(!valid_preview_name("../secret.jpg"));
        assert!(!valid_preview_name("folder/cover.jpg"));
        assert!(valid_preview_name("en_US_launcher_0.jpg"));
    }

    #[test]
    fn recognizes_jpeg_png_and_webp_previews() {
        assert!(is_image(b"\xFF\xD8\xFF\xE0"));
        assert!(is_image(b"\x89PNG\r\n\x1A\n"));
        assert!(is_image(b"RIFF1234WEBP"));
        assert!(!is_image(b"<html>"));
    }

    #[test]
    fn maps_cached_modules_and_opens_the_generated_reference() {
        let mut component_writer = ZipWriter::new(Cursor::new(Vec::new()));
        component_writer
            .start_file(
                "res/drawable-xhdpi/sample.png",
                SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
            )
            .unwrap();
        component_writer.write_all(b"sample icon bytes").unwrap();
        let component = component_writer.finish().unwrap().into_inner();

        assert_eq!(
            package_paths("launcher", Some(&[0x50, 0x4b, 0x03, 0x04])),
            vec!["com.miui.home"]
        );
        assert_eq!(
            package_paths("wallpaper", Some(b"\xFF\xD8\xFF\xE0")),
            vec!["wallpaper/default_wallpaper.jpg"]
        );
        assert_eq!(package_paths("icons", Some(&component)), vec!["icons"]);

        let archive = write_reference_archive(vec![
            (
                metadata::DESCRIPTION_PATH.into(),
                metadata::default_description_xml("Theme & One").into_bytes(),
            ),
            ("icons".into(), component),
        ])
        .unwrap();
        let project = crate::project::Project::from_bytes(
            &archive,
            "Theme (Theme Manager cache).mtz",
            None,
            crate::package::archive::Limits::default(),
        )
        .unwrap();
        assert_eq!(project.title(), "Theme & One");
        assert!(project.containers.contains_key("icons"));
        assert!(project
            .files
            .contains_key("icons!/res/drawable-xhdpi/sample.png"));
    }
}

/// Lists the phone's cached themes and opens each as a project.
/// `MTS_ADB=<adb.exe> MTS_SERIAL=<serial> cargo test theme_cache::live -- --ignored --nocapture`
#[cfg(test)]
mod live {
    use super::*;
    use crate::package::archive::Limits;
    use crate::project::Project;
    use std::sync::Arc;

    #[test]
    #[ignore]
    fn opens_cached_themes_as_projects() {
        let (Ok(path), Ok(serial)) = (std::env::var("MTS_ADB"), std::env::var("MTS_SERIAL")) else { return };
        let adb = Adb { path: path.into(), log: Arc::new(|_| {}) };
        let themes = list(&adb, &serial).expect("list");
        println!("{} cached themes", themes.len());
        for theme in themes.iter().take(4) {
            let package = reference_package(&adb, &serial, &theme.local_id).expect("package");
            let project = Project::from_bytes(&package.archive, &package.name, None, Limits::default()).expect("project");
            println!("  {} -> {} ({} files, {} warnings)", theme.title, project.title(), project.files.len(), package.warnings.len());
        }
    }
}
