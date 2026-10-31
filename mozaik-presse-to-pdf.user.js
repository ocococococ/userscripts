// ==UserScript==
// @name         Mozaik - Download issue as PDF/ZIP
// @namespace    local.mozaik-to-pdf
// @version      0.2.2
// @description  Captures page tickets in the presse.mozaik.co (PressReader) viewer and downloads all pages as a ZIP of images or a PDF; adds Download buttons on app.mozaik.co issue pages
// @homepageURL  https://github.com/ocococococ/userscripts
// @downloadURL  https://raw.githubusercontent.com/ocococococ/userscripts/main/mozaik-presse-to-pdf.user.js
// @updateURL    https://raw.githubusercontent.com/ocococococ/userscripts/main/mozaik-presse-to-pdf.user.js
// @match        https://presse.mozaik.co/*
// @match        https://app.mozaik.co/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      i.prcdn.co
// @connect      ingress.pressreader.com
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const LOG = '[mozaik-presse-to-pdf]';
  const PAGE_KEYS_RE = /\/IssueInfo\/GetPageKeys\b/i;
  const IMAGE_BASE = 'https://i.prcdn.co/img';
  const DEFAULT_SCALE = 300;
  const CONCURRENCY = 4;
  const RETRIES = 2;
  // PDF pages are laid out at A4 width; height follows the image ratio.
  const PDF_PAGE_WIDTH_PT = 595;
  // Scales tried by "Find best scale", smallest first.
  const PROBE_SCALES = [200, 300, 400, 500, 600, 800, 1000, 1200];
  // Set by a Download button on app.mozaik.co, consumed by the viewer once
  // it has page keys. GM storage is per-script, so it crosses origins.
  const AUTO_DOWNLOAD_KEY = 'AUTO_DOWNLOAD';
  const AUTO_DOWNLOAD_TTL_MS = 3 * 60 * 1000;
  const LAUNCH_CLASS = 'mozaik-presse-to-pdf-launch';
  const CLICKABLE = 'button, a, [role="button"]';
  // Mozaik's "Lire" link: <a class="playBt ..." title="Lire" onclick="firePlayIframe(event)">,
  // pointing at the giftedaccess/activate URL. It appears on more than /press pages.
  const READ_BUTTON_SELECTOR = 'a.playBt, a[title="Lire"]';

  // Everything the app.mozaik.co branch uses must be declared above this
  // early return: later const/let stay uninitialized (TDZ) on that page.
  if (location.hostname === 'app.mozaik.co') {
    initLaunchButtons();
    return;
  }

  // issue id ("f6412026010100000000001001") -> Map(pageNumber -> ticket)
  const pageKeysByIssue = new Map();
  // Last GetPageKeys request seen, replayed to make sure we have every page.
  let lastKeysRequest = null; // {url, headers}
  let currentIssue = null;
  let busy = false;
  // Set by the Stop button; checked between requests, while in-flight
  // requests are aborted directly.
  let cancelled = false;
  const activeRequests = new Set();

  // --- Capture GetPageKeys responses from the viewer's own requests ---

  function extractPageKeys(json) {
    const keys = new Map();
    const visit = (node) => {
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (!node || typeof node !== 'object') return;
      let page = null;
      let key = null;
      for (const [name, value] of Object.entries(node)) {
        if (/^page(number)?$/i.test(name) && Number.isFinite(Number(value))) page = Number(value);
        else if (/^(key|ticket)$/i.test(name) && typeof value === 'string') key = value;
      }
      if (page !== null && page > 0 && key) keys.set(page, key);
      Object.values(node).forEach((v) => typeof v === 'object' && visit(v));
    };
    visit(json);
    return keys;
  }

  function recordPageKeys(url, headers, text) {
    let issue;
    let json;
    try {
      issue = new URL(url, location.href).searchParams.get('issue');
      json = JSON.parse(text);
    } catch (err) {
      console.warn(LOG, 'could not parse GetPageKeys response', url, err);
      return;
    }
    if (!issue) return;

    const keys = extractPageKeys(json);
    console.log(LOG, `GetPageKeys ${issue}: ${keys.size} key(s)`, json);
    if (!keys.size) return;

    if (!pageKeysByIssue.has(issue)) pageKeysByIssue.set(issue, new Map());
    const known = pageKeysByIssue.get(issue);
    keys.forEach((key, page) => known.set(page, key));

    currentIssue = issue;
    lastKeysRequest = { url: new URL(url, location.href).href, headers: headers || {} };
    updatePanel();
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
    this._mozaikUrl = String(url);
    this._mozaikHeaders = {};
    return originalOpen.call(this, method, url, ...rest);
  };

  OriginalXHR.prototype.setRequestHeader = function (name, value) {
    if (this._mozaikHeaders) this._mozaikHeaders[name] = value;
    return originalSetRequestHeader.call(this, name, value);
  };

  OriginalXHR.prototype.send = function (body) {
    if (PAGE_KEYS_RE.test(this._mozaikUrl || '')) {
      this.addEventListener('load', function () {
        if (this.status >= 200 && this.status < 300) {
          const text = typeof this.response === 'string' ? this.response : this.responseText;
          recordPageKeys(this._mozaikUrl, this._mozaikHeaders, text);
        }
      });
    }
    return originalSend.call(this, body);
  };

  const originalFetch = unsafeWindow.fetch;
  unsafeWindow.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    const promise = originalFetch.apply(this, arguments);
    if (PAGE_KEYS_RE.test(url)) {
      const headers = headersToObject(init?.headers || (typeof input === 'object' ? input.headers : null));
      promise
        .then((res) => (res.ok ? res.clone().text() : null))
        .then((text) => text && recordPageKeys(url, headers, text))
        .catch((err) => console.warn(LOG, 'fetch capture failed', err));
    }
    return promise;
  };

  // --- Network helpers ---

  class CancelledError extends Error {
    constructor() {
      super('Cancelled');
    }
  }

  function throwIfCancelled() {
    if (cancelled) throw new CancelledError();
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
          else settle(reject, new Error(`HTTP ${res.status} for ${url}`));
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

  // The viewer may only have asked for some pages; replay its request with
  // pageNumber=0 (which returns every page) to fill any gaps.
  async function refreshAllPageKeys() {
    if (!lastKeysRequest) return;
    const url = new URL(lastKeysRequest.url);
    url.searchParams.set('pageNumber', '0');
    try {
      const res = await gmRequest(url.href, { headers: lastKeysRequest.headers });
      recordPageKeys(url.href, lastKeysRequest.headers, res.responseText);
    } catch (err) {
      console.warn(LOG, 'could not refresh page keys, using captured ones', err);
    }
  }

  function buildImageUrl(issue, page, key, scale) {
    // Keys are plain base64; only encode if the API didn't already.
    const ticket = key.includes('%') ? key : encodeURIComponent(key);
    return `${IMAGE_BASE}?file=${encodeURIComponent(issue)}&page=${page}&scale=${scale}&ticket=${ticket}`;
  }

  // --- JPEG handling ---

  function isJpeg(bytes) {
    return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
  }

  // Returns {width, height, components} from the first SOFn marker.
  function readJpegInfo(bytes) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return {
          height: (bytes[offset + 5] << 8) | bytes[offset + 6],
          width: (bytes[offset + 7] << 8) | bytes[offset + 8],
          components: bytes[offset + 9],
        };
      }
      offset += 2 + length;
    }
    throw new Error('Not a readable JPEG');
  }

  // WebP/PNG/CMYK JPEG -> baseline RGB JPEG, so the PDF can embed it as-is.
  async function toRgbJpeg(bytes) {
    const bitmap = await createImageBitmap(new Blob([bytes]));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function fetchPageImage(issue, page, key, scale, retries = RETRIES) {
    const url = buildImageUrl(issue, page, key, scale);
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await gmRequest(url, {
          responseType: 'arraybuffer',
          headers: { Accept: 'image/jpeg,image/*;q=0.8' },
        });
        let bytes = new Uint8Array(res.response);
        if (!isJpeg(bytes) || ![1, 3].includes(readJpegInfo(bytes).components)) {
          bytes = await toRgbJpeg(bytes);
        }
        return bytes;
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  // The CDN silently caps resolution: past some scale the width stops
  // growing. Probe the first page and keep the smallest scale reaching the
  // largest width.
  async function findBestScale(issue, keys, onProgress) {
    const page = Math.min(...keys.keys());
    let best = null;
    for (const scale of PROBE_SCALES) {
      let width;
      try {
        width = readJpegInfo(await fetchPageImage(issue, page, keys.get(page), scale, 0)).width;
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        console.warn(LOG, `scale ${scale} failed`, err);
        break;
      }
      console.log(LOG, `scale ${scale}: ${width}px`);
      onProgress(scale, width);
      if (best && width <= best.width) break;
      best = { scale, width };
    }
    return best;
  }

  async function fetchAllPages(issue, keys, scale, onProgress) {
    const pages = [...keys.keys()].sort((a, b) => a - b);
    const results = new Array(pages.length);
    let next = 0;
    let done = 0;

    const worker = async () => {
      while (next < pages.length) {
        const index = next++;
        const page = pages[index];
        // Sequential per worker on purpose: CONCURRENCY workers bound the load on the CDN.
        results[index] = { page, bytes: await fetchPageImage(issue, page, keys.get(page), scale) }; // NOSONAR
        onProgress(++done, pages.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pages.length) }, worker));
    return results;
  }

  // --- ZIP (store only: JPEGs don't compress further) ---

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

  // --- PDF (one JPEG per page, embedded untouched via DCTDecode) ---

  // PDF literal string; non-ASCII is dropped since we don't emit UTF-16.
  function pdfString(text) {
    const escaped = text.replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, String.raw`\$&`);
    return '(' + escaped + ')';
  }

  // Only needed when page numbers aren't simply 1..N (missing pages):
  // keeps the viewer's page numbers instead of renumbering.
  function buildPageLabels(pageNumbers) {
    const ranges = [];
    pageNumbers.forEach((page, i) => {
      const expected = i === 0 ? 1 : pageNumbers[i - 1] + 1;
      if (page !== expected) ranges.push(i);
    });
    if (!ranges.length) return '';
    if (ranges[0] !== 0) ranges.unshift(0);
    const nums = ranges.map((i) => `${i} << /S /D /St ${pageNumbers[i]} >>`).join(' ');
    return ` /PageLabels << /Nums [${nums}] >>`;
  }

  function buildPdf(images, { title, pageNumbers }) {
    const encoder = new TextEncoder();
    const parts = [];
    const offsets = [];
    let length = 0;

    const push = (chunk) => {
      const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
      parts.push(bytes);
      length += bytes.length;
    };
    const startObject = (id) => {
      offsets[id] = length;
      push(`${id} 0 obj\n`);
    };

    // Object ids: 1 catalog, 2 page tree, 3 info, then 3 per page (page, content, image).
    const pageIds = images.map((_, i) => 4 + i * 3);

    push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
    startObject(1);
    push(`<< /Type /Catalog /Pages 2 0 R${buildPageLabels(pageNumbers)} >>\nendobj\n`);
    startObject(2);
    const kids = pageIds.map((id) => id + ' 0 R').join(' ');
    push(`<< /Type /Pages /Kids [${kids}] /Count ${images.length} >>\nendobj\n`);
    startObject(3);
    push(`<< /Title ${pdfString(title)} /Producer (mozaik-presse-to-pdf userscript) >>\nendobj\n`);

    images.forEach((bytes, i) => {
      const info = readJpegInfo(bytes);
      const pageId = pageIds[i];
      const width = PDF_PAGE_WIDTH_PT;
      const height = Math.round((PDF_PAGE_WIDTH_PT * info.height * 100) / info.width) / 100;
      const content = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q\n`;
      const colorSpace = info.components === 1 ? '/DeviceGray' : '/DeviceRGB';

      startObject(pageId);
      push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
          `/Resources << /XObject << /Im0 ${pageId + 2} 0 R >> >> /Contents ${pageId + 1} 0 R >>\nendobj\n`
      );
      startObject(pageId + 1);
      push(`<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
      startObject(pageId + 2);
      push(
        `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} ` +
          `/ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`
      );
      push(bytes);
      push('\nendstream\nendobj\n');
    });

    const objectCount = 4 + images.length * 3;
    const xrefOffset = length;
    let xref = `xref\n0 ${objectCount}\n0000000000 65535 f \n`;
    for (let id = 1; id < objectCount; id++) {
      xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    }
    push(xref);
    push(`trailer\n<< /Size ${objectCount} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

    return new Blob(parts, { type: 'application/pdf' });
  }

  // --- Download ---

  // "/france/diapason/20261023" -> {slug: "diapason", date: "2026-10-23"}
  function parseViewerPath() {
    const match = /\/([^/]+)\/(\d{4})(\d{2})(\d{2})\/?$/.exec(location.pathname);
    return match ? { slug: match[1], date: `${match[2]}-${match[3]}-${match[4]}` } : null;
  }

  function buildBaseName(issue) {
    const parsed = parseViewerPath();
    return parsed ? `${parsed.slug}-${parsed.date}` : issue;
  }

  // "le-monde-diplomatique" -> "Le Monde Diplomatique 2026-10-23"
  function buildTitle(issue) {
    const parsed = parseViewerPath();
    if (!parsed) return issue;
    const name = parsed.slug
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
    return `${name} ${parsed.date}`;
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
    if (busy || !currentIssue) return;
    busy = true;
    cancelled = false;
    lastResult = '';
    updatePanel();
    try {
      lastResult = await action(currentIssue);
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
    return runAction(async (issue) => {
      const scale = Number(scaleInput?.value) || GM_getValue('SCALE', DEFAULT_SCALE);
      GM_setValue('SCALE', scale);

      setStatus('Fetching page list...');
      await refreshAllPageKeys();
      const keys = pageKeysByIssue.get(issue);

      const pages = await fetchAllPages(issue, keys, scale, (done, total) => {
        setStatus(`Downloading pages ${done}/${total}...`);
        setProgress(done, total);
      });

      throwIfCancelled();
      setStatus(`Building ${format.toUpperCase()}...`);
      const baseName = buildBaseName(issue);
      const digits = String(pages.at(-1).page).length;
      if (format === 'zip') {
        const files = pages.map(({ page, bytes }) => ({
          name: `${baseName}/page-${String(page).padStart(Math.max(3, digits), '0')}.jpg`,
          bytes,
        }));
        downloadBlob(`${baseName}.zip`, buildZip(files));
      } else {
        const pdf = buildPdf(
          pages.map((p) => p.bytes),
          { title: buildTitle(issue), pageNumbers: pages.map((p) => p.page) }
        );
        downloadBlob(`${baseName}.pdf`, pdf);
      }
      return `Done: ${pages.length} pages at scale ${scale}.`;
    });
  }

  function runFindScale() {
    return runAction(async (issue) => {
      setStatus('Probing scales...');
      const best = await findBestScale(issue, pageKeysByIssue.get(issue), (scale, width) => {
        setStatus(`Scale ${scale}: ${width}px wide...`);
      });
      if (!best) throw new Error('no scale worked, see console');
      scaleInput.value = best.scale;
      GM_setValue('SCALE', best.scale);
      return `Best scale: ${best.scale} (${best.width}px wide).`;
    });
  }

  // A Download button clicked on app.mozaik.co asked for this download.
  function maybeAutoDownload() {
    const request = GM_getValue(AUTO_DOWNLOAD_KEY, null);
    if (!request) return;
    GM_setValue(AUTO_DOWNLOAD_KEY, null);
    if (Date.now() - request.at > AUTO_DOWNLOAD_TTL_MS) return;
    console.log(LOG, `auto-download requested from app.mozaik.co: ${request.format}`);
    void runDownload(request.format);
  }

  // --- Floating panel ---

  let panel = null;
  let statusLine = null;
  let progressBar = null;
  let scaleInput = null;
  let zipButton = null;
  let pdfButton = null;
  let probeButton = null;
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

    const scaleLabel = document.createElement('label');
    scaleLabel.textContent = 'Scale ';
    scaleLabel.style.cssText = 'display:block;margin-bottom:6px';
    scaleInput = document.createElement('input');
    scaleInput.type = 'number';
    scaleInput.min = '50';
    scaleInput.step = '10';
    scaleInput.value = GM_getValue('SCALE', DEFAULT_SCALE);
    scaleInput.style.cssText = 'width:70px';
    scaleLabel.appendChild(scaleInput);
    probeButton = makeButton('Find best', runFindScale);
    probeButton.style.marginLeft = '6px';
    probeButton.title = 'Download page 1 at increasing scales until it stops getting bigger';
    scaleLabel.appendChild(probeButton);

    zipButton = makeButton('ZIP', () => runDownload('zip'));
    pdfButton = makeButton('PDF', () => runDownload('pdf'));
    stopButton = makeButton('Stop', cancelAction);
    stopButton.style.background = '#c0392b';

    panel.append(statusLine, progressBar, scaleLabel, zipButton, pdfButton, stopButton);
    document.body.appendChild(panel);
    updatePanel();
  }

  function updatePanel() {
    // Only show in frames where the viewer actually requested page keys,
    // plus the top frame so there is always some feedback.
    if (!panel) {
      if (window.top !== window && !currentIssue) return;
      createPanel();
      return;
    }
    const ready = Boolean(currentIssue) && !busy;
    for (const button of [zipButton, pdfButton, probeButton]) {
      button.disabled = !ready;
      button.style.opacity = ready ? '1' : '0.5';
    }
    stopButton.style.display = busy ? '' : 'none';
    if (!busy) {
      const count = currentIssue ? pageKeysByIssue.get(currentIssue).size : 0;
      const keysText = currentIssue
        ? `${currentIssue}: ${count} page key(s) captured`
        : 'Waiting for the viewer to load page keys...';
      setStatus(lastResult || keysText);
    }
    if (ready) maybeAutoDownload();
  }

  // --- app.mozaik.co: Download buttons next to "Lire" ---

  function findReadButtons() {
    const buttons = [...document.querySelectorAll(READ_BUTTON_SELECTOR)];
    if (buttons.length) return buttons;
    const fallback = findReadButtonByText();
    return fallback ? [fallback] : [];
  }

  // Fallback if the markup changes: matches on text nodes rather than
  // elements, so icons, wrappers or extra words ("Lire le magazine") don't
  // matter, then climbs to the clickable ancestor if there is one.
  function findReadButtonByText() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let fallback = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.data.trim();
      if (!/^lire\b/i.test(text)) continue;
      const parent = node.parentElement;
      if (!parent || parent.closest(`.${LAUNCH_CLASS}`)) continue;
      const target = parent.closest(CLICKABLE) || parent;
      if (/^lire$/i.test(text)) return target;
      fallback ??= target;
    }
    return fallback;
  }

  // Logs what looks like the "Lire" button when none was matched, to adjust
  // findReadButtons() against the real markup.
  function logReadButtonCandidates() {
    const candidates = [...document.querySelectorAll(`${CLICKABLE}, div, span`)]
      .filter((el) => /\blire\b/i.test(el.textContent || '') && el.textContent.length < 80)
      .map((el) => el.outerHTML.slice(0, 300));
    console.warn(LOG, `no "Lire" button found on ${location.href}; elements mentioning "lire":`, candidates);
  }

  // Clicking goes through the site's own "Lire" flow (gift-token activation,
  // redirect to the viewer); the viewer then starts the download by itself.
  function makeLaunchButton(label, format, readButton) {
    const button = makeButton(label, (event) => {
      event.preventDefault();
      event.stopPropagation();
      GM_setValue(AUTO_DOWNLOAD_KEY, { format, at: Date.now() });
      button.textContent = 'Opening viewer...';
      readButton.click();
    });
    button.style.marginRight = '0';
    return button;
  }

  // One pair of buttons per "Lire" link, in its own row since the link is
  // full width (w-full).
  function injectLaunchButtons() {
    // Book pages have a "Lire" button too, opening the book reader (see mozaik-books-to-epub.user.js).
    if (location.pathname.startsWith('/books')) return;
    for (const readButton of findReadButtons()) {
      if (readButton.dataset.mozaikToPdf) continue;
      readButton.dataset.mozaikToPdf = '1';
      const row = document.createElement('div');
      row.className = LAUNCH_CLASS;
      row.style.cssText = 'display:flex;gap:8px;margin-top:8px';
      row.append(
        makeLaunchButton('Download PDF', 'pdf', readButton),
        makeLaunchButton('Download ZIP', 'zip', readButton)
      );
      console.log(LOG, 'adding Download buttons next to', readButton);
      readButton.after(row);
    }
  }

  // app.mozaik.co is a SPA: keep watching for the "Lire" button to render.
  function initLaunchButtons() {
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        injectLaunchButtons();
      }, 200);
    });
    const start = () => {
      console.log(LOG, 'watching app.mozaik.co for the "Lire" button');
      observer.observe(document.body, { childList: true, subtree: true });
      injectLaunchButtons();
      setTimeout(() => {
        const onPressPage = location.pathname.startsWith('/press');
        if (onPressPage && !findReadButtons().length) logReadButtonCandidates();
      }, 10000);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updatePanel);
  } else {
    updatePanel();
  }
})();
