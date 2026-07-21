/**
 * utils/excelExport.js — SheetJS Workbook Builder
 * ══════════════════════════════════════════════════
 *
 * Reference implementation / auxiliary module.
 * The primary export logic is embedded inline in background.js
 * (required because service workers use importScripts, not ES imports).
 *
 * This module is a clean, documented reference for the workbook
 * structure. It can also be used in popup or options pages if needed.
 *
 * DATA SCHEMA EXPECTED
 * ─────────────────────
 * {
 *   results: [
 *     {
 *       keyword:          string,
 *       status:           'qualified' | 'skipped' | 'error',
 *       competitionCount: number | null,
 *       skipReason:       string,
 *       videos: [
 *         { title: string, tags: string[] }
 *       ]
 *     }
 *   ]
 * }
 */

'use strict';

/**
 * Sanitize a string to be a valid Excel sheet name.
 * Rules: max 31 chars, no backslash / ? * [ ] :
 */
function sanitizeSheetName(name) {
  return String(name).replace(/[\\\/\?\*\[\]\:]/g, '_').substring(0, 31);
}

/**
 * Build a complete SheetJS Workbook object from the result data.
 * @param {object} data  - { results: [...] }
 * @param {object} XLSX  - SheetJS library reference
 * @returns {object} SheetJS Workbook
 */
function buildWorkbook(data, XLSX) {
  const { results } = data;
  const wb = XLSX.utils.book_new();

  // ── 1. Summary Sheet ────────────────────────────────────────────
  // Always included — lists every keyword with its outcome.
  const summaryData = [
    ['Keyword', 'Status', 'Competition Count', 'Skip / Error Reason', 'Videos Scraped']
  ];

  results.forEach(r => {
    summaryData.push([
      r.keyword,
      r.status.charAt(0).toUpperCase() + r.status.slice(1),
      r.competitionCount ?? 'N/A',
      r.skipReason || '',
      r.videos?.length ?? 0
    ]);
  });

  const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
  wsSummary['!cols'] = [
    { wch: 40 }, { wch: 12 }, { wch: 20 }, { wch: 35 }, { wch: 15 }
  ];
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

  // ── 2. Per-keyword Sheets ────────────────────────────────────────
  const qualified = results.filter(r => r.status === 'qualified');

  if (qualified.length === 0) {
    const wsEmpty = XLSX.utils.aoa_to_sheet([
      ['No qualified keywords were found.'],
      ['Tip: Adjust your Min/Max Competition range and try again.']
    ]);
    XLSX.utils.book_append_sheet(wb, wsEmpty, 'Results');
    return wb;
  }

  if (qualified.length === 1) {
    // Single sheet named "Results"
    const r   = qualified[0];
    const rows = buildKeywordRows(r);
    const ws  = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 35 }, { wch: 55 }, { wch: 100 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Results');
  } else {
    // One sheet per qualified keyword
    const usedNames = new Map();
    qualified.forEach(r => {
      const base = sanitizeSheetName(r.keyword);
      let name   = base;

      if (usedNames.has(base)) {
        const n = usedNames.get(base) + 1;
        usedNames.set(base, n);
        // Shorten base to fit suffix within 31 chars
        name = sanitizeSheetName(`${base.substring(0, 28)}_${n}`);
      } else {
        usedNames.set(base, 1);
      }

      const rows = buildKeywordRows(r);
      const ws   = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = [{ wch: 35 }, { wch: 55 }, { wch: 100 }];
      XLSX.utils.book_append_sheet(wb, ws, name);
    });
  }

  return wb;
}

/**
 * Build the data rows array for a single keyword result.
 * @param {object} result
 * @returns {Array[]}
 */
function buildKeywordRows(result) {
  const rows = [['Keyword', 'Video Title', 'Tags']];

  if (!result.videos || result.videos.length === 0) {
    rows.push([result.keyword, '(no videos scraped)', '']);
    return rows;
  }

  result.videos.forEach(v => {
    rows.push([
      result.keyword,
      v.title   || '(no title)',
      Array.isArray(v.tags) ? v.tags.join(', ') : ''
    ]);
  });

  return rows;
}

/**
 * Generate the workbook as a base64-encoded .xlsx string.
 * Compatible with chrome.downloads.download via data URL.
 */
function generateBase64(data, XLSX) {
  const wb = buildWorkbook(data, XLSX);
  return XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
}

/**
 * Generate the workbook as a binary Blob.
 * Useful for <a download> trigger in popup/options pages.
 */
function generateBlob(data, XLSX) {
  const wb    = buildWorkbook(data, XLSX);
  const array = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([array], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
}

// Expose globally for non-module contexts
if (typeof window !== 'undefined') {
  window.AdobeStockExport = {
    buildWorkbook,
    buildKeywordRows,
    generateBase64,
    generateBlob,
    sanitizeSheetName
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    buildWorkbook, buildKeywordRows, generateBase64, generateBlob, sanitizeSheetName
  };
}
