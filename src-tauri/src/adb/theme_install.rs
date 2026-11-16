//! "Try on phone": put a theme package into Theme Manager's local library and
//! apply it, without root.
//!
//! Theme Manager keeps imported themes as plain files in its external data
//! folder (`MIUI/theme/.data`): a JSON record per theme and per part under
//! `meta/<code>/<id>.mrm`, the raw part under `content/<code>/<id>.mrc`, and
//! preview images under `preview/theme/<id>/`. The adb shell user may write
//! there (group `ext_data_rw`). We write the same records Theme Manager's own
//! importer produces, open the theme's page with the exported
//! `ViewLocalResource://view.local.resource#<id>` link, and press its Apply
//! button through uiautomator. Theme Manager then applies the theme itself.
//!
//! Earlier try-ons are marked with `"mtsTryOn": true` (ignored by Theme
//! Manager) and removed before a new one is written, so the library holds at
//! most one.

use super::{valid_serial, Adb};
use crate::error::{AppError, AppResult};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io::{Cursor, Read};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use zip::ZipArchive;

pub const LIBRARY_ROOT: &str = "/sdcard/Android/data/com.android.thememanager/files/MIUI/theme/.data";
const MARKER: &str = "mtsTryOn";
const APPLY_BUTTON_ID: &str = "com.android.thememanager:id/applyBtn";
const MAX_PART_BYTES: u64 = 128 * 1024 * 1024;

/// Parts Theme Manager applies without a Xiaomi-issued license
/// (`ThemeResourceConstants.kB`). Everything else (icons, lock screen,
/// system UI, fonts…) needs a signed rights file that Xiaomi's server only
/// issues for unmodified store themes.
pub const LICENSE_FREE_PARTS: [&str; 7] = ["audioeffect", "wallpaper", "lockscreen", "ringtone", "alarm", "notification", "bootaudio"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TryOnResult {
    pub local_id: String,
    pub parts: Vec<String>,
    pub bytes: u64,
    /// True when Apply was pressed and Theme Manager finished applying.
    pub applied: bool,
    pub steps: Vec<String>,
}

/// Theme Manager's importer table (`ThemeResourceConstants` / `utils.e`):
/// package path → resource code. Other top-level files keep their own name.
fn code_for(path: &str) -> Option<&'static str> {
    Some(match path {
        "ringtones/alarm.mp3" | "ringtones/alarm.ogg" => "alarm",
        "boots/bootanimation.zip" => "bootanimation",
        "boots/bootaudio.mp3" | "boots/bootaudio.ogg" => "bootaudio",
        "com.android.contacts" => "contact",
        "fonts/Roboto-Regular.ttf" | "Font.ttf" | "fonts/DroidSans.ttf" | "fonts/Arial.ttf" | "fonts/Font.ttf" => "fonts",
        "fonts/DroidSansFallback.ttf" | "FontFallback.ttf" => "fonts_fallback",
        "framework-res" => "framework",
        "com.miui.home" => "launcher",
        "wallpaper/default_lock_wallpaper.jpg" | "wallpaper/default_lock_wallpaper.png" | "wallpaper/default_lock_wallpaper.webp" => "lockscreen",
        "lockscreen" => "lockstyle",
        "com.android.mms" => "mms",
        "ringtones/notification.mp3" | "ringtones/notification.ogg" => "notification",
        "ringtones/ringtone.mp3" | "ringtones/ringtone.ogg" => "ringtone",
        "com.android.systemui" => "statusbar",
        "wallpaper/default_wallpaper.jpg" | "wallpaper/default_wallpaper.png" | "wallpaper/default_wallpaper.webp" => "wallpaper",
        _ => return None,
    })
}

fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('.')
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

/// The resource code a package entry is stored under, if Theme Manager imports it.
pub fn resource_code(path: &str) -> Option<String> {
    if let Some(code) = code_for(path) {
        return Some(code.into());
    }
    (!path.contains('/') && path != "description.xml" && safe_name(path)).then(|| path.to_string())
}

/// A random version-4 UUID (Theme Manager's local ID format).
pub fn new_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut bytes = [0u8; 16];
    for (i, chunk) in bytes.chunks_mut(8).enumerate() {
        let mut h = RandomState::new().build_hasher();
        h.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        h.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
        h.write_usize(i);
        chunk.copy_from_slice(&h.finish().to_le_bytes());
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

fn related(id: &str, code: &str) -> Value {
    json!({ "localId": id, "resourceCode": code, "extraMeta": {}, "metaPath": null, "contentPath": null })
}

fn record(id: &str, title: &str, author: &str, description: &str, hash: &str, size: u64, now: u64) -> Value {
    json!({
        "localId": id, "onlineId": null, "assemblyId": null, "productId": null,
        "hash": hash, "platform": 17, "size": size, "updatedTime": now, "version": "1.0",
        "authors": { "fallback": author }, "designers": { "fallback": author },
        "titles": { "fallback": title }, "descriptions": { "fallback": description },
        "builtInThumbnails": {}, "builtInPreviews": {}, "thumbnails": [], "previews": [],
        "parentResources": [], "subResources": [], "extraMeta": {},
        "metaPath": null, "contentPath": null, "rightsPath": null,
        "screenRatio": null, "fontWeight": null, "miuiAdapterVersion": 3.2, "wallpaperStyle": 0,
        MARKER: true,
    })
}

fn to_json(value: &Value) -> Vec<u8> {
    serde_json::to_vec_pretty(value).unwrap_or_default()
}

fn sha1_hex(data: &[u8]) -> String {
    sha1_smol::Sha1::from(data).digest().to_string()
}

/// Writes the library records for `package` into `stage` (laid out like
/// `.data`). Returns the theme ID and the part codes.
pub fn stage_library(package: &[u8], title: &str, author: &str, stage: &Path, license_free_only: bool) -> AppResult<(String, Vec<String>)> {
    let io = |e: std::io::Error| AppError::io("Could not stage the theme for the phone", e);
    let mut zip = ZipArchive::new(Cursor::new(package))?;
    let theme_id = new_id();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let mut theme = record(&theme_id, title, author, "Sent from Mi Theme Studio", &sha1_hex(package), package.len() as u64, now);
    let mut subs = Vec::new();
    let mut codes = Vec::new();
    let mut previews: std::collections::BTreeMap<String, Vec<String>> = Default::default();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        if entry.is_dir() || entry.size() > MAX_PART_BYTES {
            continue;
        }
        let name = entry.name()?.to_string();
        if let Some(file) = name.strip_prefix("preview/") {
            if !safe_name(file) {
                continue;
            }
            let dir = stage.join("preview/theme").join(&theme_id);
            std::fs::create_dir_all(&dir).map_err(io)?;
            let mut data = Vec::new();
            entry.read_to_end(&mut data).map_err(io)?;
            std::fs::write(dir.join(file), data).map_err(io)?;
            let locale = file.split('_').take(2).collect::<Vec<_>>().join("_");
            let key = if locale.len() == 5 && locale.as_bytes()[2] == b'_' { locale } else { "fallback".into() };
            previews.entry(key).or_default().push(file.to_string());
            continue;
        }
        let Some(code) = resource_code(&name) else { continue };
        if license_free_only && !LICENSE_FREE_PARTS.contains(&code.as_str()) {
            continue;
        }
        if codes.contains(&code) {
            continue;
        }
        let mut data = Vec::new();
        entry.read_to_end(&mut data).map_err(io)?;
        let id = new_id();
        let mut part = record(&id, title, author, "", &sha1_hex(&data), data.len() as u64, now);
        part["parentResources"] = json!([related(&theme_id, "theme")]);
        for (dir, file, bytes) in [("content", format!("{id}.mrc"), data), ("meta", format!("{id}.mrm"), to_json(&part))] {
            let folder = stage.join(dir).join(&code);
            std::fs::create_dir_all(&folder).map_err(io)?;
            std::fs::write(folder.join(file), bytes).map_err(io)?;
        }
        subs.push(related(&id, &code));
        codes.push(code);
    }
    if codes.is_empty() {
        return Err(AppError::invalid(if license_free_only {
            "The theme has no wallpapers or sounds to try on."
        } else {
            "The theme has no parts Theme Manager can apply."
        }));
    }
    theme["subResources"] = Value::Array(subs);
    if !previews.is_empty() {
        theme["builtInPreviews"] = json!(previews);
        theme["builtInThumbnails"] = json!(previews);
    }
    for (dir, file, bytes) in [("meta", format!("{theme_id}.mrm"), to_json(&theme)), ("content", format!("{theme_id}.mrc"), Vec::new())] {
        let folder = stage.join(dir).join("theme");
        std::fs::create_dir_all(&folder).map_err(io)?;
        std::fs::write(folder.join(file), bytes).map_err(io)?;
    }
    Ok((theme_id, codes))
}

/// `[x1,y1][x2,y2]` → centre point.
fn center(bounds: &str) -> Option<(i32, i32)> {
    let nums: Vec<i32> = bounds.split(|c: char| !c.is_ascii_digit()).filter(|s| !s.is_empty()).filter_map(|s| s.parse().ok()).collect();
    (nums.len() == 4).then(|| ((nums[0] + nums[2]) / 2, (nums[1] + nums[3]) / 2))
}

/// Finds a node by resource ID in a uiautomator dump and returns its centre.
pub fn find_node(xml: &str, resource_id: &str) -> Option<(i32, i32)> {
    let needle = format!("resource-id=\"{resource_id}\"");
    let at = xml.find(&needle)?;
    let start = xml[..at].rfind("<node")?;
    let end = at + xml[at..].find('>')?;
    let node = &xml[start..end];
    let b = node.find("bounds=\"")? + 8;
    center(&node[b..b + node[b..].find('"')?])
}

/// Like [`find_node`] but only when the node is enabled.
pub fn enabled_node(xml: &str, resource_id: &str) -> Option<(i32, i32)> {
    let needle = format!("resource-id=\"{resource_id}\"");
    let at = xml.find(&needle)?;
    let start = xml[..at].rfind("<node")?;
    let end = at + xml[at..].find('>')?;
    if xml[start..end].contains("enabled=\"false\"") {
        return None;
    }
    find_node(xml, resource_id)
}

/// Theme Manager logs `DownloadRightsTask return: <code>`; anything but
/// 100000 means the license request failed. Returns the server's code.
pub fn refused_license(log: &str) -> Option<String> {
    let failed = log.lines().any(|l| l.split("DownloadRightsTask return: ").nth(1).is_some_and(|c| c.trim() != "100000"));
    if !failed {
        return None;
    }
    let code = log
        .lines()
        .rev()
        .find_map(|l| l.split("downloadRights, resultCode=").nth(1))
        .map(|c| c.trim().to_string())
        .unwrap_or_else(|| "an error".into());
    Some(code)
}

impl Adb {
    fn device_time(&self, serial: &str) -> Option<String> {
        // adb joins arguments with spaces, so the format is quoted as one shell word.
        let out = self.shell(serial, &["date '+%m-%d %H:%M:%S.000'"], Duration::from_secs(10), None).ok()?;
        let t = out.stdout_text().trim().to_string();
        let ok = t.len() == 18 && t.bytes().all(|b| b.is_ascii_digit() || b" -:.".contains(&b));
        ok.then_some(t)
    }

    /// Whether Theme Manager's license request failed since `since` (device time).
    fn license_refused(&self, serial: &str, since: &str) -> Option<String> {
        let command = format!("logcat -d -t '{since}' -s ThemeDebug:I DrmService:I");
        let out = self.shell(serial, &[&command], Duration::from_secs(10), None).ok()?;
        refused_license(&out.stdout_text())
    }

    /// Modification time of the active theme folder (seconds).
    fn theme_stamp(&self, serial: &str) -> Option<String> {
        let out = self.shell(serial, &["stat", "-c", "%Y", "/data/system/theme", "/data/system/theme/config.config"], Duration::from_secs(10), None).ok()?;
        Some(out.stdout_text().split_whitespace().collect::<Vec<_>>().join(" "))
    }

    fn ui_dump(&self, serial: &str) -> AppResult<String> {
        let out = self.shell(
            serial,
            &["uiautomator dump /sdcard/mts-ui.xml >/dev/null 2>&1; cat /sdcard/mts-ui.xml; rm -f /sdcard/mts-ui.xml"],
            Duration::from_secs(20),
            None,
        )?;
        Ok(out.stdout_text())
    }

    /// Removes earlier try-on themes (and their parts) from Theme Manager's library.
    fn remove_previous_try_ons(&self, serial: &str) -> usize {
        let Ok(out) = self.shell(serial, &["grep", "-l", &format!("\"{MARKER}\""), "-r", &format!("{LIBRARY_ROOT}/meta/theme")], Duration::from_secs(15), None) else {
            return 0;
        };
        let mut removed = 0;
        for path in out.stdout_text().lines().map(str::trim).filter(|l| l.ends_with(".mrm")) {
            let Ok(bytes) = self.shell(serial, &["cat", path], Duration::from_secs(10), None) else { continue };
            let Ok(meta) = serde_json::from_str::<Value>(&bytes.stdout_text()) else { continue };
            if meta.get(MARKER) != Some(&Value::Bool(true)) {
                continue;
            }
            let Some(id) = meta.get("localId").and_then(Value::as_str).filter(|id| safe_name(id)) else { continue };
            let mut targets = vec![
                format!("{LIBRARY_ROOT}/meta/theme/{id}.mrm"),
                format!("{LIBRARY_ROOT}/content/theme/{id}.mrc"),
                format!("{LIBRARY_ROOT}/preview/theme/{id}"),
            ];
            for sub in meta.get("subResources").and_then(Value::as_array).into_iter().flatten() {
                let (Some(sid), Some(code)) = (sub.get("localId").and_then(Value::as_str), sub.get("resourceCode").and_then(Value::as_str)) else { continue };
                if safe_name(sid) && safe_name(code) {
                    targets.push(format!("{LIBRARY_ROOT}/meta/{code}/{sid}.mrm"));
                    targets.push(format!("{LIBRARY_ROOT}/content/{code}/{sid}.mrc"));
                }
            }
            let mut args = vec!["rm", "-rf"];
            args.extend(targets.iter().map(String::as_str));
            if self.shell(serial, &args, Duration::from_secs(15), None).is_ok() {
                removed += 1;
            }
        }
        removed
    }

    /// Installs `package` into Theme Manager's library and applies it.
    pub fn try_on(
        &self,
        serial: &str,
        package: &[u8],
        title: &str,
        stage: &Path,
        license_free_only: bool,
        cancel: Option<Arc<AtomicBool>>,
    ) -> AppResult<TryOnResult> {
        valid_serial(serial)?;
        let cancelled = || cancel.as_ref().is_some_and(|c| c.load(Ordering::Relaxed));
        let mut steps = Vec::new();
        self.shell(serial, &["test", "-d", LIBRARY_ROOT], Duration::from_secs(10), None).map_err(|_| {
            AppError::not_found("Theme Manager's theme library was not found on this phone. Open Theme Manager once, then try again.")
        })?;

        let _ = std::fs::remove_dir_all(stage);
        std::fs::create_dir_all(stage).map_err(|e| AppError::io("Could not prepare the staging folder", e))?;
        let (local_id, parts) = stage_library(package, title, "Mi Theme Studio", stage, license_free_only)?;
        steps.push(format!("Prepared {} parts: {}", parts.len(), parts.join(", ")));

        let removed = self.remove_previous_try_ons(serial);
        if removed > 0 {
            steps.push(format!("Removed {removed} earlier try-on from Theme Manager"));
        }
        let local = format!("{}{}.", stage.display(), std::path::MAIN_SEPARATOR);
        let out = self.exec(&["-s", serial, "push", &local, &format!("{LIBRARY_ROOT}/")], Duration::from_secs(300), cancel.clone(), false)?;
        self.expect_ok(out, "adb push")?;
        let _ = std::fs::remove_dir_all(stage);
        steps.push(format!("Copied the theme into Theme Manager's library ({} bytes)", package.len()));
        if cancelled() {
            return Err(AppError::new("cancelled", "The operation was cancelled."));
        }

        // Theme Manager reads its library on start; restart it so it sees the new theme.
        let _ = self.shell(serial, &["input", "keyevent", "KEYCODE_WAKEUP"], Duration::from_secs(10), None);
        let _ = self.shell(serial, &["am", "force-stop", "com.android.thememanager"], Duration::from_secs(10), None);
        let link = format!("ViewLocalResource://view.local.resource#{local_id}");
        let started = self.shell(serial, &["am", "start", "-a", "android.intent.action.VIEW", "-d", &link], Duration::from_secs(20), None)?;
        if let Some(error) = super::theme_apply::am_failed(&started.stdout_text()) {
            return Err(AppError::new("device", format!("Theme Manager could not open the theme: {error}")));
        }
        steps.push("Opened the theme in Theme Manager".into());

        // The active theme lives in /data/system/theme; its timestamp changes when
        // Theme Manager finishes applying. That is the success signal.
        let before = self.theme_stamp(serial);
        let since = self.device_time(serial);
        let mut applied = false;
        let mut pressed = false;
        for attempt in 0..3 {
            if cancelled() {
                break;
            }
            // Wait until the page has settled: the button is enabled and stays put.
            let deadline = Instant::now() + Duration::from_secs(25);
            let mut last = None;
            let mut button = None;
            while Instant::now() < deadline && !cancelled() {
                let point = self.ui_dump(serial).ok().and_then(|xml| enabled_node(&xml, APPLY_BUTTON_ID));
                if point.is_some() && point == last {
                    button = point;
                    break;
                }
                last = point;
                std::thread::sleep(Duration::from_millis(600));
            }
            let Some((x, y)) = button else { break };
            self.shell(serial, &["input", "tap", &x.to_string(), &y.to_string()], Duration::from_secs(10), None)?;
            pressed = true;
            steps.push(if attempt == 0 { "Pressed Apply".to_string() } else { format!("Pressed Apply again (attempt {})", attempt + 1) });

            // Applying shows a progress sheet; wait for the theme files to change.
            let deadline = Instant::now() + Duration::from_secs(if attempt == 2 { 90 } else { 8 });
            let mut started = false;
            while Instant::now() < deadline && !cancelled() {
                std::thread::sleep(Duration::from_millis(900));
                if before.is_some() && self.theme_stamp(serial) != before {
                    applied = true;
                    break;
                }
                if let Some(code) = since.as_deref().and_then(|t| self.license_refused(serial, t)) {
                    // Theme Manager asked Xiaomi for a license and was refused.
                    let _ = self.shell(serial, &["input", "keyevent", "KEYCODE_BACK"], Duration::from_secs(10), None);
                    self.remove_previous_try_ons(serial);
                    return Err(AppError::new(
                        "license",
                        format!(
                            "Theme Manager would only apply this theme with a license from Xiaomi, and Xiaomi only issues licenses for unmodified store themes (server answered {code}). The in-app preview and mirror still work, and unchanged store themes can be tried on."
                        ),
                    ));
                }
                if self.ui_dump(serial).is_ok_and(|xml| xml.contains("Applying") || xml.contains("applying")) {
                    started = true;
                }
            }
            if applied {
                break;
            }
            if started {
                // It is applying; give it time to finish instead of pressing again.
                let deadline = Instant::now() + Duration::from_secs(90);
                while Instant::now() < deadline && !cancelled() {
                    std::thread::sleep(Duration::from_millis(1000));
                    if self.theme_stamp(serial) != before {
                        applied = true;
                        break;
                    }
                }
                break;
            }
        }
        if applied {
            // Let the launcher pick up the new theme, then show the home screen.
            std::thread::sleep(Duration::from_millis(1500));
            let _ = self.shell(serial, &["input", "keyevent", "KEYCODE_HOME"], Duration::from_secs(10), None);
            steps.push("Theme Manager applied the theme".into());
        } else if pressed {
            steps.push("Theme Manager did not confirm the apply; check the phone".into());
        } else {
            steps.push("Apply button not found; the theme page is open on the phone".into());
        }
        Ok(TryOnResult { local_id, parts, bytes: package.len() as u64, applied, steps })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    #[test]
    fn maps_package_paths_like_theme_manager() {
        assert_eq!(resource_code("com.android.systemui").as_deref(), Some("statusbar"));
        assert_eq!(resource_code("lockscreen").as_deref(), Some("lockstyle"));
        assert_eq!(resource_code("wallpaper/default_lock_wallpaper.jpg").as_deref(), Some("lockscreen"));
        assert_eq!(resource_code("icons").as_deref(), Some("icons"));
        assert_eq!(resource_code("description.xml"), None);
        assert_eq!(resource_code("wallpaper/other.jpg"), None);
        assert_eq!(resource_code("../x"), None);
    }

    #[test]
    fn makes_v4_ids_and_reads_ui_dumps() {
        let id = new_id();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert_ne!(id, new_id());
        let xml = r#"<node index="1" text="APPLY" resource-id="com.android.thememanager:id/applyBtn" class="android.widget.Button" bounds="[594,2280][1112,2427]" />"#;
        assert_eq!(find_node(xml, APPLY_BUTTON_ID), Some((853, 2353)));
        assert_eq!(find_node(xml, "x:id/none"), None);
    }

    #[test]
    fn stages_records_theme_manager_can_read() {
        let mut w = ZipWriter::new(Cursor::new(Vec::new()));
        let o = SimpleFileOptions::default();
        for (name, data) in [("description.xml", &b"<theme/>"[..]), ("icons", b"PK\x03\x04icons"), ("com.miui.home", b"PK\x03\x04home"), ("preview/en_US_icons_0.jpg", b"\xFF\xD8\xFF")] {
            w.start_file(name, o).unwrap();
            w.write_all(data).unwrap();
        }
        let package = w.finish().unwrap().into_inner();
        let stage = std::env::temp_dir().join(format!("mts-stage-{}", new_id()));
        let (id, codes) = stage_library(&package, "Test", "Me", &stage, false).unwrap();
        assert_eq!(codes, vec!["icons", "launcher"]);
        let theme: Value = serde_json::from_slice(&std::fs::read(stage.join(format!("meta/theme/{id}.mrm"))).unwrap()).unwrap();
        assert_eq!(theme["titles"]["fallback"], "Test");
        assert_eq!(theme[MARKER], true);
        assert_eq!(theme["subResources"].as_array().unwrap().len(), 2);
        assert_eq!(theme["builtInPreviews"]["en_US"][0], "en_US_icons_0.jpg");
        let sub = theme["subResources"][1]["localId"].as_str().unwrap();
        assert_eq!(std::fs::read(stage.join(format!("content/launcher/{sub}.mrc"))).unwrap(), b"PK\x03\x04home");
        assert!(stage.join(format!("preview/theme/{id}/en_US_icons_0.jpg")).exists());
        std::fs::remove_dir_all(&stage).unwrap();
        assert!(stage_library(&package, "Test", "Me", &stage, true).is_err());
        let _ = std::fs::remove_dir_all(&stage);
    }

    #[test]
    fn spots_refused_licenses_in_the_log() {
        let log = "I/DrmService( 1): downloadRights, resultCode=413
I/ThemeDebug( 1): DownloadRightsTask return: 100004
";
        assert_eq!(refused_license(log).as_deref(), Some("413"));
        assert_eq!(refused_license("I/ThemeDebug( 1): DownloadRightsTask return: 100000
"), None);
        assert_eq!(refused_license(""), None);
    }
}

/// Installs and applies a package on a real phone.
/// `MTS_ADB=<adb.exe> MTS_SERIAL=<serial> MTS_TRYON=<theme.mtz> cargo test theme_install::live -- --ignored --nocapture`
#[cfg(test)]
mod live {
    use super::*;

    #[test]
    #[ignore]
    fn tries_a_theme_on_the_phone() {
        let (Ok(path), Ok(serial), Ok(mtz)) = (std::env::var("MTS_ADB"), std::env::var("MTS_SERIAL"), std::env::var("MTS_TRYON")) else { return };
        let adb = Adb { path: path.into(), log: Arc::new(|_| {}) };
        let package = std::fs::read(&mtz).unwrap();
        let stage = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/tmp/try-on");
        let result = adb.try_on(&serial, &package, "MTS Try-on Test", &stage, std::env::var("MTS_FREE_ONLY").is_ok(), None).expect("try on");
        for step in &result.steps {
            println!("  {step}");
        }
        assert!(result.applied);
    }
}
