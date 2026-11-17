# Install the website checker on your own computer, step by step

This puts the dashboard on **your own Windows computer**. You do not install anything: you unzip a folder and double-click one file.
Your sheet, your results and any keys stay on your computer. The dashboard only reads schools' public websites. The only things that leave your computer are the optional Slack messages and Ask questions, if you turn those on (Part 7).

**You need:** a Windows 10 or 11 computer (64-bit), about 1 GB of free disk space, and an internet connection.
**You do not need:** administrator rights, Node.js, or any other program.

---

## Part 1. For the person sending it to the team (once)

1. On the computer that has the `school-info-scraper` folder, open a terminal in that folder and run:

   ```powershell
   npm run make-portable
   ```

   It takes about 5 to 6 minutes. It makes `dist\School-Info-Sheet.zip` (about 61 MB). The zip contains the program only. It does **not** contain your sheet, your results, your saved pages, your Slack address or any keys.

2. Send that one zip file to each teammate with Google Drive or Teams (it is too big for most email).
3. Also send them this page, and tell them which Google Sheet to download in step 6.

Run step 1 again whenever the program is updated, and send the new zip. Teammates keep all their work (see Part 4).

---

## Part 2. For each teammate: install

**1. Save the zip.** Download `School-Info-Sheet.zip` to your computer.

**2. Unblock it (30 seconds, avoids a warning later).** Right-click the zip, choose **Properties**, tick **Unblock** at the bottom, press **OK**. If you do not see an Unblock box, skip this step.

**3. Unzip it.** Right-click the zip, choose **Extract All…**, pick a folder, press **Extract**.
- Do not open the program from inside the zip. Unzip it first.
- Put it in a simple folder such as `C:\SchoolInfoSheet`. If your Desktop and Documents are backed up by OneDrive, avoid them: the folder holds thousands of small files and OneDrive may spend a long time syncing them.

**4. Start it.** Open the unzipped folder and double-click **`Start Dashboard.cmd`**.
- After a few seconds your web browser opens on the dashboard. No black window stays open.
- If Windows shows a blue **"Windows protected your PC"** box, click **More info**, then **Run anyway**. This appears because the file is new to Windows, not because anything is wrong.
- If the browser does not open by itself, open it yourself and go to **http://localhost:4477**.

**5. Check that it is ready.** On the **Start here** page you will see a checklist. The first two lines should say **Ready**. The only thing left to do is "Load your School Information Sheet". If any line says "To do" with a reason, follow what it says, or see Part 5.

---

## Part 3. For each teammate: first use

**6. Load your school sheet (Step 1 on the Start here page).**
- Open the Google Sheet. Click **File**, then **Download**, then **Microsoft Excel (.xlsx)**.
- On the dashboard, click **Choose your sheet** and pick that file (or drag it onto the box).
- Wait about 30 seconds. It says **Done. Your school list is ready.** and the step shows a green **Done**. Your sheet is only read, never changed.

**7. Check the school websites (Step 2).**
- Click **Start checking websites**. On the next page choose a group of schools, then press **Start checking**. Nothing starts until you press that button.
- Keep the computer awake, and do not press **Turn off dashboard**, while it works. One school takes roughly a minute and several are checked at the same time, but a whole group still takes a while.
- **Shortcut:** if a teammate has already checked the schools, skip the wait. On Step 2 choose **Or add a teammate's results file (.zip)** and pick the file they sent you (see Part 6).

**8. Look at the answers and use them (Step 3).**
- **Schools** shows every school and what the website says. Each answer has a rating out of 100 and a label: **Safe to use**, **Quick look** or **Check this**.
- **To check** lists only the answers a person should look at, least certain first.
- To get the answers out, press **Download Excel (.xlsx)** or **Download CSV**. The file goes to your Downloads folder.
- Not sure what something means? Open the **Help** page at the top.

**9. Turn it off.** Scroll to the bottom of any page and click **Turn off dashboard**. Next time, double-click **`Start Dashboard.cmd`** again. Everything you did is still there.

---

## Part 4. Updating to a new version

1. Download the new zip and unzip it into a **new** folder.
2. Double-click `Start Dashboard.cmd` in the new folder.
3. Your sheet, results and settings are still there. They are kept in `C:\Users\<you>\AppData\Local\SchoolInfoSheet\data`, outside the program folder.
4. When you are happy with the new version, delete the old folder.

---

## Part 5. If something goes wrong

| What you see | What to do |
| --- | --- |
| "Windows protected your PC" | Click **More info**, then **Run anyway**. |
| Antivirus or IT blocks the folder or the file | Ask IT to allow the unzipped folder. Nothing is installed, and the program only reads public school websites. |
| The browser does not open | Open it yourself and go to **http://localhost:4477**. |
| "Dashboard is already running" or the page loads but looks old | Double-click `Start Dashboard.cmd` again, or press **Ctrl + F5** in the browser. |
| The page says it cannot connect | The dashboard was turned off. Double-click `Start Dashboard.cmd`. |
| A line on Start here says "To do" | Read the line under it. It says what to do in plain words. |
| You want to see exactly what it is doing | Double-click **`Check Setup.cmd`** for a plain list of what works, or run `Start Dashboard.cmd --console` from PowerShell to see live messages. |
| You want to start again from nothing | Turn the dashboard off, then delete the folder `C:\Users\<you>\AppData\Local\SchoolInfoSheet\data`. This deletes your saved sheet, results and settings. |

---

## Part 6. Share results so nobody checks the same school twice

- **To send yours:** on Start here, Step 3, press **Save results for teammates (.zip)**. It makes one file, `school-results-DATE.zip`. It holds only what was found on school websites, nothing from anyone's sheet, so it is safe to send.
- **To use a teammate's:** on Start here, Step 2, choose **Or add a teammate's results file (.zip)**. For each school the newer result wins, nothing is ever deleted, and any school that is not in your list is named and skipped.
- A good routine: one person checks Tier 1, another Tier 2, another Tier 3, then everyone swaps files.

---

## Part 7. Optional extras

Do these only if you want them. None is needed to use the dashboard.

- **Check automatically.** On the **Check websites** page, open the schedule, pick how often and which schools, and turn it on. Weekly is plenty, because school facts change a few times a year. To let it run while the dashboard is closed, press **Let Windows run the checks in the background**. It then runs only while you are signed in to Windows.
- **Slack messages when answers change.** On the **Check websites** page, open the Slack panel and paste your own Slack address into it. Never send that address by email or chat.
- **The Ask assistant.** On the **Ask** page, open **Connect the AI** and paste the key you were given. Never send the key by email or chat. Ask your team lead which key to use.

**Mac:** this package is for Windows only, and it has not been tested on a Mac. On a Mac, ask the person who looks after the dashboard.
