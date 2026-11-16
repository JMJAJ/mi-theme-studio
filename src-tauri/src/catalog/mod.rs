//! Read-only discovery of the public Theme Manager catalog.
//!
//! Only two list routes are called; both were verified to answer anonymous
//! GET requests:
//! - `/app/v9/uipages?pageCategory=THEME…` — the theme home shelves
//! - `/app/v9/uipages/classification?pageCategory=HYBRID…` — category cards
//!
//! The host and paths are fixed here; the UI can only choose which of the two
//! routes to load and the pagination offset. No account, device or user data
//! is sent. Product lists for shelves and theme downloads are **not**
//! implemented: in verified calls shelves return `products: []`, and the
//! marketplace download/rights routes (`/thm/download`, `/thm/drm/issue`)
//! are deliberately never called — paid/DRM gates are not bypassed.

use crate::error::{AppError, AppResult};
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

pub const API_HOST: &str = "https://api.zhuti.intl.xiaomi.com";
const SHELVES_PATH: &str = "/app/v9/uipages";
const CATEGORIES_PATH: &str = "/app/v9/uipages/classification";
pub const PAGE_SIZE: u32 = 20;
const MAX_BODY: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CatalogSource {
    Shelves,
    Categories,
}

impl CatalogSource {
    pub fn url(self, card_start: u32) -> String {
        match self {
            CatalogSource::Shelves => format!(
                "{API_HOST}{SHELVES_PATH}?cardCount={PAGE_SIZE}&pageCategory=THEME&cardStart={card_start}&isDeep=true&apiVersion=1"
            ),
            CatalogSource::Categories => {
                format!("{API_HOST}{CATEGORIES_PATH}?cardCount={PAGE_SIZE}&pageCategory=HYBRID&cardStart={card_start}")
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogLink {
    /// `UI_PAGE`, `EXTERNAL_HREF`, ...
    pub kind: Option<String>,
    pub target: Option<String>,
    pub title: Option<String>,
    /// `THEME`, `FONT`, `WALLPAPER`, ...
    pub product_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogItem {
    pub title: Option<String>,
    pub image_url: Option<String>,
    pub dark_image_url: Option<String>,
    pub link: Option<CatalogLink>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSection {
    pub card_uuid: Option<String>,
    pub card_type: String,
    /// `shelf` (product list by subject), `banner`, `grid`, `icons`, `other`.
    pub layout: &'static str,
    pub title: Option<String>,
    pub localized_title: Option<String>,
    pub subtitle: Option<String>,
    pub subject_uuid: Option<String>,
    pub product_count: Option<u64>,
    pub product_count_per_card: Option<u64>,
    /// Products embedded in the card (empty in all verified responses).
    pub products_returned: usize,
    /// The service's own visibility flag for this card.
    pub visible: bool,
    pub image_url: Option<String>,
    pub link: Option<CatalogLink>,
    pub items: Vec<CatalogItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPage {
    pub source: CatalogSource,
    pub endpoint: String,
    pub title: Option<String>,
    pub page_uuid: Option<String>,
    pub language: Option<String>,
    pub has_more: bool,
    pub card_start: u32,
    pub next_start: u32,
    pub sections: Vec<CatalogSection>,
    pub fetched_at_ms: u64,
    pub duration_ms: u64,
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Accept only HTTPS images from Xiaomi's market CDN; everything else is
/// dropped so the UI never loads arbitrary remote URLs from API data.
pub fn safe_image_url(value: Option<String>) -> Option<String> {
    let url = value?;
    let rest = url.strip_prefix("https://")?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.contains('@') || host.contains(':') {
        return None;
    }
    let allowed = host == "mi-img.com" || host.ends_with(".mi-img.com");
    allowed.then_some(url)
}

fn parse_link(value: Option<&Value>) -> Option<CatalogLink> {
    let value = value?;
    if !value.is_object() {
        return None;
    }
    let link = CatalogLink {
        kind: text(value, "type"),
        target: text(value, "link"),
        title: text(value, "title"),
        product_type: text(value, "productType"),
    };
    (link.kind.is_some() || link.target.is_some()).then_some(link)
}

fn parse_item(value: &Value) -> Option<CatalogItem> {
    if !value.is_object() {
        return None;
    }
    let item = CatalogItem {
        title: text(value, "title").or_else(|| value.get("link").and_then(|l| text(l, "title"))),
        image_url: safe_image_url(text(value, "imageUrl").or_else(|| text(value, "iconUrl"))),
        dark_image_url: safe_image_url(text(value, "iconDarkModeUrl")),
        link: parse_link(value.get("link")),
    };
    (item.image_url.is_some() || item.link.is_some()).then_some(item)
}

fn layout_of(card_type: &str, subject: bool) -> &'static str {
    if subject || card_type.ends_with("_LIST") {
        "shelf"
    } else if card_type.contains("GRID") {
        "grid"
    } else if card_type == "TOP_BANNER" {
        "icons"
    } else if card_type.contains("BANNER") || card_type.contains("AD_BIG") {
        "banner"
    } else {
        "other"
    }
}

pub fn parse_page(body: &str, source: CatalogSource, card_start: u32) -> AppResult<CatalogPage> {
    let json: Value = serde_json::from_str(body).map_err(|e| {
        AppError::new(
            "catalog",
            format!("The catalog response is not valid JSON: {e}"),
        )
    })?;
    let code = json
        .get("apiCode")
        .map(|c| {
            c.as_str()
                .map(str::to_string)
                .unwrap_or_else(|| c.to_string())
        })
        .unwrap_or_default();
    if code != "0" {
        let message = text(&json, "apiMessage").unwrap_or_else(|| "unknown error".into());
        return Err(AppError::new(
            "catalog_api",
            format!("The catalog service returned {message} (apiCode {code})."),
        ));
    }
    let data = json
        .get("apiData")
        .ok_or_else(|| AppError::new("catalog", "The catalog response has no data."))?;
    let cards = data
        .get("cards")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut sections = Vec::with_capacity(cards.len());
    for card in &cards {
        let card_type = text(card, "cardType").unwrap_or_else(|| "UNKNOWN".into());
        let subject_uuid = text(card, "subjectUuid");
        let mut items = Vec::new();
        for key in ["gridBanners", "banners", "iconGroups", "items"] {
            if let Some(list) = card.get(key).and_then(Value::as_array) {
                for entry in list {
                    // iconGroups is a list of lists.
                    match entry.as_array() {
                        Some(group) => items.extend(group.iter().filter_map(parse_item)),
                        None => items.extend(parse_item(entry)),
                    }
                }
            }
        }
        sections.push(CatalogSection {
            card_uuid: text(card, "cardUuid"),
            layout: layout_of(&card_type, subject_uuid.is_some()),
            card_type,
            title: text(card, "title"),
            localized_title: text(card, "i18nTitle"),
            subtitle: text(card, "subTitle"),
            subject_uuid,
            product_count: card.get("productCount").and_then(Value::as_u64),
            product_count_per_card: card.get("productCountPerCard").and_then(Value::as_u64),
            products_returned: card
                .get("products")
                .and_then(Value::as_array)
                .map_or(0, Vec::len),
            visible: card.get("visible").and_then(Value::as_bool).unwrap_or(true),
            image_url: safe_image_url(text(card, "imageUrl")),
            link: parse_link(card.get("link")),
            items,
        });
    }
    let has_more = data
        .get("hasMore")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok(CatalogPage {
        source,
        endpoint: source.url(card_start),
        title: text(data, "title"),
        page_uuid: text(data, "uuid"),
        language: text(data, "language"),
        has_more,
        card_start,
        next_start: card_start + cards.len() as u32,
        sections,
        fetched_at_ms: crate::storage::now_ms(),
        duration_ms: 0,
    })
}

pub fn fetch(source: CatalogSource, card_start: u32, user_agent: &str) -> AppResult<CatalogPage> {
    if card_start > 2000 {
        return Err(AppError::invalid("Invalid catalog offset."));
    }
    let url = source.url(card_start);
    let started = std::time::Instant::now();
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(20)))
        .http_status_as_error(false)
        .user_agent(user_agent)
        .build()
        .into();
    let mut response = agent
        .get(&url)
        .header("Accept", "application/json")
        .call()
        .map_err(|e| {
            AppError::new(
                "network",
                format!("Could not reach the catalog service: {e}"),
            )
        })?;
    let status = response.status();
    let body = response
        .body_mut()
        .with_config()
        .limit(MAX_BODY)
        .read_to_string()
        .map_err(|e| {
            AppError::new(
                "network",
                format!("Could not read the catalog response: {e}"),
            )
        })?;
    if !status.is_success() {
        return Err(AppError::new(
            "http",
            format!("The catalog service answered HTTP {}.", status.as_u16()),
        ));
    }
    let mut page = parse_page(&body, source, card_start)?;
    page.duration_ms = started.elapsed().as_millis() as u64;
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Synthetic fixture shaped like the verified responses (not a copy of them).
    const FIXTURE: &str = r#"{
      "apiCode": "0", "apiMessage": "success",
      "apiData": {
        "hasMore": true, "title": "Themes", "uuid": "page-1", "language": "en",
        "cards": [
          {"cardType": "TOP_BANNER", "cardUuid": "c0", "visible": true,
           "iconGroups": [[{"iconUrl": "https://t17.market.mi-img.com/thumbnail/webp/w0q90/ThemeMarket/a",
                            "iconDarkModeUrl": "https://evil.example.com/x.png",
                            "link": {"title": "New", "link": "u-1", "type": "UI_PAGE", "productType": "THEME"}}]]},
          {"cardType": "THEME_SLIDE_LIST", "cardUuid": "c1", "title": "Sweet pets", "i18nTitle": "x",
           "subjectUuid": "s-1", "productCount": 0, "visible": true},
          {"cardType": "FOUR_GRID_BANNER_WITH_SIZE", "cardUuid": "c2", "title": "Fonts", "visible": false,
           "gridBanners": [{"title": "", "imageUrl": "http://t17.market.mi-img.com/insecure",
                            "link": {"title": "Bold", "link": "u-2", "type": "UI_PAGE", "productType": "FONT"}}]},
          {"cardType": "TEXT_IMAGE_BANNER", "title": "Widgets",
           "imageUrl": "https://t17.market.mi-img.com/thumbnail/webp/w999q90/ThemeMarket/b",
           "link": {"title": "Widgets", "link": "widget://picker", "type": "EXTERNAL_HREF"}}
        ]
      }
    }"#;

    #[test]
    fn parses_cards_into_sections() {
        let page = parse_page(FIXTURE, CatalogSource::Shelves, 20).unwrap();
        assert!(page.has_more);
        assert_eq!(page.next_start, 24);
        assert_eq!(page.sections.len(), 4);
        let icons = &page.sections[0];
        assert_eq!(icons.layout, "icons");
        assert_eq!(icons.items[0].title.as_deref(), Some("New"));
        assert!(icons.items[0].image_url.is_some());
        assert!(
            icons.items[0].dark_image_url.is_none(),
            "non-CDN host is dropped"
        );
        let shelf = &page.sections[1];
        assert_eq!(shelf.layout, "shelf");
        assert_eq!(shelf.subject_uuid.as_deref(), Some("s-1"));
        let grid = &page.sections[2];
        assert_eq!(grid.layout, "grid");
        assert!(!grid.visible);
        assert_eq!(
            grid.items[0].title.as_deref(),
            Some("Bold"),
            "falls back to link title"
        );
        assert!(grid.items[0].image_url.is_none(), "plain http is dropped");
        assert_eq!(page.sections[3].layout, "banner");
        assert_eq!(
            page.sections[3].link.as_ref().unwrap().kind.as_deref(),
            Some("EXTERNAL_HREF")
        );
    }

    #[test]
    fn reports_api_errors() {
        let error = parse_page(
            r#"{"apiCode":"-1","apiMessage":"ARGUMENT_ERROR"}"#,
            CatalogSource::Shelves,
            0,
        )
        .unwrap_err();
        assert_eq!(error.code, "catalog_api");
        assert!(error.message.contains("ARGUMENT_ERROR"));
        assert_eq!(
            parse_page("<html>", CatalogSource::Shelves, 0)
                .unwrap_err()
                .code,
            "catalog"
        );
    }

    #[test]
    fn urls_are_fixed_and_uppercase() {
        let url = CatalogSource::Shelves.url(0);
        assert!(url.starts_with("https://api.zhuti.intl.xiaomi.com/app/v9/uipages?"));
        assert!(url.contains("pageCategory=THEME"));
        assert!(
            CatalogSource::Categories
                .url(0)
                .contains("/classification?")
                && CatalogSource::Categories.url(0).contains("HYBRID")
        );
    }

    #[test]
    fn image_allowlist() {
        assert!(safe_image_url(Some("https://t17.market.mi-img.com/a".into())).is_some());
        assert!(safe_image_url(Some("https://mi-img.com.evil.io/a".into())).is_none());
        assert!(safe_image_url(Some("https://user@t17.market.mi-img.com/a".into())).is_none());
        assert!(safe_image_url(Some("javascript:alert(1)".into())).is_none());
    }

    /// `MTS_CATALOG_LIVE=1 cargo test catalog::tests::live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live() {
        if std::env::var("MTS_CATALOG_LIVE").as_deref() != Ok("1") {
            return;
        }
        for source in [CatalogSource::Shelves, CatalogSource::Categories] {
            let page = fetch(source, 0, "MiThemeStudio/test").unwrap();
            println!(
                "{source:?}: {} sections, hasMore={}, {}ms",
                page.sections.len(),
                page.has_more,
                page.duration_ms
            );
            for section in page.sections.iter().take(6) {
                println!(
                    "  {} {:?} items={} subject={:?}",
                    section.layout,
                    section.title,
                    section.items.len(),
                    section.subject_uuid
                );
            }
            assert!(!page.sections.is_empty());
        }
    }
}
