//! Android Debug Bridge integration. All device access goes through this
//! module and the process runner; the web UI never gets shell access.
//!
//! Read-only queries, screenshots, an explicitly confirmed verified file
//! copy, opening Theme Manager pages, and (where Theme Manager supports it)
//! a confirmed apply through its editor entry point; see `theme_apply` and
//! docs/device-integration.md.

pub mod parse;
pub mod runner;
pub mod theme_apply;
pub mod theme_cache;

use crate::error::{AppError, AppResult};
use parse::{DeviceEntry, Size};
use runner::{RunError, RunOutput};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

pub const THEME_MANAGER_PACKAGE: &str = "com.android.thememanager";
pub const REMOTE_DIR: &str = "/sdcard/Download/MiThemeStudio";

static NEXT_LOG_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdbLogEntry {
    pub id: u64,
    pub at_ms: u64,
    pub command: String,
    pub code: Option<i32>,
    pub duration_ms: u64,
    pub ok: bool,
    pub summary: String,
}

pub type Logger = Arc<dyn Fn(AdbLogEntry) + Send + Sync>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub path: String,
    pub source: &'static str,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdbLocation {
    pub path: String,
    pub source: &'static str,
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "adb.exe"
    } else {
        "adb"
    }
}

/// Locations searched for adb, in priority order. The app's own ignored
/// `source/` research folder is never searched.
pub fn candidates(configured: Option<&str>) -> Vec<(PathBuf, &'static str)> {
    let mut list = Vec::new();
    if let Some(configured) = configured.map(str::trim).filter(|s| !s.is_empty()) {
        let path = PathBuf::from(configured);
        let path = if path.is_dir() {
            path.join(exe_name())
        } else {
            path
        };
        list.push((path, "settings"));
    }
    for var in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
        if let Ok(root) = std::env::var(var) {
            list.push((
                PathBuf::from(root).join("platform-tools").join(exe_name()),
                "android-sdk-env",
            ));
        }
    }
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            list.push((dir.join(exe_name()), "path"));
        }
    }
    if let Ok(home) = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        let home = PathBuf::from(home);
        for sub in [
            &["Desktop", "platform-tools"][..],
            &["OneDrive", "Desktop", "platform-tools"],
            &["platform-tools"],
            &["Downloads", "platform-tools"],
        ] {
            let dir = sub.iter().fold(home.clone(), |path, part| path.join(part));
            list.push((dir.join(exe_name()), "user-folder"));
        }
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        list.push((
            PathBuf::from(local)
                .join("Android")
                .join("Sdk")
                .join("platform-tools")
                .join(exe_name()),
            "android-sdk",
        ));
    }
    if cfg!(windows) {
        list.push((
            PathBuf::from(r"C:\platform-tools").join(exe_name()),
            "common",
        ));
        list.push((
            PathBuf::from(r"C:\Android\platform-tools").join(exe_name()),
            "common",
        ));
    }
    list
}

pub fn locate(configured: Option<&str>) -> (Option<AdbLocation>, Vec<Candidate>) {
    let mut searched = Vec::new();
    let mut found = None;
    for (path, source) in candidates(configured) {
        let exists = path.is_file();
        if searched
            .iter()
            .any(|c: &Candidate| Path::new(&c.path) == path)
        {
            continue;
        }
        if exists && found.is_none() {
            found = Some(AdbLocation {
                path: path.to_string_lossy().into_owned(),
                source,
            });
        }
        // Keep the list readable: only show PATH entries that exist.
        if source != "path" || exists {
            searched.push(Candidate {
                path: path.to_string_lossy().into_owned(),
                source,
                exists,
            });
        }
    }
    (found, searched)
}

pub fn valid_serial(serial: &str) -> AppResult<()> {
    if serial.is_empty()
        || serial.len() > 128
        || !serial
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c))
    {
        return Err(AppError::invalid("Invalid device serial."));
    }
    Ok(())
}

/// Device-side file name containing only shell-safe characters.
pub fn remote_file_name(name: &str) -> String {
    let stem = name.strip_suffix(".mtz").unwrap_or(name);
    let mut clean: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    clean = clean.trim_matches(['.', '_']).to_string();
    if clean.is_empty() {
        clean = "theme".into();
    }
    clean.truncate(80);
    format!("{clean}.mtz")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDetails {
    pub serial: String,
    pub manufacturer: Option<String>,
    pub brand: Option<String>,
    pub model: Option<String>,
    pub market_name: Option<String>,
    pub device: Option<String>,
    pub android_version: Option<String>,
    pub sdk: Option<String>,
    pub miui_version: Option<String>,
    pub hyperos_version: Option<String>,
    pub build_incremental: Option<String>,
    pub region: Option<String>,
    pub abi: Option<String>,
    pub screen: Option<Size>,
    pub screen_override: Option<Size>,
    pub density: Option<u32>,
    pub density_override: Option<u32>,
    pub theme_manager_version: Option<String>,
    pub theme_manager_installed: bool,
    pub fetched_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub remote_path: String,
    pub bytes: u64,
    pub verified: bool,
    pub duration_ms: u64,
}

pub struct Adb {
    pub path: PathBuf,
    pub log: Logger,
}

fn describe(error: &RunError, command: &str) -> AppError {
    match error {
        RunError::Timeout => AppError::new("timeout", format!("`{command}` timed out.")),
        RunError::Cancelled => AppError::new("cancelled", "The operation was cancelled."),
        RunError::Spawn(e) => {
            AppError::new("adb_missing", format!("adb could not be started: {e}"))
        }
        RunError::OutputTooLarge => {
            AppError::new("adb", format!("`{command}` produced too much output."))
        }
    }
}

fn trimmed(value: Option<&String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

impl Adb {
    pub fn exec(
        &self,
        args: &[&str],
        timeout: Duration,
        cancel: Option<Arc<AtomicBool>>,
        quiet: bool,
    ) -> AppResult<RunOutput> {
        let command = format!("adb {}", args.join(" "));
        let result = runner::run(&self.path, args, timeout, cancel);
        let entry =
            |ok: bool, code: Option<i32>, duration: Duration, summary: String| AdbLogEntry {
                id: NEXT_LOG_ID.fetch_add(1, Ordering::Relaxed),
                at_ms: crate::storage::now_ms(),
                command: command.clone(),
                code,
                duration_ms: duration.as_millis() as u64,
                ok,
                summary: summary.chars().take(400).collect(),
            };
        match result {
            Ok(output) => {
                if !quiet || !output.success() {
                    let summary = if output.success() {
                        let text = output.stdout_text();
                        let first = text
                            .lines()
                            .find(|l| !l.trim().is_empty())
                            .unwrap_or("")
                            .trim();
                        if output.stdout.len() > 2048 || !output.stdout.is_ascii() {
                            format!("{} bytes of output", output.stdout.len())
                        } else {
                            first.to_string()
                        }
                    } else {
                        let err = output.stderr_text();
                        if err.is_empty() {
                            output.stdout_text().trim().to_string()
                        } else {
                            err
                        }
                    };
                    (self.log)(entry(
                        output.success(),
                        output.code,
                        output.duration,
                        summary,
                    ));
                }
                Ok(output)
            }
            Err(error) => {
                (self.log)(entry(false, None, timeout, error.to_string()));
                Err(describe(&error, &command))
            }
        }
    }

    fn expect_ok(&self, output: RunOutput, what: &str) -> AppResult<RunOutput> {
        if output.success() {
            Ok(output)
        } else {
            let mut message = output.stderr_text();
            if message.is_empty() {
                message = output.stdout_text().trim().to_string();
            }
            Err(map_device_error(&message, what))
        }
    }

    pub fn version(&self) -> AppResult<String> {
        let out = self.exec(&["version"], Duration::from_secs(10), None, true)?;
        let out = self.expect_ok(out, "adb version")?;
        let text = out.stdout_text();
        let mut lines = text.lines();
        let first = lines.next().unwrap_or("").trim().to_string();
        let second = lines.next().unwrap_or("").trim().to_string();
        Ok(if second.starts_with("Version") {
            format!("{first} · {second}")
        } else {
            first
        })
    }

    pub fn devices(&self, quiet: bool) -> AppResult<Vec<DeviceEntry>> {
        let out = self.exec(&["devices", "-l"], Duration::from_secs(15), None, quiet)?;
        let out = self.expect_ok(out, "adb devices")?;
        Ok(parse::parse_devices(&out.stdout_text()))
    }

    pub fn restart_server(&self) -> AppResult<()> {
        let _ = self.exec(&["kill-server"], Duration::from_secs(10), None, false)?;
        let out = self.exec(&["start-server"], Duration::from_secs(20), None, false)?;
        self.expect_ok(out, "adb start-server").map(|_| ())
    }

    fn shell(
        &self,
        serial: &str,
        command: &[&str],
        timeout: Duration,
        cancel: Option<Arc<AtomicBool>>,
    ) -> AppResult<RunOutput> {
        valid_serial(serial)?;
        let mut args = vec!["-s", serial, "shell"];
        args.extend_from_slice(command);
        let out = self.exec(&args, timeout, cancel, false)?;
        self.expect_ok(out, &command.join(" "))
    }

    pub fn details(&self, serial: &str) -> AppResult<DeviceDetails> {
        let props = parse::parse_getprop(
            &self
                .shell(serial, &["getprop"], Duration::from_secs(15), None)?
                .stdout_text(),
        );
        let size = self
            .shell(serial, &["wm", "size"], Duration::from_secs(10), None)
            .map(|o| parse::parse_wm_size(&o.stdout_text()));
        let density = self
            .shell(serial, &["wm", "density"], Duration::from_secs(10), None)
            .map(|o| parse::parse_wm_density(&o.stdout_text()));
        let theme_manager = self
            .shell(
                serial,
                &["pm", "list", "packages", THEME_MANAGER_PACKAGE],
                Duration::from_secs(15),
                None,
            )
            .map(|o| {
                o.stdout_text()
                    .lines()
                    .any(|l| l.trim() == format!("package:{THEME_MANAGER_PACKAGE}"))
            })
            .unwrap_or(false);
        let theme_manager_version = if theme_manager {
            self.shell(
                serial,
                &["dumpsys", "package", THEME_MANAGER_PACKAGE],
                Duration::from_secs(20),
                None,
            )
            .ok()
            .and_then(|o| parse::parse_version_name(&o.stdout_text()))
        } else {
            None
        };
        let (screen, screen_override) = size.unwrap_or((None, None));
        let (density, density_override) = density.unwrap_or((None, None));
        Ok(DeviceDetails {
            serial: serial.to_string(),
            manufacturer: trimmed(props.get("ro.product.manufacturer")),
            brand: trimmed(props.get("ro.product.brand")),
            model: trimmed(props.get("ro.product.model")),
            market_name: trimmed(props.get("ro.product.marketname"))
                .or_else(|| trimmed(props.get("ro.product.vendor.marketname"))),
            device: trimmed(props.get("ro.product.device")),
            android_version: trimmed(props.get("ro.build.version.release")),
            sdk: trimmed(props.get("ro.build.version.sdk")),
            miui_version: trimmed(props.get("ro.miui.ui.version.name")),
            hyperos_version: trimmed(props.get("ro.mi.os.version.name"))
                .or_else(|| trimmed(props.get("ro.mi.os.version.incremental"))),
            build_incremental: trimmed(props.get("ro.build.version.incremental")),
            region: trimmed(props.get("ro.miui.build.region"))
                .or_else(|| trimmed(props.get("ro.miui.region"))),
            abi: trimmed(props.get("ro.product.cpu.abi")),
            screen,
            screen_override,
            density,
            density_override,
            theme_manager_version,
            theme_manager_installed: theme_manager,
            fetched_at_ms: crate::storage::now_ms(),
        })
    }

    pub fn screenshot(&self, serial: &str, cancel: Option<Arc<AtomicBool>>) -> AppResult<Vec<u8>> {
        valid_serial(serial)?;
        let out = self.exec(
            &["-s", serial, "exec-out", "screencap", "-p"],
            Duration::from_secs(25),
            cancel,
            false,
        )?;
        let out = self.expect_ok(out, "screencap")?;
        if !out.stdout.starts_with(b"\x89PNG\r\n\x1a\n") {
            let hint = String::from_utf8_lossy(&out.stdout[..out.stdout.len().min(200)])
                .trim()
                .to_string();
            return Err(AppError::new(
                "adb",
                if hint.is_empty() {
                    "The device returned an empty screenshot.".to_string()
                } else {
                    format!("The device did not return a PNG screenshot: {hint}")
                },
            ));
        }
        Ok(out.stdout)
    }

    /// Copy a local file to the device's shared storage and confirm the
    /// remote size matches. Does not open or apply the file.
    pub fn push_verified(
        &self,
        serial: &str,
        local: &Path,
        remote_name: &str,
        cancel: Option<Arc<AtomicBool>>,
    ) -> AppResult<PushResult> {
        valid_serial(serial)?;
        if remote_file_name(remote_name) != remote_name {
            return Err(AppError::invalid("Unsafe remote file name."));
        }
        let bytes = std::fs::metadata(local)
            .map_err(|e| AppError::io("Could not read the staged package", e))?
            .len();
        let remote = format!("{REMOTE_DIR}/{remote_name}");
        self.shell(
            serial,
            &["mkdir", "-p", REMOTE_DIR],
            Duration::from_secs(10),
            cancel.clone(),
        )?;
        let local_str = local.to_string_lossy().into_owned();
        let timeout = Duration::from_secs(60 + bytes / (1024 * 1024) * 2);
        let started = std::time::Instant::now();
        let out = self.exec(
            &["-s", serial, "push", &local_str, &remote],
            timeout,
            cancel.clone(),
            false,
        )?;
        self.expect_ok(out, "adb push")?;
        let stat = self.shell(
            serial,
            &["stat", "-c", "%s", &remote],
            Duration::from_secs(10),
            cancel,
        )?;
        let remote_size = parse::parse_size(&stat.stdout_text());
        let verified = remote_size == Some(bytes);
        if !verified {
            return Err(AppError::new(
                "verify",
                format!(
                    "The copy could not be verified: local {bytes} bytes, device reports {}.",
                    remote_size
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| "no size".into())
                ),
            ));
        }
        Ok(PushResult {
            remote_path: remote,
            bytes,
            verified,
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }
}

/// Turn common adb error text into actionable messages.
pub fn map_device_error(message: &str, what: &str) -> AppError {
    let lower = message.to_lowercase();
    if lower.contains("unauthorized") {
        AppError::new("unauthorized", "The device has not authorized this computer. Unlock the phone and accept the USB debugging prompt.")
    } else if lower.contains("offline") {
        AppError::new(
            "offline",
            "The device is offline. Reconnect the cable or restart the ADB server.",
        )
    } else if lower.contains("not found") && lower.contains("device") {
        AppError::new("no_device", "The device is no longer connected.")
    } else if lower.contains("more than one device") {
        AppError::new(
            "multiple_devices",
            "More than one device is connected; select one.",
        )
    } else if message.is_empty() {
        AppError::new("adb", format!("{what} failed."))
    } else {
        AppError::new("adb", format!("{what} failed: {message}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_names_are_shell_safe() {
        assert_eq!(remote_file_name("My Theme (v2).mtz"), "My_Theme__v2.mtz");
        assert_eq!(remote_file_name("$(rm -rf).mtz"), "rm_-rf.mtz");
        assert_eq!(remote_file_name("..."), "theme.mtz");
        assert_eq!(remote_file_name("Ok-1.0.mtz"), "Ok-1.0.mtz");
    }

    #[test]
    fn serial_validation() {
        assert!(valid_serial("595eABCD").is_ok());
        assert!(valid_serial("192.168.1.5:5555").is_ok());
        assert!(valid_serial("a b").is_err());
        assert!(valid_serial("a;rm").is_err());
    }

    #[test]
    fn configured_path_is_first_and_source_folder_is_never_searched() {
        let list = candidates(Some("C:/tools/adb.exe"));
        assert_eq!(list[0].1, "settings");
        assert!(list
            .iter()
            .all(|(p, _)| !p.to_string_lossy().replace('\\', "/").contains("/source/")));
    }

    #[test]
    fn maps_errors() {
        assert_eq!(
            map_device_error("error: device unauthorized.", "x").code,
            "unauthorized"
        );
        assert_eq!(
            map_device_error("error: device offline", "x").code,
            "offline"
        );
        assert_eq!(
            map_device_error("error: device 'abc' not found", "x").code,
            "no_device"
        );
    }
}
