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
         {"uuid": "mod-2", "productType": 2, "name": "A font"},
         {"uuid": "../evil", "productType": 1, "name": "Bad id"},
         {"uuid": "mod-1", "productType": 1, "name": "Duplicate"}
       ]},
      {"cardUuid": "c2", "title": "Empty shelf", "subjectUuid": "subj-2", "products": []},
      {"cardUuid": "c3", "gridBanners": [
        {"imageUrl": "https://evil.example.com/x.png", "link": {"title": "Dark", "link": "page-2", "type": 1, "productType": 1}},
        {"imageUrl": "thumbnail/y", "link": {"title": "Fonts", "link": "page-3", "type": 1, "productType": 2}},
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
    assert_eq!(shelf.products.len(), 1, "fonts, bad ids and duplicates are skipped");
    let p = &shelf.products[0];
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
    assert!(query_url(&StoreQuery::Search { keywords: "  ".into() }, 0, "US").is_err());
    let search = query_url(&StoreQuery::Search { keywords: "cat & dog".into() }, 1, "US").unwrap();
    assert!(search.starts_with("https://thm.market.intl.xiaomi.com/thm/search/v2/npage?keywords=cat%20%26%20dog&"));
    let home = query_url(&StoreQuery::Home, 20, region_of(Some("XX"))).unwrap();
    assert!(home.contains("cardStart=20") && home.contains("region=US") && home.contains("miuiUIVersion=V160"));
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
    let home = fetch_page(&StoreQuery::Home, 0, None, ua).unwrap();
    let products: Vec<_> = home.sections.iter().flat_map(|s| &s.products).collect();
    println!("home: {} sections, {} products", home.sections.len(), products.len());
    assert!(!products.is_empty());
    let subject = home.sections.iter().find_map(|s| s.subject_id.clone()).unwrap();
    let shelf = fetch_page(&StoreQuery::Subject { id: subject }, 0, None, ua).unwrap();
    println!("shelf: {} products", shelf.sections.iter().map(|s| s.products.len()).sum::<usize>());
    let search = fetch_page(&StoreQuery::Search { keywords: "cat".into() }, 0, None, ua).unwrap();
    println!("search: {} products", search.sections.iter().map(|s| s.products.len()).sum::<usize>());
    let cats = fetch_page(&StoreQuery::Categories, 0, None, ua).unwrap();
    println!("categories: {} links", cats.sections.iter().map(|s| s.links.len()).sum::<usize>());
    let detail = fetch_detail(&products[0].module_id, None, ua).unwrap();
    println!("detail: {} by {:?}, {} screenshots, free={}", detail.name, detail.designer, detail.screenshots.len(), detail.free);
    assert!(!detail.screenshots.is_empty());
    let dir = std::env::temp_dir().join("mts-store-live");
    let mut ticks = 0;
    let record = download(&detail.module_id, None, &dir, ua, |_, _| ticks += 1).unwrap();
    println!("downloaded {} bytes to {} (sha1 {}, {ticks} progress events)", record.size_bytes, record.path, record.sha1);
    assert_eq!(verify_file(Path::new(&record.path)).unwrap(), record.sha1);
    assert_eq!(existing(&dir, &detail.module_id), Some(record.clone()), "cached copy is reused");
    let bytes = std::fs::read(&record.path).unwrap();
    assert_eq!(&bytes[..2], b"PK", "package is a zip");
    let project = crate::project::Project::from_bytes(&bytes, "live.mtz", None, crate::package::archive::Limits::default()).unwrap();
    println!("opened: {} files, components {:?}", project.files.len(), project.containers.keys().collect::<Vec<_>>());
    assert!(!project.containers.is_empty());
    remove_download(&dir, &detail.module_id).unwrap();
}
