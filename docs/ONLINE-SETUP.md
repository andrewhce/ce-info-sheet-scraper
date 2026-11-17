# Put the program online for the team

> **Using Railway? Follow [RAILWAY-STEP-BY-STEP.md](RAILWAY-STEP-BY-STEP.md)**, a shorter click-by-click version with the exact order to do things in. This page is the longer reference.

> Want to host on a **DigitalOcean Droplet** with Docker + automatic HTTPS instead? Follow [DIGITALOCEAN-SETUP.md](DIGITALOCEAN-SETUP.md) and [`deploy/digitalocean/`](../deploy/digitalocean/).
>
> This needs a hosting service (a computer that is always on). If you do not have one, use [TEAM-SETUP.md](TEAM-SETUP.md) instead: a folder teammates unzip and double-click, with
> no server and no installing.

**What the team gets:** one link. They open it, sign in with their company Google account, and use the dashboard: load the
sheet, run scrapes, review schools, export to the Google Sheet copy. Nothing is installed on their computers.

**How it works:** the whole program runs on a hosting service that is always on. Every page and every button is behind
company Google sign-in. Only accounts of your company's Google Workspace get in.

**What you need** (about 45 minutes the first time): a GitHub account, a hosting account with a payment card, and someone with admin
rights on your company's Google Workspace (for step 3).

**Not yet tried for real.** The sign-in and server settings pass automatic checks against a stand-in for Google, and I clicked through
the sign-in screens in a browser. The packaged container (`Dockerfile`) has **not** been built, and nothing has been deployed, because Docker
is not installed on this PC. Expect the first real deployment to need a small fix or two; send me the error message.

## Choosing a host

Any service that runs a Dockerfile and offers a saved-data volume works. Two I looked at (prices from their pricing pages and
third-party summaries; check the current price before you pay):

| Host | Rough cost | Notes |
| --- | --- | --- |
| **Railway** (suggested) | Hobby plan about $5 a month, which includes $5 of usage; billed by use | Up to 8 GB of memory per service. Simple: connect GitHub, add a volume, set variables. |
| **Render** | A 2 GB web service about $25 a month, plus $0.25 per GB of disk | The 512 MB plan (about $7) is too small for loading the sheet. Disks need a paid plan. |

The program needs about 0.5 GB to load your sheet and 0.15 GB or more to scrape, so a 1 to 2 GB plan is plenty.

## Step 1. Put the project on GitHub (private)

`.gitignore` already keeps your data, results, workbook and secrets out. Create an empty **private** repository on github.com, then:

```powershell
cd "G:\Cardinal Education\school-info-scraper"
git init -b main
git add -A
git commit -m "School Info Sheet"
git remote add origin https://github.com/YOUR-NAME/school-info-sheet.git
git push -u origin main
```

Check nothing private went up. In PowerShell this must print nothing: `git ls-files | Select-String -Pattern '^data/|\.xlsx$|^\.env|^dist/|node_modules/'`.
(If the folder is already a Git repository connected to GitHub, skip `git init` and `git remote add`: just `git add -A`, `git commit` and `git push`.)

## Step 2. Create the service (Railway)

1. New project, **Deploy from GitHub repo**, pick the repository. Railway finds the `Dockerfile`.
2. Add a **Volume** to the service and mount it at `/data`. Everything the program saves (your sheet, results, secrets) lives there.
3. In the service settings, **generate a public domain**. You get an address like `https://school-info-sheet-production.up.railway.app`.
4. In **Variables**, add:

| Variable | Value |
| --- | --- |
| `PUBLIC_URL` | the https address from the previous step, with no slash at the end |
| `ALLOWED_EMAIL_DOMAIN` | `cardinaleducation.com` |
| `GOOGLE_CLIENT_ID` | from step 3 |
| `GOOGLE_CLIENT_SECRET` | from step 3 |

Optional: `ALLOWED_EMAILS` (extra single addresses, comma separated; leave `ALLOWED_EMAIL_DOMAIN` empty to allow only these people),
`CRAWL_PARALLEL_SITES` (how many websites are read at once; the container default is 8), `SESSION_SECRET` (32 or more random
characters; if you skip it, one is made and kept on the volume). `HOST`, `PORT` and `DATA_DIR` are already set by the `Dockerfile`.

The **Ask** page (AI assistant) is switched on by environment variables too, and cannot be changed from the page on a server:
`ANTHROPIC_API_KEY` (and optionally `ASK_MODEL`, `ASK_MONTHLY_CAP_USD`). See [ASK.md](ASK.md), including what data goes to the AI service.

The program refuses to start, and says why in the logs, if sign-in is not fully set up. That is on purpose.

## Step 3. Set up Google sign-in (a Workspace admin)

In the Google Cloud console ([console.cloud.google.com](https://console.cloud.google.com)), using your company account:

1. Create or choose a project (for example "School Info Sheet").
2. Open **Google Auth Platform**. If asked to get started: app name "School Info Sheet", your support email, and for **Audience** choose **Internal**
   (so only people in your Workspace can ever sign in).
3. **Clients**, **Create client**, application type **Web application**.
4. Under **Authorized redirect URIs** add `https://YOUR-ADDRESS/auth/callback` (your `PUBLIC_URL` plus `/auth/callback`).
5. Create. Copy the **Client ID** and **Client secret** into the two variables in step 2. The secret is shown only once; if it is lost,
   create a new one.
6. Redeploy the service so it picks up the variables.

Google says changes to these settings can take from a few minutes to a few hours to apply. A `redirect_uri_mismatch` error means the address in
step 4 and `PUBLIC_URL` are not exactly the same. The menu names above are from Google's current documentation and may differ a little on your screen.

## Step 4. First visit

Open the address. It sends you to Google, then back to the dashboard. On **Start here** choose your School Information Sheet (.xlsx), then
**Run scraper**, **Tier 1**. Share the link with the team. To connect the Google Sheet export, follow
[GOOGLE-SHEET-EXPORT.md](GOOGLE-SHEET-EXPORT.md) from the online Start here page.

## Good to know

- **Who did what.** The service's logs record who loaded a sheet, started or stopped a scrape and exported a school. The export line on each school page
  shows who sent it.
- **Updates.** Pushing a change to GitHub redeploys the service. A redeploy stops any scrape in progress; choose "Not checked yet" and press Start scraping again and it carries on.
- **Sign-in lasts 12 hours**, then Google asks again. Signing out is the link at the top right.
- **Backups.** The volume holds everything. The scrape results can be re-made by scraping again, and the sheet can be loaded again, so the only thing worth
  keeping safe is access to your Google settings.
- **One scrape at a time**, no matter how many people click.
- **Some school websites may refuse a server's address** more than your office connection. Those show as "Blocked by site" and are left alone.
- **Keep the GitHub repository private** and the list of people with access short: the sign-in protects the running service, not the code.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| The service stops straight away; the log says "The program cannot start" | Read the lines under it: a variable is missing or `PUBLIC_URL` is not https. |
| Google says `redirect_uri_mismatch` | The redirect address in Google and `PUBLIC_URL` plus `/auth/callback` differ. Make them identical. |
| "This account is not allowed in" | The account is not a Workspace account of `ALLOWED_EMAIL_DOMAIN`. Sign in with the company account (the page has a "Use another account" button). |
| You are sent to Google again and again | Cookies are blocked, or `PUBLIC_URL` does not match the address in the browser's address bar. |
| A plain "forbidden" message | The address in the browser is not `PUBLIC_URL`. Use that address. |
| Loading the sheet fails | The plan is out of memory (it needs about 0.5 GB for a moment), or the file is not the School Information Sheet. |
