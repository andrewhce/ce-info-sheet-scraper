# Send results to your Google Sheet copy

The dashboard makes a small file of what a school's website said. A menu inside a **copy** of your Google Sheet loads that file
into the school's tab, for a person to fact check. It never overwrites what a person typed.

This route needs no web app, no secret and nothing from your Google Workspace administrator: the script only runs when a person
opens the menu inside the sheet, as that person.

## What loading a file does

- **Empty cell** (or one still holding the template's hint text): filled, highlighted yellow, with a note giving the source
  page and confidence.
- **Cell with a different value:** left as it is. A note on the cell says "UPDATED INFO ON WEBSITE" and shows the website's
  value and source. The cell is highlighted orange (if it has no colour of its own).
- **Cell that already says the same:** left alone.
- Website findings go in column B for the school facts and the Events rows, and in column C ("School Website") for the
  Guide to Applying rows and the Facts Sheet links. Columns A and D are never touched.
- A school with no tab gets a new one made from the Master Template (with the Admissions Portal / School Website header row).
- Every school loaded adds a line to an **Export Log** tab with a Reviewed? checkbox. A **daily email** (about 5 pm, sheet time
  zone) lists the schools loaded since the last email.
- Loading the same file again is safe: notes do not stack and nothing already written is changed.

## One-time setup (about 5 minutes, in your Google Sheet copy)

> **These same steps are in the dashboard**, in plain words and with the script ready to copy: open **Start here** and press
> **Set up the Google Sheet menu, step by step** (or go to `#/sheet-setup`). Give teammates that page instead of this document.

1. Open the sheet copy, then **Extensions, Apps Script**.
2. **Add a new file; do not paste over an existing one.** If the project already has scripts (for example the ones that create a tab
   per school), leave them as they are. Click the **+** next to **Files**, choose **Script**, name it `School Info Export`, and paste
   in the whole of [google-sheet/Code.gs](../google-sheet/Code.gs). (The dashboard's Script page has it too, with a Copy button.)
   The script uses its own function names, so it does not clash with other scripts. One exception: if one of your other files already
   has a function called `onOpen`, tell whoever maintains this, because only one `onOpen` can exist.
3. Near the top, put the people to notify in `NOTIFY_EMAILS: ''` (comma separated). Press **Save** (the disk icon).
4. **Reload the sheet** (refresh the browser tab). A new menu, **School Info**, appears after Help. If it does not, in the Apps Script
   editor pick the function `onOpen` and press Run once.
5. The first time you use a menu item Google asks you to allow the script. If it warns "Google hasn't verified this app", choose
   **Advanced**, then **Go to ... (unsafe)**: it is your own script. It asks for permission to see and edit this spreadsheet (to write
   the cells), to show its window, and to send the daily email.
6. In the sheet choose **School Info, Start the daily email**. This starts the daily email; loading works without it.

## Each time

1. In the dashboard open a school and press **Download file for Google Sheet** (one school), or on **Start here** press
   **Download file for all N scraped schools**. The file is `school-info-export-....json`, usually in your Downloads folder. It holds
   only what was found on the school websites (nothing from your workbook, no secrets).
2. In the Google Sheet choose **School Info, Load export file...**, press **Choose file**, pick it, then **Load into this sheet**.
3. Keep the window open until it says **Done**. It loads one school at a time (a few seconds each; a file with all schools can
   take a long while, so you can also download just the schools you need from their pages). If it stops or a school fails, load
   the same file again.
4. The people named in `NOTIFY_EMAILS` get one email a day listing the schools that were loaded. Each school's tab has yellow cells
   (filled from the website) and orange cells (the website said something different, see the note). Tick **Reviewed?** in the Export
   Log when a school has been checked. The dashboard's **Help** page (the "colours" section) has the same colour key, with the Excel
   download's colours too, and each school page shows it next to the download buttons.

After editing the script later, paste the new `Code.gs` over the same `School Info Export` file and Save. (Nothing to redeploy for the
menu route.)

## Optional: send with one click (needs "Who has access: Anyone")

If your company allows an Apps Script web app to be open to **Anyone**, the dashboard can send a school straight into the sheet with the
**Send to Google Sheet** button, no file needed. In the Start here page, under **Advanced**, press **Make a secret** and copy it. In Apps
Script add a script property named `EXPORT_TOKEN` with that secret (Project Settings, Script properties), then **Deploy, New deployment,
Web app, Execute as: Me, Who has access: Anyone** and copy the web app address into the dashboard with the secret, **Save**, **Test the
connection**. "Anyone" only makes the address reachable; the script refuses every request without the secret.

If the deploy screen only offers your organization, this route cannot work, because the dashboard on a computer cannot sign in to Google.
Use the file route above instead.

**The Start here checklist reports what is true, not just that an address is saved.** A saved address is shown as *not tested yet* until
you press **Test the connection** (or a send is tried), then as *working* or *does NOT work* with Google's reason, from what that last call did.
While it does not work the school page hides the one-click button and says why; the file download is unaffected. **Remove saved address**
(in the same Advanced panel) forgets the address and secret.

## Checking it

`npm test` runs `tests/apps-script.test.js`, which runs `Code.gs` against a fake Google Sheet built from your real workbook tabs, loads a
file the same way the menu does, and checks it writes exactly what the web app route writes. It cannot test Google itself, so try the
first real load on one school you can easily undo (a version of the sheet is kept in File, Version history).

The window the menu opens is `google-sheet/load-dialog.html`, copied into `Code.gs` so the script stays a single file. If you edit that
page, run `npm run build-sheet-script`; `npm test` fails if the two are out of step.
