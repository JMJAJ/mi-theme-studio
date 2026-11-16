//! Live screen mirroring with the bundled scrcpy (Apache-2.0,
//! https://github.com/Genymobile/scrcpy). scrcpy opens its own window; the
//! app starts it for the selected device, using the same adb binary as the
//! rest of the app so two adb server versions never fight.

use super::{valid_serial, AdbLogEntry, Logger};
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub struct Mirror {
    pub serial: String,
    pub started_ms: u64,
    child: Child,
}

impl Drop for Mirror {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorStatus {
    pub available: bool,
    pub running: bool,
    pub serial: Option<String>,
    pub started_ms: Option<u64>,
    pub version: Option<String>,
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "scrcpy.exe"
    } else {
        "scrcpy"
    }
}

/// The bundled scrcpy, if the installer (or `npm run fetch:scrcpy`) put it there.
pub fn bundled(resource_dir: &Path) -> Option<PathBuf> {
    let path = resource_dir.join("scrcpy").join(exe_name());
    path.is_file().then_some(path)
}

pub fn bundled_version(resource_dir: &Path) -> Option<String> {
    std::fs::read_to_string(resource_dir.join("scrcpy").join("VERSION")).ok().map(|v| v.trim().to_string())
}

pub fn arguments(serial: &str, title: &str) -> Vec<String> {
    vec![
        "--serial".into(),
        serial.into(),
        "--window-title".into(),
        title.into(),
        "--stay-awake".into(),
        "--no-audio".into(),
        "--max-fps".into(),
        "60".into(),
    ]
}

fn log_line(log: &Logger, line: &str, ok: bool) {
    log(AdbLogEntry {
        id: super::NEXT_LOG_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        at_ms: crate::storage::now_ms(),
        command: "scrcpy".into(),
        code: None,
        duration_ms: 0,
        ok,
        summary: line.chars().take(300).collect(),
    });
}

pub fn start(scrcpy: &Path, adb: &Path, serial: &str, title: &str, log: Logger) -> AppResult<Mirror> {
    valid_serial(serial)?;
    let safe_title: String = title.chars().filter(|c| !c.is_control()).take(80).collect();
    let mut command = Command::new(scrcpy);
    command
        .args(arguments(serial, &safe_title))
        .env("ADB", adb)
        .current_dir(scrcpy.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|e| AppError::new("mirror", format!("scrcpy could not be started: {e}")))?;
    let errors = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    for stream in [child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>)]
        .into_iter()
        .flatten()
    {
        let log = log.clone();
        let errors = errors.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                let line = line.trim().to_string();
                if line.is_empty() {
                    continue;
                }
                let bad = line.starts_with("ERROR") || line.contains("error:");
                if bad {
                    if let Ok(mut e) = errors.lock() {
                        e.push(line.clone());
                    }
                }
                log_line(&log, &line, !bad);
            }
        });
    }
    // scrcpy fails fast (no device, server push failed); wait briefly for that.
    let deadline = Instant::now() + Duration::from_millis(2500);
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            std::thread::sleep(Duration::from_millis(100));
            let detail = errors.lock().map(|e| e.join(" ")).unwrap_or_default();
            return Err(AppError::new(
                "mirror",
                if detail.is_empty() { format!("scrcpy exited ({status}).") } else { format!("scrcpy exited: {detail}") },
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(Mirror { serial: serial.to_string(), started_ms: crate::storage::now_ms(), child })
}

impl Mirror {
    pub fn running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_are_fixed_and_serial_checked() {
        let args = arguments("595e1e14", "Mi Theme Studio");
        assert_eq!(&args[..2], &["--serial".to_string(), "595e1e14".to_string()]);
        assert!(args.contains(&"--no-audio".to_string()));
        let log: Logger = std::sync::Arc::new(|_| {});
        assert!(start(Path::new("scrcpy.exe"), Path::new("adb.exe"), "a;rm", "t", log).is_err());
    }
}

/// `MTS_ADB=<adb.exe> MTS_SERIAL=<serial> cargo test mirror::live -- --ignored --nocapture`
#[cfg(test)]
mod live {
    use super::*;

    #[test]
    #[ignore]
    fn mirrors_for_a_few_seconds() {
        let (Ok(adb), Ok(serial)) = (std::env::var("MTS_ADB"), std::env::var("MTS_SERIAL")) else { return };
        let resources = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
        let scrcpy = bundled(&resources).expect("run npm run fetch:scrcpy first");
        let log: Logger = std::sync::Arc::new(|e: AdbLogEntry| println!("  [{}] {}", if e.ok { "ok" } else { "!!" }, e.summary));
        let mut mirror = start(&scrcpy, Path::new(&adb), &serial, "Mi Theme Studio test", log).unwrap();
        std::thread::sleep(Duration::from_secs(4));
        assert!(mirror.running(), "scrcpy kept running");
        drop(mirror);
        println!("mirror started and stopped");
    }
}
