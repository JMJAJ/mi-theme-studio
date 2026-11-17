//! Tauri commands. Every command runs on a blocking worker thread so the
//! window stays responsive during large exports or slow device calls.

use crate::adb::{
    self, parse::DeviceEntry, Adb, AdbLocation, AdbLogEntry, Candidate, DeviceDetails, PushResult,
};
use crate::store::{self, DownloadProgress, DownloadedTheme, StorePage, StoreQuery, ThemeDetail};
use crate::error::{AppError, AppResult};
use crate::package::archive::{self, Limits, WriteEntry};
use crate::package::metadata::{self, FieldUpdate, MetadataView, DESCRIPTION_PATH};
use crate::package::ninepatch::{self, NinePatch, NinePatchUpdate};
use crate::package::paths;
use crate::project::history::History;
use crate::project::snapshot::{snapshot, ProjectSnapshot};
use crate::project::search::{self, ReplaceResult, ReplaceTarget, SearchOptions, SearchResult};
use crate::project::{decode_text, BulkResult, ConflictPolicy, CopyPlanItem, Project};
use crate::state::{lock, AppState, Screenshot, ScreenshotInfo, MAX_ADB_LOG, MAX_SCREENSHOTS};
use crate::storage::{self, RecoveryInfo, Settings};
use crate::validation::{self, ValidationReport};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};

pub const MAX_PACKAGE_BYTES: u64 = 1024 * 1024 * 1024;
pub const MAX_ASSET_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_TEXT_BYTES: usize = 24 * 1024 * 1024;

static NEXT_SHOT_ID: AtomicU64 = AtomicU64::new(1);

async fn blocking<T, F>(app: AppHandle, f: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(&AppState, &AppHandle) -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        f(&state, &app)
    })
    .await
    .map_err(|e| AppError::new("internal", format!("Background task failed: {e}")))?
}

fn with_main<T>(state: &AppState, f: impl FnOnce(&mut Project) -> AppResult<T>) -> AppResult<T> {
    let mut guard = lock(&state.main);
    let project = guard.as_mut().ok_or_else(AppError::no_project)?;
    f(project)
}

fn read_limited(path: &Path, limit: u64, what: &str) -> AppResult<Vec<u8>> {
    let meta = std::fs::metadata(path)
        .map_err(|e| AppError::io(format!("Could not read {}", path.display()), e))?;
    if !meta.is_file() {
        return Err(AppError::invalid(format!(
            "{} is not a file.",
            path.display()
        )));
    }
    if meta.len() > limit {
        return Err(AppError::new(
            "limit",
            format!(
                "{what} is larger than the {} MB limit.",
                limit / 1024 / 1024
            ),
        ));
    }
    std::fs::read(path).map_err(|e| AppError::io(format!("Could not read {}", path.display()), e))
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "package.mtz".into())
}

// ----- app & settings -------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub data_dir: String,
    pub backups_dir: String,
    pub screenshots_dir: String,
    pub recovery: Option<RecoveryInfo>,
    pub settings: Settings,
}

#[tauri::command]
pub async fn app_info(app: AppHandle) -> AppResult<AppInfo> {
    blocking(app, |state, app| {
        Ok(AppInfo {
            version: app.package_info().version.to_string(),
            data_dir: state.paths.data.to_string_lossy().into_owned(),
            backups_dir: state.paths.backups_dir().to_string_lossy().into_owned(),
            screenshots_dir: state.paths.screenshots_dir().to_string_lossy().into_owned(),
            recovery: storage::read_recovery(&state.paths).map(|(info, _)| info),
            settings: lock(&state.settings).clone(),
        })
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    #[serde(default, with = "double_option")]
    pub adb_path: Option<Option<String>>,
    pub autosave_enabled: Option<bool>,
    pub autosave_interval_seconds: Option<u32>,
    pub backups_enabled: Option<bool>,
}

mod double_option {
    use serde::{Deserialize, Deserializer};
    pub fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<Option<Option<String>>, D::Error> {
        Ok(Some(Option::deserialize(d)?))
    }
}

#[tauri::command]
pub async fn settings_update(app: AppHandle, patch: SettingsPatch) -> AppResult<Settings> {
    blocking(app, move |state, _| {
        let mut settings = lock(&state.settings);
        if let Some(adb_path) = patch.adb_path {
            settings.adb_path = adb_path.filter(|p| !p.trim().is_empty());
        }
        if let Some(v) = patch.autosave_enabled {
            settings.autosave_enabled = v;
        }
        if let Some(v) = patch.autosave_interval_seconds {
            settings.autosave_interval_seconds = v.clamp(15, 3600);
        }
        if let Some(v) = patch.backups_enabled {
            settings.backups_enabled = v;
        }
        storage::save_settings(&state.paths, &settings)?;
        Ok(settings.clone())
    })
    .await
}

#[tauri::command]
pub async fn recent_remove(app: AppHandle, path: String) -> AppResult<Settings> {
    blocking(app, move |state, _| {
        let mut settings = lock(&state.settings);
        settings.recent.retain(|r| r.path != path);
        storage::save_settings(&state.paths, &settings)?;
        Ok(settings.clone())
    })
    .await
}

// ----- project lifecycle ----------------------------------------------------

#[tauri::command]
pub async fn project_new(app: AppHandle, title: String) -> AppResult<ProjectSnapshot> {
    blocking(app, move |state, _| {
        let title = if title.trim().is_empty() {
            "My Theme".to_string()
        } else {
            title.trim().to_string()
        };
        let project = Project::new_empty(&title);
        let snap = snapshot(&project, "main");
        *lock(&state.main) = Some(project);
        *lock(&state.last_autosave) = None;
        Ok(snap)
    })
    .await
}

#[tauri::command]
pub async fn project_open(app: AppHandle, path: String) -> AppResult<ProjectSnapshot> {
    blocking(app, move |state, _| {
        let path = PathBuf::from(path);
        let data = read_limited(&path, MAX_PACKAGE_BYTES, "The package")?;
        let project = Project::from_bytes(
            &data,
            &file_name_of(&path),
            Some(path.clone()),
            Limits::default(),
        )?;
        let snap = snapshot(&project, "main");
        *lock(&state.main) = Some(project);
        *lock(&state.last_autosave) = None;
        let mut settings = lock(&state.settings);
        storage::push_recent(&mut settings, &path);
        let _ = storage::save_settings(&state.paths, &settings);
        Ok(snap)
    })
    .await
}

#[tauri::command]
pub async fn project_snapshot(app: AppHandle) -> AppResult<Option<ProjectSnapshot>> {
    blocking(app, |state, _| {
        Ok(lock(&state.main).as_ref().map(|p| snapshot(p, "main")))
    })
    .await
}

/// Close the project. The caller has already confirmed discarding changes,
/// so the recovery copy is removed too.
#[tauri::command]
pub async fn project_close(app: AppHandle) -> AppResult<()> {
    blocking(app, |state, _| {
        *lock(&state.main) = None;
        storage::clear_recovery(&state.paths);
        Ok(())
    })
    .await
}

// ----- file content ---------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub path: String,
    pub text: String,
    pub lossy: bool,
    pub bom: bool,
    pub rev: u64,
}

#[tauri::command]
pub async fn file_text(app: AppHandle, slot: Option<String>, path: String) -> AppResult<TextFile> {
    blocking(app, move |state, _| {
        let guard = if slot.as_deref() == Some("ref") {
            lock(&state.reference)
        } else {
            lock(&state.main)
        };
        let project = guard.as_ref().ok_or_else(AppError::no_project)?;
        let blob = project
            .files
            .get(&path)
            .ok_or_else(|| AppError::not_found(format!("`{path}` is not in the package.")))?;
        if blob.data.len() > MAX_TEXT_BYTES {
            return Err(AppError::new(
                "limit",
                "This file is too large to edit as text.",
            ));
        }
        let (text, lossy, bom) = decode_text(&blob.data);
        Ok(TextFile {
            path,
            text,
            lossy,
            bom,
            rev: blob.rev,
        })
    })
    .await
}

#[tauri::command]
pub async fn file_write_text(
    app: AppHandle,
    path: String,
    text: String,
    allow_invalid_xml: bool,
) -> AppResult<ProjectSnapshot> {
    blocking(app, move |state, _| {
        with_main(state, |project| {
            let ext = paths::extension(&path);
            if (ext == "xml" || ext == "maml") && !allow_invalid_xml {
                metadata::check_well_formed(&text).map_err(|e| {
                    AppError::new("xml_invalid", format!("The XML is not well-formed: {e}"))
                })?;
            }
            let bom = project
                .files
                .get(&path)
                .is_some_and(|b| b.data.starts_with(b"\xEF\xBB\xBF"));
            let mut bytes = Vec::with_capacity(text.len() + 3);
            if bom && !text.starts_with('\u{feff}') {
                bytes.extend_from_slice(b"\xEF\xBB\xBF");
            }
            bytes.extend_from_slice(text.as_bytes());
            project.put_file(&path, bytes, &format!("Edit {}", paths::file_name(&path)))?;
            Ok(snapshot(project, "main"))
        })
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkResponse {
    pub snapshot: ProjectSnapshot,
    pub result: BulkResult,
}

/// Add files from disk into `folder` (a project folder such as `wallpaper`,
/// `icons!/res/drawable-xxhdpi`, or `""` for the root).
#[tauri::command]
pub async fn files_import(
    app: AppHandle,
    sources: Vec<String>,
    folder: String,
    policy: ConflictPolicy,
    names: Option<Vec<String>>,
) -> AppResult<BulkResponse> {
    blocking(app, move |state, _| {
        let mut items = Vec::new();
        for (index, source) in sources.iter().enumerate() {
            let path = PathBuf::from(source);
            if path.is_dir() {
                return Err(AppError::invalid(format!(
                    "{} is a folder; select files instead.",
                    path.display()
                )));
            }
            // Optional target names (e.g. `<package>.png` for app icons).
            let name = names.as_ref().and_then(|n| n.get(index).cloned()).unwrap_or_else(|| file_name_of(&path));
            paths::validate_name(&name)
                .map_err(|issue| AppError::invalid(format!("`{name}`: {}", issue.describe())))?;
            let data = read_limited(&path, MAX_ASSET_BYTES, &name)?;
            items.push((paths::join(&folder, &name), data));
        }
        with_main(state, |project| {
            let label = if items.len() == 1 {
                format!("Add {}", paths::file_name(&items[0].0))
            } else {
                format!("Add {} files", items.len())
            };
            let result = project.add_files(items, policy, &label)?;
            Ok(BulkResponse {
                snapshot: snapshot(project, "main"),
                result,
            })
        })
    })
    .await
}

/// A file produced inside the app (a cropped wallpaper, a generated icon).
#[derive(Deserialize)]
pub struct GeneratedFile {
    pub path: String,
    pub data: Vec<u8>,
}

/// Write files generated in the app into the project as one undoable change,
/// replacing whatever is at those paths.
#[tauri::command]
pub async fn files_write(
    app: AppHandle,
    files: Vec<GeneratedFile>,
    label: String,
) -> AppResult<BulkResponse> {
    blocking(app, move |state, _| {
        let mut items = Vec::with_capacity(files.len());
        for file in files {
            let name = paths::file_name(&file.path).to_string();
            paths::validate_name(&name)
                .map_err(|issue| AppError::invalid(format!("`{name}`: {}", issue.describe())))?;
            if file.data.is_empty() || file.data.len() as u64 > MAX_ASSET_BYTES {
                return Err(AppError::invalid(format!("`{name}` is empty or too large.")));
            }
            items.push((file.path, file.data));
        }
        if items.is_empty() {
            return Err(AppError::invalid("Nothing to write."));
        }
        with_main(state, |project| {
            let result = project.add_files(items, ConflictPolicy::Overwrite, &label)?;
            Ok(BulkResponse {
                snapshot: snapshot(project, "main"),
                result,
            })
        })
    })
    .await
}

#[tauri::command]
pub async fn file_replace(
    app: AppHandle,
    path: String,
    source: String,
) -> AppResult<ProjectSnapshot> {
    blocking(app, move |state, _| {
        let data = read_limited(Path::new(&source), MAX_ASSET_BYTES, "The replacement file")?;
        with_main(state, |project| {
            if !project.files.contains_key(&path) {
                return Err(AppError::not_found(format!(
                    "`{path}` is not in the package."
                )));
            }
            project.put_file(&path, data, &format!("Replace {}", paths::file_name(&path)))?;
            Ok(snapshot(project, "main"))
        })
    })
    .await
}

#[tauri::command]
pub async fn files_delete(app: AppHandle, paths: Vec<String>) -> AppResult<ProjectSnapshot> {
    blocking(app, move |state, _| {
        with_main(state, |project| {
            project.delete(&paths)?;
            Ok(snapshot(project, "main"))
        })
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathsResponse {
    pub snapshot: ProjectSnapshot,
    pub paths: Vec<String>,
}

#[tauri::command]
pub async fn file_rename(
    app: AppHandle,
    path: String,
    new_name: String,
) -> AppResult<PathsResponse> {
    blocking(app, move |state, _| {
        with_main(state, |project| {
            let new_path = project.rename(&path, new_name.trim())?;
            Ok(PathsResponse {
                snapshot: snapshot(project, "main"),
                paths: vec![new_path],
            })
        })
    })
    .await
}

#[tauri::command]
pub async fn files_move(
    app: AppHandle,
    paths: Vec<String>,
    folder: String,
) -> AppResult<PathsResponse> {
    blocking(app, move |state, _| {
        with_main(state, |project| {
            let moved = project.move_to_folder(&paths, &folder)?;
            Ok(PathsResponse {
                snapshot: snapshot(project, "main"),
                paths: moved,
            })
        })
    })
    .await
}

#[tauri::command]
pub async fn files_duplicate(app: AppHandle, paths: Vec<String>) -> AppResult<PathsResponse> {
    blocking(app, move |state, _| {
        with_main(state, |project| {
            let created = project.duplicate(&paths)?;
            Ok(PathsResponse {
                snapshot: snapshot(project, "main"),
                paths: created,
            })
        })
    })
    .await
}

/// Write one package file to disk (export a single resource).
#[tauri::command]
pub async fn file_extract(
    app: AppHandle,
    slot: Option<String>,
    path: String,
    destination: String,
) -> AppResult<()> {
    blocking(app, move |state, _| {
        let data =
            {
                let guard = if slot.as_deref() == Some("ref") {
                    lock(&state.reference)
                } else {
                    lock(&state.main)
                };
                let project = guard.as_ref().ok_or_else(AppError::no_project)?;
                project.files.get(&path).cloned().ok_or_else(|| {
                    AppError::not_found(format!("`{path}` is not in the package."))
                })?
            };
        storage::atomic_write(Path::new(&destination), &data.data)
    })
    .await
}

#[tauri::command]
pub async fn container_create(app: AppHandle, name: String) -> AppResult<ProjectSnapshot> {
    blocking(app, move |state, _| {
        with_main(state, |project| {
            project.create_container(name.trim())?;
            Ok(snapshot(project, "main"))
        })
    })
    .await
}

#[tauri::command]
pub async fn folder_pack(app: AppHandle, folder: String) -> AppResult<ProjectSnapshot> {
    blocking(app, move |state, _| {
        with_main(state, |project| {
            project.pack_folder(&folder)?;
            Ok(snapshot(project, "main"))
        })
    })
    .await
}

// ----- metadata ---------------------------------------------------------------

#[tauri::command]
pub async fn metadata_get(app: AppHandle, slot: Option<String>) -> AppResult<MetadataView> {
    blocking(app, move |state, _| {
        let guard = if slot.as_deref() == Some("ref") {
            lock(&state.reference)
        } else {
            lock(&state.main)
        };
        let project = guard.as_ref().ok_or_else(AppError::no_project)?;
        Ok(metadata::parse(project.text(DESCRIPTION_PATH).as_deref()))
    })
    .await
}

#[tauri::command]
pub async fn metadata_update(
    app: AppHandle,
    fields: Vec<FieldUpdate>,
    label: Option<String>,
) -> AppResult<ProjectSnapshot> {
    blocking(app, move |state, _| {
        with_main(state, |project| {
            let current = project.text(DESCRIPTION_PATH);
            let updated = metadata::update(current.as_deref(), &fields)?;
            let label = label.unwrap_or_else(|| match fields.as_slice() {
                [one] => format!("Edit {}", one.name),
                _ => "Edit theme details".to_string(),
            });
            project.put_file(DESCRIPTION_PATH, updated.into_bytes(), &label)?;
            Ok(snapshot(project, "main"))
        })
    })
    .await
}

// ----- history ----------------------------------------------------------------

#[tauri::command]
pub async fn history_undo(app: AppHandle) -> AppResult<ProjectSnapshot> {
    blocking(app, |state, _| {
        with_main(state, |project| {
            project.undo()?;
            Ok(snapshot(project, "main"))
        })
    })
    .await
}

#[tauri::command]
pub async fn history_redo(app: AppHandle) -> AppResult<ProjectSnapshot> {
    blocking(app, |state, _| {
        with_main(state, |project| {
            project.redo()?;
            Ok(snapshot(project, "main"))
        })
    })
    .await
}

#[tauri::command]
pub async fn history_goto(app: AppHandle, id: Option<u64>) -> AppResult<ProjectSnapshot> {
    blocking(app, move |state, _| {
        with_main(state, |project| {
            project.goto(id)?;
            Ok(snapshot(project, "main"))
        })
    })
    .await
}

// ----- save / export ------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub stage: &'static str,
    pub done: usize,
    pub total: usize,
}

struct Built {
    data: Vec<u8>,
    entries: usize,
    top: Option<u64>,
    name: String,
    source_path: Option<PathBuf>,
}

fn build_package(state: &AppState, app: Option<&AppHandle>) -> AppResult<Built> {
    let emit = |stage: &'static str, done: usize, total: usize| {
        if let Some(app) = app {
            let _ = app.emit("export-progress", ExportProgress { stage, done, total });
        }
    };
    emit("collect", 0, 1);
    let (entries, top, name, source_path) = with_main(state, |project| {
        Ok((
            project.export_entries()?,
            project.history.top(),
            project.name.clone(),
            project.source_path.clone(),
        ))
    })?;
    let write: Vec<WriteEntry> = entries
        .iter()
        .map(|e| WriteEntry {
            path: &e.path,
            data: e.bytes(),
            compression: e.compression,
        })
        .collect();
    let total = write.len();
    let step = (total / 50).max(1);
    let cursor = archive::write_zip(std::io::Cursor::new(Vec::new()), &write, |done, total| {
        if done % step == 0 || done == total {
            emit("write", done, total);
        }
    })?;
    let data = cursor.into_inner();
    emit("verify", total, total);
    archive::verify_zip(&data, &write)?;
    Ok(Built {
        data,
        entries: total,
        top,
        name,
        source_path,
    })
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SaveMode {
    Save,
    SaveAs,
    Copy,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub snapshot: ProjectSnapshot,
    pub path: String,
    pub bytes: usize,
    pub entries: usize,
    pub backup_path: Option<String>,
    pub verified: bool,
    pub duration_ms: u64,
    pub mode: &'static str,
}

#[tauri::command]
pub async fn project_save(
    app: AppHandle,
    path: Option<String>,
    mode: SaveMode,
) -> AppResult<SaveResult> {
    blocking(app, move |state, app| {
        let started = Instant::now();
        let built = build_package(state, Some(app))?;
        let target = match (mode, path) {
            (_, Some(path)) => PathBuf::from(path),
            (SaveMode::Save, None) => built.source_path.clone().ok_or_else(|| AppError::new("needs_path", "Choose where to save this package."))?,
            (_, None) => return Err(AppError::new("needs_path", "Choose a destination file.")),
        };
        let backups = lock(&state.settings).backups_enabled;
        let backup = if backups { storage::backup_existing(&state.paths, &target)? } else { None };
        let _ = app.emit("export-progress", ExportProgress { stage: "write-file", done: 1, total: 1 });
        storage::atomic_write(&target, &built.data)?;
        // Re-read from disk and verify the central directory survived.
        let on_disk = std::fs::read(&target).map_err(|e| AppError::io("Could not re-read the saved package", e))?;
        let verified = on_disk == built.data && archive::list_names(std::io::Cursor::new(&on_disk)).is_ok();
        if !verified {
            return Err(AppError::new("verify", "The saved file does not match what was written. The previous version is in the backups folder."));
        }
        let snap = with_main(state, |project| {
            if mode != SaveMode::Copy {
                project.mark_saved(built.top, Some(target.clone()));
            }
            Ok(snapshot(project, "main"))
        })?;
        if mode != SaveMode::Copy {
            storage::clear_recovery(&state.paths);
            let mut settings = lock(&state.settings);
            storage::push_recent(&mut settings, &target);
            let _ = storage::save_settings(&state.paths, &settings);
        }
        let _ = app.emit("export-progress", ExportProgress { stage: "done", done: 1, total: 1 });
        Ok(SaveResult {
            snapshot: snap,
            path: target.to_string_lossy().into_owned(),
            bytes: built.data.len(),
            entries: built.entries,
            backup_path: backup.map(|b| b.to_string_lossy().into_owned()),
            verified,
            duration_ms: started.elapsed().as_millis() as u64,
            mode: match mode {
                SaveMode::Save => "save",
                SaveMode::SaveAs => "saveAs",
                SaveMode::Copy => "copy",
            },
        })
    })
    .await
}

#[tauri::command]
pub async fn project_validate(app: AppHandle) -> AppResult<ValidationReport> {
    blocking(app, |state, _| {
        with_main(state, |project| Ok(validation::validate(project)))
    })
    .await
}

#[tauri::command]
pub async fn report_save(app: AppHandle, path: String) -> AppResult<()> {
    blocking(app, move |state, _| {
        let markdown = with_main(state, |project| {
            let report = validation::validate(project);
            Ok(validation::report_markdown(project, &report))
        })?;
        storage::atomic_write(Path::new(&path), markdown.as_bytes())
    })
    .await
}

// ----- autosave & recovery ----------------------------------------------------

#[tauri::command]
pub async fn autosave(app: AppHandle) -> AppResult<Option<RecoveryInfo>> {
    blocking(app, |state, _| {
        let (dirty, top) = {
            let guard = lock(&state.main);
            match guard.as_ref() {
                Some(project) => (project.is_dirty(), project.history.top()),
                None => return Ok(None),
            }
        };
        if !dirty || *lock(&state.last_autosave) == Some(top) {
            return Ok(None);
        }
        let built = build_package(state, None)?;
        let info = RecoveryInfo {
            name: built.name.clone(),
            source_path: built
                .source_path
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
            saved_at_ms: storage::now_ms(),
            bytes: built.data.len() as u64,
        };
        storage::write_recovery(&state.paths, &info, &built.data)?;
        *lock(&state.last_autosave) = Some(built.top);
        Ok(Some(info))
    })
    .await
}

#[tauri::command]
pub async fn recovery_restore(app: AppHandle) -> AppResult<ProjectSnapshot> {
    blocking(app, |state, _| {
        let (info, file) = storage::read_recovery(&state.paths)
            .ok_or_else(|| AppError::not_found("No recovery copy is available."))?;
        let data = read_limited(&file, MAX_PACKAGE_BYTES, "The recovery copy")?;
        let mut project = Project::from_bytes(
            &data,
            &info.name,
            info.source_path.as_ref().map(PathBuf::from),
            Limits::default(),
        )?;
        // Restored work has not been saved to its package yet.
        project.history = History::new(false);
        let snap = snapshot(&project, "main");
        *lock(&state.main) = Some(project);
        Ok(snap)
    })
    .await
}

#[tauri::command]
pub async fn recovery_discard(app: AppHandle) -> AppResult<()> {
    blocking(app, |state, _| {
        storage::clear_recovery(&state.paths);
        Ok(())
    })
    .await
}

// ----- reference package ------------------------------------------------------

#[tauri::command]
pub async fn reference_open(app: AppHandle, path: String) -> AppResult<ProjectSnapshot> {
    blocking(app, move |state, _| {
        let path = PathBuf::from(path);
        let data = read_limited(&path, MAX_PACKAGE_BYTES, "The reference package")?;
        let project =
            Project::from_bytes(&data, &file_name_of(&path), Some(path), Limits::default())?;
        let snap = snapshot(&project, "ref");
        *lock(&state.reference) = Some(project);
        Ok(snap)
    })
    .await
}

#[tauri::command]
pub async fn reference_snapshot(app: AppHandle) -> AppResult<Option<ProjectSnapshot>> {
    blocking(app, |state, _| {
        Ok(lock(&state.reference).as_ref().map(|p| snapshot(p, "ref")))
    })
    .await
}

#[tauri::command]
pub async fn reference_close(app: AppHandle) -> AppResult<()> {
    blocking(app, |state, _| {
        *lock(&state.reference) = None;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn reference_plan(
    app: AppHandle,
    paths: Vec<String>,
    folder: Option<String>,
) -> AppResult<Vec<CopyPlanItem>> {
    blocking(app, move |state, _| {
        let reference = lock(&state.reference);
        let source = reference
            .as_ref()
            .ok_or_else(|| AppError::not_found("No reference package is open."))?;
        with_main(state, |project| {
            project.plan_copy(source, &paths, folder.as_deref())
        })
    })
    .await
}

#[tauri::command]
pub async fn reference_copy(
    app: AppHandle,
    paths: Vec<String>,
    folder: Option<String>,
    policy: ConflictPolicy,
) -> AppResult<BulkResponse> {
    blocking(app, move |state, _| {
        let reference = lock(&state.reference);
        let source = reference
            .as_ref()
            .ok_or_else(|| AppError::not_found("No reference package is open."))?;
        with_main(state, |project| {
            let result = project.copy_from(source, &paths, folder.as_deref(), policy)?;
            Ok(BulkResponse {
                snapshot: snapshot(project, "main"),
                result,
            })
        })
    })
    .await
}

// ----- ADB --------------------------------------------------------------------

fn adb_for(state: &AppState, app: &AppHandle) -> AppResult<Adb> {
    let configured = lock(&state.settings).adb_path.clone();
    let (location, _) = adb::locate(configured.as_deref());
    let location = location.ok_or_else(|| {
        AppError::new(
            "adb_missing",
            "adb was not found. Install Android platform-tools or set the adb.exe location.",
        )
    })?;
    let handle = app.clone();
    let log: adb::Logger = Arc::new(move |entry: AdbLogEntry| {
        let state = handle.state::<AppState>();
        let mut log = lock(&state.adb_log);
        log.push_back(entry.clone());
        while log.len() > MAX_ADB_LOG {
            log.pop_front();
        }
        let _ = handle.emit("adb-log", entry);
    });
    Ok(Adb {
        path: PathBuf::from(location.path),
        log,
    })
}

fn register_op(state: &AppState, op_id: &Option<String>) -> Option<Arc<AtomicBool>> {
    op_id.as_ref().map(|id| {
        let flag = Arc::new(AtomicBool::new(false));
        lock(&state.operations).insert(id.clone(), flag.clone());
        flag
    })
}

fn finish_op(state: &AppState, op_id: &Option<String>) {
    if let Some(id) = op_id {
        lock(&state.operations).remove(id);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdbStatus {
    pub location: Option<AdbLocation>,
    pub searched: Vec<Candidate>,
    pub version: Option<String>,
    pub devices: Vec<DeviceEntry>,
    pub error: Option<AppError>,
    pub checked_at_ms: u64,
}

fn status_inner(state: &AppState, app: &AppHandle, quiet: bool, with_version: bool) -> AdbStatus {
    let configured = lock(&state.settings).adb_path.clone();
    let (location, searched) = adb::locate(configured.as_deref());
    let mut status = AdbStatus {
        location,
        searched,
        version: None,
        devices: Vec::new(),
        error: None,
        checked_at_ms: storage::now_ms(),
    };
    if status.location.is_none() {
        status.error = Some(AppError::new("adb_missing", "adb was not found."));
        return status;
    }
    match adb_for(state, app) {
        Ok(adb) => {
            if with_version {
                status.version = adb.version().ok();
            }
            match adb.devices(quiet) {
                Ok(devices) => status.devices = devices,
                Err(error) => status.error = Some(error),
            }
        }
        Err(error) => status.error = Some(error),
    }
    status
}

#[tauri::command]
pub async fn adb_status(
    app: AppHandle,
    quiet: Option<bool>,
    with_version: Option<bool>,
) -> AppResult<AdbStatus> {
    blocking(app, move |state, app| {
        Ok(status_inner(
            state,
            app,
            quiet.unwrap_or(false),
            with_version.unwrap_or(true),
        ))
    })
    .await
}

#[tauri::command]
pub async fn adb_restart_server(app: AppHandle) -> AppResult<AdbStatus> {
    blocking(app, |state, app| {
        adb_for(state, app)?.restart_server()?;
        Ok(status_inner(state, app, false, true))
    })
    .await
}

#[tauri::command]
pub async fn adb_details(app: AppHandle, serial: String) -> AppResult<DeviceDetails> {
    blocking(app, move |state, app| adb_for(state, app)?.details(&serial)).await
}

#[tauri::command]
pub async fn adb_cached_themes(
    app: AppHandle,
    serial: String,
) -> AppResult<Vec<adb::theme_cache::CachedTheme>> {
    blocking(app, move |state, app| {
        adb::theme_cache::list(&adb_for(state, app)?, &serial)
    })
    .await
}

#[tauri::command]
pub async fn adb_cached_theme_preview(
    app: AppHandle,
    serial: String,
    local_id: String,
) -> AppResult<Vec<u8>> {
    blocking(app, move |state, app| {
        adb::theme_cache::preview(&adb_for(state, app)?, &serial, &local_id)
    })
    .await
}

#[tauri::command]
pub async fn adb_cached_theme_reference(
    app: AppHandle,
    serial: String,
    local_id: String,
) -> AppResult<ProjectSnapshot> {
    blocking(app, move |state, app| {
        let package =
            adb::theme_cache::reference_package(&adb_for(state, app)?, &serial, &local_id)?;
        let mut project =
            Project::from_bytes(&package.archive, &package.name, None, Limits::default())?;
        if let Some(report) = project.import_report.as_mut() {
            report.warnings.extend(package.warnings);
        }
        let snapshot = snapshot(&project, "ref");
        *lock(&state.reference) = Some(project);
        Ok(snapshot)
    })
    .await
}

/// Open a theme cached by Theme Manager on the phone as an editable, untitled
/// project; the phone's copy stays untouched and saving asks for a location.
#[tauri::command]
pub async fn adb_cached_theme_open(
    app: AppHandle,
    serial: String,
    local_id: String,
) -> AppResult<ProjectSnapshot> {
    blocking(app, move |state, app| {
        let package =
            adb::theme_cache::reference_package(&adb_for(state, app)?, &serial, &local_id)?;
        let mut project =
            Project::from_bytes(&package.archive, &package.name, None, Limits::default())?;
        if let Some(report) = project.import_report.as_mut() {
            report.warnings.extend(package.warnings);
        }
        let snap = snapshot(&project, "main");
        *lock(&state.main) = Some(project);
        *lock(&state.last_autosave) = None;
        Ok(snap)
    })
    .await
}

#[tauri::command]
pub async fn adb_screenshot(
    app: AppHandle,
    serial: String,
    model: Option<String>,
    op_id: Option<String>,
) -> AppResult<ScreenshotInfo> {
    blocking(app, move |state, app| {
        let adb = adb_for(state, app)?;
        let cancel = register_op(state, &op_id);
        let result = adb.screenshot(&serial, cancel);
        finish_op(state, &op_id);
        let data = result?;
        let probe = crate::package::blob::probe_bytes(&data);
        let shot = Screenshot {
            id: NEXT_SHOT_ID.fetch_add(1, Ordering::Relaxed),
            serial,
            model,
            at_ms: storage::now_ms(),
            width: probe.width,
            height: probe.height,
            data: Arc::new(data),
        };
        let info = shot.info();
        let mut shots = lock(&state.screenshots);
        shots.push(shot);
        while shots.len() > MAX_SCREENSHOTS {
            shots.remove(0);
        }
        Ok(info)
    })
    .await
}

#[tauri::command]
pub async fn screenshots_list(app: AppHandle) -> AppResult<Vec<ScreenshotInfo>> {
    blocking(app, |state, _| {
        Ok(lock(&state.screenshots)
            .iter()
            .map(Screenshot::info)
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn screenshot_save(app: AppHandle, id: u64, path: String) -> AppResult<()> {
    blocking(app, move |state, _| {
        let data = lock(&state.screenshots)
            .iter()
            .find(|s| s.id == id)
            .map(|s| s.data.clone())
            .ok_or_else(|| AppError::not_found("That screenshot is no longer in memory."))?;
        storage::atomic_write(Path::new(&path), &data)
    })
    .await
}

#[tauri::command]
pub async fn adb_cancel(app: AppHandle, op_id: String) -> AppResult<bool> {
    blocking(app, move |state, _| {
        Ok(match lock(&state.operations).get(&op_id) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        })
    })
    .await
}

#[tauri::command]
pub async fn adb_log(app: AppHandle) -> AppResult<Vec<AdbLogEntry>> {
    blocking(app, |state, _| {
        Ok(lock(&state.adb_log).iter().cloned().collect())
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendResult {
    pub push: PushResult,
    pub package_entries: usize,
}

/// Copy the current package to the device's `Download/MiThemeStudio`
/// folder. Requires `confirmed: true` from an explicit user confirmation.
/// Nothing is installed or applied.
#[tauri::command]
pub async fn adb_send_package(
    app: AppHandle,
    serial: String,
    confirmed: bool,
    op_id: Option<String>,
) -> AppResult<SendResult> {
    blocking(app, move |state, app| {
        if !confirmed {
            return Err(AppError::new(
                "unconfirmed",
                "Sending to a device requires confirmation.",
            ));
        }
        let adb = adb_for(state, app)?;
        let built = build_package(state, Some(app))?;
        let staging = state.paths.staging_dir();
        let remote_name = adb::remote_file_name(&built.name);
        let local = staging.join(&remote_name);
        storage::atomic_write(&local, &built.data)?;
        let cancel = register_op(state, &op_id);
        let result = adb.push_verified(&serial, &local, &remote_name, cancel);
        finish_op(state, &op_id);
        let _ = std::fs::remove_file(&local);
        Ok(SendResult {
            push: result?,
            package_entries: built.entries,
        })
    })
    .await
}

// ----- Theme Manager on the phone ------------------------------------------------

#[tauri::command]
pub async fn adb_theme_support(app: AppHandle, serial: String) -> AppResult<adb::theme_apply::ThemeManagerSupport> {
    blocking(app, move |state, app| adb_for(state, app)?.theme_manager_support(&serial)).await
}

#[tauri::command]
pub async fn adb_open_store_item(app: AppHandle, serial: String, module_id: String) -> AppResult<()> {
    blocking(app, move |state, app| adb_for(state, app)?.open_store_item(&serial, &module_id)).await
}

#[tauri::command]
pub async fn adb_open_theme_settings(app: AppHandle, serial: String) -> AppResult<()> {
    blocking(app, move |state, app| adb_for(state, app)?.open_theme_settings(&serial)).await
}

/// Build the open project and apply it with Theme Manager's editor entry
/// point. Requires explicit confirmation and Theme Manager support.
#[tauri::command]
pub async fn adb_apply_theme(
    app: AppHandle,
    serial: String,
    confirmed: bool,
    op_id: Option<String>,
) -> AppResult<adb::theme_apply::ApplyResult> {
    blocking(app, move |state, app| {
        if !confirmed {
            return Err(AppError::new("unconfirmed", "Applying a theme on the phone requires confirmation."));
        }
        let adb = adb_for(state, app)?;
        let support = adb.theme_manager_support(&serial)?;
        if !support.can_apply {
            return Err(AppError::new(
                "unsupported",
                "This phone's Theme Manager has no editor apply entry point. Copy the package to the phone and apply it from Theme Manager instead.",
            ));
        }
        let built = build_package(state, Some(app))?;
        let staging = state.paths.staging_dir();
        let local = staging.join("apply-temp.mtz");
        storage::atomic_write(&local, &built.data)?;
        let cancel = register_op(state, &op_id);
        let result = adb.apply_theme(&serial, &local, &support, cancel);
        finish_op(state, &op_id);
        let _ = std::fs::remove_file(&local);
        result
    })
    .await
}

/// "Try on phone": export the project, add it to Theme Manager's library on the
/// phone and press Apply there. Earlier try-ons are replaced.
/// Apps installed on the phone (name + package), listed by the bundled scrcpy
/// server so nothing has to be installed on the phone.
#[tauri::command]
pub async fn adb_list_apps(app: AppHandle, serial: String) -> AppResult<Vec<adb::apps::DeviceApp>> {
    blocking(app, move |state, app| {
        let jar = state
            .resource_dir
            .as_deref()
            .map(|r| r.join("scrcpy").join("scrcpy-server"))
            .filter(|p| p.is_file())
            .ok_or_else(|| AppError::not_found("The bundled scrcpy server is missing. Reinstall Mi Theme Studio."))?;
        adb_for(state, app)?.list_apps(&serial, &jar)
    })
    .await
}

/// Add the project to Theme Manager's library on the phone without applying
/// it; it stays under My themes and its page opens on the phone.
#[tauri::command]
pub async fn adb_add_to_theme_manager(
    app: AppHandle,
    serial: String,
    op_id: Option<String>,
) -> AppResult<adb::theme_install::TryOnResult> {
    blocking(app, move |state, app| {
        let adb = adb_for(state, app)?;
        let title = lock(&state.main)
            .as_ref()
            .map(|p| p.title())
            .ok_or_else(|| AppError::invalid("Open a theme first."))?;
        let built = build_package(state, Some(app))?;
        let stage = state.paths.staging_dir().join("add-to-tm");
        let cancel = register_op(state, &op_id);
        let result = adb.try_on(&serial, &built.data, &title, &stage, false, false, cancel);
        finish_op(state, &op_id);
        let _ = std::fs::remove_dir_all(&stage);
        result
    })
    .await
}

/// Theme backups made by Apply with root (newest first).
#[tauri::command]
pub async fn adb_root_backups(app: AppHandle, serial: String) -> AppResult<Vec<adb::root_apply::ThemeBackup>> {
    blocking(app, move |state, app| adb_for(state, app)?.root_backups(&serial)).await
}

/// Restores one of those backups into /data/system/theme.
#[tauri::command]
pub async fn adb_root_restore(app: AppHandle, serial: String, backup: String) -> AppResult<Vec<String>> {
    blocking(app, move |state, app| adb_for(state, app)?.root_restore(&serial, &backup)).await
}

/// Applies the open theme with root by writing its parts into
/// `/data/system/theme` and restarting SystemUI. Needs `su` on the phone.
#[tauri::command]
pub async fn adb_root_apply(app: AppHandle, serial: String, op_id: Option<String>) -> AppResult<adb::root_apply::RootApplyResult> {
    blocking(app, move |state, app| {
        let adb = adb_for(state, app)?;
        let built = build_package(state, Some(app))?;
        let stage = state.paths.staging_dir().join("root-apply");
        let cancel = register_op(state, &op_id);
        let result = adb.root_apply(&serial, &built.data, &stage, cancel);
        finish_op(state, &op_id);
        let _ = std::fs::remove_dir_all(&stage);
        result
    })
    .await
}

/// Whether the open theme's `uiVersion` fits the phone's theme format.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeCompatibility {
    pub device_format: Option<u32>,
    pub theme_ui_version: Option<u32>,
    pub theme_adapter: Option<String>,
    pub supported: bool,
    pub detail: String,
}

/// The phone's theme format (140 = 14.0) from theme_compatibility.xml, or none if it does not say.
#[tauri::command]
pub async fn adb_theme_format(app: AppHandle, serial: String) -> AppResult<Option<u32>> {
    blocking(app, move |state, app| {
        let adb = adb_for(state, app)?;
        Ok(adb.theme_format(&serial))
    })
    .await
}

#[tauri::command]
pub async fn theme_compatibility(app: AppHandle, serial: String) -> AppResult<ThemeCompatibility> {
    blocking(app, move |state, app| {
        let adb = adb_for(state, app)?;
        let device_format = adb.theme_format(&serial);
        let (ui, adapter) = with_main(state, |project| {
            let xml = project.text("description.xml");
            let view = metadata::parse(xml.as_deref());
            let field = |name: &str| {
                view.fields
                    .iter()
                    .find(|f| f.name == name)
                    .map(|f| f.value.trim().to_string())
                    .filter(|v| !v.is_empty())
            };
            Ok((field("uiVersion").and_then(|v| v.parse::<u32>().ok()), field("miuiAdapterVersion")))
        })?;
        let supported = match (device_format, ui) {
            (Some(format), Some(version)) => format >= version * 10,
            _ => true,
        };
        let detail = match (device_format, ui) {
            (Some(format), Some(version)) => format!(
                "The phone renders theme format {:.1}; this theme targets uiVersion {}.",
                format as f32 / 10.0,
                version
            ),
            (Some(format), None) => format!("The phone renders theme format {:.1}; this theme does not declare a uiVersion.", format as f32 / 10.0),
            (None, _) => "The phone did not report a theme format, so compatibility cannot be checked.".to_string(),
        };
        Ok(ThemeCompatibility { device_format, theme_ui_version: ui, theme_adapter: adapter, supported, detail })
    })
    .await
}

/// Per-part licence verdict for the open project, checked against the rights
/// files already on the phone.
#[tauri::command]
pub async fn adb_licence_report(app: AppHandle, serial: String) -> AppResult<adb::theme_install::LicenceReport> {
    blocking(app, move |state, app| {
        let adb = adb_for(state, app)?;
        let built = build_package(state, Some(app))?;
        adb.licence_report(&serial, &built.data)
    })
    .await
}

/// Applies every downloaded store theme/font on the phone once so Theme
/// Manager stores its licence; afterwards its parts can be mixed freely.
#[tauri::command]
pub async fn adb_license_downloads(
    app: AppHandle,
    serial: String,
    op_id: Option<String>,
) -> AppResult<Vec<adb::theme_install::LicenseOutcome>> {
    blocking(app, move |state, app| {
        let adb = adb_for(state, app)?;
        let items: Vec<(String, String, Option<String>)> = store::list_downloads(&downloads_dir(state))
            .into_iter()
            .filter(|d| matches!(d.kind, store::ProductKind::Theme | store::ProductKind::Font))
            .map(|d| (d.module_id, d.name, d.product_id))
            .collect();
        if items.is_empty() {
            return Err(AppError::invalid("No downloaded themes or fonts to license. Download some in the Store first."));
        }
        let cancel = register_op(state, &op_id);
        let out = adb.license_store_items(&serial, &items, cancel);
        finish_op(state, &op_id);
        Ok(out)
    })
    .await
}

#[tauri::command]
pub async fn adb_try_on(app: AppHandle,
    serial: String,
    op_id: Option<String>,
) -> AppResult<adb::theme_install::TryOnResult> {
    blocking(app, move |state, app| {
        let adb = adb_for(state, app)?;
        let title = lock(&state.main)
            .as_ref()
            .map(|p| p.title())
            .ok_or_else(|| AppError::invalid("Open a theme first."))?;
        let built = build_package(state, Some(app))?;
        let stage = state.paths.staging_dir().join("try-on");
        let cancel = register_op(state, &op_id);
        // Xiaomi's editor entry point when the phone has it (Chinese builds);
        // otherwise Theme Manager's library.
        let support = adb.theme_manager_support(&serial).ok().filter(|s| s.can_apply);
        let result = match support {
            Some(support) => adb.try_on_with_editor_entry(&serial, &built.data, &stage, &support, cancel),
            None => adb.try_on(&serial, &built.data, &title, &stage, false, true, cancel),
        };
        finish_op(state, &op_id);
        let _ = std::fs::remove_dir_all(&stage);
        result
    })
    .await
}

// ----- screen mirroring (bundled scrcpy) ------------------------------------------

fn mirror_status_of(state: &AppState) -> adb::mirror::MirrorStatus {
    let mut guard = lock(&state.mirror);
    if guard.as_mut().is_some_and(|m| !m.running()) {
        *guard = None;
    }
    let resources = state.resource_dir.as_deref();
    adb::mirror::MirrorStatus {
        available: resources.and_then(adb::mirror::bundled).is_some(),
        running: guard.is_some(),
        serial: guard.as_ref().map(|m| m.serial.clone()),
        started_ms: guard.as_ref().map(|m| m.started_ms),
        version: resources.and_then(adb::mirror::bundled_version),
    }
}

#[tauri::command]
pub async fn mirror_status(app: AppHandle) -> AppResult<adb::mirror::MirrorStatus> {
    blocking(app, |state, _| Ok(mirror_status_of(state))).await
}

/// Open a live mirror window of the device (one at a time).
#[tauri::command]
pub async fn mirror_start(app: AppHandle, serial: String, title: Option<String>) -> AppResult<adb::mirror::MirrorStatus> {
    blocking(app, move |state, app| {
        let scrcpy = state
            .resource_dir
            .as_deref()
            .and_then(adb::mirror::bundled)
            .ok_or_else(|| AppError::not_found("The bundled scrcpy is missing. Reinstall Mi Theme Studio, or run `npm run fetch:scrcpy` in a development checkout."))?;
        let adb = adb_for(state, app)?;
        lock(&state.mirror).take();
        let window_title = title.unwrap_or_else(|| format!("{serial} · Mi Theme Studio"));
        let mirror = adb::mirror::start(&scrcpy, &adb.path, &serial, &window_title, adb.log.clone())?;
        *lock(&state.mirror) = Some(mirror);
        Ok(mirror_status_of(state))
    })
    .await
}

#[tauri::command]
pub async fn mirror_stop(app: AppHandle) -> AppResult<adb::mirror::MirrorStatus> {
    blocking(app, |state, _| {
        lock(&state.mirror).take();
        Ok(mirror_status_of(state))
    })
    .await
}

// ----- in-app mirror (scrcpy protocol) ---------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamInfo {
    serial: String,
    width: u32,
    height: u32,
}

/// Start streaming the phone screen into the app. Binary messages (see
/// `adb::stream::MSG_*`) arrive on `channel` until the stream ends.
#[tauri::command]
pub async fn stream_start(
    app: AppHandle,
    serial: String,
    max_size: Option<u32>,
    channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> AppResult<StreamInfo> {
    blocking(app, move |state, app| {
        let jar = state
            .resource_dir
            .as_deref()
            .map(|r| r.join("scrcpy").join("scrcpy-server"))
            .filter(|p| p.is_file())
            .ok_or_else(|| AppError::not_found("The bundled mirror server is missing. Reinstall Mi Theme Studio."))?;
        let adb = adb_for(state, app)?;
        lock(&state.stream).take();
        let stream = adb::stream::start(
            adb::stream::StartOptions { adb: &adb.path, server_jar: &jar, serial: &serial, max_size: max_size.unwrap_or(1280), log: adb.log.clone() },
            move |message| {
                let _ = channel.send(tauri::ipc::InvokeResponseBody::Raw(message));
            },
        )?;
        let info = StreamInfo { serial: stream.serial.clone(), width: stream.width, height: stream.height };
        *lock(&state.stream) = Some(stream);
        Ok(info)
    })
    .await
}

#[tauri::command]
pub async fn stream_stop(app: AppHandle) -> AppResult<()> {
    blocking(app, |state, _| {
        lock(&state.stream).take();
        Ok(())
    })
    .await
}

fn with_stream(state: &AppState, message: &[u8]) -> AppResult<()> {
    let guard = lock(&state.stream);
    let stream = guard.as_ref().ok_or_else(|| AppError::new("mirror", "The mirror is not running."))?;
    stream.send(message)
}

/// Touch at (x, y) in video pixels; `width`/`height` is the current video size.
#[tauri::command]
pub fn stream_touch(app: AppHandle, action: u8, x: i32, y: i32, width: u16, height: u16) -> AppResult<()> {
    if action > adb::stream::ACTION_MOVE {
        return Err(AppError::invalid("Invalid touch action."));
    }
    with_stream(&app.state::<AppState>(), &adb::stream::touch_message(action, x, y, width, height))
}

#[tauri::command]
pub fn stream_scroll(app: AppHandle, x: i32, y: i32, width: u16, height: u16, hscroll: f32, vscroll: f32) -> AppResult<()> {
    with_stream(&app.state::<AppState>(), &adb::stream::scroll_message(x, y, width, height, hscroll, vscroll))
}

/// Press a phone button: back, home, recents, power, volumeUp, volumeDown.
#[tauri::command]
pub fn stream_key(app: AppHandle, key: String) -> AppResult<()> {
    let state = app.state::<AppState>();
    if key == "back" {
        with_stream(&state, &adb::stream::back_message(adb::stream::ACTION_DOWN))?;
        return with_stream(&state, &adb::stream::back_message(adb::stream::ACTION_UP));
    }
    let code = match key.as_str() {
        "home" => 3,
        "recents" => 187,
        "power" => 26,
        "volumeUp" => 24,
        "volumeDown" => 25,
        _ => return Err(AppError::invalid("Unknown key.")),
    };
    with_stream(&state, &adb::stream::key_message(adb::stream::ACTION_DOWN, code))?;
    with_stream(&state, &adb::stream::key_message(adb::stream::ACTION_UP, code))
}

// ----- nine-patch -------------------------------------------------------------------

#[tauri::command]
pub async fn ninepatch_info(app: AppHandle, slot: Option<String>, path: String) -> AppResult<NinePatch> {
    blocking(app, move |state, _| {
        let guard = if slot.as_deref() == Some("ref") { lock(&state.reference) } else { lock(&state.main) };
        let project = guard.as_ref().ok_or_else(AppError::no_project)?;
        let blob = project
            .files
            .get(&path)
            .ok_or_else(|| AppError::not_found(format!("`{path}` is not in the package.")))?;
        ninepatch::read(&blob.data)
    })
    .await
}

#[tauri::command]
pub async fn ninepatch_update(app: AppHandle, path: String, update: NinePatchUpdate) -> AppResult<ProjectSnapshot> {
    blocking(app, move |state, _| {
        with_main(state, |project| {
            let blob = project
                .files
                .get(&path)
                .cloned()
                .ok_or_else(|| AppError::not_found(format!("`{path}` is not in the package.")))?;
            let bytes = ninepatch::write(&blob.data, &update)?;
            project.put_file(&path, bytes, &format!("Edit nine-patch {}", paths::file_name(&path)))?;
            Ok(snapshot(project, "main"))
        })
    })
    .await
}

// ----- find and replace ----------------------------------------------------------

#[tauri::command]
pub async fn project_search(app: AppHandle, options: SearchOptions) -> AppResult<SearchResult> {
    blocking(app, move |state, _| with_main(state, |project| search::search(project, &options))).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceResponse {
    result: ReplaceResult,
    snapshot: ProjectSnapshot,
}

#[tauri::command]
pub async fn project_replace(
    app: AppHandle,
    options: SearchOptions,
    replacement: String,
    targets: Vec<ReplaceTarget>,
    allow_invalid_xml: bool,
) -> AppResult<ReplaceResponse> {
    blocking(app, move |state, _| {
        with_main(state, |project| {
            let result = search::replace(project, &options, &replacement, &targets, allow_invalid_xml)?;
            Ok(ReplaceResponse { result, snapshot: snapshot(project, "main") })
        })
    })
    .await
}

// ----- online theme store ---------------------------------------------------------

fn user_agent(app: &AppHandle) -> String {
    format!("MiThemeStudio/{}", app.package_info().version)
}

fn downloads_dir(state: &AppState) -> PathBuf {
    state.paths.data.join("downloads")
}

/// One page of store listings (home, categories, a page, a shelf or search).
#[tauri::command]
pub async fn store_page(
    app: AppHandle,
    query: StoreQuery,
    start: Option<u32>,
    region: Option<String>,
) -> AppResult<StorePage> {
    blocking(app, move |_, app| {
        store::fetch_page(&query, start.unwrap_or(0), region.as_deref(), &user_agent(app))
    })
    .await
}

#[tauri::command]
pub async fn store_detail(app: AppHandle, id: String, region: Option<String>) -> AppResult<ThemeDetail> {
    blocking(app, move |_, app| store::fetch_detail(&id, region.as_deref(), &user_agent(app))).await
}

/// Download a free theme into the app's downloads folder (verified by SHA-1).
#[tauri::command]
pub async fn store_download(
    app: AppHandle,
    module_id: String,
    region: Option<String>,
) -> AppResult<DownloadedTheme> {
    blocking(app, move |state, app| {
        let dir = downloads_dir(state);
        let id = module_id.clone();
        store::download(&module_id, region.as_deref(), &dir, &user_agent(app), |received, total| {
            let _ = app.emit(
                "store-download",
                DownloadProgress { module_id: id.clone(), received, total },
            );
        })
    })
    .await
}

#[tauri::command]
pub fn store_cancel(module_id: String) {
    store::cancel(&module_id);
}

#[tauri::command]
pub async fn store_downloads(app: AppHandle) -> AppResult<Vec<DownloadedTheme>> {
    blocking(app, |state, _| Ok(store::list_downloads(&downloads_dir(state)))).await
}

#[tauri::command]
pub async fn store_remove_download(app: AppHandle, module_id: String) -> AppResult<()> {
    blocking(app, move |state, _| store::remove_download(&downloads_dir(state), &module_id)).await
}

/// Where a downloaded wallpaper or ringtone goes in the theme.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaTarget {
    HomeWallpaper,
    LockWallpaper,
    Ringtone,
    Notification,
    Alarm,
}

impl MediaTarget {
    fn stem(self) -> &'static str {
        match self {
            MediaTarget::HomeWallpaper => "wallpaper/default_wallpaper",
            MediaTarget::LockWallpaper => "wallpaper/default_lock_wallpaper",
            MediaTarget::Ringtone => "ringtones/ringtone",
            MediaTarget::Notification => "ringtones/notification",
            MediaTarget::Alarm => "ringtones/alarm",
        }
    }

    fn kind(self) -> store::ProductKind {
        match self {
            MediaTarget::HomeWallpaper | MediaTarget::LockWallpaper => store::ProductKind::Wallpaper,
            _ => store::ProductKind::Ringtone,
        }
    }
}

/// Put a downloaded wallpaper or ringtone into the open project.
#[tauri::command]
pub async fn store_apply_media(app: AppHandle, module_id: String, target: MediaTarget) -> AppResult<ProjectSnapshot> {
    blocking(app, move |state, _| {
        let record = store::existing(&downloads_dir(state), &module_id)
            .ok_or_else(|| AppError::not_found("That item is not downloaded."))?;
        if record.kind != target.kind() {
            return Err(AppError::invalid("This download cannot be used there."));
        }
        let path = PathBuf::from(&record.path);
        let ext = paths::extension(&record.path);
        let data = read_limited(&path, MAX_ASSET_BYTES, "The download")?;
        with_main(state, |project| {
            project.place_file(
                target.stem(),
                &ext,
                data,
                &format!("Use “{}” from the theme store", record.name),
                Some((record.name.clone(), record.designer.clone().unwrap_or_default(), format!("Theme store · {}", record.module_id))),
            )?;
            Ok(snapshot(project, "main"))
        })
    })
    .await
}

/// Open a downloaded theme as an editable, untitled copy: saving asks for a
/// new location instead of overwriting the cached download.
#[tauri::command]
pub async fn store_open_project(app: AppHandle, module_id: String) -> AppResult<ProjectSnapshot> {
    blocking(app, move |state, _| {
        let record = store::existing(&downloads_dir(state), &module_id)
            .ok_or_else(|| AppError::not_found("That theme is not downloaded."))?;
        if !matches!(record.kind, store::ProductKind::Theme | store::ProductKind::Font) {
            return Err(AppError::invalid("Only theme and font packages can be opened as a project."));
        }
        let path = PathBuf::from(&record.path);
        let data = read_limited(&path, MAX_PACKAGE_BYTES, "The package")?;
        let project = Project::from_bytes(&data, &file_name_of(&path), None, Limits::default())?;
        let snap = snapshot(&project, "main");
        *lock(&state.main) = Some(project);
        *lock(&state.last_autosave) = None;
        Ok(snap)
    })
    .await
}
