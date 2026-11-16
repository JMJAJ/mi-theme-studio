//! Safe ZIP/MTZ reading and writing.
//!
//! Reading never touches the file system: entries are decoded into memory
//! with size limits (zip-bomb protection), unsafe paths are skipped and
//! reported, and nothing is silently dropped except directory markers, which
//! ZIP readers recreate implicitly.

use super::blob::{is_zip_magic, Blob, BlobRef, Compression};
use super::paths::{extension, sanitize_archive_path};
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::collections::HashSet;
use std::io::{Cursor, Read, Seek, Write};
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_entries: usize,
    pub max_entry_bytes: u64,
    pub max_total_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_entries: 100_000,
            max_entry_bytes: 512 * 1024 * 1024,
            max_total_bytes: 2 * 1024 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedEntry {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub source_name: String,
    pub archive_bytes: u64,
    pub files: usize,
    pub directories: usize,
    pub uncompressed_bytes: u64,
    pub nested_archives: Vec<String>,
    pub skipped: Vec<SkippedEntry>,
    pub warnings: Vec<String>,
}

#[derive(Debug)]
pub struct RawEntry {
    pub path: String,
    pub blob: BlobRef,
}

/// Running totals shared between an outer archive and its nested archives.
struct Budget {
    limits: Limits,
    entries: usize,
    bytes: u64,
}

fn map_compression(method: CompressionMethod) -> Compression {
    if method == CompressionMethod::Stored {
        Compression::Stored
    } else {
        Compression::Deflated
    }
}

fn read_entries(
    data: &[u8],
    label: &str,
    budget: &mut Budget,
    report: &mut ImportReport,
) -> AppResult<Vec<RawEntry>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(data))?;
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(archive.len());
    for index in 0..archive.len() {
        let mut file = archive.by_index(index)?;
        let raw_name = match file.name() {
            Ok(name) => name.into_owned(),
            Err(error) => {
                report.skipped.push(SkippedEntry {
                    path: format!("{label}#{index}"),
                    reason: format!("Unreadable entry name: {error}"),
                });
                continue;
            }
        };
        let shown = if label.is_empty() {
            raw_name.clone()
        } else {
            format!("{label}!/{raw_name}")
        };
        if file.is_dir() {
            report.directories += 1;
            continue;
        }
        let path = match sanitize_archive_path(&raw_name) {
            Ok(path) => path,
            Err(issue) => {
                report.skipped.push(SkippedEntry {
                    path: shown,
                    reason: format!("Unsafe path: {}", issue.describe()),
                });
                continue;
            }
        };
        if file.encrypted() {
            report.skipped.push(SkippedEntry {
                path: shown,
                reason: "Encrypted entries are not supported".into(),
            });
            continue;
        }
        if !seen.insert(path.clone()) {
            report.warnings.push(format!(
                "Duplicate entry `{shown}`: the first copy was kept."
            ));
            continue;
        }
        budget.entries += 1;
        if budget.entries > budget.limits.max_entries {
            return Err(AppError::new(
                "limit",
                format!(
                    "The package has more than {} entries and was not opened.",
                    budget.limits.max_entries
                ),
            ));
        }
        if file.size() > budget.limits.max_entry_bytes {
            return Err(AppError::new(
                "limit",
                format!(
                    "`{shown}` is larger than the {} MB per-file limit.",
                    budget.limits.max_entry_bytes / 1024 / 1024
                ),
            ));
        }
        let compression = map_compression(file.compression());
        let mut bytes = Vec::with_capacity(file.size().min(64 * 1024 * 1024) as usize);
        // Never trust the declared size: cap the actual read as well.
        (&mut file)
            .take(budget.limits.max_entry_bytes + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| {
                AppError::new(
                    "archive",
                    format!("`{shown}` could not be decompressed: {error}"),
                )
            })?;
        if bytes.len() as u64 > budget.limits.max_entry_bytes {
            return Err(AppError::new(
                "limit",
                format!("`{shown}` expands beyond the per-file limit."),
            ));
        }
        budget.bytes += bytes.len() as u64;
        if budget.bytes > budget.limits.max_total_bytes {
            return Err(AppError::new(
                "limit",
                format!(
                    "The package expands to more than {} MB and was not opened.",
                    budget.limits.max_total_bytes / 1024 / 1024
                ),
            ));
        }
        out.push(RawEntry {
            path,
            blob: Blob::new(bytes, compression),
        });
    }
    Ok(out)
}

/// Whether an entry in the outer package should be presented as an editable
/// component archive. MTZ components (`icons`, `lockscreen`,
/// `com.android.systemui`, ...) are ZIP files without a `.zip` extension.
pub fn is_component_candidate(path: &str, data: &[u8]) -> bool {
    if !is_zip_magic(data) {
        return false;
    }
    let ext = extension(path);
    if matches!(
        ext.as_str(),
        "apk" | "jar" | "mtz" | "aar" | "docx" | "xlsx"
    ) {
        return false;
    }
    !path.contains('/') || ext == "zip"
}

pub struct ReadPackage {
    /// Top-level entry paths in archive order.
    pub order: Vec<String>,
    pub outer: Vec<RawEntry>,
    /// Component archives: (outer path, original bytes, children)
    pub nested: Vec<(String, BlobRef, Vec<RawEntry>)>,
    pub report: ImportReport,
}

pub fn read_package(data: &[u8], source_name: &str, limits: Limits) -> AppResult<ReadPackage> {
    let mut report = ImportReport {
        source_name: source_name.to_string(),
        archive_bytes: data.len() as u64,
        ..Default::default()
    };
    if !is_zip_magic(data) {
        return Err(AppError::new(
            "archive",
            "This file is not a ZIP-based theme package (.mtz or .zip).",
        ));
    }
    let mut budget = Budget {
        limits,
        entries: 0,
        bytes: 0,
    };
    let entries = read_entries(data, "", &mut budget, &mut report)?;
    let mut outer = Vec::new();
    let mut nested = Vec::new();
    let order: Vec<String> = entries.iter().map(|e| e.path.clone()).collect();
    for entry in entries {
        if is_component_candidate(&entry.path, &entry.blob.data) {
            let mut nested_report = ImportReport::default();
            match read_entries(
                &entry.blob.data,
                &entry.path,
                &mut budget,
                &mut nested_report,
            ) {
                Ok(children) => {
                    report.directories += nested_report.directories;
                    report.skipped.extend(nested_report.skipped);
                    report.warnings.extend(nested_report.warnings);
                    report.nested_archives.push(entry.path.clone());
                    nested.push((entry.path, entry.blob, children));
                }
                Err(error) if error.code == "limit" => return Err(error),
                Err(error) => {
                    report.warnings.push(format!(
                        "`{}` looks like a component archive but could not be opened ({}); it is kept as a plain file.",
                        entry.path, error.message
                    ));
                    outer.push(entry);
                }
            }
        } else {
            outer.push(entry);
        }
    }
    report.files = outer.len() + nested.iter().map(|(_, _, c)| c.len()).sum::<usize>();
    report.uncompressed_bytes = budget.bytes;
    Ok(ReadPackage {
        order,
        outer,
        nested,
        report,
    })
}

/// One entry to write. `data` is borrowed so large packages are not copied.
pub struct WriteEntry<'a> {
    pub path: &'a str,
    pub data: &'a [u8],
    pub compression: Compression,
}

pub fn write_zip<W: Write + Seek>(
    writer: W,
    entries: &[WriteEntry<'_>],
    mut progress: impl FnMut(usize, usize),
) -> AppResult<W> {
    let mut zip = zip::ZipWriter::new(writer);
    let total = entries.len();
    for (index, entry) in entries.iter().enumerate() {
        let method = match entry.compression {
            Compression::Stored => CompressionMethod::Stored,
            Compression::Deflated => CompressionMethod::Deflated,
        };
        let options = SimpleFileOptions::default()
            .compression_method(method)
            .large_file(entry.data.len() as u64 >= u32::MAX as u64)
            .unix_permissions(0o644);
        zip.start_file(entry.path, options)?;
        zip.write_all(entry.data)?;
        progress(index + 1, total);
    }
    Ok(zip.finish()?)
}

pub fn zip_to_vec(entries: &[WriteEntry<'_>]) -> AppResult<Vec<u8>> {
    let cursor = write_zip(Cursor::new(Vec::new()), entries, |_, _| {})?;
    Ok(cursor.into_inner())
}

/// Lightweight verification of a written archive: every expected entry must
/// be present with the same uncompressed size and CRC-32.
pub fn verify_zip(data: &[u8], expected: &[WriteEntry<'_>]) -> AppResult<()> {
    let mut archive = zip::ZipArchive::new(Cursor::new(data))?;
    if archive.len() != expected.len() {
        return Err(AppError::new(
            "verify",
            format!(
                "Expected {} entries but the written archive has {}.",
                expected.len(),
                archive.len()
            ),
        ));
    }
    for entry in expected {
        let file = archive.by_name(entry.path).map_err(|_| {
            AppError::new(
                "verify",
                format!("`{}` is missing from the written archive.", entry.path),
            )
        })?;
        if file.size() != entry.data.len() as u64 || file.crc32() != crc32(entry.data) {
            return Err(AppError::new(
                "verify",
                format!("`{}` does not match after writing.", entry.path),
            ));
        }
    }
    Ok(())
}

pub fn crc32(data: &[u8]) -> u32 {
    let mut hasher = crc32_table::Hasher::new();
    hasher.update(data);
    hasher.finalize()
}

mod crc32_table {
    // Small table-driven CRC-32 (IEEE) so verification does not depend on a
    // specific compression backend crate.
    const fn table() -> [u32; 256] {
        let mut table = [0u32; 256];
        let mut i = 0;
        while i < 256 {
            let mut c = i as u32;
            let mut k = 0;
            while k < 8 {
                c = if c & 1 != 0 {
                    0xEDB8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
                k += 1;
            }
            table[i] = c;
            i += 1;
        }
        table
    }
    static TABLE: [u32; 256] = table();

    pub struct Hasher(u32);
    impl Hasher {
        pub fn new() -> Self {
            Hasher(0xFFFF_FFFF)
        }
        pub fn update(&mut self, data: &[u8]) {
            let mut c = self.0;
            for &b in data {
                c = TABLE[((c ^ b as u32) & 0xFF) as usize] ^ (c >> 8);
            }
            self.0 = c;
        }
        pub fn finalize(self) -> u32 {
            self.0 ^ 0xFFFF_FFFF
        }
    }
}

/// Read the central directory of a file on disk without decompressing it.
pub fn list_names(data: impl Read + Seek) -> AppResult<Vec<String>> {
    let archive = zip::ZipArchive::new(data)?;
    archive
        .file_names()
        .map(|name| name.map(|n| n.into_owned()).map_err(AppError::from))
        .collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn build_zip(entries: &[(&str, &[u8], Compression)]) -> Vec<u8> {
        let list: Vec<WriteEntry> = entries
            .iter()
            .map(|(path, data, compression)| WriteEntry {
                path,
                data,
                compression: *compression,
            })
            .collect();
        zip_to_vec(&list).unwrap()
    }

    /// Writes raw names (including unsafe ones) the way a hostile archive would.
    pub fn build_raw_zip(names: &[&str]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for name in names {
            if name.ends_with('/') {
                zip.add_directory(*name, SimpleFileOptions::default())
                    .unwrap();
            } else {
                zip.start_file(*name, SimpleFileOptions::default()).unwrap();
                zip.write_all(b"data").unwrap();
            }
        }
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn crc_matches_known_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn rejects_non_zip() {
        let error = read_package(b"not a zip", "x.mtz", Limits::default())
            .err()
            .unwrap();
        assert_eq!(error.code, "archive");
    }

    #[test]
    fn skips_unsafe_entries_and_directories() {
        let data = build_raw_zip(&[
            "description.xml",
            "../evil.txt",
            "/abs.txt",
            "wallpaper/",
            "wallpaper/a.jpg",
        ]);
        let package = read_package(&data, "t.mtz", Limits::default()).unwrap();
        let paths: Vec<_> = package.outer.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["description.xml", "wallpaper/a.jpg"]);
        assert_eq!(package.report.skipped.len(), 2);
        assert_eq!(package.report.directories, 1);
    }

    #[test]
    fn expands_component_archives_once() {
        let icons = build_zip(&[(
            "res/drawable-xxhdpi/com.android.camera.png",
            b"png",
            Compression::Deflated,
        )]);
        let boot = build_zip(&[("desc.txt", b"1080 2400 30", Compression::Stored)]);
        let outer = build_zip(&[
            ("description.xml", b"<MIUI-Theme/>", Compression::Deflated),
            ("icons", &icons, Compression::Stored),
            ("boots/bootanimation.zip", &boot, Compression::Stored),
            ("app.apk", &icons, Compression::Stored),
        ]);
        let package = read_package(&outer, "t.mtz", Limits::default()).unwrap();
        let nested: Vec<_> = package.nested.iter().map(|(p, _, _)| p.as_str()).collect();
        assert_eq!(nested, vec!["icons", "boots/bootanimation.zip"]);
        assert_eq!(package.nested[1].2[0].blob.compression, Compression::Stored);
        assert!(package.outer.iter().any(|e| e.path == "app.apk"));
        assert_eq!(package.report.files, 4);
    }

    #[test]
    fn enforces_limits() {
        let data = build_zip(&[("a.bin", &[0u8; 2048], Compression::Deflated)]);
        let limits = Limits {
            max_entry_bytes: 1024,
            ..Limits::default()
        };
        assert_eq!(
            read_package(&data, "t", limits).err().unwrap().code,
            "limit"
        );
        let limits = Limits {
            max_total_bytes: 1000,
            ..Limits::default()
        };
        assert_eq!(
            read_package(&data, "t", limits).err().unwrap().code,
            "limit"
        );
        let many = build_zip(&[
            ("a", b"1", Compression::Stored),
            ("b", b"2", Compression::Stored),
        ]);
        let limits = Limits {
            max_entries: 1,
            ..Limits::default()
        };
        assert_eq!(
            read_package(&many, "t", limits).err().unwrap().code,
            "limit"
        );
    }

    #[test]
    fn verify_detects_mismatch() {
        let entries = [WriteEntry {
            path: "a.txt",
            data: b"hello",
            compression: Compression::Deflated,
        }];
        let data = zip_to_vec(&entries).unwrap();
        verify_zip(&data, &entries).unwrap();
        let other = [WriteEntry {
            path: "a.txt",
            data: b"world",
            compression: Compression::Deflated,
        }];
        assert!(verify_zip(&data, &other).is_err());
    }
}
