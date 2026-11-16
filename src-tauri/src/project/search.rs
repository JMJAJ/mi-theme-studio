//! Find and replace across the text files of a project, including files
//! inside component archives. Replacements are one undoable change.

use super::{decode_text, Project};
use crate::error::{AppError, AppResult};
use crate::package::blob::Blob;
use crate::package::metadata;
use crate::package::paths;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

pub const MAX_MATCHES: usize = 5000;
const MAX_FILE_BYTES: usize = 8 * 1024 * 1024;
const PREVIEW_CHARS: usize = 160;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub query: String,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    /// Comma-separated path filters: `*.xml`, `icons!/`, `lockscreen`, … Empty = all.
    #[serde(default)]
    pub include: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    /// 1-based line and column (in characters).
    pub line: usize,
    pub column: usize,
    /// Match length in characters.
    pub length: usize,
    /// Byte offset in the decoded text, for exact replacement of one match.
    pub offset: usize,
    pub preview: String,
    /// Character offset of the match inside `preview`.
    pub preview_start: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFile {
    pub path: String,
    pub rev: u64,
    pub matches: Vec<SearchMatch>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub files: Vec<SearchFile>,
    pub total: usize,
    pub truncated: bool,
    pub searched_files: usize,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceResult {
    pub files: Vec<String>,
    pub replacements: usize,
    /// Files skipped because the result would not be well-formed XML.
    pub invalid_xml: Vec<String>,
    /// Files skipped because they changed since the search.
    pub stale: Vec<String>,
}

pub fn build_pattern(options: &SearchOptions) -> AppResult<Regex> {
    if options.query.is_empty() {
        return Err(AppError::invalid("Enter text to search for."));
    }
    if options.query.len() > 1000 {
        return Err(AppError::invalid("The search text is too long."));
    }
    let mut source = if options.regex {
        options.query.clone()
    } else {
        regex::escape(&options.query)
    };
    if options.whole_word {
        source = format!(r"\b(?:{source})\b");
    }
    RegexBuilder::new(&source)
        .case_insensitive(!options.case_sensitive)
        .multi_line(true)
        .size_limit(4 * 1024 * 1024)
        .build()
        .map_err(|e| AppError::invalid(format!("Invalid regular expression: {e}")))
}

fn glob_match(pattern: &str, text: &str) -> bool {
    // `*` matches any run of characters, `?` one character.
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti, mut star, mut mark) = (0, 0, None, 0);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi].eq_ignore_ascii_case(&t[ti])) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

pub fn path_included(include: &str, path: &str) -> bool {
    let filters: Vec<&str> = include.split(',').map(str::trim).filter(|f| !f.is_empty()).collect();
    if filters.is_empty() {
        return true;
    }
    let lower = path.to_ascii_lowercase();
    filters.iter().any(|filter| {
        let f = filter.to_ascii_lowercase();
        if f.contains('*') || f.contains('?') {
            glob_match(&f, &lower) || glob_match(&f, &paths::file_name(&lower))
        } else {
            lower.starts_with(&f) || lower.contains(&f)
        }
    })
}

/// Text files that are safe to search and rewrite: valid UTF-8, not binary XML.
fn text_of(project: &Project, path: &str) -> Option<(String, u64)> {
    let blob = project.files.get(path)?;
    if blob.data.len() > MAX_FILE_BYTES {
        return None;
    }
    let probe = blob.probe();
    if !probe.looks_like_text || probe.is_binary_xml {
        return None;
    }
    let (text, lossy, _) = decode_text(&blob.data);
    (!lossy).then_some((text, blob.rev))
}

fn preview(text: &str, line_start: usize, start: usize, end: usize) -> (String, usize) {
    let line_end = text[start..].find('\n').map_or(text.len(), |i| start + i);
    let line = text[line_start..line_end].trim_end_matches('\r');
    let before = text[line_start..start].chars().count();
    let match_chars = text[start..end.min(line_end)].chars().count();
    // Keep some context before the match, then trim.
    let skip = before.saturating_sub(40);
    let shown: String = line.chars().skip(skip).take(PREVIEW_CHARS.max(match_chars + 40)).collect();
    let leading = shown.len() - shown.trim_start().len();
    let leading_chars = shown[..leading].chars().count();
    (shown.trim_start().to_string(), before - skip - leading_chars.min(before - skip))
}

pub fn search(project: &Project, options: &SearchOptions) -> AppResult<SearchResult> {
    let pattern = build_pattern(options)?;
    let mut result = SearchResult { files: Vec::new(), total: 0, truncated: false, searched_files: 0 };
    for path in project.files.keys() {
        if !path_included(&options.include, path) {
            continue;
        }
        let Some((text, rev)) = text_of(project, path) else { continue };
        result.searched_files += 1;
        let mut matches = Vec::new();
        let mut line = 1;
        let mut line_start = 0;
        let mut scanned = 0;
        for m in pattern.find_iter(&text) {
            if m.start() == m.end() {
                continue;
            }
            for (i, b) in text[scanned..m.start()].bytes().enumerate() {
                if b == b'\n' {
                    line += 1;
                    line_start = scanned + i + 1;
                }
            }
            scanned = m.start();
            let column = text[line_start..m.start()].chars().count() + 1;
            let (preview, preview_start) = preview(&text, line_start, m.start(), m.end());
            matches.push(SearchMatch {
                line,
                column,
                length: m.as_str().chars().count(),
                offset: m.start(),
                preview,
                preview_start,
            });
            result.total += 1;
            if result.total >= MAX_MATCHES {
                result.truncated = true;
                break;
            }
        }
        if !matches.is_empty() {
            result.files.push(SearchFile { path: path.clone(), rev, matches });
        }
        if result.truncated {
            break;
        }
    }
    Ok(result)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceTarget {
    pub path: String,
    /// Revision seen by the search; the file is skipped if it changed.
    pub rev: u64,
    /// Byte offsets of the matches to replace; `None` replaces every match.
    #[serde(default)]
    pub offsets: Option<Vec<usize>>,
}

fn is_xml(path: &str) -> bool {
    matches!(paths::extension(path).as_str(), "xml" | "maml")
}

pub fn replace(
    project: &mut Project,
    options: &SearchOptions,
    replacement: &str,
    targets: &[ReplaceTarget],
    allow_invalid_xml: bool,
) -> AppResult<ReplaceResult> {
    let pattern = build_pattern(options)?;
    let mut result = ReplaceResult::default();
    let mut writes = Vec::new();
    for target in targets {
        let Some(blob) = project.files.get(&target.path).cloned() else {
            result.stale.push(target.path.clone());
            continue;
        };
        if blob.rev != target.rev {
            result.stale.push(target.path.clone());
            continue;
        }
        let Some((text, _)) = text_of(project, &target.path) else { continue };
        let mut out = String::with_capacity(text.len());
        let mut last = 0;
        let mut count = 0;
        for caps in pattern.captures_iter(&text) {
            let m = caps.get(0).expect("group 0");
            if m.start() == m.end() {
                continue;
            }
            if let Some(offsets) = &target.offsets {
                if !offsets.contains(&m.start()) {
                    continue;
                }
            }
            out.push_str(&text[last..m.start()]);
            if options.regex {
                caps.expand(replacement, &mut out);
            } else {
                out.push_str(replacement);
            }
            last = m.end();
            count += 1;
        }
        if count == 0 {
            continue;
        }
        out.push_str(&text[last..]);
        if is_xml(&target.path) && !allow_invalid_xml && metadata::check_well_formed(&out).is_err() {
            result.invalid_xml.push(target.path.clone());
            continue;
        }
        let mut bytes = Vec::with_capacity(out.len() + 3);
        if blob.data.starts_with(b"\xEF\xBB\xBF") {
            bytes.extend_from_slice(b"\xEF\xBB\xBF");
        }
        bytes.extend_from_slice(out.as_bytes());
        writes.push((target.path.clone(), Blob::new(bytes, blob.compression)));
        result.files.push(target.path.clone());
        result.replacements += count;
    }
    if writes.is_empty() {
        return Ok(result);
    }
    let label = format!(
        "Replace {} in {} {}",
        result.replacements,
        writes.len(),
        if writes.len() == 1 { "file" } else { "files" }
    );
    project.transact(&label, |tx| {
        for (path, blob) in writes {
            tx.set(&path, Some(blob));
        }
        Ok(())
    })?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package::archive::Limits;

    fn project() -> Project {
        use crate::package::archive::tests::build_zip;
        use crate::package::blob::Compression::Deflated;
        let icons = build_zip(&[("res/values/colors.xml", b"<resources><color name=\"a\">blue</color></resources>", Deflated)]);
        let bytes = build_zip(&[
            ("description.xml", b"<MIUI-Theme><title>Blue Sky</title><author>me</author></MIUI-Theme>", Deflated),
            ("notes.txt", b"blue
Blue line
nothing", Deflated),
            ("wallpaper/default_wallpaper.jpg", &[0xFF, 0xD8, 0xFF, 0xE0, 0, 0, b'b', b'l', b'u', b'e'], Deflated),
            ("icons", &icons, crate::package::blob::Compression::Stored),
        ]);
        Project::from_bytes(&bytes, "t.mtz", None, Limits::default()).unwrap()
    }

    fn opts(query: &str) -> SearchOptions {
        SearchOptions { query: query.into(), regex: false, case_sensitive: false, whole_word: false, include: String::new() }
    }

    #[test]
    fn finds_matches_with_positions() {
        let p = project();
        let r = search(&p, &opts("blue")).unwrap();
        assert_eq!(r.total, 4, "binary files are skipped, archive children are searched");
        assert!(r.files.iter().any(|f| f.path == "icons!/res/values/colors.xml"));
        let notes = r.files.iter().find(|f| f.path == "notes.txt").unwrap();
        assert_eq!(notes.matches[1].line, 2);
        assert_eq!(notes.matches[1].column, 1);
        assert_eq!(notes.matches[1].preview, "Blue line");
        let mut case = opts("blue");
        case.case_sensitive = true;
        assert_eq!(search(&p, &case).unwrap().total, 2);
        let mut only_xml = opts("blue");
        only_xml.include = "*.xml".into();
        assert_eq!(search(&p, &only_xml).unwrap().files.len(), 2);
    }

    #[test]
    fn replaces_as_one_undoable_change() {
        let mut p = project();
        let found = search(&p, &opts("blue")).unwrap();
        let targets: Vec<_> = found.files.iter().map(|f| ReplaceTarget { path: f.path.clone(), rev: f.rev, offsets: None }).collect();
        let r = replace(&mut p, &opts("blue"), "Red", &targets, false).unwrap();
        assert_eq!(r.replacements, 4);
        assert_eq!(p.text("notes.txt").unwrap(), "Red\nRed line\nnothing");
        assert!(p.text("description.xml").unwrap().contains("<title>Red Sky</title>"));
        p.undo().unwrap();
        assert_eq!(p.text("notes.txt").unwrap(), "blue\nBlue line\nnothing");
        // The old revision is stale after the undo round trip only if it changed.
        let again = replace(&mut p, &opts("blue"), "x", &targets, false).unwrap();
        assert!(again.stale.is_empty() || again.files.is_empty());
    }

    #[test]
    fn regex_groups_single_match_and_xml_guard() {
        let mut p = project();
        let mut re = opts(r"<(title)>([^<]+)</title>");
        re.regex = true;
        let found = search(&p, &re).unwrap();
        let f = &found.files[0];
        let t = [ReplaceTarget { path: f.path.clone(), rev: f.rev, offsets: Some(vec![f.matches[0].offset]) }];
        replace(&mut p, &re, "<$1>[$2]</$1>", &t, false).unwrap();
        assert!(p.text("description.xml").unwrap().contains("<title>[Blue Sky]</title>"));

        let found = search(&p, &opts("</author>")).unwrap();
        let f = &found.files[0];
        let t = [ReplaceTarget { path: f.path.clone(), rev: f.rev, offsets: None }];
        let r = replace(&mut p, &opts("</author>"), "", &t, false).unwrap();
        assert_eq!(r.invalid_xml, vec!["description.xml".to_string()]);
        assert!(p.text("description.xml").unwrap().contains("</author>"));
    }

    #[test]
    fn stale_targets_are_skipped() {
        let mut p = project();
        let found = search(&p, &opts("nothing")).unwrap();
        let f = &found.files[0];
        p.put_file("notes.txt", b"changed nothing".to_vec(), "edit").unwrap();
        let t = [ReplaceTarget { path: f.path.clone(), rev: f.rev, offsets: None }];
        let r = replace(&mut p, &opts("nothing"), "x", &t, false).unwrap();
        assert_eq!(r.stale, vec!["notes.txt".to_string()]);
    }

    #[test]
    fn filters_and_globs() {
        assert!(path_included("", "a/b.xml"));
        assert!(path_included("*.xml", "icons!/res/x.xml"));
        assert!(path_included("lockscreen", "lockscreen!/advance/manifest.xml"));
        assert!(!path_included("*.txt, icons!/", "lockscreen!/manifest.xml"));
        assert!(glob_match("res/*/a?.png", "res/drawable/ab.png"));
    }
}
