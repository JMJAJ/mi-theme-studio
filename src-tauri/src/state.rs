//! Shared application state managed by Tauri.

use crate::adb::AdbLogEntry;
use crate::project::Project;
use crate::storage::{AppPaths, Settings};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard};

pub const MAX_SCREENSHOTS: usize = 12;
pub const MAX_ADB_LOG: usize = 500;

pub struct Screenshot {
    pub id: u64,
    pub serial: String,
    pub model: Option<String>,
    pub at_ms: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub data: Arc<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotInfo {
    pub id: u64,
    pub serial: String,
    pub model: Option<String>,
    pub at_ms: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub bytes: usize,
}

impl Screenshot {
    pub fn info(&self) -> ScreenshotInfo {
        ScreenshotInfo {
            id: self.id,
            serial: self.serial.clone(),
            model: self.model.clone(),
            at_ms: self.at_ms,
            width: self.width,
            height: self.height,
            bytes: self.data.len(),
        }
    }
}

pub struct AppState {
    pub main: Mutex<Option<Project>>,
    pub reference: Mutex<Option<Project>>,
    pub screenshots: Mutex<Vec<Screenshot>>,
    pub operations: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub settings: Mutex<Settings>,
    pub adb_log: Mutex<VecDeque<AdbLogEntry>>,
    /// History position captured by the last autosave.
    pub last_autosave: Mutex<Option<Option<u64>>>,
    pub paths: AppPaths,
    pub mirror: Mutex<Option<crate::adb::mirror::Mirror>>,
    /// Bundled resources (scrcpy).
    pub resource_dir: Option<std::path::PathBuf>,
}

impl AppState {
    pub fn new(paths: AppPaths, settings: Settings) -> Self {
        Self {
            main: Mutex::new(None),
            reference: Mutex::new(None),
            screenshots: Mutex::new(Vec::new()),
            operations: Mutex::new(HashMap::new()),
            settings: Mutex::new(settings),
            adb_log: Mutex::new(VecDeque::new()),
            last_autosave: Mutex::new(None),
            paths,
            mirror: Mutex::new(None),
            resource_dir: None,
        }
    }
}

/// Lock a mutex, recovering from poisoning (a panic in another command must
/// not make the editor unusable).
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}
