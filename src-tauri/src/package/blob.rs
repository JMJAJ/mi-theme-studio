//! Immutable file contents shared between the project, its history and
//! exports. A [`Blob`] is never mutated; edits create a new blob, which makes
//! undo/redo and "unchanged since import" checks pointer comparisons.

use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

static NEXT_REV: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Compression {
    Stored,
    Deflated,
}

/// Content facts derived from the bytes (not the name).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    /// Detected container/image format, e.g. `PNG`, `JPEG`, `ZIP`.
    pub format: Option<&'static str>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub is_zip: bool,
    /// Android compiled (binary) XML.
    pub is_binary_xml: bool,
    pub looks_like_text: bool,
}

#[derive(Debug)]
pub struct Blob {
    pub data: Vec<u8>,
    pub compression: Compression,
    /// Unique, monotonically increasing revision; used for preview cache
    /// busting in the UI.
    pub rev: u64,
    probe: OnceLock<Probe>,
}

pub type BlobRef = Arc<Blob>;

impl Blob {
    pub fn new(data: Vec<u8>, compression: Compression) -> BlobRef {
        Arc::new(Blob {
            data,
            compression,
            rev: NEXT_REV.fetch_add(1, Ordering::Relaxed),
            probe: OnceLock::new(),
        })
    }

    pub fn probe(&self) -> &Probe {
        self.probe.get_or_init(|| probe_bytes(&self.data))
    }
}

pub fn is_zip_magic(data: &[u8]) -> bool {
    data.starts_with(b"PK\x03\x04") || data.starts_with(b"PK\x05\x06")
}

pub fn probe_bytes(data: &[u8]) -> Probe {
    let mut probe = Probe::default();
    let format: Option<&'static str> = if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("PNG")
    } else if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("JPEG")
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        Some("GIF")
    } else if data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        Some("WEBP")
    } else if data.starts_with(b"BM") && data.len() > 26 {
        Some("BMP")
    } else if data.len() >= 12
        && &data[4..8] == b"ftyp"
        && (&data[8..12] == b"avif" || &data[8..12] == b"avis")
    {
        Some("AVIF")
    } else if is_zip_magic(data) {
        probe.is_zip = true;
        Some("ZIP")
    } else if data.starts_with(b"OggS") {
        Some("OGG")
    } else if data.starts_with(b"ID3")
        || (data.len() > 2 && data[0] == 0xFF && (data[1] & 0xE0) == 0xE0)
    {
        Some("MP3")
    } else if data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WAVE" {
        Some("WAV")
    } else if data.len() >= 8 && &data[4..8] == b"ftyp" {
        Some("MP4")
    } else if data.starts_with(&[0x00, 0x01, 0x00, 0x00])
        || data.starts_with(b"OTTO")
        || data.starts_with(b"true")
    {
        Some("FONT")
    } else if data.starts_with(&[0x03, 0x00, 0x08, 0x00]) {
        probe.is_binary_xml = true;
        Some("AXML")
    } else {
        None
    };
    probe.format = format;
    if matches!(format, Some("PNG" | "JPEG" | "GIF" | "WEBP" | "BMP")) {
        if let Ok(size) = imagesize::blob_size(data) {
            probe.width = u32::try_from(size.width).ok();
            probe.height = u32::try_from(size.height).ok();
        }
    }
    if format.is_none() {
        let sample = &data[..data.len().min(4096)];
        let sample = sample
            .strip_prefix(b"\xEF\xBB\xBF".as_slice())
            .unwrap_or(sample);
        let utf8 = match std::str::from_utf8(sample) {
            Ok(_) => true,
            // A multi-byte character may be cut at the sample boundary.
            Err(error) => error.error_len().is_none(),
        };
        probe.looks_like_text = !sample.is_empty() && !sample.contains(&0) && utf8;
    }
    probe
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG_1X1: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03, 0x08, 0x06, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00,
    ];

    #[test]
    fn probes_png_dimensions() {
        let probe = probe_bytes(PNG_1X1);
        assert_eq!(probe.format, Some("PNG"));
        assert_eq!(probe.width, Some(2));
        assert_eq!(probe.height, Some(3));
    }

    #[test]
    fn probes_text_and_zip() {
        assert!(probe_bytes(b"<?xml version=\"1.0\"?><a/>").looks_like_text);
        assert!(probe_bytes(b"PK\x03\x04rest").is_zip);
        assert!(!probe_bytes(&[0u8, 1, 2, 3, 0, 0]).looks_like_text);
    }

    #[test]
    fn revisions_are_unique() {
        let a = Blob::new(vec![1], Compression::Stored);
        let b = Blob::new(vec![1], Compression::Stored);
        assert_ne!(a.rev, b.rev);
    }
}
