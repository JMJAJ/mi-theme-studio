//! Xiaomi Theme Design Station client (zhuti.designer.intl.xiaomi.com).
//!
//! Publishing a theme from the app follows the same calls the station's web app makes:
//!
//! 1. `POST /v3/designers/audits/add-mtz` (multipart `mtzFile`, `miuiVersion`, `productType`)
//!    creates an audit and returns its `auditId` plus the metadata read from the package.
//! 2. `POST /v3/designers/files/dynamic/video_upload` (multipart `file`, MP4 up to 20 MB)
//!    returns the preview GIF address (`gifUrl`), required for dynamic themes.
//! 3. `POST /v3/designers/files/copyright` (multipart `copyrightFile`, a ZIP) returns the
//!    `fileId`/`filename` pair the submission names as `copyrightLocator`/`copyrightFilename`.
//! 4. `POST /v3/designers/audits/submit-mtz` (JSON) submits the audit for review.
//!
//! A theme already on the station takes `update-mtz` in step 1 (plus `productId`). Its
//! submission carries a `changeLog` only once the theme has been live (`productStatus` set);
//! one rejected before going live is simply resubmitted, as the website's Update dialog does.
//!
//! Sign-in runs Xiaomi's own Mi account page (`/v1/login` → `loginUrl` on account.xiaomi.com,
//! password via `serviceLoginAuth2`, then the e-mailed/texted code via `identity/verifyEmail`)
//! in a separate webview window, so the app never sees the password. When the window comes
//! back through the station's `/sts` callback, the session cookies (`serviceToken`, `userId`,
//! `cUserId`, `desmarket-global_*`) are read from the webview cookie store and saved in the
//! app's data folder until sign-out. A pasted `Cookie` header also works.

use crate::commands::{blocking, build_package_bytes};
use crate::error::{AppError, AppResult};
use crate::package::archive::{self, WriteEntry};
use crate::package::blob::Compression;
use crate::package::metadata::{self, DESCRIPTION_PATH};
use crate::state::{lock, AppState};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder};

pub const BASE: &str = "https://zhuti.designer.intl.xiaomi.com";
const LOGIN_WINDOW: &str = "xiaomi-designer";
/// The station's own limits.
const MAX_VIDEO_BYTES: u64 = 20 * 1024 * 1024;
const MAX_COPYRIGHT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_PACKAGE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_PROOF_EXTRA_BYTES: u64 = 1024 * 1024 * 1024;
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const DESIGNER_HOST: &str = "zhuti.designer.intl.xiaomi.com";
const SESSION_FILE: &str = "designer-session.json";

/// The station's session cookies. Saved in the app's data folder so the sign-in
/// survives restarts; removed on sign-out.
#[derive(Clone, Serialize, Deserialize)]
struct Session {
    cookie: String,
    /// Pasted by the user rather than taken from the sign-in window.
    #[serde(default)]
    manual: bool,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static SESSION_LOADED: AtomicBool = AtomicBool::new(false);
/// Set while a finished sign-in is being picked up, so redirects don't race.
static FINISHING: AtomicBool = AtomicBool::new(false);

// ----- session ------------------------------------------------------------------

fn designer_url() -> Url {
    Url::parse(BASE).expect("valid designer URL")
}

fn session_path(app: &AppHandle) -> PathBuf {
    app.state::<AppState>().paths.data.join(SESSION_FILE)
}

fn current_session(app: &AppHandle) -> Option<Session> {
    if !SESSION_LOADED.swap(true, Ordering::SeqCst) {
        let saved = std::fs::read(session_path(app)).ok().and_then(|b| serde_json::from_slice::<Session>(&b).ok());
        let mut slot = lock(&SESSION);
        if slot.is_none() {
            *slot = saved.filter(|s| s.cookie.contains("serviceToken="));
        }
    }
    lock(&SESSION).clone()
}

fn store_session(app: &AppHandle, session: Option<Session>) {
    SESSION_LOADED.store(true, Ordering::SeqCst);
    let path = session_path(app);
    match &session {
        Some(s) => {
            if let Ok(bytes) = serde_json::to_vec(s) {
                if let Some(dir) = path.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let _ = crate::storage::atomic_write(&path, &bytes);
            }
        }
        None => {
            let _ = std::fs::remove_file(&path);
        }
    }
    *lock(&SESSION) = session;
}

/// Cookies for the station from the webview cookie store (shared by all windows).
/// Must not run on the main thread on Windows.
fn webview_cookie(app: &AppHandle) -> Option<String> {
    let window = app.get_webview_window(LOGIN_WINDOW).or_else(|| app.webview_windows().into_values().next())?;
    let cookies = window.cookies_for_url(designer_url()).ok()?;
    let header = cookies
        .iter()
        .map(|c| format!("{}={}", c.name(), c.value()))
        .collect::<Vec<_>>()
        .join("; ");
    header.contains("serviceToken=").then_some(header)
}

fn cookie_header(app: &AppHandle) -> AppResult<String> {
    if let Some(session) = current_session(app) {
        return Ok(session.cookie);
    }
    let cookie = webview_cookie(app).ok_or_else(|| AppError::new("designer_signed_out", "Sign in to the Xiaomi Theme Design Station first."))?;
    store_session(app, Some(Session { cookie: cookie.clone(), manual: false }));
    Ok(cookie)
}

fn agent(timeout_secs: u64) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(20)))
        .timeout_global(Some(Duration::from_secs(timeout_secs)))
        .http_status_as_error(false)
        .user_agent(BROWSER_UA)
        .build()
        .into()
}

fn network_error(e: ureq::Error) -> AppError {
    AppError::new("network", format!("Could not reach the Xiaomi Theme Design Station: {e}"))
}

/// The station answers `{code:"success", message, data}`; errors carry a readable message.
fn read_answer(mut response: ureq::http::Response<ureq::Body>) -> AppResult<Value> {
    let status = response.status().as_u16();
    let body = response
        .body_mut()
        .with_config()
        .limit(4 << 20)
        .read_to_string()
        .map_err(|e| AppError::new("network", format!("Could not read the station's answer: {e}")))?;
    let value: Option<Value> = serde_json::from_str(&body).ok();
    let message = value
        .as_ref()
        .and_then(|v| v.get("message").or_else(|| v.get("msg")))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    match status {
        401 => return Err(AppError::new("designer_signed_out", "Your Design Station session has ended. Sign in again.")),
        423 => return Err(AppError::new("designer_unregistered", "This Mi account is not registered as a designer yet. Sign up on the Design Station first.")),
        _ => {}
    }
    let Some(value) = value else {
        return Err(AppError::new("designer_http", format!("The station answered HTTP {status} with something that is not JSON.")));
    };
    let ok_code = value.get("code").and_then(Value::as_str) == Some("success")
        || value.get("result").and_then(Value::as_i64) == Some(200);
    if !(200..300).contains(&status) || !ok_code {
        let text = if message.is_empty() { format!("HTTP {status}") } else { message };
        return Err(AppError::new("designer_http", format!("The Design Station refused the request: {text}")));
    }
    Ok(value.get("data").cloned().unwrap_or(Value::Null))
}

fn get_json(app: &AppHandle, path: &str) -> AppResult<Value> {
    let cookie = cookie_header(app)?;
    let response = agent(30)
        .get(format!("{BASE}{path}"))
        .header("Accept", "application/json, text/plain, */*")
        .header("Referer", format!("{BASE}/"))
        .header("Cookie", cookie)
        .call()
        .map_err(network_error)?;
    read_answer(response)
}

fn post_json(app: &AppHandle, path: &str, body: &Value) -> AppResult<Value> {
    let cookie = cookie_header(app)?;
    let response = agent(60)
        .post(format!("{BASE}{path}"))
        .header("Accept", "application/json, text/plain, */*")
        .header("Content-Type", "application/json")
        .header("Origin", BASE)
        .header("Referer", format!("{BASE}/"))
        .header("Cookie", cookie)
        .send(serde_json::to_vec(body).unwrap_or_default())
        .map_err(network_error)?;
    read_answer(response)
}

// ----- multipart upload with progress -------------------------------------------

enum Part {
    Text { name: &'static str, value: String },
    File { name: &'static str, filename: String, mime: &'static str, data: Vec<u8> },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadProgress {
    pub what: &'static str,
    pub sent: u64,
    pub total: u64,
}

struct Counting<R> {
    inner: R,
    sent: u64,
    total: u64,
    last_emit: u64,
    what: &'static str,
    app: AppHandle,
}

impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.sent += n as u64;
        if self.sent - self.last_emit >= 256 * 1024 || self.sent == self.total {
            self.last_emit = self.sent;
            let _ = self.app.emit("designer-upload", UploadProgress { what: self.what, sent: self.sent, total: self.total });
        }
        Ok(n)
    }
}

fn quote_filename(name: &str) -> String {
    name.chars().map(|c| if c == '"' || c == '\r' || c == '\n' { '_' } else { c }).collect()
}

fn multipart_body(parts: Vec<Part>) -> (String, Vec<u8>) {
    let boundary = format!("----MiThemeStudio{:016x}", crate::storage::now_ms().wrapping_mul(0x9E37_79B9_7F4A_7C15));
    let mut body = Vec::new();
    for part in parts {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        match part {
            Part::Text { name, value } => {
                body.extend_from_slice(format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes());
                body.extend_from_slice(value.as_bytes());
            }
            Part::File { name, filename, mime, data } => {
                body.extend_from_slice(
                    format!(
                        "Content-Disposition: form-data; name=\"{name}\"; filename=\"{}\"\r\nContent-Type: {mime}\r\n\r\n",
                        quote_filename(&filename)
                    )
                    .as_bytes(),
                );
                body.extend_from_slice(&data);
            }
        }
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

fn post_multipart(app: &AppHandle, path: &str, what: &'static str, parts: Vec<Part>) -> AppResult<Value> {
    let cookie = cookie_header(app)?;
    let (content_type, body) = multipart_body(parts);
    let total = body.len() as u64;
    let reader = Counting { inner: Cursor::new(body), sent: 0, total, last_emit: 0, what, app: app.clone() };
    let _ = app.emit("designer-upload", UploadProgress { what, sent: 0, total });
    let response = agent(60 * 30)
        .post(format!("{BASE}{path}"))
        .header("Accept", "application/json, text/plain, */*")
        .header("Content-Type", content_type)
        .header("Content-Length", total.to_string())
        .header("Origin", BASE)
        .header("Referer", format!("{BASE}/"))
        .header("Cookie", cookie)
        .send(ureq::SendBody::from_owned_reader(reader))
        .map_err(network_error)?;
    read_answer(response)
}

fn read_file(path: &Path, limit: u64, what: &str) -> AppResult<Vec<u8>> {
    let meta = std::fs::metadata(path).map_err(|e| AppError::io(format!("Could not read {}", path.display()), e))?;
    if !meta.is_file() {
        return Err(AppError::invalid(format!("{} is not a file.", path.display())));
    }
    if meta.len() > limit {
        return Err(AppError::new("limit", format!("{what} is larger than the {} MB limit.", limit / 1024 / 1024)));
    }
    std::fs::read(path).map_err(|e| AppError::io(format!("Could not read {}", path.display()), e))
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into())
}

fn has_extension(path: &Path, ext: &str) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case(ext))
}

// ----- commands: session --------------------------------------------------------

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesignerStatus {
    pub signed_in: bool,
    pub manual_cookie: bool,
    pub nickname: Option<String>,
    pub designer_id: Option<i64>,
    pub designer_type: Option<String>,
    pub registration_status: Option<String>,
    pub profile_pic: Option<String>,
    pub message: Option<String>,
}

fn signed_in_status(data: &Value, manual_cookie: bool) -> DesignerStatus {
    let field = |k: &str| data.get(k).and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_string);
    DesignerStatus {
        signed_in: true,
        manual_cookie,
        nickname: field("nickname"),
        designer_id: data.get("designerId").and_then(Value::as_i64),
        designer_type: field("designerType"),
        registration_status: field("registrationStatus"),
        profile_pic: field("profilePic").filter(|u| u.starts_with("https://")),
        message: None,
    }
}

fn status(app: &AppHandle) -> DesignerStatus {
    let mut retried = false;
    loop {
        let manual_cookie = current_session(app).is_some_and(|s| s.manual);
        match get_json(app, "/v1/designers") {
            Ok(data) => return signed_in_status(&data, manual_cookie),
            // A saved session that expired: forget it and try the webview's cookies once.
            Err(e) if e.code == "designer_signed_out" && !retried && current_session(app).is_some() => {
                store_session(app, None);
                retried = true;
            }
            Err(e) => {
                return DesignerStatus {
                    manual_cookie,
                    message: (e.code != "designer_signed_out").then_some(e.message),
                    ..Default::default()
                }
            }
        }
    }
}

#[tauri::command]
pub async fn designer_status(app: AppHandle) -> AppResult<DesignerStatus> {
    blocking(app, |_, app| Ok(status(app))).await
}

/// The Mi account sign-in page for the station: `GET /v1/login` answers 401 with the
/// `account.xiaomi.com/pass/serviceLogin?...&sid=desmarket-global` address, whose callback
/// (`/sts?sign=...&followup=...`) sets the station's `serviceToken`.
fn login_url() -> String {
    let answer = agent(15)
        .get(format!("{BASE}/v1/login"))
        .header("Accept", "application/json, text/plain, */*")
        .header("Referer", format!("{BASE}/"))
        .header("Cookie", "lang=en")
        .call()
        .ok()
        .and_then(|mut r| r.body_mut().with_config().limit(64 * 1024).read_to_string().ok())
        .and_then(|body| serde_json::from_str::<Value>(&body).ok());
    answer
        .as_ref()
        .and_then(|v| v.get("loginUrl"))
        .and_then(Value::as_str)
        .filter(|u| u.starts_with("https://account.xiaomi.com/"))
        .map(str::to_string)
        .unwrap_or_else(|| format!("{BASE}/"))
}

/// Runs after the sign-in window lands back on the station: takes the cookies,
/// checks them, tells the UI and closes the window.
fn finish_login(app: &AppHandle) {
    if FINISHING.swap(true, Ordering::SeqCst) {
        return;
    }
    for _ in 0..6 {
        std::thread::sleep(Duration::from_millis(700));
        let Some(cookie) = webview_cookie(app) else { continue };
        store_session(app, Some(Session { cookie, manual: false }));
        let next = status(app);
        if next.signed_in {
            let _ = app.emit("designer-session", next);
            if let Some(window) = app.get_webview_window(LOGIN_WINDOW) {
                let _ = window.close();
            }
            break;
        }
    }
    FINISHING.store(false, Ordering::SeqCst);
}

/// Opens Xiaomi's own sign-in page (password, then the e-mailed or texted code) in a
/// separate window. The app never sees the password; it only keeps the session cookies.
#[tauri::command]
pub async fn designer_login_open(app: AppHandle) -> AppResult<()> {
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }
    let url = blocking(app.clone(), |_, _| Ok(login_url())).await?;
    let url = Url::parse(&url).unwrap_or_else(|_| designer_url());
    let handle = app.clone();
    let window = WebviewWindowBuilder::new(&app, LOGIN_WINDOW, WebviewUrl::External(url))
        .title("Sign in to Xiaomi Theme Design Station")
        .inner_size(520.0, 780.0)
        .center()
        .on_navigation(move |url| {
            // Past `/sts`, the station has set its cookies.
            if url.host_str() == Some(DESIGNER_HOST) && !url.path().starts_with("/sts") {
                let app = handle.clone();
                std::thread::spawn(move || finish_login(&app));
            }
            true
        })
        .build()
        .map_err(|e| AppError::new("internal", format!("Could not open the sign-in window: {e}")))?;
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let _ = handle.emit("designer-login-closed", ());
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn designer_login_close(app: AppHandle) -> AppResult<()> {
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW) {
        let _ = window.close();
    }
    Ok(())
}

/// Uses a `Cookie` header copied from the browser instead of the sign-in window.
#[tauri::command]
pub async fn designer_set_cookie(app: AppHandle, cookie: String) -> AppResult<DesignerStatus> {
    let cookie = cookie.trim().trim_start_matches("Cookie:").trim().to_string();
    if !cookie.contains("serviceToken=") {
        return Err(AppError::invalid("That cookie has no serviceToken; copy the whole Cookie header of a request to zhuti.designer.intl.xiaomi.com."));
    }
    blocking(app, move |_, app| {
        store_session(app, Some(Session { cookie, manual: true }));
        let next = status(app);
        if !next.signed_in {
            store_session(app, None);
        }
        let _ = app.emit("designer-session", next.clone());
        Ok(next)
    })
    .await
}

/// Forgets the session: the saved cookies and the Xiaomi cookies in the webview store.
#[tauri::command]
pub async fn designer_sign_out(app: AppHandle) -> AppResult<()> {
    blocking(app, |_, app| {
        store_session(app, None);
        if let Some(window) = app.webview_windows().into_values().next() {
            if let Ok(cookies) = window.cookies() {
                for cookie in cookies {
                    let domain = cookie.domain().unwrap_or("").trim_start_matches('.').to_ascii_lowercase();
                    if domain == "xiaomi.com" || domain.ends_with(".xiaomi.com") {
                        let _ = window.delete_cookie(cookie);
                    }
                }
            }
        }
        if let Some(window) = app.get_webview_window(LOGIN_WINDOW) {
            let _ = window.close();
        }
        let _ = app.emit("designer-session", DesignerStatus::default());
        Ok(())
    })
    .await
}

// ----- commands: upload & submit -------------------------------------------------

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TagGroup {
    pub name: String,
    #[serde(default)]
    pub sub_tags: Vec<String>,
}

#[tauri::command]
pub async fn designer_tags(app: AppHandle) -> AppResult<Vec<TagGroup>> {
    blocking(app, |_, app| {
        let data = get_json(app, "/v3/tag/list?category=THEME")?;
        Ok(serde_json::from_value(data).unwrap_or_default())
    })
    .await
}

/// What the station read from the uploaded package.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PackageAudit {
    pub audit_id: String,
    pub product_name: String,
    pub designer_name: String,
    pub author_name: String,
    pub version_name: String,
    pub miui_version: String,
    pub description: String,
    pub file_size: u64,
}

fn text(data: &Value, key: &str) -> String {
    data.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

/// Product and audit ids are UUID-like; anything else never goes into a URL.
fn check_id(id: &str) -> AppResult<&str> {
    if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Ok(id)
    } else {
        Err(AppError::invalid("That is not a Design Station id."))
    }
}

/// Uploads the package: the given .mtz, or the open project built in memory.
/// With `product_id` it is a new version of that published theme (`update-mtz`).
#[tauri::command]
pub async fn designer_upload_package(app: AppHandle, path: Option<String>, miui_version: String, product_id: Option<String>) -> AppResult<PackageAudit> {
    let allowed: &[&str] = if product_id.is_some() { &["V12", "V15", "V17"] } else { &["V15", "V17"] };
    if !allowed.contains(&miui_version.as_str()) {
        return Err(AppError::invalid("Pick Xiaomi HyperOS (V15) or Xiaomi HyperOS 3 (V17)."));
    }
    if let Some(id) = &product_id {
        check_id(id)?;
    }
    blocking(app, move |state, app| {
        let (data, filename) = match path {
            Some(path) => {
                let path = PathBuf::from(path);
                if !has_extension(&path, "mtz") {
                    return Err(AppError::invalid("The Design Station only accepts .mtz packages."));
                }
                (read_file(&path, MAX_PACKAGE_BYTES, "The package")?, file_name(&path))
            }
            None => {
                let (data, name) = build_package_bytes(state, app)?;
                let name: String = name.chars().filter(|c| !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')).collect();
                (data, format!("{}.mtz", if name.trim().is_empty() { "theme" } else { name.trim() }))
            }
        };
        let mut parts = vec![Part::File { name: "mtzFile", filename, mime: "application/octet-stream", data }];
        let endpoint = match product_id {
            Some(id) => {
                parts.push(Part::Text { name: "productId", value: id });
                "/v3/designers/audits/update-mtz"
            }
            None => "/v3/designers/audits/add-mtz",
        };
        parts.push(Part::Text { name: "miuiVersion", value: miui_version });
        parts.push(Part::Text { name: "productType", value: "THEME".into() });
        let data = post_multipart(app, endpoint, "package", parts)?;
        let audit = PackageAudit {
            audit_id: text(&data, "auditId"),
            product_name: text(&data, "productName"),
            designer_name: text(&data, "designerName"),
            author_name: text(&data, "authorName"),
            version_name: text(&data, "versionName"),
            miui_version: text(&data, "miuiVersion"),
            description: text(&data, "description"),
            file_size: data.get("fileSize").and_then(Value::as_u64).unwrap_or(0),
        };
        if audit.audit_id.is_empty() {
            return Err(AppError::new("designer_http", "The station accepted the package but returned no audit id."));
        }
        Ok(audit)
    })
    .await
}

/// Uploads the preview video and returns the GIF address the station made from it.
#[tauri::command]
pub async fn designer_upload_video(app: AppHandle, path: String) -> AppResult<String> {
    blocking(app, move |_, app| {
        let path = PathBuf::from(path);
        if !has_extension(&path, "mp4") {
            return Err(AppError::invalid("The preview video must be an MP4 file."));
        }
        let data = read_file(&path, MAX_VIDEO_BYTES, "The preview video")?;
        let answer = post_multipart(
            app,
            "/v3/designers/files/dynamic/video_upload",
            "video",
            vec![Part::File { name: "file", filename: file_name(&path), mime: "video/mp4", data }],
        )?;
        answer
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| AppError::new("designer_http", "The station did not return a preview address for the video."))
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyrightFile {
    pub file_id: String,
    pub filename: String,
}

/// The web app keeps `data.fileId` and `data.filename`; older answers used other names.
fn parse_copyright(data: &Value, fallback_name: &str) -> Option<CopyrightFile> {
    let id = ["fileId", "id", "locator", "copyrightLocator", "fileLocator"]
        .iter()
        .find_map(|k| data.get(*k).and_then(|v| v.as_str().map(str::to_string).or_else(|| v.as_i64().map(|n| n.to_string()))))
        .or_else(|| data.as_str().map(str::to_string))?;
    let filename = ["filename", "fileName", "name", "copyrightFilename"]
        .iter()
        .find_map(|k| data.get(*k).and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| fallback_name.to_string());
    Some(CopyrightFile { file_id: id, filename })
}

/// Uploads the proof-of-copyright ZIP.
#[tauri::command]
pub async fn designer_upload_copyright(app: AppHandle, path: String) -> AppResult<CopyrightFile> {
    blocking(app, move |_, app| {
        let path = PathBuf::from(path);
        if !has_extension(&path, "zip") {
            return Err(AppError::invalid("Proof of copyright must be a single .zip file."));
        }
        let data = read_file(&path, MAX_COPYRIGHT_BYTES, "The proof of copyright")?;
        if !crate::package::blob::is_zip_magic(&data) {
            return Err(AppError::invalid("That file is not a ZIP archive."));
        }
        let name = file_name(&path);
        let answer = post_multipart(
            app,
            "/v3/designers/files/copyright",
            "copyright",
            vec![Part::File { name: "copyrightFile", filename: name.clone(), mime: "application/zip", data }],
        )?;
        parse_copyright(&answer, &name).ok_or_else(|| {
            AppError::new("designer_http", format!("The station stored the ZIP but its answer was not understood: {answer}"))
        })
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Submission {
    pub audit_id: String,
    pub product_name: String,
    pub version_name: String,
    pub designer_name: String,
    pub author_name: String,
    pub description: String,
    pub tags: Vec<String>,
    #[serde(default)]
    pub talk_to_us: String,
    pub copyright_locator: String,
    pub copyright_filename: String,
    #[serde(default)]
    pub gif_url: Option<String>,
    #[serde(default)]
    pub price_in_cent: u32,
    /// Set for a new version of a published theme; required then.
    #[serde(default)]
    pub change_log: Option<String>,
}

fn check_submission(s: &Submission) -> AppResult<()> {
    let count = |v: &str| v.chars().count();
    let fail = |m: &str| Err(AppError::invalid(m.to_string()));
    if s.audit_id.trim().is_empty() {
        return fail("Upload the package first.");
    }
    if s.product_name.trim().is_empty() || count(&s.product_name) > 18 {
        return fail("The theme name must be 1–18 characters.");
    }
    if s.version_name.trim().is_empty() {
        return fail("Enter a version.");
    }
    if s.designer_name.trim().is_empty() || count(&s.designer_name) > 20 || s.author_name.trim().is_empty() || count(&s.author_name) > 20 {
        return fail("Designer and author names must be 1–20 characters.");
    }
    if s.description.trim().is_empty() || count(&s.description) > 1000 {
        return fail("The description must be 1–1000 characters.");
    }
    if s.tags.is_empty() || s.tags.len() > 10 {
        return fail("Pick 1–10 tags (the station recommends up to 6).");
    }
    if s.tags.iter().any(|t| t.contains([',', ';']) || count(t) > 20) {
        return fail("Tags can't contain commas or semicolons.");
    }
    if count(&s.talk_to_us) > 1000 {
        return fail("Extra info is limited to 1000 characters.");
    }
    if s.copyright_locator.trim().is_empty() {
        return fail("Upload the proof of copyright first.");
    }
    if s.price_in_cent > 1500 {
        return fail("The price must be between 0 and 15.");
    }
    if let Some(log) = &s.change_log {
        if log.trim().is_empty() || count(log) > 1000 {
            return fail("Describe what changed in this version (up to 1000 characters).");
        }
    }
    Ok(())
}

/// Submits the uploaded package for review.
#[tauri::command]
pub async fn designer_submit(app: AppHandle, submission: Submission) -> AppResult<()> {
    check_submission(&submission)?;
    blocking(app, move |_, app| {
        let s = submission;
        let mut body = serde_json::json!({
            "activityType": "ACTIVITY_NOT_JOIN",
            "auditId": s.audit_id,
            "copyrightLocator": s.copyright_locator,
            "copyrightFilename": s.copyright_filename,
            "description": s.description.trim(),
            "designerName": s.designer_name.trim(),
            "authorName": s.author_name.trim(),
            "priceInCent": s.price_in_cent,
            "productDivideType": "FLOW_DIVIDE",
            "productName": s.product_name.trim(),
            "productType": "THEME",
            "tags": s.tags,
            "talkToUs": s.talk_to_us.trim(),
            "versionName": s.version_name.trim(),
            "gifUrl": s.gif_url.filter(|u| !u.is_empty()),
        });
        if let Some(log) = s.change_log {
            body["changeLog"] = Value::String(log.trim().to_string());
        }
        post_json(app, "/v3/designers/audits/submit-mtz", &body)?;
        Ok(())
    })
    .await
}

// ----- published themes -----------------------------------------------------------

/// Your themes on the station with their latest audit (`audits-and-products`).
#[tauri::command]
pub async fn designer_products(app: AppHandle) -> AppResult<Value> {
    blocking(app, |_, app| get_json(app, "/v3/designers/audits-and-products?productType=THEME&productName=&pageIndex=0&sizeOfPage=100")).await
}

/// One theme: store details, review state, change log, submitted package.
#[tauri::command]
pub async fn designer_product(app: AppHandle, product_id: String) -> AppResult<Value> {
    blocking(app, move |_, app| {
        let id = check_id(&product_id)?;
        get_json(app, &format!("/v3/designers/products/{id}?productType=THEME"))
    })
    .await
}

/// The system versions a theme has packages for.
#[tauri::command]
pub async fn designer_product_versions(app: AppHandle, product_id: String) -> AppResult<Value> {
    blocking(app, move |_, app| {
        let id = check_id(&product_id)?;
        get_json(app, &format!("/v3/designers/products/{id}/miui-versions?productType=THEME"))
    })
    .await
}

// ----- proof of copyright ZIP ----------------------------------------------------

const ART_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofAttribution {
    pub source_title: String,
    pub source_author: String,
    /// Where it was taken from (theme store item, reference file, phone).
    pub origin: String,
    pub files: usize,
    /// The theme's files that came from this source, at their current paths.
    pub paths: Vec<String>,
}

/// Material in the open project that came from other themes, found by content (see
/// `provenance`). Store downloads are indexed first so anything taken from them counts.
/// The designer's own names are left out.
fn third_party(state: &AppState, own_names: &[&str]) -> AppResult<Vec<ProofAttribution>> {
    crate::provenance::scan_downloads(&state.paths.data, &state.paths.data.join("downloads"));
    let guard = lock(&state.main);
    let project = guard.as_ref().ok_or_else(AppError::no_project)?;
    let matches = crate::provenance::find(
        &state.paths.data,
        project.files.iter().map(|(p, b)| (p.as_str(), b.data.as_slice())),
        own_names,
    );
    Ok(matches
        .into_iter()
        .map(|m| ProofAttribution {
            source_title: m.source.title,
            source_author: m.source.author,
            origin: m.source.origin,
            files: m.paths.len(),
            paths: m.paths,
        })
        .collect())
}

fn credit(a: &ProofAttribution) -> String {
    let author = if a.source_author.trim().is_empty() { "an unknown author".to_string() } else { a.source_author.trim().to_string() };
    format!("\"{}\" by {author}", a.source_title.trim())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofInfo {
    pub title: String,
    pub designer: String,
    pub author: String,
    pub version: String,
    pub description: String,
    /// description.xml keywords, used to suggest station tags.
    pub keywords: String,
    pub artwork_files: usize,
    pub artwork_bytes: u64,
    /// Every image of the theme, so the designer can pick what goes into the proof.
    pub artwork: Vec<ProofFile>,
    /// Material from other themes; disclosed in the proof automatically.
    pub attributions: Vec<ProofAttribution>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofFile {
    pub path: String,
    pub size: u64,
}

fn is_art(path: &str) -> bool {
    path.rsplit_once('.').is_some_and(|(_, ext)| ART_EXTENSIONS.iter().any(|a| a.eq_ignore_ascii_case(ext)))
}

/// Theme details and artwork counts for the proof builder.
#[tauri::command]
pub async fn designer_proof_info(app: AppHandle) -> AppResult<ProofInfo> {
    blocking(app, |state, _| {
        let (designer, author) = {
            let guard = lock(&state.main);
            let project = guard.as_ref().ok_or_else(AppError::no_project)?;
            let meta = metadata::parse(project.text(DESCRIPTION_PATH).as_deref());
            let field = |name: &str| meta.fields.iter().find(|f| f.name == name).map(|f| f.value.trim().to_string()).unwrap_or_default();
            (field("designer"), field("author"))
        };
        let attributions = third_party(state, &[&designer, &author])?;
        let guard = lock(&state.main);
        let project = guard.as_ref().ok_or_else(AppError::no_project)?;
        let meta = metadata::parse(project.text(DESCRIPTION_PATH).as_deref());
        let field = |name: &str| meta.fields.iter().find(|f| f.name == name).map(|f| f.value.trim().to_string()).unwrap_or_default();
        let art: Vec<_> = project.files.iter().filter(|(p, _)| is_art(p)).collect();
        Ok(ProofInfo {
            title: Some(field("title")).filter(|t| !t.is_empty()).unwrap_or_else(|| project.title()),
            designer: field("designer"),
            author: field("author"),
            version: field("version"),
            description: field("description"),
            keywords: field("keywords"),
            artwork_files: art.len(),
            artwork_bytes: art.iter().map(|(_, b)| b.data.len() as u64).sum(),
            artwork: art.iter().map(|(p, b)| ProofFile { path: (*p).clone(), size: b.data.len() as u64 }).collect(),
            attributions,
        })
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofRequest {
    /// Where to write the ZIP; the app's publish folder when omitted.
    #[serde(default)]
    pub output: Option<String>,
    pub designer: String,
    pub title: String,
    #[serde(default)]
    pub include_artwork: bool,
    /// Theme images left out of the proof (package paths).
    #[serde(default)]
    pub exclude_artwork: Vec<String>,
    /// Files and folders (PSD, sketches, consent forms, licences, ID photo...) copied in with
    /// their folder structure.
    #[serde(default)]
    pub extra_files: Vec<String>,
    /// Files inside the folders above that are left out (absolute paths).
    #[serde(default)]
    pub exclude_extra: Vec<String>,
    /// Free-licensed material: sources, websites, commercial-use permission.
    #[serde(default)]
    pub sources: String,
    /// The designer supplies the proof themselves: nothing is generated. One ZIP among the
    /// extra files is used as it is; otherwise the files are zipped as they are.
    #[serde(default)]
    pub own_files: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofResult {
    pub path: String,
    pub bytes: u64,
    pub files: usize,
}

/// A file the designer picked, or found inside a folder they picked.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtraEntry {
    /// Absolute path on disk.
    pub path: String,
    /// Where it sits under what was picked: `Folder/sub/file.psd`, or just `file.psd`.
    pub rel: String,
    pub size: u64,
    /// The picked item it belongs to (the folder, or the file itself).
    pub root: String,
}

const MAX_SCAN_ENTRIES: usize = 20_000;

fn walk(dir: &Path, rel: &str, root: &str, out: &mut Vec<ExtraEntry>, depth: u8) {
    if depth > 32 || out.len() >= MAX_SCAN_ENTRIES {
        return;
    }
    let Ok(read) = std::fs::read_dir(dir) else { return };
    let mut items: Vec<_> = read.flatten().collect();
    items.sort_by_key(|e| e.file_name());
    for item in items {
        let Ok(kind) = item.file_type() else { continue };
        if kind.is_symlink() {
            continue;
        }
        let name = item.file_name().to_string_lossy().into_owned();
        let rel = format!("{rel}/{name}");
        if kind.is_dir() {
            walk(&item.path(), &rel, root, out, depth + 1);
        } else if kind.is_file() {
            let size = item.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(ExtraEntry { path: item.path().to_string_lossy().into_owned(), rel, size, root: root.to_string() });
        }
    }
}

/// Files and folders picked by the designer, expanded into the files they contain.
fn scan_extra(paths: &[String]) -> Vec<ExtraEntry> {
    let mut out = Vec::new();
    for raw in paths {
        let path = PathBuf::from(raw);
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        if meta.is_dir() {
            walk(&path, &file_name(&path), raw, &mut out, 0);
        } else if meta.is_file() {
            out.push(ExtraEntry { path: raw.clone(), rel: file_name(&path), size: meta.len(), root: raw.clone() });
        }
    }
    out
}

/// Expands the picked files and folders for the proof's file tree.
#[tauri::command]
pub async fn designer_proof_scan(app: AppHandle, paths: Vec<String>) -> AppResult<Vec<ExtraEntry>> {
    blocking(app, move |_, _| Ok(scan_extra(&paths))).await
}

/// The picked files minus the ones the designer unticked.
fn collect_extra(paths: &[String], exclude: &[String]) -> Vec<ExtraEntry> {
    let skip: std::collections::HashSet<&str> = exclude.iter().map(String::as_str).collect();
    scan_extra(paths).into_iter().filter(|e| !skip.contains(e.path.as_str())).collect()
}

/// Which section of the proof a picked folder belongs in: source files win, then documents.
fn folder_section(entries: &[&ExtraEntry]) -> &'static str {
    let sections: Vec<&str> = entries.iter().map(|e| extra_folder(Path::new(&e.path))).collect();
    if sections.contains(&"source") {
        "source"
    } else if sections.iter().all(|s| *s == "documents") {
        "documents"
    } else {
        "supporting"
    }
}

fn extra_folder(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    match ext.as_str() {
        "psd" | "psb" | "ai" | "fig" | "sketch" | "xd" | "kra" | "procreate" | "clip" | "afdesign" | "afphoto" | "blend" | "c4d" => "source",
        "pdf" | "doc" | "docx" | "txt" | "md" | "rtf" | "odt" | "html" | "htm" => "documents",
        _ => "supporting",
    }
}

fn unique_name(used: &mut std::collections::HashSet<String>, folder: &str, name: &str) -> String {
    let prefix = if folder.is_empty() { String::new() } else { format!("{folder}/") };
    let mut candidate = format!("{prefix}{name}");
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    let mut n = 2;
    while !used.insert(candidate.to_ascii_lowercase()) {
        candidate = format!("{prefix}{stem} ({n}){ext}");
        n += 1;
    }
    candidate
}

fn declaration(req: &ProofRequest, version: &str, stamp: &str, attributions: &[ProofAttribution], has_sources: bool) -> String {
    let mut out = String::new();
    out.push_str("PROOF OF COPYRIGHT\r\n==================\r\n\r\n");
    out.push_str(&format!("Theme:     {}\r\n", req.title.trim()));
    if !version.is_empty() {
        out.push_str(&format!("Version:   {version}\r\n"));
    }
    out.push_str(&format!("Designer:  {}\r\n", req.designer.trim()));
    out.push_str(&format!("Prepared:  {stamp} UTC\r\n\r\n"));
    if attributions.is_empty() {
        out.push_str(&format!(
            "I, {}, declare that I am the author of the theme \"{}\" submitted to the Xiaomi Theme Design Station, \
             or that I hold the rights needed to publish every part of it. Materials I did not create are listed in \
             SOURCES.txt together with where they come from and the permission to use them commercially.\r\n\r\n",
            req.designer.trim(),
            req.title.trim()
        ));
    } else {
        let taken: usize = attributions.iter().map(|a| a.files).sum();
        out.push_str(&format!(
            "I, {}, declare that I am the author of the theme \"{}\" submitted to the Xiaomi Theme Design Station, \
             except for {taken} file(s) taken from other themes, which are disclosed in full in SOURCES.txt (source, author \
             and every affected file). Any other material I did not create is listed there as well, with where it comes \
             from and the permission to use it commercially.\r\n\r\n",
            req.designer.trim(),
            req.title.trim()
        ));
    }
    out.push_str("Contents\r\n--------\r\n");
    out.push_str("  source/      Original working files (layered PSD and similar).\r\n");
    out.push_str("  artwork/     Every image in the theme package at full resolution, at its path in the package.\r\n");
    out.push_str("  documents/   Licences, authorisation forms, consent forms and other documents.\r\n");
    out.push_str("  supporting/  Other evidence (sketches, work-in-progress exports, photos).\r\n");
    out.push_str("  SOURCES.txt  Third-party and free-licensed material.\r\n");
    out.push_str("  MANIFEST.txt Size and SHA-1 of every file in this archive.\r\n\r\n");
    if !attributions.is_empty() || !has_sources {
        out.push_str("Notes\r\n-----\r\n");
        if !attributions.is_empty() {
            out.push_str("  Material from other themes was detected automatically by Mi Theme Studio, by comparing file\r\n  contents, and is disclosed in SOURCES.txt:\r\n");
            for a in attributions {
                out.push_str(&format!("    - {} ({} file{})\r\n", credit(a), a.files, if a.files == 1 { "" } else { "s" }));
            }
        }
        if !has_sources {
            out.push_str("  No third-party material is declared.\r\n");
        }
    }
    out
}

/// The designer's own proof, untouched: a single ZIP is copied as it is, any other files are
/// zipped as they are. No declaration, no sources list, no artwork is added.
fn build_own_proof(files: &[String], exclude: &[String], output: &Path) -> AppResult<ProofResult> {
    if files.is_empty() {
        return Err(AppError::invalid("Add the files that make up your proof of copyright."));
    }
    if let ([only], true) = (files, exclude.is_empty()) {
        let path = PathBuf::from(only);
        if has_extension(&path, "zip") {
            let data = read_file(&path, MAX_COPYRIGHT_BYTES, &file_name(&path))?;
            if !crate::package::blob::is_zip_magic(&data) {
                return Err(AppError::invalid(format!("{} is not a valid ZIP archive.", file_name(&path))));
            }
            let count = zip::ZipArchive::new(Cursor::new(&data)).map(|z| z.len()).unwrap_or(0);
            if !same_file(&path, output) {
                crate::storage::atomic_write(output, &data)?;
            }
            return Ok(ProofResult { path: output.to_string_lossy().into_owned(), bytes: data.len() as u64, files: count });
        }
    }
    let mut used = std::collections::HashSet::new();
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    let mut total = 0u64;
    for extra in collect_extra(files, exclude) {
        let path = PathBuf::from(&extra.path);
        let data = read_file(&path, MAX_PROOF_EXTRA_BYTES, &file_name(&path))?;
        total += data.len() as u64;
        if total > MAX_PROOF_EXTRA_BYTES {
            return Err(AppError::new("limit", "The files are larger than 1 GB together."));
        }
        let name = unique_name(&mut used, "", &extra.rel);
        entries.push((name, data));
    }
    if entries.is_empty() {
        return Err(AppError::invalid("Every file is unticked. Tick at least one file for your proof of copyright."));
    }
    let write: Vec<WriteEntry> = entries.iter().map(|(p, d)| WriteEntry { path: p, data: d, compression: Compression::Deflated }).collect();
    let zip = archive::write_zip(Cursor::new(Vec::new()), &write, |_, _| {})?.into_inner();
    archive::verify_zip(&zip, &write)?;
    crate::storage::atomic_write(output, &zip)?;
    Ok(ProofResult { path: output.to_string_lossy().into_owned(), bytes: zip.len() as u64, files: write.len() })
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Builds the proof-of-copyright ZIP the station asks for.
#[tauri::command]
pub async fn designer_proof_build(app: AppHandle, request: ProofRequest) -> AppResult<ProofResult> {
    blocking(app, move |state, _| {
        let req = request;
        if !req.own_files && (req.title.trim().is_empty() || req.designer.trim().is_empty()) {
            return Err(AppError::invalid("Enter the theme name and the designer name."));
        }
        let output = match req.output.as_deref().filter(|o| !o.trim().is_empty()) {
            Some(o) => PathBuf::from(o),
            None => {
                let safe: String = req.title.chars().filter(|c| !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')).collect();
                let safe = if safe.trim().is_empty() { "theme".to_string() } else { safe };
                let dir = state.paths.data.join("publish");
                std::fs::create_dir_all(&dir).map_err(|e| AppError::io("Could not create the publish folder", e))?;
                dir.join(format!("{} - proof of copyright.zip", safe.trim()))
            }
        };
        if !has_extension(&output, "zip") {
            return Err(AppError::invalid("Save the proof as a .zip file."));
        }
        if req.own_files {
            return build_own_proof(&req.extra_files, &req.exclude_extra, &output);
        }
        let own = {
            let guard = lock(&state.main);
            let project = guard.as_ref().ok_or_else(AppError::no_project)?;
            let meta = metadata::parse(project.text(DESCRIPTION_PATH).as_deref());
            let field = |name: &str| meta.fields.iter().find(|f| f.name == name).map(|f| f.value.trim().to_string()).unwrap_or_default();
            [field("designer"), field("author"), req.designer.trim().to_string()]
        };
        let attributions = third_party(state, &[&own[0], &own[1], &own[2]])?;
        let (artwork, version) = {
            let guard = lock(&state.main);
            let project = guard.as_ref().ok_or_else(AppError::no_project)?;
            let meta = metadata::parse(project.text(DESCRIPTION_PATH).as_deref());
            let version = meta.fields.iter().find(|f| f.name == "version").map(|f| f.value.trim().to_string()).unwrap_or_default();
            let artwork: Vec<(String, Vec<u8>)> = if req.include_artwork {
                project.files.iter().filter(|(p, _)| is_art(p) && !req.exclude_artwork.contains(p)).map(|(p, b)| (p.clone(), b.data.clone())).collect()
            } else {
                Vec::new()
            };
            (artwork, version)
        };

        let mut used = std::collections::HashSet::new();
        let mut entries: Vec<(String, Vec<u8>, Compression)> = Vec::new();
        let mut extra_total = 0u64;
        let extras = collect_extra(&req.extra_files, &req.exclude_extra);
        for extra in &extras {
            let path = PathBuf::from(&extra.path);
            let data = read_file(&path, MAX_PROOF_EXTRA_BYTES, &file_name(&path))?;
            extra_total += data.len() as u64;
            if extra_total > MAX_PROOF_EXTRA_BYTES {
                return Err(AppError::new("limit", "The added files are larger than 1 GB together."));
            }
            let section = if extra.rel.contains('/') {
                let family: Vec<&ExtraEntry> = extras.iter().filter(|e| e.root == extra.root).collect();
                folder_section(&family)
            } else {
                extra_folder(&path)
            };
            let name = unique_name(&mut used, section, &extra.rel);
            entries.push((name, data, Compression::Deflated));
        }
        for (path, data) in artwork {
            let name = unique_name(&mut used, "artwork", &path);
            // Images are already compressed.
            entries.push((name, data, Compression::Stored));
        }

        let stamp_ms = crate::storage::now_ms();
        let stamp = {
            let s = crate::storage::utc_stamp(stamp_ms);
            format!("{}-{}-{} {}:{}:{}", &s[0..4], &s[4..6], &s[6..8], &s[9..11], &s[11..13], &s[13..15])
        };
        let mut sources = String::from("THIRD-PARTY AND FREE-LICENSED MATERIAL\r\n======================================\r\n\r\n");
        if req.sources.trim().is_empty() && attributions.is_empty() {
            sources.push_str("None. Every element of this theme was created by the designer.\r\n");
        } else {
            if !req.sources.trim().is_empty() {
                sources.push_str(&req.sources.trim().replace("\r\n", "\n").replace('\n', "\r\n"));
                sources.push_str("\r\n\r\n");
            }
            if !attributions.is_empty() {
                sources.push_str("MATERIAL FROM OTHER THEMES\r\n--------------------------\r\n");
                sources.push_str("Detected automatically by Mi Theme Studio by comparing file contents with the themes it was\r\ntaken from. Every affected file of this theme is listed at its path in the package.\r\n\r\n");
                for a in &attributions {
                    sources.push_str(&format!("{}\r\n", credit(a)));
                    if !a.origin.trim().is_empty() {
                        sources.push_str(&format!("  Taken from: {}\r\n", a.origin.trim()));
                    }
                    sources.push_str(&format!("  Files ({}):\r\n", a.files));
                    for path in &a.paths {
                        sources.push_str(&format!("    {path}\r\n"));
                    }
                    sources.push_str("\r\n");
                }
            }
        }
        let readme = declaration(&req, &version, &stamp, &attributions, !req.sources.trim().is_empty() || !attributions.is_empty());
        entries.insert(0, ("SOURCES.txt".into(), sources.into_bytes(), Compression::Deflated));
        entries.insert(0, ("README - Copyright declaration.txt".into(), readme.into_bytes(), Compression::Deflated));

        let mut manifest = format!("MANIFEST  ({stamp} UTC)\r\nsize_bytes  sha1  path\r\n");
        for (name, data, _) in &entries {
            manifest.push_str(&format!("{}  {}  {}\r\n", data.len(), sha1_smol::Sha1::from(data).digest(), name));
        }
        entries.push(("MANIFEST.txt".into(), manifest.into_bytes(), Compression::Deflated));

        let write: Vec<WriteEntry> = entries.iter().map(|(p, d, c)| WriteEntry { path: p, data: d, compression: *c }).collect();
        let zip = archive::write_zip(Cursor::new(Vec::new()), &write, |_, _| {})?.into_inner();
        archive::verify_zip(&zip, &write)?;
        crate::storage::atomic_write(&output, &zip)?;
        Ok(ProofResult { path: output.to_string_lossy().into_owned(), bytes: zip.len() as u64, files: write.len() })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copyright_answer_shapes() {
        let a = parse_copyright(&serde_json::json!({"fileId": "abc", "filename": "proof.zip"}), "x.zip").unwrap();
        assert_eq!((a.file_id.as_str(), a.filename.as_str()), ("abc", "proof.zip"));
        let b = parse_copyright(&serde_json::json!("ThemeMarket/123"), "x.zip").unwrap();
        assert_eq!((b.file_id.as_str(), b.filename.as_str()), ("ThemeMarket/123", "x.zip"));
        assert!(parse_copyright(&serde_json::json!({}), "x.zip").is_none());
    }

    #[test]
    fn multipart_layout() {
        let (ct, body) = multipart_body(vec![
            Part::File { name: "mtzFile", filename: "a\"b.mtz".into(), mime: "application/octet-stream", data: b"PK".to_vec() },
            Part::Text { name: "productType", value: "THEME".into() },
        ]);
        let boundary = ct.split("boundary=").nth(1).unwrap();
        let text = String::from_utf8(body).unwrap();
        assert!(text.starts_with(&format!("--{boundary}\r\nContent-Disposition: form-data; name=\"mtzFile\"; filename=\"a_b.mtz\"\r\n")));
        assert!(text.contains("name=\"productType\"\r\n\r\nTHEME\r\n"));
        assert!(text.ends_with(&format!("--{boundary}--\r\n")));
    }

    #[test]
    fn unique_names_and_folders() {
        let mut used = std::collections::HashSet::new();
        assert_eq!(unique_name(&mut used, "source", "a.psd"), "source/a.psd");
        assert_eq!(unique_name(&mut used, "source", "A.psd"), "source/A (2).psd");
        assert_eq!(extra_folder(Path::new("x/Lock.PSD")), "source");
        assert_eq!(extra_folder(Path::new("consent.pdf")), "documents");
        assert_eq!(extra_folder(Path::new("me.jpg")), "supporting");
    }

    #[test]
    fn own_proof_is_used_as_given() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.txt");
        let b = dir.path().join("b.pdf");
        std::fs::write(&a, b"consent").unwrap();
        std::fs::write(&b, b"licence").unwrap();
        // Loose files are zipped as they are: no declaration, sources list or manifest.
        let out = dir.path().join("out.zip");
        let r = build_own_proof(&[a.to_string_lossy().into(), b.to_string_lossy().into()], &[], &out).unwrap();
        assert_eq!(r.files, 2);
        let names: Vec<String> = {
            let mut z = zip::ZipArchive::new(std::fs::File::open(&out).unwrap()).unwrap();
            (0..z.len()).map(|i| z.by_index(i).unwrap().name().unwrap().into_owned()).collect()
        };
        assert_eq!(names, vec!["a.txt", "b.pdf"]);
        // A single ZIP is copied byte for byte.
        let copy = dir.path().join("copy.zip");
        build_own_proof(&[out.to_string_lossy().into()], &[], &copy).unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), std::fs::read(&copy).unwrap());
        assert!(build_own_proof(&[], &[], &copy).is_err());

        // Folders keep their structure; unticked files are left out.
        let folder = dir.path().join("Docs");
        std::fs::create_dir_all(folder.join("sub")).unwrap();
        std::fs::write(folder.join("one.txt"), b"1").unwrap();
        std::fs::write(folder.join("sub").join("two.txt"), b"2").unwrap();
        std::fs::write(folder.join("skip.txt"), b"3").unwrap();
        let tree = dir.path().join("tree.zip");
        let roots = [folder.to_string_lossy().into_owned()];
        let skip = [folder.join("skip.txt").to_string_lossy().into_owned()];
        build_own_proof(&roots, &skip, &tree).unwrap();
        let mut names: Vec<String> = {
            let mut z = zip::ZipArchive::new(std::fs::File::open(&tree).unwrap()).unwrap();
            (0..z.len()).map(|i| z.by_index(i).unwrap().name().unwrap().into_owned()).collect()
        };
        names.sort();
        assert_eq!(names, vec!["Docs/one.txt", "Docs/sub/two.txt"]);
        assert_eq!(scan_extra(&roots).len(), 3);
        assert_eq!(folder_section(&scan_extra(&roots).iter().collect::<Vec<_>>()), "documents");
    }

    #[test]
    fn submission_limits() {
        let mut s = Submission {
            audit_id: "id".into(),
            product_name: "Vagabond".into(),
            version_name: "1.0".into(),
            designer_name: "Jx".into(),
            author_name: "Jx".into(),
            description: "Miyamoto Musashi".into(),
            tags: vec!["Cool".into()],
            talk_to_us: String::new(),
            copyright_locator: "f".into(),
            copyright_filename: "p.zip".into(),
            gif_url: None,
            price_in_cent: 0,
            change_log: None,
        };
        assert!(check_submission(&s).is_ok());
        s.product_name = "x".repeat(19);
        assert!(check_submission(&s).is_err());
        s.product_name = "ok".into();
        s.copyright_locator.clear();
        assert!(check_submission(&s).is_err());
    }
}
