//! Re-encode an image so its content matches its file extension (a `.webp`
//! that actually holds PNG data, a `.png` that is a JPEG, ...). The file keeps
//! its name, so every reference to it stays valid.

use crate::error::{AppError, AppResult};
use crate::package::blob::probe_bytes;
use crate::package::paths::{extension, file_name};
use image::codecs::gif::GifDecoder;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::codecs::webp::WebPEncoder;
use image::{AnimationDecoder, DynamicImage, ImageEncoder, ImageFormat, Rgb, RgbImage};
use std::io::Cursor;

/// JPEG quality used when a file named `.jpg` has to be re-encoded.
const JPEG_QUALITY: u8 = 92;

/// The format a file's extension asks for, if this module can write it.
pub fn target_format(path: &str) -> Option<ImageFormat> {
    match extension(path).as_str() {
        "png" => Some(ImageFormat::Png),
        "jpg" | "jpeg" => Some(ImageFormat::Jpeg),
        "webp" => Some(ImageFormat::WebP),
        _ => None,
    }
}

fn source_format(data: &[u8]) -> Option<ImageFormat> {
    match probe_bytes(data).format? {
        "PNG" => Some(ImageFormat::Png),
        "JPEG" => Some(ImageFormat::Jpeg),
        "WEBP" => Some(ImageFormat::WebP),
        "GIF" => Some(ImageFormat::Gif),
        "BMP" => Some(ImageFormat::Bmp),
        _ => None,
    }
}

/// Animated sources would lose every frame but the first, so they are left alone.
fn is_animated(data: &[u8], format: ImageFormat) -> bool {
    match format {
        // VP8X header: flags byte at offset 20, bit 1 = animation.
        ImageFormat::WebP => data.len() > 20 && &data[12..16] == b"VP8X" && data[20] & 0x02 != 0,
        ImageFormat::Gif => GifDecoder::new(Cursor::new(data))
            .map(|d| d.into_frames().take(2).count() > 1)
            .unwrap_or(false),
        _ => false,
    }
}

/// Why `path` cannot be converted, or `None` if it can (and needs to be).
pub fn blocker(path: &str, data: &[u8]) -> Option<String> {
    let Some(target) = target_format(path) else {
        return Some("Only .png, .jpg and .webp files can be converted.".into());
    };
    // `name.9.png` keeps its nine-patch border only as PNG; the name says what it is.
    if file_name(path).to_ascii_lowercase().ends_with(".9.png") && target != ImageFormat::Png {
        return Some("Nine-patch images must stay PNG.".into());
    }
    let Some(source) = source_format(data) else {
        return Some("The image format could not be recognised.".into());
    };
    if source == target {
        return Some("Already matches its extension.".into());
    }
    if is_animated(data, source) {
        return Some("Animated images are not converted; only the first frame would survive.".into());
    }
    None
}

/// Whether the Problems panel should offer a one-click conversion.
pub fn can_convert(path: &str, data: &[u8]) -> bool {
    blocker(path, data).is_none()
}

/// Re-encode `data` into the format named by `path`'s extension.
/// PNG and WebP are written losslessly; JPEG has no alpha, so transparent
/// pixels are flattened onto white.
pub fn convert_for_path(path: &str, data: &[u8]) -> AppResult<Vec<u8>> {
    if let Some(reason) = blocker(path, data) {
        return Err(AppError::invalid(reason));
    }
    let target = target_format(path).expect("checked by blocker");
    let source = source_format(data).expect("checked by blocker");
    let image = image::load_from_memory_with_format(data, source)
        .map_err(|e| AppError::invalid(format!("Could not decode the image: {e}")))?;
    encode(image, target)
}

fn encode(image: DynamicImage, target: ImageFormat) -> AppResult<Vec<u8>> {
    let mut out = Vec::new();
    let failed = |e: image::ImageError| AppError::invalid(format!("Could not encode the image: {e}"));
    let (w, h) = (image.width(), image.height());
    match target {
        ImageFormat::Png => {
            let (bytes, color) = if image.color().has_alpha() {
                (image.into_rgba8().into_raw(), image::ExtendedColorType::Rgba8)
            } else {
                (image.into_rgb8().into_raw(), image::ExtendedColorType::Rgb8)
            };
            PngEncoder::new(&mut out).write_image(&bytes, w, h, color).map_err(failed)?;
        }
        ImageFormat::WebP => {
            let (bytes, color) = if image.color().has_alpha() {
                (image.into_rgba8().into_raw(), image::ExtendedColorType::Rgba8)
            } else {
                (image.into_rgb8().into_raw(), image::ExtendedColorType::Rgb8)
            };
            WebPEncoder::new_lossless(&mut out).write_image(&bytes, w, h, color).map_err(failed)?;
        }
        ImageFormat::Jpeg => {
            let rgb = if image.color().has_alpha() {
                let rgba = image.into_rgba8();
                RgbImage::from_fn(w, h, |x, y| {
                    let p = rgba.get_pixel(x, y).0;
                    let a = p[3] as u32;
                    let blend = |c: u8| ((c as u32 * a + 255 * (255 - a) + 127) / 255) as u8;
                    Rgb([blend(p[0]), blend(p[1]), blend(p[2])])
                })
            } else {
                image.into_rgb8()
            };
            JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY)
                .write_image(rgb.as_raw(), w, h, image::ExtendedColorType::Rgb8)
                .map_err(failed)?;
        }
        _ => return Err(AppError::invalid("Unsupported target format.")),
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(alpha: bool) -> Vec<u8> {
        let image = if alpha {
            DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(3, 2, image::Rgba([10, 20, 30, 128])))
        } else {
            DynamicImage::ImageRgb8(RgbImage::from_pixel(3, 2, Rgb([10, 20, 30])))
        };
        encode(image, ImageFormat::Png).unwrap()
    }

    #[test]
    fn converts_png_named_webp() {
        let data = png(true);
        assert!(can_convert("a/finger.webp", &data));
        let out = convert_for_path("a/finger.webp", &data).unwrap();
        assert_eq!(probe_bytes(&out).format, Some("WEBP"));
        let back = image::load_from_memory(&out).unwrap().into_rgba8();
        assert_eq!(back.dimensions(), (3, 2));
        assert_eq!(back.get_pixel(1, 1).0, [10, 20, 30, 128], "lossless");
    }

    #[test]
    fn converts_to_jpeg_and_png() {
        let out = convert_for_path("w.jpg", &png(true)).unwrap();
        assert_eq!(probe_bytes(&out).format, Some("JPEG"));
        let webp = convert_for_path("x.webp", &png(false)).unwrap();
        let out = convert_for_path("x.png", &webp).unwrap();
        assert_eq!(probe_bytes(&out).format, Some("PNG"));
    }

    #[test]
    fn refuses_what_it_should() {
        assert!(!can_convert("a.png", &png(false)), "already matches");
        assert!(!can_convert("a.gif", &png(false)), "gif target unsupported");
        assert!(!can_convert("a.webp", b"not an image"));
    }
}
