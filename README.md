# Adobe Stock Keyword Research Tool v2
### Chrome Extension (Manifest V3) — Side Panel Edition

Automates keyword competition research and video data scraping on **Adobe Stock** (`stock.adobe.com`) — now with a persistent **Side Panel UI**, full **Pause / Resume** support, state persistence across browser restarts, and live progress tracking.

---

## 🚀 Setup

### 1. Install the Extension

1. Clone or download this repository.
2. Open Chrome → navigate to **`chrome://extensions`**
3. Enable **Developer Mode** (toggle, top-right corner).
4. Click **"Load unpacked"**.
5. Select the **`Adobe Extension`** folder (the one containing `manifest.json`).
6. The extension icon (red "AS") appears in your Chrome toolbar.

### 2. Open the Side Panel

Click the **"AS" extension icon** in the toolbar. Chrome will open the Side Panel on the right side of your browser window.

The side panel stays open as you navigate, unlike a popup which closes on every click.

---

## ⚙️ Configuration

| Setting | Description | Default |
|---|---|---|
| **Single Keyword** | Research one keyword | — |
| **Bulk Keywords** | One keyword per line, processed sequentially | — |
| **Min Competition** | Minimum video result count — keywords below are skipped | 10,000 |
| **Max Competition** | Maximum video result count — keywords above are skipped | 15,000 |
| **Videos / Keyword** | How many videos to scrape per qualifying keyword | 20 |

All settings are auto-saved to `chrome.storage.local` and remembered across sessions.

---

## ▶ Running a Research Session

### Single Keyword Mode
1. Select **Single Keyword** tab.
2. Type your keyword (e.g. `aerial drone city sunset`).
3. Set Min/Max Competition range.
4. Set Videos per keyword.
5. Press **▶ Start**.

### Bulk Mode
1. Select **Bulk Keywords** tab.
2. Paste keywords, one per line.
3. Configure settings.
4. Press **▶ Start** — keywords are processed sequentially, failures and skips never halt the batch.

---

## ⏸ Start / Stop / Pause / Resume

| Button | Behavior |
|---|---|
| **▶ Start** | Begins the keyword queue from index 0 (or resumes if session is restored). Disabled while running or paused. |
| **◼ Stop** | Halts the queue after the current step. Retains all results collected so far for export. |
| **⏸ Pause** | Pauses after the current keyword finishes (doesn't interrupt mid-scrape). Saves position to `chrome.storage`. |
| **▶▶ Resume** | Continues from exactly where paused. Works even after closing and reopening the browser. |

### Session Persistence / Resume After Restart

If the browser is closed mid-run (paused or otherwise), opening the side panel again will:
- Detect the incomplete session from `chrome.storage.local`.
- Show a **yellow resume banner** at the top of the panel.
- Click **▶ Resume** in the banner to continue from the last saved keyword index.

---

## 📊 Automation Flow (Mandatory Order)

For every keyword:

```
1. Navigate to filtered URL:
   https://stock.adobe.com/search?k=<keyword>
                                 &filters[content_type:video]=1
                                 &order=nb_downloads
   (Applies "Videos" filter + "Most Downloaded" sort in ONE navigation — no separate UI click needed)

2. Verify URL filters were applied (self-corrects if Adobe Stock strips params).

3. Read competition count from the filtered results page.
   ✓ This count reflects VIDEO results only, sorted by most downloaded.

4. Compare count against Min/Max range.
   → Below Min or above Max: SKIP, log reason, next keyword.
   → Within range: QUALIFIED → proceed to scraping.

5. Scroll results grid to lazy-load ≥ N video cards.

6. Collect title + detail page URL for top N videos.

7. For each video: fetch detail page → extract full tag list.
   • Strategy A: fetch() + DOMParser (fast, no extra tab)
   • Strategy B: hidden Chrome tab (JS-rendered fallback)
   • Randomized 800–2000ms delay between each fetch.

8. Store {keyword, competitionCount, status, videos:[{title, tags}]}.

9. Move to next keyword.
```

> ⚠️ **The filter step always happens BEFORE the competition count is read.** The count you see reflects video-only results — not all content types.

---

## 📥 Exporting Results

Once any keyword has been processed (even from a partially stopped run):

1. Click **⬇ Download Excel Report**.
2. Chrome downloads: `adobe-stock-keyword-research-<timestamp>.xlsx`

### Excel File Structure

| Sheet | Contents |
|---|---|
| **Summary** | All keywords — status, competition count, skip reason, videos scraped |
| **Results** *(single keyword)* | Keyword \| Video Title \| Tags (comma-joined) |
| **\<keyword\>** *(bulk mode)* | One sheet per qualified keyword, same columns |

Sheet names are sanitized (max 31 chars, no illegal Excel characters). Duplicate names get `_2`, `_3` suffixes.

---

## 🛠 Updating Selectors (When Adobe Stock Changes Their UI)

All CSS selectors are in **one file**:

👉 [`config/selectors.js`](config/selectors.js)

### How to Find a Replacement Selector

1. Open Adobe Stock in Chrome.
2. Right-click the broken element (e.g. the result count number) → **Inspect**.
3. In DevTools Elements panel, look for:
   - A `data-*` attribute (most stable, e.g. `data-cy="result-count"`)
   - A descriptive BEM class name (e.g. `search-filter-bar__total-count`)
4. Add it as the **first entry** in the relevant array in `config/selectors.js`.
5. Reload the extension at `chrome://extensions` → click the 🔄 refresh icon.

### Key Selectors to Know

| Selector Name | What it Targets |
|---|---|
| `resultCount[]` | The "12,345 results" count element |
| `resultCard[]` | Each video card/thumbnail in the grid |
| `resultCardLink[]` | The `<a>` link to the asset detail page |
| `detailTagsContainer[]` | Container of keyword/tag links on detail page |
| `detailTagItem[]` | Individual tag `<a>` elements |
| `url.videoFilter` | URL param for video content type filter |
| `url.sortMostDownloaded` | URL param for "Most Downloaded" sort |

---

## 📁 File Structure

```
Adobe Extension/
├── manifest.json              ← MV3 config — sidePanel, permissions
├── sidepanel.html             ← Side panel UI
├── sidepanel.css              ← Side panel styles (dark theme)
├── sidepanel.js               ← Side panel controller
├── background.js              ← Service worker + state machine + orchestrator
├── content.js                 ← Injected into Adobe Stock — DOM scraper
├── config/
│   └── selectors.js           ← ⭐ ALL selectors here — edit to fix breakage
├── utils/
│   ├── excelExport.js         ← SheetJS workbook builder
│   └── stateManager.js        ← chrome.storage state persistence
├── lib/
│   └── xlsx.min.js            ← SheetJS v0.18.5 (bundled, no CDN)
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## ⚠️ Known Limitations

### Selector Fragility
Adobe Stock frequently updates their React-based frontend. CSS class names and element structures change. If the extension stops working, update `config/selectors.js`. The selectors are ordered by stability (data-* first, broad fallbacks last).

### Rate Limiting & Bot Detection
The extension adds randomized delays (800–2,000ms) between detail page requests. However, Adobe Stock may still detect automated traffic, especially for large batches. Signs of rate-limiting:
- Empty tag lists (`tags: []`)
- 429 HTTP responses in the DevTools Network tab
- CAPTCHAs appearing in the working tab

**Mitigation:** Process fewer keywords per session, use smaller video counts, ensure you are logged into Adobe Stock before running.

### Adobe Stock Terms of Service
This tool is designed for personal research and productivity. Use it responsibly and in accordance with [Adobe Stock's Terms of Use](https://stock.adobe.com/license-terms). Do not use it for large-scale automated data harvesting.

### Service Worker Lifetime (MV3)
Chrome's MV3 service workers can be terminated after ~30 seconds of inactivity. The extension handles this by:
- Persisting all state to `chrome.storage.local` after every keyword.
- Rehydrating state on service worker restart.
- Showing the resume banner in the side panel if state is detected.

### Tag Availability
Tags are **not** shown in the search results grid — they require visiting each video's individual detail page. If detail pages require interactive login or return bot-detection challenges, tags will be empty for those videos.

### Login State
The extension works with both logged-in and logged-out Adobe Stock sessions, but some features (higher result limits, richer page content) may require a logged-in session. It is recommended to be logged in before starting a research session.

---

## 🔒 Permissions

| Permission | Purpose |
|---|---|
| `activeTab` | Interact with the current active tab |
| `storage` | Save/restore settings and automation state |
| `scripting` | Inject `content.js` into Adobe Stock pages |
| `tabs` | Open, navigate, and close scraping tabs |
| `sidePanel` | Register and open the Chrome Side Panel |
| `downloads` | Trigger `.xlsx` file download |
| `host: stock.adobe.com` | Inject scripts and read content on Adobe Stock |

---

## 🔧 Architecture Notes

### State Machine (background.js)
```
idle → running → paused → running (resume)
     ↓          ↓
   stopped     stopped
     ↓
  completed
```
State is persisted to `chrome.storage.local` after every keyword via `utils/stateManager.js`.

### Automation Order is Non-Negotiable
The filter URL (`?filters[content_type:video]=1&order=nb_downloads`) is applied **before** reading the competition count. This means competition reflects video results only — which is what matters for your research.

### Tag Extraction (Two Strategies)
1. **`fetch()` + DOMParser** — No extra tab, parses static HTML
2. **Hidden `chrome.tabs.create({ active: false })`** — Full JS rendering, used as fallback

### Future Extension Points
The architecture is designed to be extended with:
- Images/Templates asset type (add a URL param variant in `config/selectors.js`)
- CSV export alongside Excel (add to `utils/excelExport.js`)
- Keyword presets (save to `chrome.storage.local`)
- Search history log (append to storage on completion)
- Scheduled runs (use `chrome.alarms` API)
- Duplicate video detection (compare titles/IDs across keywords in stateManager)

---

## 📋 Changelog

| Version | Notes |
|---|---|
| 2.0.0 | Side panel UI, pause/resume, state persistence, corrected filter-first automation order |
| 1.0.0 | Initial popup-based version |
