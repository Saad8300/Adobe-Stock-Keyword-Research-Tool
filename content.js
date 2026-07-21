/**
 * content.js — Adobe Stock DOM Scraper
 * ══════════════════════════════════════
 *
 * Injected into https://stock.adobe.com/* pages by the background service worker.
 * Selector assumptions are in config/selectors.js — edit that file to fix breakage.
 *
 * MESSAGE API (received from background.js via chrome.tabs.sendMessage):
 *
 *  { action: 'verify_and_fix_filters' }
 *    → { ok: true, navigatedTo?: string }
 *      Checks the current URL carries our filter params.
 *      If not, navigates to the corrected URL and signals background to re-wait.
 *
 *  { action: 'get_result_count' }
 *    → { count: number } | { error: string }
 *      Reads the "N results" text from the DOM.
 *
 *  { action: 'scrape_video_cards', videoCount: number }
 *    → { cards: Array<{ title: string, detailUrl: string }> } | { error: string }
 *      Scrolls until N cards are loaded, then collects titles + detail URLs.
 *
 *  { action: 'get_detail_tags' }
 *    → { tags: string[] } | { error: string }
 *      Scrapes keyword/tag links from the current (detail) page.
 *
 *  { action: 'ping' }
 *    → { pong: true }
 */

'use strict';

// Guard against multiple injections per page navigation
if (window.__adobeStockContentScriptV2) {
  console.log('[content] Already initialized on this page, skipping re-init.');
} else {
  window.__adobeStockContentScriptV2 = true;
  initContent();
}

function initContent() {
  const SEL = window.ADOBE_STOCK_SELECTORS;

  if (!SEL) {
    console.error('[content] ADOBE_STOCK_SELECTORS not found. ' +
      'Ensure config/selectors.js is loaded before content.js.');
    return;
  }

  console.log('[content] v2 initialized on:', location.href);

  // ──────────────────────────────────────────────────────────────
  // UTILITY: try each selector in array, return first match
  // ──────────────────────────────────────────────────────────────
  function firstMatch(selArray, root = document) {
    for (const sel of selArray) {
      if (sel === '__TEXT_WALK__') continue;
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (_) {}
    }
    return null;
  }

  function allMatches(selArray, root = document) {
    for (const sel of selArray) {
      if (sel === '__TEXT_WALK__') continue;
      try {
        const els = [...root.querySelectorAll(sel)];
        if (els.length > 0) return els;
      } catch (_) {}
    }
    return [];
  }

  // ──────────────────────────────────────────────────────────────
  // UTILITY: wait for a DOM element using MutationObserver
  // Falls back to polling after `pollFallbackMs` ms.
  // ──────────────────────────────────────────────────────────────
  function waitForElement(selArray, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const existing = firstMatch(selArray);
      if (existing) return resolve(existing);

      const deadline = Date.now() + timeoutMs;
      let pollHandle = null;

      const cleanup = () => {
        observer.disconnect();
        clearInterval(pollHandle);
      };

      const check = () => {
        const el = firstMatch(selArray);
        if (el) { cleanup(); resolve(el); return true; }
        if (Date.now() > deadline) {
          cleanup();
          reject(new Error(`Timeout (${timeoutMs}ms) waiting for: ${JSON.stringify(selArray.slice(0, 2))}`));
          return true;
        }
        return false;
      };

      const observer = new MutationObserver(() => { check(); });
      observer.observe(document.body || document.documentElement, {
        childList: true, subtree: true, characterData: true, attributes: true
      });

      // Polling fallback in case MutationObserver misses attribute updates
      pollHandle = setInterval(() => { check(); }, SEL.timing.pollInterval);
    });
  }

  // ──────────────────────────────────────────────────────────────
  // ACTION: verify_and_fix_filters
  // Confirm the current page URL carries our filter+sort params.
  // Adobe Stock sometimes drops params in redirects or SPA navigation.
  // If filters are absent, navigate to the corrected URL.
  // ──────────────────────────────────────────────────────────────
  async function verifyAndFixFilters() {
    const href = location.href;

    // Check for video content type filter in URL
    const hasVideoFilter = href.includes('content_type:video') ||
      href.includes('content_type%3Avideo') ||
      href.includes('filters%5Bcontent_type');

    // Check for Most Downloaded sort in URL
    const hasSortOrder = href.includes('order=nb_downloads') ||
      href.includes('order%3Dnb_downloads');

    if (hasVideoFilter && hasSortOrder) {
      console.log('[content] Filters verified in URL ✓');
      return { ok: true };
    }

    // Filters missing — try to extract the keyword and rebuild the URL
    const urlParams = new URLSearchParams(location.search);
    const keyword   = urlParams.get('k') || '';

    if (!keyword) {
      return { ok: false, error: 'No keyword found in URL, cannot fix filters' };
    }

    // Build the corrected URL
    const correctedUrl = SEL.url.buildFilteredUrl(keyword);
    console.log('[content] Filters missing, navigating to:', correctedUrl);

    // Navigate the current tab to the corrected URL
    location.href = correctedUrl;

    // Signal background that we triggered a navigation (it should re-wait for load)
    return { ok: true, navigatedTo: correctedUrl };
  }

  // ──────────────────────────────────────────────────────────────
  // ACTION: get_result_count
  // Read the total filtered result count from the DOM.
  // Uses MutationObserver to wait, then falls back to text TreeWalker.
  // ──────────────────────────────────────────────────────────────
  async function getResultCount() {
    const { timing, resultCount: selectors } = SEL;
    let countEl = null;

    // 1. Wait for a known count element
    try {
      countEl = await waitForElement(
        selectors.filter(s => s !== '__TEXT_WALK__'),
        timing.resultCountTimeout
      );
    } catch (_) {
      // Timeout — fall through to text walk
    }

    // 2. Text-walk fallback: scan all visible text for "N results" pattern
    if (!countEl) {
      countEl = textWalkForCount();
    }

    if (!countEl) {
      return { error: 'Could not locate result count element. ' +
        'Adobe Stock may have changed their UI — update resultCount selectors in config/selectors.js.' };
    }

    const rawText = (countEl.textContent || '').trim();
    console.log('[content] Result count raw text:', rawText);

    // Parse: "12,345 results", "About 12,345 Videos", "12345", etc.
    const match = rawText.match(/([\d,]+)/);
    if (!match) {
      return { error: `Could not parse a number from result count text: "${rawText}"` };
    }

    const count = parseInt(match[1].replace(/,/g, ''), 10);
    if (isNaN(count)) {
      return { error: `Parsed NaN from count text: "${rawText}"` };
    }

    console.log('[content] Parsed competition count:', count);
    return { count };
  }

  /** TreeWalker-based text scan for "N results" pattern. */
  function textWalkForCount() {
    if (!document.body) return null;
    const walker  = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    const pattern = /[\d,]{2,}\s+(results?|videos?|assets?)/i;
    let node;
    while ((node = walker.nextNode())) {
      if (pattern.test(node.textContent)) {
        return node.parentElement;
      }
    }
    return null;
  }

  // ──────────────────────────────────────────────────────────────
  // ACTION: scrape_video_cards
  // Scroll the results grid to load ≥ videoCount cards,
  // then collect title + detail URL from each. Deduplicates by URL.
  // ──────────────────────────────────────────────────────────────
  async function scrapeVideoCards(videoCount) {
    const { timing } = SEL;

    // Wait for at least ONE card to appear first
    try {
      await waitForElement(SEL.resultCard, timing.gridLoadTimeout);
    } catch (e) {
      return { error: `Grid did not populate: ${e.message}` };
    }

    const cards = [];
    const seenUrls = new Set();
    const max = timing.maxScrollAttempts;
    const pause = timing.scrollPauseMs;

    for (let attempt = 0; attempt < max; attempt++) {
      const cardEls = allMatches(SEL.resultCard);
      
      // Extract unique cards from current DOM
      for (const card of cardEls) {
        if (cards.length >= videoCount) break;
        const detailUrl = extractDetailUrl(card);
        const assetId = extractAssetId(detailUrl);
        if (detailUrl && assetId && !seenUrls.has(assetId)) {
          seenUrls.add(assetId);
          const title = extractTitle(card);
          cards.push({ title, detailUrl, assetId });
        }
      }

      if (cards.length >= videoCount) {
        console.log(`[content] Scrape done: ${cards.length}/${videoCount} unique cards`);
        break;
      }
      
      console.log(`[content] Scroll ${attempt + 1}/${max}: ${cards.length}/${videoCount} unique cards`);

      // Scroll results container (preferred) and window
      const grid = firstMatch(SEL.resultsGrid);
      if (grid) grid.scrollBy({ top: grid.clientHeight * 2, behavior: 'smooth' });
      window.scrollBy({ top: window.innerHeight * 1.5, behavior: 'smooth' });

      // Try "Load More" button
      const loadMoreBtn = findLoadMoreButton();
      if (loadMoreBtn) {
        console.log('[content] Clicking load-more button');
        loadMoreBtn.click();
      }

      await new Promise(r => setTimeout(r, pause));
    }

    console.log(`[content] Collected ${cards.length} unique cards`);
    return { cards };
  }

  function findLoadMoreButton() {
    // Check known selectors
    const btn = firstMatch(SEL.filterUI.loadMoreButton);
    if (btn && btn.offsetParent !== null) return btn;

    // Text-based search as fallback
    for (const b of document.querySelectorAll('button')) {
      if (/load\s*more|show\s*more|see\s*more/i.test(b.textContent) && b.offsetParent !== null) {
        return b;
      }
    }
    return null;
  }

  /**
   * Extract the title of an asset card.
   * Priority: data-title → img[alt] → a[title] → aria-label → text
   */
  function extractTitle(card) {
    // data-title on any child
    const withData = card.querySelector('[data-title]');
    if (withData) return withData.getAttribute('data-title').trim();

    // img alt
    const img = card.querySelector('img[alt]');
    if (img) {
      const alt = img.getAttribute('alt').trim();
      if (alt.length > 1) return alt;
    }

    // a[title]
    const aTitle = card.querySelector('a[title]');
    if (aTitle) return aTitle.getAttribute('title').trim();

    // aria-label on any child
    for (const sel of ['[aria-label]']) {
      const el = card.querySelector(sel);
      if (el && el.getAttribute('aria-label')) {
        return el.getAttribute('aria-label').trim();
      }
    }

    // class-based text element
    for (const sel of ['[class*="title"]', '[class*="label"]', '[class*="name"]']) {
      try {
        const el = card.querySelector(sel);
        if (el) {
          const text = el.textContent.trim();
          if (text.length > 1) return text;
        }
      } catch (_) {}
    }

    // Last resort: first non-empty text in card
    return card.textContent.trim().split('\n')[0].trim() || 'Untitled';
  }

  /**
   * Extract the detail page URL from a result card.
   */
  function extractDetailUrl(card) {
    for (const sel of SEL.resultCardLink) {
      try {
        const a = card.querySelector(sel);
        if (a?.href) {
          const url = a.href;
          // Must be a stock.adobe.com URL
          if (url.includes('stock.adobe.com')) return url;
          if (url.startsWith('/')) return `https://stock.adobe.com${url}`;
        }
      } catch (_) {}
    }
    return null;
  }

  /**
   * Extract the asset ID from a URL for true deduplication (ignores tracking params).
   */
  function extractAssetId(url) {
    if (!url) return null;
    const match = url.match(/\/(\d+)(?:\?|$)/);
    return match ? match[1] : url; // fallback to full url if no numeric ID found
  }

  // ──────────────────────────────────────────────────────────────
  // ACTION: get_detail_tags
  // Scrape the tag/keyword list from an asset detail page.
  // Called when content.js is injected into a hidden detail tab.
  // Uses multiple strategies in decreasing order of reliability.
  // ──────────────────────────────────────────────────────────────
  async function getDetailTags() {
    const { timing } = SEL;
    const tags = new Set();
    let fullTitle = '';
    let targetTagCount = null;

    // Expand title if truncated
    try {
      const titleEl = firstMatch(SEL.detailTitle);
      const titleExpandBtn = firstMatch(SEL.detailTitleExpandBtn);
      
      if (titleEl && titleExpandBtn) {
        const initialLength = titleEl.textContent.length;
        console.log('[content] Clicking "See More" title button...');
        titleExpandBtn.click();
        
        // Wait for text to expand or button to disappear
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 100));
          if (titleEl.textContent.length > initialLength || !titleExpandBtn.offsetParent) {
            break;
          }
        }
        if (titleEl.textContent.length === initialLength && titleExpandBtn.offsetParent) {
          console.warn('[content] "See More" title button clicked but text length did not increase.');
        }
      }
    } catch (_) {}

    // Extract full title without button text
    try {
      const titleEl = firstMatch(SEL.detailTitle);
      if (titleEl) {
        // Clone node to remove buttons without affecting the DOM
        const clone = titleEl.cloneNode(true);
        const buttons = clone.querySelectorAll('button, a[role="button"]');
        buttons.forEach(btn => btn.remove());
        
        fullTitle = clone.innerText.trim(); // use innerText for better formatting
        if (!fullTitle) fullTitle = clone.textContent.trim();
      }
    } catch (_) {}

    // Parse target tag count if indicator is present
    try {
      const countEl = firstMatch(SEL.detailTagsCountIndicator);
      if (countEl) {
        const match = countEl.textContent.match(/(\d+)/);
        if (match) targetTagCount = parseInt(match[1], 10);
      }
    } catch (_) {}

    // Expand tags list
    try {
      const expandBtn = firstMatch(SEL.detailTagsExpandBtn) || firstMatch(SEL.detailTagsViewAllBtn);
      if (expandBtn) {
        console.log('[content] Clicking expand tags button...');
        expandBtn.click();
        
        // Wait for button to disappear or new tags to appear
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 100));
          if (!expandBtn.offsetParent) break;
        }
      }
    } catch (_) {}

    // Strategy 1: Wait for the tags container, then collect links
    try {
      const container = await waitForElement(SEL.detailTagsContainer, timing.gridLoadTimeout);
      if (container) {
        const tagEls = allMatches(SEL.detailTagItem, container);
        tagEls.forEach(el => {
          const t = el.textContent.trim();
          if (t.length > 1 && t.length < 80) tags.add(t);
        });
      }
    } catch (_) {
      // Container not found — continue to fallback strategies
    }

    // Strategy 2: All search-link <a> tags on the page (keyword links)
    if (tags.size === 0) {
      document.querySelectorAll('a[href*="?k="]').forEach(a => {
        const t = a.textContent.trim();
        if (t.length > 1 && t.length < 80) tags.add(t);
      });
    }

    // Strategy 3: Meta keywords tag
    if (tags.size === 0) {
      const meta = document.querySelector('meta[name="keywords"]');
      if (meta?.content) {
        meta.content.split(',').forEach(k => {
          const t = k.trim();
          if (t) tags.add(t);
        });
      }
    }

    // Strategy 4: JSON-LD structured data
    if (tags.size === 0) {
      document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
        try {
          extractJsonLdTagsLocal(JSON.parse(script.textContent), tags);
        } catch (_) {}
      });
    }

    console.log(`[content] Detail page tags (${tags.size}):`, [...tags].slice(0, 5), 'title:', fullTitle);
    return { tags: [...tags], title: fullTitle, targetTagCount };
  }

  function extractJsonLdTagsLocal(data, tagSet) {
    if (!data) return;
    if (data.keywords) {
      const kws = Array.isArray(data.keywords) ? data.keywords : String(data.keywords).split(',');
      kws.forEach(k => { const t = k.trim(); if (t) tagSet.add(t); });
    }
    if (data.about) {
      (Array.isArray(data.about) ? data.about : [data.about])
        .forEach(item => { if (item?.name) tagSet.add(item.name.trim()); });
    }
    if (data['@graph']) data['@graph'].forEach(n => extractJsonLdTagsLocal(n, tagSet));
  }

  // ──────────────────────────────────────────────────────────────
  // MESSAGE LISTENER
  // Routes incoming messages to the appropriate action handler.
  // ──────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg?.action) return false;

    console.log(`[content] action="${msg.action}" on ${location.pathname}`);

    switch (msg.action) {

      case 'verify_and_fix_filters':
        verifyAndFixFilters().then(sendResponse).catch(e => sendResponse({ error: e.message }));
        return true;

      case 'get_result_count':
        getResultCount().then(sendResponse).catch(e => sendResponse({ error: e.message }));
        return true;

      case 'scrape_video_cards':
        scrapeVideoCards(msg.videoCount || 20).then(sendResponse).catch(e => sendResponse({ error: e.message }));
        return true;

      case 'get_detail_tags':
        getDetailTags().then(sendResponse).catch(e => sendResponse({ error: e.message }));
        return true;

      case 'ping':
        sendResponse({ pong: true, url: location.href });
        return false;

      default:
        return false;
    }
  });

  console.log('[content] Message listener registered ✓');
}
