// ==UserScript==
// @name         Mozaik - Download issue as PDF/ZIP
// @namespace    local.mozaik-to-pdf
// @version      0.1.0
// @description  Captures page tickets in the presse.mozaik.co (PressReader) viewer and downloads all pages as a ZIP of images or a PDF
// @homepageURL  https://github.com/ocococococ/userscripts
// @downloadURL  https://raw.githubusercontent.com/ocococococ/userscripts/main/mozaik-to-pdf.user.js
// @updateURL    https://raw.githubusercontent.com/ocococococ/userscripts/main/mozaik-to-pdf.user.js
// @match        https://presse.mozaik.co/*
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

  const LOG = '[mozaik-to-pdf]';
  const PAGE_KEYS_RE = /\/IssueInfo\/GetPageKeys\b/i;
  const IMAGE_BASE = 'https://i.prcdn.co/img';
  const DEFAULT_SCALE = 300;
  const CONCURRENCY = 4;
  const RETRIES = 2;
  // PDF pages are laid out at A4 width; height follows the image ratio.
  const PDF_PAGE_WIDTH_PT = 595;

  // issue id ("f6412026010100000000001001") -> Map(pageNumber -> ticket)
  const pageKeysByIssue = new Map();
  // Last GetPageKeys request seen, replayed to make sure we have every page.
  let lastKeysRequest = null; // {url, headers}
  let currentIssue = null;
  let busy = false;

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

  function gmRequest(url, { headers = {}, responseType = 'text' } = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers,
        responseType,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) resolve(res);
          else reject(new Error(`HTTP ${res.status} for ${url}`));
        },
        onerror: () => reject(new Error(`Network error for ${url}`)),
        ontimeout: () => reject(new Error(`Timeout for ${url}`)),
      });
    });
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

  async function fetchPageImage(issue, page, key, scale) {
    const url = buildImageUrl(issue, page, key, scale);
    let lastError;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
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
        lastError = err;
      }
    }
    throw lastError;
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
        results[index] = { page, bytes: await fetchPageImage(issue, page, keys.get(page), scale) };
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
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
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

  function buildPdf(images) {
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

    // Object ids: 1 catalog, 2 page tree, then 3 per page (page, content, image).
    const pageIds = images.map((_, i) => 3 + i * 3);

    push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
    startObject(1);
    push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    startObject(2);
    push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${images.length} >>\nendobj\n`);

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

    const objectCount = 3 + images.length * 3;
    const xrefOffset = length;
    let xref = `xref\n0 ${objectCount}\n0000000000 65535 f \n`;
    for (let id = 1; id < objectCount; id++) {
      xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    }
    push(xref);
    push(`trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

    return new Blob(parts, { type: 'application/pdf' });
  }

  // --- Download ---

  // "/france/diapason/20261023" -> "diapason-2026-10-23"
  function buildBaseName(issue) {
    const match = location.pathname.match(/\/([^/]+)\/(\d{4})(\d{2})(\d{2})\/?$/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}-${match[4]}`;
    return issue;
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

  async function runDownload(format) {
    if (busy || !currentIssue) return;
    busy = true;
    updatePanel();

    const scale = Number(scaleInput.value) || DEFAULT_SCALE;
    GM_setValue('SCALE', scale);
    const issue = currentIssue;

    try {
      setStatus('Fetching page list...');
      await refreshAllPageKeys();
      const keys = pageKeysByIssue.get(issue);

      const pages = await fetchAllPages(issue, keys, scale, (done, total) => {
        setStatus(`Downloading pages ${done}/${total}...`);
      });

      setStatus(`Building ${format.toUpperCase()}...`);
      const baseName = buildBaseName(issue);
      const digits = String(pages[pages.length - 1].page).length;
      if (format === 'zip') {
        const files = pages.map(({ page, bytes }) => ({
          name: `${baseName}/page-${String(page).padStart(Math.max(3, digits), '0')}.jpg`,
          bytes,
        }));
        downloadBlob(`${baseName}.zip`, buildZip(files));
      } else {
        downloadBlob(`${baseName}.pdf`, buildPdf(pages.map((p) => p.bytes)));
      }
      setStatus(`Done: ${pages.length} pages.`);
    } catch (err) {
      console.error(LOG, err);
      setStatus(`Error: ${err.message}`);
    } finally {
      busy = false;
      updatePanel();
    }
  }

  // --- Floating panel ---

  let panel = null;
  let statusLine = null;
  let scaleInput = null;
  let zipButton = null;
  let pdfButton = null;

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

  function createPanel() {
    if (panel || !document.body) return;
    panel = document.createElement('div');
    panel.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:10px 12px;border-radius:8px;' +
      'background:#fff;color:#222;box-shadow:0 2px 10px rgba(0,0,0,.3);font:12px sans-serif;max-width:260px';

    statusLine = document.createElement('div');
    statusLine.style.marginBottom = '6px';

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

    zipButton = makeButton('ZIP', () => runDownload('zip'));
    pdfButton = makeButton('PDF', () => runDownload('pdf'));

    panel.append(statusLine, scaleLabel, zipButton, pdfButton);
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
    zipButton.disabled = !ready;
    pdfButton.disabled = !ready;
    zipButton.style.opacity = pdfButton.style.opacity = ready ? '1' : '0.5';
    if (!busy) {
      const count = currentIssue ? pageKeysByIssue.get(currentIssue).size : 0;
      setStatus(currentIssue ? `${currentIssue}: ${count} page key(s) captured` : 'Waiting for the viewer to load page keys...');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updatePanel);
  } else {
    updatePanel();
  }
})();
