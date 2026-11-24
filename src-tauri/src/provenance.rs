//! Where theme material came from, by content.
//!
//! Every file that enters a project from somewhere else (copied from a reference theme,
//! a store wallpaper or ringtone, a store or phone theme opened as a project) is recorded
//! here by its SHA-1, together with its source. Downloaded store items are also indexed
//! once, so material taken from them by any route is recognised. The proof of copyright
//! then discloses every file of the theme whose bytes match, whatever it is called now and
//! however often the project was saved and reopened. Replaced files no longer match.
//!
//! The index lives in `provenance.json` in the app's data folder.

use crate::package::blob::is_zip_magic;
use crate::package::metadata::DESCRIPTION_PATH;
use crate::state::lock;
use crate::store;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const INDEX_FILE: &str = "provenance.json";
/// Smaller files are too generic to say anything about their origin.
const MIN_TRACKED_BYTES: usize = 256;
const MAX_ENTRY_BYTES: u64 = 256 * 1024 * 1024;

static INDEX_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub title: String,
    #[serde(default)]
    pub author: String,
    /// Where it was taken from, e.g. `Theme store · 1a2b…` or the reference file name.
    #[serde(default)]
    pub origin: String,
}

#[derive(Default, Serialize, Deserialize)]
struct Index {
    #[serde(default)]
    sources: Vec<Source>,
    /// SHA-1 → index into `sources` (first source seen wins).
    #[serde(default)]
    files: HashMap<String, usize>,
    /// Store downloads already indexed.
    #[serde(default)]
    scanned: BTreeSet<String>,
}

impl Index {
    fn source_id(&mut self, source: Source) -> usize {
        if let Some(i) = self.sources.iter().position(|s| *s == source) {
            return i;
        }
        self.sources.push(source);
        self.sources.len() - 1
    }

    fn add(&mut self, source: Source, hashes: impl IntoIterator<Item = String>) -> bool {
        let mut hashes = hashes.into_iter().peekable();
        if hashes.peek().is_none() {
            return false;
        }
        let id = self.source_id(source);
        let mut changed = false;
        for hash in hashes {
            self.files.entry(hash).or_insert_with(|| {
                changed = true;
                id
            });
        }
        changed
    }
}

fn index_path(data_dir: &Path) -> PathBuf {
    data_dir.join(INDEX_FILE)
}

fn load(data_dir: &Path) -> Index {
    std::fs::read(index_path(data_dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save(data_dir: &Path, index: &Index) {
    if let Ok(bytes) = serde_json::to_vec(index) {
        let _ = std::fs::create_dir_all(data_dir);
        let _ = crate::storage::atomic_write(&index_path(data_dir), &bytes);
    }
}

pub fn sha1_hex(bytes: &[u8]) -> String {
    sha1_smol::Sha1::from(bytes).digest().to_string()
}

/// Whether a file says anything about where the theme's material came from.
pub fn tracked(path: &str, bytes: &[u8]) -> bool {
    bytes.len() >= MIN_TRACKED_BYTES && !path.eq_ignore_ascii_case(DESCRIPTION_PATH) && !path.ends_with('/')
}

/// Records that these files (path, bytes) came from `source`.
pub fn record<'a>(data_dir: &Path, source: Source, files: impl IntoIterator<Item = (&'a str, &'a [u8])>) {
    let hashes: Vec<String> = files.into_iter().filter(|(p, b)| tracked(p, b)).map(|(_, b)| sha1_hex(b)).collect();
    if hashes.is_empty() {
        return;
    }
    let _guard = lock(&INDEX_LOCK);
    let mut index = load(data_dir);
    if index.add(source, hashes) {
        save(data_dir, &index);
    }
}

/// Every file of a package, nested component archives included.
fn archive_files(data: &[u8], prefix: &str, depth: u8, out: &mut Vec<(String, Vec<u8>)>) {
    let Ok(mut zip) = zip::ZipArchive::new(Cursor::new(data)) else { return };
    for i in 0..zip.len() {
        let Ok(entry) = zip.by_index(i) else { continue };
        if entry.is_dir() || entry.size() > MAX_ENTRY_BYTES {
            continue;
        }
        let Ok(entry_name) = entry.name().map(|n| n.into_owned()) else { continue };
        let name = format!("{prefix}{entry_name}");
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        if entry.take(MAX_ENTRY_BYTES).read_to_end(&mut bytes).is_err() {
            continue;
        }
        if depth < 2 && is_zip_magic(&bytes) {
            archive_files(&bytes, &format!("{name}/"), depth + 1, out);
        } else {
            out.push((name, bytes));
        }
    }
}

/// Indexes store downloads that were not indexed yet.
pub fn scan_downloads(data_dir: &Path, downloads_dir: &Path) {
    let records = store::list_downloads(downloads_dir);
    let _guard = lock(&INDEX_LOCK);
    let mut index = load(data_dir);
    let mut changed = false;
    for record in records {
        if index.scanned.contains(&record.module_id) {
            continue;
        }
        let Ok(data) = std::fs::read(&record.path) else { continue };
        let mut files = Vec::new();
        if is_zip_magic(&data) {
            archive_files(&data, "", 0, &mut files);
        } else {
            files.push((record.path.clone(), data));
        }
        let source = Source {
            title: record.name.clone(),
            author: record.designer.clone().unwrap_or_default(),
            origin: format!("Theme store · {}", record.module_id),
        };
        index.add(source, files.iter().filter(|(p, b)| tracked(p, b)).map(|(_, b)| sha1_hex(b)));
        index.scanned.insert(record.module_id);
        changed = true;
    }
    if changed {
        save(data_dir, &index);
    }
}

/// Theme files that match recorded material from elsewhere, grouped by source.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Match {
    pub source: Source,
    pub paths: Vec<String>,
}

/// Looks up the theme's files. Sources by `own_names` (the designer's own names) are left
/// out: re-using your own published work needs no disclosure.
pub fn find<'a>(data_dir: &Path, files: impl IntoIterator<Item = (&'a str, &'a [u8])>, own_names: &[&str]) -> Vec<Match> {
    let index = {
        let _guard = lock(&INDEX_LOCK);
        load(data_dir)
    };
    if index.files.is_empty() {
        return Vec::new();
    }
    let own: Vec<String> = own_names.iter().map(|n| n.trim().to_lowercase()).filter(|n| !n.is_empty()).collect();
    let mut grouped: BTreeMap<usize, Vec<String>> = BTreeMap::new();
    for (path, bytes) in files {
        if !tracked(path, bytes) {
            continue;
        }
        if let Some(&id) = index.files.get(&sha1_hex(bytes)) {
            grouped.entry(id).or_default().push(path.to_string());
        }
    }
    let mut out: Vec<Match> = grouped
        .into_iter()
        .filter_map(|(id, mut paths)| {
            let source = index.sources.get(id)?.clone();
            if own.contains(&source.author.trim().to_lowercase()) {
                return None;
            }
            paths.sort();
            Some(Match { source, paths })
        })
        .collect();
    out.sort_by(|a, b| b.paths.len().cmp(&a.paths.len()).then_with(|| a.source.cmp(&b.source)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src(title: &str, author: &str) -> Source {
        Source { title: title.into(), author: author.into(), origin: format!("test · {title}") }
    }

    #[test]
    fn records_and_finds_by_content() {
        let dir = tempfile::tempdir().unwrap();
        let art = vec![7u8; 1000];
        let other = vec![9u8; 1000];
        record(dir.path(), src("Sky", "Ann"), [("wallpaper/default_wallpaper.jpg", art.as_slice())]);
        // Renamed and saved elsewhere: still the same bytes.
        let found = find(dir.path(), [("lockscreen/bg.jpg", art.as_slice()), ("icons/a.png", other.as_slice())], &["Jx"]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].source.title, "Sky");
        assert_eq!(found[0].paths, vec!["lockscreen/bg.jpg".to_string()]);
        // Your own work is not disclosed; tiny and description files are never tracked.
        assert!(find(dir.path(), [("x.jpg", art.as_slice())], &["ann"]).is_empty());
        assert!(!tracked("description.xml", &other));
        assert!(!tracked("a.xml", b"<x/>"));
    }

    #[test]
    fn first_source_wins() {
        let mut index = Index::default();
        assert!(index.add(src("A", ""), ["h".to_string()]));
        assert!(!index.add(src("B", ""), ["h".to_string()]));
        assert_eq!(index.sources[index.files["h"]].title, "A");
    }
}
