/**
 * utils/stateManager.js — Persistent Automation State Manager
 * ════════════════════════════════════════════════════════════
 *
 * Manages the complete automation state using chrome.storage.local
 * so that state survives:
 *  - Side panel reloads / closes
 *  - Browser restarts (within the same Chrome profile)
 *  - Extension updates (as long as the storage schema is compatible)
 *
 * STATE SCHEMA
 * ─────────────
 * {
 *   status:        'idle' | 'running' | 'paused' | 'stopped' | 'completed',
 *   keywords:      string[],          // full keyword queue
 *   currentIndex:  number,            // next keyword to process
 *   settings: {
 *     minComp:     number,
 *     maxComp:     number,
 *     videoCount:  number
 *   },
 *   results: [                        // per-keyword outcome
 *     {
 *       keyword:          string,
 *       status:           'qualified' | 'skipped' | 'error',
 *       competitionCount: number | null,
 *       skipReason:       string,
 *       videos: [
 *         { title: string, tags: string[] }
 *       ]
 *     }
 *   ],
 *   startedAt:     number,            // timestamp (ms)
 *   updatedAt:     number             // timestamp (ms)
 * }
 *
 * This module is used directly by background.js (ES module import).
 * It is NOT a content script — do not inject into pages.
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const STATE_KEY = 'adobeStockAutomationState';
const SETTINGS_KEY = 'adobeStockUserSettings';

// ──────────────────────────────────────────────────────────────
// Default / empty state factory
// ──────────────────────────────────────────────────────────────
function createEmptyState() {
  return {
    status:       'idle',
    keywords:     [],
    currentIndex: 0,
    settings: {
      minComp:    0,
      maxComp:    Infinity,
      videoCount: 20
    },
    results:      [],
    startedAt:    null,
    updatedAt:    null
  };
}

// ──────────────────────────────────────────────────────────────
// Read / Write helpers (chrome.storage.local)
// ──────────────────────────────────────────────────────────────

/** Load the full automation state. Returns empty state if none saved. */
async function loadState() {
  try {
    const stored = await chrome.storage.local.get(STATE_KEY);
    const s = stored[STATE_KEY];
    if (!s || typeof s !== 'object') return createEmptyState();
    // Merge with defaults to handle schema evolution
    return { ...createEmptyState(), ...s };
  } catch (e) {
    console.error('[stateManager] loadState error:', e);
    return createEmptyState();
  }
}

/** Persist the full automation state. Merges with existing. */
async function saveState(updates) {
  try {
    const current = await loadState();
    const next = {
      ...current,
      ...updates,
      updatedAt: Date.now()
    };
    await chrome.storage.local.set({ [STATE_KEY]: next });
    return next;
  } catch (e) {
    console.error('[stateManager] saveState error:', e);
    throw e;
  }
}

/** Clear all automation state (reset to idle). */
async function clearState() {
  try {
    const empty = createEmptyState();
    await chrome.storage.local.set({ [STATE_KEY]: empty });
    return empty;
  } catch (e) {
    console.error('[stateManager] clearState error:', e);
    throw e;
  }
}

// ──────────────────────────────────────────────────────────────
// User Settings (separate key so settings persist independently
// of automation runs and survive clearState calls)
// ──────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  mode:          'single',
  singleKeyword: '',
  bulkKeywords:  '',
  minComp:       10000,
  maxComp:       15000,
  videoCount:    20
};

/** Load persisted user settings (UI form values). */
async function loadUserSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
  } catch (e) {
    console.error('[stateManager] loadUserSettings error:', e);
    return { ...DEFAULT_SETTINGS };
  }
}

/** Save user settings from the UI form. */
async function saveUserSettings(settings) {
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, ...settings } });
  } catch (e) {
    console.error('[stateManager] saveUserSettings error:', e);
  }
}

// ──────────────────────────────────────────────────────────────
// Convenience state transition helpers
// ──────────────────────────────────────────────────────────────

/** Initialize a brand-new run. */
async function initRun({ keywords, settings }) {
  return saveState({
    status:       'running',
    keywords,
    currentIndex: 0,
    settings,
    results:      [],
    startedAt:    Date.now()
  });
}

/** Advance to the next keyword (called after each keyword finishes). */
async function advanceKeyword(resultEntry) {
  const current = await loadState();
  const results = [...current.results, resultEntry];
  return saveState({
    results,
    currentIndex: current.currentIndex + 1
  });
}

/** Mark run as paused at current index. */
async function pauseRun() {
  return saveState({ status: 'paused' });
}

/** Resume a paused run. */
async function resumeRun() {
  return saveState({ status: 'running' });
}

/** Mark run as stopped (retains results for export). */
async function stopRun() {
  return saveState({ status: 'stopped' });
}

/** Mark run as completed. */
async function completeRun() {
  return saveState({ status: 'completed' });
}

/** Check if there is a resumable session (paused or mid-stopped). */
async function hasResumableSession() {
  const s = await loadState();
  return (
    (s.status === 'paused' || s.status === 'stopped') &&
    s.keywords.length > 0 &&
    s.currentIndex < s.keywords.length
  );
}

// ──────────────────────────────────────────────────────────────
// Exports (ES module)
// ──────────────────────────────────────────────────────────────
export {
  createEmptyState,
  loadState,
  saveState,
  clearState,
  loadUserSettings,
  saveUserSettings,
  initRun,
  advanceKeyword,
  pauseRun,
  resumeRun,
  stopRun,
  completeRun,
  hasResumableSession
};
