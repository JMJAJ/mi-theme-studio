//! In-app screen mirroring: runs the bundled scrcpy server on the phone and
//! forwards its H.264 stream to the UI (decoded there with WebCodecs), and
//! sends touch, scroll and key input back. Same protocol as scrcpy 3.3.1
//! (https://github.com/Genymobile/scrcpy, Apache-2.0); the server version
//! must match the bundled `scrcpy-server` exactly.

use super::{valid_serial, AdbLogEntry, Logger};
use crate::error::{AppError, AppResult};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const SERVER_VERSION: &str = "3.3.1";
const DEVICE_SERVER_PATH: &str = "/data/local/tmp/mts-scrcpy-server.jar";

/// Messages sent to the UI over the binary channel.
pub const MSG_META: u8 = 1; // [1][w u32][h u32][device name utf-8]
pub const MSG_PACKET: u8 = 2; // [2][flags u8][pts u64][annex-b data]
pub const MSG_END: u8 = 3; // [3][reason utf-8]
pub const FLAG_CONFIG: u8 = 1;
pub const FLAG_KEY: u8 = 2;

const PACKET_FLAG_CONFIG: u64 = 1 << 63;
const PACKET_FLAG_KEY_FRAME: u64 = 1 << 62;
const PTS_MASK: u64 = PACKET_FLAG_KEY_FRAME - 1;
const MAX_PACKET: usize = 16 * 1024 * 1024;

pub struct Stream {
    pub serial: String,
    pub width: u32,
    pub height: u32,
    stop: Arc<AtomicBool>,
    control: Arc<Mutex<TcpStream>>,
    video: TcpStream,
    server: Child,
    adb: PathBuf,
    port: u16,
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.video.shutdown(Shutdown::Both);
        if let Ok(c) = self.control.lock() {
            let _ = c.shutdown(Shutdown::Both);
        }
        let _ = self.server.kill();
        let _ = self.server.wait();
        let _ = hidden(&self.adb)
            .args(["-s", &self.serial, "forward", "--remove", &format!("tcp:{}", self.port)])
            .output();
    }
}

fn hidden(program: &Path) -> Command {
    let mut command = Command::new(program);
    command.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

fn log_line(log: &Logger, command: &str, line: &str, ok: bool) {
    log(AdbLogEntry {
        id: super::NEXT_LOG_ID.fetch_add(1, Ordering::Relaxed),
        at_ms: crate::storage::now_ms(),
        command: command.into(),
        code: None,
        duration_ms: 0,
        ok,
        summary: line.chars().take(300).collect(),
    });
}

fn run(adb: &Path, args: &[&str], what: &str) -> AppResult<String> {
    let out = hidden(adb)
        .args(args)
        .output()
        .map_err(|e| AppError::new("mirror", format!("{what}: {e}")))?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(AppError::new("mirror", format!("{what} failed: {msg}")));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn free_port() -> AppResult<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| AppError::new("mirror", format!("No free local port: {e}")))?;
    Ok(listener.local_addr().map_err(|e| AppError::new("mirror", e.to_string()))?.port())
}

fn read_exact(stream: &mut TcpStream, buf: &mut [u8]) -> std::io::Result<()> {
    stream.read_exact(buf)
}

/// Connect through the adb forward. adb accepts the TCP connection even
/// before the server listens, so a connection only counts once the server's
/// dummy byte arrives.
fn connect_video(port: u16, deadline: Instant) -> AppResult<TcpStream> {
    loop {
        if let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)) {
            let _ = s.set_read_timeout(Some(Duration::from_millis(1500)));
            let mut byte = [0u8; 1];
            if s.read_exact(&mut byte).is_ok() {
                let _ = s.set_read_timeout(None);
                let _ = s.set_nodelay(true);
                return Ok(s);
            }
        }
        if Instant::now() > deadline {
            return Err(AppError::new("mirror", "The phone did not start the mirror server. Check the ADB log."));
        }
        std::thread::sleep(Duration::from_millis(120));
    }
}

pub struct StartOptions<'a> {
    pub adb: &'a Path,
    pub server_jar: &'a Path,
    pub serial: &'a str,
    /// Longest video side in pixels.
    pub max_size: u32,
    pub log: Logger,
}

/// Start mirroring. `on_message` receives MSG_* binary messages until the
/// stream ends.
pub fn start(opts: StartOptions, on_message: impl Fn(Vec<u8>) + Send + 'static) -> AppResult<Stream> {
    valid_serial(opts.serial)?;
    let adb = opts.adb;
    let serial = opts.serial;
    let jar = opts.server_jar.to_string_lossy().into_owned();
    run(adb, &["-s", serial, "push", &jar, DEVICE_SERVER_PATH], "Copy the mirror server to the phone")?;

    let scid = format!("{:08x}", (crate::storage::now_ms() as u32 ^ std::process::id().rotate_left(13)) & 0x7fff_ffff);
    let port = free_port()?;
    run(adb, &["-s", serial, "forward", &format!("tcp:{port}"), &format!("localabstract:scrcpy_{scid}")], "Open the mirror tunnel")?;

    let max_size = opts.max_size.clamp(320, 4096).to_string();
    let server_cmd = format!(
        "CLASSPATH={DEVICE_SERVER_PATH} app_process / com.genymobile.scrcpy.Server {SERVER_VERSION} scid={scid} log_level=info \
         tunnel_forward=true audio=false control=true video_codec=h264 max_size={max_size} max_fps=60 \
         video_bit_rate=8000000 send_device_meta=true send_frame_meta=true send_dummy_byte=true cleanup=true stay_awake=true"
    );
    let mut server = hidden(adb)
        .args(["-s", serial, "shell", &server_cmd])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::new("mirror", format!("Could not start the mirror server: {e}")))?;
    for out in [server.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>), server.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>)]
        .into_iter()
        .flatten()
    {
        let log = opts.log.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let line = line.trim().to_string();
                if !line.is_empty() {
                    let bad = line.contains("ERROR") || line.contains("Exception");
                    log_line(&log, "mirror server", &line, !bad);
                }
            }
        });
    }

    let cleanup_forward = |adb: &Path| {
        let _ = hidden(adb).args(["-s", serial, "forward", "--remove", &format!("tcp:{port}")]).output();
    };
    let mut video = match connect_video(port, Instant::now() + Duration::from_secs(8)) {
        Ok(v) => v,
        Err(e) => {
            let _ = server.kill();
            cleanup_forward(adb);
            return Err(e);
        }
    };
    let control = match TcpStream::connect(("127.0.0.1", port)) {
        Ok(c) => {
            let _ = c.set_nodelay(true);
            c
        }
        Err(e) => {
            let _ = server.kill();
            cleanup_forward(adb);
            return Err(AppError::new("mirror", format!("Could not open the control channel: {e}")));
        }
    };

    // Device name (64 bytes, NUL padded), then codec id, width, height.
    let mut name = [0u8; 64];
    let mut meta = [0u8; 12];
    let header = read_exact(&mut video, &mut name).and_then(|_| read_exact(&mut video, &mut meta));
    if let Err(e) = header {
        let _ = server.kill();
        cleanup_forward(adb);
        return Err(AppError::new("mirror", format!("The mirror stream ended early: {e}")));
    }
    let codec = u32::from_be_bytes(meta[0..4].try_into().unwrap());
    if codec != u32::from_be_bytes(*b"h264") {
        let _ = server.kill();
        cleanup_forward(adb);
        return Err(AppError::new("mirror", format!("Unexpected video codec 0x{codec:08x}.")));
    }
    let width = u32::from_be_bytes(meta[4..8].try_into().unwrap());
    let height = u32::from_be_bytes(meta[8..12].try_into().unwrap());
    let device_name = String::from_utf8_lossy(&name).trim_end_matches('\0').to_string();
    log_line(&opts.log, "mirror", &format!("Streaming {device_name} at {width}×{height}"), true);

    let mut first = vec![MSG_META];
    first.extend_from_slice(&width.to_be_bytes());
    first.extend_from_slice(&height.to_be_bytes());
    first.extend_from_slice(device_name.as_bytes());
    on_message(first);

    let stop = Arc::new(AtomicBool::new(false));
    // Video reader.
    {
        let stop = stop.clone();
        let mut reader = video.try_clone().map_err(|e| AppError::new("mirror", e.to_string()))?;
        std::thread::spawn(move || {
            let mut head = [0u8; 12];
            let reason = loop {
                if stop.load(Ordering::SeqCst) {
                    break "stopped".to_string();
                }
                if let Err(e) = reader.read_exact(&mut head) {
                    break format!("stream closed ({e})");
                }
                let pts_flags = u64::from_be_bytes(head[0..8].try_into().unwrap());
                let len = u32::from_be_bytes(head[8..12].try_into().unwrap()) as usize;
                if len == 0 || len > MAX_PACKET {
                    break format!("invalid packet size {len}");
                }
                let mut msg = Vec::with_capacity(len + 10);
                msg.push(MSG_PACKET);
                let mut flags = 0u8;
                if pts_flags & PACKET_FLAG_CONFIG != 0 {
                    flags |= FLAG_CONFIG;
                }
                if pts_flags & PACKET_FLAG_KEY_FRAME != 0 {
                    flags |= FLAG_KEY;
                }
                msg.push(flags);
                msg.extend_from_slice(&(pts_flags & PTS_MASK).to_be_bytes());
                let start = msg.len();
                msg.resize(start + len, 0);
                if let Err(e) = reader.read_exact(&mut msg[start..]) {
                    break format!("stream closed ({e})");
                }
                on_message(msg);
            };
            let mut end = vec![MSG_END];
            end.extend_from_slice(reason.as_bytes());
            on_message(end);
        });
    }
    // Drain device messages (clipboard etc.) so the server never blocks.
    {
        let stop = stop.clone();
        let mut reader = control.try_clone().map_err(|e| AppError::new("mirror", e.to_string()))?;
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while !stop.load(Ordering::SeqCst) {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        });
    }

    Ok(Stream {
        serial: serial.to_string(),
        width,
        height,
        stop,
        control: Arc::new(Mutex::new(control)),
        video,
        server,
        adb: adb.to_path_buf(),
        port,
    })
}

// ----- control messages (scrcpy 3.x wire format, big endian) --------------------

pub const ACTION_DOWN: u8 = 0;
pub const ACTION_UP: u8 = 1;
pub const ACTION_MOVE: u8 = 2;
const POINTER_ID_GENERIC_FINGER: u64 = (-2i64) as u64;

pub fn touch_message(action: u8, x: i32, y: i32, width: u16, height: u16) -> Vec<u8> {
    let mut m = Vec::with_capacity(32);
    m.push(2); // INJECT_TOUCH_EVENT
    m.push(action);
    m.extend_from_slice(&POINTER_ID_GENERIC_FINGER.to_be_bytes());
    m.extend_from_slice(&x.to_be_bytes());
    m.extend_from_slice(&y.to_be_bytes());
    m.extend_from_slice(&width.to_be_bytes());
    m.extend_from_slice(&height.to_be_bytes());
    let pressure: u16 = if action == ACTION_UP { 0 } else { 0xffff };
    m.extend_from_slice(&pressure.to_be_bytes());
    m.extend_from_slice(&0i32.to_be_bytes()); // action button
    m.extend_from_slice(&0i32.to_be_bytes()); // buttons
    m
}

/// `vscroll`/`hscroll` in wheel notches, clamped to [-16, 16].
pub fn scroll_message(x: i32, y: i32, width: u16, height: u16, hscroll: f32, vscroll: f32) -> Vec<u8> {
    let fixed = |v: f32| -> i16 {
        let norm = (v / 16.0).clamp(-1.0, 1.0);
        ((norm * 32768.0) as i32).clamp(i16::MIN as i32, i16::MAX as i32) as i16
    };
    let mut m = Vec::with_capacity(21);
    m.push(3); // INJECT_SCROLL_EVENT
    m.extend_from_slice(&x.to_be_bytes());
    m.extend_from_slice(&y.to_be_bytes());
    m.extend_from_slice(&width.to_be_bytes());
    m.extend_from_slice(&height.to_be_bytes());
    m.extend_from_slice(&fixed(hscroll).to_be_bytes());
    m.extend_from_slice(&fixed(vscroll).to_be_bytes());
    m.extend_from_slice(&0i32.to_be_bytes());
    m
}

pub fn key_message(action: u8, keycode: i32) -> Vec<u8> {
    let mut m = Vec::with_capacity(14);
    m.push(0); // INJECT_KEYCODE
    m.push(action);
    m.extend_from_slice(&keycode.to_be_bytes());
    m.extend_from_slice(&0i32.to_be_bytes()); // repeat
    m.extend_from_slice(&0i32.to_be_bytes()); // meta state
    m
}

/// Back, or turn the screen on when it is off.
pub fn back_message(action: u8) -> Vec<u8> {
    vec![4, action]
}

impl Stream {
    pub fn send(&self, message: &[u8]) -> AppResult<()> {
        let mut control = self.control.lock().map_err(|_| AppError::new("mirror", "Control channel unavailable."))?;
        control
            .write_all(message)
            .map_err(|e| AppError::new("mirror", format!("The phone stopped accepting input: {e}")))
    }

    pub fn alive(&self) -> bool {
        !self.stop.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_messages_match_the_wire_format() {
        let t = touch_message(ACTION_DOWN, 100, 200, 593, 1280);
        assert_eq!(t.len(), 32);
        assert_eq!(&t[0..2], &[2, 0]);
        assert_eq!(&t[2..10], &[0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe]);
        assert_eq!(&t[10..14], &100i32.to_be_bytes());
        assert_eq!(&t[18..20], &593u16.to_be_bytes());
        assert_eq!(&t[22..24], &[0xff, 0xff]);
        assert_eq!(&touch_message(ACTION_UP, 0, 0, 1, 1)[22..24], &[0, 0]);
        let s = scroll_message(1, 2, 3, 4, 0.0, -1.0);
        assert_eq!(s.len(), 21);
        assert_eq!(i16::from_be_bytes([s[15], s[16]]), -2048);
        assert_eq!(key_message(ACTION_DOWN, 3).len(), 14);
        assert_eq!(back_message(ACTION_UP), vec![4, 1]);
    }
}

/// `MTS_ADB=<adb.exe> MTS_SERIAL=<serial> cargo test stream::live -- --ignored --nocapture`
#[cfg(test)]
mod live {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    #[ignore]
    fn streams_video_from_the_phone() {
        let (Ok(adb), Ok(serial)) = (std::env::var("MTS_ADB"), std::env::var("MTS_SERIAL")) else { return };
        let jar = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/scrcpy/scrcpy-server");
        let packets = Arc::new(AtomicUsize::new(0));
        let first = Arc::new(Mutex::new(None::<Vec<u8>>));
        let (p, f) = (packets.clone(), first.clone());
        let log: Logger = Arc::new(|e: AdbLogEntry| println!("  [{}] {}", e.command, e.summary));
        let stream = start(
            StartOptions { adb: Path::new(&adb), server_jar: &jar, serial: &serial, max_size: 1280, log },
            move |m| {
                if m[0] == MSG_PACKET {
                    if p.fetch_add(1, Ordering::SeqCst) == 0 {
                        *f.lock().unwrap() = Some(m.clone());
                    }
                }
            },
        )
        .unwrap();
        println!("size {}x{}", stream.width, stream.height);
        std::thread::sleep(Duration::from_secs(3));
        stream.send(&key_message(ACTION_DOWN, 3)).unwrap();
        stream.send(&key_message(ACTION_UP, 3)).unwrap();
        std::thread::sleep(Duration::from_millis(800));
        let n = packets.load(Ordering::SeqCst);
        let first = first.lock().unwrap().clone().unwrap();
        println!("packets {n}; first flags {} len {}; sps byte {:02x?}", first[1], first.len(), &first[10..18]);
        assert!(first[1] & FLAG_CONFIG != 0, "first packet is the codec config");
        assert!(n > 3);
        drop(stream);
    }
}

/// Record real stream messages for the browser decode test:
/// `MTS_ADB=… MTS_SERIAL=… MTS_FIXTURE_OUT=<dir> cargo test stream::record -- --ignored`
#[cfg(test)]
mod record {
    use super::*;

    #[test]
    #[ignore]
    fn record_stream_fixture() {
        let (Ok(adb), Ok(serial), Ok(out)) = (std::env::var("MTS_ADB"), std::env::var("MTS_SERIAL"), std::env::var("MTS_FIXTURE_OUT")) else { return };
        let jar = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/scrcpy/scrcpy-server");
        let buf = Arc::new(Mutex::new(Vec::<u8>::new()));
        let b = buf.clone();
        let log: Logger = Arc::new(|_| {});
        let stream = start(StartOptions { adb: Path::new(&adb), server_jar: &jar, serial: &serial, max_size: 1280, log }, move |m| {
            let mut v = b.lock().unwrap();
            v.extend_from_slice(&(m.len() as u32).to_be_bytes());
            v.extend_from_slice(&m);
        })
        .unwrap();
        // Swipe a little so frames change.
        std::thread::sleep(Duration::from_millis(1500));
        for step in 0..10 {
            let y = 900 - step * 40;
            let action = if step == 0 { ACTION_DOWN } else if step == 9 { ACTION_UP } else { ACTION_MOVE };
            stream.send(&touch_message(action, 300, y, stream.width as u16, stream.height as u16)).unwrap();
            std::thread::sleep(Duration::from_millis(30));
        }
        std::thread::sleep(Duration::from_millis(1500));
        drop(stream);
        std::thread::sleep(Duration::from_millis(300));
        let data = buf.lock().unwrap().clone();
        std::fs::write(Path::new(&out).join("stream.bin"), &data).unwrap();
        println!("recorded {} bytes", data.len());
    }
}
