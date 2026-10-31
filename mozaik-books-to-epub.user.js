// ==UserScript==
// @name         Mozaik - Download book as EPUB/ZIP
// @namespace    local.mozaik-books-to-epub
// @version      0.5.0
// @description  Adds ZIP and EPUB buttons to the Mozaik book reader (nextory.mozaik.co/reader) that download the open book's EPUB parts as a ZIP, or merged into one EPUB
// @homepageURL  https://github.com/ocococococ/userscripts
// @downloadURL  https://raw.githubusercontent.com/ocococococ/userscripts/main/mozaik-books-to-epub.user.js
// @updateURL    https://raw.githubusercontent.com/ocococococ/userscripts/main/mozaik-books-to-epub.user.js
// @match        https://nextory.mozaik.co/reader/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      nextory.mozaik.co
// @connect      nextory.com
// @connect      storage.googleapis.com
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const LOG = '[mozaik-books-to-epub]';
  const API_BASE = 'https://nextory.mozaik.co/proxy-api/books';
  const API_RE = /^https:\/\/nextory\.mozaik\.co\/proxy-api\//i;
  const CONCURRENCY = 4;
  const RETRIES = 2;
  // Request headers set by the browser itself, or tied to one request.
  const SKIPPED_HEADERS_RE = /^(content-type|content-length|accept-encoding|host|origin|referer|cookie)$/i;
  const CONTAINER_PATH = 'META-INF/container.xml';
  // fetch-book media_type -> package endpoint. "novel" and "graphic_novel"
  // (comics) packages list EPUB parts; "audio" ones (audio books and
  // podcasts) list encrypted HLS streams, so for those the ZIP only holds the
  // API answers.
  const EPUB_PACKAGE = 'get-epub-package';
  const PACKAGE_ENDPOINTS = { novel: EPUB_PACKAGE, graphic_novel: EPUB_PACKAGE, audio: 'get-audio-package' };
  // Session fields of the audio package, left out of the saved JSON.
  const SESSION_FIELDS = new Set(['login_token', 'profile_token', 'device_id']);
  const NAV_FILE = 'mozaik-nav.xhtml';
  const NCX_FILE = 'toc.ncx';
  const NCX_TYPE = 'application/x-dtbncx+xml';
  const DC_NS = 'http://purl.org/dc/elements/1.1/';

  // Headers the app sends to the proxy API (a token, if any), replayed on our
  // own requests; GM_xmlhttpRequest sends the mozaik.co cookies anyway.
  let apiHeaders = {};
  // {id, title, author, language, publisher, mediaType, totalPages, info (fetch-book data), cover, error}
  let book = null;
  let busy = false;
  // Set by the Stop button; checked between requests, while in-flight
  // requests are aborted directly.
  let cancelled = false;
  const activeRequests = new Set();

  // --- Capture the app's own API headers ---

  function recordHeaders(url, headers) {
    let href;
    try {
      href = new URL(url, location.href).href;
    } catch {
      return;
    }
    if (!API_RE.test(href)) return;
    const kept = Object.fromEntries(Object.entries(headers).filter(([name]) => !SKIPPED_HEADERS_RE.test(name)));
    if (!Object.keys(kept).length) return;
    apiHeaders = kept;
    console.log(LOG, 'captured API headers', Object.keys(kept));
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
    this._mozaikBooksUrl = String(url);
    this._mozaikBooksHeaders = {};
    return originalOpen.call(this, method, url, ...rest);
  };

  OriginalXHR.prototype.setRequestHeader = function (name, value) {
    if (this._mozaikBooksHeaders) this._mozaikBooksHeaders[name] = value;
    return originalSetRequestHeader.call(this, name, value);
  };

  OriginalXHR.prototype.send = function (body) {
    if (this._mozaikBooksUrl) recordHeaders(this._mozaikBooksUrl, this._mozaikBooksHeaders);
    return originalSend.call(this, body);
  };

  const originalFetch = unsafeWindow.fetch;
  unsafeWindow.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    recordHeaders(url, headersToObject(init?.headers || (typeof input === 'object' ? input.headers : null)));
    return originalFetch.apply(this, arguments);
  };

  // The reader URL, opened by the book page's "Lire" button: nextory.mozaik.co/reader/fr?book_id=<id>.
  function currentBookId() {
    const id = new URLSearchParams(location.search).get('book_id');
    return /^\d+$/.test(id || '') ? id : null;
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

  function errorBody(res) {
    try {
      const text =
        res.response instanceof ArrayBuffer ? new TextDecoder().decode(res.response.slice(0, 400)) : res.responseText;
      return (text || '').replaceAll(/\s+/g, ' ').slice(0, 400);
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

  // Returns the "data" member of a proxy API response. Signed out, the API
  // redirects to an HTML page instead.
  async function fetchApi(path) {
    const res = await gmRequest(`${API_BASE}/${path}`, { headers: { Accept: 'application/json', ...apiHeaders } });
    let data;
    try {
      data = JSON.parse(res.responseText).data;
    } catch {
      // Reported below with the raw response.
    }
    if (!data) throw new Error(`${path}: no JSON data (signed out of Mozaik?): ${errorBody(res)}`);
    return data;
  }

  // Part URLs are signed for a short time, so the package is fetched when a
  // download starts and again when a part fails. Concurrent refreshes share
  // one request.
  let packageRequest = null;
  function fetchPackage(bookId) {
    packageRequest ??= fetchApi(`${EPUB_PACKAGE}/${bookId}`).finally(() => {
      packageRequest = null;
    });
    return packageRequest;
  }

  async function freshSpineUrl(bookId, spineId) {
    const pkg = await fetchPackage(bookId);
    const spine = pkg.spines?.find((candidate) => candidate.spine_id === spineId);
    if (!spine?.spine_url) throw new Error(`part ${spineId} is no longer in the package`);
    return spine.spine_url;
  }

  function isZip(bytes) {
    return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  }

  // Warns only: the package hash might not be computed on the served file.
  async function checkSha256(spine, bytes) {
    if (!spine.spine_sha256) return;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (hex !== spine.spine_sha256.toLowerCase()) {
      console.warn(LOG, `part ${spine.spine_id}: SHA-256 ${hex} differs from the package`);
    }
  }

  async function fetchPart(bookId, spine) {
    let url = spine.spine_url;
    let lastError;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        // A retry asks for a fresh signed URL: the first one may have expired.
        if (attempt > 0) url = await freshSpineUrl(bookId, spine.spine_id); // NOSONAR
        const res = await gmRequest(url, { responseType: 'arraybuffer' }); // NOSONAR
        const bytes = new Uint8Array(res.response);
        if (!isZip(bytes)) throw new Error(`part ${spine.spine_id} is not an EPUB`);
        await checkSha256(spine, bytes); // NOSONAR
        return bytes;
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        console.warn(LOG, `part ${spine.spine_id}, attempt ${attempt + 1} failed`, err);
        lastError = err;
      }
    }
    throw lastError;
  }

  async function fetchAllParts(bookId, spines, onProgress) {
    const results = new Array(spines.length);
    let next = 0;
    let done = 0;

    const worker = async () => {
      while (next < spines.length) {
        const index = next++;
        const spine = spines[index];
        // Sequential per worker on purpose: CONCURRENCY workers bound the load on the CDN.
        results[index] = { spine, bytes: await fetchPart(bookId, spine) }; // NOSONAR
        onProgress(++done, spines.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, spines.length) }, worker));
    return results;
  }

  // --- ZIP reading (stored and deflated entries) ---

  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // path -> bytes, directories left out.
  async function readZip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const stop = Math.max(0, bytes.length - 22 - 0xffff);
    let end = bytes.length - 22;
    while (end >= stop && view.getUint32(end, true) !== 0x06054b50) end--;
    if (end < stop) throw new Error('not a ZIP file');
    const count = view.getUint16(end + 10, true);
    let offset = view.getUint32(end + 16, true);
    const decoder = new TextDecoder();
    const files = new Map();
    for (let i = 0; i < count; i++) {
      if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('bad ZIP central directory');
      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const nameLength = view.getUint16(offset + 28, true);
      const localOffset = view.getUint32(offset + 42, true);
      const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
      offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
      if (name.endsWith('/')) continue;
      const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
      const data = bytes.subarray(start, start + compressedSize);
      if (method === 0) files.set(name, data.slice());
      else if (method === 8) files.set(name, await inflateRaw(data)); // NOSONAR
      else throw new Error(`${name}: unsupported ZIP method ${method}`);
    }
    return files;
  }

  // --- ZIP writing (store only: EPUB requires "mimetype" stored first) ---

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

  // General purpose bit 11: entry names are UTF-8 (accented book titles).
  const ZIP_UTF8_FLAG = 0x0800;

  function buildZip(files, type = 'application/zip') {
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

    return new Blob([...parts, ...central, end.buffer], { type });
  }

  // --- EPUB merge ---

  // Elements by local name in any namespace: OPFs may use prefixes
  // ("opf:manifest"), which CSS type selectors do not match everywhere.
  function byName(root, name) {
    return Array.from(root.getElementsByTagNameNS('*', name));
  }

  function firstByName(root, name) {
    return root.getElementsByTagNameNS('*', name)[0] || null;
  }

  function parseXml(bytes) {
    const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('invalid XML');
    return doc;
  }

  function serializeXml(doc) {
    const xml = new XMLSerializer().serializeToString(doc.documentElement);
    return new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>\n${xml}`);
  }

  function escapeXml(text) {
    return String(text)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function decodeHref(href) {
    try {
      return decodeURIComponent(href);
    } catch {
      return href;
    }
  }

  function dirname(path) {
    return path.slice(0, path.lastIndexOf('/') + 1);
  }

  // Manifest hrefs are URL-encoded and relative to the OPF file.
  function resolvePath(fromFile, href) {
    const parts = [];
    for (const segment of (dirname(fromFile) + decodeHref(href.split('#')[0])).split('/')) {
      if (segment === '..') parts.pop();
      else if (segment && segment !== '.') parts.push(segment);
    }
    return parts.join('/');
  }

  function relativeHref(fromFile, path) {
    const from = dirname(fromFile).split('/').filter(Boolean);
    const to = path.split('/');
    let common = 0;
    while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
    return [...from.slice(common).map(() => '..'), ...to.slice(common)].map(encodeURIComponent).join('/');
  }

  function findOpfPath(files) {
    if (files.has(CONTAINER_PATH)) {
      try {
        const rootfile = parseXml(files.get(CONTAINER_PATH)).getElementsByTagNameNS('*', 'rootfile')[0];
        const path = rootfile?.getAttribute('full-path');
        if (path && files.has(path)) return path;
      } catch (err) {
        console.warn(LOG, 'could not read container.xml', err);
      }
    }
    return [...files.keys()].find((name) => name.toLowerCase().endsWith('.opf')) || null;
  }

  // Entries of the package's toc ({src, name, childrens}), relative to the OPF
  // like spine_href; the spine itself when the package has no toc.
  function tocEntries(pkg) {
    return pkg.toc?.childrens?.length
      ? pkg.toc.childrens
      : pkg.spines.map((spine) => ({ src: spine.spine_href, name: spine.spine_href }));
  }

  function buildNav(entries, title) {
    const list = (entries) => {
      if (!entries?.length) return '';
      const items = entries.map(
        (entry) =>
          '<li><a href="' +
          escapeXml(entry.src) +
          '">' +
          escapeXml(entry.name || entry.src) +
          '</a>' +
          list(entry.childrens) +
          '</li>'
      );
      return `<ol>${items.join('')}</ol>`;
    };
    const heading = escapeXml(title);
    return new TextEncoder().encode(
      '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n' +
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n' +
        `<head><title>${heading}</title></head>\n` +
        `<body><nav epub:type="toc" id="toc"><h1>${heading}</h1>${list(entries)}</nav></body>\n</html>\n`
    );
  }

  // EPUB 2 table of contents, also read by EPUB 3 readers.
  function buildNcx(entries, title, uid) {
    let order = 0;
    let depth = 0;
    const points = (list, level) => {
      depth = Math.max(depth, level);
      return list
        .map((entry) => {
          order++;
          const head =
            `<navPoint id="navPoint-${order}" playOrder="${order}"><navLabel><text>` +
            escapeXml(entry.name || entry.src) +
            '</text></navLabel><content src="' +
            escapeXml(entry.src) +
            '"/>';
          const children = entry.childrens?.length ? points(entry.childrens, level + 1) : '';
          return `${head}${children}</navPoint>`;
        })
        .join('');
    };
    const navMap = points(entries, 1);
    return new TextEncoder().encode(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n' +
        `<head><meta name="dtb:uid" content="${escapeXml(uid)}"/><meta name="dtb:depth" content="${depth}"/>` +
        '<meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>\n' +
        `<docTitle><text>${escapeXml(title)}</text></docTitle>\n<navMap>${navMap}</navMap>\n</ncx>\n`
    );
  }

  function makeItem(doc, manifest, attributes) {
    const item = doc.createElementNS(manifest.namespaceURI, 'item');
    for (const [name, value] of Object.entries(attributes)) item.setAttribute(name, value);
    manifest.appendChild(item);
    return item;
  }

  function readPartOpf(spine, files) {
    const path = findOpfPath(files);
    if (!path) return { path: null, doc: null };
    try {
      return { path, doc: parseXml(files.get(path)) };
    } catch (err) {
      console.warn(LOG, `part ${spine.spine_id}: could not read ${path}`, err);
      return { path, doc: null };
    }
  }

  // Adds one part's files and manifest items to the merge state. A part's own
  // content document wins over copies of it in other parts.
  function collectPart(state, spine, files) {
    const opf = readPartOpf(spine, files);
    let ownPath = opf.path ? resolvePath(opf.path, spine.spine_href) : null;
    if (opf.doc) {
      state.base ??= opf;
      for (const item of byName(opf.doc, 'item')) {
        const id = item.getAttribute('id');
        const path = resolvePath(opf.path, item.getAttribute('href') || '');
        const own = id === spine.spine_id;
        if (own) ownPath = path;
        state.items.push({ id, path, opfPath: opf.path, item, own });
      }
    }
    for (const [path, bytes] of files) {
      if (path === 'mimetype' || path === CONTAINER_PATH || path === opf.path || state.owned.has(path)) continue;
      if (path === ownPath) state.owned.add(path);
      else if (state.merged.has(path)) continue;
      state.merged.set(path, bytes);
    }
  }

  // Every part's items, each id and file once, the parts' own content
  // documents first so they win over another id for the same file.
  function buildManifest(epub, items) {
    epub.manifest.replaceChildren();
    items.sort((a, b) => Number(b.own) - Number(a.own));
    for (const { id, path, opfPath, item, own } of items) {
      if (!id || epub.ids.has(id) || epub.idByPath.has(path)) continue;
      if (!epub.merged.has(path)) {
        if (own) console.warn(LOG, `manifest item ${id} (${path}) is in no part; dropped`);
        continue;
      }
      const copy = epub.doc.importNode(item, true);
      if (opfPath !== epub.path) copy.setAttribute('href', relativeHref(epub.path, path));
      epub.manifest.appendChild(copy);
      epub.ids.add(id);
      epub.idByPath.set(path, id);
    }
  }

  // Manifest id of a part's content document, added to the manifest if
  // missing; null when no part has the file.
  function spineItemId(epub, spine) {
    const path = resolvePath(epub.path, spine.spine_href);
    const id = epub.ids.has(spine.spine_id) ? spine.spine_id : epub.idByPath.get(path);
    if (id) return id;
    if (!epub.merged.has(path)) {
      console.warn(LOG, `spine item ${spine.spine_id} (${path}) is in no part; skipped`);
      return null;
    }
    makeItem(epub.doc, epub.manifest, {
      id: spine.spine_id,
      href: relativeHref(epub.path, path),
      'media-type': spine.spine_mimetype || 'application/xhtml+xml',
    });
    epub.ids.add(spine.spine_id);
    epub.idByPath.set(path, spine.spine_id);
    return spine.spine_id;
  }

  // Package order.
  function buildSpine(epub, parts) {
    for (const itemref of byName(epub.spine, 'itemref')) itemref.remove();
    for (const { spine } of parts) {
      const id = spineItemId(epub, spine);
      if (!id) continue;
      const itemref = epub.doc.createElementNS(epub.spine.namespaceURI, 'itemref');
      itemref.setAttribute('idref', id);
      if (spine.spine_linear === false) itemref.setAttribute('linear', 'no');
      epub.spine.appendChild(itemref);
    }
  }

  // Each part's NCX only lists its own document ("Chapter 7"), so the table
  // of contents is always rebuilt from the package's toc: the NCX, plus the
  // nav document for EPUB 3.
  function addToc(epub, pkg, title) {
    const entries = tocEntries(pkg);
    const items = [...epub.manifest.children];
    const toc = epub.spine.getAttribute('toc');
    const ncx =
      items.find((item) => toc && item.getAttribute('id') === toc) ||
      items.find((item) => item.getAttribute('media-type') === NCX_TYPE);
    let ncxPath = ncx && resolvePath(epub.path, ncx.getAttribute('href') || '');
    if (ncx) {
      epub.spine.setAttribute('toc', ncx.getAttribute('id'));
    } else {
      ncxPath = dirname(epub.path) + NCX_FILE;
      makeItem(epub.doc, epub.manifest, { id: 'mozaik-ncx', href: NCX_FILE, 'media-type': NCX_TYPE });
      epub.spine.setAttribute('toc', 'mozaik-ncx');
    }
    const uid = firstByName(epub.doc, 'identifier')?.textContent.trim() || title;
    epub.merged.set(ncxPath, buildNcx(entries, title, uid));

    if (!(Number.parseFloat(epub.doc.documentElement.getAttribute('version')) >= 3)) return;
    const nav = items.find((item) => /\bnav\b/.test(item.getAttribute('properties') || ''));
    let navPath = nav && resolvePath(epub.path, nav.getAttribute('href') || '');
    if (!nav) {
      navPath = dirname(epub.path) + NAV_FILE;
      makeItem(epub.doc, epub.manifest, {
        id: 'mozaik-nav',
        href: NAV_FILE,
        'media-type': 'application/xhtml+xml',
        properties: 'nav',
      });
    }
    epub.merged.set(navPath, buildNav(entries, title));
  }

  // The parts' metadata comes from a generic converter (dc:language "en", no
  // author): language replaced, author and publisher added, from fetch-book.
  function fillMetadata(epub, meta) {
    const metadata = firstByName(epub.doc, 'metadata');
    if (!metadata) return;
    const fields = [
      ['language', meta.language, true],
      ['creator', meta.author, false],
      ['publisher', meta.publisher, false],
    ];
    for (const [name, value, replace] of fields) {
      const existing = firstByName(metadata, name);
      if (!value || (existing && !replace)) continue;
      const element = existing || metadata.appendChild(epub.doc.createElementNS(DC_NS, `dc:${name}`));
      element.textContent = value;
    }
  }

  function containerXml(opfPath) {
    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>' +
      `<rootfile full-path="${escapeXml(opfPath)}" media-type="application/oebps-package+xml"/>` +
      '</rootfiles></container>\n'
    );
  }

  // Each part is a small EPUB holding one spine item (plus shared resources,
  // possibly again in every part). Files are merged by path; the OPF of the
  // first part is kept, with the manifests merged and the spine rebuilt in
  // package order. meta: {title, author, language, publisher}. Returns the
  // EPUB's ZIP entries, "mimetype" first.
  function mergeParts(parts, pkg, meta) {
    const state = { base: null, items: [], merged: new Map(), owned: new Set() };
    for (const { spine, files } of parts) collectPart(state, spine, files);
    if (!state.base) throw new Error('no OPF package document in the parts; use ZIP to keep them as is');

    const { doc, path } = state.base;
    const epub = {
      doc,
      path,
      manifest: firstByName(doc, 'manifest'),
      spine: firstByName(doc, 'spine'),
      merged: state.merged,
      ids: new Set(),
      idByPath: new Map(),
    };
    if (!epub.manifest || !epub.spine) throw new Error('the OPF has no manifest or spine');
    buildManifest(epub, state.items);
    buildSpine(epub, parts);
    addToc(epub, pkg, meta.title);
    fillMetadata(epub, meta);

    const encoder = new TextEncoder();
    return [
      { name: 'mimetype', bytes: encoder.encode('application/epub+zip') },
      { name: CONTAINER_PATH, bytes: encoder.encode(containerXml(path)) },
      { name: path, bytes: serializeXml(doc) },
      ...[...epub.merged].map(([name, bytes]) => ({ name, bytes })),
    ];
  }

  // --- Download ---

  // "Author - Title", without characters file systems reject.
  function buildFileName() {
    const name = [book?.author, book?.title || `Mozaik book ${book?.id}`].filter(Boolean).join(' - ');
    return name.replaceAll(/[\\/:*?"<>|]+/g, '_').replaceAll(/\s+/g, ' ').trim().slice(0, 150);
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

  async function buildEpub(parts, pkg) {
    const unpacked = [];
    for (const [index, { spine, bytes }] of parts.entries()) {
      throwIfCancelled();
      // Sequential on purpose: unpacking is CPU-bound and keeps the progress readable.
      const files = await readZip(bytes); // NOSONAR
      if (index === 0) console.log(LOG, `part ${spine.spine_id} files`, [...files.keys()]);
      unpacked.push({ spine, files });
      setStatus(`Merging parts ${index + 1}/${parts.length}...`);
      setProgress(index + 1, parts.length);
    }
    const meta = { ...book, title: book?.title || buildFileName() };
    return buildZip(mergeParts(unpacked, pkg, meta), 'application/epub+zip');
  }

  function isEpubBook() {
    return PACKAGE_ENDPOINTS[book?.mediaType] === EPUB_PACKAGE;
  }

  function jsonEntry(baseName, name, data) {
    const bytes = new TextEncoder().encode(`${JSON.stringify(data, null, 2)}\n`);
    return { name: `${baseName}/${name}.json`, bytes };
  }

  async function fetchEpubParts(bookId, pkg) {
    const spines = pkg.spines || [];
    if (!spines.length) throw new Error('the package lists no EPUB parts');
    return fetchAllParts(bookId, spines, (done, total) => {
      setStatus(`Downloading parts ${done}/${total}...`);
      setProgress(done, total);
    });
  }

  // The API answers (fetch-book and the package, as JSON) and, for EPUB
  // books, the raw parts.
  async function downloadZip(bookId, baseName) {
    const isEpub = isEpubBook();
    const endpoint = PACKAGE_ENDPOINTS[book.mediaType];
    const pkg = isEpub ? await fetchPackage(bookId) : await fetchApi(`${endpoint}/${bookId}`);
    const parts = isEpub ? await fetchEpubParts(bookId, pkg) : [];
    throwIfCancelled();
    setStatus('Building ZIP...');
    const savedPkg = Object.fromEntries(Object.entries(pkg).filter(([name]) => !SESSION_FIELDS.has(name)));
    const digits = Math.max(2, String(parts.length).length);
    const entries = [
      jsonEntry(baseName, 'fetch-book', book.info),
      jsonEntry(baseName, endpoint, savedPkg),
      ...parts.map(({ spine, bytes }, index) => ({
        name: `${baseName}/${String(index + 1).padStart(digits, '0')}-${spine.spine_id}.epub`,
        bytes,
      })),
    ];
    downloadBlob(`${baseName}.zip`, buildZip(entries));
    return isEpub ? `Done: ${parts.length} parts.` : 'Done: book info only (audio is not supported).';
  }

  async function downloadEpub(bookId, baseName) {
    const pkg = await fetchPackage(bookId);
    const parts = await fetchEpubParts(bookId, pkg);
    throwIfCancelled();
    downloadBlob(`${baseName}.epub`, await buildEpub(parts, pkg));
    return `Done: ${parts.length} parts.`;
  }

  // Runs one download with the buttons disabled; its result (or error) stays
  // as the status line until the next one.
  async function runDownload(format) {
    const bookId = currentBookId();
    const allowed = format === 'zip' ? PACKAGE_ENDPOINTS[book?.mediaType] : isEpubBook();
    if (busy || !bookId || !allowed) return;
    busy = true;
    cancelled = false;
    lastResult = '';
    updatePanel();
    try {
      setStatus('Fetching the book package...');
      const download = format === 'zip' ? downloadZip : downloadEpub;
      lastResult = await download(bookId, buildFileName());
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

  async function loadBook(bookId) {
    book = { id: bookId };
    try {
      const data = await fetchApi(`fetch-book/${bookId}`);
      if (book?.id === bookId) {
        book = {
          id: bookId,
          title: data.title || '',
          author: data.author || '',
          language: data.language || '',
          publisher: data.publisher_name || '',
          mediaType: data.media_type || '',
          totalPages: Number.isFinite(data.total_pages) ? data.total_pages : null,
          info: data,
          cover: coverUrl(data.coverImage),
        };
        console.log(LOG, `book ${bookId}: media_type "${book.mediaType}"`, data);
      }
    } catch (err) {
      console.warn(LOG, 'fetch-book failed', err);
      if (book?.id === bookId) book = { id: bookId, error: err.message };
    }
    updatePanel();
  }

  // --- Floating panel ---

  let panel = null;
  let statusLine = null;
  let progressBar = null;
  let zipButton = null;
  let epubButton = null;
  let stopButton = null;
  let cover = null;
  let lastResult = '';
  let lastUrl = null;

  function makeButton(label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.style.cssText =
      'margin-right:6px;padding:4px 10px;border:0;border-radius:4px;background:#1a73e8;color:#fff;font:600 12px sans-serif;cursor:pointer';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
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

  // fetch-book's coverImage is on storage.cloud.google.com, which redirects
  // to a Google sign-in; the same object is public on storage.googleapis.com.
  function coverUrl(url) {
    return (url || '').replace(/^https:\/\/storage\.cloud\.google\.com\//, 'https://storage.googleapis.com/');
  }

  // Shows book.cover, unless it is already shown.
  function updateCover() {
    const url = book?.cover || '';
    if (cover.dataset.url === url) return;
    if (cover.src.startsWith('blob:')) URL.revokeObjectURL(cover.src);
    cover.dataset.url = url;
    cover.style.display = url ? '' : 'none';
    if (url) cover.src = url;
    else cover.removeAttribute('src');
  }

  // If the page's CSP blocks the image host, loads the cover through
  // GM_xmlhttpRequest as a blob instead; hidden if that fails too.
  async function loadCoverAsBlob() {
    const url = cover.dataset.url;
    if (!url || cover.src.startsWith('blob:')) {
      cover.style.display = 'none';
      return;
    }
    try {
      const res = await gmRequest(url, { responseType: 'blob' });
      if (cover.dataset.url === url) cover.src = URL.createObjectURL(res.response);
    } catch (err) {
      console.warn(LOG, 'could not load the cover', err);
      cover.style.display = 'none';
    }
  }

  function createPanel() {
    panel = document.createElement('div');
    // Bottom right, above the reader's own controls; cover on the left.
    panel.style.cssText =
      'position:fixed;right:8px;bottom:8px;z-index:2147483647;display:flex;gap:8px;align-items:flex-start;' +
      'max-width:320px;padding:6px 8px;border-radius:6px;background:#fff;color:#222;' +
      'box-shadow:0 1px 6px rgba(0,0,0,.3);font:12px/16px sans-serif';
    cover = document.createElement('img');
    cover.alt = '';
    cover.style.cssText = 'display:none;flex:none;width:48px;max-height:72px;object-fit:contain;border-radius:2px';
    cover.addEventListener('error', () => {
      loadCoverAsBlob().catch((err) => console.warn(LOG, err));
    });
    const body = document.createElement('div');
    zipButton = makeButton('ZIP', () => runDownload('zip'));
    epubButton = makeButton('EPUB', () => runDownload('epub'));
    stopButton = makeButton('Stop', cancelAction);
    stopButton.style.background = '#c0392b';
    statusLine = document.createElement('div');
    statusLine.style.cssText = 'margin-top:4px;white-space:pre-line';
    progressBar = document.createElement('progress');
    progressBar.style.cssText = 'display:none;width:100%;height:8px;margin-top:4px';
    body.append(zipButton, epubButton, stopButton, statusLine, progressBar);
    panel.append(cover, body);
  }

  function idleText() {
    if (!book) return '';
    if (book.error) return `Book info unavailable: ${book.error}`;
    if (book.title === undefined) return 'Loading book info...';
    return `${buildFileName()}\n${describeMedia()}`;
  }

  function describeMedia() {
    if (isEpubBook()) return book.totalPages ? `${book.totalPages} pages` : 'Book';
    if (book.mediaType === 'audio') return 'Audio book or podcast: ZIP holds the info only';
    return `media_type "${book.mediaType}" not supported`;
  }

  // Enabled once fetch-book gives the media type: ZIP for any type with a
  // package, EPUB for EPUB books only (hidden for other types).
  function updatePanel() {
    if (!panel) return;
    const isEpub = isEpubBook();
    zipButton.disabled = busy || !PACKAGE_ENDPOINTS[book?.mediaType];
    epubButton.disabled = busy || !isEpub;
    for (const button of [zipButton, epubButton]) button.style.opacity = button.disabled ? '0.5' : '1';
    epubButton.style.display = !book?.mediaType || isEpub ? '' : 'none';
    stopButton.style.display = busy ? '' : 'none';
    updateCover();
    if (!busy) setStatus(lastResult || idleText());
  }

  // Called on a timer: follows the book id if the reader changes its URL, and
  // puts the panel back if the reader replaces the page content.
  function refresh() {
    if (!document.body) return;
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      const bookId = currentBookId();
      if (bookId && bookId !== book?.id && !busy) {
        lastResult = '';
        loadBook(bookId).catch((err) => console.warn(LOG, err));
      }
    }
    if (!currentBookId()) {
      if (!busy) panel?.remove();
      return;
    }
    if (!panel) createPanel();
    if (!panel.isConnected) document.body.appendChild(panel);
    updatePanel();
  }

  function start() {
    console.log(LOG, 'started on', location.href);
    setInterval(refresh, 1000);
    refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
