/**
 * sidepanel.js — Side Panel Controller
 * ══════════════════════════════════════
 *
 * Responsibilities:
 *  • Load / save user settings from chrome.storage.local
 *  • On open: query background for current state (detect paused/running sessions)
 *  • Show "Resume previous session?" banner when a resumable state exists
 *  • Drive the Start / Stop / Pause / Resume / Export button states
 *  • Receive progress events from background.js via chrome.runtime.onMessage
 *  • Update the live log, progress bar, step indicator, results table, status chip
 *  • Collect result data for Excel export
 *
 * This script is intentionally self-contained (no ES imports) so it works
 * as a plain <script> tag in the side panel without a bundler.
 */

'use strict';

// ══════════════════════════════════════════════════════════════
// DOM REFERENCES
// ══════════════════════════════════════════════════════════════
const $ = id => document.getElementById(id);

const statusChip       = $('statusChip');
const resumeBannerSec  = $('resumeBannerSection');
const resumeBanner     = $('resumeBanner');
const resumeBannerTitle= $('resumeBannerTitle');
const resumeBannerSub  = $('resumeBannerSub');
const btnResumeBanner  = $('btnResumeBanner');

const tabSingle        = $('tabSingle');
const tabBulk          = $('tabBulk');
const panelSingle      = $('panelSingle');
const panelBulk        = $('panelBulk');
const inputSingle      = $('inputSingle');
const inputBulk        = $('inputBulk');
const inputMinComp     = $('inputMinComp');
const inputMaxComp     = $('inputMaxComp');
const inputVideoCount  = $('inputVideoCount');

const btnStart         = $('btnStart');
const btnStop          = $('btnStop');
const btnPause         = $('btnPause');
const btnResume        = $('btnResume');
const btnExport        = $('btnExport');

const progressLabel    = $('progressLabel');
const progressBar      = $('progressBar');
const videoProgressHeader = $('videoProgressHeader');
const videoProgressLabel  = $('videoProgressLabel');
const videoProgressPct    = $('videoProgressPct');
const videoProgressWrap   = $('videoProgressWrap');
const videoProgressBar    = $('videoProgressBar');
const cntQualified     = $('cntQualified');
const cntSkipped       = $('cntSkipped');
const cntErrors        = $('cntErrors');
const currentStep      = $('currentStep');
const logInner         = $('logInner');
const resultsEmpty     = $('resultsEmpty');
const resultsTable     = $('resultsTable');
const resultsBody      = $('resultsBody');
const resultCount      = $('resultCount');
const footerStatus     = $('footerStatus');

// ══════════════════════════════════════════════════════════════
// LOCAL STATE
// ══════════════════════════════════════════════════════════════
let currentStatus   = 'idle';   // mirrors background state machine
let collectedResults = [];       // for Excel export
let currentKeyword   = '';       // keyword currently being processed
let totalKeywords    = 0;
let processedCount   = 0;
let qualifiedCount   = 0;
let skippedCount     = 0;
let errorCount       = 0;

// ══════════════════════════════════════════════════════════════
// SETTINGS PERSISTENCE (chrome.storage.local)
// ══════════════════════════════════════════════════════════════
const SETTINGS_KEY = 'adobeStockUserSettings';

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const s = stored[SETTINGS_KEY] || {};
    if (s.mode === 'bulk') setMode('bulk');
    if (s.singleKeyword) inputSingle.value    = s.singleKeyword;
    if (s.bulkKeywords)  inputBulk.value      = s.bulkKeywords;
    if (s.minComp  != null) inputMinComp.value     = s.minComp;
    if (s.maxComp  != null) inputMaxComp.value     = s.maxComp;
    if (s.videoCount != null) inputVideoCount.value = s.videoCount;
  } catch (e) {
    console.warn('[sp] loadSettings failed:', e);
  }
}

async function saveSettings() {
  try {
    await chrome.storage.local.set({
      [SETTINGS_KEY]: {
        mode:          getMode(),
        singleKeyword: inputSingle.value,
        bulkKeywords:  inputBulk.value,
        minComp:       inputMinComp.value,
        maxComp:       inputMaxComp.value,
        videoCount:    inputVideoCount.value
      }
    });
  } catch (e) {
    console.warn('[sp] saveSettings failed:', e);
  }
}

[inputSingle, inputBulk, inputMinComp, inputMaxComp, inputVideoCount].forEach(el => {
  el.addEventListener('change', saveSettings);
  el.addEventListener('blur', saveSettings);
});

// ══════════════════════════════════════════════════════════════
// MODE TOGGLE
// ══════════════════════════════════════════════════════════════
function getMode() {
  return tabBulk.classList.contains('active') ? 'bulk' : 'single';
}

function setMode(mode) {
  const isBulk = mode === 'bulk';
  tabBulk.classList.toggle('active', isBulk);
  tabSingle.classList.toggle('active', !isBulk);
  panelBulk.classList.toggle('active', isBulk);
  panelSingle.classList.toggle('active', !isBulk);
}

tabSingle.addEventListener('click', () => { setMode('single'); saveSettings(); });
tabBulk.addEventListener('click',   () => { setMode('bulk');   saveSettings(); });

// ══════════════════════════════════════════════════════════════
// INPUT VALIDATION & KEYWORD PARSING
// ══════════════════════════════════════════════════════════════
function parseSettings() {
  const mode       = getMode();
  const minComp    = parseInt(inputMinComp.value, 10);
  const maxComp    = parseInt(inputMaxComp.value, 10);
  const videoCount = parseInt(inputVideoCount.value, 10) || 20;

  let keywords = [];
  if (mode === 'single') {
    const kw = inputSingle.value.trim();
    if (kw) keywords = [kw];
  } else {
    keywords = inputBulk.value
      .split('\n')
      .map(k => k.trim())
      .filter(Boolean);
  }

  if (!keywords.length)         return { error: 'Enter at least one keyword.' };
  if (isNaN(minComp))           return { error: 'Enter a valid Min Competition value.' };
  if (isNaN(maxComp))           return { error: 'Enter a valid Max Competition value.' };
  if (minComp > maxComp)        return { error: 'Min Competition must be ≤ Max Competition.' };
  if (videoCount < 1)           return { error: 'Videos per keyword must be ≥ 1.' };

  return { keywords, settings: { minComp, maxComp, videoCount } };
}

// ══════════════════════════════════════════════════════════════
// STATUS CHIP & BUTTON STATES
// ══════════════════════════════════════════════════════════════

/**
 * Apply the UI state for a given machine status.
 * Controls which buttons are enabled and what the status chip shows.
 */
function applyStatus(status) {
  currentStatus = status;

  // Status chip
  const chipClasses = {
    idle:      ['chip-idle',      'Idle'],
    running:   ['chip-running',   'Running'],
    paused:    ['chip-paused',    'Paused'],
    stopped:   ['chip-stopped',   'Stopped'],
    completed: ['chip-completed', 'Done']
  };
  const [chipClass, chipLabel] = chipClasses[status] || ['chip-idle', status];
  statusChip.className = `status-chip ${chipClass}`;
  statusChip.innerHTML = status === 'running'
    ? `<span class="pulse"></span><span>${chipLabel}</span>`
    : `<span>${chipLabel}</span>`;

  // Button enable/disable
  const isIdle      = status === 'idle';
  const isRunning   = status === 'running';
  const isPaused    = status === 'paused';
  const isStopped   = status === 'stopped';
  const isCompleted = status === 'completed';

  btnStart.disabled  = isRunning || isPaused;
  btnStop.disabled   = isIdle || isCompleted;
  btnPause.disabled  = !isRunning;
  btnResume.disabled = !isPaused;

  // Export button: enable when we have results, even partial
  btnExport.disabled = collectedResults.length === 0;

  // Footer hint
  const hints = {
    idle:      'Ready — configure settings and press Start.',
    running:   'Processing keywords…',
    paused:    'Session paused. Press Resume to continue.',
    stopped:   'Session stopped. Download your results.',
    completed: '✓ All keywords processed!'
  };
  footerStatus.textContent = hints[status] || '';

  // Step indicator: clear spinner when not running
  if (!isRunning) {
    setStep('', false);
  }
}

// ══════════════════════════════════════════════════════════════
// PROGRESS DISPLAY HELPERS
// ══════════════════════════════════════════════════════════════

function setStep(text, showSpinner = true) {
  if (!text) {
    currentStep.innerHTML = `<span style="color:var(--text-dim)">No active task.</span>`;
    return;
  }
  const spinnerHtml = showSpinner ? '<span class="step-spinner"></span>' : '';
  currentStep.innerHTML = `${spinnerHtml}<span>${escHtml(text)}</span>`;
}

function updateProgress(processed, total, q, s, e) {
  processedCount = processed ?? processedCount;
  totalKeywords  = total     ?? totalKeywords;
  qualifiedCount = q ?? qualifiedCount;
  skippedCount   = s ?? skippedCount;
  errorCount     = e ?? errorCount;

  const pct = totalKeywords > 0 ? (processedCount / totalKeywords) * 100 : 0;
  progressBar.style.width = `${pct}%`;
  progressLabel.textContent =
    `${processedCount} / ${totalKeywords} keywords (${Math.round(pct)}%)`;
  cntQualified.textContent  = qualifiedCount;
  cntSkipped.textContent    = skippedCount;
  cntErrors.textContent     = errorCount;
}

function updateVideoProgress(scraped, total) {
  if (!total || total <= 0) {
    videoProgressHeader.style.display = 'none';
    videoProgressWrap.style.display = 'none';
    return;
  }
  videoProgressHeader.style.display = 'flex';
  videoProgressWrap.style.display = 'block';

  const pct = Math.min((scraped / total) * 100, 100);
  videoProgressBar.style.width = `${pct}%`;
  videoProgressLabel.textContent = `${scraped} / ${total} videos`;
  videoProgressPct.textContent = `${Math.round(pct)}%`;
}

// ══════════════════════════════════════════════════════════════
// LOG
// ══════════════════════════════════════════════════════════════

function now() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0'))
    .join(':');
}

function log(msg, type = 'normal') {
  const line = document.createElement('div');
  line.className = 'log-line';
  line.innerHTML =
    `<span class="log-time">${now()}</span>` +
    `<span class="log-msg log-${type}">${escHtml(msg)}</span>`;
  logInner.prepend(line);
}

function clearLog() { logInner.innerHTML = ''; }

// ══════════════════════════════════════════════════════════════
// RESULTS TABLE
// ══════════════════════════════════════════════════════════════

function addResultRow(result) {
  resultsEmpty.style.display = 'none';
  resultsTable.style.display = 'table';

  const rowClass = result.status === 'skipped' ? 'row-skipped'
    : result.status === 'error' ? 'row-error' : '';

  const badgeClass = result.status === 'qualified' ? 'badge-qualified'
    : result.status === 'error' ? 'badge-error' : 'badge-skipped';

  const badgeLabel = result.status.charAt(0).toUpperCase() + result.status.slice(1);

  const tr = document.createElement('tr');
  tr.className = rowClass;
  tr.innerHTML = `
    <td style="max-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
        title="${escHtml(result.keyword)}">${escHtml(result.keyword)}</td>
    <td><span class="status-badge ${badgeClass}">${escHtml(badgeLabel)}</span></td>
    <td>${result.competitionCount != null ? Number(result.competitionCount).toLocaleString() : '—'}</td>
    <td>${result.videos?.length ?? 0}</td>
  `;
  resultsBody.appendChild(tr);

  resultCount.textContent = `${resultsBody.rows.length} processed`;
}

function clearResultsTable() {
  resultsBody.innerHTML = '';
  resultsEmpty.style.display = 'block';
  resultsTable.style.display = 'none';
  resultCount.textContent = '0 processed';
}

// ══════════════════════════════════════════════════════════════
// EXCEL WORKBOOK HELPERS
// All SheetJS (XLSX) logic lives HERE — never in background.js.
// XLSX is available globally because sidepanel.html loads xlsx.min.js
// via a <script> tag before this file.
// ══════════════════════════════════════════════════════════════

/**
 * Sanitize a string to a valid Excel sheet name.
 * Rules: max 31 chars, no characters: \ / ? * [ ] :
 */
function sanitizeSheetName(name) {
  return String(name).replace(/[\\/\?\*\[\]\:]/g, '_').substring(0, 31);
}

/**
 * Build data rows array for a single keyword result entry.
 * Header row + one row per video.
 * @param {object} result
 * @returns {Array[]}
 */
function buildKeywordRows(result) {
  const rows = [['Keyword', 'Video Title', 'Tags']];
  if (!result.videos || result.videos.length === 0) {
    rows.push([result.keyword, '(no videos scraped)', '']);
  } else {
    result.videos.forEach(v => {
      rows.push([
        result.keyword,
        v.title  || '(no title)',
        Array.isArray(v.tags) ? v.tags.join(', ') : ''
      ]);
    });
  }
  return rows;
}

/**
 * Build a full SheetJS Workbook from the collected results.
 *
 * Structure:
 *   - Always: "Summary" sheet (all keywords, status, count, reason, video count)
 *   - Single qualified keyword: one "Results" sheet
 *   - Multiple qualified keywords: one sheet per keyword (name = sanitized keyword)
 *
 * @param {Array} results — array of result entries from background
 * @returns {object} SheetJS Workbook
 */
function buildWorkbook(results) {
  // Guard: XLSX must be available (loaded via <script src="lib/xlsx.min.js">)
  if (typeof XLSX === 'undefined') {
    throw new Error(
      'SheetJS (XLSX) is not loaded. ' +
      'Ensure <script src="lib/xlsx.min.js"> appears before sidepanel.js in sidepanel.html.'
    );
  }

  const wb = XLSX.utils.book_new();

  // ── Summary Sheet ────────────────────────────────────────────────
  const summaryRows = [
    ['Keyword', 'Status', 'Competition Count', 'Skip / Error Reason', 'Videos Scraped']
  ];
  results.forEach(r => {
    summaryRows.push([
      r.keyword,
      (r.status || 'unknown').charAt(0).toUpperCase() + (r.status || '').slice(1),
      r.competitionCount ?? 'N/A',
      r.skipReason || '',
      r.videos?.length ?? 0
    ]);
  });
  const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
  wsSummary['!cols'] = [
    { wch: 40 }, { wch: 12 }, { wch: 20 }, { wch: 35 }, { wch: 15 }
  ];
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

  // ── Per-keyword Sheets ───────────────────────────────────────────
  const qualified = results.filter(r => r.status === 'qualified');

  if (qualified.length === 0) {
    // No qualified keywords — placeholder sheet so workbook isn't empty
    const wsEmpty = XLSX.utils.aoa_to_sheet([
      ['No qualified keywords found.'],
      ['Tip: adjust your Min/Max Competition range and try again.']
    ]);
    XLSX.utils.book_append_sheet(wb, wsEmpty, 'Results');

  } else if (qualified.length === 1) {
    // Exactly one qualified keyword → single "Results" sheet
    const ws = XLSX.utils.aoa_to_sheet(buildKeywordRows(qualified[0]));
    ws['!cols'] = [{ wch: 35 }, { wch: 55 }, { wch: 100 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Results');

  } else {
    // Multiple qualified keywords → one sheet per keyword
    const usedNames = new Map(); // track duplicates
    qualified.forEach(r => {
      const base = sanitizeSheetName(r.keyword);
      let   sheetName = base;

      if (usedNames.has(base)) {
        const n = usedNames.get(base) + 1;
        usedNames.set(base, n);
        sheetName = sanitizeSheetName(`${base.substring(0, 28)}_${n}`);
      } else {
        usedNames.set(base, 1);
      }

      const ws = XLSX.utils.aoa_to_sheet(buildKeywordRows(r));
      ws['!cols'] = [{ wch: 35 }, { wch: 55 }, { wch: 100 }];
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    });
  }

  return wb;
}

/**
 * Build the workbook and trigger a Blob download via a temporary <a> element.
 * This runs entirely in the side panel DOM — no service worker involvement.
 * @param {Array} results
 */
function downloadExcelLocally(results) {
  // 1. Build workbook (throws if XLSX missing or data is malformed)
  const wb = buildWorkbook(results);

  // 2. Serialise to a binary array buffer
  const wbArray = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });

  // 3. Wrap in a Blob with the correct MIME type
  const blob = new Blob([wbArray], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });

  // 4. Create a temporary object URL and trigger the download
  const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `adobe-stock-keyword-research-${ts}.xlsx`;
  const url      = URL.createObjectURL(blob);

  const anchor      = document.createElement('a');
  anchor.href       = url;
  anchor.download   = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();

  // 5. Clean up the temporary element and object URL
  setTimeout(() => {
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, 1000);

  return filename;
}

// ══════════════════════════════════════════════════════════════
// BUTTON ACTIONS
// ══════════════════════════════════════════════════════════════

btnStart.addEventListener('click', async () => {
  const parsed = parseSettings();
  if (parsed.error) {
    log(`❌ ${parsed.error}`, 'error');
    return;
  }

  // Reset progress
  collectedResults = [];
  totalKeywords    = parsed.keywords.length;
  processedCount   = 0;
  qualifiedCount   = 0;
  skippedCount     = 0;
  errorCount       = 0;
  clearLog();
  clearResultsTable();
  updateProgress(0, totalKeywords, 0, 0, 0);
  updateVideoProgress(0, 0);
  setStep('Initializing…');
  hideBanner();
  applyStatus('running');

  await saveSettings();

  try {
    const resp = await chromeMsg({ action: 'start', payload: parsed });
    if (resp && !resp.ok) {
      log(`❌ Start failed: ${resp.reason}`, 'error');
      applyStatus('idle');
    } else {
      log(`▶ Started — processing ${totalKeywords} keyword(s)`, 'info');
    }
  } catch (e) {
    log(`❌ Could not reach background: ${e.message}`, 'error');
    applyStatus('idle');
  }
});

btnStop.addEventListener('click', async () => {
  try {
    await chromeMsg({ action: 'stop' });
    log('⛔ Stop requested.', 'error');
    setStep('Stopping…', false);
  } catch (e) {
    log(`❌ Stop failed: ${e.message}`, 'error');
  }
});

btnPause.addEventListener('click', async () => {
  try {
    await chromeMsg({ action: 'pause' });
    log('⏸ Pause requested — will pause after current step.', 'skip');
  } catch (e) {
    log(`❌ Pause failed: ${e.message}`, 'error');
  }
});

btnResume.addEventListener('click', () => startResume());
btnResumeBanner.addEventListener('click', () => startResume());

async function startResume() {
  hideBanner();
  setStep('Resuming…');
  applyStatus('running');
  try {
    const resp = await chromeMsg({ action: 'resume' });
    if (resp && !resp.ok) {
      log(`❌ Resume failed: ${resp.reason}`, 'error');
      applyStatus('paused');
    } else {
      log('▶▶ Resumed from saved position.', 'info');
    }
  } catch (e) {
    log(`❌ Resume error: ${e.message}`, 'error');
    applyStatus('paused');
  }
}

btnExport.addEventListener('click', () => {
  if (!collectedResults.length) {
    log('No results to export yet.', 'error');
    return;
  }

  // Guard: XLSX must be loaded in this page context
  if (typeof XLSX === 'undefined') {
    log('❌ SheetJS library not loaded — check that lib/xlsx.min.js is present and referenced in sidepanel.html.', 'error');
    return;
  }

  // Disable button immediately to prevent double-clicks
  btnExport.disabled = true;
  btnExport.innerHTML = '<span class="step-spinner" style="width:12px;height:12px;"></span> Generating…';
  log('📊 Generating Excel workbook…', 'info');

  // Use setTimeout(0) to let the DOM repaint the button state before the
  // synchronous XLSX.write() call blocks the thread.
  setTimeout(() => {
    try {
      const filename = downloadExcelLocally(collectedResults);
      log(`✅ Excel downloaded: ${filename}`, 'ok');
    } catch (e) {
      console.error('[sp] Excel export error:', e);
      log(`❌ Export failed: ${e.message}`, 'error');
    } finally {
      // Reset button regardless of success/failure
      btnExport.disabled = collectedResults.length === 0;
      btnExport.innerHTML = '<span>⬇</span> Download Excel Report';
    }
  }, 0);
});

// ══════════════════════════════════════════════════════════════
// MESSAGE HANDLER — receives events from background.js
// ══════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg?.event) return;

  switch (msg.event) {

    // ── Run lifecycle ─────────────────────────────────────────
    case 'run_started':
      totalKeywords = msg.total ?? totalKeywords;
      if (msg.resuming) log(`↩ Resuming from keyword ${msg.currentIndex + 1}`, 'info');
      updateProgress(msg.currentIndex, msg.total, qualifiedCount, skippedCount, errorCount);
      break;

    case 'run_paused':
      applyStatus('paused');
      updateProgress(msg.currentIndex, msg.total);
      log(`⏸ Paused at keyword ${msg.currentIndex}/${msg.total}.`, 'skip');
      break;

    case 'run_stopped':
      applyStatus('stopped');
      if (msg.results) {
        collectedResults = msg.results;
        btnExport.disabled = collectedResults.length === 0;
      }
      log(`⛔ Stopped. ${collectedResults.length} keyword(s) collected.`, 'error');
      if (collectedResults.length > 0) {
        log('📁 You can still download partial results.', 'info');
      }
      updateVideoProgress(0, 0);
      break;

    case 'run_completed': {
      applyStatus('completed');
      if (msg.results) {
        collectedResults = msg.results;
        btnExport.disabled = false;
      }
      progressBar.style.width = '100%';
      updateProgress(totalKeywords, totalKeywords, msg.qualified, msg.skipped, msg.errors);
      log(`🎉 Done! ${msg.qualified} qualified, ${msg.skipped} skipped, ${msg.errors} errors.`, 'ok');
      log(`📹 Total videos scraped: ${msg.totalScraped}`, 'ok');
      log('📁 Press "Download Excel Report" to export.', 'info');
      updateVideoProgress(0, 0);
      break;
    }

    case 'run_error':
      log(`❌ Run error: ${msg.error}`, 'error');
      applyStatus('stopped');
      break;

    // ── Per-keyword events ────────────────────────────────────
    case 'keyword_start':
      currentKeyword = msg.keyword;
      setStep(`Searching: "${msg.keyword}" (${msg.index + 1}/${msg.total})…`);
      log(`🔍 [${msg.index + 1}/${msg.total}] Processing: "${msg.keyword}"`, 'info');
      break;

    case 'competition_found':
      log(`📊 Competition: ${Number(msg.count).toLocaleString()} results for "${msg.keyword}"`, 'normal');
      break;

    case 'keyword_qualified': {
      qualifiedCount++;
      const processed = processedCount; // not incremented yet
      updateProgress(processed, totalKeywords, qualifiedCount, skippedCount, errorCount);
      log(`✅ QUALIFIED: "${msg.keyword}" — ${Number(msg.count).toLocaleString()} results`, 'ok');
      break;
    }

    case 'keyword_skipped': {
      skippedCount++;
      updateProgress(processedCount, totalKeywords, qualifiedCount, skippedCount, errorCount);
      log(`⏭ SKIPPED: "${msg.keyword}" — ${msg.reason} (${Number(msg.count).toLocaleString()})`, 'skip');
      break;
    }

    case 'keyword_error':
      errorCount++;
      updateProgress(processedCount, totalKeywords, qualifiedCount, skippedCount, errorCount);
      log(`❌ ERROR: "${msg.keyword}" — ${msg.error}`, 'error');
      break;

    case 'keyword_done': {
      processedCount++;
      const r = msg.result;
      if (r) {
        collectedResults.push(r);
        addResultRow(r);
        btnExport.disabled = false;
      }
      updateProgress(processedCount, msg.total, qualifiedCount, skippedCount, errorCount);
      updateVideoProgress(0, 0);
      break;
    }

    // ── Step / scrape progress ────────────────────────────────
    case 'step': {
      const kw = msg.keyword || currentKeyword;
      setStep(kw ? `"${kw}" — ${msg.step}` : msg.step);
      break;
    }

    case 'scrape_progress': {
      const stepText = msg.step || `Scraping video ${msg.scraped}/${msg.total}…`;
      const kw = msg.keyword || currentKeyword;
      setStep(kw ? `"${kw}" — ${stepText}` : stepText);
      updateVideoProgress(msg.scraped, msg.total);
      break;
    }

    // ── Generic log ───────────────────────────────────────────
    case 'log':
      log(msg.message, msg.type || 'muted');
      break;

    // Note: 'download_ready' and 'download_error' events are no longer sent
    // from background.js. Export is handled entirely within sidepanel.js
    // using downloadExcelLocally() — see the btnExport click handler above.
  }
});

// ══════════════════════════════════════════════════════════════
// RESUME BANNER HELPERS
// ══════════════════════════════════════════════════════════════

function showBanner(state) {
  const remaining = state.keywords.length - state.currentIndex;
  resumeBannerTitle.textContent =
    state.status === 'paused' ? 'Session paused' : 'Previous session found';
  resumeBannerSub.textContent =
    `${state.currentIndex} done, ${remaining} remaining — click Resume to continue.`;
  resumeBannerSec.style.display = 'block';
}

function hideBanner() {
  resumeBannerSec.style.display = 'none';
}

// ══════════════════════════════════════════════════════════════
// CHROME MESSAGING WRAPPER (resolves on response)
// ══════════════════════════════════════════════════════════════

function chromeMsg(msg) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(resp);
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

// ══════════════════════════════════════════════════════════════
// HTML ESCAPING
// ══════════════════════════════════════════════════════════════

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// ══════════════════════════════════════════════════════════════
// INITIALIZATION — runs when side panel opens
// ══════════════════════════════════════════════════════════════

async function init() {
  // 1. Load user settings (form values)
  await loadSettings();

  // 2. Query background for current automation state
  try {
    const resp = await chromeMsg({ action: 'get_state' });
    if (!resp?.ok) return;

    const state = resp.state;
    if (!state) return;

    // Rehydrate counters from persisted results
    if (Array.isArray(state.results) && state.results.length > 0) {
      collectedResults = state.results;
      processedCount   = state.currentIndex || 0;
      qualifiedCount   = state.results.filter(r => r.status === 'qualified').length;
      skippedCount     = state.results.filter(r => r.status === 'skipped').length;
      errorCount       = state.results.filter(r => r.status === 'error').length;
      totalKeywords    = state.keywords.length;

      // Render results table from persisted data
      state.results.forEach(r => addResultRow(r));
      updateProgress(processedCount, totalKeywords, qualifiedCount, skippedCount, errorCount);
      btnExport.disabled = false;
    }

    // Apply UI status based on background state
    applyStatus(state.status || 'idle');

    // Show resume banner if session is resumable
    if (
      (state.status === 'paused' || state.status === 'stopped') &&
      state.keywords.length > 0 &&
      state.currentIndex < state.keywords.length
    ) {
      showBanner(state);
      if (state.status === 'paused') {
        log('⏸ Reconnected to a paused session — press Resume to continue.', 'skip');
      } else if (state.status === 'stopped') {
        log('⛔ Previous session was stopped — results available for export.', 'error');
      }
    } else if (state.status === 'running') {
      log('ℹ Reconnected to a running session.', 'info');
    }

  } catch (e) {
    // Background not yet ready — no issue, user will click Start manually
    console.warn('[sp] Could not fetch background state on init:', e.message);
  }
}

init();
