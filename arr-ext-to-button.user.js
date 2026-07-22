  // ==UserScript==
  // @name         Sonarr/Radarr/Lidarr - ext.to Button
  // @namespace    local.arr-ext-to-button
  // @version      1.3.2
  // @description  Adds a button on Sonarr series pages, Radarr movie pages (via IMDb ID) and Lidarr album pages (via artist/album search) that opens ext.to
  // @homepageURL  https://github.com/ocococococ/userscripts
  // @downloadURL  https://raw.githubusercontent.com/ocococococ/userscripts/main/arr-ext-to-button.user.js
  // @updateURL    https://raw.githubusercontent.com/ocococococ/userscripts/main/arr-ext-to-button.user.js
  // @match        http://videostation.local:8989/series/*
  // @match        http://videostation.local:8310/movie/*
  // @match        http://videostation.local:8686/album/*
  // @grant        GM_getValue
  // @grant        GM_setValue
  // @run-at       document-idle
  // ==/UserScript==

  (function () {
    'use strict';

    const BUTTON_CLASS = 'exttoimdb-button';
    const IMDB_LINK_SELECTOR = 'a[href*="imdb.com/title/tt"]';
    const IMDB_ID_RE = /imdb\.com\/title\/(tt\d+)/i;

    function extractImdbId(href) {
      const match = href.match(IMDB_ID_RE);
      return match ? match[1] : null;
    }

    function createButton(href, label, title) {
      const button = document.createElement('a');
      button.className = BUTTON_CLASS;
      button.textContent = label;
      button.title = title;
      button.href = href;
      button.target = '_blank';
      button.rel = 'noopener noreferrer';
      button.style.cssText = [
        'display:inline-flex',
        'align-items:center',
        'margin-left:6px',
        'padding:1px 10px',
        'border-radius:4px',
        'line-height:1.6',
        'background:#35c5f4',
        'color:#fff',
        'font-size:13px',
        'font-weight:600',
        'text-decoration:none',
        'cursor:pointer',
        'vertical-align:middle',
      ].join(';');
      return button;
    }

    function injectImdbButtons() {
      document.querySelectorAll(IMDB_LINK_SELECTOR).forEach((link) => {
        const next = link.nextElementSibling;
        if (next?.classList.contains(BUTTON_CLASS)) {
          return; // already injected next to this link
        }

        const imdbId = extractImdbId(link.getAttribute('href') || '');
        if (!imdbId) return;

        const href = `https://ext.to/browse/?imdb_id=${encodeURIComponent(imdbId)}`;
        link.insertAdjacentElement('afterend', createButton(href, 'ext.to', `Search ext.to for ${imdbId}`));
      });
    }

    // Sonarr/Radarr are single-page apps; content (including the IMDb link)
    // loads and changes asynchronously as the user navigates between titles.
    const observer = new MutationObserver(() => injectImdbButtons());
    observer.observe(document.documentElement, { childList: true, subtree: true });

    injectImdbButtons();

    // --- Lidarr: albums have no IMDb link, so search ext.to by artist + album
    // title instead, resolved via Lidarr's own (same-origin) API. ---

    const LIDARR_BUTTON_ID = 'exttoimdb-lidarr-button';

    // Asked for once (via prompt()) the first time it's needed, then cached
    // in Tampermonkey's storage - never hardcoded here.
    function getLidarrApiKey() {
      let key = GM_getValue('LIDARR_API_KEY');
      if (!key) {
        key = prompt('Enter your Lidarr API key (Settings -> General -> Security in Lidarr). Asked once, then stored locally.')?.trim();
        if (key) GM_setValue('LIDARR_API_KEY', key);
      }
      return key || null;
    }

    function getAlbumIdFromPath() {
      const match = /^\/album\/([^/]+)\/?$/.exec(location.pathname);
      return match ? match[1] : null;
    }

    let lidarrPlacementObserver = null;

    function removeLidarrButton() {
      document.getElementById(LIDARR_BUTTON_ID)?.remove();
      lidarrPlacementObserver?.disconnect();
      lidarrPlacementObserver = null;
    }

    // The "Links" badge (Discogs/AllMusic/etc.) sits in the same details row as
    // duration/release date/size/type; its class names are content-hashed by
    // Lidarr's build (e.g. AlbumDetails-links-XXXXX), so match by prefix.
    function findLinksAnchor() {
      const linksLabel = document.querySelector('[class*="AlbumDetails-links-"]');
      const badge = linksLabel?.closest('[class*="AlbumDetails-detailsLabel-"]');
      return badge?.parentElement || null;
    }

    function tryPlaceLidarrButton(artistName, albumTitle, forceFixedFallback) {
      if (document.getElementById(LIDARR_BUTTON_ID)) return true;

      const anchor = findLinksAnchor();
      if (!anchor && !forceFixedFallback) return false;

      const query = `${artistName} ${albumTitle}`;
      const href = `https://ext.to/browse/?q=${encodeURIComponent(query)}&cat=3`;
      const button = createButton(href, 'Search ext.to', `Search ext.to for ${query}`);
      button.id = LIDARR_BUTTON_ID;

      if (anchor) {
        button.style.marginLeft = '8px';
        anchor.after(button);
      } else {
        button.style.cssText += ';position:fixed;bottom:20px;right:20px;z-index:2147483647;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
        document.body.appendChild(button);
      }

      lidarrPlacementObserver?.disconnect();
      lidarrPlacementObserver = null;
      return true;
    }

    async function refreshLidarrButton() {
      removeLidarrButton();

      const albumId = getAlbumIdFromPath();
      if (!albumId) return;

      const apiKey = getLidarrApiKey();
      if (!apiKey) return;

      try {
        const res = await fetch(`${location.origin}/api/v1/album`, {
          headers: { 'X-Api-Key': apiKey },
        });
        if (!res.ok) return;

        const albums = await res.json();
        const album = albums.find((a) => a.foreignAlbumId === albumId || String(a.id) === albumId);
        if (!album) return;

        const artistName = album.artist?.artistName || '';
        const albumTitle = album.title;

        // Lidarr's SPA may not have rendered the details row yet; keep trying
        // as the DOM mutates, then fall back to a floating button after 5s.
        if (tryPlaceLidarrButton(artistName, albumTitle, false)) return;

        lidarrPlacementObserver = new MutationObserver(() => tryPlaceLidarrButton(artistName, albumTitle, false));
        lidarrPlacementObserver.observe(document.body, { childList: true, subtree: true });

        setTimeout(() => tryPlaceLidarrButton(artistName, albumTitle, true), 5000);
      } catch (err) {
        console.error('[arr ext.to button] Lidarr lookup failed', err);
      }
    }

    if (location.port === '8686') {
      const originalPushState = history.pushState;
      history.pushState = function (...args) {
        originalPushState.apply(this, args);
        setTimeout(refreshLidarrButton, 300);
      };
      window.addEventListener('popstate', () => setTimeout(refreshLidarrButton, 300));

      refreshLidarrButton();
    }
  })();
