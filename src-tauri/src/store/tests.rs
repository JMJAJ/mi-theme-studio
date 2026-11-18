use super::*;

// Synthetic fixtures shaped like verified responses (not copies of them).
const HOME: &str = r#"{
  "apiCode": "0", "apiMessage": "success",
  "apiData": {
    "hasMore": true, "fileServer": "https://t17.market.mi-img.com/download/",
    "cards": [
      {"cardUuid": "c0", "iconGroups": [[{"title": "New", "iconUrl": "thumbnail/webp/w216q90/ThemeMarket/a",
        "link": {"title": "New", "link": "page-1", "type": 1, "productType": 1}}]]},
      {"cardUuid": "c1", "title": "Global trends", "subjectUuid": "subj-1",
       "products": [
         {"uuid": "mod-1", "productUuid": "prod-1", "productType": 1, "name": "Glass", "originPriceInCent": 0,
          "imageUrl": "thumbnail/webp/w480q70/ThemeMarket/x", "fileSizeInKB": 9447242, "metaTags": ["Widget", "Pink"]},
         {"uuid": "mod-2", "productType": 7, "name": "A font"},
         {"uuid": "mod-3", "productType": 99, "name": "Unknown type"},
         {"uuid": "../evil", "productType": 1, "name": "Bad id"},
         {"uuid": "mod-1", "productType": 1, "name": "Duplicate"}
       ]},
      {"cardUuid": "c2", "title": "Empty shelf", "subjectUuid": "subj-2", "products": []},
      {"cardUuid": "c3", "gridBanners": [
        {"imageUrl": "https://evil.example.com/x.png", "link": {"title": "Dark", "link": "page-2", "type": 1, "productType": 1}},
        {"imageUrl": "thumbnail/y", "link": {"title": "Odd", "link": "page-3", "type": 1, "productType": 42}},
        {"imageUrl": "thumbnail/z", "link": {"title": "App", "link": "widget://x", "type": 3}}
      ]}
    ]
  }
}"#;

#[test]
fn parses_shelves_links_and_products() {
    let page = parse_page(HOME, 0).unwrap();
    assert!(page.has_more);
    assert_eq!(page.next_start, 4);
    assert_eq!(page.sections.len(), 3, "empty cards are dropped");
    let icons = &page.sections[0];
    assert_eq!(icons.links[0].page_id.as_deref(), Some("page-1"));
    assert!(icons.links[0].icon);
    assert_eq!(
        icons.links[0].image_url.as_deref(),
        Some("https://t17.market.mi-img.com/thumbnail/webp/w216q90/ThemeMarket/a"),
        "relative paths resolve against the file server host"
    );
    let shelf = &page.sections[1];
    assert_eq!(shelf.subject_id.as_deref(), Some("subj-1"));
    assert_eq!(shelf.products.len(), 2, "unknown types, bad ids and duplicates are skipped");
    assert_eq!(shelf.products[1].kind, ProductKind::Font);
    let p = &shelf.products[0];
    assert_eq!(p.kind, ProductKind::Theme);
    assert_eq!(p.module_id, "mod-1");
    assert_eq!(p.product_id.as_deref(), Some("prod-1"));
    assert_eq!(p.price_cents, 0);
    assert_eq!(p.size_bytes, Some(9447242));
    assert_eq!(p.tags, vec!["Widget", "Pink"]);
    let grid = &page.sections[2];
    assert_eq!(grid.links.len(), 1, "non-theme and app-only links are skipped");
    assert_eq!(grid.links[0].title.as_deref(), Some("Dark"));
    assert!(grid.links[0].image_url.is_none(), "foreign image hosts are dropped");
}

const DETAIL: &str = r#"{
  "apiCode": "0",
  "apiData": {
    "cards": [
      {"themeProductOverview": {"snapshotsUrl": ["https://t17.market.mi-img.com/thumbnail/webp/w1080q70/ThemeMarket/s1", "http://insecure/s2"]}},
      {"designerName": "Evanc", "designerIcon": "https://cdn.cnbj1.fds.api.mi-img.com/user-avatar/a.jpeg", "productCount": 3337}
    ],
    "extraInfo": {"themeDetail": {
      "name": "Glass Flower", "moduleId": "mod-1", "productId": "prod-1", "designer": "Evanc", "author": "Evanc",
      "description": "Slide up to unlock", "moneyInfo": "inr", "tags": "AI Generated;Widget;", "fileSize": 9447242, "version": "V15",
      "uiVersion": 15, "downloads": 185431, "score": 2.0, "productPrice": 0, "productBought": false,
      "downloadUrlRoot": "https://t17.market.mi-img.com/thumbnail/"
    }}
  }
}"#;

#[test]
fn parses_detail() {
    let d = parse_detail(DETAIL, "mod-1").unwrap();
    assert_eq!(d.name, "Glass Flower");
    assert_eq!(d.product_id.as_deref(), Some("prod-1"));
    assert_eq!(d.screenshots.len(), 1);
    assert_eq!(d.cover, d.screenshots.first().cloned());
    assert_eq!(d.tags, vec!["AI Generated", "Widget"]);
    assert_eq!(d.designer_themes, Some(3337));
    assert!(d.designer_icon.is_some());
    assert!(d.free && !d.bought);
    assert_eq!(d.ui_version, Some(15));
}

#[test]
fn paid_detail_is_not_free() {
    let paid = DETAIL.replace("\"productPrice\": 0", "\"productPrice\": 199");
    let d = parse_detail(&paid, "mod-1").unwrap();
    assert!(!d.free);
    assert_eq!(d.price_cents, 199);
    assert_eq!(d.currency.as_deref(), Some("INR"));
}

#[test]
fn missing_price_is_not_free() {
    let missing = DETAIL.replace("\"productPrice\": 0, ", "");
    assert!(!missing.contains("productPrice"), "fixture edit must remove the field");
    let d = parse_detail(&missing, "mod-1").unwrap();
    assert!(!d.price_known, "an absent price is not a stated price");
    assert!(!d.free, "a theme with no stated price must not be treated as free");
    assert_eq!(d.price_cents, 0);
}

#[test]
fn malformed_price_is_not_free() {
    for bad in ["-5", "\"free\"", "null", "true", "\"\"", "[]"] {
        let doc = DETAIL.replace("\"productPrice\": 0", &format!("\"productPrice\": {bad}"));
        let d = parse_detail(&doc, "mod-1").unwrap();
        assert!(!d.free, "productPrice {bad} must not read as free");
        assert!(!d.price_known, "productPrice {bad} must not count as a stated price");
    }
}

#[test]
fn zero_price_is_free() {
    let d = parse_detail(DETAIL, "mod-1").unwrap();
    assert!(d.price_known);
    assert!(d.free);
    assert_eq!(d.price_cents, 0);
}

#[test]
fn download_ticket_checks_host_and_hash() {
    let ok = r#"{"apiCode":0,"apiData":{"downloadUrl":"https://theme-fs.cdn.intl.miui.com/issue/a.mtz?t=1","fileHash":"43B3ACE1BA9A05E85CCBA9ABAE5A72E07081F476","fileSize":10}}"#;
    let t = parse_ticket(ok).unwrap();
    assert_eq!(t.sha1.as_deref(), Some("43b3ace1ba9a05e85ccba9abae5a72e07081f476"));
    assert_eq!(t.size, Some(10));
    let evil = ok.replace("theme-fs.cdn.intl.miui.com", "miui.com.evil.io");
    assert_eq!(parse_ticket(&evil).unwrap_err().code, "store");
    let http = ok.replace("https://", "http://");
    assert!(parse_ticket(&http).is_err());
    let err = parse_ticket(r#"{"apiCode":-1,"apiData":"get downloadUrl error!"}"#).unwrap_err();
    assert_eq!(err.code, "store_api");
    assert!(err.message.contains("get downloadUrl error!"));
}

#[test]
fn urls_validate_input() {
    assert!(query_url(&StoreQuery::Page { id: "../x".into() }, 0, "US").is_err());
    assert!(query_url(&StoreQuery::Search { keywords: "  ".into(), product: ProductKind::Theme, part: None }, 0, "US").is_err());
    let search = query_url(&StoreQuery::Search { keywords: "cat & dog".into(), product: ProductKind::Theme, part: None }, 1, "US").unwrap();
    assert!(search.starts_with("https://thm.market.intl.xiaomi.com/thm/search/v2/npage?keywords=cat%20%26%20dog&"));
    let home = query_url(&StoreQuery::Home { product: ProductKind::Theme, part: None }, 20, region_of(Some("XX"))).unwrap();
    let fonts = query_url(&StoreQuery::Home { product: ProductKind::Font, part: None }, 0, "IN").unwrap();
    assert!(fonts.contains("pageCategory=FONT"));
    let rings = query_url(&StoreQuery::Search { keywords: "piano".into(), product: ProductKind::Ringtone, part: None }, 0, "IN").unwrap();
    assert!(rings.contains("category=RingtoneUnion"));
    let q: StoreQuery = serde_json::from_str(r#"{"kind":"home"}"#).unwrap();
    assert_eq!(q, StoreQuery::Home { product: ProductKind::Theme, part: None }, "product defaults to themes");
    assert!(home.contains("cardStart=20") && home.contains("region=PR") && home.contains("miuiUIVersion=V160"));
}

#[test]
fn ringtone_detail_has_free_preview_only() {
    let ring = r#"{"apiCode":"0","apiData":{"cards":[],"extraInfo":{"themeDetail":{
        "name":"Sweet Dreams","moduleId":"r-1","productType":6,"productPrice":0,
        "downloadUrl":"ThemeMarket/abc/Sweet Dreams.mp3","downloadUrlRootAudio":"https://t17.market.mi-img.com/download/"}}}}"#;
    let d = parse_detail(ring, "r-1").unwrap();
    assert_eq!(d.kind, ProductKind::Ringtone);
    assert_eq!(d.audio_url.as_deref(), Some("https://t17.market.mi-img.com/download/ThemeMarket/abc/Sweet%20Dreams.mp3"));
    let paid = ring.replace("\"productPrice\":0", "\"productPrice\":100");
    assert!(parse_detail(&paid, "r-1").unwrap().audio_url.is_none());
    let font = r#"{"apiCode":"0","apiData":{"cards":[],"extraInfo":{"themeDetail":{"name":"F","moduleId":"f-1","category":"Font","productType":7}}}}"#;
    assert_eq!(parse_detail(font, "f-1").unwrap().kind, ProductKind::Font);
    assert_eq!(extension_of_url("https://x.miui.com/a/Sweet+Dreams.MP3?t=1&s=2").as_deref(), Some("mp3"));
    assert_eq!(extension_of_url("https://x.miui.com/a/noext?t=1"), None);
}

#[test]
fn file_names_are_safe() {
    assert_eq!(safe_file_stem("Glass Flower"), "Glass Flower");
    assert_eq!(safe_file_stem("../..\\con:<>"), "con");
    assert_eq!(safe_file_stem("***"), "theme");
}

#[test]
fn downloads_index_round_trip() {
    let dir = std::env::temp_dir().join(format!("mts-store-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("Glass (mod-1).mtz");
    std::fs::write(&file, b"hello").unwrap();
    let record = DownloadedTheme {
        module_id: "mod-1".into(),
        product_id: None,
        kind: ProductKind::Theme,
        name: "Glass".into(),
        designer: None,
        cover: None,
        path: file.to_string_lossy().into_owned(),
        size_bytes: 5,
        sha1: verify_file(&file).unwrap(),
        downloaded_at_ms: 1,
    };
    assert_eq!(record.sha1, "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
    std::fs::write(sidecar(&dir, "mod-1"), serde_json::to_string(&record).unwrap()).unwrap();
    assert_eq!(list_downloads(&dir), vec![record]);
    remove_download(&dir, "mod-1").unwrap();
    assert!(list_downloads(&dir).is_empty());
    assert!(!file.exists());
    let _ = std::fs::remove_dir_all(&dir);
}

/// `MTS_STORE_LIVE=1 cargo test store::tests::live -- --ignored --nocapture`
#[test]
#[ignore]
fn live() {
    if std::env::var("MTS_STORE_LIVE").as_deref() != Ok("1") {
        return;
    }
    let ua = "MiThemeStudio/test";
    let home = fetch_page(&StoreQuery::Home { product: ProductKind::Theme, part: None }, 0, None, ua).unwrap();
    let products: Vec<_> = home.sections.iter().flat_map(|s| &s.products).collect();
    println!("home: {} sections, {} products", home.sections.len(), products.len());
    assert!(!products.is_empty());
    let subject = home.sections.iter().find_map(|s| s.subject_id.clone()).unwrap();
    let shelf = fetch_page(&StoreQuery::Subject { id: subject }, 0, None, ua).unwrap();
    println!("shelf: {} products", shelf.sections.iter().map(|s| s.products.len()).sum::<usize>());
    let search = fetch_page(&StoreQuery::Search { keywords: "cat".into(), product: ProductKind::Theme, part: None }, 0, None, ua).unwrap();
    println!("search: {} products", search.sections.iter().map(|s| s.products.len()).sum::<usize>());
    let cats = fetch_page(&StoreQuery::Categories, 0, None, ua).unwrap();
    println!("categories: {} links", cats.sections.iter().map(|s| s.links.len()).sum::<usize>());
    let detail = fetch_detail(&products[0].module_id, None, ua).unwrap();
    println!("detail: {} by {:?}, {} screenshots, free={}", detail.name, detail.designer, detail.screenshots.len(), detail.free);
    assert!(!detail.screenshots.is_empty());
    let dir = std::env::temp_dir().join("mts-store-live");
    let mut ticks = 0;
    let record = download(&detail.module_id, None, &dir, ua, None, |_, _| ticks += 1).unwrap();
    println!("downloaded {} bytes to {} (sha1 {}, {ticks} progress events)", record.size_bytes, record.path, record.sha1);
    assert_eq!(verify_file(Path::new(&record.path)).unwrap(), record.sha1);
    assert_eq!(existing(&dir, &detail.module_id), Some(record.clone()), "cached copy is reused");
    let bytes = std::fs::read(&record.path).unwrap();
    assert_eq!(&bytes[..2], b"PK", "package is a zip");
    let project = crate::project::Project::from_bytes(&bytes, "live.mtz", None, crate::package::archive::Limits::default()).unwrap();
    println!("opened: {} files, components {:?}", project.files.len(), project.containers.keys().collect::<Vec<_>>());
    assert!(!project.containers.is_empty());
    remove_download(&dir, &detail.module_id).unwrap();

    for (kind, word) in [(ProductKind::Font, "bold"), (ProductKind::Ringtone, "piano"), (ProductKind::Wallpaper, "flower")] {
        let home = fetch_page(&StoreQuery::Home { product: kind, part: None }, 0, Some("IN"), ua).unwrap();
        let home_products = home.sections.iter().map(|s| s.products.len()).sum::<usize>();
        let home_links = home.sections.iter().map(|s| s.links.len()).sum::<usize>();
        let found = fetch_page(&StoreQuery::Search { keywords: word.into(), product: kind, part: None }, 0, Some("IN"), ua).unwrap();
        let items: Vec<_> = found.sections.iter().flat_map(|s| s.products.clone()).collect();
        println!("{kind:?}: home {home_products} products / {home_links} links, search {} items", items.len());
        assert!(items.iter().all(|p| p.kind == kind), "{kind:?} search returns only that kind");
        if kind == ProductKind::Font {
            continue;
        }
        let free = items.iter().find(|p| p.price_cents == 0).expect("a free item");
        let d = fetch_detail(&free.module_id, Some("IN"), ua).unwrap();
        assert_eq!(d.kind, kind);
        if kind == ProductKind::Ringtone {
            assert!(d.audio_url.is_some(), "free ringtone has a preview");
        }
        let record = download(&free.module_id, Some("IN"), &dir, ua, None, |_, _| {}).unwrap();
        println!("  downloaded {} ({} bytes) as {}", record.name, record.size_bytes, record.path);
        assert!(kind.allowed_extensions().contains(&crate::package::paths::extension(&record.path).as_str()));
        remove_download(&dir, &record.module_id).unwrap();
    }
}

/// Live store pages for the UI preview harness:
/// `MTS_STORE_LIVE=1 MTS_FIXTURE_OUT=<dir> cargo test store::tests::export_store_fixture -- --ignored`
#[test]
#[ignore]
fn export_store_fixture() {
    let (Ok(_), Ok(out)) = (std::env::var("MTS_STORE_LIVE"), std::env::var("MTS_FIXTURE_OUT")) else { return };
    let ua = "MiThemeStudio/test";
    let home = fetch_page(&StoreQuery::Home { product: ProductKind::Theme, part: None }, 0, Some("IN"), ua).unwrap();
    std::fs::write(std::path::Path::new(&out).join("store-home.json"), serde_json::to_string(&home).unwrap()).unwrap();
    let cats = fetch_page(&StoreQuery::Categories, 0, Some("IN"), ua).unwrap();
    std::fs::write(std::path::Path::new(&out).join("store-categories.json"), serde_json::to_string(&cats).unwrap()).unwrap();
    let id = home.sections.iter().flat_map(|s| &s.products).next().unwrap().module_id.clone();
    let detail = fetch_detail(&id, Some("IN"), ua).unwrap();
    std::fs::write(std::path::Path::new(&out).join("store-detail.json"), serde_json::to_string(&detail).unwrap()).unwrap();
}

#[test]
fn icon_packs_are_their_own_kind() {
    let home = query_url(&StoreQuery::Home { product: ProductKind::Icon, part: None }, 2, "IN").unwrap();
    assert!(home.starts_with("https://thm.market.intl.xiaomi.com/thm/search/v2/npage?keywords=&category=Icon&page=2&"));
    let search = query_url(&StoreQuery::Search { keywords: "cat".into(), product: ProductKind::Icon, part: None }, 0, "IN").unwrap();
    assert!(search.contains("keywords=cat&category=Icon"));
    // Search results carry no productType: they take the searched kind.
    let page = r#"{"apiCode":0,"apiData":{"cards":[{"products":[{"uuid":"i-1","name":"Kitty","imageUrl":"https://t17.market.mi-img.com/thumbnail/x"}]}]}}"#;
    assert_eq!(parse_page_as(page, 0, ProductKind::Icon).unwrap().sections[0].products[0].kind, ProductKind::Icon);
    assert_eq!(parse_page(page, 0).unwrap().sections[0].products[0].kind, ProductKind::Theme);
    let detail = r#"{"apiCode":"0","apiData":{"cards":[],"extraInfo":{"themeDetail":{"name":"Kitty","moduleId":"i-1","productType":9,"productPrice":0,"iconCount":120}}}}"#;
    let d = parse_detail(detail, "i-1").unwrap();
    assert_eq!((d.kind, d.icon_count), (ProductKind::Icon, Some(120)));
    assert_eq!(ProductKind::Icon.allowed_extensions(), &["mtz", "zip"]);
}

#[test]
fn part_listings_search_that_category() {
    let lock = StoreQuery::Home { product: ProductKind::Theme, part: Some(StorePart::Lockscreen) };
    assert!(query_url(&lock, 1, "IN").unwrap().starts_with("https://thm.market.intl.xiaomi.com/thm/search/v2/npage?keywords=&category=LockStyle&page=1&"));
    let boot = StoreQuery::Search { keywords: "dark sky".into(), product: ProductKind::Theme, part: Some(StorePart::BootAnimation) };
    assert!(query_url(&boot, 0, "IN").unwrap().contains("keywords=dark%20sky&category=BootAnimation"));
    // A part only filters themes.
    let fonts = StoreQuery::Home { product: ProductKind::Font, part: Some(StorePart::Aod) };
    assert!(query_url(&fonts, 0, "IN").unwrap().contains("pageCategory=FONT"));
    let q: StoreQuery = serde_json::from_str(r#"{"kind":"search","keywords":"x","product":"theme","part":"statusBar"}"#).unwrap();
    assert_eq!(q.part(), Some(StorePart::StatusBar));
    // No picture: the store sends just the folder.
    let page = r#"{"apiCode":0,"apiData":{"cards":[{"products":[{"uuid":"c-1","name":"Clock","imageUrl":"https://t17.market.mi-img.com/thumbnail/webp/w212q80/"}]}]}}"#;
    assert_eq!(parse_page(page, 0).unwrap().sections[0].products[0].image_url, None);
}

#[test]
fn icon_covers_drop_details_suffix() {
    let page = r#"{"apiCode":0,"apiData":{"root":"https://t17.market.mi-img.com/thumbnail/","cards":[{"products":[{"uuid":"i-1","name":"K","imageUrl":"https://t17.market.mi-img.com/thumbnail/webp/w212q80/ThemeMarket/abc/details"}]}]}}"#;
    let p = &parse_page_as(page, 0, ProductKind::Icon).unwrap().sections[0].products[0];
    assert_eq!(p.image_url.as_deref(), Some("https://t17.market.mi-img.com/thumbnail/webp/w212q80/ThemeMarket/abc"));
    let l: PartListing = serde_json::from_str(r#"{"kind":"icon","name":"K","cover":null}"#).unwrap();
    assert_eq!((l.category(), listing_detail("i-1", &l).kind), ("Icon", ProductKind::Icon));
    let l: PartListing = serde_json::from_str(r#"{"part":"lockscreen","kind":"theme","name":"K"}"#).unwrap();
    assert_eq!(l.category(), "LockStyle");
}
