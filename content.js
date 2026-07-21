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

  // ──────────────────────────────────────────────────────────────
  // DEBUG INSTRUMENTATION
  // Flip DEBUG to false to silence the verbose console trace.
  // Every key scraping step logs here so behaviour can be verified
  // directly in the page console (DevTools → the hidden/working tab).
  // ──────────────────────────────────────────────────────────────
  const DEBUG = true;
  const dbg = (...a) => { if (DEBUG) console.log('%c[content]', 'color:#e6000a', ...a); };

  dbg('v2 initialized on:', location.href);

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /** Poll `predicate` until it returns truthy or `timeoutMs` elapses. */
  async function waitFor(predicate, timeoutMs = 3000, stepMs = 100) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { if (predicate()) return true; } catch (_) {}
      await sleep(stepMs);
    }
    return false;
  }

  /** Wait until `counter()` stops changing for two consecutive reads. */
  async function waitUntilStable(counter, timeoutMs = 2000, stepMs = 200) {
    const deadline = Date.now() + timeoutMs;
    let prev = -1, stable = 0;
    while (Date.now() < deadline) {
      const cur = counter();
      if (cur === prev) { if (++stable >= 2) return cur; }
      else { stable = 0; prev = cur; }
      await sleep(stepMs);
    }
    return counter();
  }

  const isVisible = el => !!(el && el.offsetParent !== null);

  /** Find the first visible <button>/link whose text matches `re`. */
  function findButtonByText(re, root = document) {
    const nodes = root.querySelectorAll('button, a[role="button"], [role="button"], a');
    for (const b of nodes) {
      const txt = (b.textContent || '').trim();
      if (txt && re.test(txt) && isVisible(b)) return b;
    }
    return null;
  }

  /** Strip truncation ellipses and stray toggle labels from a title string. */
  function cleanTitle(t) {
    return String(t || '')
      .replace(/\s*(?:see\s*more|show\s*more|view\s*all|read\s*more)\s*$/i, '')
      .replace(/(?:\.{3}|…)\s*$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const cleanTag = t => String(t || '').replace(/\s+/g, ' ').trim();

  /** Reject non-tag noise: toggle labels, pure numbers, over/under-length. */
  function isJunkTag(t) {
    if (!t) return true;
    if (t.length < 2 || t.length > 60) return true;
    if (/^(?:see\s*more|view\s*all|show\s*more|\+?\s*\d+\s*more)$/i.test(t)) return true;
    if (/^\d+$/.test(t)) return true;
    return false;
  }

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
    let stagnantScrolls = 0; // consecutive scrolls that loaded no new cards

    const collectFromDom = () => {
      for (const card of allMatches(SEL.resultCard)) {
        if (cards.length >= videoCount) break;
        const detailUrl = extractDetailUrl(card);
        const assetId = extractAssetId(detailUrl);
        if (detailUrl && assetId && !seenUrls.has(assetId)) {
          seenUrls.add(assetId);
          cards.push({ title: extractTitle(card), detailUrl, assetId });
        }
      }
    };

    for (let attempt = 0; attempt < max; attempt++) {
      const before = cards.length;
      collectFromDom();

      if (cards.length >= videoCount) {
        dbg(`scrapeVideoCards done: ${cards.length}/${videoCount} unique cards`);
        break;
      }

      // Detect an exhausted grid: several scrolls in a row with no growth.
      if (cards.length === before) {
        stagnantScrolls++;
        if (stagnantScrolls >= 4) {
          dbg(`scrapeVideoCards: grid exhausted at ${cards.length}/${videoCount} ` +
              `(no new cards after ${stagnantScrolls} scrolls)`);
          break;
        }
      } else {
        stagnantScrolls = 0;
      }

      dbg(`scrapeVideoCards scroll ${attempt + 1}/${max}: ${cards.length}/${videoCount} unique`);

      const grid = firstMatch(SEL.resultsGrid);
      if (grid) grid.scrollBy({ top: grid.clientHeight * 2, behavior: 'smooth' });
      window.scrollBy({ top: window.innerHeight * 1.5, behavior: 'smooth' });

      const loadMoreBtn = findLoadMoreButton();
      if (loadMoreBtn) { dbg('clicking load-more button'); loadMoreBtn.click(); }

      await new Promise(r => setTimeout(r, pause));
    }

    dbg(`scrapeVideoCards collected ${cards.length} unique cards`);
    return { cards, exhausted: cards.length < videoCount };
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
    // Prefer clean attribute-based titles (these never contain "See More").
    const withData = card.querySelector('[data-title]');
    if (withData) return cleanTitle(withData.getAttribute('data-title'));

    const img = card.querySelector('img[alt]');
    if (img) {
      const alt = cleanTitle(img.getAttribute('alt'));
      if (alt.length > 1) return alt;
    }

    const aTitle = card.querySelector('a[title]');
    if (aTitle) return cleanTitle(aTitle.getAttribute('title'));

    const ariaEl = card.querySelector('[aria-label]');
    if (ariaEl && ariaEl.getAttribute('aria-label')) {
      return cleanTitle(ariaEl.getAttribute('aria-label'));
    }

    // NOTE: this is only a grid fallback. The authoritative, fully-expanded
    // title comes from the detail page (getDetailData). We deliberately avoid
    // scraping truncated description blocks (which contain the "See More"
    // button label) here.
    return 'Untitled';
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
   * Extract the stable numeric asset ID from a detail URL for reliable
   * deduplication. Handles trailing slashes, query strings, and #fragments
   * uniformly by taking the LAST purely-numeric path segment (Adobe Stock
   * asset URLs are /<type>/<slug>/<id>). Falls back to an asset_id query
   * param, then to the normalized origin+path, then the raw string.
   */
  function extractAssetId(url) {
    if (!url) return null;
    try {
      const u = new URL(url, 'https://stock.adobe.com');
      const segs = u.pathname.split('/').filter(Boolean);
      for (let i = segs.length - 1; i >= 0; i--) {
        if (/^\d+$/.test(segs[i])) return segs[i];
      }
      const qid = u.searchParams.get('asset_id') || u.searchParams.get('id');
      if (qid && /^\d+$/.test(qid)) return qid;
      return (u.origin + u.pathname).replace(/\/+$/, '');
    } catch (_) {
      return url;
    }
  }

  // ──────────────────────────────────────────────────────────────
  // ACTION: get_detail_tags
  // Scrape the tag/keyword list from an asset detail page.
  // Called when content.js is injected into a hidden detail tab.
  // Uses multiple strategies in decreasing order of reliability.
  // ──────────────────────────────────────────────────────────────
  async function getDetailData() {
    const { timing } = SEL;
    const assetId = extractAssetId(location.href);
    dbg('getDetailData ▶ id=' + assetId, location.href);

    // ── 1. Wait for the page's core content (title OR tag list) ──────
    // Detail pages are React SPAs; the tag list renders after hydration.
    try {
      await waitForElement(
        [...SEL.detailTitle, ...SEL.detailTagsContainer, 'a[href*="?k="]'],
        timing.detailLoadTimeout
      );
    } catch (_) {
      dbg('  core content wait timed out — proceeding with whatever is present');
    }

    // ── 2. Expand the truncated title ("See More") and VERIFY ────────
    const titleExpanded = await expandTitle();
    dbg('  title expand:', titleExpanded);

    // ── 3. Read the expected tag count, expand the list, VERIFY ──────
    const targetTagCount = readTargetTagCount();
    const tagExpansion = await expandTags(targetTagCount);
    dbg('  tag expand:', tagExpansion);

    // ── 4. Extract the clean title (button/toggle text stripped) ─────
    const title = extractDetailTitle();

    // ── 5. Extract the fully-expanded tag list ───────────────────────
    const tags = collectTags();

    dbg(`getDetailData ◀ id=${assetId} title="${title}" tags=${tags.length}` +
        (targetTagCount ? `/${targetTagCount}` : ''));
    return { assetId, title, tags, targetTagCount };
  }

  /** Click the title "See More" toggle and confirm the text actually grew. */
  async function expandTitle() {
    const titleEl = firstMatch(SEL.detailTitle);
    if (!titleEl) return false;
    let btn = firstMatch(SEL.detailTitleExpandBtn) || findButtonByText(/see\s*more|show\s*more/i, titleEl.parentElement || document);
    if (!btn || !isVisible(btn)) return false;

    const before = titleEl.textContent.trim().length;
    dbg('  clicking See More (title), len before =', before);
    try { btn.click(); } catch (_) { return false; }

    // Success = title grew OR the toggle button disappeared.
    const ok = await waitFor(
      () => titleEl.textContent.trim().length > before || !isVisible(btn),
      SEL.timing.expandVerifyTimeout
    );
    if (!ok) dbg('  ⚠ See More clicked but no verified change');
    return ok;
  }

  /** Parse the "N keywords" indicator, if present. */
  function readTargetTagCount() {
    const countEl = firstMatch(SEL.detailTagsCountIndicator);
    if (countEl) {
      const m = countEl.textContent.match(/(\d+)/);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  }

  /**
   * Click the "View All" / expand-keywords toggle, verify more tags
   * appeared, then wait for the count to stabilize so we never read a
   * half-rendered list.
   */
  async function expandTags(targetTagCount) {
    const before = getTagElements().length;
    let btn = firstMatch(SEL.detailTagsViewAllBtn) ||
              firstMatch(SEL.detailTagsExpandBtn) ||
              findButtonByText(/view\s*all|show\s*(all|more)|see\s*all|\+\s*\d+\s*more/i);

    if (btn && isVisible(btn)) {
      dbg('  clicking View All (tags), tags before =', before, 'target =', targetTagCount ?? '?');
      try { btn.click(); } catch (_) {}
      await waitFor(() => {
        const n = getTagElements().length;
        if (targetTagCount) return n >= targetTagCount;
        return n > before || !isVisible(btn);
      }, SEL.timing.expandVerifyTimeout);
    } else {
      dbg('  no tag-expand toggle found (list may already be full)');
    }

    // Let lazily-rendered tags settle.
    const finalCount = await waitUntilStable(() => getTagElements().length, 2000);
    return { before, after: finalCount, clicked: !!(btn && isVisible(btn)) };
  }

  /**
   * The current set of tag elements. Prefer the dedicated keyword
   * container; fall back to all keyword-search links on the page.
   */
  function getTagElements() {
    const container = firstMatch(SEL.detailTagsContainer);
    if (container) {
      const els = allMatches(SEL.detailTagItem, container);
      if (els.length) return els;
    }
    return [...document.querySelectorAll('a[href*="?k="]')];
  }

  /** Extract the clean detail-page title, excluding any toggle button text. */
  function extractDetailTitle() {
    const el = firstMatch(SEL.detailTitle);
    if (!el) return '';
    const clone = el.cloneNode(true);
    // Remove the "See More" toggle (and any other buttons) so its label
    // can never leak into the title text.
    clone.querySelectorAll(
      'button, a[role="button"], [role="button"], [class*="see-more" i], [class*="seemore" i], [class*="show-more" i]'
    ).forEach(n => n.remove());
    const raw = (clone.innerText || clone.textContent || '').trim();
    return cleanTitle(raw);
  }

  /** Collect, clean, and de-duplicate tags from the (expanded) DOM. */
  function collectTags() {
    const seen = new Set();
    const out = [];

    const push = t => {
      const c = cleanTag(t);
      if (isJunkTag(c)) return;
      const key = c.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(c);
    };

    // Primary: rendered keyword links (authoritative once expanded).
    getTagElements().forEach(el => push(el.textContent));

    // Fallbacks only if the DOM yielded nothing (e.g. render blocked).
    if (out.length === 0) {
      const meta = document.querySelector('meta[name="keywords"]');
      if (meta?.content) meta.content.split(',').forEach(push);
    }
    if (out.length === 0) {
      document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
        try { extractJsonLdTagsLocal(JSON.parse(script.textContent), push); } catch (_) {}
      });
    }
    return out;
  }

  function extractJsonLdTagsLocal(data, push) {
    if (!data) return;
    if (data.keywords) {
      const kws = Array.isArray(data.keywords) ? data.keywords : String(data.keywords).split(',');
      kws.forEach(push);
    }
    if (data.about) {
      (Array.isArray(data.about) ? data.about : [data.about])
        .forEach(item => { if (item?.name) push(item.name); });
    }
    if (data['@graph']) data['@graph'].forEach(n => extractJsonLdTagsLocal(n, push));
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

      case 'get_detail_data':
      case 'get_detail_tags': // backward-compatible alias
        getDetailData().then(sendResponse).catch(e => sendResponse({ error: e.message }));
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
