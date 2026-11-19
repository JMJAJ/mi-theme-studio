//! Parsers for adb/shell output. Pure functions so they are unit-testable
//! without a device.

use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEntry {
    pub serial: String,
    /// `device`, `unauthorized`, `offline`, `recovery`, `sideload`, `no permissions`, ...
    pub state: String,
    pub model: Option<String>,
    pub product: Option<String>,
    pub device: Option<String>,
    pub transport_id: Option<String>,
    pub usb: Option<String>,
}

/// Parse `adb devices -l`.
pub fn parse_devices(output: &str) -> Vec<DeviceEntry> {
    let mut devices = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty()
            || line.starts_with("List of devices")
            || line.starts_with('*')
            || line.starts_with("adb ")
        {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(serial) = parts.next() else { continue };
        let rest: Vec<&str> = parts.collect();
        if rest.is_empty() {
            continue;
        }
        // State is everything up to the first key:value pair ("no permissions" has a space).
        let state_end = rest
            .iter()
            .position(|p| p.contains(':'))
            .unwrap_or(rest.len());
        let state = rest[..state_end].join(" ");
        let mut entry = DeviceEntry {
            serial: serial.to_string(),
            state: if state.starts_with("no permissions") {
                "no permissions".into()
            } else {
                state
            },
            model: None,
            product: None,
            device: None,
            transport_id: None,
            usb: None,
        };
        for pair in &rest[state_end..] {
            if let Some((key, value)) = pair.split_once(':') {
                let value = Some(value.to_string());
                match key {
                    "model" => entry.model = value.map(|v| v.replace('_', " ")),
                    "product" => entry.product = value,
                    "device" => entry.device = value,
                    "transport_id" => entry.transport_id = value,
                    "usb" => entry.usb = value,
                    _ => {}
                }
            }
        }
        devices.push(entry);
    }
    devices
}

/// Parse `getprop` output lines like `[ro.product.model]: [2510DPC44G]`.
pub fn parse_getprop(output: &str) -> HashMap<String, String> {
    let mut props = HashMap::new();
    for line in output.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix('[') else {
            continue;
        };
        let Some((key, value)) = rest.split_once("]: [") else {
            continue;
        };
        let value = value.strip_suffix(']').unwrap_or(value);
        props.insert(key.to_string(), value.to_string());
    }
    props
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Size {
    pub width: u32,
    pub height: u32,
}

/// Parse `wm size`; prefers the override size when present.
pub fn parse_wm_size(output: &str) -> (Option<Size>, Option<Size>) {
    let mut physical = None;
    let mut over = None;
    for line in output.lines() {
        let Some((label, value)) = line.split_once(':') else {
            continue;
        };
        let Some((w, h)) = value.trim().split_once('x') else {
            continue;
        };
        let (Ok(width), Ok(height)) = (w.trim().parse(), h.trim().parse()) else {
            continue;
        };
        let size = Some(Size { width, height });
        if label.contains("Override") {
            over = size;
        } else {
            physical = size;
        }
    }
    (physical, over)
}

/// Parse `wm density`.
pub fn parse_wm_density(output: &str) -> (Option<u32>, Option<u32>) {
    let mut physical = None;
    let mut over = None;
    for line in output.lines() {
        let Some((label, value)) = line.split_once(':') else {
            continue;
        };
        let Ok(value) = value.trim().parse() else {
            continue;
        };
        if label.contains("Override") {
            over = Some(value);
        } else {
            physical = Some(value);
        }
    }
    (physical, over)
}

/// First `versionName=` from `dumpsys package <pkg>`.
pub fn parse_version_name(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        line.trim()
            .strip_prefix("versionName=")
            .map(|v| v.trim().to_string())
    })
}

/// Parse the size printed by `stat -c %s`.
pub fn parse_size(output: &str) -> Option<u64> {
    output.lines().find_map(|l| l.trim().parse().ok())
}

/// What the phone reports right now, for previews fed from the phone.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveState {
    pub battery_level: Option<u32>,
    pub charging: Option<bool>,
    pub full: bool,
    /// The phone's clock, in milliseconds since 1970.
    pub epoch_ms: Option<u64>,
    /// The phone's time zone, minutes east of UTC.
    pub tz_offset_minutes: Option<i32>,
    /// Columns from the Weather app's provider, by name, one value per row.
    pub weather: HashMap<String, Vec<String>>,
    pub weather_error: Option<String>,
    pub music_playing: Option<bool>,
    pub fetched_at_ms: u64,
}

/// Split the output of the combined live-state shell command into its `@@name` sections.
pub fn split_sections(output: &str) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    let mut current: Option<String> = None;
    for line in output.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(name) = line.strip_prefix("@@") {
            let name = name.trim().to_string();
            out.entry(name.clone()).or_default();
            current = Some(name);
        } else if let Some(name) = &current {
            let text = out.entry(name.clone()).or_default();
            text.push_str(line);
            text.push('\n');
        }
    }
    out
}

/// Parse `dumpsys battery`: level, and whether it is charging or full.
pub fn parse_battery(output: &str) -> (Option<u32>, Option<bool>, bool) {
    let mut level = None;
    let mut scale = None;
    let mut status = None;
    let mut powered = false;
    for line in output.lines() {
        let Some((key, value)) = line.trim().split_once(':') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "level" => level = value.parse::<u32>().ok(),
            "scale" => scale = value.parse::<u32>().ok(),
            "status" => status = value.parse::<u32>().ok(),
            "AC powered" | "USB powered" | "Wireless powered" | "Dock powered" => {
                powered |= value == "true"
            }
            _ => {}
        }
    }
    let level = match (level, scale) {
        (Some(l), Some(s)) if s > 0 && s != 100 => Some((l * 100 + s / 2) / s),
        (l, _) => l,
    };
    // BatteryManager: 2 charging, 3 discharging, 4 not charging, 5 full.
    let full = status == Some(5);
    let charging = status.map(|s| s == 2 || (s == 5 && powered));
    (level.map(|l| l.min(100)), charging, full)
}

/// Parse `date +%s` and `date +%z` lines: the clock and the zone offset.
pub fn parse_clock(output: &str) -> (Option<u64>, Option<i32>) {
    let mut epoch = None;
    let mut zone = None;
    for line in output.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if (line.starts_with('+') || line.starts_with('-')) && line.len() == 5 {
            let sign = if line.starts_with('-') { -1 } else { 1 };
            let h: i32 = line[1..3].parse().unwrap_or(0);
            let m: i32 = line[3..5].parse().unwrap_or(0);
            zone = Some(sign * (h * 60 + m));
        } else if let Ok(s) = line.parse::<u64>() {
            epoch = Some(if s > 100_000_000_000 { s } else { s * 1000 });
        }
    }
    (epoch, zone)
}

/// Parse `content query` rows (`Row: 0 a=1, b=two, c=x, y`) into columns.
/// A value may itself hold ", "; a new column only starts at ", name=".
pub fn parse_content_rows(output: &str) -> HashMap<String, Vec<String>> {
    let mut columns: HashMap<String, Vec<String>> = HashMap::new();
    for line in output.lines() {
        let Some(rest) = line.trim().strip_prefix("Row:") else {
            continue;
        };
        let rest = rest.trim_start();
        let rest = rest.split_once(' ').map(|(_, r)| r).unwrap_or("");
        let bytes = rest.as_bytes();
        let mut starts = vec![0usize];
        let mut i = 0;
        while let Some(off) = rest[i..].find(", ") {
            let at = i + off;
            let name_start = at + 2;
            let name_len = bytes[name_start..]
                .iter()
                .take_while(|b| b.is_ascii_alphanumeric() || **b == b'_')
                .count();
            if name_len > 0 && bytes.get(name_start + name_len) == Some(&b'=') {
                starts.push(name_start);
            }
            i = name_start;
        }
        for (k, &start) in starts.iter().enumerate() {
            let end = starts.get(k + 1).map(|&n| n - 2).unwrap_or(rest.len());
            let Some((name, value)) = rest[start..end].split_once('=') else {
                continue;
            };
            let value = if value == "NULL" { "" } else { value };
            columns
                .entry(name.trim().to_string())
                .or_default()
                .push(value.to_string());
        }
    }
    columns
}

/// From `dumpsys media_session` lines: is any player playing (state 3)?
pub fn parse_media_playing(output: &str) -> Option<bool> {
    let mut seen = false;
    for line in output.lines() {
        let Some(pos) = line.find("{state=") else {
            continue;
        };
        seen = true;
        let n: String = line[pos + 7..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if n == "3" {
            return Some(true);
        }
    }
    seen.then_some(false)
}


#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_live_state_pieces() {
        let battery = "Current Battery Service state:\n  AC powered: false\n  USB powered: true\n  Wireless powered: false\n  status: 2\n  health: 2\n  present: true\n  level: 67\n  scale: 100\n";
        assert_eq!(parse_battery(battery), (Some(67), Some(true), false));
        assert_eq!(parse_battery("  status: 3\n  level: 40\n  scale: 100\n"), (Some(40), Some(false), false));
        assert_eq!(parse_battery("  status: 5\n  level: 100\n  AC powered: true\n"), (Some(100), Some(true), true));

        assert_eq!(parse_clock("1763550000\n+0100\n"), (Some(1_763_550_000_000), Some(60)));
        assert_eq!(parse_clock("1763550000\n-0530\n"), (Some(1_763_550_000_000), Some(-330)));

        let rows = "Row: 0 city_name=Praha, description=Mostly cloudy, rain later, temperature=5℃, aqilevel=NULL\nRow: 1 city_name=Praha, description=Rain, temperature=3℃, aqilevel=40\n";
        let cols = parse_content_rows(rows);
        assert_eq!(cols["city_name"], vec!["Praha", "Praha"]);
        assert_eq!(cols["description"], vec!["Mostly cloudy, rain later", "Rain"]);
        assert_eq!(cols["temperature"], vec!["5℃", "3℃"]);
        assert_eq!(cols["aqilevel"], vec!["", "40"]);
        assert!(parse_content_rows("Error while accessing provider:weather\njava.lang.SecurityException").is_empty());

        assert_eq!(parse_media_playing("    state=PlaybackState {state=2, position=0}\n    state=PlaybackState {state=3(PLAYING), position=1}"), Some(true));
        assert_eq!(parse_media_playing("    state=PlaybackState {state=2, position=0}"), Some(false));
        assert_eq!(parse_media_playing(""), None);

        let s = split_sections("@@battery\n  level: 5\n@@time\n123\n");
        assert_eq!(s["battery"], "  level: 5\n");
        assert_eq!(s["time"], "123\n");
    }

    #[test]
    fn parses_device_list() {
        let out = "* daemon not running; starting now at tcp:5037\n* daemon started successfully\nList of devices attached\n595eABCD               device product:annibale_eea model:2510DPC44G device:annibale transport_id:1\nemulator-5554 offline transport_id:2\nR58M unauthorized usb:1-1 transport_id:3\nXYZ no permissions (user in plugdev group); see [http://developer.android.com/tools/device.html] usb:3-1\n\n";
        let devices = parse_devices(out);
        assert_eq!(devices.len(), 4);
        assert_eq!(devices[0].serial, "595eABCD");
        assert_eq!(devices[0].state, "device");
        assert_eq!(devices[0].model.as_deref(), Some("2510DPC44G"));
        assert_eq!(devices[0].transport_id.as_deref(), Some("1"));
        assert_eq!(devices[1].state, "offline");
        assert_eq!(devices[2].state, "unauthorized");
        assert_eq!(devices[3].state, "no permissions");
        assert!(parse_devices("List of devices attached\n\n").is_empty());
    }

    #[test]
    fn parses_props_and_window_manager() {
        let props = parse_getprop("[ro.product.model]: [2510DPC44G]\n[ro.mi.os.version.name]: [OS2.0]\n[empty]: []\nnoise\n");
        assert_eq!(props["ro.product.model"], "2510DPC44G");
        assert_eq!(props["ro.mi.os.version.name"], "OS2.0");
        assert_eq!(props["empty"], "");
        let (physical, over) =
            parse_wm_size("Physical size: 1220x2712\nOverride size: 1080x2400\n");
        assert_eq!(
            physical,
            Some(Size {
                width: 1220,
                height: 2712
            })
        );
        assert_eq!(
            over,
            Some(Size {
                width: 1080,
                height: 2400
            })
        );
        assert_eq!(
            parse_wm_density("Physical density: 480\n"),
            (Some(480), None)
        );
        assert_eq!(
            parse_version_name("  Packages:\n    versionName=3.0.5.19-global\n"),
            Some("3.0.5.19-global".into())
        );
        assert_eq!(parse_size("1234\n"), Some(1234));
    }
}
