/**
 * config/selectors.js — Centralized Adobe Stock DOM Selector Config
 * ══════════════════════════════════════════════════════════════════
 *
 * ★ THIS IS THE ONLY FILE YOU NEED TO EDIT if Adobe Stock changes
 *   their page markup or class names. ★
 *
 * Each selector entry is an ordered array. The runtime code tries
 * each selector in sequence, using the first one that finds a match.
 * Data-attributes (data-*) are preferred over class names because
 * they are more stable across Adobe Stock's React-based deployments.
 *
 * HOW TO PATCH A BROKEN SELECTOR
 * ────────────────────────────────
 * 1. Open Adobe Stock in Chrome.
 * 2. Right-click the broken element → Inspect.
 * 3. In DevTools Elements panel, look for a stable data-* attribute
 *    OR a descriptive class name that is unlikely to be auto-generated.
 * 4. Add it as the FIRST entry in the relevant array below.
 * 5. Reload the extension at chrome://extensions.
 *
 * PAGE CONTEXTS
 * ─────────────
 * Search Results: https://stock.adobe.com/search?k=<kw>&filters[content_type:video]=1&order=nb_downloads
 * Asset Detail:   https://stock.adobe.com/<type>/<slug>/<asset-id>
 *
 * Exposed as: window.ADOBE_STOCK_SELECTORS (so both content.js and
 * any inline scripts can reference it without module imports).
 * ══════════════════════════════════════════════════════════════════
 */

/* global window */
window.ADOBE_STOCK_SELECTORS = {

  // ──────────────────────────────────────────────────────────────
  // SECTION A — URL PARAMETERS
  // Prefer URL-based filter+sort over UI click simulation.
  // Adobe Stock supports these params as of mid-2025.
  // ──────────────────────────────────────────────────────────────
  url: {
    base: 'https://stock.adobe.com/search',

    /**
     * Video content type filter param.
     * Appending this to the search URL scopes results to videos only.
     * If Adobe Stock changes this param, update it here.
     */
    videoFilter: 'filters[content_type:video]=1',

    /**
     * Sort by "Most Downloaded" param.
     * nb_downloads = number of downloads (confirmed param name as of 2025).
     */
    sortMostDownloaded: 'order=nb_downloads',

    /**
     * Build the full filtered+sorted search URL for a keyword.
     * This is the SINGLE URL used at step 1+2 of the automation
     * (navigate AND apply filters in one shot — no separate filter click needed).
     *
     * @param {string} keyword
     * @returns {string}
     */
    buildFilteredUrl(keyword) {
      const k = encodeURIComponent(keyword.trim());
      return `${this.base}?k=${k}&${this.videoFilter}&${this.sortMostDownloaded}`;
    },

    /**
     * Verify the current page URL reflects our filters (sanity check).
     * @param {string} href - window.location.href
     * @returns {boolean}
     */
    isFilteredVideoPage(href) {
      return href.includes('content_type:video') || href.includes('filters%5Bcontent_type%3Avideo%5D');
    }
  },

  // ──────────────────────────────────────────────────────────────
  // SECTION B — SEARCH RESULTS PAGE SELECTORS
  // ──────────────────────────────────────────────────────────────

  /**
   * The element that displays the total result count.
   * Typical text: "12,345 results" or "About 12,345 Videos"
   *
   * PATCH HINT: Use browser DevTools → inspect the count number
   * near the top of the results grid. Look for data-cy or
   * a distinctive class name like "search-filter-bar__total-count".
   */
  resultCount: [
    // Tier 1: data-cy attributes (most stable — engineers use these for testing)
    '[data-cy="search-results-count"]',
    '[data-cy="result-count"]',
    '[data-cy="total-results"]',

    // Tier 2: class-name patterns observed on Adobe Stock
    '.search-filter-bar__total-count',
    '[class*="result-count"]',
    '[class*="total-count"]',
    '[class*="results-count"]',
    '[class*="ResultsCount"]',

    // Tier 3: ARIA / semantic attributes
    '[aria-label*="results"]',

    // Tier 4: broad tag + text content match (handled via JS TreeWalker)
    '__TEXT_WALK__'
  ],

  /**
   * The results grid container element.
   * Used as the root to scope card queries and as the scroll target.
   */
  resultsGrid: [
    '[data-cy="search-results"]',
    '[data-cy="search-results-list"]',
    '.js-search-result-list',
    '[class*="SearchResults"]',
    '[class*="search-results"]',
    'ol[class*="result"]',
    'ul[class*="result"]',
    // Broad fallback: the <main> element
    'main[role="main"]',
    'main'
  ],

  /**
   * Individual result card / thumbnail within the grid.
   * Each card = one asset (video in our case).
   *
   * PATCH HINT: Right-click a thumbnail → Inspect.
   * Find the containing <li> or <article> with a data-* attribute.
   */
  resultCard: [
    // Tier 1: data attributes
    '[data-cy="search-result-item"]',
    '[data-asset-id]',
    '[data-content-id]',

    // Tier 2: BEM class patterns
    '[class*="search-result-cell"]',
    '[class*="SearchResultItem"]',
    '[class*="result-item"]',
    '[class*="asset-card"]',

    // Tier 3: list items inside known containers
    '.js-search-result-list li',
    'ol[class*="result"] > li',
    'ul[class*="result"] > li',

    // Tier 4: broad — any <article> in a results context
    'article[class*="result"]',
    'article'
  ],

  /**
   * The <a> link element INSIDE a result card that navigates
   * to the asset detail page.
   *
   * PATCH HINT: Hover a video thumbnail → look at the bottom-left
   * of the browser for the URL. It should be /video/<title>/<id>.
   */
  resultCardLink: [
    'a[data-asset-id]',
    'a[href*="/video/"]',
    'a[href*="/stock/"]',
    'a[class*="asset-link"]',
    'a[class*="thumb"]',
    'a[class*="Thumb"]',
    'a.js-open-panel-link',
    // Last resort: first <a> in card
    'a[href]'
  ],

  /**
   * Title/label of the asset as shown in the search grid.
   * Priority: data-title > img alt > a title attr > aria-label.
   */
  resultCardTitle: [
    '[data-title]',          // .getAttribute('data-title')
    'img[alt]',              // .getAttribute('alt')
    'a[title]',              // .getAttribute('title')
    '[aria-label]',          // .getAttribute('aria-label')
    '[class*="title"]',      // .textContent
    '[class*="label"]'       // .textContent
  ],

  /**
   * Indicator that a card is a VIDEO (not image/template).
   * On the filtered URL this is always true, but we check anyway.
   */
  videoIndicator: [
    '[data-content-type="video"]',
    '[data-asset-type="video"]',
    'video',
    '[class*="video"]',
    '[aria-label*="video" i]',
    '[aria-label*="Video"]'
  ],

  // ──────────────────────────────────────────────────────────────
  // SECTION C — ASSET DETAIL PAGE SELECTORS
  // ──────────────────────────────────────────────────────────────

  /**
   * Main title heading on an asset detail page.
   */
  detailTitle: [
    'h1[class*="title"]',
    '[data-cy="asset-title"]',
    '[class*="AssetTitle"]',
    '[class*="asset-title"]',
    'h1'
  ],

  /**
   * Container holding all keyword/tag links on the detail page.
   *
   * PATCH HINT: Scroll to the "Keywords" section on any video page.
   * Right-click the keyword list → Inspect. Look for a <ul> or <div>
   * with class containing "keyword" or "tag".
   *
   * Example markup (observed):
   *   <ul class="keywords-list">
   *     <li><a href="/search?k=nature">nature</a></li>
   *   </ul>
   */
  detailTagsContainer: [
    '[data-cy="keywords-list"]',
    '[data-cy="tags-list"]',
    '[class*="keywords-list"]',
    '[class*="keyword-list"]',
    '[class*="KeywordList"]',
    '[class*="tags-list"]',
    '[class*="TagList"]',
    '.asset-details-keywords',
    '[class*="Keywords"]',
    '[class*="Tags"]'
  ],

  /**
   * Individual keyword/tag elements inside the tags container.
   * Usually <a> links with href containing the keyword search.
   */
  detailTagItem: [
    'a[href*="?k="]',         // most reliable — search param link
    'a[href*="/search?"]',
    '[class*="keyword"]',
    '[class*="tag"]',
    'li > a',
    'a'
  ],

  // ──────────────────────────────────────────────────────────────
  // SECTION D — UI FALLBACK SELECTORS (if URL params fail)
  // Used when Adobe Stock doesn't honour URL filter params and
  // we must click the actual filter UI elements.
  // These are less reliable; prefer URL params from SECTION A.
  // ──────────────────────────────────────────────────────────────
  filterUI: {
    /**
     * The "Videos" filter button/tab in the filter bar.
     * PATCH HINT: Click "Videos" on the Adobe Stock filter bar,
     * then inspect the clicked element.
     */
    videoFilterButton: [
      '[data-cy="filter-content-type-video"]',
      '[data-value="video"]',
      'button[class*="video"]',
      'label[for*="video"]',
      '[aria-label*="Videos"]',
      '[aria-label*="Video"]'
    ],

    /**
     * The Sort dropdown trigger button.
     */
    sortDropdown: [
      '[data-cy="sort-dropdown"]',
      '[data-cy="sort-select"]',
      '[class*="sort-dropdown"]',
      '[class*="SortDropdown"]',
      'button[class*="sort"]',
      'select[class*="sort"]'
    ],

    /**
     * "Most Downloaded" option inside the sort dropdown.
     */
    sortMostDownloadedOption: [
      '[data-value="nb_downloads"]',
      '[data-cy="sort-option-nb_downloads"]',
      'option[value="nb_downloads"]',
      '[class*="sort-option"][class*="download"]'
    ],

    /**
     * "Load more" button for triggering pagination (if not lazy-scroll).
     */
    loadMoreButton: [
      '[data-cy="load-more"]',
      '[class*="load-more"]',
      '[class*="LoadMore"]',
      'button[class*="more"]'
    ]
  },

  // ──────────────────────────────────────────────────────────────
  // SECTION E — TIMING CONSTANTS
  // Increase values if Adobe Stock is slow on your connection.
  // ──────────────────────────────────────────────────────────────
  timing: {
    /** Max ms to wait for result count element after page load */
    resultCountTimeout: 20000,

    /** Max ms to wait for at least one card to appear in the grid */
    gridLoadTimeout: 25000,

    /** Polling fallback interval (used if MutationObserver misses) */
    pollInterval: 600,

    /** Number of scroll attempts before giving up on lazy loading */
    maxScrollAttempts: 40,

    /** Pause between scroll attempts (ms) */
    scrollPauseMs: 1000,

    /** Min/max random delay between detail page fetches (ms) */
    detailPageDelayMin: 800,
    detailPageDelayMax: 2000,

    /** Per-keyword hard timeout before treating as error (ms) */
    keywordTimeout: 45000,

    /** Backoff delays for retrying failed selector lookups */
    retryDelays: [500, 1000, 2000]
  }
};
