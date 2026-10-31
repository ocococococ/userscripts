// ==UserScript==
// @name         Telerama - Download issue as PDF/ZIP
// @namespace    local.telerama-to-pdf
// @version      0.3.0
// @description  Adds ZIP and PDF buttons to the magazine.telerama.fr (Twipe) viewer that download the open Telerama or Sortir issue as one merged PDF or as a ZIP of page PDFs
// @homepageURL  https://github.com/ocococococ/userscripts
// @downloadURL  https://raw.githubusercontent.com/ocococococ/userscripts/main/telerama-to-pdf.user.js
// @updateURL    https://raw.githubusercontent.com/ocococococ/userscripts/main/telerama-to-pdf.user.js
// @match        https://magazine.telerama.fr/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js#sha256=0f9a5cad07941f0826586c94e089d89b918c46e5c17cf2d5a3c6f666e3bc694f
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      twipecloud.net
// @run-at       document-start
// ==/UserScript==

/* global PDFLib */

(function () {
  'use strict';

  const LOG = '[telerama-to-pdf]';
  const PAGES_RE = /GetPublicationPages-(\d+)\.json/i;
  // Twipe data files are named <Name>-<id>.json (GetPublicationPages-8678.json);
  // those of the open issue (publication or package id) are saved in the ZIP.
  const DATA_JSON_RE = /\/([A-Za-z]+)-(\d+)\.json(?:[?#]|$)/;
  // GetDownloadCredentials/<userId>/<sessionId>/<downloadId>, requested when the viewer opens.
  const CREDENTIALS_RE = /\/GetDownloadCredentials\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)/i;
  // Pdf/<pageId>/<version>/<sessionId>/<userId>/<downloadId>/url, requested by "Page actuelle".
  const PDF_URL_RE = /\/Pdf\/\d+\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)\/url\b/i;
  // Viewer platform version sent in Pdf URLs ("Platform v3.39.0" in reader.html).
  const DEFAULT_API_VERSION = '3.39.0';
  const CONCURRENCY = 4;
  const RETRIES = 2;
  // First part of ExternalPageReference ("TLR_20261007_001") -> file name.
  const MAGAZINE_NAMES = { TLR: 'T\u00e9l\u00e9rama', SORTTLR: 'T\u00e9l\u00e9rama Paris' };
  const MONTH_NAMES = [
    'Janvier',
    'F\u00e9vrier',
    'Mars',
    'Avril',
    'Mai',
    'Juin',
    'Juillet',
    'Ao\u00fbt',
    'Septembre',
    'Octobre',
    'Novembre',
    'D\u00e9cembre',
  ];
  // Issue number as printed on the cover ("SUPPLEMENT DE TELERAMA No 4007"). Inner page
  // folios ("Telerama Paris 4007") use subset fonts whose digits are not plain text.
  // Also matches "N<degree sign> 4007" and "N<masculine ordinal> 4007" (Telerama covers).
  // The next line's text follows directly ("4007Du 31/10"), so no \b after the number.
  // Skips the press registration number nearby ("CPPAP N<masculine ordinal> 0630 C 80864").
  const ISSUE_RE = /(?<!CPPAP\s*)\bN[o\u00b0\u00ba]\.?\s*([1-9]\d{3,4})(?!\d)/;
  const ISSUE_SEARCH_PAGES = 3;

  // pubId -> [{id, number, reference}] sorted by page number
  const pagesByPub = new Map();
  // "GetPublicationPages-8678" -> last parsed answer
  const dataJsonByName = new Map();
  // Ids the viewer passes to the API. Page PDF URLs are signed per request,
  // so they have to be asked for with these.
  let session = null; // {apiOrigin, version, userId, sessionId, downloadId, headers}
  let lastPubId = null;
  // pubId -> issue number ("4007"), or null when none was found.
  const issueByPub = new Map();
  const issueLookups = new Set();
  let busy = false;
  // Set by the Stop button; checked between requests, while in-flight
  // requests are aborted directly.
  let cancelled = false;
  const activeRequests = new Set();

  // --- Capture the viewer's own requests ---

  function recordDataJson(url, text) {
    const match = DATA_JSON_RE.exec(url);
    if (!match) return;
    const name = `${match[1]}-${match[2]}`;
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      console.warn(LOG, `could not parse ${name}.json`, url, err);
      return;
    }
    dataJsonByName.set(name, json);
    if (PAGES_RE.test(url)) recordPages(url, json);
  }

  function recordPages(url, json) {
    const pubId = String(json.PublicationId ?? PAGES_RE.exec(url)[1]);
    const pages = (json.Page || [])
      .filter((page) => Number.isFinite(page.PublicationPageID) && Number.isFinite(page.PageNumber))
      .map((page) => ({ id: page.PublicationPageID, number: page.PageNumber, reference: page.ExternalPageReference || '' }))
      .sort((a, b) => a.number - b.number);
    console.log(LOG, `GetPublicationPages ${pubId}: ${pages.length} page(s)`, json);
    if (!pages.length) return;

    pagesByPub.set(pubId, pages);
    lastPubId = pubId;
    updatePanel();
  }

  function recordSession(url, headers) {
    let match = CREDENTIALS_RE.exec(url);
    let ids = null;
    if (match) {
      ids = { userId: match[1], sessionId: match[2], downloadId: match[3] };
    } else if ((match = PDF_URL_RE.exec(url))) {
      ids = { version: match[1], sessionId: match[2], userId: match[3], downloadId: match[4] };
    }
    if (!ids) return;
    session = { version: session?.version || DEFAULT_API_VERSION, ...ids, apiOrigin: new URL(url).origin, headers };
    console.log(LOG, 'captured session ids', session);
    updatePanel();
  }

  // Returns true when the response should be passed to recordDataJson().
  function observeRequest(url, headers) {
    const href = new URL(url, location.href).href;
    recordSession(href, headers);
    return DATA_JSON_RE.test(href);
  }

  function headersToObject(headers) {
    const out = {};
    if (!headers) return out;
    try {
      new Headers(headers).forEach((value, name) => {
        out[name] = value;
      });
    } catch {
      // Opaque cross-compartment object; replay without extra headers.
    }
    return out;
  }

  const OriginalXHR = unsafeWindow.XMLHttpRequest;
  const originalOpen = OriginalXHR.prototype.open;
  const originalSetRequestHeader = OriginalXHR.prototype.setRequestHeader;
  const originalSend = OriginalXHR.prototype.send;

  OriginalXHR.prototype.open = function (method, url, ...rest) {
    this._teleramaUrl = String(url);
    this._teleramaHeaders = {};
    return originalOpen.call(this, method, url, ...rest);
  };

  OriginalXHR.prototype.setRequestHeader = function (name, value) {
    if (this._teleramaHeaders) this._teleramaHeaders[name] = value;
    return originalSetRequestHeader.call(this, name, value);
  };

  OriginalXHR.prototype.send = function (body) {
    if (this._teleramaUrl && observeRequest(this._teleramaUrl, this._teleramaHeaders)) {
      this.addEventListener('load', function () {
        if (this.status >= 200 && this.status < 300) {
          const text = typeof this.response === 'string' ? this.response : this.responseText;
          recordDataJson(this._teleramaUrl, text);
        }
      });
    }
    return originalSend.call(this, body);
  };

  const originalFetch = unsafeWindow.fetch;
  unsafeWindow.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    const promise = originalFetch.apply(this, arguments);
    const headers = headersToObject(init?.headers || (typeof input === 'object' ? input.headers : null));
    if (observeRequest(url, headers)) {
      promise
        .then((res) => (res.ok ? res.clone().text() : null))
        .then((text) => text && recordDataJson(url, text))
        .catch((err) => console.warn(LOG, 'fetch capture failed', err));
    }
    return promise;
  };

  // The hash ("#!.../pub/8593/page/1") names the open issue; fall back to
  // the last page list seen.
  function currentPubId() {
    const match = /\/pub\/(\d+)/.exec(location.hash);
    if (match && pagesByPub.has(match[1])) return match[1];
    return lastPubId;
  }

  // --- Network helpers ---

  class CancelledError extends Error {
    constructor() {
      super('Cancelled');
    }
  }

  function throwIfCancelled() {
    if (cancelled) throw new CancelledError();
  }

  // Start of an error response, e.g. CloudFront/S3 XML telling a missing file
  // ("<Code>AccessDenied</Code>" with a RequestId) from a bad signature.
  function errorBody(res) {
    try {
      const text =
        res.response instanceof ArrayBuffer ? new TextDecoder().decode(res.response.slice(0, 400)) : res.responseText;
      return (text || '').replace(/\s+/g, ' ').slice(0, 400);
    } catch {
      return '';
    }
  }

  function gmRequest(url, { headers = {}, responseType = 'text' } = {}) {
    throwIfCancelled();
    return new Promise((resolve, reject) => {
      const settle = (fn, value) => {
        activeRequests.delete(request);
        fn(value);
      };
      const request = GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers,
        responseType,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) settle(resolve, res);
          else settle(reject, new Error(`HTTP ${res.status} for ${url}: ${errorBody(res)}`));
        },
        onerror: () => settle(reject, new Error(`Network error for ${url}`)),
        ontimeout: () => settle(reject, new Error(`Timeout for ${url}`)),
        onabort: () => settle(reject, new CancelledError()),
      });
      activeRequests.add(request);
    });
  }

  function cancelAction() {
    if (!busy || cancelled) return;
    cancelled = true;
    setStatus('Stopping...');
    for (const request of activeRequests) request.abort();
  }

  // Same call as the viewer's "Page actuelle": returns a short-lived signed
  // CDN URL in ReturnMessage.
  async function fetchPagePdfUrl(pageId) {
    const { apiOrigin, version, sessionId, userId, downloadId, headers } = session;
    const url = `${apiOrigin}/Pdf/${pageId}/${version}/${sessionId}/${userId}/${downloadId}/url`;
    const res = await gmRequest(url, { headers });
    let pdfUrl;
    try {
      pdfUrl = JSON.parse(res.responseText).ReturnMessage;
    } catch {
      // Reported below with the raw response.
    }
    if (typeof pdfUrl !== 'string' || !/^https?:\/\//.test(pdfUrl)) {
      throw new Error(`no PDF URL for page ${pageId}: ${res.responseText.slice(0, 200)}`);
    }
    return pdfUrl;
  }

  function isPdf(bytes) {
    return bytes.length > 4 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-';
  }

  async function fetchPagePdf(page, retries = RETRIES) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        // Ask for a fresh signed URL on every attempt: they expire quickly.
        const url = await fetchPagePdfUrl(page.id);
        const res = await gmRequest(url, { responseType: 'arraybuffer' });
        const bytes = new Uint8Array(res.response);
        if (!isPdf(bytes)) throw new Error(`page ${page.number} is not a PDF`);
        return bytes;
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  async function fetchAllPages(pages, onProgress) {
    const results = new Array(pages.length);
    let next = 0;
    let done = 0;

    const worker = async () => {
      while (next < pages.length) {
        const index = next++;
        const page = pages[index];
        // Sequential per worker on purpose: CONCURRENCY workers bound the load on the API.
        results[index] = { page: page.number, bytes: await fetchPagePdf(page) }; // NOSONAR
        onProgress(++done, pages.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pages.length) }, worker));
    return results;
  }

  // --- ZIP (store only: page PDFs are already compressed) ---

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  // General purpose bit 11: entry names are UTF-8 (accented magazine names).
  const ZIP_UTF8_FLAG = 0x0800;

  function buildZip(files) {
    const encoder = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [];
    const central = [];
    let offset = 0;

    for (const file of files) {
      const name = encoder.encode(file.name);
      const crc = crc32(file.bytes);
      const size = file.bytes.length;

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, ZIP_UTF8_FLAG, true);
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, size, true);
      local.setUint32(22, size, true);
      local.setUint16(26, name.length, true);
      parts.push(local.buffer, name, file.bytes);

      const entry = new DataView(new ArrayBuffer(46));
      entry.setUint32(0, 0x02014b50, true);
      entry.setUint16(4, 20, true);
      entry.setUint16(6, 20, true);
      entry.setUint16(8, ZIP_UTF8_FLAG, true);
      entry.setUint16(12, dosTime, true);
      entry.setUint16(14, dosDate, true);
      entry.setUint32(16, crc, true);
      entry.setUint32(20, size, true);
      entry.setUint32(24, size, true);
      entry.setUint16(28, name.length, true);
      entry.setUint32(42, offset, true);
      central.push(entry.buffer, name);

      offset += 30 + name.length + size;
    }

    const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }

  // --- PDF (single-page PDFs merged with pdf-lib) ---

  async function mergePdfs(files, title, onProgress) {
    const merged = await PDFLib.PDFDocument.create();
    for (const [index, bytes] of files.entries()) {
      throwIfCancelled();
      // Sequential on purpose: pages must stay in order.
      const source = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true }); // NOSONAR
      const copied = await merged.copyPages(source, source.getPageIndices()); // NOSONAR
      copied.forEach((page) => merged.addPage(page));
      onProgress(index + 1, files.length);
    }
    merged.setTitle(title);
    merged.setProducer('telerama-to-pdf userscript');
    return new Blob([await merged.save()], { type: 'application/pdf' });
  }

  // --- Download ---

  // Literal strings of a decoded PDF content stream, joined. Covers use WinAnsi
  // fonts, so "[(N)]TJ (o)Tj [( 4)2.02(00)23.98(7)]TJ" reads "No 4007".
  function pdfLiteralText(bytes) {
    const raw = new TextDecoder('latin1').decode(bytes);
    let text = '';
    for (const [, body] of raw.matchAll(/\(((?:\\[\s\S]|[^\\)])*)\)/g)) {
      text += body.replaceAll(/\\([0-7]{1,3}|[\s\S])/g, (_, esc) =>
        /^[0-7]/.test(esc) ? String.fromCodePoint(Number.parseInt(esc, 8)) : esc
      );
    }
    return text;
  }

  async function findIssueNumberInPage(bytes) {
    const { PDFDocument, PDFRawStream, PDFName, decodePDFRawStream } = PDFLib;
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    for (const [, object] of doc.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFRawStream) || object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) {
        continue;
      }
      let decoded;
      try {
        decoded = decodePDFRawStream(object).decode();
      } catch {
        continue; // Filter pdf-lib cannot decode; not a text stream anyway.
      }
      const match = ISSUE_RE.exec(pdfLiteralText(decoded));
      if (match) return match[1];
    }
    return null;
  }

  // Issue number from the first pages' text, or null.
  async function findIssueNumber(files) {
    for (const { page, bytes } of files.slice(0, ISSUE_SEARCH_PAGES)) {
      try {
        // Sequential on purpose: usually found on the cover.
        const issue = await findIssueNumberInPage(bytes); // NOSONAR
        if (issue) return issue;
      } catch (err) {
        console.warn(LOG, `could not read the text of page ${page}`, err);
      }
    }
    return null;
  }

  // ExternalPageReference "TLR_20261028_001" + issue "4007" -> ["Telerama No. 4007", "28 Octobre 2026"]
  // (accented), ["Telerama", "28 Octobre 2026"] without an issue number.
  function buildNameParts(pubId, pages, issue = null) {
    const match = /^([A-Za-z]+)_(\d{4})(\d{2})(\d{2})_/.exec(pages[0].reference);
    if (!match) return [`${MAGAZINE_NAMES.TLR} ${pubId}`];
    const [, code, year, month, day] = match;
    const name = MAGAZINE_NAMES[code.toUpperCase()] || code;
    const title = issue ? `${name} No. ${issue}` : name;
    return [title, `${day} ${MONTH_NAMES[Number(month) - 1] || month} ${year}`];
  }

  // "Telerama No. 4007 - 28 Octobre 2026" (accented)
  function buildFileName(pubId, pages, issue = null) {
    return buildNameParts(pubId, pages, issue).join(' - ');
  }

  // Reads the issue number from the first pages as soon as the session is
  // known, so the panel shows the final file name before any download.
  async function lookupIssue(pubId) {
    if (busy || !session || issueByPub.has(pubId) || issueLookups.has(pubId)) return;
    issueLookups.add(pubId);
    try {
      let issue = null;
      for (const page of pagesByPub.get(pubId).slice(0, ISSUE_SEARCH_PAGES)) {
        // Sequential on purpose: usually found on the cover, no need for more pages.
        const bytes = await fetchPagePdf(page); // NOSONAR
        issue = await findIssueNumber([{ page: page.number, bytes }]); // NOSONAR
        if (issue) break;
      }
      issueByPub.set(pubId, issue);
    } catch (err) {
      // Left unset when stopped, so it is tried again after the action.
      if (!(err instanceof CancelledError)) {
        console.warn(LOG, 'could not read the issue number', err);
        issueByPub.set(pubId, null);
      }
    } finally {
      issueLookups.delete(pubId);
      updatePanel();
    }
  }

  function jsonFile(baseName, name, data) {
    const bytes = new TextEncoder().encode(`${JSON.stringify(data, null, 2)}\n`);
    return { name: `${baseName}/${name}.json`, bytes };
  }

  // The open issue's Twipe data files (named after the publication or package
  // id), plus issue.json describing the download. Credentials and the signed
  // page URLs are left out.
  function buildJsonFiles(pubId, pages, files, baseName, issue) {
    const packageId = /\/package\/(\d+)/.exec(location.hash)?.[1] || null;
    const ids = new Set([pubId, packageId].filter(Boolean));
    const summary = {
      name: baseName,
      issue,
      pubId,
      packageId,
      viewerUrl: location.href,
      pages: pages.map((page, index) => ({
        number: page.number,
        id: page.id,
        reference: page.reference,
        bytes: files[index]?.bytes.length,
      })),
    };
    const data = [...dataJsonByName].filter(([name]) => ids.has(name.split('-').pop()));
    return [jsonFile(baseName, 'issue', summary), ...data.map(([name, json]) => jsonFile(baseName, name, json))];
  }

  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // Runs one panel action with the buttons disabled; its return value (or
  // error) stays as the status line until the next action.
  async function runAction(action) {
    const pubId = currentPubId();
    if (busy || !pubId || !session) return;
    busy = true;
    cancelled = false;
    lastResult = '';
    updatePanel();
    try {
      lastResult = await action(pubId);
    } catch (err) {
      if (err instanceof CancelledError) {
        lastResult = 'Stopped.';
      } else {
        console.error(LOG, err);
        lastResult = `Error: ${err.message}`;
      }
    } finally {
      cancelled = false;
      busy = false;
      setProgress(null);
      updatePanel();
    }
  }

  function runDownload(format) {
    return runAction(async (pubId) => {
      const pages = pagesByPub.get(pubId);

      const files = await fetchAllPages(pages, (done, total) => {
        setStatus(`Downloading pages ${done}/${total}...`);
        setProgress(done, total);
      });

      throwIfCancelled();
      const issue = issueByPub.get(pubId) || (await findIssueNumber(files));
      if (!issue) console.warn(LOG, 'no issue number found on the first pages; naming by date');
      issueByPub.set(pubId, issue);
      const baseName = buildFileName(pubId, pages, issue);
      setStatus(`Building ${format.toUpperCase()}...`);
      if (format === 'zip') {
        const digits = String(files.at(-1).page).length;
        const entries = files.map(({ page, bytes }) => ({
          name: `${baseName}/page-${String(page).padStart(Math.max(3, digits), '0')}.pdf`,
          bytes,
        }));
        const jsonFiles = buildJsonFiles(pubId, pages, files, baseName, issue);
        downloadBlob(`${baseName}.zip`, buildZip([...jsonFiles, ...entries]));
      } else {
        const pdf = await mergePdfs(
          files.map((file) => file.bytes),
          baseName,
          (done, total) => {
            setStatus(`Merging pages ${done}/${total}...`);
            setProgress(done, total);
          }
        );
        downloadBlob(`${baseName}.pdf`, pdf);
      }
      return `Done: ${files.length} pages.`;
    });
  }

  // --- Floating panel ---

  const POSITION_KEY = 'telerama-to-pdf.panel-position';
  let panel = null;
  let nameLine = null;
  let statusLine = null;
  let progressBar = null;
  let zipButton = null;
  let pdfButton = null;
  let stopButton = null;
  let lastResult = '';

  function makeButton(label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.style.cssText =
      'margin:0 2px;padding:2px 8px;border:0;border-radius:3px;background:#1a73e8;color:#fff;font:600 11px/16px sans-serif;cursor:pointer';
    button.addEventListener('click', onClick);
    return button;
  }

  function setStatus(text) {
    if (statusLine) statusLine.textContent = text;
  }

  // setProgress(null) hides the bar.
  function setProgress(done, total) {
    if (!progressBar) return;
    progressBar.style.display = done === null ? 'none' : 'block';
    if (done !== null) {
      progressBar.max = total;
      progressBar.value = done;
    }
  }

  function loadPanelPosition() {
    try {
      const position = JSON.parse(localStorage.getItem(POSITION_KEY));
      return Number.isFinite(position?.left) && Number.isFinite(position?.top) ? position : null;
    } catch {
      return null;
    }
  }

  function savePanelPosition() {
    try {
      const { left, top } = panel.getBoundingClientRect();
      localStorage.setItem(POSITION_KEY, JSON.stringify({ left, top }));
    } catch {
      // Storage blocked: the position just is not remembered.
    }
  }

  // Moves the panel to (left, top), kept inside the window.
  function placePanel(left, top) {
    const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
    panel.style.left = `${Math.min(Math.max(0, left), maxLeft)}px`;
    panel.style.top = `${Math.min(Math.max(0, top), maxTop)}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  // Dragging anywhere but on a button moves the panel; the position is
  // remembered for the next issue.
  function makeDraggable() {
    panel.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button')) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = panel.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      const move = (moveEvent) => placePanel(moveEvent.clientX - offsetX, moveEvent.clientY - offsetY);
      panel.setPointerCapture(event.pointerId);
      panel.addEventListener('pointermove', move);
      panel.addEventListener(
        'lostpointercapture',
        () => {
          panel.removeEventListener('pointermove', move);
          savePanelPosition();
        },
        { once: true }
      );
    });
    window.addEventListener('resize', () => {
      if (!panel.style.top) return;
      const { left, top } = panel.getBoundingClientRect();
      placePanel(left, top);
    });
  }

  function createPanel() {
    if (panel || !document.body) return;
    panel = document.createElement('div');
    panel.title = 'Drag to move';
    // Bottom right by default, narrow enough for the margin the viewer leaves there.
    panel.style.cssText =
      'position:fixed;right:8px;bottom:8px;z-index:2147483647;box-sizing:border-box;max-width:180px;text-align:center;' +
      'padding:6px 8px;border-radius:6px;background:#fff;color:#222;box-shadow:0 1px 6px rgba(0,0,0,.3);' +
      'font:11px/14px sans-serif;cursor:move;user-select:none;touch-action:none';

    nameLine = document.createElement('div');
    nameLine.style.cssText = 'margin-bottom:2px;font-weight:600;white-space:pre-line';

    statusLine = document.createElement('div');
    statusLine.style.marginBottom = '4px';

    progressBar = document.createElement('progress');
    progressBar.style.cssText = 'display:none;width:100%;height:8px;margin-bottom:4px';

    zipButton = makeButton('ZIP', () => runDownload('zip'));
    pdfButton = makeButton('PDF', () => runDownload('pdf'));
    stopButton = makeButton('Stop', cancelAction);
    stopButton.style.background = '#c0392b';

    panel.append(nameLine, statusLine, progressBar, zipButton, pdfButton, stopButton);
    document.body.appendChild(panel);
    makeDraggable();
    const position = loadPanelPosition();
    if (position) placePanel(position.left, position.top);
    updatePanel();
  }

  function waitingText(pubId) {
    if (!pubId) return 'Waiting for the viewer to load the issue...';
    const count = pagesByPub.get(pubId).length;
    if (!session) return `${count} pages listed, waiting for session ids (open the viewer's download menu once if this stays).`;
    if (issueLookups.has(pubId)) return `${count} pages, reading the issue number from the cover...`;
    return `${count} pages`;
  }

  function updatePanel() {
    if (!panel) {
      createPanel();
      return;
    }
    const pubId = currentPubId();
    const ready = Boolean(pubId && session) && !busy;
    for (const button of [zipButton, pdfButton]) {
      button.disabled = !ready;
      button.style.opacity = ready ? '1' : '0.5';
    }
    stopButton.style.display = busy ? '' : 'none';
    // Before the status: a lookup it starts shows as "reading the issue number".
    if (pubId) lookupIssue(pubId);
    const pages = pubId && pagesByPub.get(pubId);
    // File name parts, the date on its own line.
    nameLine.textContent = pages ? buildNameParts(pubId, pages, issueByPub.get(pubId)).join('\n') : '';
    nameLine.style.display = pages ? '' : 'none';
    if (!busy) setStatus(lastResult || waitingText(pubId));
  }

  window.addEventListener('hashchange', () => {
    if (!busy) lastResult = '';
    updatePanel();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updatePanel);
  } else {
    updatePanel();
  }
})();
