# How it works

## What it does and does not do

- Reads the school's **own website** and the PDFs it links to (fact sheets, school profiles) by itself. It never fetches
  third-party sites such as Niche. A person can add pages saved by hand from Ravenna, Niche, Private School Review and
  Boarding School Review, and those only fill what the website left empty, in that order (docs/SOURCES.md).
- Uses **fixed rules, no AI**. Every answer shows the page it came from, the exact words it matched, and a confidence mark
  (high, medium, low). Check low-confidence answers before using them.
- Obeys each site's `robots.txt`, identifies itself honestly, pauses between pages, and reads at most 40 pages and 4 PDFs
  per website. A site that refuses automated visits is marked "Blocked by site" and left alone.
- **Cannot log in.** Anything that exists only inside an admissions portal (Ravenna, Gateway and so on), such as the exact
  essay prompts, will not be found automatically. For Ravenna a person signs in, saves the page and adds the file on the
  **Ravenna & reviews** page.
- Two template rows are never looked up: Further Notes and Peer Schools. Homework hours usually come from third-party
  sites, so they are almost always blank.
- Paragraph rows (application steps, interviews, essays, events) are copied sections of the school's page, not summaries.
- **Never changes your workbook.** It only reads it.
- The optional **Ask** page puts an AI assistant on top of the saved results. The scraper stays rules-only: the assistant never
  reads websites itself, it only looks things up in what was saved (docs/ASK.md).

## How a school is read

1. **Import** (`src/import-workbook.js`): reads the Master Template rows, the PSTP Schools list and what each existing
   school tab already says. This runs when you choose your sheet on the Start here page.
2. **Crawl** (`src/lib/crawl.js`, `fetcher.js`, `html.js`): starts at the school's website, follows the links that look like
   admissions, tuition, "at a glance", visit and so on, and reads the pages and PDFs. Schools that share a website (lower,
   middle and upper divisions) are read once.
3. **Rules** (`src/lib/rules.js`): one rule per template row looks for the facts in the text it read and keeps the page it
   came from. A number is only taken when the words around it say what it is: money (`$3,000.00`), percentages, graduating
   years ("Class of 2026") and add-on services are not headcounts or ratios, a figure stated for another division is not
   used, hotels on a visitor page are not the school's address, and the school's own hedge words ("More than 1,800",
   "Approximately 365") are kept with the number. When the school's pages give two different values with nearly equal
   weight, the answer is marked medium and names the other value.
4. **Website check** (`src/lib/identity.js`): none of the school's distinctive name words appearing anywhere on its website
   means the link in the PSTP list probably belongs to another school. The school page shows a warning, the list shows
   "wrong site?", and the school is left out of the "all schools" Google Sheet file.
5. **Compare** (`src/lib/compare.js`): sets each answer beside what your sheet says and marks it Matches, Differs, Can fill
   a blank, and so on. A hedge word becomes a range, so a sheet value of 1,823 matches "More than 1,800".

"Differs" means the school's website and your sheet disagree, not that the scraper is wrong: the sheet's numbers often come
from an earlier year or another site. Open the school page to see the page the website's number came from.

## Which column an answer belongs to (Google Sheet export)

School facts and the Events rows go in column **B**. The Guide to Applying rows and the Facts Sheet links go in column
**C** ("School Website"). Columns A and D are never touched.

## Commands

The dashboard does all of this with buttons. From a terminal opened in the `school-info-scraper` folder:

| Command | What it does |
| --- | --- |
| `npm start` | Open the dashboard (same as Start Dashboard.cmd). |
| `npm run check` | The setup checklist (same as Check Setup.cmd). |
| `node src/scrape.js --tier 1` | Read every Tier 1 school. Also `--tier 2`, `--tier 3`. |
| `node src/scrape.js --school "Castilleja (Upper) School"` | Read one school (name or id). |
| `node src/scrape.js --pending` | Read the schools not read yet. |
| `node src/scrape.js --all` | Read everything. Add `--refresh` to download pages again instead of using saved ones. |
| `node src/import-workbook.js "path\to\sheet.xlsx"` | Load a workbook from the command line. |
| `npm run make-portable` | Build the folder and zip you send to teammates (docs/TEAM-SETUP.md). |
| `npm test` | Run the automatic checks (about a minute). |

Only one scrape runs at a time, whether started from a button or a terminal.

## Settings (`config.json`)

You rarely need this. `parallelSites` (websites read at once), `delayMs` (pause between pages),
`maxPagesPerSite`, `maxPdfsPerSite`, `cacheDays` (how long saved pages count as fresh) and `port` (4477). The dashboard
reads the file again each time it starts. `workbookPath` is only used if no sheet has been chosen on the Start here page.

## Tests

`npm test` runs seven groups of checks (loading the sheet, sharing results, team sign-in, the field rules, the Ask assistant, the Google Sheet script, publishing). The field-rule checks (`tests/rules.test.js`) use small made-up pages, one real past mistake each. They use a fake Google Sheet built from your real workbook tabs and a local stand-in for GitHub,
so they never touch your real accounts. The first needs your workbook to be loaded.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| Double-clicking does nothing, or a window closes at once | Double-click `Check Setup.cmd` and read what it says. |
| "Node.js is not installed" | Install the LTS version from nodejs.org, then double-click `Start Dashboard.cmd` again. |
| "Port 4477 is already in use" | The dashboard is already open: go to http://localhost:4477. |
| The school list is empty | Choose your sheet on the Start here page. |
| "That file could not be used" when choosing the sheet | The file needs tabs called "Master Template" and "PSTP Schools". Download it again as .xlsx from Google Sheets. |
| A school shows "Blocked by site" or "Could not load" | The site refuses automated visits or is down. Nothing is worked around; check that school by hand. |
| A scrape seems stuck | Many school sites ask robots to wait 5 to 10 seconds per page, so a website takes 2 to 7 minutes. Watch the page count on Run scraper. |

## Files

| Where | What it is |
| --- | --- |
| `src/server.js` | The dashboard. |
| `src/lib/results-package.js` | Saves your results to one file and adds a teammate's file. |
| `src/agent/` | The Ask page's AI assistant: six read-only tools, the question loop, Claude and Groq providers, settings and the spend meter (docs/ASK.md). |
| `tools/make-portable.js` | Builds the folder you send to teammates. |
| `src/auth.js` | Company Google sign-in and the server settings, for running online. |
| `src/scrape.js` | The scraper. |
| `src/import-workbook.js` | Reads your Excel sheet. Schools added by hand stay on the list. |
| `src/lib/school-list.js` | Adds or removes one school without loading the whole sheet again. |
| `src/lib/sources.js`, `source-readers.js` | Pages saved by hand from Ravenna, Niche and the review sites: checking them, reading the facts, and filling the questions the website left empty (docs/SOURCES.md). |
| `src/setup-check.js` | The checklist. |
| `src/lib/` | `crawl`, `fetcher`, `html`, `textindex` (reading websites); `rules`, `template`, `compare` (deciding what each row says); `dashboard-data`, `util` (shared); `sheet-export`, `access-check` (optional extras). |
| `src/public/` | The dashboard pages (`index.html`, `app.js`, `styles.css`). |
| `google-sheet/Code.gs` | Goes inside the Google Sheet copy: the School Info menu that loads an export file, the cell writing, the Export Log and the daily email. |
| `google-sheet/load-dialog.html` | The window that menu opens. Its text is copied into `Code.gs` by `npm run build-sheet-script`. |
| `deploy/` | `build-static.js`, `deploy-copy.js`, `publish-copy.js`: sharing a read-only copy online. |
| `tests/` | The automatic checks. |
| `data/` | Everything the program saves. |
