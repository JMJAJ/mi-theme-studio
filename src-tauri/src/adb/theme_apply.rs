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
//!
//! The experimental AOD path (`apply_theme_permanent`) uses a separate
//! vulnerability to write the theme and a sticky validation blocker. It is
//! deliberately separate from the normal apply path and is guarded by an
//! explicit confirmation in the UI.

use super::{valid_serial, Adb, THEME_MANAGER_PACKAGE};
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::fs::File;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use zip::ZipArchive;

pub const APPLY_ACTIVITY: &str = "com.android.thememanager/com.android.thememanager.ApplyThemeForScreenshot";
/// Declared by Theme Manager builds that use the two-step (init/apply) flow.
pub const SUPPORT_MARKER: &str = "com.android.thememanager.support3.0";
/// Theme Manager can read its own external files directory without storage
/// permissions. A path such as `/sdcard/temp.mtz` instead opens DocumentsUI,
/// so the single-step flow must use this one too.
const NEW_FLOW_PATH: &str = "/sdcard/Android/data/com.android.thememanager/files/temp.mtz";
const FILES_DIR: &str = "/sdcard/Android/data/com.android.thememanager/files";
/// Stable copy used by the keep-alive loop; unlike temp.mtz it is not
/// overwritten by the next apply.
const KEEPALIVE_PATH: &str = "/sdcard/Android/data/com.android.thememanager/files/keep.mtz";
const KEEPALIVE_SCRIPT_PATH: &str = "/data/local/tmp/mts_keep_theme.sh";

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepAppliedResult {
    pub running: bool,
    pub bytes: u64,
    pub steps: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermanentApplyResult {
    /// `themeManagerAod` when Theme Manager copied the real files first;
    /// `aodFull` when AOD/System UI wrote real files and set the wallpaper.
    pub mode: String,
    pub blocker_verified: bool,
    pub steps: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AodRestoreResult {
    pub blocker_removed: bool,
    pub steps: Vec<String>,
}

const AOD_PACKAGE: &str = "com.miui.aod";
const AOD_PROVIDER_URI: &str = "content://com.miui.aod.settings";
const AOD_MAML_DIR: &str = "/sdcard/Download/mts_aod_maml";
const AOD_MAML_MANIFEST: &str = "/sdcard/Download/mts_aod_maml/content/manifest.xml";
const AOD_MAML_DRAWABLE: &str = "/sdcard/Download/mts_aod_maml/drawable";
const AOD_PARAM_PATH: &str = "/data/local/tmp/mts_aod_param.json";
/// The `theme_dir_name` is concatenated without canonicalisation; the extra
/// `..` segments escape the AOD app directory to shell-writable storage.
const AOD_PARAM_JSON: &str = r#"{"theme_style_info":{"theme_dir_name":"../../../../../../../../sdcard/Download/mts_aod_maml","theme_name":"Mi Theme Studio","theme_description":"Mi Theme Studio","theme_type":"maml","theme_identity":"mts"}}"#;
const AOD_BLOCKER_LINK: &str = "/data/system/theme/boots/bootanimation.zip";
const AOD_BLOCKER_DIR: &str = "/data/system/theme/boots";
const AOD_THEME_STAGING: &str = "/data/local/tmp/mts_theme";
const LOCK_XML_PATH: &str = "/data/system/theme_magic/users/0/wallpaper/data/lock.xml";
const LOCK_XML_STAGING: &str = "/data/local/tmp/mts_lock.xml";
const LOCK_MAML_DIR: &str = "/data/system/theme_magic/users/0/wallpaper/maml";
const LOCK_MAML_WALLPAPER: &str = "/data/system/theme_magic/users/0/wallpaper/maml/lock_wallpaper.jpg";
/// `ThemeCompatibility.isCompatibleResource()` refuses to open any theme ZIP
/// under `/data/system/theme/` while a theme file exists and this marker
/// directory does not. Without it `ThemeZipFile` silently ignores the copied
/// `icons` archive, so the launcher keeps its stock icons. Theme Manager
/// normally creates it; a phone whose theme directory was populated outside
/// Theme Manager may not have it.
const THEME_COMPAT_MARKER: &str = "/data/system/theme/compatibility-v12";
const AOD_KEEPALIVE_SCRIPT_PATH: &str = "/data/local/tmp/mts_aod_keep.sh";

/// Reapplies the staged package when the framework's periodic DRM reset
/// changes `/data/system/theme`. Runs as the adb shell user; no root.
pub fn keepalive_script() -> &'static str {
    include_str!("keepalive.sh")
}

/// Keep-alive for builds without the Theme Manager editor activity. It
/// re-runs the staged AOD full-apply manifest after a reset instead of trying
/// the missing ApplyThemeForScreenshot activity.
pub fn aod_keepalive_script() -> &'static str {
    include_str!("aod_keepalive.sh")
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

    /// Install a Xiaomi-signed Theme Manager APK as an update. This is the
    /// fallback for phones whose factory build (for example a preinstalled
    /// 3.0.5.19) has no editor apply entry point. The package manager enforces
    /// the OEM signature; `-d` allows a version downgrade to the factory APK.
    pub fn install_theme_manager_apk(
        &self,
        serial: &str,
        apk: &Path,
        cancel: Option<Arc<AtomicBool>>,
    ) -> AppResult<ThemeManagerSupport> {
        valid_serial(serial)?;
        let is_apk = apk.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("apk"));
        if !is_apk {
            return Err(AppError::invalid("Choose a Theme Manager .apk file."));
        }
        let size = std::fs::metadata(apk).map_err(|e| AppError::io("Could not read the APK", e))?.len();
        if size < 1024 * 1024 || size > 512 * 1024 * 1024 {
            return Err(AppError::invalid("That APK does not look like Theme Manager (unexpected size)."));
        }
        let local = apk.to_string_lossy().into_owned();
        let out = self.exec(
            &["-s", serial, "install", "-r", "-d", "-g", &local],
            Duration::from_secs(240),
            cancel,
            false,
        )?;
        let text = out.stdout_text();
        self.expect_ok(out, "adb install")?;
        if !text.contains("Success") {
            return Err(AppError::new(
                "install_failed",
                format!("The phone rejected the APK: {}", text.lines().last().unwrap_or("no output")),
            ));
        }
        let support = self.theme_manager_support(serial)?;
        if !support.installed || !support.can_apply {
            return Err(AppError::new(
                "unsupported",
                "The APK installed, but its Theme Manager still has no editor apply entry point.",
            ));
        }
        Ok(support)
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

    /// Copy the built package to the stable keep-alive path.
    pub fn stage_keepalive_theme(
        &self,
        serial: &str,
        local: &Path,
        cancel: Option<Arc<AtomicBool>>,
    ) -> AppResult<u64> {
        self.ensure_files_dir(serial)?;
        self.push_to(serial, local, KEEPALIVE_PATH, cancel)
    }

    /// Start the editor activity with the keep-alive copy.
    pub fn apply_keepalive_now(&self, serial: &str, cancel: Option<Arc<AtomicBool>>) -> AppResult<()> {
        let args = [
            "-n",
            APPLY_ACTIVITY,
            "-e",
            "api_called_from",
            "ThemeEditor",
            "-e",
            "theme_file_path",
            KEEPALIVE_PATH,
        ];
        let _ = cancel;
        self.start(serial, &args, "Apply theme").map(|_| ())
    }

    /// Install and start a detached shell loop that reapplies the staged theme
    /// after the framework's periodic DRM reset. The loop runs as the adb shell
    /// user, so it needs no root and survives adb disconnects (but not reboot).
    pub fn start_keepalive(
        &self,
        serial: &str,
        script_local: &Path,
        cancel: Option<Arc<AtomicBool>>,
    ) -> AppResult<()> {
        self.push_to(serial, script_local, KEEPALIVE_SCRIPT_PATH, cancel.clone())?;
        let _ = self.shell(serial, &["chmod", "755", KEEPALIVE_SCRIPT_PATH], Duration::from_secs(10), cancel.clone());
        self.kill_keepalive(serial);
        let command = format!("nohup sh {KEEPALIVE_SCRIPT_PATH} >/dev/null 2>&1 &");
        self.shell(serial, &[&command], Duration::from_secs(20), cancel)?;
        std::thread::sleep(Duration::from_millis(1200));
        if !self.keepalive_running(serial) {
            return Err(AppError::new(
                "keepalive",
                "The keep-alive loop did not stay running. Make sure USB debugging is still authorized and try again.",
            ));
        }
        Ok(())
    }

    pub fn start_aod_keepalive(
        &self,
        serial: &str,
        script_local: &Path,
        cancel: Option<Arc<AtomicBool>>,
    ) -> AppResult<()> {
        self.push_to(serial, script_local, AOD_KEEPALIVE_SCRIPT_PATH, cancel.clone())?;
        let _ = self.shell(
            serial,
            &["chmod", "755", AOD_KEEPALIVE_SCRIPT_PATH],
            Duration::from_secs(10),
            cancel.clone(),
        );
        self.kill_aod_keepalive(serial);
        let command = format!("nohup sh {AOD_KEEPALIVE_SCRIPT_PATH} >/dev/null 2>&1 &");
        self.shell(serial, &[&command], Duration::from_secs(20), cancel)?;
        std::thread::sleep(Duration::from_millis(1500));
        if !self.aod_keepalive_running(serial) {
            return Err(AppError::new(
                "keepalive",
                "The AOD keep-alive loop did not stay running. Apply the theme permanently first and keep USB debugging authorized.",
            ));
        }
        Ok(())
    }

    fn kill_aod_keepalive(&self, serial: &str) {
        if let Ok(out) = self.shell(
            serial,
            &["pgrep", "-f", "[m]ts_aod_keep.sh"],
            Duration::from_secs(10),
            None,
        ) {
            for pid in out.stdout_text().split_whitespace() {
                if pid.chars().all(|c| c.is_ascii_digit()) {
                    let _ = self.shell(serial, &["kill", "-9", pid], Duration::from_secs(10), None);
                }
            }
        }
    }

    pub fn aod_keepalive_running(&self, serial: &str) -> bool {
        self.shell(
            serial,
            &["pgrep", "-f", "[m]ts_aod_keep.sh"],
            Duration::from_secs(10),
            None,
        )
        .map(|out| !out.stdout_text().trim().is_empty())
        .unwrap_or(false)
    }

    fn kill_keepalive(&self, serial: &str) {
        if let Ok(out) = self.shell(
            serial,
            &["pgrep", "-f", "[m]ts_keep_theme.sh"],
            Duration::from_secs(10),
            None,
        ) {
            for pid in out.stdout_text().split_whitespace() {
                if pid.chars().all(|c| c.is_ascii_digit()) {
                    let _ = self.shell(serial, &["kill", "-9", pid], Duration::from_secs(10), None);
                }
            }
        }
    }

    pub fn stop_keepalive(&self, serial: &str) -> AppResult<()> {
        self.kill_keepalive(serial);
        self.kill_aod_keepalive(serial);
        Ok(())
    }

    pub fn keepalive_running(&self, serial: &str) -> bool {
        self.shell(
            serial,
            &["pgrep", "-f", "[m]ts_keep_theme.sh"],
            Duration::from_secs(10),
            None,
        )
        .map(|out| !out.stdout_text().trim().is_empty())
        .unwrap_or(false)
            || self.aod_keepalive_running(serial)
    }

    // ----- AOD permanent apply ------------------------------------------------

    /// The AOD MAML exploit needs a package that exposes `getAodThumbnail`
    /// and a shell that can write secure settings. Both are checked before
    /// anything on the phone is changed.
    fn aod_available(&self, serial: &str) -> AppResult<bool> {
        valid_serial(serial)?;
        let packages = self
            .shell(serial, &["pm", "list", "packages", AOD_PACKAGE], Duration::from_secs(15), None)?
            .stdout_text();
        if !packages.lines().any(|line| line.trim() == format!("package:{AOD_PACKAGE}")) {
            return Ok(false);
        }
        let call = self.shell(
            serial,
            &["content", "call", "--uri", AOD_PROVIDER_URI, "--method", "getAodThumbnail"],
            Duration::from_secs(25),
            None,
        );
        Ok(call.map(|out| out.stdout_text().contains("Result:")).unwrap_or(false))
    }

    fn remote_mkdir(&self, serial: &str, dir: &str, cancel: Option<Arc<AtomicBool>>) -> AppResult<()> {
        let command = format!("mkdir -p '{dir}'");
        self.shell(serial, &[&command], Duration::from_secs(15), cancel).map(|_| ())
    }

    fn push_bytes(
        &self,
        serial: &str,
        bytes: &[u8],
        remote: &str,
        staging: &Path,
        cancel: Option<Arc<AtomicBool>>,
    ) -> AppResult<u64> {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        std::fs::create_dir_all(staging).map_err(|e| AppError::io("Could not create the AOD staging folder", e))?;
        let local = staging.join(format!("aod-push-{stamp}.tmp"));
        std::fs::write(&local, bytes).map_err(|e| AppError::io("Could not write a staging file", e))?;
        let result = self.push_to(serial, &local, remote, cancel);
        let _ = std::fs::remove_file(&local);
        result
    }

    fn set_aod_style(
        &self,
        serial: &str,
        manifest: &str,
        staging: &Path,
        cancel: Option<Arc<AtomicBool>>,
    ) -> AppResult<()> {
        self.remote_mkdir(serial, AOD_MAML_DIR, cancel.clone())?;
        self.push_bytes(serial, manifest.as_bytes(), AOD_MAML_MANIFEST, staging, cancel.clone())?;
        self.push_bytes(serial, &one_pixel_png()?, AOD_MAML_DRAWABLE, staging, cancel.clone())?;
        self.push_bytes(serial, AOD_PARAM_JSON.as_bytes(), AOD_PARAM_PATH, staging, cancel.clone())?;
        let set_param = format!("settings put secure maml \"$(cat {AOD_PARAM_PATH})\"");
        self.shell(serial, &[&set_param], Duration::from_secs(20), cancel.clone())?;
        self.shell(
            serial,
            &["settings", "put", "secure", "aod_category_name", "maml"],
            Duration::from_secs(15),
            cancel.clone(),
        )?;
        let category = self
            .shell(serial, &["settings", "get", "secure", "aod_category_name"], Duration::from_secs(15), cancel)?;
        if category.stdout_text().trim() != "maml" {
            return Err(AppError::new(
                "unsupported",
                "The phone did not accept the AOD category setting. Enable always-on display and try again.",
            ));
        }
        Ok(())
    }

    fn trigger_aod(&self, serial: &str) -> AppResult<()> {
        self.shell(
            serial,
            &["input keyevent KEYCODE_WAKEUP; sleep 1; input keyevent KEYCODE_SLEEP; sleep 4"],
            Duration::from_secs(20),
            None,
        )
        .map(|_| ())
    }

    fn aod_blocker_verified(&self, serial: &str) -> bool {
        let dir = self
            .shell(serial, &["ls", "-ld", AOD_BLOCKER_DIR], Duration::from_secs(15), None)
            .map(|out| out.stdout_text())
            .unwrap_or_default();
        let link = self
            .shell(serial, &["ls", "-l", AOD_BLOCKER_LINK], Duration::from_secs(15), None)
            .map(|out| out.stdout_text())
            .unwrap_or_default();
        dir.contains('t') && link.contains("-> /dev/input/event0")
    }

    fn install_aod_blocker(
        &self,
        serial: &str,
        staging: &Path,
        cancel: Option<Arc<AtomicBool>>,
    ) -> AppResult<PermanentApplyResult> {
        if !self.aod_available(serial)? {
            return Err(AppError::new(
                "unsupported",
                "This phone's AOD provider does not expose the MAML preview method. The permanent blocker is not available.",
            ));
        }
        let mut steps = vec!["AOD provider is available".to_string()];
        self.set_aod_style(serial, &aod_blocker_manifest(), staging, cancel.clone())?;
        steps.push("Wrote the sticky boot-animation blocker manifest".into());
        self.trigger_aod(serial)?;
        steps.push("Asked AOD to run the manifest".into());
        let verified = self.aod_blocker_verified(serial);
        steps.push(if verified {
            "Verified: /data/system/theme/boots is sticky and bootanimation.zip points at /dev/input/event0".into()
        } else {
            "The blocker could not be verified; check that always-on display is enabled".into()
        });
        if !verified {
            return Err(AppError::new(
                "verify",
                "The permanent blocker could not be verified on the phone. Enable always-on display, keep the screen off for a few seconds, then try again.",
            ));
        }
        Ok(PermanentApplyResult { mode: "aodBlocker".into(), blocker_verified: true, steps })
    }

    /// Apply the built package through Theme Manager when it has the editor
    /// entry point. Otherwise apply every real file through AOD/System UI,
    /// set the system wallpaper through the same MAML context, trigger the
    /// framework theme reload, and finish with the sticky validation blocker.
    pub fn apply_theme_permanent(
        &self,
        serial: &str,
        local: &Path,
        support: &ThemeManagerSupport,
        staging: &Path,
        cancel: Option<Arc<AtomicBool>>,
    ) -> AppResult<PermanentApplyResult> {
        valid_serial(serial)?;
        if !self.aod_available(serial)? {
            return Err(AppError::new(
                "unsupported",
                "This phone does not expose the AOD MAML path needed for a permanent apply.",
            ));
        }
        // Theme Manager 3.0.5.16 applies a uiVersion 17 + lockstyle package only
        // partially (icons). When the package has a lockstyle archive, use the
        // AOD full apply so the MAML lock screen, effect assets and wallpaper
        // are installed as real files instead.
        if support.can_apply && !theme_requires_maml(local)? {
            let applied = self.apply_theme(serial, local, support, cancel.clone())?;
            let mut steps = applied.steps;
            steps.push("Theme Manager copied the theme files".into());
            let blocker = self.install_aod_blocker(serial, staging, cancel)?;
            steps.extend(blocker.steps);
            return Ok(PermanentApplyResult {
                mode: "themeManagerAod".into(),
                blocker_verified: blocker.blocker_verified,
                steps,
            });
        }
        self.apply_theme_aod(serial, local, staging, cancel)
    }

    /// Write the real theme files from /data/local/tmp through AOD/System UI,
    /// set the wallpaper through WallpaperManager from the MAML context, and
    /// make the framework reload the theme. This is the no-designer path.
    fn apply_theme_aod(
        &self,
        serial: &str,
        local: &Path,
        staging: &Path,
        cancel: Option<Arc<AtomicBool>>,
    ) -> AppResult<PermanentApplyResult> {
        let (temp, entries, wallpaper) = extract_aod_theme(local, staging)?;
        let result = (|| {
            let mut steps = vec!["Theme package contains a MAML lockstyle; using the AOD full-apply path".to_string()];
            self.shell(
                serial,
                &[&format!("rm -rf '{AOD_THEME_STAGING}'")],
                Duration::from_secs(20),
                cancel.clone(),
            )?;
            let local_string = temp.to_string_lossy().into_owned();
            let push = self.exec(
                &["-s", serial, "push", &local_string, AOD_THEME_STAGING],
                Duration::from_secs(240),
                cancel.clone(),
                false,
            )?;
            self.expect_ok(push, "adb push theme")?;
            self.shell(
                serial,
                &[&format!(
                    "find '{AOD_THEME_STAGING}' -type d -exec chmod 755 {{}} \\; ; \
                     find '{AOD_THEME_STAGING}' -type f -exec chmod 644 {{}} \\;"
                )],
                Duration::from_secs(60),
                cancel.clone(),
            )?;
            steps.push(format!(
                "Copied {} real theme components to {AOD_THEME_STAGING}",
                entries.len()
            ));
            let has_lockscreen = entries.iter().any(|(_, destination)| destination == "lockscreen");
            let mut lock_xml = false;
            if has_lockscreen {
                let current = self.shell(
                    serial,
                    &["cat", LOCK_XML_PATH],
                    Duration::from_secs(20),
                    cancel.clone(),
                )?;
                let current = current.stdout_text();
                if !current.trim().is_empty() {
                    let updated = current
                        .replace("type=\"image\"", "type=\"maml\"")
                        .replace(
                            "com.miui.miwallpaper/com.miui.miwallpaper.wallpaperservice.ImageWallpaper",
                            "com.miui.miwallpaper/com.miui.miwallpaper.MiWallpaper",
                        )
                        .replace(
                            "/wallpaper/image/lock_wallpaper.jpg",
                            "/wallpaper/maml/lock_wallpaper.jpg",
                        );
                    self.push_bytes(serial, updated.as_bytes(), LOCK_XML_STAGING, staging, cancel.clone())?;
                    lock_xml = true;
                    steps.push("Prepared the MAML lock-screen metadata and wallpaper".into());
                }
            }
            let has_lock_wallpaper = temp.join("wallpaper/default_lock_wallpaper.jpg").is_file();
            let manifest = aod_full_manifest(&entries, wallpaper.as_deref(), lock_xml, has_lock_wallpaper);
            self.set_aod_style(serial, &manifest, staging, cancel.clone())?;
            steps.push("Wrote the AOD full-apply manifest and category".into());
            self.trigger_aod(serial)?;
            steps.push("Asked AOD to copy the files, set wallpaper and reload the theme".into());
            if lock_xml {
                self.set_aod_style(
                    serial,
                    &aod_lockscreen_manifest(has_lock_wallpaper),
                    staging,
                    cancel.clone(),
                )?;
                self.trigger_aod(serial)?;
                steps.push("Installed the MAML lock-screen archive and wallpaper in a second AOD pass".into());
            }
            let _ = self.shell(
                serial,
                &["sleep 15; am force-stop com.android.systemui; am force-stop com.miui.home; am force-stop com.mi.android.globallauncher; am force-stop com.android.settings; am force-stop com.android.contacts; am force-stop com.android.mms; am force-stop com.android.deskclock; am start -a android.intent.action.MAIN -c android.intent.category.HOME; sleep 5; settings put system clock_changed_time_2x4 \"$(date +%s%3N)\"; o=$(settings get system resident_timezone); a=$(settings get system auto_dual_clock); settings put system resident_timezone America/New_York; settings put system auto_dual_clock 1; sleep 3; settings put system auto_dual_clock 0; sleep 3; if [ \"$o\" = \"null\" ]; then settings delete system resident_timezone; else settings put system resident_timezone \"$o\"; fi; settings put system auto_dual_clock \"$a\"; sleep 2"],
                Duration::from_secs(60),
                cancel.clone(),
            );
            steps.push("Restarted System UI and cold-started the launcher after the theme copy".into());
            steps.push(
                "Home icons: the launcher reads /data/system/theme/icons itself and regenerates its icon bitmaps on every process start, so an empty /data/system/theme_magic/customized_icons is expected".into(),
            );
            steps.push(
                "Home clock: asked the launcher to refresh its clock backup by toggling the dual-clock setting. If the widget is still stock, the launcher's private app_clock_bak cache is missing; remove and re-add the clock from the launcher widget picker, or restore the launcher data from backup.".into(),
            );
            steps.push(
                "A clock that is a MAML widget (HyperOS 3 'Default classic clock') is a different widget: it only applies /data/system/theme/clock_2x4 when it was provisioned by Theme Manager (addSource 1011), so re-add the clock from the launcher widget picker if the home screen shows the stock one".into(),
            );
            if lock_xml {
                steps.push("Reboot the phone once to make the wallpaper service load the MAML lock screen".into());
            }
            let verified = self.aod_blocker_verified(serial);
            steps.push(if verified {
                "Verified: /data/system/theme/boots is sticky and bootanimation.zip points at /dev/input/event0".into()
            } else {
                "The sticky blocker could not be verified; enable always-on display and try again".into()
            });
            if !verified {
                return Err(AppError::new(
                    "verify",
                    "The AOD full apply ran, but the sticky blocker could not be verified. Enable always-on display, keep the screen off for a few seconds, then try again.",
                ));
            }
            Ok(PermanentApplyResult { mode: "aodFull".into(), blocker_verified: true, steps })
        })();
        let _ = std::fs::remove_dir_all(&temp);
        result
    }

    /// Undo the AOD category and remove the sticky blocker. The theme files
    /// themselves are not reverted; apply another theme afterwards.
    pub fn restore_aod(&self, serial: &str, staging: &Path) -> AppResult<AodRestoreResult> {
        valid_serial(serial)?;
        let mut steps = Vec::new();
        if self.aod_available(serial)? {
            self.set_aod_style(serial, &aod_cleanup_manifest(), staging, None)?;
            self.trigger_aod(serial)?;
            steps.push("Asked AOD to remove the sticky blocker".into());
        } else {
            steps.push("AOD provider is unavailable; skipping the manifest cleanup".into());
        }
        self.shell(
            serial,
            &["settings", "put", "secure", "aod_category_name", "sun"],
            Duration::from_secs(15),
            None,
        )?;
        let _ = self.shell(
            serial,
            &["settings", "delete", "secure", "maml"],
            Duration::from_secs(15),
            None,
        );
        steps.push("Restored the AOD category to sun".into());
        let remaining = self
            .shell(serial, &["ls", "-l", AOD_BLOCKER_LINK], Duration::from_secs(15), None)
            .map(|out| out.stdout_text())
            .unwrap_or_default();
        let removed = !remaining.contains("-> /dev/input/event0");
        steps.push(if removed { "Blocker is no longer present".into() } else { "The blocker path still exists; remove it from the AOD manifest or re-apply a theme".into() });
        Ok(AodRestoreResult { blocker_removed: removed, steps })
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

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Extract an .mtz locally and return the theme components that Theme Manager
/// A lockstyle archive is the HyperOS 3 MAML lock-screen format. Theme Manager
/// 3.0.5.16's designer apply does not install it, so these packages must go
/// through the full AOD path even when the editor entry point is present.
fn theme_requires_maml(local: &Path) -> AppResult<bool> {
    let file = File::open(local).map_err(|e| AppError::io("Could not open the theme package", e))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|e| AppError::new("package", format!("Could not read the theme package: {e}")))?;
    Ok(archive.by_name("lockstyle").is_ok() || archive.by_name("advance/manifest.xml").is_ok())
}

/// applies: top-level files plus the two wallpaper images. `source` is relative
/// to the staging directory; `destination` is relative to /data/system/theme.
fn extract_aod_theme(
    local: &Path,
    staging: &Path,
) -> AppResult<(PathBuf, Vec<(String, String)>, Option<String>)> {
    let file = File::open(local).map_err(|e| AppError::io("Could not open the theme package", e))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|e| AppError::new("package", format!("Could not read the theme package: {e}")))?;
    std::fs::create_dir_all(staging).map_err(|e| AppError::io("Could not create the AOD staging folder", e))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = staging.join(format!("aod-full-{stamp}"));
    std::fs::create_dir_all(&dir).map_err(|e| AppError::io("Could not create the AOD staging folder", e))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| AppError::new("package", format!("Could not read a theme entry: {e}")))?;
        let name = entry
            .name()
            .map_err(|e| AppError::new("package", format!("Could not read a theme entry name: {e}")))?
            .to_string();
        let relative = Path::new(&name);
        if relative.is_absolute()
            || relative
                .components()
                .any(|part| matches!(part, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
        {
            return Err(AppError::new("package", format!("The theme contains an unsafe path: {name}")));
        }
        let output = dir.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&output).map_err(|e| AppError::io("Could not create a theme folder", e))?;
            continue;
        }
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent).map_err(|e| AppError::io("Could not create a theme folder", e))?;
        }
        let mut handle = File::create(&output).map_err(|e| AppError::io("Could not write a theme file", e))?;
        std::io::copy(&mut entry, &mut handle).map_err(|e| AppError::io("Could not extract a theme file", e))?;
    }
    let mut entries = Vec::new();
    for item in std::fs::read_dir(&dir).map_err(|e| AppError::io("Could not list the extracted theme", e))? {
        let item = item.map_err(|e| AppError::io("Could not list the extracted theme", e))?;
        let name = item.file_name().to_string_lossy().into_owned();
        if matches!(name.as_str(), "description.xml" | "rights" | "preview" | "aod" | "boots") {
            continue;
        }
        let path = item.path();
        if path.is_file() {
            if name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
            {
                // Theme Manager 3.0.5.19 names the MAML archive `lockstyle`;
                // the theme resource slot is still `/data/system/theme/lockscreen`.
                let destination = if name == "lockstyle" { "lockscreen".to_string() } else { name.clone() };
                entries.push((name, destination));
            }
            continue;
        }
        if name == "wallpaper" {
            for (file, destination) in [
                ("default_wallpaper.jpg", "wallpaper"),
                ("default_lock_wallpaper.jpg", "lock_wallpaper"),
            ] {
                if path.join(file).is_file() {
                    entries.push((format!("wallpaper/{file}"), destination.to_string()));
                }
            }
        }
    }
    entries.sort();
    if entries.is_empty() {
        return Err(AppError::new(
            "package",
            "The theme has no applicable top-level files (icons, lockscreen, wallpaper, etc.).",
        ));
    }
    let wallpaper = entries
        .iter()
        .find(|(_, destination)| destination == "wallpaper")
        .map(|(source, _)| source.clone());
    Ok((dir, entries, wallpaper))
}

/// Build the AOD manifest. The first block gets a Context through the MAML
/// object variable `__objContext`, sets the wallpaper, and triggers the same
/// configuration-change + broadcast sequence Theme Manager uses after an apply.
/// The rest copies every real theme file and installs the sticky blocker.
fn aod_full_manifest(
    entries: &[(String, String)],
    wallpaper: Option<&str>,
    lock_xml: bool,
    lock_wallpaper: bool,
) -> String {
    let mut commands = Vec::new();
    commands.push(
        "<FieldCommand targetType=\"var\" target=\"__objContext\" field=\"mContext\" method=\"get\" return=\"mts_ctx\" returnType=\"string\"/>".to_string(),
    );
    commands.push(
        "<MethodCommand targetType=\"var\" target=\"mts_ctx\" method=\"getSystemService\" params=\"'wallpaper'\" paramTypes=\"java.lang.String\" return=\"mts_wm\" returnType=\"string\"/>".to_string(),
    );
    if let Some(wallpaper) = wallpaper {
        commands.push(format!(
            "<MethodCommand class=\"android.graphics.BitmapFactory\" method=\"decodeFile\" params=\"'{}/{wallpaper}'\" paramTypes=\"java.lang.String\" return=\"mts_bmp\" returnType=\"string\"/>",
            AOD_THEME_STAGING
        ));
        commands.push(
            "<MethodCommand targetType=\"var\" target=\"mts_wm\" method=\"setBitmap\" params=\"'mts_bmp'\" paramTypes=\"android.graphics.Bitmap\"/>".to_string(),
        );
    }
    // The framework only opens `/data/system/theme/<component>` ZIPs when the
    // v12 compatibility marker exists. `mkdir` throws when it is already there;
    // MAML keeps running the remaining commands, which is what we want.
    commands.push(os_cmd("mkdir", &[(THEME_COMPAT_MARKER, false), ("493", true)]));
    commands.push(os_cmd("chmod", &[(THEME_COMPAT_MARKER, false), ("493", true)]));
    for (index, (source, destination)) in entries.iter().enumerate() {
        let source = format!("{AOD_THEME_STAGING}/{source}");
        let destination = format!("/data/system/theme/{destination}");
        let backup = format!("/data/system/theme/.mts_bak_{}", destination.rsplit('/').next().unwrap_or("part"));
        let variable = format!("mts_{index}");
        commands.push(os_cmd("unlink", &[(backup.as_str(), false)]));
        commands.push(os_cmd(
            "rename",
            &[(destination.as_str(), false), (backup.as_str(), false)],
        ));
        commands.push(format!(
            "<MethodCommand class=\"android.system.Os\" method=\"open\" params=\"'{}',0,0\" paramTypes=\"java.lang.String,int,int\" return=\"mts_in_{variable}\" returnType=\"string\"/>",
            xml_escape(&source)
        ));
        commands.push(format!(
            "<MethodCommand class=\"android.system.Os\" method=\"open\" params=\"'{}',577,420\" paramTypes=\"java.lang.String,int,int\" return=\"mts_out_{variable}\" returnType=\"string\"/>",
            xml_escape(&destination)
        ));
        commands.push(format!(
            "<MethodCommand class=\"android.os.FileUtils\" method=\"copy\" params=\"'mts_in_{variable}','mts_out_{variable}'\" paramTypes=\"java.io.FileDescriptor,java.io.FileDescriptor\"/>"
        ));
        commands.push(format!(
            "<MethodCommand class=\"android.system.Os\" method=\"close\" params=\"'mts_in_{variable}'\" paramTypes=\"java.io.FileDescriptor\"/>"
        ));
        commands.push(format!(
            "<MethodCommand class=\"android.system.Os\" method=\"close\" params=\"'mts_out_{variable}'\" paramTypes=\"java.io.FileDescriptor\"/>"
        ));
        // `Os.open(..., 577, 420)` is filtered through the process umask. In the
        // System UI process that umask turns 0644 into 0600, and every other app
        // (the launcher included) then fails to read the theme file and silently
        // falls back to stock art. The explicit chmod is what makes the copy
        // usable; without it icons revert the next time the launcher re-resolves.
        commands.push(os_cmd("chmod", &[(&destination, false), ("420", true)]));
    }
    if lock_xml {
        commands.push(os_cmd("mkdir", &[(LOCK_MAML_DIR, false), ("511", true)]));
        commands.push(os_cmd("unlink", &[("/data/system/theme_magic/users/0/wallpaper/data/.mts_bak_lock.xml", false)]));
        commands.push(os_cmd(
            "rename",
            &[
                (LOCK_XML_PATH, false),
                ("/data/system/theme_magic/users/0/wallpaper/data/.mts_bak_lock.xml", false),
            ],
        ));
        commands.push(format!(
            "<MethodCommand class=\"android.system.Os\" method=\"open\" params=\"'{}',0,0\" paramTypes=\"java.lang.String,int,int\" return=\"mts_lock_in\" returnType=\"string\"/>",
            LOCK_XML_STAGING
        ));
        commands.push(format!(
            "<MethodCommand class=\"android.system.Os\" method=\"open\" params=\"'{}',577,438\" paramTypes=\"java.lang.String,int,int\" return=\"mts_lock_out\" returnType=\"string\"/>",
            LOCK_XML_PATH
        ));
        commands.push(
            "<MethodCommand class=\"android.os.FileUtils\" method=\"copy\" params=\"'mts_lock_in','mts_lock_out'\" paramTypes=\"java.io.FileDescriptor,java.io.FileDescriptor\"/>".to_string(),
        );
        commands.push(
            "<MethodCommand class=\"android.system.Os\" method=\"close\" params=\"'mts_lock_in'\" paramTypes=\"java.io.FileDescriptor\"/>".to_string(),
        );
        commands.push(
            "<MethodCommand class=\"android.system.Os\" method=\"close\" params=\"'mts_lock_out'\" paramTypes=\"java.io.FileDescriptor\"/>".to_string(),
        );
        commands.push(os_cmd("chmod", &[(LOCK_XML_PATH, false), ("438", true)]));
    }
    if lock_wallpaper {
        commands.push(format!(
            "<MethodCommand class=\"android.system.Os\" method=\"open\" params=\"'{}/wallpaper/default_lock_wallpaper.jpg',0,0\" paramTypes=\"java.lang.String,int,int\" return=\"mts_lockwp_in\" returnType=\"string\"/>",
            AOD_THEME_STAGING
        ));
        commands.push(format!(
            "<MethodCommand class=\"android.system.Os\" method=\"open\" params=\"'{}',577,436\" paramTypes=\"java.lang.String,int,int\" return=\"mts_lockwp_out\" returnType=\"string\"/>",
            LOCK_MAML_WALLPAPER
        ));
        commands.push(
            "<MethodCommand class=\"android.os.FileUtils\" method=\"copy\" params=\"'mts_lockwp_in','mts_lockwp_out'\" paramTypes=\"java.io.FileDescriptor,java.io.FileDescriptor\"/>".to_string(),
        );
        commands.push(
            "<MethodCommand class=\"android.system.Os\" method=\"close\" params=\"'mts_lockwp_in'\" paramTypes=\"java.io.FileDescriptor\"/>".to_string(),
        );
        commands.push(
            "<MethodCommand class=\"android.system.Os\" method=\"close\" params=\"'mts_lockwp_out'\" paramTypes=\"java.io.FileDescriptor\"/>".to_string(),
        );
        commands.push(os_cmd("chmod", &[(LOCK_MAML_WALLPAPER, false), ("436", true)]));
    }
    // Icon caches. `/data/system/theme_magic/customized_icons/` is owned by uid
    // 6101 while this manifest runs as System UI, so these two calls cannot
    // populate it; they are kept because they are cheap and remain correct for
    // builds where System UI *is* allowed to prime the cache.
    commands.push(
        "<MethodCommand class=\"miui.content.res.IconCustomizer\" method=\"clearCustomizedIcons\" params=\"''\" paramTypes=\"java.lang.String\"/>".to_string(),
    );
    commands.push(
        "<MethodCommand class=\"miui.content.res.IconCustomizer\" method=\"prepareCustomizedIcons\" params=\"'mts_ctx','mts_null'\" paramTypes=\"android.content.Context,miui.content.res.IconCustomizer$CustomizedIconsListener\"/>".to_string(),
    );
    // Legacy `ConfigableGadget` clock bookkeeping: this is the path that feeds
    // `app_clock_bak` from `/data/system/theme/clock_2x4` for a clock *gadget*.
    // The HyperOS 3 launcher's MAML clock widget is a different widget and is
    // gated on `addSource == 1011`, so it needs the picker instead.
    commands.push(
        "<MethodCommand targetType=\"ctor\" class=\"miui.content.res.ThemeRuntimeManager\" params=\"'mts_ctx'\" paramTypes=\"android.content.Context\" return=\"mts_rt\" returnType=\"string\"/>".to_string(),
    );
    commands.push(
        "<MethodCommand targetType=\"var\" target=\"mts_rt\" method=\"markGadgetUpdated\"/>".to_string(),
    );
    commands.push(
        "<MethodCommand class=\"android.content.res.MiuiConfiguration\" method=\"sendThemeConfigurationChangeMsg\" params=\"268466329\" paramTypes=\"long\"/>".to_string(),
    );
    commands.push(
        "<IntentCommand type=\"broadcast\" action=\"miui.intent.action.ACTION_THEME_CHANGED\"/>".to_string(),
    );
    commands.extend(aod_blocker_commands());
    let body = commands
        .iter()
        .map(|command| format!("        {command}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n\
<Aod frameRate=\"30\" screenWidth=\"1080\" version=\"1\">\n\
  <Image name=\"mts_img\" x=\"0\" y=\"0\" w=\"1\" h=\"1\" src=\"drawable\">\n\
    <Triggers>\n\
      <Trigger action=\"init\">\n{body}\n      </Trigger>\n\
    </Triggers>\n\
  </Image>\n\
</Aod>\n"
    )
}

/// A separate short AOD pass for the lockscreen. Keeping it out of the long
/// full-apply manifest makes the copy deterministic: the MAML lock archive,
/// lock.xml type=maml and the MAML wallpaper slot are installed together, then
/// the caller reboots once so the wallpaper service reloads lock.xml.
fn aod_lockscreen_manifest(with_wallpaper: bool) -> String {
    let mut commands = Vec::new();
    commands.push(os_cmd("mkdir", &[(LOCK_MAML_DIR, false), ("511", true)]));
    commands.push(os_cmd(
        "unlink",
        &[("/data/system/theme_magic/users/0/wallpaper/data/.mts_bak_lock.xml", false)],
    ));
    commands.push(os_cmd(
        "rename",
        &[
            (LOCK_XML_PATH, false),
            ("/data/system/theme_magic/users/0/wallpaper/data/.mts_bak_lock.xml", false),
        ],
    ));
    commands.push(format!(
        "<MethodCommand class=\"android.system.Os\" method=\"open\" params=\"'{}',0,0\" paramTypes=\"java.lang.String,int,int\" return=\"mts_lock2_in\" returnType=\"string\"/>",
        LOCK_XML_STAGING
    ));
    commands.push(format!(
        "<MethodCommand class=\"android.system.Os\" method=\"open\" params=\"'{}',577,438\" paramTypes=\"java.lang.String,int,int\" return=\"mts_lock2_out\" returnType=\"string\"/>",
        LOCK_XML_PATH
    ));
    commands.push(
        "<MethodCommand class=\"android.os.FileUtils\" method=\"copy\" params=\"'mts_lock2_in','mts_lock2_out'\" paramTypes=\"java.io.FileDescriptor,java.io.FileDescriptor\"/>".to_string(),
    );
    commands.push(
        "<MethodCommand class=\"android.system.Os\" method=\"close\" params=\"'mts_lock2_in'\" paramTypes=\"java.io.FileDescriptor\"/>".to_string(),
    );
    commands.push(
        "<MethodCommand class=\"android.system.Os\" method=\"close\" params=\"'mts_lock2_out'\" paramTypes=\"java.io.FileDescriptor\"/>".to_string(),
    );
    commands.push(os_cmd("chmod", &[(LOCK_XML_PATH, false), ("438", true)]));
    if with_wallpaper {
        commands.push(format!(
            "<MethodCommand class=\"android.system.Os\" method=\"open\" params=\"'{}/wallpaper/default_lock_wallpaper.jpg',0,0\" paramTypes=\"java.lang.String,int,int\" return=\"mts_lockwp2_in\" returnType=\"string\"/>",
            AOD_THEME_STAGING
        ));
        commands.push(format!(
            "<MethodCommand class=\"android.system.Os\" method=\"open\" params=\"'{}',577,436\" paramTypes=\"java.lang.String,int,int\" return=\"mts_lockwp2_out\" returnType=\"string\"/>",
            LOCK_MAML_WALLPAPER
        ));
        commands.push(
            "<MethodCommand class=\"android.os.FileUtils\" method=\"copy\" params=\"'mts_lockwp2_in','mts_lockwp2_out'\" paramTypes=\"java.io.FileDescriptor,java.io.FileDescriptor\"/>".to_string(),
        );
        commands.push(
            "<MethodCommand class=\"android.system.Os\" method=\"close\" params=\"'mts_lockwp2_in'\" paramTypes=\"java.io.FileDescriptor\"/>".to_string(),
        );
        commands.push(
            "<MethodCommand class=\"android.system.Os\" method=\"close\" params=\"'mts_lockwp2_out'\" paramTypes=\"java.io.FileDescriptor\"/>".to_string(),
        );
        commands.push(os_cmd("chmod", &[(LOCK_MAML_WALLPAPER, false), ("436", true)]));
    }
    commands.push(
        "<MethodCommand class=\"android.content.res.MiuiConfiguration\" method=\"sendThemeConfigurationChangeMsg\" params=\"268466329\" paramTypes=\"long\"/>".to_string(),
    );
    let body = commands
        .iter()
        .map(|command| format!("        {command}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n\
<Aod frameRate=\"30\" screenWidth=\"1080\" version=\"1\">\n\
  <Image name=\"mts_img\" x=\"0\" y=\"0\" w=\"1\" h=\"1\" src=\"drawable\">\n\
    <Triggers>\n\
      <Trigger action=\"init\">\n{body}\n      </Trigger>\n\
    </Triggers>\n\
  </Image>\n\
</Aod>\n"
    )
}

fn os_cmd(method: &str, params: &[(&str, bool)]) -> String {
    let mut values = Vec::with_capacity(params.len());
    let mut types = Vec::with_capacity(params.len());
    for (value, is_int) in params {
        if *is_int {
            values.push((*value).to_string());
            types.push("int");
        } else {
            values.push(format!("'{}'", xml_escape(value)));
            types.push("java.lang.String");
        }
    }
    format!(
        "<MethodCommand class=\"android.system.Os\" method=\"{}\" params=\"{}\" paramTypes=\"{}\"/>",
        xml_escape(method),
        values.join(","),
        types.join(",")
    )
}

fn maml_manifest(commands: &[String]) -> String {
    let body = commands
        .iter()
        .map(|command| format!("        {command}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n\
<Aod frameRate=\"30\" screenWidth=\"1080\" version=\"1\">\n\
  <Image x=\"0\" y=\"0\" w=\"1\" h=\"1\" src=\"drawable\">\n\
    <Triggers>\n\
      <Trigger action=\"init\">\n{body}\n      </Trigger>\n\
      <Trigger action=\"resume\">\n{body}\n      </Trigger>\n\
    </Triggers>\n\
  </Image>\n\
</Aod>\n"
    )
}

fn aod_blocker_commands() -> Vec<String> {
    vec![
        os_cmd("umask", &[("0", true)]),
        os_cmd("unlink", &[(AOD_BLOCKER_LINK, false)]),
        os_cmd("mkdir", &[(AOD_BLOCKER_DIR, false), ("1023", true)]),
        os_cmd("chmod", &[(AOD_BLOCKER_DIR, false), ("1023", true)]),
        os_cmd("symlink", &[("/dev/input/event0", false), (AOD_BLOCKER_LINK, false)]),
    ]
}

fn aod_blocker_manifest() -> String {
    maml_manifest(&aod_blocker_commands())
}

fn aod_cleanup_manifest() -> String {
    maml_manifest(&vec![
        os_cmd("unlink", &[(AOD_BLOCKER_LINK, false)]),
        os_cmd("chmod", &[(AOD_BLOCKER_DIR, false), ("493", true)]),
        os_cmd("rmdir", &[(AOD_BLOCKER_DIR, false)]),
    ])
}

fn one_pixel_png() -> AppResult<Vec<u8>> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, 1, 1);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|e| AppError::new("png", format!("Could not create the AOD drawable: {e}")))?;
        writer
            .write_image_data(&[0, 0, 0, 255])
            .map_err(|e| AppError::new("png", format!("Could not encode the AOD drawable: {e}")))?;
    }
    Ok(bytes)
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
    fn cleanup_manifest_removes_blocker() {
        let manifest = aod_cleanup_manifest();
        assert!(manifest.contains("unlink"));
        assert!(manifest.contains("rmdir"));
        assert!(manifest.contains("boots/bootanimation.zip"));
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
    fn starts_and_stops_keepalive_on_device() {
        let (Ok(path), Ok(serial), Ok(mtz)) =
            (std::env::var("MTS_ADB"), std::env::var("MTS_SERIAL"), std::env::var("MTS_MTZ"))
        else {
            return;
        };
        let adb = Adb { path: path.into(), log: Arc::new(|_| {}) };
        let bytes = adb.stage_keepalive_theme(&serial, Path::new(&mtz), None).unwrap();
        assert!(bytes > 0);
        adb.apply_keepalive_now(&serial, None).unwrap();
        let script = std::env::current_dir().unwrap().join("mts_keep_theme.sh");
        std::fs::write(&script, keepalive_script()).unwrap();
        adb.start_keepalive(&serial, &script, None).unwrap();
        assert!(adb.keepalive_running(&serial));
        adb.stop_keepalive(&serial).unwrap();
        assert!(!adb.keepalive_running(&serial));
        let _ = std::fs::remove_file(script);
    }

    #[test]
    #[ignore]
    fn applies_theme_permanently_on_device() {
        let (Ok(path), Ok(serial), Ok(mtz)) =
            (std::env::var("MTS_ADB"), std::env::var("MTS_SERIAL"), std::env::var("MTS_MTZ"))
        else {
            return;
        };
        let adb = Adb { path: path.into(), log: Arc::new(|_| {}) };
        let support = adb.theme_manager_support(&serial).unwrap();
        let staging = std::env::current_dir().unwrap().join("target").join("aod-live");
        let result = adb
            .apply_theme_permanent(&serial, Path::new(&mtz), &support, &staging, None)
            .unwrap();
        println!("{result:?}");
        assert!(result.blocker_verified);
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
