# AGENTS.md

Guidance for coding agents working in this repository.

## Project

This repository publishes small browser userscripts. The current script is:

- `google-maps-saved-list-to-gpx.user.js`: a Tampermonkey userscript that captures Google Maps saved-list `entitylist/getlist` responses and exports the loaded list as GPX waypoints.

There is no package manager, build step, bundler, or automated test suite in this repo.

## Editing Rules

- Keep userscripts self-contained and dependency-free unless the repository intentionally adds a build system.
- Preserve the `// ==UserScript==` metadata block at the top of each `.js` file.
- Keep metadata aligned and include the repository URL with `@homepageURL` for published scripts.
- Use plain browser JavaScript that works in Tampermonkey with `@grant none`.
- Keep the script wrapped in its IIFE and avoid leaking globals except intentional window patches.
- Prefer small, explicit helper functions over framework-style abstractions.
- Use ASCII unless the touched file already requires non-ASCII text.

## Google Maps GPX Script Notes

- The script patches both `window.fetch` and `XMLHttpRequest` so it can observe saved-list responses.
- Only parse responses whose URL matches `/maps/preview/entitylist/getlist`.
- Preserve support for opening raw `entity_list*.json` files through the existing `file://` include.
- GPX output should remain valid XML. Escape user-controlled text before writing it into GPX.
- Coordinates should be validated as finite numbers and formatted consistently.
- The floating panel must remain lightweight and should not depend on Google Maps internals beyond captured network responses.

## Validation

For metadata-only edits, inspect the diff.

For behavior changes, manually validate in a browser with Tampermonkey:

1. Install or update `google-maps-saved-list-to-gpx.user.js` in Tampermonkey.
2. Open Google Maps and load a saved list.
3. Confirm the floating button changes from waiting to a downloadable GPX action.
4. Download the GPX file and check that it contains the expected `<metadata>` and `<wpt>` entries.
5. If parser behavior changes, also test with a raw `entity_list*.json` file URL.

## Versioning

- Bump `@version` for user-visible behavior changes.
- Metadata-only or documentation-only changes do not need a version bump unless preparing a published release.
