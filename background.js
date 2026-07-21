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
  pauseRun,
  resumeRun,
  stopRun,
  completeRun
} from './utils/stateManager.js';

import { extractAssetId, runScrapeLoop } from './utils/scrapeCore.js';

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
  detailTabId:   null,     // reused hidden tab for asset detail pages
  stopFlag:      false,    // set true by Stop action
  pauseFlag:     false,    // set true by Pause action
  keywordTimer:  null      // per-keyword timeout handle
};

// ══════════════════════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════════════════════

// ── DEBUG INSTRUMENTATION ──────────────────────────────────────
// Flip to false to silence the verbose service-worker trace.
// Inspect via chrome://extensions → the extension's "service worker" console.
const DEBUG = true;
const dbg = (...a) => { if (DEBUG) console.log('%c[bg]', 'color:#e6000a', ...a); };

/** Send a message to the side panel (best-effort; panel may be closed). */
function notify(event, data = {}) {
  chrome.runtime.sendMessage({ event, ...data }).catch(() => {
    // Side panel may be closed — silently ignore
  });
}

/** Random delay between minMs and maxMs milliseconds. */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomDelay = (min, max) => sleep(Math.floor(Math.random() * (max - min + 1)) + min);
// extractAssetId is imported from utils/scrapeCore.js (single source of truth,
// shared with the unit tests).

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
  // Small settle only. The steps that read dynamic content afterwards
  // (get_result_count, scrape_video_cards) do their OWN condition-based
  // waits in content.js, so we don't gate on a fixed render timer here.
  await sleep(500);
}

/** Close the working tab when the run finishes or is stopped. */
async function closeWorkingTab() {
  if (rt.workingTabId) {
    try { await chrome.tabs.remove(rt.workingTabId); } catch (_) {}
    rt.workingTabId = null;
  }
}

// ══════════════════════════════════════════════════════════════
// DETAIL-PAGE SCRAPING
// ──────────────────────────────────────────────────────────────
// A SINGLE hidden tab is reused for every asset detail page in the
// run. This is the only reliable way to read a React SPA's fully
// rendered keyword list and expanded title:
//   • plain fetch() returns pre-hydration HTML with only a partial
//     keyword subset — that was the root cause of missing/short tags
//     and "See More"-polluted titles in previous versions.
//   • Reusing one tab (vs. create+destroy per video) removes the
//     per-video 20s load wait and the tab-churn races that caused
//     the loop to stall out at 5–6 videos.
// content.js does the DOM work (expand + verify + extract) and
// returns { assetId, title, tags, targetTagCount }.
// ══════════════════════════════════════════════════════════════

/** Ensure the reusable detail tab exists (create if missing/closed). */
async function ensureDetailTab() {
  if (rt.detailTabId != null) {
    try { await chrome.tabs.get(rt.detailTabId); return; }
    catch (_) { rt.detailTabId = null; }
  }
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  rt.detailTabId = tab.id;
  dbg('created detail tab', rt.detailTabId);
}

/** Close the reusable detail tab. */
async function closeDetailTab() {
  if (rt.detailTabId != null) {
    try { await chrome.tabs.remove(rt.detailTabId); } catch (_) {}
    rt.detailTabId = null;
  }
}

/**
 * Navigate the reused detail tab to an asset URL and extract its
 * title + full tag list from the rendered DOM.
 *
 * We do NOT trust tab "load complete" as a signal that the (lazily
 * rendered) keyword list is present — that race caused inconsistent
 * partial-tag results. content.js::getDetailData does the real
 * condition-based wait (waitForTagsReady) plus a retry loop, and returns
 * per-video diagnostics (complete / attempts / readyMs / elapsedMs).
 *
 * @param {string} url — full asset detail URL
 */
async function scrapeDetailPage(url) {
  await ensureDetailTab();
  await chrome.tabs.update(rt.detailTabId, { url });
  await waitForTabLoad(rt.detailTabId, 30000);
  // Minimal settle only so the content script is injectable; the actual
  // "is the tags section rendered?" wait happens inside content.js.
  await sleep(300);

  const resp = await sendToContent(rt.detailTabId, { action: 'get_detail_data' }, 3);
  if (resp?.error) throw new Error(resp.error);

  return {
    assetId:        resp?.assetId || extractAssetId(url),
    title:          resp?.title || '',
    tags:           Array.isArray(resp?.tags) ? resp.tags : [],
    targetTagCount: resp?.targetTagCount ?? null,
    complete:       resp?.complete ?? null,
    attempts:       resp?.attempts ?? null,
    readyMs:        resp?.readyMs ?? null,
    elapsedMs:      resp?.elapsedMs ?? null
  };
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

  // ── Two-phase deadlines (replaces the old blunt 45s cap) ─────────
  // The setup phase (navigate + verify + count) is quick and gets a
  // fixed budget. Scraping N detail pages is inherently sequential, so
  // its budget SCALES with videoCount. The fixed 45s cap was the direct
  // cause of the "only 5/10 videos" bug: it fired mid-scrape and killed
  // legitimate in-progress work.
  const setupDeadline  = Date.now() + 60000;
  const scrapeBudgetMs = Math.max(90000, videoCount * 30000);

  try {
    // ── STEP 1+2: Navigate with filters already in the URL ────────
    const filteredUrl = buildFilteredUrl(keyword);
    notify('step', { keyword, step: 'Navigating to filtered results…' });
    dbg(`keyword "${keyword}" → ${filteredUrl}`);

    await navigateWorkingTab(filteredUrl);
    if (Date.now() > setupDeadline) throw new Error('Timed out during navigation');

    // ── STEP 3: Verify URL filter was honoured ─────────────────────
    notify('step', { keyword, step: 'Verifying filters applied…' });
    const verifyResp = await sendToContent(rt.workingTabId, { action: 'verify_and_fix_filters' });
    if (verifyResp?.navigatedTo) {
      await waitForTabLoad(rt.workingTabId, 25000);
      await sleep(500); // content-side reads re-wait condition-based
    }
    if (Date.now() > setupDeadline) throw new Error('Timed out during filter verification');

    // ── STEP 4: Read competition count ─────────────────────────────
    notify('step', { keyword, step: 'Reading competition count…' });
    const countResp = await sendToContent(rt.workingTabId, { action: 'get_result_count' });
    if (!countResp || countResp.error) {
      throw new Error(countResp?.error || 'No response from content script (get_result_count)');
    }

    const count = countResp.count;
    result.competitionCount = count;
    dbg(`competition count for "${keyword}" = ${count}`);
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

    // ── STEP 6 & 7: Scrape N unique videos + full tags ─────────────
    // The dedupe / retry / termination logic lives in the shared,
    // unit-tested runScrapeLoop(). Here we only wire up the real I/O:
    // grid scraping (working tab) and detail scraping (reused hidden tab).
    dbg(`scrape start: need ${videoCount}, budget ${Math.round(scrapeBudgetMs / 1000)}s`);

    const loop = await runScrapeLoop({
      videoCount,
      deadlineMs: scrapeBudgetMs,

      // Load the grid and return its cards (content.js dedupes internally too).
      fetchCards: async (target) => {
        notify('step', { keyword, step: `Loading result grid (need ${videoCount})…` });
        const cardsResp = await sendToContent(rt.workingTabId, {
          action: 'scrape_video_cards', videoCount: target
        });
        if (!cardsResp || cardsResp.error) {
          throw new Error(cardsResp?.error || 'No response from content script (scrape_video_cards)');
        }
        const cards = cardsResp.cards || [];
        dbg(`grid returned ${cards.length} cards (requested ${target})`);
        return { cards };
      },

      // Navigate the reused detail tab and extract title + full tags,
      // guarded by a per-video hard timeout so one bad page can't hang.
      fetchDetail: async (url) => {
        dbg(`▶ detail ${url}`);
        const detail = await Promise.race([
          scrapeDetailPage(url),
          new Promise((_, rej) => setTimeout(() => rej(new Error('detail page timeout (30s)')), 30000))
        ]);
        // Per-video timing/retry diagnostics — makes intermittent timing
        // variance visible in the console instead of invisible.
        dbg(`  ◀ id=${detail.assetId} tags=${detail.tags.length}` +
            (detail.targetTagCount ? `/${detail.targetTagCount}` : '') +
            ` complete=${detail.complete} attempts=${detail.attempts}` +
            ` readyMs=${detail.readyMs} totalMs=${detail.elapsedMs} title="${detail.title}"`);
        if (detail.complete === false) {
          notify('log', {
            message: `  ⚠ Tags may be incomplete for "${detail.title}" ` +
              `(${detail.tags.length}${detail.targetTagCount ? '/' + detail.targetTagCount : ''}` +
              `, after ${detail.attempts} attempts / ${detail.elapsedMs}ms)`,
            type: 'skip'
          });
        }
        return detail;
      },

      onProgress: (p) => notify('scrape_progress', { keyword, ...p }),
      onLog:      (l) => notify('log', { message: '  ⚠ ' + l.message, type: l.type }),
      shouldStop: () => rt.stopFlag || rt.pauseFlag,
      interItemDelay: () => randomDelay(400, 900)
    });

    const { videos } = loop;
    notify('scrape_progress', { keyword, scraped: videos.length, total: videoCount, step: 'Done' });

    // ── VALIDATION ────────────────────────────────────────────────
    if (loop.reason) {
      notify('log', {
        message: `  ⚠ Scraped ${videos.length}/${videoCount} videos (${loop.reason})`,
        type: videos.length > 0 ? 'skip' : 'error'
      });
      result.skipReason = (result.skipReason ? result.skipReason + '; ' : '') +
        `Partial: ${videos.length}/${videoCount} videos (${loop.reason})`;
    } else {
      notify('log', { message: `  ✓ Scraped all ${videos.length} videos`, type: 'ok' });
    }

    // Store per documented schema { title, tags } (drop internal assetId).
    result.videos = videos.map(v => ({ title: v.title, tags: v.tags }));

  } catch (err) {
    result.status     = 'error';
    result.skipReason = err.message;
    notify('keyword_error', { keyword, error: err.message });
    console.error('[bg] Error processing "' + keyword + '":', err);
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
    await closeDetailTab();
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
            settings: {}, results: [], workingTabId: null, detailTabId: null,
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
