//! Opening and applying themes through Theme Manager on the phone.
//!
//! Applying uses the same protocol as Xiaomi's own desktop theme editor: the
//! package is pushed to a path Theme Manager reads and its
//! `ApplyThemeForScreenshot` activity is started with `api_called_from =
//! ThemeEditor`. That activity only exists in some Theme Manager builds
//! (verified absent in global 3.0.5.19 on HyperOS 3), so support is detected
//! first. When an update removed it, `prepare_theme_manager` can revert Theme
//! Manager to the factory build through the package manager; nothing here
//! needs root, patches an APK, or touches Theme Manager's private data.

use super::{valid_serial, Adb, THEME_MANAGER_PACKAGE};
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

pub const APPLY_ACTIVITY: &str = "com.android.thememanager/com.android.thememanager.ApplyThemeForScreenshot";
/// Declared by Theme Manager builds that use the two-step (init/apply) flow.
pub const SUPPORT_MARKER: &str = "com.android.thememanager.support3.0";
/// Theme Manager can read its own external files directory without storage
/// permissions. A path such as `/sdcard/temp.mtz` instead opens DocumentsUI,
/// so the single-step flow must use this one too.
const NEW_FLOW_PATH: &str = "/sdcard/Android/data/com.android.thememanager/files/temp.mtz";
const FILES_DIR: &str = "/sdcard/Android/data/com.android.thememanager/files";

/// `pm uninstall-system-updates` only has something to remove when the
/// running build was installed over the system one (its code lives in /data).
fn is_updated_system_app(dump: &str) -> bool {
    dump.lines()
        .map(str::trim)
        .any(|line| line.starts_with("codePath=/data/"))
}

/// Theme Manager opens the system file picker when it cannot read the path.
fn picker_in_front(activities: &str) -> bool {
    activities
        .lines()
        .filter(|l| l.contains("ResumedActivity"))
        .any(|l| l.contains("documentsui") || l.contains("DocumentsActivity") || l.contains("FilePicker"))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThemeManagerSupport {
    pub installed: bool,
    pub version: Option<String>,
    /// `ApplyThemeForScreenshot` resolves: one-click apply is possible.
    pub can_apply: bool,
    /// Two-step flow (`ver2_step_init` / `ver2_step_apply`).
    pub two_step: bool,
    /// Store/detail deep links resolve.
    pub can_open_store: bool,
    /// `su` grants a root shell (Apply with root).
    pub rooted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub remote_path: String,
    pub bytes: u64,
    pub steps: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareThemeManagerResult {
    /// True when an update was removed and the factory build was restored.
    pub changed: bool,
    pub before_version: Option<String>,
    pub support: ThemeManagerSupport,
    pub steps: Vec<String>,
}

/// `pm uninstall-system-updates` prints `Success` on its own line.
fn uninstall_succeeded(output: &str) -> bool {
    output.lines().any(|line| line.trim() == "Success")
}

/// `am start` prints errors on stdout with exit code 0.
pub(super) fn am_failed(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with("Error") || l.contains("Exception"))
        .map(str::to_string)
}

pub fn resolves(output: &str, component_hint: &str) -> bool {
    output.lines().any(|l| l.trim().starts_with(THEME_MANAGER_PACKAGE) && l.contains(component_hint))
}

fn valid_store_id(id: &str) -> AppResult<&str> {
    if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Ok(id)
    } else {
        Err(AppError::invalid("Invalid store identifier."))
    }
}

impl Adb {
    /// Theme format the phone's framework accepts, from
    /// `/system/media/theme/theme_compatibility.xml` (140 = 14.0). Themes whose
    /// `uiVersion` exceeds it cannot be rendered by that build.
    pub fn theme_format(&self, serial: &str) -> Option<u32> {
        let out = self
            .shell(serial, &["cat", "/system/media/theme/theme_compatibility.xml"], Duration::from_secs(15), None)
            .ok()?;
        let text = out.stdout_text();
        let file = (|| {
            let at = text.find("<version>")? + "<version>".len();
            let end = at + text[at..].find("</version>")?;
            text[at..end].trim().parse::<u32>().ok()
        })();
        // Xiaomi stopped bumping that file at MIUI 14: every HyperOS build still says 140.
        // HyperOS N renders theme format 14 + N (HyperOS 1 = 15, HyperOS 3 = 17).
        let hyperos = self
            .shell(serial, &["getprop", "ro.mi.os.version.code"], Duration::from_secs(10), None)
            .ok()
            .and_then(|o| o.stdout_text().trim().parse::<u32>().ok())
            .filter(|&code| code > 0)
            .map(|code| 140 + code * 10);
        match (file, hyperos) {
            (Some(f), Some(h)) => Some(f.max(h)),
            (f, h) => f.or(h),
        }
    }

    fn apply_activity_resolves(&self, serial: &str) -> bool {
        self.shell(
            serial,
            &["cmd", "package", "resolve-activity", "--brief", "--components", "-n", APPLY_ACTIVITY],
            Duration::from_secs(15),
            None,
        )
        .map(|out| resolves(&out.stdout_text(), "ApplyThemeForScreenshot"))
        .unwrap_or(false)
    }

    pub fn theme_manager_support(&self, serial: &str) -> AppResult<ThemeManagerSupport> {
        valid_serial(serial)?;
        let dump = self
            .shell(serial, &["dumpsys", "package", THEME_MANAGER_PACKAGE], Duration::from_secs(20), None)?
            .stdout_text();
        let installed = dump.contains(&format!("Package [{THEME_MANAGER_PACKAGE}]"));
        if !installed {
            return Ok(ThemeManagerSupport { installed, version: None, can_apply: false, two_step: false, can_open_store: false, rooted: self.rooted(serial) });
        }
        let apply = self.apply_activity_resolves(serial);
        let store = self
            .shell(
                serial,
                &["cmd", "package", "resolve-activity", "--brief", "-a", "android.intent.action.VIEW", "-d", "theme://zhuti.xiaomi.com/settingstheme", THEME_MANAGER_PACKAGE],
                Duration::from_secs(15),
                None,
            )
            .map(|o| resolves(&o.stdout_text(), "ThemeSettingsActivity"))
            .unwrap_or(false);
        Ok(ThemeManagerSupport {
            installed,
            version: super::parse::parse_version_name(&dump),
            can_apply: apply,
            two_step: dump.contains(SUPPORT_MARKER),
            can_open_store: store,
            rooted: self.rooted(serial),
        })
    }

    fn start(&self, serial: &str, args: &[&str], what: &str) -> AppResult<String> {
        let mut command = vec!["am", "start"];
        command.extend_from_slice(args);
        let out = self.shell(serial, &command, Duration::from_secs(20), None)?.stdout_text();
        if let Some(error) = am_failed(&out) {
            return Err(AppError::new("adb", format!("{what}: {error}")));
        }
        Ok(out)
    }

    /// Open a store item's page in Theme Manager (the user applies or buys it there).
    pub fn open_store_item(&self, serial: &str, module_id: &str) -> AppResult<()> {
        let id = valid_store_id(module_id)?;
        let uri = format!("theme://zhuti.xiaomi.com/detail/{id}");
        self.start(serial, &["-a", "android.intent.action.VIEW", "-d", &uri, "-p", THEME_MANAGER_PACKAGE], "Open in Theme Manager")
            .map(|_| ())
    }

    /// Open Theme Manager's installed-themes settings page.
    pub fn open_theme_settings(&self, serial: &str) -> AppResult<()> {
        self.start(
            serial,
            &["-a", "android.intent.action.VIEW", "-d", "theme://zhuti.xiaomi.com/settingstheme", "-p", THEME_MANAGER_PACKAGE],
            "Open Theme Manager",
        )
        .map(|_| ())
    }

    fn push_to(&self, serial: &str, local: &Path, remote: &str, cancel: Option<Arc<AtomicBool>>) -> AppResult<u64> {
        let bytes = std::fs::metadata(local).map_err(|e| AppError::io("Could not read the staged package", e))?.len();
        if let Some(dir) = remote.rsplit_once('/').map(|(d, _)| d) {
            let _ = self.shell(serial, &["mkdir", "-p", dir], Duration::from_secs(10), cancel.clone());
        }
        let local_str = local.to_string_lossy().into_owned();
        let out = self.exec(&["-s", serial, "push", &local_str, remote], Duration::from_secs(60 + bytes / (1024 * 1024) * 2), cancel.clone(), false)?;
        self.expect_ok(out, "adb push")?;
        let stat = self.shell(serial, &["stat", "-c", "%s", remote], Duration::from_secs(10), cancel)?;
        match super::parse::parse_size(&stat.stdout_text()) {
            Some(size) if size == bytes => Ok(bytes),
            other => Err(AppError::new(
                "verify",
                format!("The copy could not be verified: local {bytes} bytes, device reports {}.", other.map(|s| s.to_string()).unwrap_or_else(|| "no size".into())),
            )),
        }
    }

    /// Remove Theme Manager's update so the factory build (which still has the
    /// editor apply entry point on affected global builds) is used. No root and
    /// no APK is installed; this is the package manager's supported downgrade.
    /// Theme Manager's own data may be reset by the downgrade.
    pub fn prepare_theme_manager(
        &self,
        serial: &str,
        cancel: Option<Arc<AtomicBool>>,
    ) -> AppResult<PrepareThemeManagerResult> {
        valid_serial(serial)?;
        let before = self.theme_manager_support(serial)?;
        if !before.installed {
            return Err(AppError::not_found("Theme Manager is not installed on this phone."));
        }
        if before.can_apply {
            return Ok(PrepareThemeManagerResult {
                changed: false,
                before_version: before.version.clone(),
                support: before,
                steps: vec!["Theme Manager already has the editor apply entry point.".into()],
            });
        }
        let dump = self
            .shell(serial, &["dumpsys", "package", THEME_MANAGER_PACKAGE], Duration::from_secs(20), None)?
            .stdout_text();
        if !is_updated_system_app(&dump) {
            return Err(AppError::new(
                "unsupported",
                format!(
                    "Theme Manager {} is already this phone's factory build and has no editor apply entry point, so there is no update to remove.",
                    before.version.as_deref().unwrap_or("")
                ),
            ));
        }
        let out = self
            .shell(
                serial,
                &["pm", "uninstall-system-updates", THEME_MANAGER_PACKAGE],
                Duration::from_secs(120),
                cancel,
            )?
            .stdout_text();
        if !uninstall_succeeded(&out) {
            let detail = out
                .lines()
                .map(str::trim)
                .rfind(|line| !line.is_empty())
                .unwrap_or("no output");
            return Err(AppError::new(
                "prepare_failed",
                format!("Theme Manager's update could not be removed: {detail}"),
            ));
        }
        let mut ready = false;
        for _ in 0..15 {
            std::thread::sleep(Duration::from_millis(1000));
            if self.apply_activity_resolves(serial) {
                ready = true;
                break;
            }
        }
        let support = self.theme_manager_support(serial)?;
        if !ready || !support.can_apply {
            return Err(AppError::new(
                "unsupported",
                format!(
                    "Theme Manager was reverted to {} but its factory build has no editor apply entry point on this phone.",
                    support.version.as_deref().unwrap_or("the factory build")
                ),
            ));
        }
        let version = support.version.clone().unwrap_or_else(|| "the factory build".into());
        Ok(PrepareThemeManagerResult {
            changed: true,
            before_version: before.version,
            support,
            steps: vec![
                "Removed Theme Manager updates (factory build restored)".into(),
                format!("Theme Manager is now {version}"),
                "The editor apply entry point is available".into(),
            ],
        })
    }

    /// Apply a package with Theme Manager's editor entry point. Requires
    /// `support.can_apply`; the caller must have asked the user first.
    pub fn apply_theme(&self, serial: &str, local: &Path, support: &ThemeManagerSupport, cancel: Option<Arc<AtomicBool>>) -> AppResult<ApplyResult> {
        valid_serial(serial)?;
        if !support.can_apply {
            return Err(AppError::new(
                "unsupported",
                "This phone's Theme Manager has no editor apply entry point. Copy the package to the phone and apply it from Theme Manager instead.",
            ));
        }
        // adb's /sdcard is the owner's storage; Theme Manager also refuses to
        // apply in Second space, so another foreground user cannot work.
        let user = self
            .shell(serial, &["am", "get-current-user"], Duration::from_secs(10), None)
            .ok()
            .and_then(|o| o.stdout_text().trim().parse::<u32>().ok());
        if user.is_some_and(|u| u != 0) {
            return Err(AppError::new(
                "unsupported",
                "The phone is in another user or Second space. Switch back to the main user and try again.",
            ));
        }
        let mut steps = Vec::new();
        self.ensure_files_dir(serial)?;
        let bytes = self.push_to(serial, local, NEW_FLOW_PATH, cancel)?;
        steps.push(format!("Copied {bytes} bytes to {NEW_FLOW_PATH} (verified)"));
        let base = ["-n", APPLY_ACTIVITY, "-e", "api_called_from", "ThemeEditor"];
        let mut apply = base.to_vec();
        apply.extend_from_slice(&["-e", "theme_file_path", NEW_FLOW_PATH]);
        self.start(serial, &apply, "Apply theme")?;
        std::thread::sleep(Duration::from_millis(2000));
        let front = self
            .shell(serial, &["dumpsys activity activities | grep ResumedActivity"], Duration::from_secs(15), None)
            .map(|o| o.stdout_text())
            .unwrap_or_default();
        if picker_in_front(&front) {
            let _ = self.shell(serial, &["input", "keyevent", "KEYCODE_BACK"], Duration::from_secs(10), None);
            return Err(AppError::new(
                "apply_failed",
                "Theme Manager could not read the copied package and opened the file picker instead. Open Theme Manager once, then try again.",
            ));
        }
        steps.push("Asked Theme Manager to apply the theme".into());
        Ok(ApplyResult { remote_path: NEW_FLOW_PATH.into(), bytes, steps })
    }

    /// Theme Manager runs under a shared uid that must own its external files
    /// folder. A folder created by adb's shell user may not be readable by it,
    /// so let Theme Manager create the folder itself when it is missing.
    fn ensure_files_dir(&self, serial: &str) -> AppResult<()> {
        let exists = |adb: &Self| {
            adb.shell(serial, &[&format!("[ -d {FILES_DIR} ] && echo yes")], Duration::from_secs(10), None)
                .map(|o| o.stdout_text().trim() == "yes")
                .unwrap_or(false)
        };
        if exists(self) {
            return Ok(());
        }
        let _ = self.shell(
            serial,
            &["monkey", "-p", THEME_MANAGER_PACKAGE, "-c", "android.intent.category.LAUNCHER", "1"],
            Duration::from_secs(20),
            None,
        );
        for _ in 0..15 {
            std::thread::sleep(Duration::from_millis(1000));
            if exists(self) {
                return Ok(());
            }
        }
        Err(AppError::new(
            "apply_failed",
            "Theme Manager has not created its storage folder yet. Open Theme Manager on the phone once, then try again.",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_uninstall_output() {
        assert!(uninstall_succeeded("Uninstalling updates to com.android.thememanager...\nSuccess\n"));
        assert!(!uninstall_succeeded("Failure [DELETE_FAILED_INTERNAL_ERROR]"));
        assert!(!uninstall_succeeded(""));
    }

    #[test]
    fn detects_updated_build_and_picker() {
        assert!(is_updated_system_app("    codePath=/data/app/~~x==/com.android.thememanager-y==\n    codePath=/product/app/MIUIThemeManagerGlobal\n"));
        assert!(!is_updated_system_app("    codePath=/product/app/MIUIThemeManagerGlobal\n"));
        assert!(picker_in_front("  topResumedActivity=ActivityRecord{1 u0 com.google.android.documentsui/com.android.documentsui.picker.PickActivity t9}"));
        assert!(!picker_in_front("  topResumedActivity=ActivityRecord{1 u0 com.mi.android.globallauncher/com.miui.home.launcher.Launcher t2}"));
    }

    #[test]
    fn parses_am_and_resolve_output() {
        assert!(am_failed("Starting: Intent { act=android.intent.action.VIEW }").is_none());
        assert!(am_failed("Starting: Intent { cmp=x }\nError type 3\nError: Activity class {x} does not exist.").is_some());
        // Delivered to the running instance still reaches Theme Manager.
        assert!(am_failed("Warning: Activity not started, intent has been delivered to currently running top-most instance.").is_none());
        assert!(resolves("com.android.thememanager/.activity.ThemeSettingsActivity\n", "ThemeSettingsActivity"));
        assert!(!resolves("No activity found\n", "ApplyThemeForScreenshot"));
        assert!(valid_store_id("c44fe8c3-598d-4205-8bd7-8b79a462d214").is_ok());
        assert!(valid_store_id("x;rm -rf /").is_err());
        assert!(valid_store_id("").is_err());
    }
}

/// Read-only check against a real phone:
/// `MTS_ADB=<adb.exe> MTS_SERIAL=<serial> cargo test theme_apply::live -- --ignored --nocapture`
#[cfg(test)]
mod live {
    use super::*;

    #[test]
    #[ignore]
    fn detects_support_on_device() {
        let (Ok(path), Ok(serial)) = (std::env::var("MTS_ADB"), std::env::var("MTS_SERIAL")) else { return };
        let adb = Adb { path: path.into(), log: Arc::new(|_| {}) };
        let support = adb.theme_manager_support(&serial).unwrap();
        println!("{support:?}");
        assert!(support.installed);
    }

    #[test]
    #[ignore]
    fn prepares_and_applies_package_on_device() {
        let (Ok(path), Ok(serial), Ok(mtz)) =
            (std::env::var("MTS_ADB"), std::env::var("MTS_SERIAL"), std::env::var("MTS_MTZ"))
        else {
            return;
        };
        let adb = Adb { path: path.into(), log: Arc::new(|_| {}) };
        let prepared = adb.prepare_theme_manager(&serial, None).unwrap();
        assert!(prepared.support.can_apply);
        let result = adb.apply_theme(&serial, Path::new(&mtz), &prepared.support, None).unwrap();
        println!("{result:?}");
    }
}
