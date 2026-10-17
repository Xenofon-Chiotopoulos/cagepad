# CagePad

**SudokuPad-style solving for [logic-masters.de](https://logic-masters.de/Raetselportal/) puzzles, with live cage totals.**

Live site: **https://xenofon-chiotopoulos.github.io/cagepad/**

Paste a logic-masters link or puzzle ID (e.g. `000VJX`), a SudokuPad link or an f-puzzles link, or hit **Browse** to pick from the newest logic-masters puzzles.

## What it does

The solving controls match SudokuPad:
- Normal, corner, centre and colour modes. `Z X C V` switch modes, `Space` cycles, and holding `Shift` / `Ctrl` gives corner / centre marks temporarily.
- Drag-select, `Shift`/`Ctrl`-click, double-click to select all cells with the same digit or colour, and arrow keys.
- Unlimited undo and redo.
- Multi-colour cells, conflict highlighting (rows, columns, boxes, cages, anti-king, anti-knight), a timer with pause, and autosave per puzzle.

Sums, which is why this exists:
- **Live cage totals.** Every cage gets a pill next to its clue with the sum placed so far:
  - blue: on track
  - green: complete and correct
  - red: over the total, a repeated digit, or the total can no longer be reached
  
  Settings can switch this to "still needed / cells left".
- **Killer combinations** for the selected cage. Combinations that no longer fit your placed digits or centre marks are struck out, and you get must-contain / can-contain digits and one-click "pencil in candidates".
- **Combination calculator** for any number of cells and any total, with must-include and exclude digits.
- **Selection total** under the grid. It also shows the total of whole cages inside the selection, which is handy for the 45 rule.
- **Arrow and little-killer sums** are checked against the bulb or clue.
- **Line sums with per-box segments**, for region-sum, sumdex and similar lines.

Other quality-of-life features:
- A **Lösungscode helper**: it reads the logic-masters "Row 5"-style instruction and builds the answer code from your grid, ready to copy.
- Automatic solved detection against the puzzle's stored solution, an optional "show mistakes" mode, and auto-removal of pencil marks from cells a placed digit sees.
- A digit pad that counts how many of each digit are still to place.
- Auto-candidates, using basic eliminations and optionally the cage combinations.
- Copy and paste progress, and share links.
- Light and dark themes, and a layout that works on phones.

## How loading works

Browsers can't read logic-masters.de or SudokuPad's puzzle API directly: neither sends CORS headers for other sites. So:

1. **Hourly cache.** A GitHub Action (`.github/workflows/site.yml`) runs `scraper/scrape.py`. It reads the newest logic-masters puzzles, resolves their SudokuPad, f-puzzles or tinyurl links server-side, and commits the data to `data/`. The site then loads it from its own origin.
2. **On-demand requests.** If a puzzle isn't cached, the site offers a "Request via GitHub" button. It opens an issue titled `fetch 000ABC`, the Action fetches that puzzle (owner-only), closes the issue, and the page loads it once it's there (about 2 minutes).
3. **Bookmarklet.** Drag **Open in CagePad** from the Tools tab to your bookmarks bar, then click it on any SudokuPad, f-puzzles or logic-masters page. It runs on that site, so it can read the puzzle and hand it straight to CagePad.
4. **Optional proxy.** Deploy `worker/cors-proxy.js` to Cloudflare Workers (free) and paste its URL into Settings to load anything instantly.

You can also trigger the scraper manually: **Actions → Update puzzles & deploy → Run workflow**, optionally with IDs or more listing pages to backfill.

## Development

It's a plain static site with no build step:

```sh
python3 -m http.server 8000      # then open http://localhost:8000
python3 scraper/scrape.py --ids 000VJX   # fetch specific puzzles into data/
```

- `js/format.js`: link parsing, SudokuPad `scl` decoding (including the zipped variant) and the f-puzzles converter
- `js/sums.js`: combinations, cage, line and arrow analysis, and conflicts
- `js/render.js`: SVG renderer, using SudokuPad's 64 px cell units
- `js/app.js`: UI, input, loading and persistence

## Credits

CagePad is an independent fan project. It isn't affiliated with logic-masters.de, SudokuPad (by Sven Neumann / Cracking the Cryptic) or f-puzzles. Puzzles belong to their authors: please solve and submit solutions on logic-masters.de. Puzzle data is read in the formats SudokuPad and f-puzzles use for their links. lz-string is © pieroxy (MIT).
