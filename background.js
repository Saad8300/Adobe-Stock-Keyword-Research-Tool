/**
 * background.js — Service Worker / Orchestrator
 * ════════════════════════════════════════════════
 *
 * STATE MACHINE
 * ─────────────
 *  idle ──[start]──► running ──[pause]──► paused ──[resume]──► running
 *                  │                   │
 *                  │[stop]             │[stop]
 *                  ▼                   ▼
 *               stopped            stopped
 *                  │
 *              (all done)
 *                  ▼
 *             completed
 *
 * AUTOMATION ORDER (mandatory — filters first, count second):
 *  1. Navigate to filtered+sorted URL (video filter + most downloaded)
 *  2. Wait for page to fully load
 *  3. Read competition count from already-filtered page
 *  4. Compare against min/max
 *  5. If qualified → scrape top N videos
 *  6. For each video → fetch detail page tags
 *  7. Store result → advance queue
 *
 * MESSAGING PROTOCOL
 * ────────────────────
 * background → sidepanel:  { event: string, ...payload }
 * sidepanel  → background:  { action: string, ...payload }
 * content    → background:  via sendResponse callbacks
 *
 * EXCEL EXPORT
 * ────────────────────
 * SheetJS (xlsx.min.js) is NOT loaded here. Service workers have no
 * window/DOM, so XLSX globals are unavailable. All workbook generation
 * happens in sidepanel.js where xlsx.min.js is loaded via a <script> tag.
 */

'use strict';

import {
  loadState,
  saveState,
  clearState,
  initRun,
  advanceKeyword,
  pauseRun,
  resumeRun,
  stopRun,
  completeRun,
  hasResumableSession
} from './utils/stateManager.js';

// ══════════════════════════════════════════════════════════════
// SIDE PANEL REGISTRATION
// ══════════════════════════════════════════════════════════════

// Open side panel when the extension icon is clicked
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(e => console.warn('[bg] setPanelBehavior failed:', e));

// ══════════════════════════════════════════════════════════════
// IN-MEMORY RUNTIME STATE
// Mirrors chrome.storage but kept in memory for fast access
// during a run. Persisted to storage at key checkpoints.
// ══════════════════════════════════════════════════════════════
let rt = {
  status:        'idle',   // mirrors storage status
  keywords:      [],
  currentIndex:  0,
  settings:      {},
  results:       [],
  workingTabId:  null,     // the tab we navigate for main searches
  stopFlag:      false,    // set true by Stop action
  pauseFlag:     false,    // set true by Pause action
  keywordTimer:  null      // per-keyword timeout handle
};

// ══════════════════════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════════════════════

/** Send a message to the side panel (best-effort; panel may be closed). */
function notify(event, data = {}) {
  chrome.runtime.sendMessage({ event, ...data }).catch(() => {
    // Side panel may be closed — silently ignore
  });
}

/** Random delay between minMs and maxMs milliseconds. */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const randomDelay = (min, max) => sleep(Math.floor(Math.random() * (max - min + 1)) + min);

/**
 * Wait for a Chrome tab to reach 'complete' status.
 * @param {number} tabId
 * @param {number} timeoutMs
 */
function waitForTabLoad(tabId, timeoutMs = 35000) {
  return new Promise((resolve, reject) => {
    // Check if it's already complete
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (tab.status === 'complete') return resolve();
    });

    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Tab ${tabId} load timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * Ensure content scripts are injected into a tab, then send it a
 * message and await the async response.
 *
 * Retries up to `maxAttempts` times with increasing delays (backoff).
 * @returns {Promise<any>} — the response object from content.js
 */
async function sendToContent(tabId, message, maxAttempts = 4) {
  // Inject scripts (idempotent — throws if already injected, which is fine)
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['config/selectors.js', 'content.js']
    });
  } catch (_) {
    // Already injected or not injectable — continue
  }

  const delays = [600, 1200, 2000, 3000]; // backoff schedule

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      return response;
    } catch (err) {
      if (attempt === maxAttempts - 1) throw err;
      notify('log', {
        message: `  ↻ Retry ${attempt + 1}/${maxAttempts - 1} (${err.message})`,
        type: 'muted'
      });
      await sleep(delays[attempt] || 2000);
    }
  }
}

// ══════════════════════════════════════════════════════════════
// WORKING TAB MANAGEMENT
// ══════════════════════════════════════════════════════════════

/** Open or navigate the single persistent working tab. */
async function navigateWorkingTab(url) {
  if (!rt.workingTabId) {
    const tab = await chrome.tabs.create({ url, active: false });
    rt.workingTabId = tab.id;
  } else {
    // Verify tab still exists before navigating
    try {
      await chrome.tabs.get(rt.workingTabId);
      await chrome.tabs.update(rt.workingTabId, { url });
    } catch (_) {
      // Tab was closed externally — create a new one
      const tab = await chrome.tabs.create({ url, active: false });
      rt.workingTabId = tab.id;
    }
  }
  await waitForTabLoad(rt.workingTabId, 35000);
  // Extra pause for React/SPA frameworks to finish rendering
  await sleep(1500);
}

/** Close the working tab when the run finishes or is stopped. */
async function closeWorkingTab() {
  if (rt.workingTabId) {
    try { await chrome.tabs.remove(rt.workingTabId); } catch (_) {}
    rt.workingTabId = null;
  }
}

// ══════════════════════════════════════════════════════════════
// TAG FETCHING FROM DETAIL PAGES
// Two strategies, tried in order:
//   A. fetch() + DOMParser — fast, no extra tab
//   B. Hidden tab — full JS rendering, slower but more reliable
// ══════════════════════════════════════════════════════════════

/**
 * Try to extract tags and title from a detail page URL.
 * @param {string} url — full URL of the asset detail page
 * @returns {Promise<{tags: string[], title: string}>}
 */
async function fetchTagsFromDetailPage(url) {
  // ── Strategy A: plain fetch ──────────────────────────────────
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      credentials: 'omit'
    });
    if (res.ok) {
      const html = await res.text();
      const tags = parseTagsFromHtml(html);
      
      let title = '';
      try {
        // DOMParser is available in MV3 service workers only in very new Chrome versions,
        // but we'll try basic regex fallback if DOMParser fails.
        // Wait, DOMParser is NOT available in SW! 
        // We'll just rely on Strategy B for title or use regex.
        const match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
        if (match) title = match[1].trim();
      } catch (_) {}

      if (tags.length > 0) {
        console.log(`[bg] fetch() got ${tags.length} tags from ${url}`);
        return { tags, title };
      }
      // Zero tags from static parse — fall through to tab method
    }
  } catch (e) {
    console.warn('[bg] fetch() for tags failed:', e.message, '— trying hidden tab');
  }

  // ── Strategy B: hidden tab ────────────────────────────────────
  return fetchTagsViaHiddenTab(url);
}

/**
 * Parse tags from raw HTML string. Service workers don't have DOMParser.
 */
function parseTagsFromHtml(html) {
  const tags = new Set();
  
  // Basic regex fallback since DOMParser isn't in Service Worker
  // (We primarily rely on hidden tab for accuracy anyway)
  const metaMatch = html.match(/<meta\s+name="keywords"\s+content="([^"]+)"/i);
  if (metaMatch) {
    metaMatch[1].split(',').forEach(k => {
      const t = k.trim();
      if (t) tags.add(t);
    });
  }

  // Look for JSON-LD structured data
  const jsonLdRegex = /<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = jsonLdRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      extractJsonLdTags(data, tags);
    } catch (_) {}
  }

  return [...tags];
}

function extractJsonLdTags(data, tagSet) {
  if (!data) return;
  if (data.keywords) {
    const kws = Array.isArray(data.keywords) ? data.keywords : String(data.keywords).split(',');
    kws.forEach(k => { const t = k.trim(); if (t) tagSet.add(t); });
  }
  if (data.about) {
    (Array.isArray(data.about) ? data.about : [data.about])
      .forEach(item => { if (item?.name) tagSet.add(item.name.trim()); });
  }
  if (data['@graph']) data['@graph'].forEach(n => extractJsonLdTags(n, tagSet));
}

/**
 * Open a hidden tab, wait for it to load, message content.js to
 * scrape tags, then close the tab.
 */
async function fetchTagsViaHiddenTab(url) {
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    await waitForTabLoad(tabId, 20000);
    await sleep(1200); // let React finish

    const resp = await sendToContent(tabId, { action: 'get_detail_tags' }, 3);
    return {
      tags: (resp && Array.isArray(resp.tags)) ? resp.tags : [],
      title: resp?.title || ''
    };
  } catch (e) {
    console.warn('[bg] Hidden tab tag fetch failed:', e.message);
    return { tags: [], title: '' };
  } finally {
    if (tabId) {
      try { await chrome.tabs.remove(tabId); } catch (_) {}
    }
  }
}

// ══════════════════════════════════════════════════════════════
// CORE: PROCESS ONE KEYWORD
// Implements the MANDATORY automation order from spec Section 3.
// ══════════════════════════════════════════════════════════════

/**
 * Process a single keyword through the full automation pipeline.
 *
 * MANDATORY ORDER:
 *  1. Navigate to URL with filters already applied (video + most downloaded)
 *  2. Wait for grid
 *  3. Read competition count (on already-filtered page)
 *  4. Compare range
 *  5. Scrape N videos (if qualified)
 *  6. Fetch tags for each video
 *  7. Return result entry
 */
async function processKeyword(keyword, index, total) {
  const { minComp, maxComp, videoCount } = rt.settings;

  // Result entry initialized with error defaults (overwritten on success)
  const result = {
    keyword,
    status:           'error',
    competitionCount: null,
    skipReason:       '',
    videos:           []
  };

  notify('keyword_start', { keyword, index, total });

  // Per-keyword hard timeout — wraps the entire processing block
  let keywordTimedOut = false;
  const timeoutHandle = setTimeout(() => {
    keywordTimedOut = true;
  }, 45000); // 45 seconds

  try {
    // ── STEP 1+2: Navigate with filters already in the URL ────────
    // This combines "apply filters" and "navigate" into one shot.
    // The URL encodes: video content type + most downloaded sort.
    const filteredUrl = buildFilteredUrl(keyword);
    notify('step', { keyword, step: 'Navigating to filtered results…' });
    notify('log', { message: `  → ${filteredUrl}`, type: 'muted' });

    await navigateWorkingTab(filteredUrl);

    if (keywordTimedOut) throw new Error('Keyword timed out during navigation');

    // ── STEP 3: Verify URL filter was honoured ─────────────────────
    // Some traffic configurations may strip the filter params.
    // The content script will verify and optionally click fallback UI.
    notify('step', { keyword, step: 'Verifying filters applied…' });
    const verifyResp = await sendToContent(rt.workingTabId, {
      action: 'verify_and_fix_filters'
    });

    if (verifyResp?.navigatedTo) {
      // Content script triggered a URL fix — wait for reload
      await waitForTabLoad(rt.workingTabId, 25000);
      await sleep(1500);
    }

    if (keywordTimedOut) throw new Error('Keyword timed out during filter verification');

    // ── STEP 4: Read competition count ─────────────────────────────
    notify('step', { keyword, step: 'Reading competition count…' });
    const countResp = await sendToContent(rt.workingTabId, { action: 'get_result_count' });

    if (!countResp || countResp.error) {
      throw new Error(countResp?.error || 'No response from content script (get_result_count)');
    }

    const count = countResp.count;
    result.competitionCount = count;
    notify('competition_found', { keyword, count });

    // ── STEP 5: Compare against range ─────────────────────────────
    if (count < minComp) {
      result.status     = 'skipped';
      result.skipReason = `Below min (${minComp.toLocaleString()})`;
      notify('keyword_skipped', { keyword, count, reason: result.skipReason });
      return result;
    }
    if (count > maxComp) {
      result.status     = 'skipped';
      result.skipReason = `Above max (${maxComp.toLocaleString()})`;
      notify('keyword_skipped', { keyword, count, reason: result.skipReason });
      return result;
    }

    // Qualified!
    result.status = 'qualified';
    notify('keyword_qualified', { keyword, count });

    if (keywordTimedOut) throw new Error('Keyword timed out before scraping');

    // ── STEP 6: Scrape top N video cards from the grid ───────────
    notify('step', { keyword, step: `Scraping top ${videoCount} videos…` });
    const cardsResp = await sendToContent(rt.workingTabId, {
      action: 'scrape_video_cards',
      videoCount
    });

    if (!cardsResp || cardsResp.error) {
      throw new Error(cardsResp?.error || 'No response from content script (scrape_video_cards)');
    }

    const cards = cardsResp.cards || [];
    notify('log', { message: `  Found ${cards.length} video card(s) to process`, type: 'muted' });

    // ── STEP 7: Fetch tags from each video detail page ────────────
    const videos = [];
    for (let i = 0; i < cards.length; i++) {
      if (rt.stopFlag || rt.pauseFlag) break;
      if (keywordTimedOut) break;

      const card = cards[i];
      notify('scrape_progress', {
        keyword,
        scraped: i,
        total: cards.length,
        step: `Fetching tags for video ${i + 1}/${cards.length}…`
      });

      let tags = [];
      let fullTitle = card.title || `Video ${i + 1}`;
      if (card.detailUrl) {
        try {
          const detailData = await fetchTagsFromDetailPage(card.detailUrl);
          tags = detailData.tags;
          if (detailData.title) fullTitle = detailData.title;
        } catch (e) {
          notify('log', {
            message: `  ⚠ Tag fetch failed for "${card.title || 'video ' + (i+1)}": ${e.message}`,
            type: 'skip'
          });
        }
        // Randomized delay between detail page fetches
        await randomDelay(800, 2000);
      }

      videos.push({ title: fullTitle, tags });
    }

    notify('scrape_progress', { keyword, scraped: videos.length, total: cards.length, step: 'Done' });
    
    // ── VALIDATION CHECK ──────────────────────────────────────────
    if (videos.length < videoCount) {
      notify('log', {
        message: `  ⚠ Validation: only ${videos.length}/${videoCount} unique videos found (grid may have fewer results or max scroll reached)`,
        type: 'error'
      });
      // Ensure we record the reason in the summary
      result.skipReason = (result.skipReason ? result.skipReason + '; ' : '') + `Partial scrape: ${videos.length}/${videoCount} videos`;
    } else {
      notify('log', {
        message: `  ✓ Validation: successfully scraped ${videos.length} unique videos`,
        type: 'ok'
      });
    }

    result.videos = videos;

  } catch (err) {
    result.status     = 'error';
    result.skipReason = err.message;
    notify('keyword_error', { keyword, error: err.message });
    console.error(`[bg] Error processing "${keyword}":`, err);
  } finally {
    clearTimeout(timeoutHandle);
  }

  return result;
}

// ══════════════════════════════════════════════════════════════
// URL BUILDER (mirrors selectors.js but available in SW scope)
// Selectors.js is a content-side script; we duplicate the URL
// builder here for the service worker.
// ══════════════════════════════════════════════════════════════

function buildFilteredUrl(keyword) {
  const k = encodeURIComponent(keyword.trim());
  return `https://stock.adobe.com/search?k=${k}&filters[content_type:video]=1&order=nb_downloads`;
}

// ══════════════════════════════════════════════════════════════
// MAIN AUTOMATION LOOP
// ══════════════════════════════════════════════════════════════

async function runAutomationLoop() {
  const state = await loadState();
  rt.keywords     = state.keywords;
  rt.settings     = state.settings;
  rt.results      = state.results || [];
  rt.currentIndex = state.currentIndex || 0;
  rt.status       = 'running';
  rt.stopFlag     = false;
  rt.pauseFlag    = false;

  const total = rt.keywords.length;

  notify('run_started', {
    total,
    currentIndex: rt.currentIndex,
    resuming: rt.currentIndex > 0
  });

  try {
    while (rt.currentIndex < total) {
      // ── Check pause/stop flags ─────────────────────────────────
      if (rt.stopFlag) {
        await stopRun();
        rt.status = 'stopped';
        notify('run_stopped', {
          results: rt.results,
          totalScraped: rt.results.reduce((a, r) => a + r.videos.length, 0)
        });
        return;
      }

      if (rt.pauseFlag) {
        // Persist pause state so Resume can pick up from here
        await saveState({
          status:       'paused',
          currentIndex: rt.currentIndex,
          results:      rt.results
        });
        rt.status = 'paused';
        notify('run_paused', {
          currentIndex: rt.currentIndex,
          total,
          results: rt.results
        });
        return; // Exit loop — Resume will re-enter runAutomationLoop
      }

      const keyword = rt.keywords[rt.currentIndex];

      // ── Process keyword ────────────────────────────────────────
      const result = await processKeyword(keyword, rt.currentIndex, total);
      rt.results = [...rt.results, result];

      // Persist after each keyword so pausing/crashing doesn't lose work
      await saveState({
        currentIndex: rt.currentIndex + 1,
        results:      rt.results,
        status:       'running'
      });
      rt.currentIndex++;

      // Send keyword summary to side panel
      notify('keyword_done', {
        result,
        processed: rt.currentIndex,
        total,
        allResults: rt.results
      });

      // Brief pause between keywords
      if (rt.currentIndex < total && !rt.stopFlag && !rt.pauseFlag) {
        await sleep(1000);
      }
    }

    // ── All keywords done ──────────────────────────────────────────
    await completeRun();
    rt.status = 'completed';

    const totalScraped = rt.results.reduce((a, r) => a + r.videos.length, 0);
    notify('run_completed', {
      results: rt.results,
      totalScraped,
      qualified: rt.results.filter(r => r.status === 'qualified').length,
      skipped:   rt.results.filter(r => r.status === 'skipped').length,
      errors:    rt.results.filter(r => r.status === 'error').length
    });

  } finally {
    await closeWorkingTab();
  }
}

// ══════════════════════════════════════════════════════════════
// MESSAGE ROUTER
// All messages from the side panel and content scripts arrive here.
// ══════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.action) return false;

  (async () => {
    try {
      switch (msg.action) {

        // ── Triggered by "Start" button ─────────────────────────
        case 'start': {
          if (rt.status === 'running') {
            sendResponse({ ok: false, reason: 'Already running' });
            return;
          }
          const { keywords, settings } = msg.payload;
          
          notify('log', {
            message: `Starting run: keyword(s)=${keywords.length}, min=${settings.minComp}, max=${settings.maxComp}, videos=${settings.videoCount}`,
            type: 'info'
          });

          await initRun({ keywords, settings });
          rt.status       = 'running';
          rt.keywords     = keywords;
          rt.settings     = settings;
          rt.results      = [];
          rt.currentIndex = 0;
          rt.stopFlag     = false;
          rt.pauseFlag    = false;
          sendResponse({ ok: true });
          // Run loop in background (don't await here — return sendResponse first)
          runAutomationLoop().catch(e => {
            console.error('[bg] runAutomationLoop crashed:', e);
            notify('run_error', { error: e.message });
          });
          break;
        }

        // ── Triggered by "Resume" button ─────────────────────────
        case 'resume': {
          if (rt.status === 'running') {
            sendResponse({ ok: false, reason: 'Already running' });
            return;
          }
          await resumeRun();
          rt.status    = 'running';
          rt.stopFlag  = false;
          rt.pauseFlag = false;
          sendResponse({ ok: true });
          runAutomationLoop().catch(e => {
            console.error('[bg] resume runAutomationLoop crashed:', e);
            notify('run_error', { error: e.message });
          });
          break;
        }

        // ── Triggered by "Pause" button ──────────────────────────
        case 'pause': {
          rt.pauseFlag = true;
          sendResponse({ ok: true });
          notify('log', { message: '⏸ Pause requested — will pause after current step.', type: 'skip' });
          break;
        }

        // ── Triggered by "Stop" button ───────────────────────────
        case 'stop': {
          rt.stopFlag  = true;
          rt.pauseFlag = false;
          sendResponse({ ok: true });
          notify('log', { message: '⛔ Stop requested — finishing current step then halting.', type: 'error' });
          break;
        }

        // ── Side panel loaded — check for resumable state ────────
        case 'get_state': {
          const s = await loadState();
          sendResponse({ ok: true, state: s });
          break;
        }

        // ── Clear all state (after export or manual reset) ───────
        case 'clear_state': {
          await clearState();
          rt = {
            status: 'idle', keywords: [], currentIndex: 0,
            settings: {}, results: [], workingTabId: null,
            stopFlag: false, pauseFlag: false, keywordTimer: null
          };
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ ok: false, reason: `Unknown action: ${msg.action}` });
      }
    } catch (e) {
      console.error('[bg] Message handler error:', e);
      sendResponse({ ok: false, reason: e.message });
      notify('run_error', { error: e.message });
    }
  })();

  return true; // Keep channel open for async sendResponse
});

// ══════════════════════════════════════════════════════════════
// STARTUP — rehydrate in-memory rt from storage
// (service worker may have been terminated and restarted)
// ══════════════════════════════════════════════════════════════
(async () => {
  try {
    const s = await loadState();
    rt.status       = s.status;
    rt.keywords     = s.keywords     || [];
    rt.currentIndex = s.currentIndex || 0;
    rt.settings     = s.settings     || {};
    rt.results      = s.results      || [];
    console.log(`[bg] Rehydrated state: status=${s.status}, index=${s.currentIndex}/${s.keywords.length}`);
  } catch (e) {
    console.error('[bg] Startup rehydration failed:', e);
  }
})();

console.log('[bg] Adobe Stock Keyword Research Tool v2 — service worker ready.');
