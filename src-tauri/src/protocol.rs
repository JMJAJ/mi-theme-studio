//! `themeres:` URI scheme serving package files and device screenshots to
//! `<img>` elements without sending bytes through IPC.
//!
//! URLs: `themeres://localhost/{main|ref}/{percent-encoded path}?v={rev}`
//! and `themeres://localhost/shot/{id}` (on Windows the webview uses
//! `http://themeres.localhost/...`).

use crate::project::classify::kind_of;
use crate::state::{lock, AppState};
use percent_encoding::percent_decode_str;
use std::sync::Arc;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext};

fn mime(format: Option<&str>, kind: &str) -> &'static str {
    match format {
        Some("PNG") => "image/png",
        Some("JPEG") => "image/jpeg",
        Some("GIF") => "image/gif",
        Some("WEBP") => "image/webp",
        Some("BMP") => "image/bmp",
        Some("AVIF") => "image/avif",
        Some("OGG") => "audio/ogg",
        Some("MP3") => "audio/mpeg",
        Some("WAV") => "audio/wav",
        Some("MP4") => "video/mp4",
        _ if kind == "xml" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn respond(
    status: StatusCode,
    content_type: &str,
    body: Vec<u8>,
    cache: bool,
) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(
            header::CACHE_CONTROL,
            if cache {
                "max-age=31536000, immutable"
            } else {
                "no-store"
            },
        )
        .header("X-Content-Type-Options", "nosniff")
        // Fonts are always fetched in CORS mode, and the webview page lives on a
        // different origin than this scheme: without this header every font
        // preview silently falls back to the UI font.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let state = ctx.app_handle().state::<AppState>();
    let raw_path = request.uri().path().trim_start_matches('/');
    let (slot, rest) = raw_path.split_once('/').unwrap_or((raw_path, ""));
    let decoded = percent_decode_str(rest).decode_utf8_lossy().into_owned();
    let not_found = || {
        respond(
            StatusCode::NOT_FOUND,
            "text/plain",
            b"not found".to_vec(),
            false,
        )
    };
    match slot {
        "main" | "ref" => {
            let guard = if slot == "main" {
                lock(&state.main)
            } else {
                lock(&state.reference)
            };
            let Some(project) = guard.as_ref() else {
                return not_found();
            };
            let Some(blob) = project.files.get(&decoded).cloned() else {
                return not_found();
            };
            drop(guard);
            let probe = blob.probe();
            let content_type = mime(probe.format, kind_of(&decoded, probe));
            respond(StatusCode::OK, content_type, blob.data.clone(), true)
        }
        "shot" => {
            let Ok(id) = decoded.parse::<u64>() else {
                return not_found();
            };
            let data: Option<Arc<Vec<u8>>> = lock(&state.screenshots)
                .iter()
                .find(|s| s.id == id)
                .map(|s| s.data.clone());
            match data {
                Some(data) => respond(StatusCode::OK, "image/png", data.as_ref().clone(), true),
                None => not_found(),
            }
        }
        _ => not_found(),
    }
}
