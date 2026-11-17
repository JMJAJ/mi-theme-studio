//! Applying a theme with root by writing its parts into `/data/system/theme`.
//!
//! Theme Manager applies a theme by copying each component to
//! `/data/system/theme/<name>` (see `basemodule/utils/e.k`) and restarting
//! SystemUI. Its pre-apply check refuses parts without a Xiaomi licence. On a
//! rooted phone the same files can be placed directly, which is what this
//! module does: back up the current theme (and home wallpaper), push the
//! parts, copy them as root with the right owner and SELinux label, check each
//! one landed, remove the previous theme's leftovers, then restart SystemUI
//! and the launcher.
//!
//! Layout checked on a Mi 9T (MIUI 12, Android 11): component files such as
//! `icons`, `lockscreen`, `com.android.systemui`, `framework-res`; the lock
//! wallpaper as `lock_wallpaper` (served to the keyguard by Theme Manager's
//! `theme_lockwallpaper` provider); the home wallpaper is the system one in
//! `/data/system/users/0/wallpaper` (+ `wallpaper_orig`), with a copy in the
//! theme folder.
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
const BACKUP_DIR: &str = "/sdcard/MiThemeStudio";
const USER_WALLPAPER: &str = "/data/system/users/0/wallpaper";
const MAX_PART_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootApplyResult {
    pub applied: bool,
    pub backup: Option<String>,
    pub parts: Vec<String>,
    /// Parts that did not land (copy failed or the size did not match).
    pub failed: Vec<String>,
    /// Previous theme parts removed because this theme does not have them.
    pub removed: Vec<String>,
    /// Icons, fonts, framework or app styles changed: MIUI only reloads them at boot.
    pub needs_reboot: bool,
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
        // The package entry `framework-res` is Theme Manager's `framework` code,
        // but the applied file keeps the original name.
        "framework" => "framework-res",
        // The lock screen wallpaper (`wallpaper/default_lock_wallpaper.*`).
        "lockscreen" => "lock_wallpaper",
        // A copy of the home wallpaper; the system one is set separately.
        "wallpaper" => "wallpaper",
        "fonts" => return Some(format!("{THEME_DIR}/fonts/Roboto-Regular.ttf")),
        "fonts_fallback" => return Some(format!("{THEME_DIR}/fonts/DroidSansFallback.ttf")),
        // Sounds and boot audio are handed to the system itself, not stored in the theme folder.
        "ringtone" | "notification" | "alarm" | "bootaudio" | "audioeffect" => return None,
        "" => return None,
        other => other,
    };
    Some(format!("{THEME_DIR}/{dest}"))
}

/// Single-quote a value for the phone's shell.
fn sq(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

impl Adb {
    /// Whether `su` grants a root shell (Magisk, KernelSU, …).
    pub fn rooted(&self, serial: &str) -> bool {
        valid_serial(serial).is_ok()
            && self
                .shell(serial, &["su", "-c", "id"], Duration::from_secs(20), None)
                .map(|o| o.stdout_text().contains("uid=0"))
                .unwrap_or(false)
    }

    /// Runs `script` as root. The script is passed as one double-quoted `su -c`
    /// argument; `\`, `"`, `$` and backticks are escaped so the outer (shell
    /// user) shell neither splits it nor expands anything: only the root shell
    /// sees variables and command substitutions. Always ends with `true`, so
    /// the result is judged by what the script prints, not by its exit code.
    fn su_script(&self, serial: &str, script: &str, timeout: Duration) -> AppResult<String> {
        let escaped = script.replace('\\', "\\\\").replace('"', "\\\"").replace('$', "\\$").replace('`', "\\`");
        let command = format!("su -c \"{escaped}; true\"");
        Ok(self.shell(serial, &[&command], timeout, None)?.stdout_text())
    }

    fn no_root() -> AppError {
        AppError::new(
            "noroot",
            "This phone did not grant root. Apply with root needs su (Magisk, KernelSU or APatch) and the Shell app allowed in it: unlock the phone, accept the superuser prompt for Shell, then try again.",
        )
    }

    /// Theme backups written by [`Adb::root_apply`], newest first.
    pub fn root_backups(&self, serial: &str) -> AppResult<Vec<ThemeBackup>> {
        valid_serial(serial)?;
        let command = format!("stat -c '%s %Y %n' {BACKUP_DIR}/theme-*.tar 2>/dev/null; true");
        let out = self.shell(serial, &[&command], Duration::from_secs(15), None)?;
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

    fn restart_ui(&self, serial: &str) {
        let _ = self.su_script(serial, "pkill -f com.android.systemui; am force-stop com.miui.home", Duration::from_secs(30));
        std::thread::sleep(Duration::from_millis(4500));
    }

    /// Replaces `/data/system/theme` (and the home wallpaper, when the backup
    /// has it) with a backup made by `root_apply`, then restarts SystemUI.
    pub fn root_restore(&self, serial: &str, backup: &str) -> AppResult<Vec<String>> {
        valid_serial(serial)?;
        if !self.rooted(serial) {
            return Err(Self::no_root());
        }
        if !backup.starts_with(&format!("{BACKUP_DIR}/theme-")) || backup.contains("..") || !backup.ends_with(".tar") || backup.contains('\'') {
            return Err(AppError::invalid("That is not a theme backup made by this app."));
        }
        let b = sq(backup);
        let script = format!(
            "if tar -tf {b} theme >/dev/null 2>&1; then \
               rm -rf {THEME_DIR} && tar -xf {b} -C /data/system theme && \
               chown -R theme:theme {THEME_DIR} && chcon -R u:object_r:theme_data_file:s0 {THEME_DIR} 2>/dev/null; \
               if tar -tf {b} users/0/wallpaper >/dev/null 2>&1; then \
                 tar -xf {b} -C /data/system users/0/wallpaper users/0/wallpaper_orig 2>/dev/null; \
                 for w in {USER_WALLPAPER} {USER_WALLPAPER}_orig; do [ -f $w ] && chown system:system $w && chmod 600 $w && chcon u:object_r:wallpaper_file:s0 $w; done; \
                 echo MTS_WALLPAPER; \
               fi; \
               rm -rf /data/system/theme_magic/customized_icons/* /data/system/theme_magic/tempIcon/* 2>/dev/null; \
               echo MTS_RESTORED; \
             else echo MTS_BAD_BACKUP; fi"
        );
        let out = self.su_script(serial, &script, Duration::from_secs(240))?;
        if !out.contains("MTS_RESTORED") {
            return Err(AppError::new("restore", format!("Could not restore {backup}. The phone said: {}", out.trim())));
        }
        let mut steps = vec![format!("Restored {backup} into {THEME_DIR}")];
        if out.contains("MTS_WALLPAPER") {
            steps.push("Restored the home wallpaper".into());
        }
        self.restart_ui(serial);
        steps.push("Restarted SystemUI and the launcher".into());
        Ok(steps)
    }

    pub fn root_apply(&self, serial: &str, package: &[u8], stage: &Path, cancel: Option<Arc<AtomicBool>>) -> AppResult<RootApplyResult> {
        valid_serial(serial)?;
        let cancelled = || cancel.as_ref().is_some_and(|c| c.load(Ordering::Relaxed));
        if !self.rooted(serial) {
            return Err(Self::no_root());
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
            if data.is_empty() {
                continue;
            }
            parts.push((code, data));
        }
        if parts.is_empty() {
            return Err(AppError::invalid("This theme has no parts that can be written to the theme folder."));
        }

        // 1. Back up the current theme folder and home wallpaper. No backup, no apply.
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let backup_path = format!("{BACKUP_DIR}/theme-{now}.tar");
        let backup_cmd = format!(
            "mkdir -p {BACKUP_DIR} && mkdir -p {THEME_DIR} && cd /data/system && \
             set -- theme; for w in users/0/wallpaper users/0/wallpaper_orig; do [ -f $w ] && set -- \"$@\" $w; done; \
             tar -cf {backup_path} \"$@\" && tar -tf {backup_path} theme >/dev/null && echo MTS_BACKUP_OK"
        );
        let out = self.su_script(serial, &backup_cmd, Duration::from_secs(240))?;
        if !out.contains("MTS_BACKUP_OK") {
            let _ = self.su_script(serial, &format!("rm -f {backup_path}"), Duration::from_secs(15));
            return Err(AppError::new(
                "backup",
                format!("Could not back up the current theme to {backup_path}, so nothing was changed. Check that the phone has free storage. The phone said: {}", out.trim()),
            ));
        }
        steps.push(format!("Backed up the current theme and home wallpaper to {backup_path}"));
        if cancelled() {
            return Err(AppError::new("cancelled", "The operation was cancelled."));
        }

        // 2. Stage the parts locally and push them in one go.
        let io = |e: std::io::Error| AppError::io("Could not stage the theme for root apply", e);
        let _ = std::fs::remove_dir_all(stage);
        std::fs::create_dir_all(stage).map_err(io)?;
        for (index, (_, data)) in parts.iter().enumerate() {
            std::fs::write(stage.join(index.to_string()), data).map_err(io)?;
        }
        let _ = self.shell(serial, &["rm", "-rf", TMP_DIR], Duration::from_secs(10), None);
        self.shell(serial, &["mkdir", "-p", TMP_DIR], Duration::from_secs(10), None)?;
        let local = format!("{}{}.", stage.display(), std::path::MAIN_SEPARATOR);
        let out = self.exec(&["-s", serial, "push", &local, &format!("{TMP_DIR}/")], Duration::from_secs(600), cancel.clone(), false)?;
        self.expect_ok(out, "adb push")?;
        steps.push(format!("Pushed {} part(s) to the phone", parts.len()));
        if cancelled() {
            let _ = self.shell(serial, &["rm", "-rf", TMP_DIR], Duration::from_secs(10), None);
            return Err(AppError::new("cancelled", "The operation was cancelled."));
        }

        // 3. Write every part as root and check it landed with the right size.
        let dests: Vec<String> = parts.iter().map(|(code, _)| applied_destination(code).unwrap_or_default()).collect();
        let keep: Vec<String> = dests
            .iter()
            .filter_map(|d| d.strip_prefix(&format!("{THEME_DIR}/")).map(|rest| rest.split('/').next().unwrap_or(rest).to_string()))
            .collect();
        let mut script = format!("mkdir -p {THEME_DIR}; chown theme:theme {THEME_DIR}; chmod 775 {THEME_DIR}; ");
        // A full apply replaces the previous theme: drop its parts this theme
        // does not have (Theme Manager does the same). Wallpapers stay unless
        // replaced; folders such as rights/ and .runtime are left alone.
        let keep_list = format!(" {} lock_wallpaper wallpaper plugin_config.xml ", keep.join(" "));
        script.push_str(&format!(
            "for f in {THEME_DIR}/*; do n=${{f##*/}}; [ -f \"$f\" ] || continue; case '{keep_list}' in *\" $n \"*) ;; *) rm -f \"$f\" && echo MTS_REMOVED:$n;; esac; done; "
        ));
        if !keep.iter().any(|k| k == "fonts") {
            script.push_str(&format!("[ -d {THEME_DIR}/fonts ] && rm -rf {THEME_DIR}/fonts && echo MTS_REMOVED:fonts; "));
        }
        for (index, ((code, data), dest)) in parts.iter().zip(&dests).enumerate() {
            if let Some((dir, _)) = dest.rsplit_once('/') {
                if dir != THEME_DIR {
                    script.push_str(&format!("mkdir -p {dir}; chown theme:theme {dir}; chmod 775 {dir}; chcon u:object_r:theme_data_file:s0 {dir} 2>/dev/null; "));
                }
            }
            script.push_str(&format!(
                "rm -rf {dest}; cp {TMP_DIR}/{index} {dest} && chown theme:theme {dest} && chmod 644 {dest}; chcon u:object_r:theme_data_file:s0 {dest} 2>/dev/null; \
                 s=$(stat -c %s {dest} 2>/dev/null); [ \"$s\" = \"{size}\" ] && echo MTS_OK:{code} || echo MTS_FAIL:{code}; ",
                size = data.len()
            ));
            // The home wallpaper is the system one; the theme folder only keeps a copy.
            if code == "wallpaper" {
                script.push_str(&format!(
                    "for w in {USER_WALLPAPER}_orig {USER_WALLPAPER}; do cp {TMP_DIR}/{index} $w && chown system:system $w && chmod 600 $w && chcon u:object_r:wallpaper_file:s0 $w; done && echo MTS_HOME_WALLPAPER; "
                ));
            }
        }
        // The launcher serves icons from a cache; without clearing it new icons only show up later.
        if parts.iter().any(|(code, _)| code == "icons") {
            script.push_str("rm -rf /data/system/theme_magic/customized_icons/* /data/system/theme_magic/tempIcon/* 2>/dev/null; ");
        }
        script.push_str(&format!("rm -rf {TMP_DIR}"));
        let out = self.su_script(serial, &script, Duration::from_secs(300))?;

        let mut failed = Vec::new();
        let mut written = Vec::new();
        let mut removed = Vec::new();
        for line in out.lines().map(str::trim) {
            if let Some(code) = line.strip_prefix("MTS_OK:") {
                written.push(code.to_string());
            } else if let Some(code) = line.strip_prefix("MTS_FAIL:") {
                failed.push(code.to_string());
            } else if let Some(name) = line.strip_prefix("MTS_REMOVED:") {
                removed.push(name.to_string());
            }
        }
        // A part with no answer at all did not run: count it as failed.
        for (code, _) in &parts {
            if !written.contains(code) && !failed.contains(code) {
                failed.push(code.clone());
            }
        }
        steps.push(format!("Wrote {} of {} part(s) into {THEME_DIR}: {}", written.len(), parts.len(), written.join(", ")));
        if !failed.is_empty() {
            steps.push(format!("Did not land: {}", failed.join(", ")));
        }
        if out.contains("MTS_HOME_WALLPAPER") {
            steps.push("Set the home screen wallpaper".into());
        }
        if !removed.is_empty() {
            steps.push(format!("Removed the previous theme's {}", removed.join(", ")));
        }

        // 4. SystemUI (status bar, lock screen) and the launcher pick the files up on restart.
        self.restart_ui(serial);
        steps.push("Restarted SystemUI and the launcher".into());
        // Verified on MIUI 12: the lock screen, status bar and wallpapers show
        // after the restart above, but icons, fonts, framework and app styles
        // are cached by every running app and only reload at boot.
        let live = |c: &str| matches!(c, "statusbar" | "lockstyle" | "lockscreen" | "wallpaper" | "plugin_config.xml");
        let needs_reboot = written.iter().any(|c| !live(c)) || !removed.is_empty();
        if needs_reboot {
            steps.push("Icons, fonts and app styles show after the phone restarts".into());
        }
        Ok(RootApplyResult { applied: failed.is_empty(), backup: Some(backup_path), parts: written, failed, removed, needs_reboot, steps })
    }

    /// Restart the phone (used after a font change).
    pub fn reboot(&self, serial: &str) -> AppResult<()> {
        valid_serial(serial)?;
        let out = self.exec(&["-s", serial, "reboot"], Duration::from_secs(30), None, false)?;
        self.expect_ok(out, "adb reboot")?;
        Ok(())
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
        println!("  parts: {:?} failed: {:?} removed: {:?}", result.parts, result.failed, result.removed);
        assert!(result.applied, "parts did not land: {:?}", result.failed);
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
        assert_eq!(applied_destination("framework").as_deref(), Some("/data/system/theme/framework-res"));
        assert_eq!(applied_destination("lockscreen").as_deref(), Some("/data/system/theme/lock_wallpaper"));
        assert_eq!(applied_destination("wallpaper").as_deref(), Some("/data/system/theme/wallpaper"));
        assert_eq!(applied_destination("fonts").as_deref(), Some("/data/system/theme/fonts/Roboto-Regular.ttf"));
        assert_eq!(applied_destination("clock_2x4").as_deref(), Some("/data/system/theme/clock_2x4"));
        assert_eq!(applied_destination("ringtone"), None);
    }

    #[test]
    fn quotes_for_the_phone_shell() {
        assert_eq!(sq("a b"), "'a b'");
        assert_eq!(sq("it's"), "'it'\\''s'");
    }
}
