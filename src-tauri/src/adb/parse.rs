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

#[cfg(test)]
mod tests {
    use super::*;

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
