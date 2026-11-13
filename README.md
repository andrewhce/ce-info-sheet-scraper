# School Info Sheet scraper

Reads each school in your **PSTP Schools** list from the school's own public website and fills in the
rows of your **Master Template**. A dashboard shows, school by school, **what your sheet says now** next
to **what the website says**, with the page it came from, so a person can fact check quickly.
The scraper itself uses fixed rules (no AI) and never changes your workbook. The optional **Ask** page adds an AI
assistant that only reads what the scraper saved and answers questions about it (see [docs/ASK.md](docs/ASK.md)).

## Start in three steps

1. Double-click **`Start Dashboard.cmd`**. The dashboard opens in your browser. Keep the black window open
   while you use it; close it to stop. (The first time it installs what it needs, which takes a minute and needs internet. If
   Node.js is missing it opens the download page: install the "LTS" version, then double-click again.)
2. On **Start here**, choose your School Information Sheet as an Excel file. In Google Sheets: File, Download,
   Microsoft Excel (.xlsx). Do this again whenever the sheet changes.
3. On **Run scraper**, press **Tier 1** (about an hour for 65 schools; keep the PC awake). Then open **Schools** to review.

Something not working? Double-click **`Check Setup.cmd`**: it lists what is ready and what still needs doing, in plain words.
The same list is at the top of the Start here page.

## The pages

| Page | What it is for |
| --- | --- |
| **Start here** | A checklist of what is ready, where you choose your sheet, and the optional Google Sheet export setup. |
| **Schools** | Every school with its status. Click one to see each template row, your sheet beside the website, and the evidence. |
| **Ask** | Ask questions about the school data in plain English; answers show their source. Needs an API key (Claude, or Groq to try it out). Reads only: anything that changes something is a button you press. |
| **Run scraper** | Buttons to read Tier 1, 2, 3, the schools not read yet, or all. Live progress and a Stop button. |
| **Script** | The code and the rules, grouped by what they do, readable in the browser. |

## Where things are

```
school-info-scraper/
  Start Dashboard.cmd     double-click: open the dashboard
  Check Setup.cmd         double-click: what is ready, what is missing
  README.md               this page
  config.json             settings (crawl speed, limits); you rarely need to touch it
  docs/                   the guides: how it works, Google Sheet export, sharing online
  src/                    the program
    server.js  scrape.js  import-workbook.js  setup-check.js
    lib/                  the scraper's parts (crawl, fetch, rules ...)
    agent/                the Ask page's assistant (tools, the question loop, settings, spend meter)
    public/               the dashboard pages
  google-sheet/Code.gs    the script that goes inside your Google Sheet copy (adds the "School Info" menu; optional)
  deploy/                 sharing a read-only copy online (set aside for now)
  tools/make-portable.js  builds the folder you send to teammates (nothing to install)
  dist/                   where that folder and its zip are made
  tests/                  automatic checks
  data/                   everything the program saves (see below)
  package.json, node_modules/    the libraries it uses; ignore these
```

**`data/`** holds your loaded workbook, the school list, every scrape result and the saved web pages. Nothing in it is
precious except `results/` (what the scraper found). `data/cache/` only saves time and is safe to delete.

## Guides

- [docs/TEAM-SETUP.md](docs/TEAM-SETUP.md): give the program to teammates as a folder they unzip and double-click (nothing to install, no server), and share results between computers.
- [docs/ONLINE-SETUP.md](docs/ONLINE-SETUP.md): (needs a hosting service) put the program on a hosting service so the team opens a link, signs in with company Google accounts, and needs nothing installed.
- [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md): what it does and does not do, how a school is read, commands, settings, troubleshooting.
- [docs/ASK.md](docs/ASK.md): the Ask page: connect an API key, what the assistant can and cannot do, cost and the monthly cap, what it records.
- [docs/GOOGLE-SHEET-EXPORT.md](docs/GOOGLE-SHEET-EXPORT.md): send a school's findings into a copy of your Google Sheet for a person to fact check (download a file, load it from the sheet's School Info menu).
- [docs/DEPLOY-GUIDE.md](docs/DEPLOY-GUIDE.md): a showcase script for your boss, and putting a read-only copy online (set aside for now).
