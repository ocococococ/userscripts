// ==UserScript==
// @name         Google Maps Saved List to GPX
// @namespace    local.google-maps-gpx
// @version      0.2.1
// @description  Export the saved list currently loaded in Google Maps as GPX.
// @homepageURL  https://github.com/ocococococ/userscripts
// @downloadURL  https://raw.githubusercontent.com/ocococococ/userscripts/main/google-maps-saved-list-to-gpx.user.js
// @updateURL    https://raw.githubusercontent.com/ocococococ/userscripts/main/google-maps-saved-list-to-gpx.user.js
// @match        https://www.google.com/maps*
// @match        https://maps.google.com/*
// @include      https://www.google.*/maps*
// @include      file:///*entity_list*.json
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const PATCH_KEY = "__googleMapsSavedListToGpxPatched";
  const ENTITY_LIST_RE = /\/maps\/preview\/entitylist\/getlist\b/;

  if (window[PATCH_KEY]) {
    return;
  }
  window[PATCH_KEY] = true;

  let latestPlaceList = null;
  let latestSource = "";
  let panel = null;
  let button = null;
  let titleLine = null;
  let statusLine = null;

  class Coordinate {
    constructor(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        throw new TypeError(`Invalid coordinate: ${value}`);
      }
      this.value = number;
    }

    format() {
      return this.value.toFixed(8).replace(/\.?0+$/, "");
    }

    toString() {
      return String(this.value);
    }
  }

  class Coordinates {
    constructor(latitude, longitude) {
      this.latitude = latitude;
      this.longitude = longitude;
    }
  }

  class Place {
    constructor(name, coordinates) {
      this.name = name;
      this.coordinates = coordinates;
    }
  }

  function loadGoogleJson(text) {
    let payload = text.trimStart();
    if (payload.startsWith(")]}'")) {
      payload = payload.replace(/^\)\]\}'\s*/, "");
    }
    return JSON.parse(payload);
  }

  function extractPlaces(text) {
    const data = loadGoogleJson(text);
    const savedList = data[0];
    const title = String(savedList[4]);
    const items = savedList[8];

    if (!Array.isArray(items)) {
      throw new TypeError("Saved list response does not contain places");
    }

    const places = items.map((item) => {
      const coord = item[1][5];
      return new Place(
        String(item[2]),
        new Coordinates(
          new Coordinate(coord[2]),
          new Coordinate(coord[3]),
        ),
      );
    });

    return [title, places];
  }

  function escapeXml(value) {
    return String(value).replace(/[<>&'"]/g, (char) => {
      const entities = {
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        "'": "&apos;",
        "\"": "&quot;",
      };
      return entities[char];
    });
  }

  function writeGpx(placeList) {
    const [title, places] = placeList;
    const escapedTitle = escapeXml(title);
    const lines = [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<gpx",
      "  version=\"1.1\"",
      "  creator=\"userscript.js\"",
      "  xmlns=\"http://www.topografix.com/GPX/1/1\"",
      "  xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"",
      "  xsi:schemaLocation=\"http://www.topografix.com/GPX/1/1 " +
        "http://www.topografix.com/GPX/1/1/gpx.xsd\"",
      ">",
      "  <metadata>",
      `    <name>${escapedTitle}</name>`,
      `    <desc>Google Maps saved list: ${escapedTitle}</desc>`,
      "  </metadata>",
    ];

    for (const place of places) {
      const coordinates = place.coordinates;
      lines.push(
        "  <wpt " +
          `lat="${coordinates.latitude.format()}" ` +
          `lon="${coordinates.longitude.format()}">`,
        `    <name>${escapeXml(place.name)}</name>`,
        "  </wpt>",
      );
    }

    lines.push("</gpx>", "");
    return lines.join("\n");
  }

  function filenameFromTitle(title) {
    const filename = String(title)
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ");
    return `${filename || "entity_list"}.gpx`;
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], {
      type: "application/gpx+xml;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function isEntityListUrl(url) {
    return typeof url === "string" && ENTITY_LIST_RE.test(url);
  }

  function requestUrl(input) {
    if (typeof input === "string") {
      return input;
    }
    if (input && typeof input.url === "string") {
      return input.url;
    }
    if (input && typeof input.href === "string") {
      return input.href;
    }
    return "";
  }

  function handleEntityListText(text, source) {
    const placeList = extractPlaces(text);
    const [, places] = placeList;
    if (places.length === 0) {
      throw new Error("Saved list response has no places");
    }

    latestPlaceList = placeList;
    latestSource = source || "";
    updatePanel(null);
    console.debug(
      "[Google Maps GPX] Captured saved list",
      placeList[0],
      places.length,
      latestSource,
    );
  }

  function patchFetch() {
    if (typeof window.fetch !== "function") {
      return;
    }

    const originalFetch = window.fetch;
    window.fetch = function patchedFetch(input, init) {
      const url = requestUrl(input);
      return originalFetch.call(this, input, init).then((response) => {
        if (isEntityListUrl(url)) {
          response.clone().text().then((text) => {
            try {
              handleEntityListText(text, url);
            } catch (error) {
              updatePanel(error);
            }
          }).catch((error) => updatePanel(error));
        }
        return response;
      });
    };
  }

  function patchXmlHttpRequest() {
    if (typeof window.XMLHttpRequest !== "function") {
      return;
    }

    const proto = window.XMLHttpRequest.prototype;
    const originalOpen = proto.open;
    const originalSend = proto.send;

    proto.open = function patchedOpen(method, url, ...rest) {
      this.__gpxEntityListUrl = requestUrl(url);
      return originalOpen.call(this, method, url, ...rest);
    };

    proto.send = function patchedSend(...args) {
      this.addEventListener("load", function onLoad() {
        const url = this.__gpxEntityListUrl || "";
        if (!isEntityListUrl(url)) {
          return;
        }

        if (this.responseType && this.responseType !== "text") {
          return;
        }

        try {
          handleEntityListText(this.responseText || "", url);
        } catch (error) {
          updatePanel(error);
        }
      });
      return originalSend.apply(this, args);
    };
  }

  function styleButton(isEnabled) {
    button.disabled = !isEnabled;
    button.style.cursor = isEnabled ? "pointer" : "default";
    button.style.padding = "7px 10px";
    button.style.border = "1px solid #1a73e8";
    button.style.borderRadius = "4px";
    button.style.background = isEnabled ? "#1a73e8" : "#e8eaed";
    button.style.color = isEnabled ? "#fff" : "#5f6368";
    button.style.font = "13px Arial, sans-serif";
  }

  function ensurePanel() {
    if (panel || !document.body) {
      return;
    }

    panel = document.createElement("div");
    panel.style.position = "fixed";
    panel.style.top = "12px";
    panel.style.right = "12px";
    panel.style.zIndex = "2147483647";
    panel.style.padding = "10px";
    panel.style.maxWidth = "340px";
    panel.style.border = "1px solid #dadce0";
    panel.style.borderRadius = "6px";
    panel.style.background = "#fff";
    panel.style.boxShadow = "0 2px 10px rgba(60, 64, 67, 0.25)";
    panel.style.color = "#202124";
    panel.style.font = "13px Arial, sans-serif";

    button = document.createElement("button");
    button.type = "button";
    button.addEventListener("click", () => {
      if (!latestPlaceList) {
        return;
      }
      downloadText(
        filenameFromTitle(latestPlaceList[0]),
        writeGpx(latestPlaceList),
      );
    });

    titleLine = document.createElement("div");
    titleLine.style.marginTop = "8px";
    titleLine.style.overflow = "hidden";
    titleLine.style.textOverflow = "ellipsis";
    titleLine.style.whiteSpace = "nowrap";

    statusLine = document.createElement("div");
    statusLine.style.marginTop = "5px";
    statusLine.style.color = "#5f6368";

    panel.appendChild(button);
    panel.appendChild(titleLine);
    panel.appendChild(statusLine);
    document.body.appendChild(panel);

    updatePanel(null);
  }

  function updatePanel(error) {
    ensurePanel();
    if (!panel) {
      return;
    }

    if (error) {
      button.textContent = "Download GPX";
      styleButton(false);
      titleLine.textContent = "No saved list captured";
      statusLine.textContent = `Capture failed: ${error.message}`;
      return;
    }

    if (!latestPlaceList) {
      button.textContent = "Waiting for saved list";
      styleButton(false);
      titleLine.textContent = "Open a saved list in Google Maps";
      statusLine.textContent = "The button enables after Maps loads a list.";
      return;
    }

    const [title, places] = latestPlaceList;
    button.textContent = `Download ${places.length} GPX waypoint(s)`;
    styleButton(true);
    titleLine.textContent = title;
    statusLine.textContent = latestSource
      ? "Captured entitylist/getlist response"
      : "Captured saved list data";
  }

  function isRawEntityListPage() {
    return isEntityListUrl(window.location.href) ||
      /entity_list.*\.json$/i.test(window.location.pathname);
  }

  function tryParseBodyText() {
    if (!document.body || !isRawEntityListPage()) {
      return;
    }

    try {
      handleEntityListText(document.body.textContent || "", window.location.href);
    } catch (error) {
      updatePanel(error);
    }
  }

  function onReady(callback) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
      return;
    }
    callback();
  }

  patchFetch();
  patchXmlHttpRequest();

  onReady(() => {
    ensurePanel();
    tryParseBodyText();
  });
}());
