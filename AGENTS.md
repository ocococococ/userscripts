# AGENTS.md

Guidance for coding agents working in this repository.

## Project

This repository publishes small browser userscripts. The current scripts are:

- `google-maps-saved-list-to-gpx.user.js`: a Tampermonkey userscript that captures Google Maps saved-list `entitylist/getlist` responses and exports the loaded list as GPX waypoints.
- `arr-ext-to-button.user.js`: adds a button on Sonarr series pages, Radarr movie pages (via IMDb ID), and Lidarr album pages (via artist/album search, resolved through Lidarr's own API) that opens a matching search on ext.to.
- `ext-to-arr-push-button.user.js`: adds a "Send to Sonarr/Radarr/Lidarr" button on ext.to search results that resolves the torrent's magnet link and pushes it straight into the matching *arr instance via its `release/push` API.

There is no package manager, build step, bundler, or automated test suite in this repo.

## Editing Rules

- Keep userscripts self-contained and dependency-free unless the repository intentionally adds a build system.
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

## Versioning

- Bump `@version` for user-visible behavior changes.
- Metadata-only or documentation-only changes do not need a version bump unless preparing a published release.
