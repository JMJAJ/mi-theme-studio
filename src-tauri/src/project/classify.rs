//! Classification of package paths into MIUI/HyperOS theme components and
//! file kinds. Kept in one place so the explorer, dashboard and validation
//! agree.

use crate::package::blob::Probe;
use crate::package::paths::{extension, split_nested};
use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentDef {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    /// Root entry (archive or folder) new files of this component go into.
    pub default_root: &'static str,
    /// Whether MIUI stores this component as a nested ZIP archive.
    pub archive: bool,
}

pub const COMPONENTS: &[ComponentDef] = &[
    ComponentDef {
        id: "metadata",
        label: "Metadata",
        description: "description.xml and package configuration",
        default_root: "",
        archive: false,
    },
    ComponentDef {
        id: "previews",
        label: "Previews",
        description: "Store preview screenshots (preview/)",
        default_root: "preview",
        archive: false,
    },
    ComponentDef {
        id: "wallpapers",
        label: "Wallpapers",
        description: "Home and lock screen wallpapers (wallpaper/)",
        default_root: "wallpaper",
        archive: false,
    },
    ComponentDef {
        id: "lockscreen",
        label: "Lock screen",
        description: "Lock screen MAML component (lockscreen)",
        default_root: "lockscreen",
        archive: true,
    },
    ComponentDef {
        id: "icons",
        label: "Icons",
        description: "App icons and icon masks (icons)",
        default_root: "icons",
        archive: true,
    },
    ComponentDef {
        id: "systemui",
        label: "System UI",
        description: "Status bar, notification shade, control center (com.android.systemui)",
        default_root: "com.android.systemui",
        archive: true,
    },
    ComponentDef {
        id: "framework",
        label: "Framework",
        description: "Shared system resources (framework-res, framework-miui-res)",
        default_root: "framework-res",
        archive: true,
    },
    ComponentDef {
        id: "settings",
        label: "Settings",
        description: "Settings app resources (com.android.settings)",
        default_root: "com.android.settings",
        archive: true,
    },
    ComponentDef {
        id: "home",
        label: "Home screen",
        description: "Launcher resources (com.miui.home)",
        default_root: "com.miui.home",
        archive: true,
    },
    ComponentDef {
        id: "apps",
        label: "Other apps",
        description: "Per-app resource overlays (com.*)",
        default_root: "",
        archive: true,
    },
    ComponentDef {
        id: "fonts",
        label: "Typography",
        description: "Font files (fonts/)",
        default_root: "fonts",
        archive: false,
    },
    ComponentDef {
        id: "sounds",
        label: "Sounds",
        description: "Ringtones, notification and alarm sounds (ringtones/)",
        default_root: "ringtones",
        archive: false,
    },
    ComponentDef {
        id: "boot",
        label: "Boot animation",
        description: "Boot animation archives (boots/)",
        default_root: "boots",
        archive: false,
    },
    ComponentDef {
        id: "widgets",
        label: "Clocks & widgets",
        description: "Clock, photo frame and widget MAML (clock_*, photoframe_*)",
        default_root: "",
        archive: true,
    },
    ComponentDef {
        id: "other",
        label: "Other resources",
        description: "Files outside the known components",
        default_root: "",
        archive: false,
    },
];

/// Component id for a project path.
pub fn component_of(path: &str) -> &'static str {
    let (outer, _) = split_nested(path);
    let root = outer
        .split('/')
        .next()
        .unwrap_or(outer)
        .to_ascii_lowercase();
    let lower = outer.to_ascii_lowercase();
    match root.as_str() {
        "description.xml" | "plugin_config.xml" | "theme_values.xml" => "metadata",
        "preview" | "previews" => "previews",
        "wallpaper" | "wallpapers" => "wallpapers",
        "lockscreen" | "lockstyle" | "lock_screen" => "lockscreen",
        "icons" | "fancy_icons" | "fancyicons" => "icons",
        "com.android.systemui" => "systemui",
        "framework-res" | "framework-miui-res" | "miui" | "com.miui.core" | "miui-res" => {
            "framework"
        }
        "com.android.settings" => "settings",
        "com.miui.home" => "home",
        "fonts" | "font" => "fonts",
        "ringtones" | "audio" | "sounds" | "notifications" | "alarms" => "sounds",
        "boots" | "bootanimation" | "bootanimation.zip" => "boot",
        _ if root.starts_with("clock_")
            || root.starts_with("photoframe_")
            || root.starts_with("widget_")
            || root.starts_with("maml") =>
        {
            "widgets"
        }
        _ if root.starts_with("com.") || root.starts_with("miui.") => "apps",
        _ if lower.contains("wallpaper") => "wallpapers",
        _ => "other",
    }
}

pub fn kind_of(path: &str, probe: &Probe) -> &'static str {
    let ext = extension(path);
    if matches!(
        probe.format,
        Some("PNG" | "JPEG" | "GIF" | "WEBP" | "BMP" | "AVIF")
    ) {
        return "image";
    }
    if probe.is_binary_xml {
        return "binaryXml";
    }
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "avif" => "image",
        "xml" | "maml" => "xml",
        "ttf" | "otf" | "ttc" => "font",
        "ogg" | "mp3" | "wav" | "m4a" | "aac" | "flac" | "amr" | "mid" => "audio",
        "mp4" | "webm" | "3gp" | "mkv" => "video",
        "txt" | "json" | "ini" | "properties" | "prop" | "css" | "js" | "md" | "csv" | "cfg"
        | "lua" | "html" | "svg" => "text",
        _ if probe.is_zip => "archive",
        _ if matches!(probe.format, Some("OGG" | "MP3" | "WAV")) => "audio",
        _ if matches!(probe.format, Some("FONT")) => "font",
        _ if probe.looks_like_text => "text",
        _ => "binary",
    }
}

/// Android density bucket parsed from `drawable-xxhdpi`-style folders.
pub fn density_of(path: &str) -> Option<&'static str> {
    let lower = path.to_ascii_lowercase();
    for (needle, label) in [
        ("-xxxhdpi", "xxxhdpi"),
        ("-nxhdpi", "nxhdpi"),
        ("-xxhdpi", "xxhdpi"),
        ("-xhdpi", "xhdpi"),
        ("-hdpi", "hdpi"),
        ("-mdpi", "mdpi"),
        ("-nodpi", "nodpi"),
    ] {
        if lower.contains(&format!("drawable{needle}"))
            || lower.contains(&format!("mipmap{needle}"))
        {
            return Some(label);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package::blob::probe_bytes;

    #[test]
    fn classifies_components() {
        assert_eq!(component_of("description.xml"), "metadata");
        assert_eq!(
            component_of("wallpaper/default_wallpaper.jpg"),
            "wallpapers"
        );
        assert_eq!(
            component_of("icons!/res/drawable-xxhdpi/com.android.camera.png"),
            "icons"
        );
        assert_eq!(
            component_of("com.android.systemui!/res/drawable/x.png"),
            "systemui"
        );
        assert_eq!(component_of("framework-res"), "framework");
        assert_eq!(component_of("com.android.contacts"), "apps");
        assert_eq!(component_of("clock_2x4!/manifest.xml"), "widgets");
        assert_eq!(component_of("ringtones/a.ogg"), "sounds");
        assert_eq!(component_of("random.bin"), "other");
    }

    #[test]
    fn classifies_kinds() {
        assert_eq!(kind_of("a.xml", &probe_bytes(b"<a/>")), "xml");
        assert_eq!(
            kind_of("a.png", &probe_bytes(b"\x89PNG\r\n\x1a\n....")),
            "image"
        );
        assert_eq!(kind_of("desc.txt", &probe_bytes(b"1080 2400 30")), "text");
        assert_eq!(kind_of("blob", &probe_bytes(&[0, 1, 2, 0])), "binary");
        assert_eq!(
            density_of("icons!/res/drawable-xxhdpi/a.png"),
            Some("xxhdpi")
        );
        assert_eq!(density_of("wallpaper/a.png"), None);
    }
}
