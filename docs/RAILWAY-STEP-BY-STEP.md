# Test the dashboard online with Railway, step by step

This puts the dashboard on **Railway** (a hosting service) so your team opens one link, signs in with their company Google account, and uses it with nothing installed on their computers.

**This is a first test.** The program side was checked on 2026-11-17 by running it the way Railway runs it, but the Docker build itself and Railway have **not** been tried yet (Docker is not installed on the development PC). If something fails, copy the error lines from Railway's **Deploy Logs** or **Build Logs** (never any keys or passwords) and send them over. Expect to need one small fix.

**What you need (about 45 minutes):**
- Your **GitHub** account (the code goes in a **private** repository; yours already exists).
- A **Railway** account with a payment card. The Hobby plan was about $5 a month when this was written; check the current price on railway.com/pricing.
- A **Google Cloud** project where you can create sign-in credentials (Part C).

**Order matters.** You need Railway's address before Google's setup, and you need Google's keys before the program will start. That is why the first deploy fails on purpose in step 4. Follow the parts in order.

---

## Part A. Put the code on GitHub (private)

The `school-info-scraper` folder is **already a Git repository** connected to GitHub (`https://github.com/andrewhce/ce-info-sheet-scraper`). Its one saved version is from Nov 13, so the GitHub copy is **out of date**: it is missing about 28 files the program needs now (for example `src/launch.js` and the Ask files). Railway builds whatever is on GitHub, so you must send the current version first.

`.gitignore` already keeps your data, results, workbook, saved settings and keys out of it. On 2026-11-17 a trial commit on a copy of the folder confirmed that none of those would be included, and the Nov 13 history has none of them either.

1. **Make sure the GitHub repository is private.** Open `https://github.com/andrewhce/ce-info-sheet-scraper`. It must show a **Private** label next to its name. If it says **Public**, go to **Settings**, then **General**, scroll to **Danger Zone**, choose **Change visibility**, and make it private **before** the next step.
2. In PowerShell, in the `school-info-scraper` folder, save the current version and send it:

   ```powershell
   cd "G:\Cardinal Education\school-info-scraper"
   git add -A
   git commit -m "Current version for online test"
   git push
   ```

3. Check that nothing private is in the repository. This must print nothing:

   ```powershell
   git ls-files | Select-String -Pattern '^data/|\.xlsx$|^\.env|^dist/|node_modules/'
   ```

---

## Part B. Create the service on Railway

4. On railway.com choose **New Project**, then **Deploy from GitHub repo**, and pick your repository. Railway finds the `Dockerfile` by itself and builds from it.
   - **The first deploy will crash. That is expected.** Open **Deploy Logs**: it says `The program cannot start` and that sign-in is not set up. The program refuses to run on the internet without Google sign-in, on purpose.
5. **Add the storage.** Open the service, go to **Settings**, then **Volumes** (or press Ctrl+K and search "volume"), add a volume and set its **mount path** to exactly `/data`. This is where your sheet, results and settings are kept. Without it everything is lost on every redeploy.
6. **Get the web address.** In the service, **Settings**, then **Networking**, press **Generate Domain**. You get an address like `https://school-info-sheet-production.up.railway.app`. Copy it. If Railway asks which port, use `8080`.

---

## Part C. Set up Google sign-in

7. Open console.cloud.google.com with your company Google account. Create or choose a project (for example "School Info Sheet").
8. Open **Google Auth Platform** (older screens call it **APIs & Services, OAuth consent screen**).
   - If you are a Google Workspace admin, set **Audience** to **Internal**. Only people in your company can ever sign in. This is the right choice for the real thing.
   - If you are not an admin and just want to test, choose **External**, keep it in **Testing**, and add your own email (and teammates' emails) under **Test users**. The program still only lets in the company domain.
9. Go to **Clients**, then **Create client**, type **Web application**.
10. Under **Authorized redirect URIs** add your Railway address plus `/auth/callback`, for example `https://school-info-sheet-production.up.railway.app/auth/callback`.
11. Create it. Copy the **Client ID** and **Client secret** (the secret is shown once; if lost, make a new one).

---

## Part D. Give Railway the settings

12. In Railway, open the service, then **Variables**, and add these four. Type or paste the values only here, never into a chat or email:

    | Variable | Value |
    | --- | --- |
    | `PUBLIC_URL` | your Railway address, starting with `https://`, **no slash at the end** |
    | `ALLOWED_EMAIL_DOMAIN` | `cardinaleducation.com` |
    | `GOOGLE_CLIENT_ID` | from step 11 |
    | `GOOGLE_CLIENT_SECRET` | from step 11 |

    Optional:
    - `ALLOWED_EMAILS`: extra single addresses, comma separated (for people outside the company domain).
    - `CRAWL_PARALLEL_SITES`: how many websites are read at once (default 8).
    - `ASK_ADMIN_EMAILS`: the email of the person who may set the AI key from the **Ask** page (several can be listed with commas). That person signs in, opens **Ask**, and pastes the key into the **AI settings · administrator only** box. Nobody else can see it. If you leave this out, nobody can change the AI settings from the page.
    - `ANTHROPIC_API_KEY`: the other way to switch on the **Ask** page, set here instead of in the box. See `docs/ASK.md` for what data goes to the AI service.
    - `SESSION_DAYS`: how many days a signed-in browser stays logged in via sliding renewal until clicking Sign out (default `30`).
    - `SESSION_SECRET`: 32 or more random characters. If you skip it, one is made and kept on the volume.

13. Railway redeploys. When the deploy shows **Active**, the service is up.

---

## Part E. Check that it works

14. Open `https://YOUR-ADDRESS/healthz`. It should show the word `ok`.
15. Open `https://YOUR-ADDRESS/`. You are sent to Google, then back to the dashboard on the **Start here** page.
16. **Step 1:** choose your School Information Sheet (.xlsx) as you would on your own computer. This needs about 0.5 GB of memory for a moment.
17. **Step 2:** press **Start checking websites**, pick **one** school, and press **Start checking**. A good first school takes about a minute.
18. **Check that saving works:** in Railway press **Redeploy**, wait for **Active**, and open the dashboard again. Your sheet and results must still be there. If they are gone, the volume is not mounted at `/data` (step 5).
19. Optional: in the service **Settings**, set the **Healthcheck Path** to `/healthz` so Railway waits until the program is ready before switching to a new deploy. It must answer a plain 200, which `/healthz` does.

---

## What is different online

- **Times for scheduled checks use the server's clock**, which is normally UTC, not your local time.
- **"Let Windows run the checks in the background" does not apply.** The server runs the schedule by itself, around the clock.
- **A redeploy stops a check in progress.** Choose "Schools not checked yet" and press Start checking again; it carries on.
- **Some school websites may block a server's address** more than your office connection. Those show as "Blocked by site" and are left alone. Compare a few schools with your own computer's results before judging the online version.
- **One check runs at a time**, however many people press the button.
- **Sign-in stays cached across tab/browser closes** for 30 days by default (`SESSION_DAYS`, sliding renewal while active) until you click **Sign out**.
- **Cost:** Railway bills by use (memory, processor, network, the volume). Look at the **Usage** page after a day.
- **Use a separate Slack channel, or leave Slack off, for the test.** Otherwise your own computer and Railway can both announce the same changes.
- **Keep the GitHub repository private** and the list of people with access short. The sign-in protects the running service, not the code.

---

## If something goes wrong

| What you see | What to do |
| --- | --- |
| Deploy Logs say `The program cannot start` | A variable is missing or `PUBLIC_URL` does not start with `https://`. Read the lines under it. |
| Railway says "Dockerfile invalid: docker VOLUME ... is not supported, use Railway Volumes" | Railway refuses the `VOLUME` instruction. It was removed from the `Dockerfile` on 2026-11-17, so commit and push again. Railway also flags the capital word `VOLUME` inside a comment, so keep that word out of the `Dockerfile` completely. The storage is the Railway Volume you add in step 5. |
| The build fails at `npm ci` or at a `COPY` line | Copy the Build Logs lines and send them over. |
| The address says "Application failed to respond" | Open Deploy Logs. If the program is running, add a variable `PORT` with value `8080` and in **Networking** make sure the domain points at port `8080`, then redeploy. The program listens on whatever `PORT` Railway gives it, on all addresses. |
| The deploy keeps being marked unhealthy | If you set a Healthcheck Path, it must be `/healthz` (a plain 200). Railway does not follow redirects, so `/` will fail. |
| Google says `redirect_uri_mismatch` | The redirect address in Google and `PUBLIC_URL` plus `/auth/callback` are not identical. Make them match exactly, including `https` and no trailing slash. Google can take a few minutes to apply the change. |
| "This account is not allowed in" | The account is not in `ALLOWED_EMAIL_DOMAIN` (or `ALLOWED_EMAILS`). Use the company account. With an External app in Testing, the person must also be listed as a Test user. |
| You are sent to Google again and again | Cookies are blocked, or the address in the browser is not exactly `PUBLIC_URL`. |
| A plain "forbidden" message | Open the dashboard from the `PUBLIC_URL` address, not another one. |
| The log says permission denied writing to `/data` | Add the variable `RAILWAY_RUN_UID` with value `0`, then redeploy. (Railway mounts volumes as root; the program normally fixes this itself on start.) |
| Loading the sheet fails or the service restarts | Out of memory. Raise the service's memory limit in Railway, then try again. |

For the longer reference (including Render and a DigitalOcean option) see [ONLINE-SETUP.md](ONLINE-SETUP.md).
