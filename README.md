# School Info Sheet scraper

Reads each school in your **PSTP Schools** list from the school's own public website and fills in the
rows of your **Master Template**. A dashboard shows, school by school, **what your sheet says now** next
to **what the website says**, with the page it came from, so a person can fact check quickly.
The scraper itself uses fixed rules (no AI) and never changes your workbook. The optional **Ask** page adds an AI
assistant that only reads what the scraper saved and answers questions about it (see [docs/ASK.md](docs/ASK.md)).

## Start in three steps

1. Double-click **`Start Dashboard.cmd`**. The dashboard opens quietly in your browser (no black command window stays open; use **Turn off dashboard** at the bottom of the page when you are done, or run `Start Dashboard.cmd --console` to view live console output). The first time it installs dependencies automatically. If Node.js is missing it opens the download page: install the "LTS" version, then double-click again.
2. On **Start here**, follow Step 1 to drop in your School Information Sheet as an Excel file (in Google Sheets: File → Download → Microsoft Excel (.xlsx)). Do this again whenever the sheet changes.
3. On **Check websites**, choose **Tier 1**, then press **Start checking** (about an hour for 65 schools; keep the PC awake). Choosing a group only selects it: nothing starts until you press Start checking. Then open **Schools** to look at the answers, copy them, or download Excel (`.xlsx`) / CSV spreadsheets. New to the dashboard? Open **Help** (top right) for a plain-words guide to every label and colour.

Something not working? Double-click **`Check Setup.cmd`**: it lists what is ready and what still needs doing, in plain words.
The same list is shown on **Start here** if anything still needs attention.

## The pages

| Page | What it is for |
| --- | --- |
| **Start here** | 3-step guide: load your sheet, scrape or load teammate results, and export Excel/CSV (plus Advanced Google Sheet menu setup). |
| **Schools** | Every school with clickable quick-filter cards (including websites updated since the previous check). Click a school to copy answers with one click, view evidence, or export a spreadsheet. |
| **To check** | The researcher's work list. Every main fact gets a rating out of 100 (**Safe to use**, **Quick look** or **Check this**) from where it came from and how clearly the website says it, never from your sheet. Only the answers the dashboard is unsure about are listed, least certain first, so nobody re-reads answers that are almost certainly right (see [docs/TRUST.md](docs/TRUST.md)). |
| **Check websites** | Choose Tier 1, 2, 3, schools not checked yet, or all schools, then press **Start checking** (choosing alone never starts a run); set up an **automatic schedule**; and connect **Slack notifications**, which list every changed answer of every updated school in full (nothing is cut off), numbered when long, and warn when a school's website link looks like a different school. |
| **Accuracy** | How often the answers are actually right: pick a list of schools, mark each answer **✓ Right** or **✗ Wrong** on the school page, and see the results per question (see [docs/ACCURACY.md](docs/ACCURACY.md)). |
| **Help** | A plain-words guide: what the dashboard is for, a quick guide, and what every label, colour and status means. |
| **Ask** | Optional AI assistant to ask questions about school data in plain English (only needed if connected with a Claude or Groq key). |
| **Technical details & code** | Footer link at the bottom of any page showing the source code and extraction rules in plain view. |

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

- [docs/RAILWAY-STEP-BY-STEP.md](docs/RAILWAY-STEP-BY-STEP.md): click-by-click steps to test the dashboard online on Railway (GitHub, a volume, Google sign-in, the settings, and what to check). The longer reference is [docs/ONLINE-SETUP.md](docs/ONLINE-SETUP.md).
- [docs/INSTALL-STEP-BY-STEP.md](docs/INSTALL-STEP-BY-STEP.md): plain-language, click-by-click steps for teammates to install and start using the dashboard on their own Windows computer (hand this to them with the zip).
- [docs/TEAM-SETUP.md](docs/TEAM-SETUP.md): give the program to teammates as a folder they unzip and double-click (nothing to install, no server), and share results between computers.
- [docs/ONLINE-SETUP.md](docs/ONLINE-SETUP.md): (needs a hosting service) put the program on a hosting service so the team opens a link, signs in with company Google accounts, and needs nothing installed.
- [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md): what it does and does not do, how a school is read, commands, settings, troubleshooting.
- [docs/TRUST.md](docs/TRUST.md): the trust score: what raises and lowers it, where the weights come from, and how the spot-checks tune it.
- [docs/MONTE-CARLO-REPORT.md](docs/MONTE-CARLO-REPORT.md): a simulation, in plain words, of how many answers are likely wrong, how much checking is worth it, how many hand checks you need, and how much the ratings depend on judgement. Remake it with `node tools/monte-carlo.js`.
- [docs/ACCURACY.md](docs/ACCURACY.md): how to measure how accurate the scraper is with spot-checks, and how to read the figures.
- [docs/ASK.md](docs/ASK.md): the Ask page: connect an API key, what the assistant can and cannot do, cost and the monthly cap, what it records.
- [docs/GOOGLE-SHEET-EXPORT.md](docs/GOOGLE-SHEET-EXPORT.md): send a school's findings into a copy of your Google Sheet for a person to fact check (download a file, load it from the sheet's School Info menu).
- [docs/DEPLOY-GUIDE.md](docs/DEPLOY-GUIDE.md): a showcase script for your boss, and putting a read-only copy online (set aside for now).
