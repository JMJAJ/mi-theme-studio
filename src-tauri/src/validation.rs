//! Structural package checks. These catch problems that are detectable from
//! the package itself; they do not prove a theme will install or render on
//! a particular MIUI/HyperOS build.

use crate::package::metadata::{self, check_well_formed, DESCRIPTION_PATH, ROOT_NAME};
use crate::package::paths::{extension, file_name, join, parent, split_nested, NESTED_SEP};
use crate::project::classify::{component_of, kind_of};
use crate::project::{decode_text, Project};
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub severity: Severity,
    pub code: &'static str,
    pub message: String,
    pub path: Option<String>,
    /// Optional one-click fix the UI can offer (`pack-folder`, `create-description`,
    /// `convert-format`).
    pub fix: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationReport {
    pub issues: Vec<Issue>,
    pub errors: usize,
    pub warnings: usize,
    pub infos: usize,
    pub checked_files: usize,
    pub checked_xml: usize,
    pub checked_references: usize,
    pub limitations: Vec<&'static str>,
}

pub const LIMITATIONS: &[&str] = &[
    "Checks are structural: they cannot prove that a package installs or renders on a given MIUI/HyperOS version.",
    "MAML expressions, variables and runtime-generated image names are not evaluated; only literal image references are checked.",
    "Theme Manager may reject packages that are unsigned, from unknown sources, or built for a different UI version.",
];

/// Components MIUI stores as nested ZIP archives at the package root.
const ARCHIVE_COMPONENTS: &[&str] = &[
    "icons",
    "lockscreen",
    "com.android.systemui",
    "framework-res",
    "framework-miui-res",
    "com.android.settings",
    "com.miui.home",
    "com.android.contacts",
    "com.android.mms",
    "com.miui.securitycenter",
];

fn issue(
    severity: Severity,
    code: &'static str,
    message: impl Into<String>,
    path: Option<&str>,
) -> Issue {
    Issue {
        severity,
        code,
        message: message.into(),
        path: path.map(str::to_string),
        fix: None,
    }
}

pub fn validate(project: &Project) -> ValidationReport {
    let mut issues = Vec::new();
    let mut checked_xml = 0usize;
    let mut checked_references = 0usize;

    // --- description.xml --------------------------------------------------
    match project.files.get(DESCRIPTION_PATH) {
        None => issues.push(Issue {
            fix: Some("create-description"),
            ..issue(
                Severity::Error,
                "missing-description",
                "description.xml is missing; Theme Manager needs it to identify the theme.",
                None,
            )
        }),
        Some(blob) => {
            let (text, lossy, _) = decode_text(&blob.data);
            if lossy {
                issues.push(issue(
                    Severity::Warning,
                    "encoding",
                    "description.xml is not valid UTF-8.",
                    Some(DESCRIPTION_PATH),
                ));
            }
            let view = metadata::parse(Some(&text));
            if let Some(error) = view.error {
                issues.push(issue(
                    Severity::Error,
                    "xml-syntax",
                    format!("description.xml is not well-formed: {error}"),
                    Some(DESCRIPTION_PATH),
                ));
            } else {
                if !metadata::is_known_root(&view.root) {
                    issues.push(issue(
                        Severity::Warning,
                        "description-root",
                        format!(
                            "The root element is `{}`; theme packages use `theme` (current) or `{ROOT_NAME}` (older MIUI).",
                            view.root
                        ),
                        Some(DESCRIPTION_PATH),
                    ));
                }
                let value = |name: &str| {
                    view.fields
                        .iter()
                        .find(|f| f.name == name && f.attributes.is_empty())
                        .map(|f| f.value.trim().to_string())
                };
                for (name, severity) in [
                    ("title", Severity::Warning),
                    ("author", Severity::Warning),
                    ("version", Severity::Warning),
                    ("uiVersion", Severity::Info),
                ] {
                    if value(name).is_none_or(|v| v.is_empty()) {
                        issues.push(issue(
                            severity,
                            "description-field",
                            format!("`{name}` is empty or missing in description.xml."),
                            Some(DESCRIPTION_PATH),
                        ));
                    }
                }
            }
        }
    }

    // --- per-file checks --------------------------------------------------
    let mut lower_paths: HashMap<String, &str> = HashMap::new();
    for (path, blob) in &project.files {
        let probe = blob.probe();
        let kind = kind_of(path, probe);
        if blob.data.is_empty() {
            issues.push(issue(
                Severity::Warning,
                "empty-file",
                "File is empty.",
                Some(path),
            ));
        }
        if let Some(other) = lower_paths.insert(path.to_lowercase(), path) {
            issues.push(issue(
                Severity::Warning,
                "case-collision",
                format!("Differs from `{other}` only by letter case; this breaks on case-insensitive file systems."),
                Some(path),
            ));
        }
        let ext = extension(path);
        let expected = match ext.as_str() {
            "png" => Some("PNG"),
            "jpg" | "jpeg" => Some("JPEG"),
            "webp" => Some("WEBP"),
            "gif" => Some("GIF"),
            _ => None,
        };
        if let Some(expected) = expected {
            match probe.format {
                Some(actual) if actual != expected => issues.push(Issue {
                    fix: crate::package::convert::can_convert(path, &blob.data)
                        .then_some("convert-format"),
                    ..issue(
                        Severity::Warning,
                        "format-mismatch",
                        format!("Named .{ext} but the content is {actual}."),
                        Some(path),
                    )
                }),
                None if !blob.data.is_empty() => issues.push(issue(
                    Severity::Error,
                    "image-unreadable",
                    "The image header could not be read.",
                    Some(path),
                )),
                _ => {}
            }
        }
        if kind == "xml" {
            checked_xml += 1;
            let (text, _, _) = decode_text(&blob.data);
            if let Err(error) = check_well_formed(&text) {
                issues.push(issue(
                    Severity::Error,
                    "xml-syntax",
                    format!("XML is not well-formed: {error}"),
                    Some(path),
                ));
            }
        }
        if path.chars().any(|c| ":*?\"<>|".contains(c)) {
            issues.push(issue(
                Severity::Info,
                "portable-name",
                "Name contains characters that are not allowed on Windows.",
                Some(path),
            ));
        }
        if blob.data.len() > 50 * 1024 * 1024 {
            issues.push(issue(
                Severity::Info,
                "large-file",
                format!("Large file ({} MB).", blob.data.len() / 1024 / 1024),
                Some(path),
            ));
        }
    }

    // --- structure ----------------------------------------------------------
    let roots: HashSet<&str> = project
        .files
        .keys()
        .map(|k| split_nested(k).0.split('/').next().unwrap_or(""))
        .collect();
    for component in ARCHIVE_COMPONENTS {
        if project.containers.contains_key(*component) {
            continue;
        }
        if let Some(blob) = project.files.get(*component) {
            if !blob.probe().is_zip {
                issues.push(issue(
                    Severity::Warning,
                    "component-not-archive",
                    format!("`{component}` should be a ZIP-format component archive."),
                    Some(component),
                ));
            }
        } else if roots.contains(component) && !project.files_under(component).is_empty() {
            issues.push(Issue {
                fix: Some("pack-folder"),
                ..issue(
                    Severity::Warning,
                    "component-folder",
                    format!("`{component}/` is a plain folder. Packages store this component as a ZIP archive named `{component}`."),
                    Some(component),
                )
            });
        }
    }
    let has = |component: &str| project.files.keys().any(|k| component_of(k) == component);
    if !has("wallpapers") {
        issues.push(issue(
            Severity::Info,
            "no-wallpaper",
            "No wallpaper/ resources; the device keeps its current wallpaper.",
            None,
        ));
    }
    if !has("previews") {
        issues.push(issue(
            Severity::Info,
            "no-previews",
            "No preview/ images; Theme Manager shows previews from this folder.",
            None,
        ));
    }

    // --- MAML references ---------------------------------------------------
    let all: HashSet<&str> = project.files.keys().map(String::as_str).collect();
    let lower_all: HashMap<String, &str> = project
        .files
        .keys()
        .map(|k| (k.to_lowercase(), k.as_str()))
        .collect();
    for (path, blob) in &project.files {
        if file_name(path) != "manifest.xml" {
            continue;
        }
        let (text, _, _) = decode_text(&blob.data);
        let base = parent(path);
        for reference in image_references(&text) {
            checked_references += 1;
            let target = join(&base, &reference);
            if all.contains(target.as_str()) || has_variant(&all, &target) {
                continue;
            }
            match lower_all.get(&target.to_lowercase()) {
                Some(actual) => issues.push(issue(
                    Severity::Warning,
                    "reference-case",
                    format!("References `{reference}` but the file is `{}` (case differs; Android is case-sensitive).", file_name(actual)),
                    Some(path),
                )),
                None => issues.push(issue(
                    Severity::Warning,
                    "missing-reference",
                    format!("References `{reference}`, which is not in the package."),
                    Some(path),
                )),
            }
        }
    }

    // --- import report ------------------------------------------------------
    if let Some(report) = &project.import_report {
        for skipped in &report.skipped {
            issues.push(issue(
                Severity::Warning,
                "skipped-entry",
                format!("Skipped on import: {}", skipped.reason),
                Some(&skipped.path),
            ));
        }
    }

    issues.sort_by(|a, b| {
        a.severity
            .cmp(&b.severity)
            .then_with(|| a.path.cmp(&b.path))
    });
    let count = |s: Severity| issues.iter().filter(|i| i.severity == s).count();
    ValidationReport {
        errors: count(Severity::Error),
        warnings: count(Severity::Warning),
        infos: count(Severity::Info),
        issues,
        checked_files: project.files.len(),
        checked_xml,
        checked_references,
        limitations: LIMITATIONS.to_vec(),
    }
}

/// MAML image elements can use numbered or state variants (`bg_0.png`,
/// `bg_pressed.png`); accept those as resolving the base name.
fn has_variant(all: &HashSet<&str>, target: &str) -> bool {
    let (stem, ext) = match target.rfind('.') {
        Some(index) => (&target[..index], &target[index..]),
        None => (target, ""),
    };
    let prefix = format!("{stem}_");
    all.iter()
        .any(|p| p.starts_with(&prefix) && p.ends_with(ext))
}

/// Literal image references from `src` attributes in a MAML manifest.
pub fn image_references(xml: &str) -> Vec<String> {
    let mut reader = Reader::from_str(xml);
    let mut out = BTreeMap::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                let mut src = None;
                let mut dynamic = false;
                for attribute in element.attributes().flatten() {
                    let key: &str = attribute.key.as_ref();
                    if key == "src" {
                        #[allow(deprecated)]
                        let value = attribute.unescape_value().ok().map(|v| v.into_owned());
                        src = value;
                    } else if matches!(
                        key,
                        "srcid" | "srcExp" | "srcFormat" | "srcFormatExp" | "srcParas"
                    ) {
                        dynamic = true;
                    }
                }
                if let Some(src) = src {
                    let dynamic = dynamic
                        || src.contains(['#', '@', '$', '{', '('])
                        || src.starts_with("http");
                    let is_image =
                        matches!(extension(&src).as_str(), "png" | "jpg" | "jpeg" | "webp");
                    if !dynamic
                        && is_image
                        && !src.contains(NESTED_SEP)
                        && !src.starts_with('/')
                        && !src.contains("..")
                    {
                        out.insert(src.trim_start_matches("./").to_string(), ());
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out.into_keys().collect()
}

pub fn report_markdown(project: &Project, report: &ValidationReport) -> String {
    use std::fmt::Write;
    let mut md = String::new();
    let _ = writeln!(md, "# Package report: {}\n", project.title());
    let _ = writeln!(md, "- Package file: `{}`", project.name);
    if let Some(path) = &project.source_path {
        let _ = writeln!(md, "- Location: `{}`", path.display());
    }
    let total: usize = project.files.values().map(|b| b.data.len()).sum();
    let _ = writeln!(
        md,
        "- Files: {} ({} bytes uncompressed)",
        project.files.len(),
        total
    );
    let _ = writeln!(
        md,
        "- Component archives: {}",
        project
            .containers
            .keys()
            .cloned()
            .collect::<Vec<_>>()
            .join(", ")
    );
    let _ = writeln!(
        md,
        "- Unsaved changes: {}\n",
        if project.is_dirty() { "yes" } else { "no" }
    );

    let view = metadata::parse(project.text(DESCRIPTION_PATH).as_deref());
    if !view.fields.is_empty() {
        let _ = writeln!(md, "## Metadata\n");
        for field in view.fields.iter().filter(|f| !f.complex) {
            let lang = field
                .attributes
                .iter()
                .map(|(k, v)| format!(" [{k}={v}]"))
                .collect::<String>();
            let _ = writeln!(
                md,
                "- **{}**{}: {}",
                field.name,
                lang,
                field.value.replace('\n', " ")
            );
        }
        let _ = writeln!(md);
    }

    let mut by_component: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    for (path, blob) in &project.files {
        let entry = by_component.entry(component_of(path)).or_default();
        entry.0 += 1;
        entry.1 += blob.data.len();
    }
    let _ = writeln!(
        md,
        "## Components\n\n| Component | Files | Bytes |\n|---|---:|---:|"
    );
    for (component, (files, bytes)) in by_component {
        let _ = writeln!(md, "| {component} | {files} | {bytes} |");
    }

    let _ = writeln!(
        md,
        "\n## Validation\n\n{} errors, {} warnings, {} notes ({} files, {} XML documents, {} image references checked).\n",
        report.errors, report.warnings, report.infos, report.checked_files, report.checked_xml, report.checked_references
    );
    for issue in &report.issues {
        let severity = match issue.severity {
            Severity::Error => "ERROR",
            Severity::Warning => "WARN",
            Severity::Info => "NOTE",
        };
        let path = issue
            .path
            .as_deref()
            .map(|p| format!(" `{p}`"))
            .unwrap_or_default();
        let _ = writeln!(md, "- {severity}{path}: {}", issue.message);
    }
    if !project.attributions.is_empty() {
        let _ = writeln!(md, "\n## Reused resources\n");
        for a in &project.attributions {
            let _ = writeln!(
                md,
                "- {} files from “{}” by {} ({})",
                a.files,
                a.source_title,
                if a.source_author.is_empty() {
                    "unknown author"
                } else {
                    &a.source_author
                },
                a.source_file
            );
        }
    }
    let _ = writeln!(md, "\n## Limitations\n");
    for limitation in &report.limitations {
        let _ = writeln!(md, "- {limitation}");
    }
    md
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package::archive::tests::build_zip;
    use crate::package::archive::Limits;
    use crate::package::blob::Compression::Deflated;

    #[test]
    fn finds_maml_references() {
        let xml = r##"<Lockscreen><Image src="bg.png"/><Image src="#dyn.png"/><Image src="n.png" srcid="#x"/><Image src="sub/a.png"/><Text text="x"/></Lockscreen>"##;
        assert_eq!(
            image_references(xml),
            vec!["bg.png".to_string(), "sub/a.png".to_string()]
        );
    }

    #[test]
    fn reports_problems() {
        let lock = build_zip(&[
            ("manifest.xml", br#"<Lockscreen><Image src="bg.png"/><Image src="Clock.png"/><Image src="digit.png"/></Lockscreen>"#, Deflated),
            ("clock.png", b"\x89PNG\r\n\x1a\n", Deflated),
            ("digit_0.png", b"\x89PNG\r\n\x1a\n", Deflated),
        ]);
        let data = build_zip(&[
            (
                "description.xml",
                b"<MIUI-Theme><title>T</title></MIUI-Theme>",
                Deflated,
            ),
            ("lockscreen", &lock, Deflated),
            ("wallpaper/a.png", b"\xFF\xD8\xFFjpeg", Deflated),
            ("broken.xml", b"<a>", Deflated),
            ("framework-res/res/x.png", b"\x89PNG\r\n\x1a\n", Deflated),
        ]);
        let project = Project::from_bytes(&data, "t.mtz", None, Limits::default()).unwrap();
        let report = validate(&project);
        let codes: Vec<_> = report.issues.iter().map(|i| i.code).collect();
        assert!(codes.contains(&"missing-reference"), "{codes:?}");
        assert!(codes.contains(&"reference-case"));
        assert!(codes.contains(&"format-mismatch"));
        assert!(codes.contains(&"xml-syntax"));
        assert!(codes.contains(&"component-folder"));
        assert!(codes.contains(&"description-field"));
        assert!(report.errors >= 1);
        let missing: Vec<_> = report
            .issues
            .iter()
            .filter(|i| i.code == "missing-reference")
            .collect();
        assert_eq!(missing.len(), 1, "digit.png resolves through digit_0.png");
        let md = report_markdown(&project, &report);
        assert!(md.contains("# Package report: T"));
    }

    #[test]
    fn missing_description_is_an_error() {
        let data = build_zip(&[("wallpaper/a.jpg", b"\xFF\xD8\xFF", Deflated)]);
        let project = Project::from_bytes(&data, "t.mtz", None, Limits::default()).unwrap();
        let report = validate(&project);
        assert!(report
            .issues
            .iter()
            .any(|i| i.code == "missing-description" && i.fix == Some("create-description")));
    }
}
