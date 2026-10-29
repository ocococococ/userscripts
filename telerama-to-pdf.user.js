// ==UserScript==
// @name         Telerama - Download issue as PDF/ZIP
// @namespace    local.telerama-to-pdf
// @version      0.1.0
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
  // GetDownloadCredentials/<userId>/<sessionId>/<downloadId>, requested when the viewer opens.
  const CREDENTIALS_RE = /\/GetDownloadCredentials\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)/i;
  // Pdf/<pageId>/<version>/<sessionId>/<userId>/<downloadId>/url, requested by "Page actuelle".
  const PDF_URL_RE = /\/Pdf\/\d+\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)\/url\b/i;
  // Viewer platform version sent in Pdf URLs ("Platform v3.39.0" in reader.html).
  const DEFAULT_API_VERSION = '3.39.0';
  const CONCURRENCY = 4;
  const RETRIES = 2;
  // First part of ExternalPageReference ("TLR_20261007_001") -> file name.
  const MAGAZINE_NAMES = { TLR: 'Telerama' };

  // pubId -> [{id, number, reference}] sorted by page number
  const pagesByPub = new Map();
  // Ids the viewer passes to the API. Page PDF URLs are signed per request,
  // so they have to be asked for with these.
  let session = null; // {apiOrigin, version, userId, sessionId, downloadId, headers}
  let lastPubId = null;
  let busy = false;
  // Set by the Stop button; checked between requests, while in-flight
  // requests are aborted directly.
  let cancelled = false;
  const activeRequests = new Set();

  // --- Capture the viewer's own requests ---

  function recordPages(url, text) {
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      console.warn(LOG, 'could not parse GetPublicationPages response', url, err);
      return;
    }
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

  // Returns true when the response should be passed to recordPages().
  function observeRequest(url, headers) {
    const href = new URL(url, location.href).href;
    recordSession(href, headers);
    return PAGES_RE.test(href);
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
          recordPages(this._teleramaUrl, text);
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
        .then((text) => text && recordPages(url, text))
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

  // ExternalPageReference "TLR_20261007_001" -> "telerama-2026-10-07" / "Telerama 2026-10-07"
  function buildNames(pubId, pages) {
    const match = /^([A-Za-z]+)_(\d{4})(\d{2})(\d{2})_/.exec(pages[0].reference);
    if (!match) return { baseName: `telerama-${pubId}`, title: `Telerama ${pubId}` };
    const code = match[1].toUpperCase();
    const name = MAGAZINE_NAMES[code] || code;
    const date = `${match[2]}-${match[3]}-${match[4]}`;
    return { baseName: `${name.toLowerCase()}-${date}`, title: `${name} ${date}` };
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
      const { baseName, title } = buildNames(pubId, pages);

      const files = await fetchAllPages(pages, (done, total) => {
        setStatus(`Downloading pages ${done}/${total}...`);
        setProgress(done, total);
      });

      throwIfCancelled();
      setStatus(`Building ${format.toUpperCase()}...`);
      if (format === 'zip') {
        const digits = String(files.at(-1).page).length;
        const entries = files.map(({ page, bytes }) => ({
          name: `${baseName}/page-${String(page).padStart(Math.max(3, digits), '0')}.pdf`,
          bytes,
        }));
        downloadBlob(`${baseName}.zip`, buildZip(entries));
      } else {
        const pdf = await mergePdfs(
          files.map((file) => file.bytes),
          title,
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

  let panel = null;
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
      'margin-right:6px;padding:4px 10px;border:0;border-radius:4px;background:#1a73e8;color:#fff;font:600 12px sans-serif;cursor:pointer';
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

  function createPanel() {
    if (panel || !document.body) return;
    panel = document.createElement('div');
    panel.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:10px 12px;border-radius:8px;' +
      'background:#fff;color:#222;box-shadow:0 2px 10px rgba(0,0,0,.3);font:12px sans-serif;max-width:260px';

    statusLine = document.createElement('div');
    statusLine.style.marginBottom = '6px';

    progressBar = document.createElement('progress');
    progressBar.style.cssText = 'display:none;width:100%;margin-bottom:6px';

    zipButton = makeButton('ZIP', () => runDownload('zip'));
    pdfButton = makeButton('PDF', () => runDownload('pdf'));
    stopButton = makeButton('Stop', cancelAction);
    stopButton.style.background = '#c0392b';

    panel.append(statusLine, progressBar, zipButton, pdfButton, stopButton);
    document.body.appendChild(panel);
    updatePanel();
  }

  function waitingText(pubId) {
    if (!pubId) return 'Waiting for the viewer to load the issue...';
    const count = pagesByPub.get(pubId).length;
    if (!session) return `${count} pages listed, waiting for session ids (open the viewer's download menu once if this stays).`;
    return `${buildNames(pubId, pagesByPub.get(pubId)).title}: ${count} pages`;
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
