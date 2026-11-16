//! Path rules for entries inside a theme package.
//!
//! Package paths are always relative, `/`-separated and never contain `.`
//! or `..` segments. Files inside a nested component archive (for example the
//! `icons` or `lockscreen` component of an `.mtz`) are addressed as
//! `outer!/inner/path.png`.

pub const NESTED_SEP: &str = "!/";
pub const MAX_PATH_LEN: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathIssue {
    Empty,
    Absolute,
    Traversal,
    ControlCharacter,
    ReservedSeparator,
    TooLong,
    IllegalCharacter(char),
}

impl PathIssue {
    pub fn describe(&self) -> String {
        match self {
            PathIssue::Empty => "the path is empty".into(),
            PathIssue::Absolute => "absolute paths are not allowed".into(),
            PathIssue::Traversal => "`.` and `..` path segments are not allowed".into(),
            PathIssue::ControlCharacter => "the path contains control characters".into(),
            PathIssue::ReservedSeparator => "`!/` is reserved for component archives".into(),
            PathIssue::TooLong => format!("the path is longer than {MAX_PATH_LEN} characters"),
            PathIssue::IllegalCharacter(c) => {
                format!("the character `{c}` is not allowed in names")
            }
        }
    }
}

/// Normalize a path read from an archive. Rejects anything that could escape
/// the package root. Empty segments (`a//b`) are collapsed. A trailing `/`
/// is removed; callers decide whether the entry is a directory.
pub fn sanitize_archive_path(raw: &str) -> Result<String, PathIssue> {
    if raw.chars().any(|c| c.is_control()) {
        return Err(PathIssue::ControlCharacter);
    }
    let normalized = raw.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err(PathIssue::Absolute);
    }
    // Windows drive (`C:`) or UNC-like prefixes.
    let bytes = normalized.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return Err(PathIssue::Absolute);
    }
    if normalized.contains(NESTED_SEP) {
        return Err(PathIssue::ReservedSeparator);
    }
    let mut parts = Vec::new();
    for part in normalized.split('/') {
        match part {
            "" => continue,
            "." | ".." => return Err(PathIssue::Traversal),
            other => parts.push(other),
        }
    }
    if parts.is_empty() {
        return Err(PathIssue::Empty);
    }
    let joined = parts.join("/");
    if joined.len() > MAX_PATH_LEN {
        return Err(PathIssue::TooLong);
    }
    Ok(joined)
}

/// Validate a single file or folder name typed by the user. Stricter than
/// archive import: names that are unsafe on Windows are rejected so exported
/// packages can be extracted anywhere.
pub fn validate_name(name: &str) -> Result<(), PathIssue> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(PathIssue::Empty);
    }
    if trimmed == "." || trimmed == ".." {
        return Err(PathIssue::Traversal);
    }
    if name.chars().any(|c| c.is_control()) {
        return Err(PathIssue::ControlCharacter);
    }
    for c in ['/', '\\', ':', '*', '?', '"', '<', '>', '|'] {
        if name.contains(c) {
            return Err(PathIssue::IllegalCharacter(c));
        }
    }
    if name.contains('!') && name.ends_with('!') {
        return Err(PathIssue::ReservedSeparator);
    }
    Ok(())
}

/// Validate a full project path (may contain one `!/` component separator).
pub fn validate_project_path(path: &str) -> Result<(), PathIssue> {
    let (outer, inner) = split_nested(path);
    sanitize_archive_path(outer).and_then(|clean| {
        if clean != outer {
            Err(PathIssue::Traversal)
        } else {
            Ok(())
        }
    })?;
    for segment in outer.split('/') {
        validate_name(segment)?;
    }
    if let Some(inner) = inner {
        let clean = sanitize_archive_path(inner)?;
        if clean != inner {
            return Err(PathIssue::Traversal);
        }
        for segment in inner.split('/') {
            validate_name(segment)?;
        }
    }
    Ok(())
}

/// Split `outer!/inner` into its parts.
pub fn split_nested(path: &str) -> (&str, Option<&str>) {
    match path.find(NESTED_SEP) {
        Some(index) => (&path[..index], Some(&path[index + NESTED_SEP.len()..])),
        None => (path, None),
    }
}

pub fn join_nested(outer: &str, inner: &str) -> String {
    format!("{outer}{NESTED_SEP}{inner}")
}

/// Last segment of a path (handles both `/` and `!/`).
pub fn file_name(path: &str) -> &str {
    let (outer, inner) = split_nested(path);
    let tail = inner.unwrap_or(outer);
    tail.rsplit('/').next().unwrap_or(tail)
}

/// Parent folder of a path, or `""` for root entries. The parent of a direct
/// child of a component archive is `outer!/`'s container key (`outer`) with
/// the separator, represented as `outer!/`.
pub fn parent(path: &str) -> String {
    let (outer, inner) = split_nested(path);
    match inner {
        Some(inner) => match inner.rfind('/') {
            Some(index) => join_nested(outer, &inner[..index]),
            None => format!("{outer}{NESTED_SEP}"),
        },
        None => match outer.rfind('/') {
            Some(index) => outer[..index].to_string(),
            None => String::new(),
        },
    }
}

/// Join a folder (as returned by [`parent`], possibly `outer!/`) and a name.
pub fn join(folder: &str, name: &str) -> String {
    if folder.is_empty() {
        name.to_string()
    } else if folder.ends_with(NESTED_SEP) || folder.ends_with('/') {
        format!("{folder}{name}")
    } else {
        format!("{folder}/{name}")
    }
}

/// Lowercase file extension without the dot (`.9.png` yields `png`).
pub fn extension(path: &str) -> String {
    let name = file_name(path);
    match name.rfind('.') {
        Some(index) if index > 0 => name[index + 1..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

/// Produce a non-conflicting name such as `name copy.png`, `name copy 2.png`.
pub fn copy_name(path: &str, exists: impl Fn(&str) -> bool) -> String {
    let folder = parent(path);
    let name = file_name(path);
    let (stem, ext) = if let Some(stripped) = name.strip_suffix(".9.png") {
        (stripped.to_string(), ".9.png".to_string())
    } else {
        match name.rfind('.') {
            Some(index) if index > 0 => (name[..index].to_string(), name[index..].to_string()),
            _ => (name.to_string(), String::new()),
        }
    };
    for n in 1.. {
        let candidate_name = if n == 1 {
            format!("{stem} copy{ext}")
        } else {
            format!("{stem} copy {n}{ext}")
        };
        let candidate = join(&folder, &candidate_name);
        if !exists(&candidate) {
            return candidate;
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_normal_paths() {
        assert_eq!(sanitize_archive_path("icons/a.png").unwrap(), "icons/a.png");
        assert_eq!(sanitize_archive_path("a\\b\\c.xml").unwrap(), "a/b/c.xml");
        assert_eq!(sanitize_archive_path("a//b/").unwrap(), "a/b");
    }

    #[test]
    fn rejects_unsafe_paths() {
        assert_eq!(sanitize_archive_path("../evil"), Err(PathIssue::Traversal));
        assert_eq!(
            sanitize_archive_path("a/../../evil"),
            Err(PathIssue::Traversal)
        );
        assert_eq!(sanitize_archive_path("./a"), Err(PathIssue::Traversal));
        assert_eq!(
            sanitize_archive_path("/etc/passwd"),
            Err(PathIssue::Absolute)
        );
        assert_eq!(
            sanitize_archive_path("C:/Windows/x"),
            Err(PathIssue::Absolute)
        );
        assert_eq!(
            sanitize_archive_path("\\\\server\\share"),
            Err(PathIssue::Absolute)
        );
        assert_eq!(
            sanitize_archive_path("a!/b"),
            Err(PathIssue::ReservedSeparator)
        );
        assert_eq!(
            sanitize_archive_path("a\u{0}b"),
            Err(PathIssue::ControlCharacter)
        );
        assert_eq!(sanitize_archive_path(""), Err(PathIssue::Empty));
        assert_eq!(sanitize_archive_path("/"), Err(PathIssue::Absolute));
    }

    #[test]
    fn nested_helpers() {
        assert_eq!(
            split_nested("icons!/res/a.png"),
            ("icons", Some("res/a.png"))
        );
        assert_eq!(split_nested("wallpaper/a.jpg"), ("wallpaper/a.jpg", None));
        assert_eq!(file_name("icons!/res/a.png"), "a.png");
        assert_eq!(parent("icons!/res/a.png"), "icons!/res");
        assert_eq!(parent("icons!/a.png"), "icons!/");
        assert_eq!(parent("wallpaper/a.jpg"), "wallpaper");
        assert_eq!(parent("description.xml"), "");
        assert_eq!(join("icons!/", "a.png"), "icons!/a.png");
        assert_eq!(join("icons!/res", "a.png"), "icons!/res/a.png");
        assert_eq!(join("", "a.png"), "a.png");
        assert_eq!(extension("res/bg.9.png"), "png");
        assert_eq!(extension("icons"), "");
        assert_eq!(extension(".hidden"), "");
    }

    #[test]
    fn validates_user_names() {
        assert!(validate_name("icon.png").is_ok());
        assert!(validate_name("a/b").is_err());
        assert!(validate_name("..").is_err());
        assert!(validate_name("con?.png").is_err());
        assert!(validate_project_path("icons!/res/drawable-xxhdpi/a.png").is_ok());
        assert!(validate_project_path("icons!/../a.png").is_err());
        assert!(validate_project_path("a/./b").is_err());
    }

    #[test]
    fn copy_names_do_not_collide() {
        let existing = ["w/a.png", "w/a copy.png"];
        let name = copy_name("w/a.png", |p| existing.contains(&p));
        assert_eq!(name, "w/a copy 2.png");
        assert_eq!(copy_name("r/bg.9.png", |_| false), "r/bg copy.9.png");
        assert_eq!(copy_name("icons", |_| false), "icons copy");
    }
}
