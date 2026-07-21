/**
 * utils/scrapeCore.js — Pure, testable scraping core
 * ══════════════════════════════════════════════════════════════
 *
 * This module holds the *pure* logic that decides:
 *   • how an asset's stable dedupe key is derived from a URL,
 *   • how titles/tags are cleaned,
 *   • how the "scrape N unique videos" loop advances and terminates.
 *
 * It has NO dependency on chrome.* / DOM / network, so it can be unit
 * tested directly in Node (see test/scrapeCore.test.mjs). background.js
 * imports `extractAssetId` and `runScrapeLoop` from here, so the tests
 * exercise the REAL control flow — not a re-implementation.
 *
 * NOTE: content.js keeps byte-identical copies of extractAssetId /
 * cleanTitle / cleanTag / isJunkTag because it runs as an injected
 * classic script (it cannot import ES modules). Keep them in sync.
 * ══════════════════════════════════════════════════════════════
 */

'use strict';

/**
 * Extract the stable numeric asset ID from a detail URL for reliable
 * deduplication. Handles trailing slashes, query strings, and #fragments
 * uniformly by taking the LAST purely-numeric path segment (Adobe Stock
 * asset URLs are /<type>/<slug>/<id>). Falls back to an asset_id/id query
 * param, then to the normalized origin+path, then the raw string.
 *
 * This robustness is the fix for the "duplicate videos with incomplete
 * tags" bug: the old /\/(\d+)(?:\?|$)/ regex fell back to the full URL for
 * common URL shapes, so the same asset seen via two URL variants produced
 * two different keys → a duplicate row.
 */
export function extractAssetId(url) {
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

/** Strip truncation ellipses and stray toggle labels from a title string. */
export function cleanTitle(t) {
  return String(t || '')
    .replace(/\s*(?:see\s*more|show\s*more|view\s*all|read\s*more)\s*$/i, '')
    .replace(/(?:\.{3}|…)\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalize a raw tag string. */
export function cleanTag(t) {
  return String(t || '').replace(/\s+/g, ' ').trim();
}

/** Reject non-tag noise: toggle labels, "+N more", pure numbers, bad length. */
export function isJunkTag(t) {
  if (!t) return true;
  if (t.length < 2 || t.length > 60) return true;
  if (/^(?:see\s*more|view\s*all|show\s*more|\+?\s*\d+\s*more)$/i.test(t)) return true;
  if (/^\d+$/.test(t)) return true;
  return false;
}

/**
 * Decide whether a tag read is "complete".
 *   • If the page states a total (targetCount) → complete once we reach it.
 *   • Otherwise → complete once we have a non-zero count that is UNCHANGED
 *     from the previous attempt (stable across two consecutive reads).
 * A stable count of 0 is never "complete" — that was the bug where an
 * empty/half-rendered list was accepted as final.
 */
export function isTagReadComplete(count, prevCount, targetCount) {
  if (targetCount && targetCount > 0) return count >= targetCount;
  return count > 0 && count === prevCount;
}

/**
 * Retry an "expand + read tags" attempt until the result is complete or
 * the attempt budget is exhausted, with backoff between tries. This is the
 * pure control logic behind content.js::getDetailData's retry loop (which
 * implements the identical algorithm inline because it is an injected
 * classic script and cannot import ES modules — keep the two in sync).
 *
 * Under simulated slow loading (attemptFn returns a count that grows across
 * calls as the DOM lazily renders), this converges to a complete result
 * instead of giving up on the first, partial read.
 *
 * @param {object}   o
 * @param {function} o.attemptFn    async (attempt:number) => number  (tags collected this pass)
 * @param {number|null} o.targetCount  page's stated tag total, if known
 * @param {number}   [o.maxAttempts=4]
 * @param {function} [o.backoff]     (attempt:number) => ms
 * @param {function} [o.sleep]
 * @returns {Promise<{count:number, complete:boolean, attempts:number}>}
 */
export async function retryUntilComplete({
  attemptFn,
  targetCount,
  maxAttempts = 4,
  backoff = (n) => 300 * n,
  sleep = (ms) => new Promise(r => setTimeout(r, ms))
}) {
  let count = 0, complete = false, attempt = 0, prevCount = -1;
  while (attempt < maxAttempts) {
    attempt++;
    count = await attemptFn(attempt);
    complete = isTagReadComplete(count, prevCount, targetCount);
    if (complete) break;
    prevCount = count;
    if (attempt < maxAttempts) await sleep(backoff(attempt));
  }
  return { count, complete, attempts: attempt };
}

/**
 * Drive the "scrape N unique videos with complete tags" loop.
 *
 * The caller supplies async I/O closures; this function owns all the
 * control flow (dedupe, ret/fail accounting, termination). It is
 * guaranteed to terminate: every asset is added to `processed` BEFORE it
 * is worked on, so it is attempted at most once, and each grid iteration
 * that yields no new asset ends the loop.
 *
 * @param {object}   o
 * @param {number}   o.videoCount   target number of unique videos
 * @param {function} o.fetchCards   async (target:number) => { cards:[{title,detailUrl,assetId?}] }
 * @param {function} o.fetchDetail  async (url:string)    => { assetId,title,tags,targetTagCount }
 * @param {function} [o.onProgress] ({scraped,total,step,assetId}) => void
 * @param {function} [o.onLog]      ({message,type}) => void
 * @param {function} [o.shouldStop] () => boolean   (stop/pause requested)
 * @param {number}   [o.deadlineMs] time budget; default scales with videoCount
 * @param {function} [o.now]        () => number (injectable clock for tests)
 * @param {function} [o.interItemDelay] async () => void (polite delay between items)
 * @returns {Promise<{videos:Array, failedCount:number, exhaustedGrid:boolean,
 *                    deadlineHit:boolean, reason:string|null}>}
 */
export async function runScrapeLoop({
  videoCount,
  fetchCards,
  fetchDetail,
  onProgress,
  onLog,
  shouldStop,
  deadlineMs,
  now = () => Date.now(),
  interItemDelay
}) {
  const videos = [];
  const processed = new Set();   // asset IDs ATTEMPTED (dedupe key)
  let failedCount = 0;
  let exhaustedGrid = false;
  let deadlineHit = false;

  const stop = () => (shouldStop ? !!shouldStop() : false);
  const deadline = now() + (deadlineMs ?? Math.max(90000, videoCount * 30000));
  const progress = p => { if (onProgress) onProgress(p); };
  const logline = l => { if (onLog) onLog(l); };

  while (videos.length < videoCount) {
    if (stop()) break;
    if (now() > deadline) { deadlineHit = true; break; }

    // Ask the grid for enough cards to also cover the ones that failed.
    const target = videoCount + failedCount;
    const resp = await fetchCards(target);
    const cards = (resp && resp.cards) || [];

    const newCards = cards.filter(c => {
      const id = c.assetId || extractAssetId(c.detailUrl);
      return id && !processed.has(id);
    });

    if (newCards.length === 0) { exhaustedGrid = true; break; }

    for (const card of newCards) {
      if (videos.length >= videoCount) break;
      if (stop()) break;
      if (now() > deadline) { deadlineHit = true; break; }

      const assetId = card.assetId || extractAssetId(card.detailUrl);
      processed.add(assetId); // attempted-once guarantee → strictly terminating
      const num = videos.length + 1;

      progress({ scraped: videos.length, total: videoCount, assetId,
                 step: `Scraping video ${num}/${videoCount}…` });

      if (!card.detailUrl) { failedCount++; continue; }

      try {
        const detail = await fetchDetail(card.detailUrl);

        // The resolved page's canonical ID may differ from the grid link
        // (redirects/slugs) — reconcile so a duplicate never slips through.
        const finalId = (detail && detail.assetId) || assetId;
        if (finalId !== assetId) processed.add(finalId);
        if (videos.some(v => v.assetId === finalId)) continue;

        const title = (detail && detail.title) || card.title || `Video ${num}`;
        const tags  = (detail && detail.tags) || [];

        if (tags.length === 0) {
          failedCount++;
          logline({ message: `No tags found for "${title}" — skipped`, type: 'skip' });
          continue;
        }
        if (detail.targetTagCount && tags.length < detail.targetTagCount) {
          logline({ message: `Partial tags ${tags.length}/${detail.targetTagCount} for "${title}"`, type: 'skip' });
        }

        videos.push({ title, tags, assetId: finalId });
        progress({ scraped: videos.length, total: videoCount,
                   step: `Scraped ${videos.length}/${videoCount}` });
      } catch (e) {
        failedCount++;
        logline({ message: `Video ${num} failed: ${e.message}`, type: 'skip' });
      }

      if (interItemDelay) await interItemDelay();
    }
  }

  let reason = null;
  if (videos.length < videoCount) {
    reason = exhaustedGrid ? 'no more results available in grid'
      : deadlineHit ? 'scrape time budget exhausted'
      : stop() ? 'stopped/paused'
      : 'unknown';
  }
  return { videos, failedCount, exhaustedGrid, deadlineHit, reason };
}
