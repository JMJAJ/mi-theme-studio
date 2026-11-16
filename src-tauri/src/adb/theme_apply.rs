//! Opening and applying themes through Theme Manager on the phone.
//!
//! Applying uses the same protocol as Xiaomi's own desktop theme editor: the
//! package is pushed to a path Theme Manager reads and its
//! `ApplyThemeForScreenshot` activity is started with `api_called_from =
//! ThemeEditor`. That activity only exists in some Theme Manager builds
//! (verified absent in global 3.0.5.19 on HyperOS 3), so support is detected
//! first and the apply call is refused when it is missing. Nothing here needs
//! root, changes system settings, or touches Theme Manager's private data.

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
const NEW_FLOW_INIT_PATH: &str = "/sdcard/Download/auto/temp.mtz";
const NEW_FLOW_PATH: &str = "/sdcard/Android/data/com.android.thememanager/files/temp.mtz";
const LEGACY_PATH: &str = "/sdcard/temp.mtz";

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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub remote_path: String,
    pub bytes: u64,
    pub steps: Vec<String>,
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
    pub fn theme_manager_support(&self, serial: &str) -> AppResult<ThemeManagerSupport> {
        valid_serial(serial)?;
        let dump = self
            .shell(serial, &["dumpsys", "package", THEME_MANAGER_PACKAGE], Duration::from_secs(20), None)?
            .stdout_text();
        let installed = dump.contains(&format!("Package [{THEME_MANAGER_PACKAGE}]"));
        if !installed {
            return Ok(ThemeManagerSupport { installed, version: None, can_apply: false, two_step: false, can_open_store: false });
        }
        let apply = self
            .shell(serial, &["cmd", "package", "resolve-activity", "--brief", "--components", "-n", APPLY_ACTIVITY], Duration::from_secs(15), None)
            .map(|o| resolves(&o.stdout_text(), "ApplyThemeForScreenshot"))
            .unwrap_or(false);
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
        let mut steps = Vec::new();
        let base = ["-n", APPLY_ACTIVITY, "-e", "api_called_from", "ThemeEditor"];
        if support.two_step {
            let _ = self.shell(serial, &["rm", "-f", NEW_FLOW_INIT_PATH], Duration::from_secs(10), cancel.clone());
            let mut init = base.to_vec();
            init.extend_from_slice(&["-e", "theme_file_path", NEW_FLOW_INIT_PATH, "-e", "ver2_step", "ver2_step_init"]);
            self.start(serial, &init, "Prepare Theme Manager")?;
            steps.push("Prepared Theme Manager".into());
            std::thread::sleep(Duration::from_millis(1000));
            let bytes = self.push_to(serial, local, NEW_FLOW_PATH, cancel)?;
            steps.push(format!("Copied {bytes} bytes to {NEW_FLOW_PATH} (verified)"));
            let mut apply = base.to_vec();
            apply.extend_from_slice(&["-e", "theme_file_path", NEW_FLOW_PATH, "-e", "ver2_step", "ver2_step_apply"]);
            self.start(serial, &apply, "Apply theme")?;
            steps.push("Asked Theme Manager to apply the theme".into());
            Ok(ApplyResult { remote_path: NEW_FLOW_PATH.into(), bytes, steps })
        } else {
            let bytes = self.push_to(serial, local, LEGACY_PATH, cancel)?;
            steps.push(format!("Copied {bytes} bytes to {LEGACY_PATH} (verified)"));
            let mut apply = base.to_vec();
            apply.extend_from_slice(&["-e", "theme_file_path", LEGACY_PATH]);
            self.start(serial, &apply, "Apply theme")?;
            steps.push("Asked Theme Manager to apply the theme".into());
            Ok(ApplyResult { remote_path: LEGACY_PATH.into(), bytes, steps })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
