//! Reading and editing `description.xml`.
//!
//! Edits are applied by streaming the original XML and only replacing the
//! text of the targeted direct children of the root element. Declarations,
//! comments, whitespace, attributes, unknown elements and their order are
//! kept as they were.

use crate::error::{AppError, AppResult};
use quick_xml::escape::escape;
use quick_xml::events::{BytesEnd, BytesStart, BytesText, Event};
use quick_xml::{Reader, Writer};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const DESCRIPTION_PATH: &str = "description.xml";
pub const ROOT_NAME: &str = "MIUI-Theme";
/// Root used by current Theme Manager / HyperOS packages.
pub const ROOT_NAME_CURRENT: &str = "theme";

pub fn is_known_root(root: &str) -> bool {
    root == ROOT_NAME || root == ROOT_NAME_CURRENT
}

/// Fields the editor knows about, in the order they are created when
/// missing. Other simple fields are still listed and editable.
pub const KNOWN_FIELDS: &[(&str, &str)] = &[
    ("title", "Title"),
    ("designer", "Designer"),
    ("author", "Author"),
    ("version", "Version"),
    ("uiVersion", "UI version"),
    ("miuiAdapterVersion", "Adapter version"),
    ("description", "Description"),
    ("keywords", "Keywords"),
];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetadataField {
    pub name: String,
    pub value: String,
    /// `xml:lang` or similar attributes make a field a localized variant; the
    /// editor shows them but only edits plain fields.
    pub attributes: Vec<(String, String)>,
    /// Field contains child elements and is not editable as plain text.
    pub complex: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataView {
    pub exists: bool,
    pub root: String,
    pub fields: Vec<MetadataField>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FieldUpdate {
    pub name: String,
    pub value: String,
}

pub fn default_description_xml(title: &str) -> String {
    format!(
        "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<{ROOT_NAME}>\n<title>{}</title>\n<designer></designer>\n<author></author>\n<version>1.0</version>\n<uiVersion>14</uiVersion>\n<description></description>\n</{ROOT_NAME}>\n",
        escape(title)
    )
}

pub fn default_plugin_config_xml() -> String {
    "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<PluginConfig>\n</PluginConfig>\n".to_string()
}

/// Text of a localized entry such as `<titles><title locale="en_US">…`.
/// `locales` are tried in order; a locale prefix (`en`) also matches `en_US`.
pub fn localized_value(xml: &str, group: &str, item: &str, locales: &[&str]) -> Option<String> {
    let (xml, _) = strip_bom(xml);
    let mut reader = Reader::from_str(xml);
    let mut depth = 0usize;
    let mut in_group = false;
    let mut current: Option<(String, String)> = None;
    let mut found: Vec<(String, String)> = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(start)) => {
                depth += 1;
                let name = name_of(&start);
                if depth == 2 && name == group {
                    in_group = true;
                } else if depth == 3 && in_group && name == item {
                    let locale = attributes_of(&start)
                        .into_iter()
                        .find(|(k, _)| k == "locale" || k == "xml:lang")
                        .map(|(_, v)| v)
                        .unwrap_or_default();
                    current = Some((locale, String::new()));
                }
            }
            Ok(Event::Text(text)) => {
                if let Some((_, value)) = current.as_mut() {
                    value.push_str(&text.xml10_content());
                }
            }
            Ok(Event::CData(data)) => {
                if let Some((_, value)) = current.as_mut() {
                    let data: &str = &data;
                    value.push_str(data);
                }
            }
            Ok(Event::End(_)) => {
                if depth == 3 {
                    if let Some((locale, value)) = current.take() {
                        found.push((locale, value.trim().to_string()));
                    }
                }
                if depth == 2 {
                    in_group = false;
                }
                depth = depth.saturating_sub(1);
            }
            Ok(Event::Eof) | Err(_) => break,
            Ok(_) => {}
        }
    }
    for wanted in locales {
        let hit = found
            .iter()
            .find(|(l, v)| !v.is_empty() && l.eq_ignore_ascii_case(wanted))
            .or_else(|| found.iter().find(|(l, v)| !v.is_empty() && l.to_ascii_lowercase().starts_with(&wanted.to_ascii_lowercase())));
        if let Some((_, v)) = hit {
            return Some(v.clone());
        }
    }
    None
}

fn strip_bom(xml: &str) -> (&str, bool) {
    match xml.strip_prefix('\u{feff}') {
        Some(rest) => (rest, true),
        None => (xml, false),
    }
}

fn name_of(start: &BytesStart) -> String {
    let qname = start.name();
    let name: &str = qname.as_ref();
    name.to_string()
}

#[allow(deprecated)]
fn attributes_of(start: &BytesStart) -> Vec<(String, String)> {
    start
        .attributes()
        .flatten()
        .map(|a| {
            let key: &str = a.key.as_ref();
            (
                key.to_string(),
                a.unescape_value()
                    .map(|v| v.into_owned())
                    .unwrap_or_default(),
            )
        })
        .collect()
}

/// Check that an XML document is well formed. Returns the first error with
/// its byte position.
pub fn check_well_formed(xml: &str) -> Result<(), String> {
    let (xml, _) = strip_bom(xml);
    let mut reader = Reader::from_str(xml);
    reader.config_mut().check_end_names = true;
    let mut depth: i32 = 0;
    let mut roots = 0;
    loop {
        match reader.read_event() {
            Ok(Event::Start(_)) => {
                if depth == 0 {
                    roots += 1;
                }
                depth += 1;
            }
            Ok(Event::Empty(_)) => {
                if depth == 0 {
                    roots += 1;
                }
            }
            Ok(Event::End(_)) => depth -= 1,
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => {
                return Err(format!("{error} (at byte {})", reader.error_position()));
            }
        }
    }
    if depth != 0 {
        return Err("The document ends before all elements are closed.".into());
    }
    if roots == 0 {
        return Err("The document has no root element.".into());
    }
    if roots > 1 {
        return Err("The document has more than one root element.".into());
    }
    Ok(())
}

pub fn parse(xml: Option<&str>) -> MetadataView {
    let Some(xml) = xml else {
        return MetadataView {
            exists: false,
            root: String::new(),
            fields: Vec::new(),
            error: None,
        };
    };
    if let Err(error) = check_well_formed(xml) {
        return MetadataView {
            exists: true,
            root: String::new(),
            fields: Vec::new(),
            error: Some(error),
        };
    }
    let (xml, _) = strip_bom(xml);
    let mut reader = Reader::from_str(xml);
    let mut depth = 0usize;
    let mut root = String::new();
    let mut fields = Vec::new();
    let mut current: Option<MetadataField> = None;
    loop {
        match reader.read_event() {
            Ok(Event::Start(start)) => {
                depth += 1;
                if depth == 1 {
                    root = name_of(&start);
                } else if depth == 2 {
                    current = Some(MetadataField {
                        name: name_of(&start),
                        value: String::new(),
                        attributes: attributes_of(&start),
                        complex: false,
                    });
                } else if let Some(field) = current.as_mut() {
                    field.complex = true;
                }
            }
            Ok(Event::Empty(start)) => {
                if depth == 0 {
                    root = name_of(&start);
                } else if depth == 1 {
                    fields.push(MetadataField {
                        name: name_of(&start),
                        value: String::new(),
                        attributes: attributes_of(&start),
                        complex: false,
                    });
                } else if let Some(field) = current.as_mut() {
                    field.complex = true;
                }
            }
            Ok(Event::Text(text)) => {
                if depth == 2 {
                    if let Some(field) = current.as_mut() {
                        field.value.push_str(&text.xml10_content());
                    }
                }
            }
            Ok(Event::GeneralRef(reference)) => {
                if depth == 2 {
                    if let Some(field) = current.as_mut() {
                        let name: &str = &reference;
                        let entity = format!("&{name};");
                        field.value.push_str(
                            &quick_xml::escape::unescape(&entity)
                                .map(|v| v.into_owned())
                                .unwrap_or(entity),
                        );
                    }
                }
            }
            Ok(Event::CData(data)) => {
                if depth == 2 {
                    if let Some(field) = current.as_mut() {
                        let data: &str = &data;
                        field.value.push_str(data);
                    }
                }
            }
            Ok(Event::End(_)) => {
                if depth == 2 {
                    if let Some(mut field) = current.take() {
                        field.value = field.value.trim().to_string();
                        fields.push(field);
                    }
                }
                depth = depth.saturating_sub(1);
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => {
                return MetadataView {
                    exists: true,
                    root,
                    fields,
                    error: Some(error.to_string()),
                };
            }
        }
    }
    MetadataView {
        exists: true,
        root,
        fields,
        error: None,
    }
}

/// Apply plain-text updates to direct children of the root element. Fields
/// that do not exist are appended before the root's closing tag, using the
/// indentation of the existing children.
pub fn update(xml: Option<&str>, updates: &[FieldUpdate]) -> AppResult<String> {
    for update in updates {
        if update.name.is_empty()
            || !update
                .name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
            || update
                .name
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_digit())
        {
            return Err(AppError::invalid(format!(
                "`{}` is not a valid field name.",
                update.name
            )));
        }
    }
    let owned_default;
    let source = match xml {
        Some(xml) => xml,
        None => {
            owned_default = default_description_xml("My Theme");
            &owned_default
        }
    };
    check_well_formed(source)
        .map_err(|e| AppError::invalid(format!("description.xml is not valid XML: {e}")))?;
    let (body, had_bom) = strip_bom(source);
    let mut pending: BTreeMap<&str, &str> = updates
        .iter()
        .map(|u| (u.name.as_str(), u.value.as_str()))
        .collect();
    let order: Vec<&str> = updates.iter().map(|u| u.name.as_str()).collect();

    let mut reader = Reader::from_str(body);
    let mut writer = Writer::new(Vec::new());
    let mut depth = 0usize;
    // Set while the text of a replaced field is being skipped.
    let mut skipping = false;
    // Whitespace that precedes child elements (indentation style).
    let mut indent = String::from(
        "
",
    );
    // Whitespace written at depth 1 since the last child element boundary.
    let mut trailing_ws = String::new();

    let write_err = |e: std::io::Error| AppError::new("xml", e.to_string());
    loop {
        let event = reader
            .read_event()
            .map_err(|e| AppError::invalid(e.to_string()))?;
        if skipping {
            match &event {
                Event::Start(_) => depth += 1,
                Event::End(_) => {
                    if depth == 2 {
                        skipping = false;
                        writer.write_event(event.clone()).map_err(write_err)?;
                        trailing_ws.clear();
                    }
                    depth -= 1;
                }
                Event::Eof => break,
                _ => {}
            }
            continue;
        }
        match event {
            Event::Start(start) => {
                depth += 1;
                if depth == 2 {
                    if !trailing_ws.is_empty() {
                        indent = trailing_ws.clone();
                    }
                    trailing_ws.clear();
                    let name = name_of(&start);
                    if attributes_of(&start).is_empty() {
                        if let Some(value) = pending.remove(name.as_str()) {
                            writer
                                .write_event(Event::Start(start.clone()))
                                .map_err(write_err)?;
                            writer
                                .write_event(Event::Text(BytesText::new(value)))
                                .map_err(write_err)?;
                            skipping = true;
                            continue;
                        }
                    }
                }
                writer.write_event(Event::Start(start)).map_err(write_err)?;
            }
            Event::Empty(start) => {
                if depth == 1 {
                    if !trailing_ws.is_empty() {
                        indent = trailing_ws.clone();
                    }
                    trailing_ws.clear();
                    let name = name_of(&start);
                    if attributes_of(&start).is_empty() {
                        if let Some(value) = pending.remove(name.as_str()) {
                            writer
                                .write_event(Event::Start(start.to_owned()))
                                .map_err(write_err)?;
                            writer
                                .write_event(Event::Text(BytesText::new(value)))
                                .map_err(write_err)?;
                            writer
                                .write_event(Event::End(BytesEnd::new(name)))
                                .map_err(write_err)?;
                            continue;
                        }
                    }
                }
                writer.write_event(Event::Empty(start)).map_err(write_err)?;
            }
            Event::Text(text) => {
                if depth == 1 {
                    let raw: String = text.to_string();
                    if raw.trim().is_empty() {
                        trailing_ws.push_str(&raw);
                    } else {
                        trailing_ws.clear();
                    }
                }
                writer.write_event(Event::Text(text)).map_err(write_err)?;
            }
            Event::End(end) => {
                if depth == 1 && !pending.is_empty() {
                    // Append missing fields before `</root>`, matching the
                    // indentation of existing children.
                    let child_tail = indent.rsplit('\n').next().unwrap_or("").to_string();
                    let wrote_newline = trailing_ws.contains('\n');
                    let closing_tail = trailing_ws.rsplit('\n').next().unwrap_or("").to_string();
                    let mut first = true;
                    for name in &order {
                        if let Some(value) = pending.remove(name) {
                            let lead = if !wrote_newline {
                                String::new()
                            } else if first {
                                child_tail
                                    .strip_prefix(closing_tail.as_str())
                                    .unwrap_or(&child_tail)
                                    .to_string()
                            } else {
                                format!("\n{child_tail}")
                            };
                            first = false;
                            if !lead.is_empty() {
                                writer
                                    .write_event(Event::Text(BytesText::from_escaped(
                                        lead.as_str(),
                                    )))
                                    .map_err(write_err)?;
                            }
                            writer
                                .write_event(Event::Start(BytesStart::new(*name)))
                                .map_err(write_err)?;
                            writer
                                .write_event(Event::Text(BytesText::new(value)))
                                .map_err(write_err)?;
                            writer
                                .write_event(Event::End(BytesEnd::new(*name)))
                                .map_err(write_err)?;
                        }
                    }
                    if wrote_newline {
                        let closing = format!("\n{closing_tail}");
                        writer
                            .write_event(Event::Text(BytesText::from_escaped(closing.as_str())))
                            .map_err(write_err)?;
                    }
                }
                if depth == 2 {
                    trailing_ws.clear();
                }
                depth = depth.saturating_sub(1);
                writer.write_event(Event::End(end)).map_err(write_err)?;
            }
            Event::Eof => break,
            other => {
                if depth == 1 {
                    trailing_ws.clear();
                }
                writer.write_event(other).map_err(write_err)?;
            }
        }
    }
    let mut output =
        String::from_utf8(writer.into_inner()).map_err(|e| AppError::new("xml", e.to_string()))?;
    if had_bom {
        output.insert(0, '\u{feff}');
    }
    check_well_formed(&output)
        .map_err(|e| AppError::new("xml", format!("Internal error rewriting XML: {e}")))?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_format_root_and_localized_titles() {
        let xml = "<?xml version=\"1.0\"?>
<theme>
<title><![CDATA[7]]></title>
<titles>
<title locale=\"zh_CN\"><![CDATA[七]]></title>
<title locale=\"en_US\"><![CDATA[Glass Flower]]></title>
</titles>
</theme>";
        let view = parse(Some(xml));
        assert!(is_known_root(&view.root));
        assert_eq!(view.fields.iter().find(|f| f.name == "title").unwrap().value, "7");
        assert_eq!(localized_value(xml, "titles", "title", &["en_US"]).as_deref(), Some("Glass Flower"));
        assert_eq!(localized_value(xml, "titles", "title", &["en"]).as_deref(), Some("Glass Flower"));
        assert_eq!(localized_value(xml, "titles", "title", &["fr_FR"]), None);
        assert!(!is_known_root("resources"));
    }

    const SAMPLE: &str = "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<MIUI-Theme>\n<!-- keep me -->\n<title>Old &amp; Gold</title>\n<designer>D</designer>\n<author/>\n<title xml:lang=\"zh_CN\">旧</title>\n<custom>x</custom>\n</MIUI-Theme>\n";

    fn value(view: &MetadataView, name: &str) -> Option<String> {
        view.fields
            .iter()
            .find(|f| f.name == name && f.attributes.is_empty())
            .map(|f| f.value.clone())
    }

    #[test]
    fn parses_fields() {
        let view = parse(Some(SAMPLE));
        assert!(view.error.is_none());
        assert_eq!(view.root, "MIUI-Theme");
        assert_eq!(value(&view, "title").as_deref(), Some("Old & Gold"));
        assert_eq!(value(&view, "author").as_deref(), Some(""));
        assert_eq!(view.fields.iter().filter(|f| f.name == "title").count(), 2);
    }

    #[test]
    fn updates_preserve_everything_else() {
        let updates = vec![
            FieldUpdate {
                name: "title".into(),
                value: "New <Theme>".into(),
            },
            FieldUpdate {
                name: "author".into(),
                value: "Me".into(),
            },
            FieldUpdate {
                name: "version".into(),
                value: "2.0".into(),
            },
        ];
        let out = update(Some(SAMPLE), &updates).unwrap();
        assert!(out.starts_with("<?xml version='1.0' encoding='utf-8' standalone='yes' ?>"));
        assert!(out.contains("<!-- keep me -->"));
        assert!(out.contains("<title>New &lt;Theme&gt;</title>"));
        assert!(out.contains("<title xml:lang=\"zh_CN\">旧</title>"));
        assert!(out.contains("<custom>x</custom>"));
        assert!(out.contains("<author>Me</author>"));
        assert!(
            out.contains("\n<version>2.0</version>\n</MIUI-Theme>"),
            "{out}"
        );
        let view = parse(Some(&out));
        assert_eq!(value(&view, "title").as_deref(), Some("New <Theme>"));
        assert_eq!(value(&view, "version").as_deref(), Some("2.0"));
    }

    #[test]
    fn update_is_noop_for_same_values() {
        let out = update(
            Some(SAMPLE),
            &[FieldUpdate {
                name: "designer".into(),
                value: "D".into(),
            }],
        )
        .unwrap();
        assert_eq!(out, SAMPLE);
    }

    #[test]
    fn keeps_indentation_style() {
        let xml = "<MIUI-Theme>\n  <title>A</title>\n</MIUI-Theme>";
        let out = update(
            Some(xml),
            &[FieldUpdate {
                name: "author".into(),
                value: "B".into(),
            }],
        )
        .unwrap();
        assert_eq!(
            out,
            "<MIUI-Theme>\n  <title>A</title>\n  <author>B</author>\n</MIUI-Theme>"
        );
    }

    #[test]
    fn rejects_bad_input() {
        assert!(update(Some("<a><b></a>"), &[]).is_err());
        assert!(update(
            Some(SAMPLE),
            &[FieldUpdate {
                name: "bad name".into(),
                value: "".into()
            }]
        )
        .is_err());
        assert!(check_well_formed("<a/><b/>").is_err());
        assert!(check_well_formed("<a>").is_err());
        assert!(check_well_formed("\u{feff}<a/>").is_ok());
    }

    #[test]
    fn creates_default_when_missing() {
        let out = update(
            None,
            &[FieldUpdate {
                name: "title".into(),
                value: "T".into(),
            }],
        )
        .unwrap();
        assert_eq!(value(&parse(Some(&out)), "title").as_deref(), Some("T"));
    }
}
