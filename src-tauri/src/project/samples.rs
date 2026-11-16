//! Round-trip checks against real theme packages (opt-in).
//!
//! `MTS_SAMPLES=<folder or file;file> cargo test project::samples -- --ignored --nocapture`
//!
//! For every `.mtz`/`.zip` sample:
//! 1. an untouched export reproduces every top-level entry byte-for-byte, in
//!    the original order (nested component archives included);
//! 2. the export reopens with the same file map;
//! 3. editing one file inside a component archive changes only that file
//!    after reopening, and leaves every other component archive identical;
//! 4. validation runs; its findings are printed for review.

use super::Project;
use crate::package::archive::{zip_to_vec, Limits, WriteEntry};
use crate::package::paths::NESTED_SEP;
use std::collections::BTreeMap;
use std::io::Read;
use std::path::PathBuf;

fn samples() -> Vec<PathBuf> {
    let Ok(raw) = std::env::var("MTS_SAMPLES") else { return Vec::new() };
    let mut out = Vec::new();
    for part in raw.split(';').filter(|p| !p.trim().is_empty()) {
        let path = PathBuf::from(part.trim());
        if path.is_dir() {
            let mut files: Vec<PathBuf> = std::fs::read_dir(&path)
                .unwrap()
                .flatten()
                .map(|e| e.path())
                .filter(|p| matches!(p.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref(), Some("mtz" | "zip")))
                .collect();
            files.sort();
            out.extend(files);
        } else {
            out.push(path);
        }
    }
    out
}

/// Top-level entries of a zip as (name, decompressed bytes), in archive order.
fn entries(data: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(data)).unwrap();
    let mut out = Vec::new();
    for i in 0..zip.len() {
        let mut file = zip.by_index(i).unwrap();
        if file.is_dir() {
            continue;
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        out.push((file.name().unwrap().to_string(), bytes));
    }
    out
}

fn export(project: &Project) -> Vec<u8> {
    let entries = project.export_entries().unwrap();
    let write: Vec<WriteEntry> = entries
        .iter()
        .map(|e| WriteEntry { path: &e.path, data: e.bytes(), compression: e.compression })
        .collect();
    zip_to_vec(&write).unwrap()
}

fn file_map(project: &Project) -> BTreeMap<String, Vec<u8>> {
    project.files.iter().map(|(k, v)| (k.clone(), v.data.clone())).collect()
}

#[test]
#[ignore]
fn real_packages_round_trip() {
    let list = samples();
    if list.is_empty() {
        println!("MTS_SAMPLES not set; nothing to check");
        return;
    }
    let mut failures = Vec::new();
    for path in &list {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let data = std::fs::read(path).unwrap();
        let project = match Project::from_bytes(&data, &name, None, Limits::default()) {
            Ok(p) => p,
            Err(e) => {
                failures.push(format!("{name}: does not open: {}", e.message));
                continue;
            }
        };
        let report = project.import_report.clone();
        let skipped = report.as_ref().map_or(0, |r| r.skipped.len());

        // 1. untouched export is byte-identical per entry and in order
        let original = entries(&data);
        let exported_bytes = export(&project);
        let exported = entries(&exported_bytes);
        let original_names: Vec<&str> = original.iter().map(|(n, _)| n.as_str()).collect();
        let exported_names: Vec<&str> = exported.iter().map(|(n, _)| n.as_str()).collect();
        if skipped == 0 && original_names != exported_names {
            failures.push(format!("{name}: entry order/names differ ({} vs {})", original_names.len(), exported_names.len()));
        }
        let changed: Vec<&str> = original
            .iter()
            .filter(|(n, bytes)| exported.iter().find(|(m, _)| m == n).is_some_and(|(_, b)| b != bytes))
            .map(|(n, _)| n.as_str())
            .collect();
        if !changed.is_empty() {
            failures.push(format!("{name}: {} entries changed on an untouched export: {:?}", changed.len(), &changed[..changed.len().min(5)]));
        }

        // 2. reopen gives the same file map
        let reopened = Project::from_bytes(&exported_bytes, &name, None, Limits::default()).unwrap();
        if file_map(&reopened) != file_map(&project) {
            failures.push(format!("{name}: file map differs after reopening the export"));
        }

        // 3. one edit inside a component archive stays local
        let mut edited = Project::from_bytes(&data, &name, None, Limits::default()).unwrap();
        let target = edited
            .files
            .keys()
            .find(|k| k.contains(NESTED_SEP) && k.ends_with(".xml"))
            .or_else(|| edited.files.keys().find(|k| k.contains(NESTED_SEP)))
            .cloned();
        if let Some(target) = &target {
            let mut bytes = edited.files[target].data.clone();
            bytes.extend_from_slice(b"\n<!-- mts round-trip -->\n");
            edited.put_file(target, bytes.clone(), "edit").unwrap();
            let edited_bytes = export(&edited);
            let after = Project::from_bytes(&edited_bytes, &name, None, Limits::default()).unwrap();
            let before_map = file_map(&project);
            let after_map = file_map(&after);
            let diff: Vec<&String> = before_map.keys().chain(after_map.keys()).filter(|k| before_map.get(*k) != after_map.get(*k)).collect();
            let mut diff: Vec<&String> = diff;
            diff.dedup();
            if diff != vec![target] {
                failures.push(format!("{name}: editing {target} changed {} files: {:?}", diff.len(), &diff[..diff.len().min(5)]));
            }
            let outer = target.split(NESTED_SEP).next().unwrap();
            let edited_entries = entries(&edited_bytes);
            let other_changed: Vec<&str> = original
                .iter()
                .filter(|(n, _)| n != outer)
                .filter(|(n, bytes)| edited_entries.iter().find(|(m, _)| m == n).is_some_and(|(_, b)| b != bytes))
                .map(|(n, _)| n.as_str())
                .collect();
            if !other_changed.is_empty() {
                failures.push(format!("{name}: editing {target} also rewrote {other_changed:?}"));
            }
        }

        // 4. validation summary
        let validation = crate::validation::validate(&project);
        let errors = validation.issues.iter().filter(|i| i.severity == crate::validation::Severity::Error).count();
        let warnings = validation.issues.iter().filter(|i| i.severity == crate::validation::Severity::Warning).count();
        println!(
            "{name}: {} files, {} components, {} skipped, export {} entries ok, validation {errors} errors / {warnings} warnings",
            project.files.len(),
            project.containers.len(),
            skipped,
            exported.len()
        );
        for issue in validation.issues.iter().take(4) {
            println!("    {:?} {}: {} {}", issue.severity, issue.code, issue.path.as_deref().unwrap_or(""), issue.message);
        }
    }
    assert!(failures.is_empty(), "round-trip failures:\n{}", failures.join("\n"));
    println!("{} samples round-tripped", list.len());
}
