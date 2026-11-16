//! Local persistence: settings, recent packages, autosave recovery and
//! export backups. Everything lives in the per-user app data folder.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_RECENT: usize = 12;
pub const MAX_BACKUPS_PER_NAME: usize = 10;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentItem {
    pub path: String,
    pub name: String,
    pub opened_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Explicit adb.exe path; when empty the app searches common locations.
    pub adb_path: Option<String>,
    pub recent: Vec<RecentItem>,
    pub autosave_enabled: bool,
    pub autosave_interval_seconds: u32,
    pub backups_enabled: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            adb_path: None,
            recent: Vec::new(),
            autosave_enabled: true,
            autosave_interval_seconds: 60,
            backups_enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryInfo {
    pub name: String,
    pub source_path: Option<String>,
    pub saved_at_ms: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub config: PathBuf,
    pub data: PathBuf,
}

impl AppPaths {
    pub fn settings_file(&self) -> PathBuf {
        self.config.join("settings.json")
    }
    pub fn recovery_dir(&self) -> PathBuf {
        self.data.join("recovery")
    }
    pub fn backups_dir(&self) -> PathBuf {
        self.data.join("backups")
    }
    pub fn screenshots_dir(&self) -> PathBuf {
        self.data.join("screenshots")
    }
    pub fn staging_dir(&self) -> PathBuf {
        self.data.join("staging")
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `YYYYMMDD-HHMMSS` in UTC, for file names.
pub fn utc_stamp(ms: u64) -> String {
    let secs = ms / 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}{mo:02}{d:02}-{h:02}{m:02}{s:02}")
}

/// Write via a temporary file in the same directory, then rename, so a
/// failure never leaves a truncated package behind.
pub fn atomic_write(path: &Path, data: &[u8]) -> AppResult<()> {
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(dir)
        .map_err(|e| AppError::io(format!("Could not create {}", dir.display()), e))?;
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "package".into());
    let temp = dir.join(format!(".{file_name}.{}.tmp", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&temp)?;
        file.write_all(data)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        return Err(AppError::io(
            format!("Could not write {}", path.display()),
            error,
        ));
    }
    Ok(())
}

pub fn load_settings(paths: &AppPaths) -> Settings {
    fs::read(paths.settings_file())
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn save_settings(paths: &AppPaths, settings: &Settings) -> AppResult<()> {
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| AppError::new("settings", e.to_string()))?;
    atomic_write(&paths.settings_file(), &json)
}

pub fn push_recent(settings: &mut Settings, path: &Path) {
    let path_string = path.to_string_lossy().into_owned();
    settings
        .recent
        .retain(|r| !r.path.eq_ignore_ascii_case(&path_string));
    settings.recent.insert(
        0,
        RecentItem {
            name: path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path_string.clone()),
            path: path_string,
            opened_at_ms: now_ms(),
        },
    );
    settings.recent.truncate(MAX_RECENT);
}

/// Copy an existing file into the backups folder before it is overwritten.
pub fn backup_existing(paths: &AppPaths, target: &Path) -> AppResult<Option<PathBuf>> {
    if !target.is_file() {
        return Ok(None);
    }
    let dir = paths.backups_dir();
    fs::create_dir_all(&dir).map_err(|e| AppError::io("Could not create the backups folder", e))?;
    let stem = target
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "package".into());
    let ext = target
        .extension()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "mtz".into());
    let backup = dir.join(format!("{stem}-{}.{ext}", utc_stamp(now_ms())));
    fs::copy(target, &backup)
        .map_err(|e| AppError::io("Could not create a backup of the existing file", e))?;
    prune_backups(&dir, &stem, MAX_BACKUPS_PER_NAME);
    Ok(Some(backup))
}

fn prune_backups(dir: &Path, stem: &str, keep: usize) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let prefix = format!("{stem}-");
    let mut matching: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name().map(|n| n.to_string_lossy()).is_some_and(|n| {
                n.starts_with(&prefix)
                    && n.len() > prefix.len()
                    && n[prefix.len()..]
                        .chars()
                        .next()
                        .is_some_and(|c| c.is_ascii_digit())
            })
        })
        .collect();
    matching.sort();
    while matching.len() > keep {
        let _ = fs::remove_file(matching.remove(0));
    }
}

pub fn write_recovery(paths: &AppPaths, info: &RecoveryInfo, data: &[u8]) -> AppResult<()> {
    let dir = paths.recovery_dir();
    atomic_write(&dir.join("autosave.mtz"), data)?;
    let json =
        serde_json::to_vec_pretty(info).map_err(|e| AppError::new("recovery", e.to_string()))?;
    atomic_write(&dir.join("autosave.json"), &json)
}

pub fn read_recovery(paths: &AppPaths) -> Option<(RecoveryInfo, PathBuf)> {
    let dir = paths.recovery_dir();
    let info: RecoveryInfo =
        serde_json::from_slice(&fs::read(dir.join("autosave.json")).ok()?).ok()?;
    let file = dir.join("autosave.mtz");
    file.is_file().then_some((info, file))
}

pub fn clear_recovery(paths: &AppPaths) {
    let dir = paths.recovery_dir();
    let _ = fs::remove_file(dir.join("autosave.json"));
    let _ = fs::remove_file(dir.join("autosave.mtz"));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_paths() -> (tempfile::TempDir, AppPaths) {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths {
            config: dir.path().join("config"),
            data: dir.path().join("data"),
        };
        (dir, paths)
    }

    #[test]
    fn stamps_are_formatted() {
        assert_eq!(utc_stamp(0), "19700101-000000");
        assert_eq!(utc_stamp(1_700_000_000_000), "20231114-221320");
    }

    #[test]
    fn settings_round_trip_and_recent_list() {
        let (_dir, paths) = temp_paths();
        let mut settings = load_settings(&paths);
        assert!(settings.autosave_enabled);
        for i in 0..20 {
            push_recent(&mut settings, Path::new(&format!("C:/t/{i}.mtz")));
        }
        push_recent(&mut settings, Path::new("C:/t/3.mtz"));
        assert_eq!(settings.recent.len(), MAX_RECENT);
        assert_eq!(settings.recent[0].name, "3.mtz");
        save_settings(&paths, &settings).unwrap();
        assert_eq!(load_settings(&paths).recent[0].name, "3.mtz");
    }

    #[test]
    fn backups_and_recovery() {
        let (dir, paths) = temp_paths();
        let target = dir.path().join("Theme.mtz");
        assert!(backup_existing(&paths, &target).unwrap().is_none());
        atomic_write(&target, b"v1").unwrap();
        let backup = backup_existing(&paths, &target).unwrap().unwrap();
        assert_eq!(fs::read(backup).unwrap(), b"v1");
        atomic_write(&target, b"v2").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"v2");

        let info = RecoveryInfo {
            name: "Theme.mtz".into(),
            source_path: None,
            saved_at_ms: 1,
            bytes: 2,
        };
        write_recovery(&paths, &info, b"zz").unwrap();
        let (read, file) = read_recovery(&paths).unwrap();
        assert_eq!(read.name, "Theme.mtz");
        assert_eq!(fs::read(file).unwrap(), b"zz");
        clear_recovery(&paths);
        assert!(read_recovery(&paths).is_none());
    }

    #[test]
    fn prunes_old_backups() {
        let (dir, _paths) = temp_paths();
        let backups = dir.path().join("b");
        fs::create_dir_all(&backups).unwrap();
        for i in 0..15 {
            fs::write(
                backups.join(format!("T-2026010{}-0000{:02}.mtz", i % 10, i)),
                b"x",
            )
            .unwrap();
        }
        fs::write(backups.join("T-other.mtz"), b"x").unwrap();
        prune_backups(&backups, "T", 10);
        assert_eq!(fs::read_dir(&backups).unwrap().count(), 11);
    }
}
