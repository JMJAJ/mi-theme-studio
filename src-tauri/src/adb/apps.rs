//! Installed apps on the phone (name + package), for icon coverage.
//!
//! Xiaomi's old editor installs a helper APK ("ShowApps") for this, which
//! Play Protect now blocks. The bundled scrcpy server can list apps from an
//! adb shell (`list_apps=true`) without installing anything.

use super::{valid_serial, Adb};
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::path::Path;
use std::time::Duration;

const DEVICE_SERVER_PATH: &str = "/data/local/tmp/mts-scrcpy-server.jar";
const SCRCPY_VERSION: &str = "3.3.1";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceApp {
    pub label: String,
    pub package: String,
    pub system: bool,
}

/// Parses scrcpy's app list: ` * Label    com.pkg` (system) or ` - Label    com.pkg`.
pub fn parse_app_list(text: &str) -> Vec<DeviceApp> {
    let mut apps: Vec<DeviceApp> = text
        .lines()
        .filter_map(|line| {
            let line = line.trim_end();
            let (system, rest) = if let Some(r) = line.trim_start().strip_prefix("* ") {
                (true, r)
            } else if let Some(r) = line.trim_start().strip_prefix("- ") {
                (false, r)
            } else {
                return None;
            };
            let (label, package) = rest.trim().rsplit_once(char::is_whitespace)?;
            let package = package.trim();
            let valid = package.contains('.') && package.bytes().all(|b| b.is_ascii_alphanumeric() || b"._".contains(&b));
            valid.then(|| DeviceApp { label: label.trim().to_string(), package: package.to_string(), system })
        })
        .collect();
    apps.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
    apps.dedup_by(|a, b| a.package == b.package);
    apps
}

impl Adb {
    /// Launcher apps installed on the phone.
    pub fn list_apps(&self, serial: &str, server_jar: &Path) -> AppResult<Vec<DeviceApp>> {
        valid_serial(serial)?;
        let jar = server_jar.to_string_lossy().to_string();
        let out = self.exec(&["-s", serial, "push", &jar, DEVICE_SERVER_PATH], Duration::from_secs(60), None, true)?;
        self.expect_ok(out, "adb push")?;
        let command = format!("CLASSPATH={DEVICE_SERVER_PATH} app_process / com.genymobile.scrcpy.Server {SCRCPY_VERSION} list_apps=true log_level=info 2>&1");
        let out = self.shell(serial, &[&command], Duration::from_secs(90), None)?;
        let apps = parse_app_list(&out.stdout_text());
        if apps.is_empty() {
            return Err(AppError::new("device", "The phone did not return an app list."));
        }
        Ok(apps)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_scrcpy_app_lists() {
        let text = "[server] INFO: List of apps:\n * App vault                      com.mi.globalminusscreen\n - My Bank App                    com.bank.app\n * Broken line\n";
        let apps = parse_app_list(text);
        assert_eq!(apps.len(), 2);
        assert_eq!(apps[0], DeviceApp { label: "App vault".into(), package: "com.mi.globalminusscreen".into(), system: true });
        assert_eq!(apps[1].label, "My Bank App");
        assert!(!apps[1].system);
    }
}

/// `MTS_ADB=<adb.exe> MTS_SERIAL=<serial> cargo test adb::apps::live -- --ignored --nocapture`
#[cfg(test)]
mod live {
    use super::*;
    use std::sync::Arc;

    #[test]
    #[ignore]
    fn lists_apps_on_the_phone() {
        let (Ok(path), Ok(serial)) = (std::env::var("MTS_ADB"), std::env::var("MTS_SERIAL")) else { return };
        let adb = Adb { path: path.into(), log: Arc::new(|_| {}) };
        let jar = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/scrcpy/scrcpy-server");
        let apps = adb.list_apps(&serial, &jar).expect("apps");
        println!("{} apps, {} user", apps.len(), apps.iter().filter(|a| !a.system).count());
        for a in apps.iter().take(5) {
            println!("  {} {} {}", a.label, a.package, a.system);
        }
        assert!(apps.len() > 10);
    }
}
