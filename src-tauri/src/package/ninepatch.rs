//! Android nine-patch PNGs.
//!
//! Two forms exist:
//! - **compiled**: the image has no border; stretch areas and padding live in
//!   an `npTc` chunk (this is what theme packages ship);
//! - **source**: a 1px border marks stretch areas (top/left) and content
//!   padding (bottom/right) with opaque black pixels.
//!
//! Compiled files are edited by rewriting only the `npTc` chunk, so the pixel
//! data stays byte-for-byte identical. Source files are edited by redrawing
//! the border and re-encoding the PNG as 8-bit RGBA.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

const SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const NO_COLOR: u32 = 0x0000_0001;
const MAX_PIXELS: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NinePatchKind {
    Compiled,
    Source,
    /// A PNG without nine-patch data yet.
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NinePatch {
    pub kind: NinePatchKind,
    /// Size of the drawable content (excluding the border of source files).
    pub width: u32,
    pub height: u32,
    /// Stretchable ranges `[start, end)` along each axis.
    pub x_divs: Vec<[u32; 2]>,
    pub y_divs: Vec<[u32; 2]>,
    /// Content padding `[left, top, right, bottom]`; `None` = not specified
    /// (Android then uses the stretch area).
    pub padding: Option<[u32; 4]>,
    /// Source files with red layout-bound markers; preserved as-is.
    pub layout_bounds: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NinePatchUpdate {
    pub x_divs: Vec<[u32; 2]>,
    pub y_divs: Vec<[u32; 2]>,
    pub padding: Option<[u32; 4]>,
}

// ----- PNG chunks -----------------------------------------------------------------

struct Chunk<'a> {
    kind: [u8; 4],
    data: &'a [u8],
    /// Whole chunk including length, type and CRC.
    raw: &'a [u8],
}

fn chunks(bytes: &[u8]) -> AppResult<Vec<Chunk<'_>>> {
    if bytes.len() < 8 || &bytes[..8] != SIGNATURE {
        return Err(AppError::invalid("Not a PNG file."));
    }
    let mut out = Vec::new();
    let mut at = 8;
    while at + 12 <= bytes.len() {
        let len = u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
        let end = at.checked_add(12 + len).filter(|e| *e <= bytes.len()).ok_or_else(|| AppError::invalid("The PNG is truncated."))?;
        let kind: [u8; 4] = bytes[at + 4..at + 8].try_into().unwrap();
        out.push(Chunk { kind, data: &bytes[at + 8..at + 8 + len], raw: &bytes[at..end] });
        at = end;
        if &kind == b"IEND" {
            break;
        }
    }
    if out.first().map(|c| &c.kind) != Some(b"IHDR") {
        return Err(AppError::invalid("The PNG has no header."));
    }
    Ok(out)
}

fn crc32(parts: &[&[u8]]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for part in parts {
        for &byte in *part {
            crc ^= byte as u32;
            for _ in 0..8 {
                crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
            }
        }
    }
    !crc
}

fn chunk_bytes(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 12);
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    out.extend_from_slice(&crc32(&[kind, data]).to_be_bytes());
    out
}

fn header_size(ihdr: &[u8]) -> (u32, u32) {
    let w = u32::from_be_bytes(ihdr[0..4].try_into().unwrap());
    let h = u32::from_be_bytes(ihdr[4..8].try_into().unwrap());
    (w, h)
}

// ----- compiled (npTc) ------------------------------------------------------------

fn be_u32(data: &[u8], at: usize) -> AppResult<u32> {
    data.get(at..at + 4)
        .map(|b| u32::from_be_bytes(b.try_into().unwrap()))
        .ok_or_else(|| AppError::invalid("The nine-patch chunk is truncated."))
}

fn pairs(values: &[u32]) -> Vec<[u32; 2]> {
    values.chunks_exact(2).map(|p| [p[0], p[1]]).collect()
}

fn parse_nptc(data: &[u8]) -> AppResult<(Vec<[u32; 2]>, Vec<[u32; 2]>, [u32; 4])> {
    if data.len() < 32 {
        return Err(AppError::invalid("The nine-patch chunk is truncated."));
    }
    let (nx, ny) = (data[1] as usize, data[2] as usize);
    let pad = |i: usize| -> AppResult<u32> { Ok(be_u32(data, 12 + i * 4)?.min(u16::MAX as u32)) };
    // File order: left, right, top, bottom.
    let padding = [pad(0)?, pad(2)?, pad(1)?, pad(3)?];
    let mut xs = Vec::with_capacity(nx);
    for i in 0..nx {
        xs.push(be_u32(data, 32 + i * 4)?);
    }
    let mut ys = Vec::with_capacity(ny);
    for i in 0..ny {
        ys.push(be_u32(data, 32 + (nx + i) * 4)?);
    }
    Ok((pairs(&xs), pairs(&ys), padding))
}

/// Number of patches along one axis (edges with zero-width segments dropped).
fn segments(divs: &[[u32; 2]], size: u32) -> usize {
    let mut bounds = vec![0];
    for d in divs {
        bounds.push(d[0]);
        bounds.push(d[1]);
    }
    bounds.push(size);
    bounds.windows(2).filter(|w| w[1] > w[0]).count().max(1)
}

fn build_nptc(update: &NinePatchUpdate, width: u32, height: u32) -> Vec<u8> {
    let xs: Vec<u32> = update.x_divs.iter().flatten().copied().collect();
    let ys: Vec<u32> = update.y_divs.iter().flatten().copied().collect();
    let colors = segments(&update.x_divs, width) * segments(&update.y_divs, height);
    let padding = update.padding.unwrap_or_else(|| default_padding(update, width, height));
    let mut out = Vec::with_capacity(32 + (xs.len() + ys.len() + colors) * 4);
    out.push(0); // wasDeserialized
    out.push(xs.len() as u8);
    out.push(ys.len() as u8);
    out.push(colors.min(255) as u8);
    out.extend_from_slice(&0u32.to_be_bytes()); // xDivsOffset (runtime only)
    out.extend_from_slice(&0u32.to_be_bytes()); // yDivsOffset
    for p in [padding[0], padding[2], padding[1], padding[3]] {
        out.extend_from_slice(&p.to_be_bytes());
    }
    out.extend_from_slice(&0u32.to_be_bytes()); // colorsOffset
    for v in xs.iter().chain(ys.iter()) {
        out.extend_from_slice(&v.to_be_bytes());
    }
    for _ in 0..colors.min(255) {
        out.extend_from_slice(&NO_COLOR.to_be_bytes());
    }
    out
}

/// What Android uses when no padding is given: the stretch area.
fn default_padding(update: &NinePatchUpdate, width: u32, height: u32) -> [u32; 4] {
    let (l, r) = match (update.x_divs.first(), update.x_divs.last()) {
        (Some(a), Some(b)) => (a[0], width.saturating_sub(b[1])),
        _ => (0, 0),
    };
    let (t, b) = match (update.y_divs.first(), update.y_divs.last()) {
        (Some(a), Some(z)) => (a[0], height.saturating_sub(z[1])),
        _ => (0, 0),
    };
    [l, t, r, b]
}

// ----- source (border) ------------------------------------------------------------

fn decode_rgba(bytes: &[u8]) -> AppResult<(u32, u32, Vec<u8>)> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|e| AppError::invalid(format!("Could not read the PNG: {e}")))?;
    let info = reader.info();
    if info.width as u64 * info.height as u64 > MAX_PIXELS {
        return Err(AppError::invalid("The image is too large to edit."));
    }
    let mut buf = vec![0; reader.output_buffer_size()];
    let frame = reader.next_frame(&mut buf).map_err(|e| AppError::invalid(format!("Could not decode the PNG: {e}")))?;
    let (w, h) = (frame.width, frame.height);
    let src = &buf[..frame.buffer_size()];
    let rgba = match frame.color_type {
        png::ColorType::Rgba => src.to_vec(),
        png::ColorType::Rgb => src.chunks_exact(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
        png::ColorType::GrayscaleAlpha => src.chunks_exact(2).flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
        png::ColorType::Grayscale => src.iter().flat_map(|&g| [g, g, g, 255]).collect(),
        png::ColorType::Indexed => return Err(AppError::invalid("Unsupported indexed PNG.")),
    };
    Ok((w, h, rgba))
}

fn encode_rgba(w: u32, h: u32, rgba: &[u8]) -> AppResult<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, w, h);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Best);
        let mut writer = encoder.write_header().map_err(|e| AppError::invalid(format!("Could not write the PNG: {e}")))?;
        writer.write_image_data(rgba).map_err(|e| AppError::invalid(format!("Could not write the PNG: {e}")))?;
    }
    Ok(out)
}

#[derive(Clone, Copy, PartialEq)]
enum Mark {
    None,
    Black,
    Red,
    Other,
}

fn mark(rgba: &[u8], w: u32, x: u32, y: u32) -> Mark {
    let i = ((y * w + x) * 4) as usize;
    match (rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]) {
        (_, _, _, 0) => Mark::None,
        (0, 0, 0, 255) => Mark::Black,
        (255, 0, 0, 255) => Mark::Red,
        _ => Mark::Other,
    }
}

fn runs(marks: impl Iterator<Item = Mark>) -> Vec<[u32; 2]> {
    let mut out = Vec::new();
    let mut start = None;
    let mut i = 0u32;
    for m in marks {
        match (m == Mark::Black, start) {
            (true, None) => start = Some(i),
            (false, Some(s)) => {
                out.push([s, i]);
                start = None;
            }
            _ => {}
        }
        i += 1;
    }
    if let Some(s) = start {
        out.push([s, i]);
    }
    out
}

/// A source nine-patch: every border pixel is transparent, black or red,
/// and at least one black marker exists on the top and left edges.
fn parse_source(w: u32, h: u32, rgba: &[u8]) -> Option<NinePatch> {
    if w < 3 || h < 3 {
        return None;
    }
    let (cw, ch) = (w - 2, h - 2);
    let mut layout_bounds = false;
    let mut border = (0..w).flat_map(|x| [(x, 0), (x, h - 1)]).chain((0..h).flat_map(|y| [(0, y), (w - 1, y)]));
    if border.any(|(x, y)| {
        let m = mark(rgba, w, x, y);
        layout_bounds |= m == Mark::Red;
        m == Mark::Other
    }) {
        return None;
    }
    let x_divs = runs((1..w - 1).map(|x| mark(rgba, w, x, 0)));
    let y_divs = runs((1..h - 1).map(|y| mark(rgba, w, 0, y)));
    if x_divs.is_empty() || y_divs.is_empty() {
        return None;
    }
    let px = runs((1..w - 1).map(|x| mark(rgba, w, x, h - 1)));
    let py = runs((1..h - 1).map(|y| mark(rgba, w, w - 1, y)));
    let padding = match (px.first(), py.first()) {
        (Some(x), Some(y)) => Some([x[0], y[0], cw - x[1], ch - y[1]]),
        _ => None,
    };
    Some(NinePatch { kind: NinePatchKind::Source, width: cw, height: ch, x_divs, y_divs, padding, layout_bounds })
}

// ----- API --------------------------------------------------------------------------

pub fn read(bytes: &[u8]) -> AppResult<NinePatch> {
    let list = chunks(bytes)?;
    let (w, h) = header_size(list[0].data);
    if let Some(chunk) = list.iter().find(|c| &c.kind == b"npTc") {
        let (x_divs, y_divs, padding) = parse_nptc(chunk.data)?;
        let has_lb = list.iter().any(|c| &c.kind == b"npLb");
        return Ok(NinePatch { kind: NinePatchKind::Compiled, width: w, height: h, x_divs, y_divs, padding: Some(padding), layout_bounds: has_lb });
    }
    if (w as u64) * (h as u64) <= MAX_PIXELS {
        if let Ok((dw, dh, rgba)) = decode_rgba(bytes) {
            if let Some(source) = parse_source(dw, dh, &rgba) {
                return Ok(source);
            }
        }
    }
    Ok(NinePatch { kind: NinePatchKind::None, width: w, height: h, x_divs: Vec::new(), y_divs: Vec::new(), padding: None, layout_bounds: false })
}

fn validate(update: &NinePatchUpdate, width: u32, height: u32) -> AppResult<()> {
    let check = |divs: &[[u32; 2]], size: u32, axis: &str| -> AppResult<()> {
        if divs.is_empty() {
            return Err(AppError::invalid(format!("Add at least one {axis} stretch area.")));
        }
        if divs.len() > 63 {
            return Err(AppError::invalid(format!("Too many {axis} stretch areas.")));
        }
        let mut last = 0;
        for (i, d) in divs.iter().enumerate() {
            if d[0] >= d[1] || d[1] > size || (i > 0 && d[0] < last) {
                return Err(AppError::invalid(format!(
                    "{axis} stretch areas must be non-empty, inside the image and in order without overlapping."
                )));
            }
            last = d[1];
        }
        Ok(())
    };
    check(&update.x_divs, width, "Horizontal")?;
    check(&update.y_divs, height, "Vertical")?;
    if let Some([l, t, r, b]) = update.padding {
        if l + r > width || t + b > height {
            return Err(AppError::invalid("The padding is larger than the image."));
        }
    }
    Ok(())
}

pub fn write(bytes: &[u8], update: &NinePatchUpdate) -> AppResult<Vec<u8>> {
    let current = read(bytes)?;
    validate(update, current.width, current.height)?;
    match current.kind {
        NinePatchKind::Compiled | NinePatchKind::None => {
            let list = chunks(bytes)?;
            let chunk = chunk_bytes(b"npTc", &build_nptc(update, current.width, current.height));
            let mut out = Vec::with_capacity(bytes.len() + chunk.len());
            out.extend_from_slice(SIGNATURE);
            for c in &list {
                if &c.kind == b"npTc" {
                    continue;
                }
                out.extend_from_slice(c.raw);
                if &c.kind == b"IHDR" {
                    out.extend_from_slice(&chunk);
                }
            }
            Ok(out)
        }
        NinePatchKind::Source => {
            let (w, h, mut rgba) = decode_rgba(bytes)?;
            let set = |rgba: &mut Vec<u8>, x: u32, y: u32, on: bool| {
                let i = ((y * w + x) * 4) as usize;
                if rgba[i..i + 4] == [255, 0, 0, 255] {
                    return; // keep layout bounds
                }
                rgba[i..i + 4].copy_from_slice(if on { &[0, 0, 0, 255] } else { &[0, 0, 0, 0] });
            };
            let inside = |divs: &[[u32; 2]], v: u32| divs.iter().any(|d| v >= d[0] && v < d[1]);
            for x in 0..w - 2 {
                set(&mut rgba, x + 1, 0, inside(&update.x_divs, x));
            }
            for y in 0..h - 2 {
                set(&mut rgba, 0, y + 1, inside(&update.y_divs, y));
            }
            let (cw, ch) = (w - 2, h - 2);
            for x in 0..cw {
                let on = update.padding.is_some_and(|[l, _, r, _]| x >= l && x < cw - r);
                set(&mut rgba, x + 1, h - 1, on);
            }
            for y in 0..ch {
                let on = update.padding.is_some_and(|[_, t, _, b]| y >= t && y < ch - b);
                set(&mut rgba, w - 1, y + 1, on);
            }
            encode_rgba(w, h, &rgba)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain_png(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
        encode_rgba(w, h, rgba).unwrap()
    }

    #[test]
    fn compiled_round_trip_keeps_pixels() {
        let pixels = vec![200u8; 10 * 6 * 4];
        let png = plain_png(10, 6, &pixels);
        assert_eq!(read(&png).unwrap().kind, NinePatchKind::None);
        let update = NinePatchUpdate { x_divs: vec![[2, 4], [6, 8]], y_divs: vec![[1, 5]], padding: Some([1, 2, 3, 1]) };
        let out = write(&png, &update).unwrap();
        let np = read(&out).unwrap();
        assert_eq!(np.kind, NinePatchKind::Compiled);
        assert_eq!(np.x_divs, update.x_divs);
        assert_eq!(np.y_divs, update.y_divs);
        assert_eq!(np.padding, Some([1, 2, 3, 1]));
        // Image data chunks are untouched.
        let idat = |b: &[u8]| chunks(b).unwrap().into_iter().filter(|c| &c.kind == b"IDAT").map(|c| c.raw.to_vec()).collect::<Vec<_>>();
        assert_eq!(idat(&png), idat(&out));
        // Decodes as a normal PNG (CRC valid) and the chunk sits after IHDR.
        assert_eq!(decode_rgba(&out).unwrap().2, pixels);
        assert_eq!(&chunks(&out).unwrap()[1].kind, b"npTc");
        // Rewriting replaces the chunk rather than adding a second one.
        let again = write(&out, &NinePatchUpdate { x_divs: vec![[0, 10]], y_divs: vec![[0, 6]], padding: None }).unwrap();
        assert_eq!(chunks(&again).unwrap().iter().filter(|c| &c.kind == b"npTc").count(), 1);
        assert_eq!(read(&again).unwrap().padding, Some([0, 0, 0, 0]));
    }

    #[test]
    fn colors_count_matches_patches() {
        let update = NinePatchUpdate { x_divs: vec![[0, 2], [4, 6]], y_divs: vec![[1, 3]], padding: None };
        let chunk = build_nptc(&update, 6, 4);
        // x: [0,2) [2,4) [4,6) = 3 segments; y: [0,1) [1,3) [3,4) = 3 segments.
        assert_eq!(chunk[3], 9);
        assert_eq!(chunk.len(), 32 + (4 + 2 + 9) * 4);
    }

    fn source_png() -> Vec<u8> {
        // 6x5 image: content 4x3, top marks x 1..3, left marks y 1..2, padding bottom x 0..4, right y 0..3.
        let (w, h) = (6u32, 5u32);
        let mut px = vec![0u8; (w * h * 4) as usize];
        let mut put = |x: u32, y: u32, c: [u8; 4]| {
            let i = ((y * w + x) * 4) as usize;
            px[i..i + 4].copy_from_slice(&c);
        };
        for y in 1..h - 1 {
            for x in 1..w - 1 {
                put(x, y, [10, 120, 200, 255]);
            }
        }
        for x in 2..4 {
            put(x, 0, [0, 0, 0, 255]);
        }
        put(0, 2, [0, 0, 0, 255]);
        for x in 1..5 {
            put(x, h - 1, [0, 0, 0, 255]);
        }
        for y in 1..4 {
            put(w - 1, y, [0, 0, 0, 255]);
        }
        plain_png(w, h, &px)
    }

    #[test]
    fn source_read_and_write() {
        let png = source_png();
        let np = read(&png).unwrap();
        assert_eq!(np.kind, NinePatchKind::Source);
        assert_eq!((np.width, np.height), (4, 3));
        assert_eq!(np.x_divs, vec![[1, 3]]);
        assert_eq!(np.y_divs, vec![[1, 2]]);
        assert_eq!(np.padding, Some([0, 0, 0, 0]));
        let out = write(&png, &NinePatchUpdate { x_divs: vec![[0, 1], [3, 4]], y_divs: vec![[0, 3]], padding: Some([1, 0, 1, 1]) }).unwrap();
        let np = read(&out).unwrap();
        assert_eq!(np.x_divs, vec![[0, 1], [3, 4]]);
        assert_eq!(np.y_divs, vec![[0, 3]]);
        assert_eq!(np.padding, Some([1, 0, 1, 1]));
        // Content pixels survive.
        let (_, _, rgba) = decode_rgba(&out).unwrap();
        let i = ((2 * 6 + 2) * 4) as usize;
        assert_eq!(&rgba[i..i + 4], &[10, 120, 200, 255]);
    }

    #[test]
    fn rejects_bad_updates_and_files() {
        let png = plain_png(4, 4, &[1u8; 64]);
        let bad = |x: Vec<[u32; 2]>, y: Vec<[u32; 2]>| write(&png, &NinePatchUpdate { x_divs: x, y_divs: y, padding: None }).is_err();
        assert!(bad(vec![], vec![[0, 1]]));
        assert!(bad(vec![[2, 2]], vec![[0, 1]]));
        assert!(bad(vec![[0, 5]], vec![[0, 1]]));
        assert!(bad(vec![[2, 3], [0, 1]], vec![[0, 1]]));
        assert!(read(b"not a png").is_err());
        let mut truncated = png.clone();
        truncated.truncate(20);
        assert!(read(&truncated).is_err());
    }
}

#[cfg(test)]
mod sample_tests {
    use super::*;

    /// `MTS_NINEPATCH_SAMPLE=<theme.mtz> cargo test ninepatch::sample_tests -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_theme_nine_patches() {
        let Ok(path) = std::env::var("MTS_NINEPATCH_SAMPLE") else { return };
        let data = std::fs::read(path).unwrap();
        let project = crate::project::Project::from_bytes(&data, "s.mtz", None, crate::package::archive::Limits::default()).unwrap();
        let mut count = 0;
        for (path, blob) in &project.files {
            if !path.ends_with(".9.png") {
                continue;
            }
            let np = read(&blob.data).unwrap_or_else(|e| panic!("{path}: {}", e.message));
            assert_eq!(np.kind, NinePatchKind::Compiled, "{path}");
            for d in np.x_divs.iter() {
                assert!(d[0] < d[1] && d[1] <= np.width, "{path} x {d:?} w {}", np.width);
            }
            for d in np.y_divs.iter() {
                assert!(d[0] < d[1] && d[1] <= np.height, "{path} y {d:?} h {}", np.height);
            }
            let update = NinePatchUpdate { x_divs: np.x_divs.clone(), y_divs: np.y_divs.clone(), padding: np.padding };
            let again = read(&write(&blob.data, &update).unwrap()).unwrap();
            assert_eq!(again, np, "{path}");
            count += 1;
        }
        println!("{count} nine-patches parsed and round-tripped");
        assert!(count > 0);
    }
}
