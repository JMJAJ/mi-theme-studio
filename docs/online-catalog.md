# Online catalog

The **Online themes** view shows public, read-only catalog data from the global Theme Manager service. Nothing is requested until the user clicks *Load catalog*; requests are anonymous (generic `MiThemeStudio/<version>` user agent, no account, device or package data).

## Routes used

Both routes were verified to answer anonymous GET requests with `apiCode: "0"`:

| View | Route |
|---|---|
| Theme shelves | `https://api.zhuti.intl.xiaomi.com/app/v9/uipages?cardCount=20&pageCategory=THEME&cardStart=<n>&isDeep=true&apiVersion=1` |
| Categories | `https://api.zhuti.intl.xiaomi.com/app/v9/uipages/classification?cardCount=20&pageCategory=HYBRID` |

`pageCategory` must be uppercase (`theme` returns `ARGUMENT_ERROR`). The shelf page is paginated with `cardStart` and `hasMore`.

What the responses contain and how the app shows it:

- `TOP_BANNER` → quick links (`iconGroups` with `iconUrl` / `iconDarkModeUrl` and `UI_PAGE` links such as New, Hot Hits, Dark Mode).
- `THEME_*_LIST` → shelves with `title`, `subjectUuid`, `productCountPerCard`; in verified calls `products` is empty and `productCount` is 0. The app lists the shelves and states "No products returned".
- `FOUR_GRID_BANNER_WITH_SIZE` (categories) → category cards with images and `UI_PAGE` links (`productType` THEME or FONT). These cards carry `visible: false`; the app shows them with a "hidden by service" badge and a toggle.
- `TEXT_IMAGE_BANNER`, `GLOBAL_AD_BIG` → banners with images; `EXTERNAL_HREF` links are app-only and are not opened.

Images come directly from `https://t17.market.mi-img.com/...` URLs in the JSON. The backend drops image URLs outside `https://*.mi-img.com`, and the CSP only allows that host for remote images.

## Not available yet

- **Products inside shelves.** Direct calls to shelf/subject child pages returned empty cards. The Android app's default request parameters are empty, so this is not fixed by adding device headers; it may depend on region, backend visibility or service behaviour. Needs a verified product-list request.
- **Theme details and downloads.** The app resource type for full themes is `Compound`; detail and download routes exist in the marketplace API but are **not** called. Downloads stay unavailable until a real product ID and download flow are verified.
- **Rights/DRM.** The marketplace rights route is treated as a gate. The app never attempts to bypass paid or DRM restrictions.

When downloads become possible, the plan is to open a downloaded theme as a read-only reference (never replacing the project) and keep its attribution in the package report.
