# AGENTS.md

Guidance for coding agents working in this repository.

## Project

This repository publishes small browser userscripts. The current scripts are:

- `google-maps-saved-list-to-gpx.user.js`: a Tampermonkey userscript that captures Google Maps saved-list `entitylist/getlist` responses and exports the loaded list as GPX waypoints.
- `arr-ext-to-button.user.js`: adds a button on Sonarr series pages, Radarr movie pages (via IMDb ID), and Lidarr album pages (via artist/album search, resolved through Lidarr's own API) that opens a matching search on ext.to.
- `ext-to-arr-push-button.user.js`: adds a "Send to Sonarr/Radarr/Lidarr" button on ext.to search results that resolves the torrent's magnet link and pushes it straight into the matching *arr instance via its `release/push` API.

- `mozaik-presse-to-pdf.user.js`: runs in the presse.mozaik.co (PressReader white-label) viewer, captures the page tickets from `IssueInfo/GetPageKeys`, and downloads every page from `i.prcdn.co` as a ZIP of JPEGs or a PDF (both written by small built-in, dependency-free writers). It also adds "Download PDF/ZIP" buttons on `app.mozaik.co/press/<id>` issue pages.
- `mozaik-books-to-epub.user.js`: in Mozaik's book reader (`nextory.mozaik.co/reader/fr?book_id=<id>`, opened by "Lire" on `app.mozaik.co/books/<id>`), adds ZIP and EPUB buttons that download the book's EPUB parts (one small EPUB per spine item, as served to Mozaik's reader) as a ZIP, or merged into one EPUB (with a small built-in ZIP reader/writer).
- `telerama-to-pdf.user.js`: runs in the magazine.telerama.fr (Twipe) viewer for Telerama and Sortir, captures the page list and session ids from the viewer's own requests, and downloads every page PDF as a ZIP or as one merged PDF (merged with pdf-lib).

There is no package manager, build step, bundler, or automated test suite in this repo.

## Editing Rules

- Keep userscripts self-contained and dependency-free unless the repository intentionally adds a build system. `telerama-to-pdf.user.js` is an intentional exception: it `@require`s pdf-lib (pinned version, `#sha256=` integrity hash) because merging existing PDF pages is not worth hand-rolling.
- Preserve the `// ==UserScript==` metadata block at the top of each `.js` file.
- Keep metadata aligned and include the repository URL with `@homepageURL` for published scripts.
- Use plain browser JavaScript that works in Tampermonkey with `@grant none` when possible. The two `arr-`/`ext-to-arr-` scripts are an intentional exception: they need `GM_xmlhttpRequest` (bypass CORS to reach a LAN *arr instance from ext.to), `GM_getValue`/`GM_setValue` (store API keys outside the script source, prompting once via `prompt()` the first time each is needed), and `unsafeWindow` (patch the real page's `XMLHttpRequest`, not a sandboxed copy).
- Keep the script wrapped in its IIFE and avoid leaking globals except intentional window patches.
- Prefer small, explicit helper functions over framework-style abstractions.
- Use ASCII unless the touched file already requires non-ASCII text.
- Never hardcode API keys, tokens, or other secrets in these scripts' source. Use the `GM_getValue`/`GM_setValue`-with-`prompt()` pattern from `ext-to-arr-push-button.user.js`'s `getApiKey()` for any script that needs one.

## Google Maps GPX Script Notes

- The script patches both `window.fetch` and `XMLHttpRequest` so it can observe saved-list responses.
- Only parse responses whose URL matches `/maps/preview/entitylist/getlist`.
- Preserve support for opening raw `entity_list*.json` files through the existing `file://` include.
- GPX output should remain valid XML. Escape user-controlled text before writing it into GPX.
- Coordinates should be validated as finite numbers and formatted consistently.
- The floating panel must remain lightweight and should not depend on Google Maps internals beyond captured network responses.

## Sonarr/Radarr/Lidarr <-> ext.to Script Notes

These two scripts work as a pair but run on different origins, so they cannot share state directly:

- `arr-ext-to-button.user.js` runs on the *arr apps themselves (`videostation.local:8989/8310/8686`). For Sonarr/Radarr it just scans the page for an existing `a[href*="imdb.com/title/tt..."]` link and drops a button next to it - no API key needed there. For Lidarr (no IMDb link exists for music) it instead calls Lidarr's own same-origin `/api/v1/album` API to resolve artist/album name from the URL's album id.
- `ext-to-arr-push-button.user.js` runs on `ext.to/browse/*`. It patches `XMLHttpRequest` (must run at `document-start`, before ext.to's own scripts) to intercept the response of ext.to's `ajax/getSearchMagnet.php` call, keyed by `torrent_id` from the request body. It triggers that request by clicking ext.to's *own* magnet button rather than reconstructing the request itself, since that request is signed with an `hmac`/`timestamp` whose derivation is not worth reverse-engineering.
- The `suppressMagnetOpen` flag in `ext-to-arr-push-button.user.js` is what keeps ext.to's normal magnet-button behavior (opening the OS's magnet handler) working when the user clicks it directly, while suppressing that same behavior when our own button triggers the click programmatically. Do not remove this without preserving that distinction.
- Both scripts read the four possible values (`SONARR_API_KEY`, `RADARR_API_KEY`, `LIDARR_API_KEY`) via `GM_getValue`, prompting once via `prompt()` and persisting via `GM_setValue` the first time each is actually needed. `arr-ext-to-button.user.js` only ever needs `LIDARR_API_KEY`.
- Sonarr/Radarr use API `v3`; Lidarr uses API `v1`. Keep each target's `apiVersion` field correct - a mismatch 404s and returns Lidarr's SPA HTML shell instead of JSON, which fails silently unless logged.
- `release/push` can fail two different ways: a FluentValidation array (`[{propertyName, errorMessage}]`) when the title can't be parsed at all, or a resolved release object (`{rejected, rejections}`) when it parses but doesn't match a monitored item in the library. `isUnparseableTitle()` in `ext-to-arr-push-button.user.js` checks both shapes.
- Lidarr's title parser expects `Artist - Album` style separators; some music releases use `|` instead, which `pushReleaseWithRetry()` retries once with `|` replaced by `-`.

## Mozaik to PDF Script Notes

- Page images are `https://i.prcdn.co/img?file=<issue>&page=<n>&scale=<s>&ticket=<key>`; `<issue>` and the per-page `<key>` both come from the viewer's own `GetPageKeys` request, which the script observes by patching `fetch`/`XMLHttpRequest` at `document-start` (no auth flow is reimplemented).
- Before downloading, that request is replayed with `pageNumber=0` to fill any pages the viewer had not asked for yet.
- The ZIP also holds `issue.json` (issue id, title, viewer URL, scale, and each page's number, width, height and byte size) and one `IssueInfo-<Method>.json` per `ingress.pressreader.com/services/IssueInfo/<Method>` JSON answer the viewer received for that issue (the last one per method; `GetPageKeys` is the full `pageNumber=0` replay made just before the download, tickets included).
- The PDF writer embeds JPEG bytes untouched (`/DCTDecode`); anything else (WebP, PNG, CMYK JPEG) is re-encoded to RGB JPEG through a canvas first. It sets `/Title` from the viewer URL and only adds `/PageLabels` when pages are missing, so labels keep the viewer's page numbers.
- The Stop button (shown only while busy) sets `cancelled` and aborts every in-flight `GM_xmlhttpRequest` tracked in `activeRequests`; `gmRequest()` refuses new requests while `cancelled` is set, and `CancelledError` is never retried.
- "Find best" probes page 1 at increasing `scale` values and keeps the smallest one reaching the largest width (the CDN caps resolution); the chosen scale is stored with `GM_setValue('SCALE')`.
- On `app.mozaik.co` the script only adds "Download PDF/ZIP" buttons under each "Lire" link (`a.playBt` / `a[title="Lire"]`, with a text-based fallback), on any page, not just `/press`. They set an `AUTO_DOWNLOAD` GM value (GM storage is per-script, so it crosses origins), then click "Lire" so the site's own gift-token flow opens the viewer; the viewer consumes that value (valid 3 minutes) once it has page keys and starts the download. The app branch returns early, so no `fetch`/`XMLHttpRequest` patching happens there. It skips `/books` pages: their "Lire" button opens the book reader, where `mozaik-books-to-epub.user.js` adds its own buttons.

## Mozaik Books to EPUB Script Notes

- The script only runs in the reader, `nextory.mozaik.co/reader/fr?book_id=<id>` (the `data-reader-url` of the book page's `button.js-open-reader` "Lire" button), and shows a floating panel at the bottom right. The book id comes from `book_id`. Placing buttons under "Lire" on `app.mozaik.co/books/<id>` was dropped: that page renders the button twice (one per layout), recommended book titles can start with "Lire", and app.mozaik.co changes pages without reloading. `@match` must keep its trailing `*`: without it, only that exact URL matches.
- `fetch-book`'s `media_type` decides what can be downloaded: `novel` and `graphic_novel` (comics, same EPUB parts) use `get-epub-package` (ZIP of parts, EPUB) and show `total_pages`. `audio` (audio books and podcasts alike; `get-audio-package`: per-chapter HLS `master_playlist` URIs on `connect.nextory.com` plus AES `crypt_keys`) are encrypted streams, so their audio is deliberately not downloaded: ZIP only holds the JSON below and EPUB is hidden. Other media types disable both buttons, as does waiting for `fetch-book`.
- Every ZIP starts with `fetch-book.json` and `<endpoint>.json` (`get-epub-package.json` or `get-audio-package.json`): the `data` of each answer, pretty-printed, minus the audio package's session fields (`login_token`, `profile_token`, `device_id`).
- The panel shows `fetch-book`'s `coverImage` as a thumbnail. That URL is on `storage.cloud.google.com`, which redirects to a Google sign-in, so the host is swapped for the public `storage.googleapis.com` (`@connect`); if the page blocks the image, it is loaded through `GM_xmlhttpRequest` as a blob, else hidden.
- Metadata (`title`, `author`, used for the `Author - Title` file name) comes from `https://nextory.mozaik.co/proxy-api/books/fetch-book/<id>`, the parts from `.../get-epub-package/<id>` (`spines[]` with `spine_id`, `spine_href`, `spine_url`, `spine_sha256`; `toc.childrens[]`; `crypt_key`/`crypt_iv`). Both answer `{"data": ...}`.
- API calls use `GM_xmlhttpRequest`, which sends the user's mozaik.co cookies. The script also patches `fetch`/`XMLHttpRequest` at `document-start` to replay any header the app itself sends to `proxy-api` (such as a token). Signed out, the API redirects to an HTML page, reported as "no JSON data".
- `spine_url`s on `atlas-media.nextory.com` are signed links (`nx-expires`, `nx-signature`) that expire quickly (`403 Token has expired`), so the package is fetched when a download starts, and again for each retry of a failed part (concurrent refreshes share one request). A SHA-256 mismatch with `spine_sha256` only logs a warning.
- ZIP keeps the raw parts (`NN-<spine_id>.epub`), useful to inspect them when the merge goes wrong. EPUB merges them: files by path (a part's own content document wins over copies in other parts), manifests by id/path, the OPF of the first part as base, the spine rebuilt in package order, `container.xml` rewritten, `mimetype` stored first. Each part's `toc.ncx` only lists its own document ("Chapter 7"), so the NCX is always rebuilt from the package `toc` (42 named entries for the sample book), plus a `nav` document when the OPF is EPUB 3 (the parts are EPUB 2.0, from "EPUBLib"). The parts' metadata says `dc:language` `en` with no author, so `language`, `author` and `publisher_name` from `fetch-book` replace/add `dc:language`, `dc:creator`, `dc:publisher`. XML lookups use `getElementsByTagNameNS('*', name)`: the OPF uses an `opf:` prefix.
- The parts are not encrypted, so nothing is decrypted: the package's `crypt_key`/`crypt_iv` are unused. Any `META-INF/encryption.xml` (font obfuscation) is kept as served. The first part's file list is logged to the console.
- Checked against a real book (43 parts, each a full small EPUB: fonts and its CSS repeated, about 94 MB of parts for an 11.5 MB EPUB): every manifest file present, spine and NCX consistent.

## Telerama to PDF Script Notes

- The viewer (`magazine.telerama.fr/data/<package>/reader/reader.html#!.../pub/<pubId>/page/<n>`) is Twipe's web reader; its unminified source is `webreaders.twipecloud.net/webapp/lmo-tlr/primary/<version>/partial/web.js`, which is the reference when its requests change.
- Pages come from the viewer's `GetPublicationPages-<pubId>.json` response (`Page[].PublicationPageID`, `PageNumber`, `ExternalPageReference` like `TLR_20261007_001`, used for file names).
- Page PDFs live on `lmo-tlr-production-cdn.twipecloud.net` behind short-lived CloudFront signed URLs, so they cannot be built locally. The script asks for one per page with the same call as the viewer's "Page actuelle" (`retrievePdfUrl` in web.js): `GET <api>/Pdf/<PublicationPageID>/<version>/<sessionId>/<userId>/<downloadId>/url`, which returns the URL in `ReturnMessage`. A fresh URL is requested on every retry.
- Tried and dropped: the viewer's hidden "Toutes les pages" entry (`GET <api>/api/downloadservice/requestfullpdfdownload/<userId>/<sessionId>/<orderId>/<subsId>/<packageId>[/<pubId>].json`, with `orderId` from the `TW_READER_SESSION` cookie and `subsId` from `TW_LOGGED_IN`; `0/0` fails with "Order mismatch" E10). It does return a signed `DownloadLink` (`FullPublicationPdf-<pubId>.pdf` / `FullContentPackagePdf-<packageId>.pdf`), but the CDN answers 403 even in a plain browser tab: the file is never generated when the issue data has `FullPdfAvailable: false`, which is also why the viewer hides the entry. Each call also creates a new `DownloadId`, so do not call it speculatively.
- `userId`/`sessionId`/`downloadId` (and the request headers, such as `x-api-key`) are captured from the viewer's `GetDownloadCredentials/<userId>/<sessionId>/<downloadId>` request, or from a `Pdf/.../url` request if the user used the viewer's download menu.
- The Stop button and `activeRequests`/`CancelledError` handling follow `mozaik-presse-to-pdf.user.js`.
- The panel starts at the bottom right, with its lines and buttons centered, and is at most 180px wide, so it fits the margin the viewer leaves there. It can be dragged anywhere except on its buttons, and the position is kept in `localStorage` (`telerama-to-pdf.panel-position`) and clamped to the window.
- Files are named `Télérama No. 4007 - 28 Octobre 2026` (`TLR`) or `Télérama Paris No. 4007 - 28 Octobre 2026` (`SORTTLR`, the Sortir supplement, which shares the Télérama number). No request carries the issue number, so `findIssueNumber()` reads it from the cover PDF. `lookupIssue()` fetches the cover as soon as the session ids are known (one `Pdf/.../url` call plus one page download), so the panel shows the final name before any download. Covers use WinAnsi fonts, so the literal strings of the page's decoded streams join into `No 4007`. Lines are joined without separators (`Nº 4007Du 31/10`), and the Télérama cover also prints `CPPAP Nº 0630 C 80864` (press registration number), which `ISSUE_RE` skips. Inner-page folios (`Télérama Paris 4007`) use subset fonts with custom glyph codes for the digits and cannot be read that way. Without a number the name falls back to `Télérama - 28 Octobre 2026`. The source keeps accents as `\u` escapes, and the ZIP sets the UTF-8 name flag.

## Validation

For metadata-only edits, inspect the diff.

For behavior changes, manually validate in a browser with Tampermonkey:

1. Install or update `google-maps-saved-list-to-gpx.user.js` in Tampermonkey.
2. Open Google Maps and load a saved list.
3. Confirm the floating button changes from waiting to a downloadable GPX action.
4. Download the GPX file and check that it contains the expected `<metadata>` and `<wpt>` entries.
5. If parser behavior changes, also test with a raw `entity_list*.json` file URL.

For `arr-ext-to-button.user.js` and `ext-to-arr-push-button.user.js`:

1. Install/update both scripts in Tampermonkey (Firefox: no `@require`/file-access setup needed, both use `GM_getValue`/`GM_setValue` instead).
2. Open a Sonarr series page, a Radarr movie page, and a Lidarr album page; confirm an "ext.to" / "Search ext.to" button appears in each case (inline next to the IMDb link for Sonarr/Radarr, next to the "Links" badge for Lidarr, falling back to a floating button after 5s if that anchor never renders).
3. Click through to ext.to and confirm a "Send to Sonarr/Radarr/Lidarr" button appears on each result row, matching the row's category (TV/Movies/Music).
4. Click the real ext.to magnet icon directly first - confirm it still opens your OS's magnet handler as normal.
5. Click "Send to ..." on a result - confirm you're prompted once for the relevant API key (first run only), and that no OS magnet-handler prompt appears this time.
6. Confirm the button ends on "Sent (OK)" for a release Sonarr/Radarr/Lidarr can grab, or a specific rejection reason otherwise (check the console for the full `release/push` response on rejection).

For `mozaik-books-to-epub.user.js`:

1. Open a book page such as `https://app.mozaik.co/books/13450471` while signed in, and click "Lire".
2. Confirm the reader shows a panel at the bottom right with the cover thumbnail, ZIP and EPUB buttons and `Author - Title`, and that the press script adds no buttons on the book page.
3. Download the ZIP and check it holds `fetch-book.json`, `get-epub-package.json` and one `NN-<spine_id>.epub` per spine item.
4. Download the EPUB and open it in a reader (and ideally run `epubcheck`): every chapter in order, real text, a working table of contents. Also open an audio book in the reader: EPUB is hidden, and ZIP only holds `fetch-book.json` and `get-audio-package.json` without the session tokens.
5. Press Stop during a download and confirm it ends on "Stopped.".

For `telerama-to-pdf.user.js`:

1. Open a Telerama and a Sortir issue from `telerama.fr/kiosque/telerama` and `/kiosque/sortir`.
2. Confirm the panel goes from waiting to "Télérama No. 4007 - 07 Octobre 2026" / "152 pages" (name and date from the issue, issue number from the cover a moment later) with ZIP and PDF enabled (console shows `GetPublicationPages` and `captured session ids`).
3. Download the ZIP and check it holds one `page-NNN.pdf` per page; download the PDF and check page count, order and `/Title`. Both should be named like `Télérama No. 4007 - 28 Octobre 2026` (`Télérama Paris ...` for Sortir); a date-only name means the cover number was not found (console warning).
4. Press Stop during a download and confirm it ends on "Stopped.".

## Versioning

- Bump `@version` for user-visible behavior changes.
- Metadata-only or documentation-only changes do not need a version bump unless preparing a published release.

## Code quality

- Fix javascript warnings, especially those found by Sonarqube.
