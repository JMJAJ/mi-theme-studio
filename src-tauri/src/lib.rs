//! Mi Theme Studio native backend.
//!
//! Modules:
//! - `package`: archive I/O, path safety, metadata (description.xml)
//! - `project`: in-memory workspace, undo/redo, classification, snapshots
//! - `validation`: structural package checks and reports
//! - `storage`: settings, recents, autosave recovery, backups
//! - `adb`: device discovery, details, screenshots, verified file copy
//! - `store`: online theme store (browse, details, verified free downloads)
//! - `commands` / `protocol` / `state`: Tauri integration

pub mod adb;
pub mod commands;
pub mod error;
pub mod package;
pub mod project;
pub mod protocol;
pub mod state;
pub mod storage;
pub mod store;
pub mod validation;

use state::AppState;
use storage::AppPaths;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .register_uri_scheme_protocol("themeres", protocol::handle)
        .setup(|app| {
            let resolver = app.path();
            let paths = AppPaths {
                config: resolver.app_config_dir()?,
                data: resolver.app_data_dir()?,
            };
            let settings = storage::load_settings(&paths);
            let mut state = AppState::new(paths, settings);
            if let Ok(resources) = resolver.resource_dir() {
                let bundled_adb = resources.join("scrcpy").join(if cfg!(windows) { "adb.exe" } else { "adb" });
                if bundled_adb.is_file() {
                    let _ = adb::BUNDLED_ADB.set(bundled_adb);
                }
                state.resource_dir = Some(resources);
            }
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::settings_update,
            commands::recent_remove,
            commands::project_new,
            commands::project_open,
            commands::project_snapshot,
            commands::project_close,
            commands::file_text,
            commands::file_write_text,
            commands::files_import,
            commands::files_write,
            commands::file_replace,
            commands::files_delete,
            commands::file_rename,
            commands::files_move,
            commands::files_duplicate,
            commands::file_extract,
            commands::container_create,
            commands::folder_pack,
            commands::metadata_get,
            commands::metadata_update,
            commands::history_undo,
            commands::history_redo,
            commands::history_goto,
            commands::project_save,
            commands::project_validate,
            commands::report_save,
            commands::autosave,
            commands::recovery_restore,
            commands::recovery_discard,
            commands::reference_open,
            commands::reference_snapshot,
            commands::reference_close,
            commands::reference_plan,
            commands::reference_copy,
            commands::adb_status,
            commands::adb_restart_server,
            commands::adb_details,
            commands::adb_cached_themes,
            commands::adb_cached_theme_preview,
            commands::adb_cached_theme_reference,
            commands::adb_cached_theme_open,
            commands::adb_try_on,
            commands::adb_licence_report,
            commands::adb_license_downloads,
            commands::adb_root_apply,
            commands::adb_reboot,
            commands::adb_root_backups,
            commands::adb_root_restore,
            commands::theme_compatibility,
            commands::adb_theme_format,
            commands::adb_add_to_theme_manager,
            commands::adb_list_apps,
            commands::adb_screenshot,
            commands::screenshots_list,
            commands::screenshot_save,
            commands::adb_cancel,
            commands::adb_log,
            commands::adb_send_package,
            commands::adb_theme_support,
            commands::adb_prepare_theme_manager,
            commands::adb_open_store_item,
            commands::adb_open_theme_settings,
            commands::adb_apply_theme,
            commands::mirror_start,
            commands::mirror_stop,
            commands::mirror_status,
            commands::stream_start,
            commands::stream_stop,
            commands::stream_touch,
            commands::stream_scroll,
            commands::stream_key,
            commands::ninepatch_info,
            commands::ninepatch_update,
            commands::project_search,
            commands::project_replace,
            commands::store_page,
            commands::store_detail,
            commands::store_download,
            commands::store_cancel,
            commands::store_downloads,
            commands::store_remove_download,
            commands::store_open_project,
            commands::store_apply_media,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Mi Theme Studio")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // Close a running scrcpy window with the app.
                let state = app.state::<AppState>();
                state::lock(&state.mirror).take();
                state::lock(&state.stream).take();
                // An adb server started from the bundled adb keeps running and
                // locks the install folder, which breaks the next update.
                let configured = state::lock(&state.settings).adb_path.clone();
                if let (Some(location), _) = adb::locate(configured.as_deref()) {
                    if location.source == "bundled" {
                        adb::kill_server_quietly(std::path::Path::new(&location.path));
                    }
                }
            }
        });
}
