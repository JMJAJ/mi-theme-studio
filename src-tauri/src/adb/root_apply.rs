//! Applying a theme with root by writing its parts into `/data/system/theme`.
//!
//! Theme Manager applies a theme by copying each component to
//! `/data/system/theme/<name>` (see `basemodule/utils/e.k`) and restarting
//! SystemUI. Its pre-apply check refuses parts without a Xiaomi licence. On a
//! rooted phone the same files can be placed directly, which is what this
//! module does: back up the current theme, push the parts, copy them as root
//! with the theme's SELinux label, then restart SystemUI.
//!
//! This is the user's own device and their own theme; the app only automates
//! the file copy that root allows. It is not silent: the UI asks first and the
//! backup path is reported.

use super::{valid_serial, Adb};
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::io::{Cursor, Read};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use zip::ZipArchive;

pub const THEME_DIR: &str = "/data/system/theme";
const TMP_DIR: &str = "/data/local/tmp/mts-root-theme";
const MAX_PART_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootApplyResult {
    pub applied: bool,
    pub backup: Option<String>,
    pub parts: Vec<String>,
    pub steps: Vec<String>,
}

/// One `/data/system/theme` backup on the phone's storage.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeBackup {
    pub path: String,
    pub name: String,
    pub bytes: u64,
    pub modified_ms: u64,
}

/// Where Theme Manager puts a part it applies. Anything else lands under
/// `/data/system/theme/<code>` (that is its fallback too).
pub fn applied_destination(code: &str) -> Option<String> {
    let dest = match code {
        "statusbar" => "com.android.systemui",
        "lockstyle" => "lockscreen",
        "launcher" => "com.miui.home",
        "mms" => "com.android.mms",
        "contact" => "com.android.contacts",
        "fonts" => return Some(format!("{THEME_DIR}/fonts/Roboto-Regular.ttf")),
        "fonts_fallback" => return Some(format!("{THEME_DIR}/fonts/DroidSansFallback.ttf")),
        // Wallpapers, sounds and boot audio are handed to the system itself,
        // not stored in the theme folder.
        "wallpaper" | "lockscreen" | "ringtone" | "notification" | "alarm" | "bootaudio" | "audioeffect" => return None,
        "" => return None,
        other => other,
    };
    Some(format!("{THEME_DIR}/{dest}"))
}

impl Adb {
    /// Whether `su` grants a root shell (Magisk, KernelSU, …).
    pub fn rooted(&self, serial: &str) -> bool {
        valid_serial(serial).is_ok()
            && self
                .shell(serial, &["su", "-c", "id"], Duration::from_secs(10), None)
                .map(|o| o.stdout_text().contains("uid=0"))
                .unwrap_or(false)
    }

    /// Runs `script` as root. The script is quoted as one `su -c` argument;
    /// without the quotes the device shell would split it and the commands
    /// after the first `;` would run as the shell user.
    fn su_script(&self, serial: &str, script: &str, timeout: Duration) -> AppResult<String> {
        let command = format!("su -c \"{}\"", script.replace('"', "\\\""));
        Ok(self.shell(serial, &[&command], timeout, None)?.stdout_text())
    }

    /// Theme backups written by [`Adb::root_apply`], newest first.
    pub fn root_backups(&self, serial: &str) -> AppResult<Vec<ThemeBackup>> {
        valid_serial(serial)?;
        let command = "stat -c '%s %Y %n' /sdcard/MiThemeStudio/*";
        let out = self.shell(serial, &[command], Duration::from_secs(15), None)?;
        let mut backups: Vec<ThemeBackup> = Vec::new();
        for line in out.stdout_text().lines() {
            let mut fields = line.split_whitespace();
            let (Some(size), Some(modified), Some(path)) = (fields.next(), fields.next(), fields.next()) else { continue };
            let name = path.rsplit('/').next().unwrap_or_default().to_string();
            if !name.starts_with("theme-") || !name.ends_with(".tar") {
                continue;
            }
            let Ok(bytes) = size.parse::<u64>() else { continue };
            let Ok(seconds) = modified.parse::<u64>() else { continue };
            backups.push(ThemeBackup { path: path.to_string(), name, bytes, modified_ms: seconds * 1000 });
        }
        backups.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
        Ok(backups)
    }

    /// Replaces `/data/system/theme` with a backup made by `root_apply` and
    /// restarts SystemUI.
    pub fn root_restore(&self, serial: &str, backup: &str) -> AppResult<Vec<String>> {
        valid_serial(serial)?;
        if !self.rooted(serial) {
            return Err(AppError::new("noroot", "This phone did not grant root."));
        }
        if !backup.starts_with("/sdcard/MiThemeStudio/theme-") || backup.contains("..") || !backup.ends_with(".tar") {
            return Err(AppError::invalid("That is not a theme backup made by this app."));
        }
        let mut steps = Vec::new();
        let script = format!(
            "if tar -tf {backup} >/dev/null 2>&1; then rm -rf /data/system/theme && tar -xf {backup} -C /data/system && chown -R theme:theme /data/system/theme && chcon -R u:object_r:theme_data_file:s0 /data/system/theme 2>/dev/null; rm -rf /data/system/theme_magic/customized_icons/* /data/system/theme_magic/tempIcon/* 2>/dev/null; echo restored; else echo failed; fi"
        );
        let out = self.su_script(serial, &script, Duration::from_secs(240))?;
        if !out.contains("restored") {
            return Err(AppError::new("restore", format!("Could not restore {backup}. The command said: {}", out.trim())));
        }
        steps.push(format!("Restored {backup} into /data/system/theme"));
        let _ = self.su_script(serial, "pkill -f com.android.systemui; am force-stop com.miui.home; true", Duration::from_secs(30));
        std::thread::sleep(Duration::from_millis(3500));
        steps.push("Restarted SystemUI and the launcher".into());
        Ok(steps)
    }

    pub fn root_apply(&self, serial: &str, package: &[u8], stage: &Path, cancel: Option<Arc<AtomicBool>>) -> AppResult<RootApplyResult> {        valid_serial(serial)?;
        let cancelled = || cancel.as_ref().is_some_and(|c| c.load(Ordering::Relaxed));
        if !self.rooted(serial) {
            return Err(AppError::new(
                "noroot",
                "This phone did not grant root. Apply with root needs `su` (Magisk/KernelSU) and the shell allowed to use it.",
            ));
        }
        let mut steps = Vec::new();

        // Collect the parts Theme Manager would write, in package order.
        let mut zip = ZipArchive::new(Cursor::new(package))?;
        let mut parts: Vec<(String, Vec<u8>)> = Vec::new();
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i)?;
            if entry.is_dir() || entry.size() > MAX_PART_BYTES {
                continue;
            }
            let name = entry.name()?.to_string();
            if name.starts_with("preview/") {
                continue;
            }
            let Some(code) = super::theme_install::resource_code(&name) else { continue };
            if parts.iter().any(|(c, _)| *c == code) || applied_destination(&code).is_none() {
                continue;
            }
            let mut data = Vec::new();
            entry.read_to_end(&mut data)?;
            parts.push((code, data));
        }
        if parts.is_empty() {
            return Err(AppError::invalid("This theme has no parts that can be written to the theme folder."));
        }

        // Back up the current theme first: this is the way back.
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let backup_path = format!("/sdcard/MiThemeStudio/theme-{now}.tar");
        let backup_cmd = format!("mkdir -p /sdcard/MiThemeStudio && tar -cf {backup_path} -C /data/system theme 2>/dev/null || cp -a /data/system/theme {backup_path}.dir");
        let backup = match self.su_script(serial, &backup_cmd, Duration::from_secs(180)) {
            Ok(_) => {
                steps.push(format!("Backed up the current theme to {backup_path}"));
                Some(backup_path)
            }
            Err(_) => {
                steps.push("Could not back up the current theme; continuing anyway".into());
                None
            }
        };

        // Stage the parts locally, push them once, then copy as root.
        let io = |e: std::io::Error| AppError::io("Could not stage the theme for root apply", e);
        let _ = std::fs::remove_dir_all(stage);
        std::fs::create_dir_all(stage).map_err(io)?;
        let mut script = String::new();
        for (index, (code, data)) in parts.iter().enumerate() {
            std::fs::write(stage.join(index.to_string()), data).map_err(io)?;
            let dest = applied_destination(code).ok_or_else(|| AppError::invalid("Unsupported part"))?;
            if let Some((dir, _)) = dest.rsplit_once('/') {
                script.push_str(&format!("mkdir -p {dir}; chown theme:theme {dir} 2>/dev/null; "));
            }
            script.push_str(&format!(
                "cp {TMP_DIR}/{index} {dest}; chown theme:theme {dest}; chmod 644 {dest}; chcon u:object_r:theme_data_file:s0 {dest} 2>/dev/null; "
            ));
        }
        // The launcher serves icons from a large-icon cache; without clearing it
        // new icons only show up after the cache expires.
        if parts.iter().any(|(code, _)| code == "icons") {
            script.push_str("rm -rf /data/system/theme_magic/customized_icons/* /data/system/theme_magic/tempIcon/* 2>/dev/null; ");
        }
        let _ = self.shell(serial, &["rm", "-rf", TMP_DIR], Duration::from_secs(10), None);
        self.shell(serial, &["mkdir", "-p", TMP_DIR], Duration::from_secs(10), None)?;
        let local = format!("{}{}.", stage.display(), std::path::MAIN_SEPARATOR);
        let out = self.exec(&["-s", serial, "push", &local, &format!("{TMP_DIR}/")], Duration::from_secs(300), cancel.clone(), false)?;
        self.expect_ok(out, "adb push")?;
        steps.push(format!("Pushed {} part(s) to the phone", parts.len()));
        if cancelled() {
            return Err(AppError::new("cancelled", "The operation was cancelled."));
        }

        let echoed = self.su_script(serial, &script, Duration::from_secs(240))?;
        let echoed = echoed.trim().to_string();
        if !echoed.is_empty() {
            steps.push(echoed.lines().take(6).collect::<Vec<_>>().join(" "));
        }
        steps.push("Wrote the parts into /data/system/theme".into());

        // SystemUI picks the files up on restart; the launcher reloads icons.
        let _ = self.su_script(serial, "pkill -f com.android.systemui; am force-stop com.miui.home; true", Duration::from_secs(30));
        std::thread::sleep(Duration::from_millis(4500));
        steps.push("Restarted SystemUI and the launcher".into());
        Ok(RootApplyResult { applied: true, backup, parts: parts.iter().map(|(code, _)| code.clone()).collect(), steps })
    }
}

#[cfg(test)]
mod live {
    use super::*;

    /// `MTS_ADB=… MTS_SERIAL=… MTS_TRYON=<font-only.mtz>`
    #[test]
    #[ignore]
    fn lists_and_restores_backups() {
        let (Ok(path), Ok(serial)) = (std::env::var("MTS_ADB"), std::env::var("MTS_SERIAL")) else { return };
        let adb = Adb { path: path.into(), log: Arc::new(|_| {}) };
        let backups = adb.root_backups(&serial).expect("backups");
        for backup in &backups {
            println!("  {} · {} bytes · {}", backup.name, backup.bytes, backup.modified_ms);
        }
        assert!(!backups.is_empty());
        if let Ok(target) = std::env::var("MTS_RESTORE_BACKUP") {
            let steps = adb.root_restore(&serial, &target).expect("restore");
            for step in steps {
                println!("  {step}");
            }
        }
    }

    #[test]
    #[ignore]
    fn applies_a_theme_with_root() {
        let (Ok(path), Ok(serial), Ok(mtz)) = (std::env::var("MTS_ADB"), std::env::var("MTS_SERIAL"), std::env::var("MTS_TRYON")) else { return };
        let adb = Adb { path: path.into(), log: Arc::new(|_| {}) };
        assert!(adb.rooted(&serial), "the phone did not grant root");
        let package = std::fs::read(&mtz).unwrap();
        let stage = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/tmp/root-apply");
        let result = adb.root_apply(&serial, &package, &stage, None).expect("root apply");
        for step in &result.steps {
            println!("  {step}");
        }
        println!("  parts: {:?}", result.parts);
        assert!(result.applied);
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_parts_to_theme_folder_paths() {
        assert_eq!(applied_destination("icons").as_deref(), Some("/data/system/theme/icons"));
        assert_eq!(applied_destination("statusbar").as_deref(), Some("/data/system/theme/com.android.systemui"));
        assert_eq!(applied_destination("lockstyle").as_deref(), Some("/data/system/theme/lockscreen"));
        assert_eq!(applied_destination("launcher").as_deref(), Some("/data/system/theme/com.miui.home"));
        assert_eq!(applied_destination("fonts").as_deref(), Some("/data/system/theme/fonts/Roboto-Regular.ttf"));
        assert_eq!(applied_destination("clock_2x4").as_deref(), Some("/data/system/theme/clock_2x4"));
        assert_eq!(applied_destination("wallpaper"), None);
        assert_eq!(applied_destination("ringtone"), None);
    }
}
