//! Serializable views of a project for the UI. File contents are never sent
//! here; previews load through the `themeres:` protocol and text through
//! dedicated commands.

use super::classify::{component_of, density_of, kind_of, ComponentDef, COMPONENTS};
use super::history::HistoryItem;
use super::{Attribution, Project};
use crate::package::archive::ImportReport;
use crate::package::blob::Compression;
use crate::package::paths::NESTED_SEP;
use serde::Serialize;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub size: usize,
    pub kind: &'static str,
    pub component: &'static str,
    pub format: Option<&'static str>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub nine_patch: bool,
    pub density: Option<&'static str>,
    /// `original`, `modified` or `added` relative to the last open/save.
    pub status: &'static str,
    pub rev: u64,
    pub compression: Compression,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInfo {
    pub name: String,
    pub component: &'static str,
    pub files: usize,
    pub bytes: usize,
    pub status: &'static str,
    pub original_bytes: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub slot: &'static str,
    pub name: String,
    pub title: String,
    pub source_path: Option<String>,
    pub dirty: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    pub undo_label: Option<String>,
    pub redo_label: Option<String>,
    pub files: Vec<FileInfo>,
    pub containers: Vec<ContainerInfo>,
    pub removed: Vec<String>,
    pub total_bytes: usize,
    pub history: Vec<HistoryItem>,
    pub import_report: Option<ImportReport>,
    pub attributions: Vec<Attribution>,
    pub components: &'static [ComponentDef],
}

pub fn snapshot(project: &Project, slot: &'static str) -> ProjectSnapshot {
    let mut total = 0usize;
    let files: Vec<FileInfo> = project
        .files
        .iter()
        .map(|(path, blob)| {
            total += blob.data.len();
            let probe = blob.probe();
            let status = match project.baseline.get(path) {
                Some(base) if Arc::ptr_eq(base, blob) => "original",
                Some(_) => "modified",
                None => "added",
            };
            FileInfo {
                path: path.clone(),
                size: blob.data.len(),
                kind: kind_of(path, probe),
                component: component_of(path),
                format: probe.format,
                width: probe.width,
                height: probe.height,
                nine_patch: path.to_ascii_lowercase().ends_with(".9.png"),
                density: density_of(path),
                status,
                rev: blob.rev,
                compression: blob.compression,
            }
        })
        .collect();
    let containers = project
        .containers
        .iter()
        .map(|(name, container)| {
            let prefix = format!("{name}{NESTED_SEP}");
            let children: Vec<&FileInfo> = files
                .iter()
                .filter(|f| f.path.starts_with(&prefix))
                .collect();
            let changed = children.iter().any(|f| f.status != "original")
                || children.len() != container.original_children.len();
            ContainerInfo {
                name: name.clone(),
                component: component_of(name),
                files: children.len(),
                bytes: children.iter().map(|f| f.size).sum(),
                status: if container.original.is_none() {
                    "added"
                } else if changed {
                    "modified"
                } else {
                    "original"
                },
                original_bytes: container.original.as_ref().map(|b| b.data.len()),
            }
        })
        .collect();
    let mut removed: Vec<String> = project
        .baseline
        .keys()
        .filter(|k| !project.files.contains_key(*k))
        .cloned()
        .collect();
    removed.sort();
    ProjectSnapshot {
        slot,
        name: project.name.clone(),
        title: project.title(),
        source_path: project
            .source_path
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned()),
        dirty: slot == "main" && project.is_dirty(),
        can_undo: !project.history.undo.is_empty(),
        can_redo: !project.history.redo.is_empty(),
        undo_label: project.history.undo.last().map(|c| c.label.clone()),
        redo_label: project.history.redo.last().map(|c| c.label.clone()),
        files,
        containers,
        removed,
        total_bytes: total,
        history: project.history.items(),
        import_report: project.import_report.clone(),
        attributions: project.attributions.clone(),
        components: COMPONENTS,
    }
}
