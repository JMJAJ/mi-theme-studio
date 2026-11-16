# Theme store

The **Theme store** view (Tools → Theme store) browses Xiaomi's public Theme Manager catalog, shows full theme details, downloads free themes, and applies all or selected parts of a downloaded theme to the open project.

Nothing is requested until the user clicks *Connect*. Requests are anonymous GETs with a generic `MiThemeStudio/<version>` user agent.

## Client parameters

Product lists are only filled when a request carries the client parameters Theme Manager adds to every call. Without them the service returns shelf titles with empty `products`. The app sends fixed, generic values that describe a device class, not a person:

`device=generic, region=<chosen>, isGlobal=true, system=miui, alpha=false, language=en_US, capability=w,b,s,m,h5,v:8,vw, apk=3000519, devicePixel=1080, miuiUIVersion=V160, isSupportWidget=true`

`miuiUIVersion` is the one that matters: without it, home shelves drop from ~128 products to a handful. No account, device identifier, user ID or package data is sent. The region is chosen in the store toolbar (default `IN`).

The region changes the catalog itself. In a November 2026 sample of the first two home pages: `US` returned 281 products, all free (paid themes are hidden there); `IN` returned 597 (46 paid); EU regions about 261 (around 50 paid, EUR prices); `RU` returned only paid themes. Prices come as cents plus an ISO currency (`moneyInfo`). The *Free only* toggle hides paid themes client-side.

The download-ticket route also answers for paid themes without authentication. Mi Theme Studio does not use that: the backend checks the detail's `productPrice`/`productBought` and refuses paid themes before requesting a ticket.

## Routes

| Purpose | Route |
|---|---|
| Home shelves | `https://api.zhuti.intl.xiaomi.com/app/v9/uipages?pageCategory=THEME&isDeep=true&cardStart=<n>` |
| Categories | `…/app/v9/uipages/classification?pageCategory=HYBRID` |
| Page from a banner or category | `…/app/v9/uipages/<pageId>` |
| All themes on a shelf | `…/app/v9/uipages/subjects/<subjectId>?cardCount=1&cardStart=<n>` |
| Search | `https://thm.market.intl.xiaomi.com/thm/search/v2/npage?keywords=<q>&category=Compound&page=<n>` |
| Theme detail | `…/app/v9/uipages/theme/<moduleId>` |
| Download ticket | `https://thm.market.intl.xiaomi.com/thm/download/v2/<moduleId>?category=Compound` |

Products carry a module ID (`uuid`, the downloadable package) and a product ID (`productUuid`). The detail route accepts either. Relative image paths are resolved against the response's `fileServer`.

The detail response holds the overview card (`snapshotsUrl` screenshots), the designer card (name, avatar, theme count), the detail card (description, tags) and `extraInfo.themeDetail` (name, designer, size, version, UI version, downloads, score, `productPrice`, `productBought`).

The download ticket returns a signed `https://theme-fs.cdn.intl.miui.com/…/<name>.mtz` URL, `fileSize` and `fileHash` (the SHA-1 of the package).

## Product types

The same routes serve every product type; the type picks `pageCategory` (home page) and `category` (search and download):

| Type | Code (`productType`) | `pageCategory` | `category` | Download |
|---|---|---|---|---|
| Theme | 1 | `THEME` | `Compound` | `.mtz` |
| Font | 7 | `FONT` | `Font` | `.mtz` with `fonts/` |
| Wallpaper | 2 | `WALLPAPER` | `WallpaperUnion` | `.jpg` / `.png` |
| Ringtone | 6 | `RINGTONE` | `RingtoneUnion` | `.mp3` |

The wallpaper home page is built from albums and category links (`loopImages`, `fixedElements`, `topImage`); its category pages list individual wallpapers. Ringtone details carry `downloadUrl` + `downloadUrlRootAudio`, which the app uses as an audio preview for free ringtones only. A download's file type must match its product type.

Wallpapers apply as `wallpaper/default_wallpaper.*` and/or `wallpaper/default_lock_wallpaper.*`; ringtones as `ringtones/ringtone.mp3`, `notification.mp3` or `alarm.mp3` (the names Theme Manager reads). A file with the same name and another extension is replaced in the same undoable change, and the source is recorded in the package report.

## Downloads

- Only themes with `productPrice == 0` (or already bought) are downloaded. The backend re-fetches the detail and refuses paid themes before requesting a ticket. Rights/DRM routes (`/thm/drm/issue`) are never called.
- Ticket URLs must be HTTPS on `*.miui.com`, `*.mi-img.com` or `*.xiaomi.com`.
- Packages stream to `<app data>/downloads/<name> (<id>).mtz` through a `.part` file, with progress events (`store-download`) and cancellation. Size and SHA-1 are verified before the file is kept. A JSON sidecar records name, designer, cover, size and hash, and the *Downloaded* tab lists them offline.
- Images are only loaded from `https://*.mi-img.com` (backend allow-list and CSP).

## Applying a theme

- **Apply parts to my theme**: the download is opened as the read-only reference package. Its top-level parts (component archives such as `icons`, `lockscreen`, `com.android.systemui`, and folders such as `wallpaper`, `fonts`) are listed with file counts and sizes. The selected parts go through the normal copy-from-reference flow: you review the plan, existing files at the same paths are replaced by default, the copy is one undoable change, and the source theme is recorded in the package report.
- **Open whole theme as project**: opens the package as an untitled project, so saving asks for a new location instead of overwriting the cached download.
- **Browse files as reference**: opens the reference in the sidebar to copy individual files.

Respect the designers' licences when redistributing anything built from store themes.
