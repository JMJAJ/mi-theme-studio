//! The in-memory theme workspace.
//!
//! A [`Project`] is a flat map of package paths to immutable blobs. Files in
//! component archives are addressed as `outer!/inner`. Every mutation goes
//! through [`Project::transact`], which records an undoable [`Change`] and
//! rolls back on error.

pub mod classify;
pub mod history;
pub mod search;
#[cfg(test)]
mod samples;
pub mod snapshot;

use crate::error::{AppError, AppResult};
use crate::package::archive::{self, ImportReport, Limits, WriteEntry};
use crate::package::blob::{Blob, BlobRef, Compression};
use crate::package::convert;
use crate::package::metadata;
use crate::package::paths::{
    self, join_nested, split_nested, validate_name, validate_project_path, NESTED_SEP,
};
use history::{now_ms, Change, ContainerDelta, FileDelta, History};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::Arc;

/// A nested component archive such as `icons` or `lockscreen`.
#[derive(Debug)]
pub struct Container {
    /// Original archive bytes; written back unchanged when the children are
    /// untouched, so unknown archive details survive a round trip.
    pub original: Option<BlobRef>,
    pub original_children: Vec<(String, BlobRef)>,
    pub compression: Compression,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attribution {
    pub source_title: String,
    pub source_author: String,
    pub source_file: String,
    pub files: usize,
    pub at_ms: u64,
}

pub struct Project {
    pub name: String,
    pub source_path: Option<PathBuf>,
    pub files: BTreeMap<String, BlobRef>,
    pub containers: BTreeMap<String, Arc<Container>>,
    /// Top-level order from the original archive; keeps exports stable.
    pub outer_order: Vec<String>,
    /// State at open/last save, used for added/modified/removed status.
    pub baseline: HashMap<String, BlobRef>,
    pub history: History,
    pub import_report: Option<ImportReport>,
    pub attributions: Vec<Attribution>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConflictPolicy {
    Skip,
    Overwrite,
    Rename,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyPlanItem {
    pub source: String,
    pub destination: String,
    pub conflict: bool,
    pub size: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertResult {
    pub converted: Vec<String>,
    /// `(path, reason)` for files left unchanged.
    pub failed: Vec<(String, String)>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkResult {
    pub written: Vec<String>,
    pub skipped: Vec<String>,
    pub overwritten: Vec<String>,
}

/// Transaction over a project: records the first `before` of every touched
/// path, applies changes immediately, and can roll back.
pub struct Tx<'a> {
    project: &'a mut Project,
    files: Vec<FileDelta>,
    file_index: HashMap<String, usize>,
    containers: Vec<ContainerDelta>,
    container_index: HashMap<String, usize>,
}

impl<'a> Tx<'a> {
    pub fn project(&self) -> &Project {
        self.project
    }

    pub fn set(&mut self, path: &str, blob: Option<BlobRef>) {
        let before = self.project.files.get(path).cloned();
        match self.file_index.get(path) {
            Some(&index) => self.files[index].after = blob.clone(),
            None => {
                self.file_index.insert(path.to_string(), self.files.len());
                self.files.push(FileDelta {
                    path: path.to_string(),
                    before,
                    after: blob.clone(),
                });
            }
        }
        match blob {
            Some(blob) => {
                self.project.files.insert(path.to_string(), blob);
            }
            None => {
                self.project.files.remove(path);
            }
        }
    }

    pub fn set_container(&mut self, name: &str, container: Option<Arc<Container>>) {
        let before = self.project.containers.get(name).cloned();
        match self.container_index.get(name) {
            Some(&index) => self.containers[index].after = container.clone(),
            None => {
                self.container_index
                    .insert(name.to_string(), self.containers.len());
                self.containers.push(ContainerDelta {
                    name: name.to_string(),
                    before,
                    after: container.clone(),
                });
            }
        }
        match container {
            Some(container) => {
                self.project.containers.insert(name.to_string(), container);
            }
            None => {
                self.project.containers.remove(name);
            }
        }
    }

    fn rollback(self) {
        for delta in self.files.into_iter().rev() {
            match delta.before {
                Some(blob) => self.project.files.insert(delta.path, blob),
                None => self.project.files.remove(&delta.path),
            };
        }
        for delta in self.containers.into_iter().rev() {
            match delta.before {
                Some(c) => self.project.containers.insert(delta.name, c),
                None => self.project.containers.remove(&delta.name),
            };
        }
    }
}

fn path_error(path: &str, issue: paths::PathIssue) -> AppError {
    AppError::invalid(format!(
        "`{path}` is not a valid package path: {}",
        issue.describe()
    ))
}

impl Project {
    pub fn new_empty(title: &str) -> Project {
        let mut files = BTreeMap::new();
        files.insert(
            metadata::DESCRIPTION_PATH.to_string(),
            Blob::new(
                metadata::default_description_xml(title).into_bytes(),
                Compression::Deflated,
            ),
        );
        let safe_title: String = title
            .chars()
            .filter(|c| !"\\/:*?\"<>|".contains(*c))
            .collect();
        let name = if safe_title.trim().is_empty() {
            "Untitled.mtz".to_string()
        } else {
            format!("{}.mtz", safe_title.trim())
        };
        Project {
            name,
            source_path: None,
            outer_order: vec![metadata::DESCRIPTION_PATH.to_string()],
            files,
            containers: BTreeMap::new(),
            baseline: HashMap::new(),
            history: History::new(false),
            import_report: None,
            attributions: Vec::new(),
        }
    }

    pub fn from_bytes(
        data: &[u8],
        name: &str,
        source_path: Option<PathBuf>,
        limits: Limits,
    ) -> AppResult<Project> {
        let package = archive::read_package(data, name, limits)?;
        let mut files = BTreeMap::new();
        let mut containers = BTreeMap::new();
        let outer_order = package.order;
        for entry in package.outer {
            files.insert(entry.path, entry.blob);
        }
        for (outer, blob, children) in package.nested {
            let mut original_children = Vec::with_capacity(children.len());
            for child in children {
                files.insert(join_nested(&outer, &child.path), child.blob.clone());
                original_children.push((child.path, child.blob));
            }
            let compression = blob.compression;
            containers.insert(
                outer,
                Arc::new(Container {
                    original: Some(blob),
                    original_children,
                    compression,
                }),
            );
        }
        let baseline = files.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        if files.is_empty() && containers.is_empty() {
            return Err(AppError::invalid("The archive does not contain any files."));
        }
        Ok(Project {
            name: name.to_string(),
            source_path,
            files,
            containers,
            outer_order,
            baseline,
            history: History::new(true),
            import_report: Some(package.report),
            attributions: Vec::new(),
        })
    }

    pub fn is_dirty(&self) -> bool {
        self.history.is_dirty()
    }

    pub fn title(&self) -> String {
        let xml = self.text(metadata::DESCRIPTION_PATH);
        if let Some(localized) = xml.as_deref().and_then(|x| metadata::localized_value(x, "titles", "title", &["en_US", "en"])) {
            return localized;
        }
        let view = metadata::parse(xml.as_deref());
        view.fields
            .iter()
            .find(|f| f.name == "title" && f.attributes.is_empty())
            .map(|f| f.value.clone())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| {
                self.name
                    .trim_end_matches(".mtz")
                    .trim_end_matches(".zip")
                    .to_string()
            })
    }

    pub fn text(&self, path: &str) -> Option<String> {
        self.files.get(path).map(|b| decode_text(&b.data).0)
    }

    pub fn is_container(&self, path: &str) -> bool {
        self.containers.contains_key(path)
    }

    /// Files whose path is under `folder` (`a/b` → `a/b/...`; `icons!/` or a
    /// container name → all children).
    pub fn files_under(&self, folder: &str) -> Vec<String> {
        let prefix = if self.containers.contains_key(folder) {
            format!("{folder}{NESTED_SEP}")
        } else if folder.ends_with(NESTED_SEP) || folder.ends_with('/') {
            folder.to_string()
        } else {
            format!("{folder}/")
        };
        self.files
            .range(prefix.clone()..)
            .take_while(|(k, _)| k.starts_with(&prefix))
            .map(|(k, _)| k.clone())
            .collect()
    }

    pub fn path_exists(&self, path: &str) -> bool {
        self.files.contains_key(path)
            || self.containers.contains_key(path)
            || !self.files_under(path).is_empty()
    }

    /// Run `f` as one undoable change. Empty changes are not recorded.
    pub fn transact<T>(
        &mut self,
        label: &str,
        f: impl FnOnce(&mut Tx) -> AppResult<T>,
    ) -> AppResult<T> {
        let mut tx = Tx {
            project: self,
            files: Vec::new(),
            file_index: HashMap::new(),
            containers: Vec::new(),
            container_index: HashMap::new(),
        };
        match f(&mut tx) {
            Ok(value) => {
                let Tx {
                    project,
                    files,
                    containers,
                    ..
                } = tx;
                let id = project.history.next_id();
                let change = Change {
                    id,
                    label: label.to_string(),
                    at_ms: now_ms(),
                    files,
                    containers,
                };
                if !change.is_empty() {
                    project.history.push(change);
                }
                Ok(value)
            }
            Err(error) => {
                tx.rollback();
                Err(error)
            }
        }
    }

    fn apply_side(&mut self, change: &Change, forward: bool) {
        for delta in &change.containers {
            let target = if forward { &delta.after } else { &delta.before };
            match target {
                Some(c) => self.containers.insert(delta.name.clone(), c.clone()),
                None => self.containers.remove(&delta.name),
            };
        }
        for delta in &change.files {
            let target = if forward { &delta.after } else { &delta.before };
            match target {
                Some(b) => self.files.insert(delta.path.clone(), b.clone()),
                None => self.files.remove(&delta.path),
            };
        }
    }

    pub fn undo(&mut self) -> AppResult<String> {
        let change = self
            .history
            .undo
            .pop()
            .ok_or_else(|| AppError::invalid("Nothing to undo."))?;
        self.apply_side(&change, false);
        let label = change.label.clone();
        self.history.redo.push(change);
        Ok(label)
    }

    pub fn redo(&mut self) -> AppResult<String> {
        let change = self
            .history
            .redo
            .pop()
            .ok_or_else(|| AppError::invalid("Nothing to redo."))?;
        self.apply_side(&change, true);
        let label = change.label.clone();
        self.history.undo.push(change);
        Ok(label)
    }

    /// Move through history until `id` is the most recent applied change
    /// (`None` = before the first change).
    pub fn goto(&mut self, id: Option<u64>) -> AppResult<()> {
        let in_undo = id.is_none() || self.history.undo.iter().any(|c| Some(c.id) == id);
        let in_redo = self.history.redo.iter().any(|c| Some(c.id) == id);
        if !in_undo && !in_redo {
            return Err(AppError::not_found(
                "That history step is no longer available.",
            ));
        }
        if in_undo {
            while self.history.top() != id {
                self.undo()?;
            }
        } else {
            while self.history.top() != id {
                self.redo()?;
            }
        }
        Ok(())
    }

    // ----- validation helpers -------------------------------------------

    fn check_new_path(&self, path: &str, ignore: &BTreeSet<String>) -> AppResult<()> {
        validate_project_path(path).map_err(|issue| path_error(path, issue))?;
        let (outer, inner) = split_nested(path);
        if inner.is_some() && !self.containers.contains_key(outer) {
            return Err(AppError::not_found(format!(
                "The component archive `{outer}` does not exist."
            )));
        }
        if inner.is_none() && self.containers.contains_key(path) && !ignore.contains(path) {
            return Err(AppError::conflict(format!(
                "`{path}` is a component archive."
            )));
        }
        // A file cannot share its path with a folder, and none of its parent
        // folders may be a file.
        let under = self.files_under(path);
        if under.iter().any(|p| !ignore.contains(p)) && !self.containers.contains_key(path) {
            return Err(AppError::conflict(format!("`{path}` is a folder.")));
        }
        let mut current = paths::parent(path);
        while !current.is_empty() && !current.ends_with(NESTED_SEP) {
            if self.files.contains_key(&current) && !ignore.contains(&current) {
                return Err(AppError::conflict(format!(
                    "`{current}` is a file, not a folder."
                )));
            }
            current = paths::parent(&current);
        }
        if inner.is_none() {
            let top = outer.split('/').next().unwrap_or(outer);
            if top != outer && self.containers.contains_key(top) {
                return Err(AppError::conflict(format!(
                    "`{top}` is a component archive; open it to add files inside."
                )));
            }
        }
        Ok(())
    }

    fn default_compression(&self, path: &str) -> Compression {
        let (outer, inner) = split_nested(path);
        if inner.is_some() && outer.to_ascii_lowercase().contains("bootanimation") {
            return Compression::Stored;
        }
        Compression::Deflated
    }

    // ----- operations -----------------------------------------------------

    pub fn put_file(&mut self, path: &str, data: Vec<u8>, label: &str) -> AppResult<()> {
        let existing = self.files.get(path).cloned();
        if existing.is_none() {
            self.check_new_path(path, &BTreeSet::new())?;
        }
        let compression = existing
            .as_ref()
            .map(|b| b.compression)
            .unwrap_or_else(|| self.default_compression(path));
        if existing.as_ref().is_some_and(|b| b.data == data) {
            return Ok(());
        }
        let blob = Blob::new(data, compression);
        self.transact(label, |tx| {
            tx.set(path, Some(blob));
            Ok(())
        })
    }

    pub fn add_files(
        &mut self,
        items: Vec<(String, Vec<u8>)>,
        policy: ConflictPolicy,
        label: &str,
    ) -> AppResult<BulkResult> {
        let mut result = BulkResult::default();
        let mut planned: Vec<(String, BlobRef)> = Vec::new();
        let mut taken: BTreeSet<String> = BTreeSet::new();
        for (path, data) in items {
            let mut target = path.clone();
            let exists = self.files.contains_key(&target) || taken.contains(&target);
            if exists {
                match policy {
                    ConflictPolicy::Skip => {
                        result.skipped.push(target);
                        continue;
                    }
                    ConflictPolicy::Overwrite => result.overwritten.push(target.clone()),
                    ConflictPolicy::Rename => {
                        target = paths::copy_name(&target, |p| {
                            self.files.contains_key(p) || taken.contains(p)
                        });
                    }
                }
            }
            if !self.files.contains_key(&target) {
                self.check_new_path(&target, &BTreeSet::new())?;
            }
            let compression = self
                .files
                .get(&target)
                .map(|b| b.compression)
                .unwrap_or_else(|| self.default_compression(&target));
            taken.insert(target.clone());
            planned.push((target, Blob::new(data, compression)));
        }
        self.transact(label, |tx| {
            for (path, blob) in planned {
                tx.set(&path, Some(blob));
                result.written.push(path);
            }
            Ok(())
        })?;
        Ok(result)
    }

    /// Re-encode images so their content matches their extension, in one undo step.
    /// Files that cannot be converted are reported with the reason and left as they are.
    pub fn convert_images(&mut self, paths: &[String]) -> AppResult<ConvertResult> {
        let jobs: Vec<(String, BlobRef)> = paths
            .iter()
            .filter_map(|p| self.files.get(p).map(|b| (p.clone(), b.clone())))
            .collect();
        let mut result = ConvertResult::default();
        for p in paths.iter().filter(|p| !self.files.contains_key(*p)) {
            result.failed.push((p.clone(), "Not in the package.".into()));
        }
        let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(jobs.len().max(1));
        let chunk = jobs.len().div_ceil(threads).max(1);
        let outcomes: Vec<(String, BlobRef, AppResult<Vec<u8>>)> = std::thread::scope(|scope| {
            let handles: Vec<_> = jobs
                .chunks(chunk)
                .map(|part| {
                    scope.spawn(move || {
                        part.iter()
                            .map(|(p, b)| (p.clone(), b.clone(), convert::convert_for_path(p, &b.data)))
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
        });
        let mut planned = Vec::new();
        for (path, old, outcome) in outcomes {
            match outcome {
                Ok(data) => planned.push((path, Blob::new(data, old.compression))),
                Err(e) => result.failed.push((path, e.message)),
            }
        }
        if planned.is_empty() {
            return Ok(result);
        }
        let label = match planned.as_slice() {
            [(path, _)] => format!("Convert {}", paths::file_name(path)),
            many => format!("Convert {} images", many.len()),
        };
        self.transact(&label, |tx| {
            for (path, blob) in planned {
                tx.set(&path, Some(blob));
                result.converted.push(path);
            }
            Ok(())
        })?;
        Ok(result)
    }

    /// Expand a selection (files, folders, component archives) into files.
    fn expand(&self, path: &str) -> Vec<String> {
        if self.files.contains_key(path) {
            vec![path.to_string()]
        } else {
            self.files_under(path)
        }
    }

    pub fn delete(&mut self, selection: &[String]) -> AppResult<usize> {
        let mut targets = BTreeSet::new();
        let mut containers = BTreeSet::new();
        for path in selection {
            let expanded = self.expand(path);
            if self.containers.contains_key(path) {
                containers.insert(path.clone());
            } else if expanded.is_empty() {
                return Err(AppError::not_found(format!(
                    "`{path}` is not in the package."
                )));
            }
            targets.extend(expanded);
        }
        let count = targets.len() + containers.len();
        let label = if count == 1 {
            format!(
                "Delete {}",
                paths::file_name(selection.first().map(String::as_str).unwrap_or_default())
            )
        } else {
            format!("Delete {count} items")
        };
        self.transact(&label, |tx| {
            for path in &targets {
                tx.set(path, None);
            }
            for name in &containers {
                tx.set_container(name, None);
            }
            Ok(())
        })?;
        Ok(count)
    }

    /// Move a file, folder or component archive to `destination` (a full
    /// path, not a folder).
    pub fn move_item(&mut self, source: &str, destination: &str, label: &str) -> AppResult<()> {
        self.move_many(&[(source.to_string(), destination.to_string())], label)
    }

    fn move_many(&mut self, pairs: &[(String, String)], label: &str) -> AppResult<()> {
        let mut moves: Vec<(String, String)> = Vec::new();
        let mut container_moves: Vec<(String, String)> = Vec::new();
        for (source, destination) in pairs {
            if source == destination {
                continue;
            }
            validate_project_path(destination).map_err(|issue| path_error(destination, issue))?;
            if destination.starts_with(&format!("{source}/"))
                || destination.starts_with(&format!("{source}{NESTED_SEP}"))
            {
                return Err(AppError::invalid(format!(
                    "`{source}` cannot be moved into itself."
                )));
            }
            if self.containers.contains_key(source) {
                if destination.contains(NESTED_SEP) || destination.contains('/') {
                    return Err(AppError::invalid(
                        "Component archives must stay at the package root.",
                    ));
                }
                container_moves.push((source.clone(), destination.clone()));
                for file in self.files_under(source) {
                    let inner = split_nested(&file).1.unwrap_or_default();
                    moves.push((file.clone(), join_nested(destination, inner)));
                }
            } else if self.files.contains_key(source) {
                moves.push((source.clone(), destination.clone()));
            } else {
                let under = self.files_under(source);
                if under.is_empty() {
                    return Err(AppError::not_found(format!(
                        "`{source}` is not in the package."
                    )));
                }
                for file in under {
                    let rest = &file[source.len()..];
                    moves.push((file.clone(), format!("{destination}{rest}")));
                }
            }
        }
        if moves.is_empty() && container_moves.is_empty() {
            return Ok(());
        }
        let sources: BTreeSet<String> = moves
            .iter()
            .map(|(s, _)| s.clone())
            .chain(container_moves.iter().map(|(s, _)| s.clone()))
            .collect();
        let mut destinations = BTreeSet::new();
        for (_, destination) in container_moves.iter() {
            if self.path_exists(destination) && !sources.contains(destination) {
                return Err(AppError::conflict(format!(
                    "`{destination}` already exists."
                )));
            }
        }
        for (_, destination) in &moves {
            if !destinations.insert(destination.clone()) {
                return Err(AppError::conflict(format!(
                    "More than one item would be moved to `{destination}`."
                )));
            }
            if self.files.contains_key(destination) && !sources.contains(destination) {
                return Err(AppError::conflict(format!(
                    "`{destination}` already exists."
                )));
            }
        }
        let renamed_containers: BTreeSet<String> =
            container_moves.iter().map(|(_, d)| d.clone()).collect();
        for (_, destination) in &moves {
            let (outer, inner) = split_nested(destination);
            if inner.is_some()
                && !self.containers.contains_key(outer)
                && !renamed_containers.contains(outer)
            {
                return Err(AppError::not_found(format!(
                    "The component archive `{outer}` does not exist."
                )));
            }
            if inner.is_none() {
                self.check_new_path(destination, &sources)?;
            }
        }
        self.transact(label, |tx| {
            for (source, destination) in &container_moves {
                let container = tx.project().containers.get(source).cloned();
                tx.set_container(source, None);
                tx.set_container(destination, container);
            }
            let blobs: Vec<(String, Option<BlobRef>)> = moves
                .iter()
                .map(|(s, d)| (d.clone(), tx.project().files.get(s).cloned()))
                .collect();
            for (source, _) in &moves {
                tx.set(source, None);
            }
            for (destination, blob) in blobs {
                tx.set(&destination, blob);
            }
            Ok(())
        })
    }

    pub fn rename(&mut self, path: &str, new_name: &str) -> AppResult<String> {
        validate_name(new_name).map_err(|issue| path_error(new_name, issue))?;
        let parent = if self.containers.contains_key(path) {
            String::new()
        } else {
            paths::parent(path)
        };
        let destination = paths::join(&parent, new_name);
        let label = format!("Rename {} to {new_name}", paths::file_name(path));
        self.move_item(path, &destination, &label)?;
        Ok(destination)
    }

    pub fn move_to_folder(&mut self, selection: &[String], folder: &str) -> AppResult<Vec<String>> {
        let folder = folder.trim_end_matches('/');
        let pairs: Vec<(String, String)> = selection
            .iter()
            .map(|source| {
                let name = if self.containers.contains_key(source) {
                    source.as_str()
                } else {
                    paths::file_name(source)
                };
                (source.clone(), paths::join(folder, name))
            })
            .collect();
        let label = if pairs.len() == 1 {
            format!("Move {}", paths::file_name(&pairs[0].0))
        } else {
            format!("Move {} items", pairs.len())
        };
        self.move_many(&pairs, &label)?;
        Ok(pairs.into_iter().map(|(_, d)| d).collect())
    }

    pub fn duplicate(&mut self, selection: &[String]) -> AppResult<Vec<String>> {
        let mut planned: Vec<(String, BlobRef)> = Vec::new();
        for path in selection {
            let blob = self.files.get(path).cloned().ok_or_else(|| {
                AppError::invalid(format!(
                    "Only files can be duplicated; `{path}` is not a file."
                ))
            })?;
            let taken: BTreeSet<&str> = planned.iter().map(|(p, _)| p.as_str()).collect();
            let target = paths::copy_name(path, |p| self.path_exists(p) || taken.contains(p));
            planned.push((target, blob));
        }
        let label = if planned.len() == 1 {
            format!("Duplicate {}", paths::file_name(&selection[0]))
        } else {
            format!("Duplicate {} files", planned.len())
        };
        let created: Vec<String> = planned.iter().map(|(p, _)| p.clone()).collect();
        self.transact(&label, |tx| {
            for (path, blob) in planned {
                tx.set(&path, Some(blob));
            }
            Ok(())
        })?;
        Ok(created)
    }

    pub fn create_container(&mut self, name: &str) -> AppResult<()> {
        validate_name(name).map_err(|issue| path_error(name, issue))?;
        if self.path_exists(name) {
            return Err(AppError::conflict(format!("`{name}` already exists.")));
        }
        let container = Arc::new(Container {
            original: None,
            original_children: Vec::new(),
            compression: Compression::Stored,
        });
        self.transact(&format!("Create component {name}"), |tx| {
            tx.set_container(name, Some(container));
            Ok(())
        })
    }

    /// Convert the root-level folder `folder/…` into the component archive
    /// `folder`, which is how MIUI packages store components.
    pub fn pack_folder(&mut self, folder: &str) -> AppResult<usize> {
        if folder.contains('/') || folder.contains(NESTED_SEP) {
            return Err(AppError::invalid(
                "Only root-level folders can be packed into a component archive.",
            ));
        }
        if self.containers.contains_key(folder) || self.files.contains_key(folder) {
            return Err(AppError::conflict(format!(
                "`{folder}` already exists as a file or component."
            )));
        }
        let files = self.files_under(folder);
        if files.is_empty() {
            return Err(AppError::not_found(format!(
                "`{folder}` has no files to pack."
            )));
        }
        let container = Arc::new(Container {
            original: None,
            original_children: Vec::new(),
            compression: Compression::Stored,
        });
        let count = files.len();
        self.transact(&format!("Pack {folder} as component"), |tx| {
            tx.set_container(folder, Some(container));
            for file in &files {
                let blob = tx.project().files.get(file).cloned();
                let inner = &file[folder.len() + 1..];
                tx.set(file, None);
                tx.set(&join_nested(folder, inner), blob);
            }
            Ok(())
        })?;
        Ok(count)
    }

    // ----- reference copy ------------------------------------------------

    pub fn plan_copy(
        &self,
        source: &Project,
        selection: &[String],
        destination_folder: Option<&str>,
    ) -> AppResult<Vec<CopyPlanItem>> {
        let mut items = Vec::new();
        for selected in selection {
            let files = source.expand(selected);
            if files.is_empty() {
                return Err(AppError::not_found(format!(
                    "`{selected}` is not in the reference package."
                )));
            }
            for file in files {
                let destination = match destination_folder {
                    None => file.clone(),
                    Some(folder) => {
                        // Keep the path relative to the selected item's parent.
                        let base = if source.containers.contains_key(selected) {
                            String::new()
                        } else {
                            paths::parent(selected)
                        };
                        let relative = if base.is_empty() {
                            file.as_str()
                        } else {
                            &file[base.len()..].trim_start_matches(['/', '!'])
                        };
                        let relative = relative.replace(NESTED_SEP, "/");
                        paths::join(folder.trim_end_matches('/'), &relative)
                    }
                };
                let size = source.files.get(&file).map(|b| b.data.len()).unwrap_or(0);
                let conflict = self.files.contains_key(&destination);
                items.push(CopyPlanItem {
                    source: file,
                    destination,
                    conflict,
                    size,
                });
            }
        }
        Ok(items)
    }

    pub fn copy_from(
        &mut self,
        source: &Project,
        selection: &[String],
        destination_folder: Option<&str>,
        policy: ConflictPolicy,
    ) -> AppResult<BulkResult> {
        let plan = self.plan_copy(source, selection, destination_folder)?;
        let mut result = BulkResult::default();
        let mut needed_containers = BTreeSet::new();
        let mut writes: Vec<(String, BlobRef)> = Vec::new();
        let mut taken = BTreeSet::new();
        for item in plan {
            let mut destination = item.destination.clone();
            if self.files.contains_key(&destination) || taken.contains(&destination) {
                match policy {
                    ConflictPolicy::Skip => {
                        result.skipped.push(destination);
                        continue;
                    }
                    ConflictPolicy::Overwrite => result.overwritten.push(destination.clone()),
                    ConflictPolicy::Rename => {
                        destination = paths::copy_name(&destination, |p| {
                            self.files.contains_key(p) || taken.contains(p)
                        })
                    }
                }
            }
            let (outer, inner) = split_nested(&destination);
            if inner.is_some() && !self.containers.contains_key(outer) {
                if self.files.contains_key(outer) || !self.files_under(outer).is_empty() {
                    return Err(AppError::conflict(format!(
                        "`{outer}` exists but is not a component archive."
                    )));
                }
                needed_containers.insert(outer.to_string());
            }
            validate_project_path(&destination).map_err(|issue| path_error(&destination, issue))?;
            taken.insert(destination.clone());
            writes.push((destination, source.files[&item.source].clone()));
        }
        let label = format!("Copy {} files from {}", writes.len(), source.title());
        let source_title = source.title();
        self.transact(&label, |tx| {
            for name in &needed_containers {
                let compression = source
                    .containers
                    .get(name)
                    .map(|c| c.compression)
                    .unwrap_or(Compression::Stored);
                tx.set_container(
                    name,
                    Some(Arc::new(Container {
                        original: None,
                        original_children: Vec::new(),
                        compression,
                    })),
                );
            }
            for (path, blob) in writes {
                tx.set(&path, Some(blob));
                result.written.push(path);
            }
            Ok(())
        })?;
        if !result.written.is_empty() {
            let author = metadata::parse(source.text(metadata::DESCRIPTION_PATH).as_deref())
                .fields
                .iter()
                .find(|f| f.name == "author" && f.attributes.is_empty())
                .map(|f| f.value.clone())
                .unwrap_or_default();
            self.attributions.push(Attribution {
                source_title,
                source_author: author,
                source_file: source.name.clone(),
                files: result.written.len(),
                at_ms: now_ms(),
            });
        }
        Ok(result)
    }

    /// Put an external file at `stem.<ext>` (e.g. `wallpaper/default_wallpaper`),
    /// removing other files with the same stem but a different extension, as
    /// one undoable change, and record where it came from.
    pub fn place_file(
        &mut self,
        stem: &str,
        ext: &str,
        data: Vec<u8>,
        label: &str,
        attribution: Option<(String, String, String)>,
    ) -> AppResult<String> {
        let path = format!("{stem}.{}", ext.to_ascii_lowercase());
        let stem_name = paths::file_name(stem).to_ascii_lowercase();
        let folder = paths::parent(stem);
        let siblings: Vec<String> = self
            .files
            .keys()
            .filter(|k| *k != &path && paths::parent(k) == folder)
            .filter(|k| {
                let name = paths::file_name(k).to_ascii_lowercase();
                name.rsplit_once('.').is_some_and(|(s, _)| s == stem_name)
            })
            .cloned()
            .collect();
        let existing = self.files.get(&path).cloned();
        if existing.is_none() {
            let ignore: BTreeSet<String> = siblings.iter().cloned().collect();
            self.check_new_path(&path, &ignore)?;
        }
        let compression = existing.as_ref().map(|b| b.compression).unwrap_or_else(|| self.default_compression(&path));
        let blob = Blob::new(data, compression);
        self.transact(label, |tx| {
            for sibling in &siblings {
                tx.set(sibling, None);
            }
            tx.set(&path, Some(blob));
            Ok(())
        })?;
        if let Some((source_title, source_author, source_file)) = attribution {
            self.attributions.push(Attribution { source_title, source_author, source_file, files: 1, at_ms: now_ms() });
        }
        Ok(path)
    }

    // ----- export ----------------------------------------------------------

    /// Build the bytes of every top-level entry. Component archives whose
    /// children are unchanged are written byte-for-byte from the original.
    pub fn export_entries(&self) -> AppResult<Vec<ExportEntry>> {
        let mut outer_keys: Vec<String> = Vec::new();
        let mut seen = BTreeSet::new();
        let mut top_level: BTreeSet<String> = self
            .files
            .keys()
            .filter(|k| !k.contains(NESTED_SEP))
            .cloned()
            .collect();
        top_level.extend(self.containers.keys().cloned());
        for key in &self.outer_order {
            if top_level.contains(key) && seen.insert(key.clone()) {
                outer_keys.push(key.clone());
            }
        }
        for key in &top_level {
            if seen.insert(key.clone()) {
                outer_keys.push(key.clone());
            }
        }
        let mut out = Vec::with_capacity(outer_keys.len());
        for key in outer_keys {
            if let Some(container) = self.containers.get(&key) {
                let prefix = format!("{key}{NESTED_SEP}");
                let children: Vec<(String, BlobRef)> = self
                    .files
                    .range(prefix.clone()..)
                    .take_while(|(k, _)| k.starts_with(&prefix))
                    .map(|(k, v)| (k[prefix.len()..].to_string(), v.clone()))
                    .collect();
                let unchanged = container.original.is_some()
                    && children.len() == container.original_children.len()
                    && container.original_children.iter().all(|(name, blob)| {
                        children
                            .binary_search_by(|(n, _)| n.as_str().cmp(name))
                            .is_ok_and(|i| Arc::ptr_eq(&children[i].1, blob))
                    });
                if unchanged {
                    out.push(ExportEntry {
                        path: key,
                        data: ExportData::Blob(container.original.clone().unwrap()),
                        compression: container.compression,
                    });
                } else {
                    // Original child order first, then new children sorted.
                    let order: HashMap<&str, usize> = container
                        .original_children
                        .iter()
                        .enumerate()
                        .map(|(i, (n, _))| (n.as_str(), i))
                        .collect();
                    let mut sorted = children;
                    sorted.sort_by(|(a, _), (b, _)| {
                        let ia = order.get(a.as_str()).copied().unwrap_or(usize::MAX);
                        let ib = order.get(b.as_str()).copied().unwrap_or(usize::MAX);
                        ia.cmp(&ib).then_with(|| a.cmp(b))
                    });
                    let write: Vec<WriteEntry> = sorted
                        .iter()
                        .map(|(path, blob)| WriteEntry {
                            path,
                            data: &blob.data,
                            compression: blob.compression,
                        })
                        .collect();
                    let bytes = archive::zip_to_vec(&write)?;
                    out.push(ExportEntry {
                        path: key,
                        data: ExportData::Owned(bytes),
                        compression: container.compression,
                    });
                }
            } else if let Some(blob) = self.files.get(&key) {
                out.push(ExportEntry {
                    path: key,
                    data: ExportData::Blob(blob.clone()),
                    compression: blob.compression,
                });
            }
        }
        Ok(out)
    }

    /// Called after a successful save to `path`.
    pub fn mark_saved(&mut self, top: Option<u64>, path: Option<PathBuf>) {
        self.history.mark_saved_at(top);
        if let Some(path) = path {
            if let Some(name) = path.file_name() {
                self.name = name.to_string_lossy().into_owned();
            }
            self.source_path = Some(path);
        }
        if self.history.top() == top {
            self.baseline = self
                .files
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
        }
    }
}

pub enum ExportData {
    Blob(BlobRef),
    Owned(Vec<u8>),
}

pub struct ExportEntry {
    pub path: String,
    pub data: ExportData,
    pub compression: Compression,
}

impl ExportEntry {
    pub fn bytes(&self) -> &[u8] {
        match &self.data {
            ExportData::Blob(blob) => &blob.data,
            ExportData::Owned(bytes) => bytes,
        }
    }
}

/// Decode bytes as UTF-8 text. Returns (text, lossy, had_bom).
pub fn decode_text(bytes: &[u8]) -> (String, bool, bool) {
    let (body, bom) = match bytes.strip_prefix(b"\xEF\xBB\xBF".as_slice()) {
        Some(rest) => (rest, true),
        None => (bytes, false),
    };
    match std::str::from_utf8(body) {
        Ok(text) => (text.to_string(), false, bom),
        Err(_) => (String::from_utf8_lossy(body).into_owned(), true, bom),
    }
}

#[cfg(test)]
mod tests;
