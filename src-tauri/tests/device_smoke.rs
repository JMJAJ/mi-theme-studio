//! Opt-in smoke test against a real device:
//! `MTS_DEVICE_SMOKE=1 cargo test --test device_smoke -- --ignored --nocapture`
//! Read-only: lists devices, reads properties and cached theme metadata,
//! captures one screenshot, and reads one cached preview into memory.
//! Serials are masked in output and nothing is written to disk.

use mi_theme_studio_lib::adb::{self, Adb};
use std::path::PathBuf;
use std::sync::Arc;

fn mask(serial: &str) -> String {
    format!("{}…", &serial[..serial.len().min(3)])
}

#[test]
#[ignore]
fn live_device_read_only() {
    if std::env::var("MTS_DEVICE_SMOKE").as_deref() != Ok("1") {
        eprintln!("set MTS_DEVICE_SMOKE=1 to run");
        return;
    }
    let (location, _) = adb::locate(std::env::var("MTS_ADB").ok().as_deref());
    let location = location.expect("adb not found");
    println!("adb: {} ({})", location.path, location.source);
    let adb = Adb {
        path: PathBuf::from(&location.path),
        log: Arc::new(|e| {
            println!(
                "  [{}] {} -> {:?} {}ms",
                if e.ok { "ok" } else { "err" },
                e.command.split(" -s ").next().unwrap_or(""),
                e.code,
                e.duration_ms
            )
        }),
    };
    println!("version: {}", adb.version().unwrap());
    let devices = adb.devices(false).unwrap();
    println!("devices: {}", devices.len());
    for device in &devices {
        println!(
            "  {} state={} model={:?}",
            mask(&device.serial),
            device.state,
            device.model
        );
    }
    let Some(device) = devices.iter().find(|d| d.state == "device") else {
        return;
    };
    let details = adb.details(&device.serial).unwrap();
    println!(
        "details: {:?} {:?} android={:?} hyperos={:?} miui={:?} screen={:?} density={:?} theme_manager={:?}",
        details.manufacturer, details.market_name.or(details.model), details.android_version, details.hyperos_version, details.miui_version, details.screen, details.density, details.theme_manager_version
    );
    let png = adb.screenshot(&device.serial, None).unwrap();
    let size = imagesize::blob_size(&png).unwrap();
    println!(
        "screenshot: {} bytes, {}x{}",
        png.len(),
        size.width,
        size.height
    );
    match adb::theme_cache::list(&adb, &device.serial) {
        Ok(themes) => {
            println!("cached Theme Manager themes: {}", themes.len());
            for theme in themes.iter().take(5) {
                println!(
                    "  {:?} by {:?} ({} components)",
                    theme.title,
                    theme.author,
                    theme.components.len()
                );
            }
            if let Some(theme) = themes.iter().find(|theme| theme.has_preview) {
                let preview =
                    adb::theme_cache::preview(&adb, &device.serial, &theme.local_id).unwrap();
                assert!(
                    preview.starts_with(b"\xFF\xD8\xFF")
                        || preview.starts_with(b"\x89PNG\r\n\x1A\n")
                        || preview.get(8..12) == Some(&b"WEBP"[..])
                );
                println!("cached preview: {} bytes", preview.len());
            }
            if let Some(theme) = themes
                .iter()
                .find(|theme| theme.title == "Samurai")
                .or_else(|| themes.first())
            {
                let package =
                    adb::theme_cache::reference_package(&adb, &device.serial, &theme.local_id)
                        .unwrap();
                let project = mi_theme_studio_lib::project::Project::from_bytes(
                    &package.archive,
                    &package.name,
                    None,
                    mi_theme_studio_lib::package::archive::Limits::default(),
                )
                .unwrap();
                assert_eq!(project.title(), theme.title);
                assert!(
                    !project.containers.is_empty(),
                    "a cached theme reference should include component archives"
                );
                println!(
                    "cached reference: {} files, {} components, {} import warnings",
                    project.files.len(),
                    project.containers.len(),
                    package.warnings.len()
                );
            }
        }
        Err(error) => println!("cached themes: {}", error.message),
    }
}
