# School Info Sheet: showcase and deployment guide

For showing the tool to your boss and putting it on a link the team can open. **Putting it online is set aside for now**;
nothing here has been deployed. Commands are for PowerShell opened in `G:\Cardinal Education\school-info-scraper`.
The everyday guide is [../README.md](../README.md).

## 1. What you are showing (30 seconds)

- A scraper reads each school's **own public website** (and the PDFs it links to) and fills the rows of the
  **Master Template**: address, grades, tuition, ratio, application dates, interviews, essays, and so on.
- A dashboard lists the **310 PSTP schools** and, for each, shows **what the sheet says now** next to
  **what the website says**, with the page link and the exact words it matched.
- It uses fixed rules, **no AI**, so it cannot make things up: every answer points to its source, with a
  confidence mark (high / medium / low). A person still fact checks.
- It never changes the workbook. A separate button can send findings into a **copy** of the sheet (see section 7).

## 2. Be honest about where it stands

| | |
| --- | --- |
| Schools in the list | 310 |
| Schools scraped so far | **31** (Tier 1 has 65) |
| Template rows found per school | about 23 of 39 on average |
| Early accuracy against your existing tabs (31 schools) | address matched 22 of 26, tuition 20 of 23, application dates mostly; **enrollment only 7 of 18** (the weakest row) |
| Not possible | anything behind an admissions-portal login; homework hours (a third-party figure); peer schools |
| Paragraph rows (application steps, interviews, essays) | copied sections of the school's page, not summaries |

Say this first and the numbers will help you rather than hurt you. Re-check them on the day: they change when you scrape more.

## 3. Pick how to show it

| | A. On this PC | B. Link, no login | C. Link behind a login |
| --- | --- | --- | --- |
| Setup | none | Cloudflare account, about 15 min | Cloudflare account + Access, about 40 min |
| Who can open it | you, on a screen share | anyone with the link | only the emails you allow |
| What it shows | everything, including the Run buttons | scraped data and sources only (no workbook text) | everything except Run buttons, including the comparison with your sheet |

**My suggestion:** use **A** for the first showing (it works today), then set up **C** for the team. Use **B** only if
you need a link quickly and are comfortable with an unlisted public page of public school information.
Person-specific application links from your school list (100 of the 222 portal links include a student number)
are automatically cut back to the portal's front page in every copy.

### Option A: show it from this PC

Double-click `Start Dashboard.cmd` (or run `node src/server.js`). It opens http://localhost:4477. Keep the black window open.

## 4. Before the showcase

1. (Optional, a day before) Scrape Tier 1 so the demo has 65 schools: Run scraper, **Tier 1**. Roughly an hour (an
   estimate; many school sites ask bots to wait 5 to 10 seconds per page). Keep the PC awake.
2. Look through three or four schools yourself and decide which ones you will open.
3. If you are using a link (B or C), upload again after the last scrape (section 5, step 5) and open the link in a
   private window and on your phone.
4. Keep option A ready as the fallback.

## 5. Put it on Cloudflare Pages (options B and C)

**Cloudflare facts I checked:** the Zero Trust **Free plan allows up to 50 users** (Cloudflare's pricing page). Whether
sign-up asks for a payment method was not stated anywhere I could find, so check when you sign up. The Pages
"Enable access policy" switch only protects preview links, **not** the main `<project>.pages.dev` address, so the
login must be added as its own Access application (steps below).

The upload command has only been tested against stand-ins, not real Cloudflare. If any step errors, send me the exact message.

**Step 1. Sign in once.** A Cloudflare account is free (https://dash.cloudflare.com/sign-up). This PC may already be
signed in; check with:

```powershell
npx wrangler whoami
```

If it says you are not logged in:

```powershell
npx wrangler login
```

**Step 2. Create an empty project.** Type the project name and the production branch into the command (this version of Wrangler,
4.161, does not ask for them). Use your own name if `ce-school-info-sheet` is taken, and use the same name in every later step.
Note the `.pages.dev` address it prints.

```powershell
npx wrangler pages project create ce-school-info-sheet --production-branch main
```

Run the later `node deploy/deploy-copy.js ...` commands from the project folder: `cd "G:\Cardinal Education\school-info-scraper"`.

**Step 3 (option B only). Upload the public copy** and skip to step 5's test.

```powershell
node deploy/deploy-copy.js --project ce-school-info-sheet --no-sheet
```

**Step 3 (option C). Add the login first.** In the Cloudflare dashboard, open Zero Trust.

1. First time only: choose a team name and the Free plan.
2. **Add the One-time PIN login yourself.** Since May 2026 Cloudflare no longer adds it to new accounts. Instead they start with a
   "Cloudflare" login that only lets in people who are members of **your Cloudflare account**, so your boss and the team could not
   use it. Go to **Integrations, Identity providers**, under "Your identity providers" select **Add new identity provider**, then
   select **One-time PIN**.
3. Access, Applications, Add an application, **Self-hosted**.
4. Application domains: add `ce-school-info-sheet.pages.dev` and `*.ce-school-info-sheet.pages.dev` (use your own project name; the second covers the per-upload addresses).
5. Policy: Action **Allow**; Include **Emails ending in** `@cardinaleducation.com` (or list individual emails). If the application asks
   which login methods to accept, tick **One-time PIN** (or accept all).
6. Save. Then in the Pages project, Settings, General, also select **Enable access policy**.

Step 2 is from Cloudflare's current documentation. The application's login-method screen is not described there, so what you see
may differ a little from step 5. A code is sent **only** to an email an Allow policy lets in; anyone else sees the same "a code has
been emailed to you" message and receives nothing. Codes last 10 minutes and work once. If codes do not arrive, check spam and ask
your IT person to allow `notify.cloudflare.com` (Cloudflare's own docs say email scanners can use up a code before you do).

**Step 4 (option C). Upload.** The command refuses to upload unless the address already answers with a Cloudflare login,
so the workbook text can never go up unprotected. It checks again afterwards and warns if anything answers without a login.

```powershell
node deploy/deploy-copy.js --project ce-school-info-sheet
```

**Step 5. Test in a private browser window.** Option C: you should see the Cloudflare login, accept your work email, get a code by email,
then see the dashboard. A non-allowed email should be refused. Option B: the dashboard opens straight away.

To update later (after more scraping): run `node deploy/deploy-copy.js` again. It rebuilds the copy and uploads it.

## 5b. Deploy through GitHub instead (replaces steps 2 to 4)

Choose this if you would rather push to GitHub than run Wrangler. Things to know first:

- **A new Cloudflare project is needed.** Cloudflare does not let a project made with Wrangler (like `ce-school-info-sheet`) switch to GitHub deploys, and
  project names cannot be changed. The empty one can stay, or be deleted in its Settings.
- **A push publishes straight away.** The login (step 3) must exist first. `publish-copy.js` checks for it before it builds or pushes, but anyone with
  push access to the GitHub repository can publish without that check, so keep the repository **private** and the access list short.
- **The repository will hold workbook text** (the full copy) unless you add `--no-sheet`. Private repositories are free on GitHub.
- Only the finished pages go to GitHub (a separate repository), never the scraper, your scraped data or the workbook file.

1. Make the local repository folder (a placeholder page only; `G:\Cardinal Education\school-info-site`):

```powershell
node deploy/publish-copy.js --setup
```

2. On github.com: New repository, name `school-info-site`, **Private**, no README and no .gitignore, Create. Copy its address.
3. Connect and push the placeholder (Windows opens a browser to sign in to GitHub the first time):

```powershell
cd "G:\Cardinal Education\school-info-site"
git remote add origin https://github.com/YOUR-NAME/school-info-site.git
git push -u origin main
```

4. In Cloudflare: Workers & Pages, Create application, then **Pages**, then **Import an existing Git repository**. Authorize Cloudflare's GitHub app for
   just that one repository and pick it. Name the project (a new name, for example `ce-school-info-site`). Production branch `main`, framework preset
   **None**, build command **empty**, build output directory **`public`**. Save and Deploy. (Menu names may differ; Cloudflare is pushing Workers, so look
   for the Pages option.) This publishes only the placeholder.
5. Add the login: step 3 above (One-time PIN, Self-hosted application, both domains, Allow policy), using the **new** project's address.
6. Publish from the project folder (it checks the login, builds, commits and pushes):

```powershell
cd "G:\Cardinal Education\school-info-scraper"
node deploy/publish-copy.js --url https://ce-school-info-site.pages.dev/
```

   Cloudflare builds it in about a minute. Test in a private window as in step 5.
7. After more scraping, run `node deploy/publish-copy.js` again.

| What you see | What to do |
| --- | --- |
| `Not publishing ... (it said: HTTP 522)` or `404` or `200` | The login is not covering that address yet. Re-check the two domains in the Access application. |
| `no GitHub address yet` | Do step 3 (`git remote add origin ...`). |
| The push did not go through | Sign in to GitHub when asked, and check you have write access to the repository. The commit is kept; run the command again. |
| Cloudflare deploy succeeds but the page is blank | The build output directory must be exactly `public`. |

## 6. Showcase script (about 6 minutes)

1. **The list** (Schools page). 310 schools, stats across the top, filters. "Not scraped yet" is honest, not an error.
2. **One school in detail:** open **Castilleja (Upper) School**. Left column is your sheet, right column is the website.
   Green "Matches the sheet" rows are the proof it works. Open **Evidence** on one row: the exact words and the page.
3. **Where it adds value:** open **Lakeside (Upper) School**. The website gives a decision date the sheet does not have
   (a blank it can fill), and a newer application-open date than the sheet (marked "Differs"). Re-check these on the day.
4. **Where it is weak, on purpose:** open a school where Enrollment says "Differs" and show the evidence. This is why a person fact checks.
5. **The Script page:** "no AI, fixed rules, here is every rule." Mention it obeys each site's robots.txt and is polite about speed.
6. **The Google Sheet button:** explain it (section 7). It is built and tested but not yet connected to your copy.

## 7. Questions your boss may ask

- **What does it cost?** No AI fees. Cloudflare Pages and the Zero Trust free plan are free at this size (check Cloudflare's current limits).
- **Is it allowed to read school sites?** It reads only each school's own public pages, obeys robots.txt, identifies itself honestly, and leaves alone any site that refuses.
  None of the first 31 refused.
- **Can it overwrite our data?** No. The workbook is only read. The Google Sheet export never overwrites a filled cell: blanks are filled in yellow, and where a person already typed something different it adds a note and an orange highlight.
- **How accurate is it?** See section 2. Every value shows its source so errors are quick to spot.
- **How long for everything?** A few hours for all 310 schools (an estimate), then it can be re-run each cycle.
- **Who can see it?** On this PC, only you. On a link: only the emails allowed by the login (option C).

**Google Sheet export (not set up yet).** The dashboard has an **Export to Google Sheet** button on each school page. It needs a one-time, 10-minute
setup in your sheet copy (steps in `docs/GOOGLE-SHEET-EXPORT.md`). A person is emailed once a day listing the schools
exported, and an **Export Log** tab tracks who has reviewed each one. Set it up after the showcase unless your boss asks to see it.

## 8. If something goes wrong

| What you see | What to do |
| --- | --- |
| `Not uploading ... (it said: HTTP 404)` or `HTTP 200` | The login is not covering that address yet. Re-check the two domains in the Access application; wait a minute; try again. |
| `More than one account available` | In PowerShell: `$env:CLOUDFLARE_ACCOUNT_ID="your-account-id"` (Cloudflare dashboard, right-hand side of the home page), then run the command again. |
| `You are not authenticated` | `npx wrangler login` |
| `Not enough non-option arguments: got 0, need at least 1` | The project name is missing. Use `npx wrangler pages project create ce-school-info-sheet --production-branch main`. |
| The project address is not `<name>.pages.dev` | Cloudflare added a suffix because the name was taken. Add `--url https://the-real-address.pages.dev` to the deploy command. |
| No One-time PIN option in Cloudflare | New accounts no longer include it. Add it under Integrations, Identity providers, Add new identity provider, One-time PIN. |
| No login code arrives | Check spam. The email must match the Allow rule or no code is sent. Allow `notify.cloudflare.com`. Request a fresh code if one was "already used" (email scanners can open it first). |
| The page shows old numbers | Run `node deploy/deploy-copy.js` again, then press Ctrl+F5. |
| `Port 4477 is already in use` | The dashboard is already open at http://localhost:4477. |

## 9. Not done yet

- Nothing is hosted on Cloudflare yet.
- The Google Sheet export is not connected to your copy.
- Only 31 of 310 schools are scraped.
