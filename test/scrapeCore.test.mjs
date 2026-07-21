/**
 * test/scrapeCore.test.mjs — Unit tests for the scraping core
 * ══════════════════════════════════════════════════════════════
 *
 * Run: node test/scrapeCore.test.mjs
 *
 * These tests exercise the SAME module background.js imports
 * (utils/scrapeCore.js), so they verify the real control flow that
 * decides dedupe, termination, and per-video success — the exact
 * places the persistent bugs lived.
 *
 * Covered:
 *   1. extractAssetId robustness (dedupe key) across URL shapes
 *   2. cleanTitle strips "See More" / ellipsis (Bug 2)
 *   3. isJunkTag rejects toggle labels / numbers (Bug 4)
 *   4. runScrapeLoop: 10 requested → 10 UNIQUE, no dupes (Bugs 1 & 3)
 *   5. runScrapeLoop: per-video failures don't kill the loop (Bug 1)
 *   6. runScrapeLoop: duplicate URLs collapse to one asset (Bug 3)
 *   7. runScrapeLoop: genuinely-fewer results reported correctly
 *   8. runScrapeLoop: zero-tag pages rejected (Bug 4 data quality)
 *   9. runScrapeLoop: stop flag halts promptly
 *  10. runScrapeLoop: deadline halts without throwing
 */

import {
  extractAssetId, cleanTitle, cleanTag, isJunkTag, runScrapeLoop,
  isTagReadComplete, retryUntilComplete
} from '../utils/scrapeCore.js';

let passed = 0, failed = 0;
const fails = [];
function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; fails.push(msg); console.error('  ✗ ' + msg); }
}
function eq(a, b, msg) { assert(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

// Build a fake Adobe Stock video URL for a numeric id.
const url = id => `https://stock.adobe.com/video/some-slug-${id}/${id}`;

// ── 1. extractAssetId ──────────────────────────────────────────
(() => {
  eq(extractAssetId('https://stock.adobe.com/video/title/123456'), '123456', 'plain URL');
  eq(extractAssetId('https://stock.adobe.com/video/title/123456/'), '123456', 'trailing slash');
  eq(extractAssetId('https://stock.adobe.com/video/title/123456?clickref=x'), '123456', 'query string');
  eq(extractAssetId('https://stock.adobe.com/video/title/123456#kw'), '123456', 'fragment');
  eq(extractAssetId('https://stock.adobe.com/video/title/123456/?a=b&c=d'), '123456', 'slash + query');
  eq(extractAssetId('/video/title/123456'), '123456', 'relative URL');
  eq(extractAssetId('https://stock.adobe.com/images/foo/?asset_id=999'), '999', 'asset_id param');
  // Two different URL shapes for the SAME asset must produce the SAME key.
  eq(extractAssetId(url(555)), extractAssetId(url(555) + '?ref=abc'),
     'same asset via different URLs → same key');
  eq(extractAssetId(null), null, 'null URL');
})();

// ── 2. cleanTitle (Bug 2) ──────────────────────────────────────
(() => {
  eq(cleanTitle('Aerial city sunset ... See More'), 'Aerial city sunset', 'strip "... See More"');
  eq(cleanTitle('Business team meeting…'), 'Business team meeting', 'strip ellipsis char');
  eq(cleanTitle('Ocean waves\n   slow motion   See More'), 'Ocean waves slow motion', 'strip See More + collapse ws');
  eq(cleanTitle('Charts and graphs...'), 'Charts and graphs', 'strip trailing ...');
  eq(cleanTitle('Clean title'), 'Clean title', 'leave clean title untouched');
  assert(!/see\s*more/i.test(cleanTitle('Data charts and \n ... \n See More')),
     'the exact reported bug string no longer contains "See More"');
})();

// ── 3. isJunkTag / cleanTag (Bug 4) ────────────────────────────
(() => {
  assert(isJunkTag('See More'), 'reject "See More"');
  assert(isJunkTag('View All'), 'reject "View All"');
  assert(isJunkTag('+45 more'), 'reject "+45 more"');
  assert(isJunkTag('123'), 'reject pure number');
  assert(isJunkTag(''), 'reject empty');
  assert(!isJunkTag('nature'), 'keep real tag "nature"');
  assert(!isJunkTag('slow motion'), 'keep multi-word tag');
  eq(cleanTag('  aerial   drone  '), 'aerial drone', 'cleanTag collapses whitespace');
})();

// ── Helpers for loop tests ─────────────────────────────────────
// Simulate a grid of N unique assets that "lazy loads": fetchCards(target)
// returns up to `target` cards (capped by however many really exist).
function makeGrid(totalAssets, { detailBehavior } = {}) {
  const all = Array.from({ length: totalAssets }, (_, i) => ({
    title: `Card ${i + 1}`,
    detailUrl: url(1000 + i)
  }));
  const fetchCards = async (target) => ({ cards: all.slice(0, Math.min(target, all.length)) });
  const fetchDetail = async (u) => {
    const id = extractAssetId(u);
    const behavior = detailBehavior ? detailBehavior(id) : {};
    if (behavior.throw) throw new Error(behavior.throw);
    return {
      assetId: id,
      title: behavior.title ?? `Title ${id}`,
      tags: 'tags' in behavior ? behavior.tags : ['a', 'b', 'c'],
      targetTagCount: behavior.targetTagCount ?? null
    };
  };
  return { fetchCards, fetchDetail };
}

function noDuplicates(videos) {
  const ids = videos.map(v => v.assetId);
  return new Set(ids).size === ids.length;
}

// ── 4. 10 requested → 10 unique, no dupes ──────────────────────
await (async () => {
  const { fetchCards, fetchDetail } = makeGrid(200);
  const r = await runScrapeLoop({ videoCount: 10, fetchCards, fetchDetail });
  eq(r.videos.length, 10, 'got exactly 10 videos');
  assert(noDuplicates(r.videos), 'no duplicate asset IDs');
  eq(r.reason, null, 'no partial-scrape reason when full count met');
  assert(r.videos.every(v => v.tags.length > 0), 'every video has tags');
})();

// ── 5. Per-video failures must NOT kill the loop (root cause of 5/10) ──
await (async () => {
  // Every 3rd asset throws; loop must recover by pulling more cards.
  let n = 0;
  const { fetchCards, fetchDetail } = makeGrid(200, {
    detailBehavior: () => (++n % 3 === 0 ? { throw: 'simulated tab crash' } : {})
  });
  const r = await runScrapeLoop({ videoCount: 10, fetchCards, fetchDetail });
  eq(r.videos.length, 10, 'still reaches 10 despite ~1/3 failures');
  assert(noDuplicates(r.videos), 'no duplicates after retries');
  assert(r.failedCount > 0, 'failures were recorded');
})();

// ── 6. Duplicate URLs in the grid collapse to one asset (Bug 3) ──
await (async () => {
  // Grid keeps returning the SAME 6 assets but via varying URL suffixes.
  const base = [1, 2, 3, 4, 5, 6];
  let call = 0;
  const fetchCards = async () => {
    call++;
    return { cards: base.map(i => ({ title: `C${i}`, detailUrl: url(2000 + i) + `?ref=${call}` })) };
  };
  const fetchDetail = async (u) => ({ assetId: extractAssetId(u), title: `T`, tags: ['x'] });
  const r = await runScrapeLoop({ videoCount: 10, fetchCards, fetchDetail });
  eq(r.videos.length, 6, 'only 6 unique assets despite changing URL params');
  assert(noDuplicates(r.videos), 'duplicate URLs did not create duplicate rows');
  eq(r.exhaustedGrid, true, 'correctly detected the grid is exhausted');
  eq(r.reason, 'no more results available in grid', 'accurate partial reason');
})();

// ── 7. Genuinely fewer results than requested ──────────────────
await (async () => {
  const { fetchCards, fetchDetail } = makeGrid(4); // only 4 assets exist
  const r = await runScrapeLoop({ videoCount: 10, fetchCards, fetchDetail });
  eq(r.videos.length, 4, 'returns the 4 that exist');
  eq(r.exhaustedGrid, true, 'flags exhausted grid');
  assert(r.reason.includes('no more results'), 'reason explains genuinely-fewer');
})();

// ── 8. Zero-tag pages are rejected (data quality) ──────────────
await (async () => {
  // Odd assets return no tags; they must be skipped, not exported empty.
  const { fetchCards, fetchDetail } = makeGrid(200, {
    detailBehavior: (id) => (Number(id) % 2 === 1 ? { tags: [] } : { tags: ['ok'] })
  });
  const r = await runScrapeLoop({ videoCount: 10, fetchCards, fetchDetail });
  eq(r.videos.length, 10, 'still collects 10 tagged videos');
  assert(r.videos.every(v => v.tags.length > 0), 'no empty-tag rows in output');
})();

// ── 9. Stop flag halts promptly ────────────────────────────────
await (async () => {
  const { fetchCards, fetchDetail } = makeGrid(200);
  let count = 0;
  const r = await runScrapeLoop({
    videoCount: 10, fetchCards, fetchDetail,
    shouldStop: () => (++count > 3) // stop after a few progress ticks
  });
  assert(r.videos.length < 10, 'stopped before completing');
  eq(r.reason, 'stopped/paused', 'reports stop reason');
})();

// ── 10. Deadline halts without throwing ────────────────────────
await (async () => {
  // Fake clock that jumps past the deadline immediately after start.
  let t = 0;
  const now = () => { const v = t; t += 100000; return v; };
  const { fetchCards, fetchDetail } = makeGrid(200);
  const r = await runScrapeLoop({ videoCount: 10, fetchCards, fetchDetail, deadlineMs: 1000, now });
  assert(r.deadlineHit || r.videos.length < 10, 'deadline stops the loop');
  assert(r.reason !== null, 'reports a partial reason on deadline');
})();

// ── 11. isTagReadComplete (completion decision) ────────────────
(() => {
  assert(isTagReadComplete(45, 40, 45), 'reaches stated target → complete');
  assert(isTagReadComplete(50, 10, 45), 'exceeds stated target → complete');
  assert(!isTagReadComplete(40, 40, 45), 'below target even if stable → NOT complete');
  assert(!isTagReadComplete(0, 0, null), 'stable count of 0 is NEVER complete (the bug)');
  assert(isTagReadComplete(20, 20, null), 'no target + stable non-zero → complete');
  assert(!isTagReadComplete(20, 10, null), 'no target + still growing → NOT complete');
})();

// A no-op sleep so retry tests run instantly (we assert on convergence,
// not wall-clock timing).
const fastSleep = () => Promise.resolve();

// ── 12. retryUntilComplete converges under SIMULATED SLOW LOAD ──
await (async () => {
  // The tag list lazy-renders: 0 tags on the first read, then it fills in.
  // A single-check implementation would have returned 0/partial; the retry
  // loop must keep going until it reaches the stated total of 45.
  const counts = [0, 12, 30, 45];
  const r = await retryUntilComplete({
    attemptFn: async (n) => counts[n - 1],
    targetCount: 45, maxAttempts: 4, sleep: fastSleep
  });
  eq(r.count, 45, 'eventually reads the full 45 tags');
  eq(r.complete, true, 'marked complete once target met');
  eq(r.attempts, 4, 'took the retries it needed (did not give up early)');
})();

// ── 13. retryUntilComplete: fast page completes on attempt 1 ───
await (async () => {
  const r = await retryUntilComplete({
    attemptFn: async () => 45, targetCount: 45, maxAttempts: 4, sleep: fastSleep
  });
  eq(r.attempts, 1, 'fast page needs only one attempt');
  eq(r.complete, true, 'complete immediately');
})();

// ── 14. retryUntilComplete: no stated total, waits for STABLE ──
await (async () => {
  // Count grows then stabilizes; must confirm stability before accepting.
  const counts = [10, 22, 30, 30];
  const r = await retryUntilComplete({
    attemptFn: async (n) => counts[n - 1],
    targetCount: null, maxAttempts: 4, sleep: fastSleep
  });
  eq(r.count, 30, 'settles on the stable count');
  eq(r.complete, true, 'complete once stable across two reads');
  eq(r.attempts, 4, 'confirmed stability rather than trusting first read');
})();

// ── 15. retryUntilComplete: never reaches target → partial, flagged ──
await (async () => {
  // Genuinely fewer tags than the (misread) target — must NOT hang; must
  // return the best result with complete=false so the caller can flag it.
  const r = await retryUntilComplete({
    attemptFn: async () => 12, targetCount: 45, maxAttempts: 4, sleep: fastSleep
  });
  eq(r.attempts, 4, 'exhausts the attempt budget');
  eq(r.complete, false, 'reports incomplete rather than pretending success');
  eq(r.count, 12, 'still returns the best data it got');
})();

// ── Summary ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(48)}`);
if (failed === 0) {
  console.log(`✅ ALL TESTS PASSED — ${passed} assertions`);
  process.exit(0);
} else {
  console.log(`❌ ${failed} FAILED, ${passed} passed`);
  fails.forEach(f => console.log('   • ' + f));
  process.exit(1);
}
