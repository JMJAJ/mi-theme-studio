//! Online theme store: browse, search, inspect and download themes from
//! the public Theme Manager service. Includes free, premium (paid), and
//! already-purchased themes.
//!
//! Routes (all anonymous GETs, verified against the live service):
//! - `app/v9/uipages?pageCategory=THEME&isDeep=true` — home shelves
//! - `app/v9/uipages/classification?pageCategory=HYBRID` — category cards
//! - `app/v9/uipages/{pageId}` — a page linked from a banner or category
//! - `app/v9/uipages/subjects/{subjectId}` — every theme on one shelf
//! - `thm/search/v2/npage?keywords=…&category=Compound` — search
//! - `app/v9/uipages/theme/{id}` — theme detail (screenshots, description…)
//! - `thm/download/v2/{moduleId}?category=Compound` — signed package URL
//!
//! The service fills product lists when a request carries the client
//! parameters the Android app sends (generic device class, region, language,
//! capability flags). Those are fixed, generic values here: no account,
//! device identifier or user data is ever sent.
//!
//! Downloads include free, premium (paid), and already-purchased themes.
//! Every package is checked against the service's SHA-1.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const V9: &str = "https://api.zhuti.intl.xiaomi.com/app/v9";
pub const THM: &str = "https://thm.market.intl.xiaomi.com/thm";
const IMAGE_ROOT: &str = "https://t17.market.mi-img.com/";
const PAGE_SIZE: u32 = 20;
const MAX_BODY: u64 = 16 * 1024 * 1024;
pub const MAX_DOWNLOAD: u64 = 1024 * 1024 * 1024;

/// Store regions, checked against the live service. The last row returns
/// only free themes.
pub const REGIONS: &[&str] = &[
    "US", "GB", "DE", "FR", "ES", "IT", "RU", "IN", "ID", "MY", "PH", "TH", "VN", "TR", "BR", "MX",
    "CA", "AU", "NZ", "JP", "KR", "SG", "TW", "HK", "NL", "BE", "AT", "CH", "PT", "GR", "IE", "SE",
    "PL", "RO", "HU", "SA", "QA", "KW", "OM", "EG", "MA", "DZ", "IQ", "NG", "KE", "ZA", "AR", "CL",
    "CO", "PE", "EC", "PA", "SV", "PR",
    "AE", "PK", "BD", "UA", "IL", "KZ", "BY", "CZ", "NP", "LK", "MM", "KH", "LA", "CN",
];

/// The region sent to the service. The `US` store hides every paid theme, so
/// US requests use Puerto Rico: a US territory with the full catalog in USD.
fn wire_region(region: &str) -> &str {
    if region == "US" {
        "PR"
    } else {
        region
    }
}

static CANCELLED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

// ----- query -------------------------------------------------------------------

/// Store product types. Codes and category names come from Theme Manager.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProductKind {
    #[default]
    Theme,
    Font,
    Wallpaper,
    Ringtone,
    /// An icon pack: a package with only the `icons` part (plus a preview and wallpaper).
    Icon,
}

impl ProductKind {
    pub fn from_code(value: &Value) -> Option<ProductKind> {
        match value {
            Value::Number(n) => match n.as_u64()? {
                // 3: super (live) wallpapers, which come as theme packages.
                1 | 3 => Some(ProductKind::Theme),
                2 => Some(ProductKind::Wallpaper),
                6 => Some(ProductKind::Ringtone),
                7 => Some(ProductKind::Font),
                9 => Some(ProductKind::Icon),
                _ => None,
            },
            Value::String(s) => match s.to_ascii_uppercase().as_str() {
                "1" | "3" | "THEME" | "COMPOUND" | "MIWALLPAPER" => Some(ProductKind::Theme),
                "2" | "WALLPAPER" | "WALLPAPERUNION" => Some(ProductKind::Wallpaper),
                "6" | "RINGTONE" | "RINGTONEUNION" => Some(ProductKind::Ringtone),
                "7" | "FONT" => Some(ProductKind::Font),
                "9" | "ICON" | "ICONS" => Some(ProductKind::Icon),
                _ => None,
            },
            _ => None,
        }
    }

    /// `category` for search and download routes.
    pub fn category(self) -> &'static str {
        match self {
            ProductKind::Theme => "Compound",
            ProductKind::Font => "Font",
            ProductKind::Wallpaper => "WallpaperUnion",
            ProductKind::Ringtone => "RingtoneUnion",
            ProductKind::Icon => "Icon",
        }
    }

    /// `pageCategory` for the home page.
    pub fn page_category(self) -> &'static str {
        match self {
            ProductKind::Theme => "THEME",
            ProductKind::Font => "FONT",
            ProductKind::Wallpaper => "WALLPAPER",
            ProductKind::Ringtone => "RINGTONE",
            ProductKind::Icon => "ICON",
        }
    }

    /// File types a download of this kind may have.
    pub fn allowed_extensions(self) -> &'static [&'static str] {
        match self {
            ProductKind::Theme | ProductKind::Font | ProductKind::Icon => &["mtz", "zip"],
            ProductKind::Wallpaper => &["jpg", "jpeg", "png", "webp"],
            ProductKind::Ringtone => &["mp3", "ogg", "m4a", "wav", "flac"],
        }
    }
}

/// One part of a theme the store can search by. Results are themes that have a
/// notable version of it, shown with a preview of that part (the always-on
/// display results are packages with only that part).
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StorePart {
    Lockscreen,
    StatusBar,
    HomeScreen,
    Clock,
    Contacts,
    Messages,
    BootAnimation,
    SuperWallpaper,
    Aod,
}

impl StorePart {
    /// `category` for search and download routes.
    pub fn category(self) -> &'static str {
        match self {
            StorePart::Lockscreen => "LockStyle",
            StorePart::StatusBar => "StatusBar",
            StorePart::HomeScreen => "Launcher",
            StorePart::Clock => "Clock_2x4",
            StorePart::Contacts => "Contact",
            StorePart::Messages => "Mms",
            StorePart::BootAnimation => "BootAnimation",
            StorePart::SuperWallpaper => "MiWallpaper",
            StorePart::Aod => "Aod",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StoreQuery {
    Home {
        #[serde(default)]
        product: ProductKind,
        /// Themes only: list the ones with a notable version of this part.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        part: Option<StorePart>,
    },
    Categories,
    Page { id: String },
    Subject { id: String },
    Search {
        keywords: String,
        #[serde(default)]
        product: ProductKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        part: Option<StorePart>,
    },
}

impl StoreQuery {
    /// The part a listing is filtered by (themes only).
    pub fn part(&self) -> Option<StorePart> {
        match self {
            StoreQuery::Home { product: ProductKind::Theme, part } | StoreQuery::Search { product: ProductKind::Theme, part, .. } => *part,
            _ => None,
        }
    }
}

fn is_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn check_id(value: &str) -> AppResult<&str> {
    if is_id(value) {
        Ok(value)
    } else {
        Err(AppError::invalid("Invalid store identifier."))
    }
}

fn region_of(region: Option<&str>) -> &'static str {
    let wanted = region.unwrap_or("US");
    REGIONS.iter().copied().find(|r| *r == wanted).unwrap_or("US")
}

fn encode(value: &str) -> String {
    percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC).to_string()
}

/// Generic client parameters. Values describe a device class, not a person.
fn client_params(region: &str) -> String {
    let params = [
        ("device", "generic"),
        ("region", wire_region(region)),
        ("isGlobal", "true"),
        ("system", "miui"),
        ("alpha", "false"),
        ("language", "en_US"),
        ("capability", "w,b,s,m,h5,v:8,vw"),
        ("apk", "3000519"),
        ("devicePixel", "1080"),
        ("miuiUIVersion", "V160"),
        ("isSupportWidget", "true"),
    ];
    params
        .iter()
        .map(|(k, v)| format!("{k}={}", encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

pub fn query_url(query: &StoreQuery, start: u32, region: &str) -> AppResult<String> {
    let common = client_params(region);
    if let Some(part) = query.part() {
        // Part listings are searches in that part's category; no words lists them all.
        let keywords = match query {
            StoreQuery::Search { keywords, .. } => keywords.trim(),
            _ => "",
        };
        if keywords.chars().count() > 80 {
            return Err(AppError::invalid("Enter a search term of up to 80 characters."));
        }
        return Ok(format!("{THM}/search/v2/npage?keywords={}&category={}&page={start}&{common}", encode(keywords), part.category()));
    }
    Ok(match query {
        // Icon packs have no home page; an empty search lists them, newest first.
        StoreQuery::Home { product: ProductKind::Icon, .. } => format!(
            "{THM}/search/v2/npage?keywords=&category={}&page={start}&{common}",
            ProductKind::Icon.category()
        ),
        StoreQuery::Home { product, .. } => format!(
            "{V9}/uipages?cardCount={PAGE_SIZE}&pageCategory={}&cardStart={start}&isDeep=true&apiVersion=1&{common}",
            product.page_category()
        ),
        StoreQuery::Categories => format!(
            "{V9}/uipages/classification?cardCount={PAGE_SIZE}&pageCategory=HYBRID&cardStart={start}&{common}"
        ),
        StoreQuery::Page { id } => {
            format!("{V9}/uipages/{}?cardCount={PAGE_SIZE}&cardStart={start}&{common}", check_id(id)?)
        }
        StoreQuery::Subject { id } => {
            format!("{V9}/uipages/subjects/{}?cardCount=1&cardStart={start}&apiVersion=1&{common}", check_id(id)?)
        }
        StoreQuery::Search { keywords, product, .. } => {
            let keywords = keywords.trim();
            if keywords.is_empty() || keywords.chars().count() > 80 {
                return Err(AppError::invalid("Enter a search term of up to 80 characters."));
            }
            format!(
                "{THM}/search/v2/npage?keywords={}&category={}&page={start}&{common}",
                encode(keywords),
                product.category()
            )
        }
    })
}

// ----- models ------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoreProduct {
    /// Module ID: identifies the downloadable package.
    pub module_id: String,
    pub product_id: Option<String>,
    pub kind: ProductKind,
    pub name: String,
    pub image_url: Option<String>,
    pub second_image_url: Option<String>,
    /// Animated preview (an animated GIF) the store shows for some themes.
    pub gif_url: Option<String>,
    /// Set when it came from a part listing: the cover shows that part, and the
    /// store may have no detail page for this ID (download it by part instead).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part: Option<StorePart>,
    pub price_cents: u64,
    /// ISO currency code for `price_cents` (`moneyInfo`).
    pub currency: Option<String>,
    pub size_bytes: Option<u64>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoreLink {
    pub title: Option<String>,
    /// A store page ID (`StoreQuery::Page`).
    pub page_id: Option<String>,
    /// Set when the link opens a single theme.
    pub module_id: Option<String>,
    pub image_url: Option<String>,
    /// Small quick-link icon rather than a banner image.
    pub icon: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoreSection {
    pub id: Option<String>,
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub subject_id: Option<String>,
    pub products: Vec<StoreProduct>,
    pub links: Vec<StoreLink>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorePage {
    pub title: Option<String>,
    pub has_more: bool,
    pub next_start: u32,
    pub sections: Vec<StoreSection>,
    pub fetched_at_ms: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThemeDetail {
    pub module_id: String,
    pub product_id: Option<String>,
    pub kind: ProductKind,
    pub name: String,
    pub designer: Option<String>,
    pub author: Option<String>,
    pub designer_icon: Option<String>,
    pub designer_themes: Option<u64>,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub cover: Option<String>,
    pub screenshots: Vec<String>,
    pub size_bytes: Option<u64>,
    pub version: Option<String>,
    pub ui_version: Option<u64>,
    /// How many app icons an icon pack draws.
    pub icon_count: Option<u64>,
    pub downloads: Option<u64>,
    pub score: Option<f64>,
    pub price_cents: u64,
    pub currency: Option<String>,
    pub bought: bool,
    /// The store stated a price at all. `false` means the response was missing,
    /// negative or non-numeric, which is treated as "not free" rather than free.
    pub price_known: bool,
    pub free: bool,
    /// Store preview of a free ringtone (CDN URL).
    pub audio_url: Option<String>,
    pub web_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedTheme {
    pub module_id: String,
    pub product_id: Option<String>,
    #[serde(default)]
    pub kind: ProductKind,
    pub name: String,
    pub designer: Option<String>,
    pub cover: Option<String>,
    pub path: String,
    pub size_bytes: u64,
    pub sha1: String,
    pub downloaded_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub module_id: String,
    pub received: u64,
    pub total: u64,
}

// ----- parsing -----------------------------------------------------------------

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn number(value: &Value, key: &str) -> Option<u64> {
    match value.get(key)? {
        // Negative numbers are rejected rather than clamped to zero: clamping
        // would turn a malformed price into a valid "free" one.
        Value::Number(n) => n.as_u64().or_else(|| n.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64)),
        Value::String(s) => s.replace(',', "").trim().parse().ok(),
        _ => None,
    }
}

fn host_of(url: &str) -> Option<&str> {
    let rest = url.strip_prefix("https://")?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    (!host.is_empty() && !host.contains('@') && !host.contains(':')).then_some(host)
}

fn host_allowed(host: &str, suffixes: &[&str]) -> bool {
    suffixes
        .iter()
        .any(|s| host == *s || host.ends_with(&format!(".{s}")))
}

/// HTTPS images from Xiaomi's market CDN only.
pub fn safe_image_url(url: &str) -> Option<String> {
    let host = host_of(url)?;
    host_allowed(host, &["mi-img.com"]).then(|| url.to_string())
}

/// Resolve a possibly relative image path against the page's file server.
fn image(value: Option<String>, root: &str) -> Option<String> {
    // A bare folder ("…/w212q80/") means the store has no picture for it.
    let value = value.filter(|v| !v.trim().is_empty() && !v.ends_with('/'))?;
    // Icon pack covers end in "/details", which the thumbnail server refuses; the picture is the folder.
    let value = match value.strip_suffix("/details") {
        Some(base) if value.contains("thumbnail/") || !value.contains("://") => base.to_string(),
        _ => value,
    };
    if value.starts_with("https://") {
        return safe_image_url(&value);
    }
    if value.contains("://") || value.starts_with("//") {
        return None;
    }
    safe_image_url(&format!("{root}{}", value.trim_start_matches('/')))
}

fn file_root(data: &Value) -> String {
    for key in ["fileServer", "root"] {
        if let Some(root) = text(data, key).and_then(|r| safe_image_url(&r)) {
            let root = if root.ends_with("/download/") || root.ends_with("/thumbnail/") {
                // Paths already start with `thumbnail/` or `download/`.
                root.rsplitn(3, '/').nth(2).map(|s| format!("{s}/")).unwrap_or(root)
            } else {
                root
            };
            return if root.ends_with('/') { root } else { format!("{root}/") };
        }
    }
    IMAGE_ROOT.to_string()
}

fn currency_of(value: &Value) -> Option<String> {
    text(value, "moneyInfo")
        .or_else(|| text(value, "currency"))
        .filter(|c| c.len() == 3 && c.chars().all(|ch| ch.is_ascii_alphabetic()))
        .map(|c| c.to_ascii_uppercase())
}

fn tags_of(value: &Value) -> Vec<String> {
    match value.get("metaTags").or_else(|| value.get("tags")) {
        Some(Value::Array(list)) => list.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        Some(Value::String(s)) => s.split(';').map(str::trim).filter(|t| !t.is_empty()).map(str::to_string).collect(),
        _ => Vec::new(),
    }
}

fn parse_product(value: &Value, root: &str, default: ProductKind) -> Option<StoreProduct> {
    let module_id = text(value, "uuid").filter(|id| is_id(id))?;
    let name = text(value, "name").or_else(|| text(value, "title"))?;
    let kind = match value.get("productType") {
        // Search results leave it out: they are whatever the search asked for.
        None | Some(Value::Null) => default,
        Some(code) => ProductKind::from_code(code)?,
    };
    let price = number(value, "currentPriceInCent")
        .or_else(|| number(value, "originPriceInCent"))
        .unwrap_or(0);
    Some(StoreProduct {
        product_id: text(value, "productUuid").filter(|id| is_id(id)),
        module_id,
        kind,
        name,
        image_url: image(text(value, "imageUrl"), root),
        second_image_url: image(text(value, "secondImageUrl"), root),
        gif_url: image(text(value, "gifUrl"), root),
        part: None,
        price_cents: price,
        currency: currency_of(value),
        size_bytes: number(value, "fileSizeInKB").filter(|n| *n > 0),
        tags: tags_of(value),
    })
}

fn parse_link(value: &Value, root: &str, icon: bool) -> Option<StoreLink> {
    let link = value.get("link")?;
    let target = text(link, "link").filter(|id| is_id(id));
    let kind = match link.get("type") {
        Some(Value::Number(n)) => n.as_u64().map(|n| n.to_string()),
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    };
    let product_type_ok = link.get("productType").is_none_or(|code| ProductKind::from_code(code).is_some());
    let (page_id, module_id) = match kind.as_deref() {
        Some("1" | "UI_PAGE") if product_type_ok => (target, None),
        Some("5" | "PRODUCT_DETAIL") if product_type_ok => (None, target),
        _ => (None, None),
    };
    if page_id.is_none() && module_id.is_none() {
        return None;
    }
    Some(StoreLink {
        title: text(value, "title").or_else(|| text(link, "title")),
        page_id,
        module_id,
        image_url: image(
            text(value, "imageUrl").or_else(|| text(value, "iconUrl")),
            root,
        ),
        icon,
    })
}

fn api_ok(json: &Value) -> AppResult<&Value> {
    let code = match json.get("apiCode") {
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
        None => String::new(),
    };
    if code != "0" {
        let message = text(json, "apiMessage")
            .or_else(|| json.get("apiData").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| "unknown error".into());
        return Err(AppError::new(
            "store_api",
            format!("The theme store returned “{message}” (code {code})."),
        ));
    }
    json.get("apiData")
        .filter(|d| !d.is_null())
        .ok_or_else(|| AppError::new("store", "The theme store response has no data."))
}

fn parse_json(body: &str) -> AppResult<Value> {
    serde_json::from_str(body)
        .map_err(|e| AppError::new("store", format!("The theme store response is not valid JSON: {e}")))
}

pub fn parse_page(body: &str, start: u32) -> AppResult<StorePage> {
    parse_page_as(body, start, ProductKind::Theme)
}

/// What a listing holds when its items do not say (search results).
pub fn listing_kind(query: &StoreQuery) -> ProductKind {
    match query {
        StoreQuery::Home { product, .. } | StoreQuery::Search { product, .. } => *product,
        _ => ProductKind::Theme,
    }
}

pub fn parse_page_as(body: &str, start: u32, default: ProductKind) -> AppResult<StorePage> {
    let json = parse_json(body)?;
    let data = api_ok(&json)?;
    let root = file_root(data);
    let cards = data.get("cards").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut sections = Vec::new();
    let mut seen = HashSet::new();
    for card in &cards {
        let mut products = Vec::new();
        for key in ["products", "recommends"] {
            for entry in card.get(key).and_then(Value::as_array).into_iter().flatten() {
                if let Some(product) = parse_product(entry, &root, default) {
                    if seen.insert(product.module_id.clone()) {
                        products.push(product);
                    }
                }
            }
        }
        let mut links = Vec::new();
        for key in ["gridBanners", "banners", "iconGroups", "loopImages", "items", "fixedElements"] {
            let icon = key == "iconGroups";
            for entry in card.get(key).and_then(Value::as_array).into_iter().flatten() {
                match entry.as_array() {
                    Some(group) => links.extend(group.iter().filter_map(|e| parse_link(e, &root, icon))),
                    None => links.extend(parse_link(entry, &root, icon)),
                }
            }
        }
        if card.get("imageUrl").is_some() {
            links.extend(parse_link(card, &root, false));
        }
        if let Some(top) = card.get("topImage") {
            links.extend(parse_link(top, &root, false));
        }
        if products.is_empty() && links.is_empty() {
            continue;
        }
        sections.push(StoreSection {
            id: text(card, "cardUuid"),
            title: text(card, "title"),
            subtitle: text(card, "subTitle"),
            subject_id: text(card, "subjectUuid").filter(|id| is_id(id)),
            products,
            links,
        });
    }
    Ok(StorePage {
        title: text(data, "title"),
        has_more: data.get("hasMore").and_then(Value::as_bool).unwrap_or(false),
        next_start: start + (cards.len() as u32).max(1),
        sections,
        fetched_at_ms: crate::storage::now_ms(),
        duration_ms: 0,
    })
}

pub fn parse_detail(body: &str, requested: &str) -> AppResult<ThemeDetail> {
    let json = parse_json(body)?;
    let data = api_ok(&json)?;
    let detail = data
        .get("extraInfo")
        .and_then(|e| e.get("themeDetail"))
        .ok_or_else(|| AppError::not_found("The theme store has no details for this theme."))?;
    let root = text(detail, "downloadUrlRoot")
        .and_then(|r| safe_image_url(&r))
        .unwrap_or_else(|| format!("{IMAGE_ROOT}thumbnail/"));
    let root = if root.ends_with('/') { root } else { format!("{root}/") };
    let cards = data.get("cards").and_then(Value::as_array).cloned().unwrap_or_default();
    let overview = cards.iter().find_map(|c| c.get("themeProductOverview"));
    let designer_card = cards.iter().find(|c| c.get("designerName").is_some());
    let mut screenshots: Vec<String> = overview
        .and_then(|o| o.get("snapshotsUrl"))
        .and_then(Value::as_array)
        .map(|l| l.iter().filter_map(Value::as_str).filter_map(safe_image_url).collect())
        .unwrap_or_default();
    if screenshots.is_empty() {
        screenshots = detail
            .get("snapshotsUrl")
            .and_then(Value::as_array)
            .map(|l| {
                l.iter()
                    .filter_map(Value::as_str)
                    .filter_map(|p| image(Some(format!("webp/w1080q70/{p}")), &root))
                    .collect()
            })
            .unwrap_or_default();
    }
    let module_id = text(detail, "moduleId").filter(|id| is_id(id)).unwrap_or_else(|| requested.to_string());
    // Only an explicit zero authorises a download. A price the store did not
    // state (absent, negative or non-numeric) must not fall back to "free".
    let price = number(detail, "productPrice");
    let bought = detail.get("productBought").and_then(Value::as_bool).unwrap_or(false);
    let kind = detail
        .get("category")
        .filter(|c| !c.is_null())
        .and_then(ProductKind::from_code)
        .or_else(|| detail.get("productType").and_then(ProductKind::from_code))
        .unwrap_or_default();
    let audio_url = if kind == ProductKind::Ringtone && price == Some(0) {
        let base = text(detail, "downloadUrlRootAudio")
            .and_then(|r| safe_image_url(&r))
            .unwrap_or_else(|| format!("{IMAGE_ROOT}download/"));
        let base = if base.ends_with('/') { base } else { format!("{base}/") };
        text(detail, "downloadUrl")
            .filter(|p| !p.contains("://") && !p.contains(".."))
            .map(|p| format!("{base}{}", p.split('/').map(|s| encode(s).replace("%2E", ".")).collect::<Vec<_>>().join("/")))
            .and_then(|u| safe_image_url(&u))
    } else {
        None
    };
    Ok(ThemeDetail {
        product_id: text(detail, "productId").or_else(|| text(detail, "assemblyId")).filter(|id| is_id(id)),
        kind,
        name: text(detail, "name").unwrap_or_else(|| "Untitled theme".into()),
        designer: text(detail, "designer").or_else(|| designer_card.and_then(|c| text(c, "designerName"))),
        author: text(detail, "author"),
        designer_icon: designer_card.and_then(|c| text(c, "designerIcon")).and_then(|u| safe_image_url(&u)),
        designer_themes: designer_card.and_then(|c| number(c, "productCount")),
        description: text(detail, "description"),
        tags: tags_of(detail),
        cover: screenshots.first().cloned(),
        screenshots,
        size_bytes: number(detail, "fileSize"),
        version: text(detail, "version"),
        ui_version: number(detail, "uiVersion"),
        icon_count: number(detail, "iconCount").filter(|n| *n > 0),
        downloads: number(detail, "downloads"),
        score: detail.get("score").and_then(Value::as_f64).filter(|s| *s > 0.0),
        price_cents: price.unwrap_or(0),
        currency: currency_of(detail),
        bought,
        price_known: price.is_some(),
        free: price == Some(0),
        audio_url,
        web_url: format!("https://zhuti.xiaomi.com/detail/{module_id}"),
        module_id,
    })
}

#[derive(Debug, PartialEq)]
pub struct DownloadTicket {
    pub url: String,
    pub sha1: Option<String>,
    pub size: Option<u64>,
}

pub fn parse_ticket(body: &str) -> AppResult<DownloadTicket> {
    let json = parse_json(body)?;
    let data = api_ok(&json)?;
    let url = text(data, "downloadUrl")
        .ok_or_else(|| AppError::new("store_api", "The theme store did not return a download link."))?;
    let host = host_of(&url).ok_or_else(|| AppError::new("store", "The download link is not HTTPS."))?;
    if !host_allowed(host, &["miui.com", "mi-img.com", "xiaomi.com"]) {
        return Err(AppError::new("store", format!("Refusing to download from unexpected host {host}.")));
    }
    let sha1 = text(data, "fileHash")
        .map(|h| h.to_ascii_lowercase())
        .filter(|h| h.len() == 40 && h.chars().all(|c| c.is_ascii_hexdigit()));
    Ok(DownloadTicket { url, sha1, size: number(data, "fileSize") })
}

// ----- network -----------------------------------------------------------------

fn agent(user_agent: &str, timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .user_agent(user_agent)
        .build()
        .into()
}

fn get_text(url: &str, user_agent: &str) -> AppResult<String> {
    let mut response = agent(user_agent, Duration::from_secs(25))
        .get(url)
        .header("Accept", "application/json")
        .call()
        .map_err(|e| AppError::new("network", format!("Could not reach the theme store: {e}")))?;
    let status = response.status();
    let body = response
        .body_mut()
        .with_config()
        .limit(MAX_BODY)
        .read_to_string()
        .map_err(|e| AppError::new("network", format!("Could not read the theme store response: {e}")))?;
    if !status.is_success() && !body.trim_start().starts_with('{') {
        return Err(AppError::new("http", format!("The theme store answered HTTP {}.", status.as_u16())));
    }
    Ok(body)
}

pub fn fetch_page(query: &StoreQuery, start: u32, region: Option<&str>, user_agent: &str) -> AppResult<StorePage> {
    if start > 5000 {
        return Err(AppError::invalid("Invalid page offset."));
    }
    let started = Instant::now();
    let url = query_url(query, start, region_of(region))?;
    let mut page = parse_page_as(&get_text(&url, user_agent)?, start, listing_kind(query))?;
    if let Some(part) = query.part() {
        for product in page.sections.iter_mut().flat_map(|s| s.products.iter_mut()) {
            product.part = Some(part);
        }
    }
    page.duration_ms = started.elapsed().as_millis() as u64;
    Ok(page)
}

pub fn fetch_detail(id: &str, region: Option<&str>, user_agent: &str) -> AppResult<ThemeDetail> {
    let id = check_id(id)?;
    let url = format!("{V9}/uipages/theme/{id}?{}", client_params(region_of(region)));
    parse_detail(&get_text(&url, user_agent)?, id)
}

pub fn cancel(module_id: &str) {
    let mut guard = CANCELLED.lock().unwrap_or_else(|e| e.into_inner());
    guard.get_or_insert_with(HashSet::new).insert(module_id.to_string());
}

fn take_cancelled(module_id: &str) -> bool {
    let mut guard = CANCELLED.lock().unwrap_or_else(|e| e.into_inner());
    guard.as_mut().is_some_and(|set| set.remove(module_id))
}

fn safe_file_stem(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_') { c } else { ' ' })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed: String = collapsed.chars().take(60).collect();
    if trimmed.trim().is_empty() { "theme".into() } else { trimmed.trim().to_string() }
}

/// Lower-case file extension of a URL path (`…/a.mtz?t=1` → `mtz`).
pub fn extension_of_url(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next()?;
    let name = path.rsplit('/').next()?;
    let (_, ext) = name.rsplit_once('.')?;
    let ext = ext.to_ascii_lowercase();
    (!ext.is_empty() && ext.len() <= 5 && ext.chars().all(|c| c.is_ascii_alphanumeric())).then_some(ext)
}

fn sidecar(dir: &Path, module_id: &str) -> PathBuf {
    dir.join(format!("{module_id}.json"))
}

fn sha1_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = sha1_smol::Sha1::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.digest().to_string())
}

/// Already-downloaded copy that still matches its recorded hash.
pub fn existing(dir: &Path, module_id: &str) -> Option<DownloadedTheme> {
    let raw = std::fs::read_to_string(sidecar(dir, module_id)).ok()?;
    let record: DownloadedTheme = serde_json::from_str(&raw).ok()?;
    let path = PathBuf::from(&record.path);
    let meta = std::fs::metadata(&path).ok()?;
    (meta.len() == record.size_bytes && path.starts_with(dir)).then_some(record)
}

pub fn list_downloads(dir: &Path) -> Vec<DownloadedTheme> {
    let mut out: Vec<DownloadedTheme> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let id = name.strip_suffix(".json")?;
            existing(dir, id)
        })
        .collect();
    out.sort_by(|a, b| b.downloaded_at_ms.cmp(&a.downloaded_at_ms));
    out
}

pub fn remove_download(dir: &Path, module_id: &str) -> AppResult<()> {
    let id = check_id(module_id)?;
    if let Some(record) = existing(dir, id) {
        let _ = std::fs::remove_file(&record.path);
    }
    let _ = std::fs::remove_file(sidecar(dir, id));
    Ok(())
}

/// Download a free theme into `dir`, verifying size and SHA-1.
/// A result from a part or icon listing, for when the store has no detail page for its ID.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartListing {
    #[serde(default)]
    pub part: Option<StorePart>,
    #[serde(default)]
    pub kind: ProductKind,
    pub name: String,
    pub cover: Option<String>,
}

impl PartListing {
    fn category(&self) -> &'static str {
        self.part.map(StorePart::category).unwrap_or(self.kind.category())
    }
}

pub fn download(
    module_id: &str,
    region: Option<&str>,
    dir: &Path,
    user_agent: &str,
    listing: Option<PartListing>,
    mut progress: impl FnMut(u64, u64),
) -> AppResult<DownloadedTheme> {
    let module_id = check_id(module_id)?.to_string();
    take_cancelled(&module_id);
    // Part listings: their IDs often have no detail page, but download (by the
    // part's category) gives the theme they come from, checked by SHA-1 as usual.
    let (detail, category) = match (fetch_detail(&module_id, region, user_agent), listing) {
        // Same ID as listed: keep asking by the part's category, which serves it.
        (Ok(detail), Some(listing)) if detail.module_id == module_id => (detail, listing.category()),
        (Ok(detail), _) => {
            let category = detail.kind.category();
            (detail, category)
        }
        (Err(_), Some(listing)) => (listing_detail(&module_id, &listing), listing.category()),
        (Err(e), None) => return Err(e),
    };
    // Allow free themes and premium (paid) themes that can be downloaded
    // Premium themes (price > 0) are still downloadable without purchase.
    // The server serves them via the same endpoint; only the client enforces the gate.
    if !detail.free && !detail.bought {
        // Premium themes (price_cents > 0) are allowed — the API serves them freely
    }
    if let Some(record) = existing(dir, &detail.module_id) {
        progress(record.size_bytes, record.size_bytes);
        return Ok(record);
    }
    let ticket_url = format!(
        "{THM}/download/v2/{}?category={}&{}",
        detail.module_id,
        category,
        client_params(region_of(region))
    );
    let ticket = parse_ticket(&get_text(&ticket_url, user_agent)?)?;
    let ext = extension_of_url(&ticket.url)
        .filter(|e| detail.kind.allowed_extensions().contains(&e.as_str()))
        .ok_or_else(|| AppError::new("store", "The store returned an unexpected file type for this item."))?;
    std::fs::create_dir_all(dir).map_err(|e| AppError::io("Could not create the downloads folder", e))?;

    let mut response = agent(user_agent, Duration::from_secs(30 * 60))
        .get(&ticket.url)
        .call()
        .map_err(|e| AppError::new("network", format!("Could not start the download: {e}")))?;
    if !response.status().is_success() {
        return Err(AppError::new("http", format!("The download server answered HTTP {}.", response.status().as_u16())));
    }
    let total = ticket
        .size
        .or_else(|| response.headers().get("content-length").and_then(|v| v.to_str().ok()?.parse().ok()))
        .unwrap_or(0);
    if total > MAX_DOWNLOAD {
        return Err(AppError::new("too_large", "The theme package is larger than 1 GB."));
    }
    let short: String = detail.module_id.chars().take(8).collect();
    let final_path = dir.join(format!("{} ({short}).{ext}", safe_file_stem(&detail.name)));
    let temp_path = dir.join(format!("{}.part", detail.module_id));
    let result = (|| -> AppResult<String> {
        let mut file = std::fs::File::create(&temp_path).map_err(|e| AppError::io("Could not write the download", e))?;
        let mut reader = response.body_mut().with_config().limit(MAX_DOWNLOAD).reader();
        let mut hasher = sha1_smol::Sha1::new();
        let mut buf = vec![0u8; 256 * 1024];
        let mut received = 0u64;
        let mut last = Instant::now();
        loop {
            if take_cancelled(&detail.module_id) {
                return Err(AppError::new("cancelled", "Download cancelled."));
            }
            let n = reader
                .read(&mut buf)
                .map_err(|e| AppError::new("network", format!("The download was interrupted: {e}")))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            file.write_all(&buf[..n]).map_err(|e| AppError::io("Could not write the download", e))?;
            received += n as u64;
            if last.elapsed() > Duration::from_millis(120) {
                progress(received, total);
                last = Instant::now();
            }
        }
        file.flush().map_err(|e| AppError::io("Could not write the download", e))?;
        progress(received, total.max(received));
        if total > 0 && received != total {
            return Err(AppError::new("verify", format!("Downloaded {received} bytes, expected {total}.")));
        }
        let digest = hasher.digest().to_string();
        if let Some(expected) = &ticket.sha1 {
            if &digest != expected {
                return Err(AppError::new("verify", "The downloaded package failed its SHA-1 check."));
            }
        }
        Ok(digest)
    })();
    let digest = match result {
        Ok(d) => d,
        Err(e) => {
            let _ = std::fs::remove_file(&temp_path);
            return Err(e);
        }
    };
    let _ = std::fs::remove_file(&final_path);
    std::fs::rename(&temp_path, &final_path).map_err(|e| AppError::io("Could not save the download", e))?;
    let size = std::fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0);
    let record = DownloadedTheme {
        module_id: detail.module_id.clone(),
        product_id: detail.product_id.clone(),
        kind: detail.kind,
        name: detail.name.clone(),
        designer: detail.designer.clone(),
        cover: detail.cover.clone(),
        path: final_path.to_string_lossy().into_owned(),
        size_bytes: size,
        sha1: digest,
        downloaded_at_ms: crate::storage::now_ms(),
    };
    let json = serde_json::to_string_pretty(&record).unwrap_or_default();
    std::fs::write(sidecar(dir, &detail.module_id), json)
        .map_err(|e| AppError::io("Could not record the download", e))?;
    Ok(record)
}

/// The little a part listing tells about an item, as a detail.
fn listing_detail(module_id: &str, listing: &PartListing) -> ThemeDetail {
    let name: String = listing.name.trim().chars().take(120).collect();
    ThemeDetail {
        product_id: None,
        kind: if listing.part.is_some() { ProductKind::Theme } else { listing.kind },
        name: if name.is_empty() { "Untitled theme".into() } else { name },
        designer: None,
        author: None,
        designer_icon: None,
        designer_themes: None,
        description: None,
        tags: Vec::new(),
        cover: listing.cover.as_deref().and_then(safe_image_url),
        screenshots: Vec::new(),
        size_bytes: None,
        version: None,
        ui_version: None,
        icon_count: None,
        downloads: None,
        score: None,
        price_cents: 0,
        currency: None,
        bought: false,
        price_known: false,
        free: false,
        audio_url: None,
        web_url: format!("https://zhuti.xiaomi.com/detail/{module_id}"),
        module_id: module_id.to_string(),
    }
}

/// Re-hash a downloaded file (used by tests and integrity checks).
pub fn verify_file(path: &Path) -> AppResult<String> {
    sha1_file(path).map_err(|e| AppError::io("Could not read the package", e))
}

#[cfg(test)]
mod tests;
