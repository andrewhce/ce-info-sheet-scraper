# Give the program to your team (no server needed)

**Looking for the plain-language, click-by-click version to hand to teammates? See [INSTALL-STEP-BY-STEP.md](INSTALL-STEP-BY-STEP.md).** This page is the shorter reference.

Each teammate gets a folder they unzip and double-click. **Nothing is installed**: Node.js is packed inside the folder, so it needs no
admin rights and does not touch anything else on the computer. Because the dashboard runs locally on `127.0.0.1` (`localhost`),
your workbook, scraped cache, Slack webhook, and API keys stay strictly on each teammate's own PC rather than on an online server.
Teammates share only what the scraper found on public school websites by passing around one small results file, so the same schools are not scraped twice.

## For you: make the package (once, and again after updates)

On your Windows computer, in a terminal opened in the `school-info-scraper` folder:

```powershell
npm run make-portable
```

This takes about 5 to 6 minutes and makes `dist\School-Info-Sheet.zip` (about 61 MB). It copies the program and this computer's Node.js, and **nothing from your `data` folder**: no
workbook, no results, no saved pages, no secrets. Send the zip to teammates with Google Drive, Teams or similar (it is too big for most email).

Sending to the Google Sheet needs nothing in the package: each teammate downloads a file from the dashboard and loads it from the sheet's
**School Info** menu (see [GOOGLE-SHEET-EXPORT.md](GOOGLE-SHEET-EXPORT.md)). Only if you use the optional one-click web app route, add
`-- --with-google-export` to put its settings in the package:

```powershell
npm run make-portable -- --with-google-export
```

That zip then **contains the export secret**. Send it only to people you trust, never by a public link.

## For each teammate

1. Unzip the folder anywhere (for example Desktop or Documents). Do not run it from inside the zip.
2. Open it and double-click **`Start Dashboard.cmd`**. The dashboard opens quietly in your browser (no black command window stays open). Click **Turn off dashboard** at the bottom of any page whenever you want to stop it.
   If Windows shows a blue "Windows protected your PC" box, click **More info**, then **Run anyway**. (Or, before unzipping: right-click the zip, Properties, tick **Unblock**, OK.)
3. On **Start here**, follow the 3 steps:
   - **Step 1:** Choose your School Information Sheet as an Excel file (in Google Sheets: File → Download → Microsoft Excel (.xlsx)).
   - **Step 2:** Press **Start checking websites** to read the school websites, or drop in a teammate's `.zip` results file to skip waiting.
   - **Step 3:** Look at the answers on the **Schools** and **To check** pages, or download clean **Excel (.xlsx)** / **CSV** spreadsheets anytime.

They need a Windows 64-bit PC, about 0.5 GB of free disk, about 1 GB of free memory, and internet. Mac is not supported by the package.
`Check Setup.cmd` lists anything that is not working, in plain words.

## Sharing results

On **Start here**:

- **Save results for teammates (.zip)** (Step 3) makes `school-results-DATE.zip` with everything this computer has scraped.
- **Add a teammate's results file (.zip)** (Step 2) adds theirs. For each school the newer result wins, nothing is ever deleted, and schools that are not in your list are skipped and named.

The file holds only what was found on the school websites (nothing from anyone's workbook), so it is safe to send. Each person still compares the results with
their own copy of the sheet, so a teammate with a different or newer sheet still sees the right comparison.

A good routine: split the work (one person scrapes Tier 1, another Tier 2, another Tier 3), everyone saves a results file, everyone adds the others'. Tuition and dates
change each admission cycle, so one person can re-scrape every month and share the new file.

## Updating the program

Rebuild the package and send the new zip. A teammate unzips it and double-clicks **`Start Dashboard.cmd`** right away. Portable builds store their saved sheet, scraped results, and cache in `%LocalAppData%\SchoolInfoSheet\data`, so updating the folder keeps everything intact automatically.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| Windows says "Windows protected your PC" | More info, then Run anyway. |
| Antivirus or IT blocks the folder | Ask IT to allow the unzipped folder. Nothing is installed, and the program only reads public school websites. |
| Dashboard is already running | Double-clicking `Start Dashboard.cmd` again simply reopens it at `http://localhost:4477`. Use **Turn off dashboard** at the bottom of the page to stop it. |
| Want terminal logs for troubleshooting | Run `Start Dashboard.cmd --console` in PowerShell/Command Prompt or inspect `data\dashboard.log`. |
| A results file is refused | It must be a file made by "Save results for teammates (.zip)". The message says why. |
| Anything else | Double-click `Check Setup.cmd` and read what it says. |
