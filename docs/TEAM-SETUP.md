# Give the program to your team (no server needed)

Each teammate gets a folder they unzip and double-click. **Nothing is installed**: Node.js is packed inside the folder, so it needs no
admin rights and does not touch anything else on the computer. Teammates share what the scraper found by passing around one small
results file, so the same schools are not scraped twice.

## For you: make the package (once, and again after updates)

On your Windows computer, in a terminal opened in the `school-info-scraper` folder:

```powershell
npm run make-portable
```

This makes `dist\School-Info-Sheet.zip` (about 55 MB). It copies the program and this computer's Node.js, and **nothing from your `data` folder**: no
workbook, no results, no saved pages, no secrets. Send the zip to teammates with Google Drive, Teams or similar (it is too big for most email).

Sending to the Google Sheet needs nothing in the package: each teammate downloads a file from the dashboard and loads it from the sheet's
**School Info** menu (see [GOOGLE-SHEET-EXPORT.md](GOOGLE-SHEET-EXPORT.md)). Only if you use the optional one-click web app route, add
`-- --with-google-export` to put its settings in the package:

```powershell
npm run make-portable -- --with-google-export
```

That zip then **contains the export secret**. Send it only to people you trust, never by a public link.

## For each teammate

1. Unzip the folder anywhere (for example the Desktop). Do not run it from inside the zip.
2. Open it and double-click **`Start Dashboard.cmd`**. A black window opens, then the browser. Keep the black window open while using it.
   If Windows shows a blue "Windows protected your PC" box, click **More info**, then **Run anyway**. (Or, before unzipping: right-click the zip,
   Properties, tick **Unblock**, OK.)
3. On **Start here**, choose your School Information Sheet as an Excel file. In Google Sheets: File, Download, Microsoft Excel (.xlsx).
4. Use **Run scraper** and **Schools** as usual.

They need a Windows 64-bit PC, about 0.5 GB of free disk, about 1 GB of free memory, and internet. Mac is not supported by the package.
`Check Setup.cmd` lists anything that is not working, in plain words.

## Sharing results

On **Start here**, **Share results with teammates**:

- **Save my results to a file** makes `school-results-DATE.zip` with everything this computer has scraped.
- **Add a teammate's results file** adds theirs. For each school the newer result wins, nothing is ever deleted, and schools that are not in your list are skipped
  and named.

The file holds only what was found on the school websites (nothing from anyone's workbook), so it is safe to send. Each person still compares the results with
their own copy of the sheet, so a teammate with a different or newer sheet still sees the right comparison.

A good routine: split the work (one person scrapes Tier 1, another Tier 2, another Tier 3), everyone saves a results file, everyone adds the others'. Tuition and dates
change each admission cycle, so one person can re-scrape every month and share the new file.

## Updating the program

Rebuild the package and send the new zip. A teammate unzips it into a **new** folder, then copies their old `data` folder into the new one. That keeps their sheet, results
and saved pages.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| Windows says "Windows protected your PC" | More info, then Run anyway. |
| Antivirus or IT blocks the folder | Ask IT to allow the unzipped folder. Nothing is installed, and the program only reads public school websites. |
| "Port 4477 is already in use" | The dashboard is already open: go to http://localhost:4477. |
| A results file is refused | It must be a file made by "Save my results to a file". The message says why. |
| Anything else | Double-click `Check Setup.cmd` and read what it says. |
