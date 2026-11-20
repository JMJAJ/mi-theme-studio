//! Runs external processes with a timeout and cooperative cancellation.
//! Output pipes are drained on background threads so a chatty process can
//! never dead-lock on a full pipe buffer.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunError {
    Spawn(String),
    Timeout,
    Cancelled,
    OutputTooLarge,
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RunError::Spawn(e) => write!(f, "could not start the process: {e}"),
            RunError::Timeout => write!(f, "the command timed out"),
            RunError::Cancelled => write!(f, "the command was cancelled"),
            RunError::OutputTooLarge => write!(f, "the command produced too much output"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct RunOutput {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub duration: Duration,
    pub truncated: bool,
}

impl RunOutput {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }
    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
    pub fn stderr_text(&self) -> String {
        String::from_utf8_lossy(&self.stderr).trim().to_string()
    }
}

pub const MAX_OUTPUT: usize = 64 * 1024 * 1024;

struct Sink {
    buffer: Vec<u8>,
    overflow: bool,
    done: bool,
}

type SharedSink = Arc<Mutex<Sink>>;

fn drain(mut reader: impl Read + Send + 'static, limit: usize) -> SharedSink {
    let sink = Arc::new(Mutex::new(Sink {
        buffer: Vec::new(),
        overflow: false,
        done: false,
    }));
    let shared = sink.clone();
    thread::spawn(move || {
        let mut chunk = [0u8; 64 * 1024];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut sink = shared.lock().unwrap_or_else(|e| e.into_inner());
                    if sink.buffer.len() + n > limit {
                        // Keep draining so the child can exit.
                        sink.overflow = true;
                    } else {
                        sink.buffer.extend_from_slice(&chunk[..n]);
                    }
                }
            }
        }
        shared.lock().unwrap_or_else(|e| e.into_inner()).done = true;
    });
    sink
}

/// Collect a reader's output. A background process started by the child
/// (for example the adb server daemon) can inherit and hold the pipe open,
/// so only wait a short grace period after the child itself has exited.
fn collect(sink: &SharedSink, grace: Duration) -> (Vec<u8>, bool) {
    let deadline = Instant::now() + grace;
    loop {
        {
            let mut guard = sink.lock().unwrap_or_else(|e| e.into_inner());
            if guard.done || Instant::now() >= deadline {
                return (std::mem::take(&mut guard.buffer), guard.overflow);
            }
        }
        thread::sleep(Duration::from_millis(10));
    }
}

pub fn run(
    program: &Path,
    args: &[&str],
    timeout: Duration,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<RunOutput, RunError> {
    run_inner(program, args, None, timeout, cancel, MAX_OUTPUT, 1024 * 1024, true, false)
}

/// Run a PowerShell (Windows) or POSIX shell (macOS/Linux) command in a chosen folder.
/// Output is capped but returned with a truncation flag instead of failing the command.
pub fn run_shell(
    command: &str,
    directory: &Path,
    timeout: Duration,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<RunOutput, RunError> {
    #[cfg(windows)]
    {
        let shell = Path::new("powershell.exe");
        let args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command];
        run_inner(shell, &args, Some(directory), timeout, cancel, 1024 * 1024, 256 * 1024, false, true)
    }
    #[cfg(not(windows))]
    {
        let shell = Path::new("/bin/sh");
        let args = ["-c", command];
        run_inner(shell, &args, Some(directory), timeout, cancel, 1024 * 1024, 256 * 1024, false, true)
    }
}

fn run_inner(
    program: &Path,
    args: &[&str],
    directory: Option<&Path>,
    timeout: Duration,
    cancel: Option<Arc<AtomicBool>>,
    stdout_limit: usize,
    stderr_limit: usize,
    reject_overflow: bool,
    kill_tree: bool,
) -> Result<RunOutput, RunError> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(directory) = directory {
        command.current_dir(directory);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let started = Instant::now();
    let mut child = command
        .spawn()
        .map_err(|e| RunError::Spawn(e.to_string()))?;
    let stdout = drain(child.stdout.take().expect("piped stdout"), stdout_limit);
    let stderr = drain(child.stderr.take().expect("piped stderr"), stderr_limit);
    let outcome = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status.code()),
            Ok(None) => {}
            Err(e) => break Err(RunError::Spawn(e.to_string())),
        }
        if cancel.as_ref().is_some_and(|c| c.load(Ordering::Relaxed)) {
            terminate(&mut child, kill_tree);
            break Err(RunError::Cancelled);
        }
        if started.elapsed() >= timeout {
            terminate(&mut child, kill_tree);
            break Err(RunError::Timeout);
        }
        thread::sleep(Duration::from_millis(15));
    };
    // Killing the direct child may leave a forked adb server holding the
    // pipes; do not block on the readers in error cases.
    let code = match outcome {
        Ok(code) => code,
        Err(error) => return Err(error),
    };
    let (stdout, overflow) = collect(&stdout, Duration::from_millis(1500));
    let (stderr, stderr_overflow) = collect(&stderr, Duration::from_millis(300));
    let truncated = overflow || stderr_overflow;
    if truncated && reject_overflow {
        return Err(RunError::OutputTooLarge);
    }
    Ok(RunOutput {
        code,
        stdout,
        stderr,
        duration: started.elapsed(),
        truncated,
    })
}

fn terminate(child: &mut std::process::Child, kill_tree: bool) {
    #[cfg(windows)]
    if kill_tree {
        use std::os::windows::process::CommandExt;
        let mut taskkill_path = std::env::var_os("SystemRoot")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from("C:\\Windows"));
        taskkill_path.push("System32");
        taskkill_path.push("taskkill.exe");
        let mut taskkill = Command::new(taskkill_path);
        taskkill
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x0800_0000);
        let _ = taskkill.status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn cmd() -> PathBuf {
        PathBuf::from(
            std::env::var("ComSpec").unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".into()),
        )
    }

    #[test]
    fn captures_output_and_exit_code() {
        let out = run(
            &cmd(),
            &["/C", "echo hello&& exit 3"],
            Duration::from_secs(10),
            None,
        )
        .unwrap();
        assert_eq!(out.code, Some(3));
        assert!(out.stdout_text().contains("hello"));
    }

    #[test]
    fn times_out() {
        let started = Instant::now();
        let error = run(
            &cmd(),
            &["/C", "ping -n 30 127.0.0.1 > NUL"],
            Duration::from_millis(300),
            None,
        )
        .unwrap_err();
        assert_eq!(error, RunError::Timeout);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn can_be_cancelled() {
        let flag = Arc::new(AtomicBool::new(false));
        let setter = flag.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(200));
            setter.store(true, Ordering::Relaxed);
        });
        let error = run(
            &cmd(),
            &["/C", "ping -n 30 127.0.0.1 > NUL"],
            Duration::from_secs(20),
            Some(flag),
        )
        .unwrap_err();
        assert_eq!(error, RunError::Cancelled);
    }

    #[test]
    fn reports_missing_program() {
        let error = run(
            Path::new("C:\\definitely\\missing\\adb.exe"),
            &[],
            Duration::from_secs(1),
            None,
        )
        .unwrap_err();
        assert!(matches!(error, RunError::Spawn(_)));
    }
}
