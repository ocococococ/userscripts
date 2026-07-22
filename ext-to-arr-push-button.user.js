// ==UserScript==
// @name         ext.to - Push to Sonarr/Radarr/Lidarr
// @namespace    local.ext-to-arr-push-button
// @version      1.6.1
// @description  Adds a button on ext.to search results that sends a torrent straight to Sonarr, Radarr or Lidarr via release/push
// @homepageURL  https://github.com/ocococococ/userscripts
// @downloadURL  https://raw.githubusercontent.com/ocococococ/userscripts/main/ext-to-arr-push-button.user.js
// @updateURL    https://raw.githubusercontent.com/ocococococ/userscripts/main/ext-to-arr-push-button.user.js
// @match        https://ext.to/browse/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      videostation.local
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // Your local Sonarr/Radarr/Lidarr instances. API keys are asked for once
  // (via prompt()) the first time each is actually needed, then cached in
  // Tampermonkey's storage - never hardcoded here.
  const SONARR = { baseUrl: 'http://videostation.local:8989', apiVersion: 'v3', keyName: 'SONARR_API_KEY', label: 'Sonarr' };
  const RADARR = { baseUrl: 'http://videostation.local:8310', apiVersion: 'v3', keyName: 'RADARR_API_KEY', label: 'Radarr' };
  const LIDARR = { baseUrl: 'http://videostation.local:8686', apiVersion: 'v1', keyName: 'LIDARR_API_KEY', label: 'Lidarr' };

  function getApiKey(target) {
    let key = GM_getValue(target.keyName);
    if (!key) {
      key = prompt(`Enter your ${target.label} API key (Settings -> General -> Security in ${target.label}). Asked once, then stored locally.`)?.trim();
      if (key) GM_setValue(target.keyName, key);
    }
    return key || null;
  }

  const MAGNET_ENDPOINT = 'getSearchMagnet.php';
  const BUTTON_CLASS = 'arrpush-button';
  const pendingMagnetRequests = new Map(); // torrent_id -> {resolve, reject}

  // --- Intercept ext.to's own magnet AJAX call (patched before its scripts run) ---

  function getBodyParam(body, key) {
    if (!body) return null;
    try {
      return new URLSearchParams(body).get(key);
    } catch {
      return null;
    }
  }

  const OriginalXHR = unsafeWindow.XMLHttpRequest;
  const originalOpen = OriginalXHR.prototype.open;
  const originalSend = OriginalXHR.prototype.send;

  // True only during the synchronous window where OUR button triggers a
  // click on ext.to's real magnet button - lets us tell "we clicked it
  // programmatically" apart from "the user clicked it themselves".
  let suppressMagnetOpen = false;

  OriginalXHR.prototype.open = function (method, url, ...rest) {
    this._arrpushUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };

  OriginalXHR.prototype.send = function (body) {
    if (typeof this._arrpushUrl === 'string' && this._arrpushUrl.includes(MAGNET_ENDPOINT)) {
      const torrentId = getBodyParam(body, 'torrent_id');

      // ext.to's own jQuery handler is bound via the `onload`/`onreadystatechange`
      // properties (not addEventListener) and, on success, opens the magnet link
      // with the browser's default handler. Only clear those when we're the ones
      // who triggered this click - a genuine user click on the real button should
      // still behave exactly as ext.to intends.
      if (suppressMagnetOpen) {
        this.onload = null;
        this.onreadystatechange = null;
      }

      this.addEventListener('load', function () {
        if (!torrentId || !pendingMagnetRequests.has(torrentId)) return;
        const { resolve, reject } = pendingMagnetRequests.get(torrentId);
        pendingMagnetRequests.delete(torrentId);
        try {
          const data = JSON.parse(this.responseText);
          if (data?.success && data?.url) {
            resolve(data.url);
          } else {
            reject(new Error('ext.to did not return a magnet link'));
          }
        } catch (err) {
          reject(err);
        }
      });
    }
    return originalSend.call(this, body);
  };

  function requestMagnetUrl(torrentId, magnetButton) {
    return new Promise((resolve, reject) => {
      pendingMagnetRequests.set(torrentId, { resolve, reject });
      suppressMagnetOpen = true;
      try {
        magnetButton.click();
      } finally {
        suppressMagnetOpen = false;
      }
      setTimeout(() => {
        if (pendingMagnetRequests.has(torrentId)) {
          pendingMagnetRequests.delete(torrentId);
          reject(new Error('Timed out waiting for magnet link'));
        }
      }, 15000);
    });
  }

  // --- Push to Sonarr/Radarr ---

  function pushRelease(target, title, magnetUrl) {
    return new Promise((resolve, reject) => {
      const apiKey = getApiKey(target);
      if (!apiKey) {
        reject(new Error(`No API key provided for ${target.label}`));
        return;
      }

      const url = `${target.baseUrl}/api/${target.apiVersion}/release/push`;
      const payload = {
        title,
        magnetUrl,
        protocol: 'torrent',
        publishDate: new Date().toISOString(),
      };

      console.log('[ext.to arrpush] magnet link:', magnetUrl);
      console.log('[ext.to arrpush] POST', url, payload);

      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers: {
          'X-Api-Key': apiKey,
          'Content-Type': 'application/json',
        },
        data: JSON.stringify(payload),
        onload: (res) => {
          try {
            const body = JSON.parse(res.responseText);
            resolve(Array.isArray(body) ? body[0] : body);
          } catch (err) {
            console.error('[ext.to arrpush] pushRelease: failed to parse response', {
              status: res.status,
              statusText: res.statusText,
              responseText: res.responseText,
              err,
            });
            reject(err);
          }
        },
        onerror: (err) => {
          console.error('[ext.to arrpush] pushRelease: request error', err);
          reject(err);
        },
      });
    });
  }

  function detectTarget(row) {
    if (row.querySelector('.related-posted a[href^="/tv/"]')) return SONARR;
    if (row.querySelector('.related-posted a[href^="/movies/"]')) return RADARR;
    if (row.querySelector('.related-posted a[href^="/music/"]')) return LIDARR;
    return null;
  }

  // release/push can fail two different ways depending on how badly the
  // title breaks parsing: a FluentValidation array (400, {propertyName,
  // errorMessage}) when the whole title is unparseable, or a resolved
  // ReleaseResource with rejections like "Unknown Artist"/"Unknown Series".
  function isUnparseableTitle(result) {
    if (!result) return false;
    if (result.propertyName === 'Title' && /unable to parse/i.test(result.errorMessage || '')) return true;
    return Boolean(result.rejections?.some((r) => /unknown (artist|series|movie)/i.test(r)));
  }

  // --- Button UI ---

  function setStatus(button, text, color) {
    button.textContent = text;
    button.style.background = color;
  }

  // data-tooltip sometimes contains literal <span> markup (search-term
  // highlighting); parsing it as HTML and reading textContent strips tags
  // and decodes entities correctly, unlike a regex-based approach.
  function stripHtmlTags(html) {
    const el = document.createElement('div');
    el.innerHTML = html;
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function getRejectionReason(result) {
    if (result?.rejections?.length) return result.rejections.join('; ');
    if (result?.errorMessage) {
      const prefix = result.propertyName ? `${result.propertyName}: ` : '';
      return `${prefix}${result.errorMessage}`;
    }
    return 'Rejected';
  }

  function reportPushResult(button, result) {
    if (result?.rejected === false) {
      setStatus(button, 'Sent (OK)', '#2ecc71');
      return;
    }
    console.error('[ext.to arrpush] release rejected', result);
    if (result?.rejections?.length) {
      console.error('[ext.to arrpush] rejections:', result.rejections);
    }
    setStatus(button, getRejectionReason(result), '#c0392b');
  }

  async function pushReleaseWithRetry(target, title, magnetUrl) {
    let result = await pushRelease(target, title, magnetUrl);

    // Lidarr's parser expects "Artist - Album" style titles; some music
    // releases use "|" as the separator instead, which either fails
    // validation outright ("Unable to parse") or resolves to an
    // unrecognized artist - either way, retry with "-" instead.
    if (target === LIDARR && isUnparseableTitle(result) && title.includes('|')) {
      const retryTitle = title.replaceAll('|', '-');
      console.log('[ext.to arrpush] Lidarr: retrying with "|" replaced by "-":', retryTitle);
      result = await pushRelease(target, retryTitle, magnetUrl);
    }

    return result;
  }

  function createButton(row, target) {
    const button = document.createElement('a');
    button.className = BUTTON_CLASS;
    button.href = 'javascript:void(0);';
    button.textContent = `Send to ${target.label}`;
    button.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'margin-left:8px',
      'padding:1px 10px',
      'border-radius:4px',
      'line-height:1.6',
      'background:#35c5f4',
      'color:#fff',
      'font-size:12px',
      'font-weight:600',
      'text-decoration:none',
      'cursor:pointer',
      'white-space:nowrap',
    ].join(';');

    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const titleLink = row.querySelector('.torrent-title-link');
      const magnetButton = row.querySelector('.search-magnet-btn');
      const torrentId = magnetButton?.dataset.id;
      const title = stripHtmlTags(titleLink?.dataset.tooltip || titleLink?.textContent || '');

      if (!torrentId || !title) {
        setStatus(button, 'Missing data', '#c0392b');
        return;
      }

      setStatus(button, 'Fetching magnet...', '#888');

      try {
        const magnetUrl = await requestMagnetUrl(torrentId, magnetButton);
        setStatus(button, 'Sending...', '#888');

        const result = await pushReleaseWithRetry(target, title, magnetUrl);
        reportPushResult(button, result);
      } catch (err) {
        setStatus(button, 'Error', '#c0392b');
        console.error('[ext.to arrpush]', err);
      }
    });

    return button;
  }

  function injectButtons() {
    document.querySelectorAll('table.search-table tbody tr').forEach((row) => {
      const btnBlock = row.querySelector('.btn-blocks');
      if (!btnBlock || btnBlock.querySelector(`.${BUTTON_CLASS}`)) return;

      const target = detectTarget(row);
      if (!target) return;

      btnBlock.appendChild(createButton(row, target));
    });
  }

  // ext.to loads/paginates results via AJAX; keep watching for new rows.
  function startObserving() {
    const observer = new MutationObserver(() => injectButtons());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    injectButtons();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserving);
  } else {
    startObserving();
  }
})();
