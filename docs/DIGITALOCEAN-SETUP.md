# Running Online on a DigitalOcean Droplet

This bundle runs the full **School Info Sheet** dashboard online with:

- **Google Workspace Sign-In** (only `@cardinaleducation.com` accounts get in)
- **Automatic HTTPS** via Caddy + Let's Encrypt
- **Persistent `/data` volume** (keeps your uploaded `.xlsx`, scraped results, cache, saved memories, chat sessions, and auto-learned `agent-kb.json` across restarts and updates)
- **Locked Ask AI costs** (**Claude Sonnet 5.5 + Medium effort** by default, plus optional `ASK_MONTHLY_CAP_USD=5`)

All ready-to-use server files live in [`deploy/digitalocean/`](../deploy/digitalocean/):
`docker-compose.yml`, `Caddyfile`, `env.example`, and `setup-droplet.sh`.

---

## Step 1. Create a DigitalOcean Droplet

1. In DigitalOcean, click **Create -> Droplets**.
2. **OS:** Ubuntu **24.04 LTS** (or 22.04 LTS).
3. **Plan:** **Basic**, Regular SSD, **2 GB RAM / 1 vCPU** (loading the `.xlsx` workbook briefly needs ~0.5 GB RAM, plus Chromium/scraping).
4. **Region:** San Francisco (`SFO3`) or any US region close to your team.
5. **Authentication:** SSH key (recommended) or strong root password.
6. Copy the Droplet's public **IPv4 address** once created.

*(Avoid DigitalOcean App Platform for this app as-is: App Platform does not keep a persistent `/data` disk across redeploys.)*

---

## Step 2. Pick a Free HTTPS Hostname (No New Domain Purchase Needed)

Because Google Sign-In and Let's Encrypt HTTPS certificates require a real hostname (raw `http://DROPLET_IP` is blocked by [`src/auth.js`](../src/auth.js) and rejected by Google OAuth redirect URIs), choose one of these two \$0 options:

### Option A (Best): Add one subdomain under `cardinaleducation.com`
In your existing DNS / cPanel Zone Editor for `cardinaleducation.com`:
- **Type:** `A`
- **Name / Host:** `schools` (creates `schools.cardinaleducation.com`)
- **Points to / IPv4:** your Droplet's IP address
- **TTL:** Auto / 300 seconds

### Option B (Free standalone): Use DuckDNS while testing
If you cannot edit `cardinaleducation.com` DNS yet:
1. Go to [duckdns.org](https://www.duckdns.org), sign in, and claim a subdomain such as `ce-school-sheet` (`ce-school-sheet.duckdns.org`).
2. Paste your Droplet's IPv4 address into DuckDNS and click **update ip**.

*(Wait 1–2 minutes until `ping YOUR_APP_DOMAIN` resolves to your Droplet's IP.)*

---

## Step 3. Create Google Workspace OAuth Credentials

Inside [console.cloud.google.com](https://console.cloud.google.com) (using a company `@cardinaleducation.com` Workspace account):

1. Create or select a project (e.g., `School Info Sheet`).
2. Open **Google Auth Platform** -> **Branding / Audience**:
   - App name: `School Info Sheet`
   - Audience: **Internal** (restricts login strictly to your Google Workspace org)
3. Open **Clients** -> **Create client** -> **Web application**:
   - **Name:** `School Info Sheet DigitalOcean`
   - **Authorized redirect URIs:**
     `https://YOUR_APP_DOMAIN/auth/callback`
     *(Example: `https://schools.cardinaleducation.com/auth/callback`)*
4. Save the **Client ID** and **Client secret**.

> **Need Allen or IT to add DNS or approve Google Cloud OAuth?** Send them:
> *"Can we point an `A` record `schools.cardinaleducation.com` -> `YOUR_DROPLET_IP`, and create an Internal Google OAuth Web Client with redirect URI `https://schools.cardinaleducation.com/auth/callback`?"*

---

## Step 4. Deploy onto the Droplet

1. Push your project to a **private** GitHub repo (`.gitignore` already excludes `data/`, `dist/`, and `.env` secrets), then SSH into the Droplet:

```bash
ssh root@YOUR_DROPLET_IP
git clone https://github.com/YOUR_ORG/school-info-scraper.git /opt/school-info-scraper
cd /opt/school-info-scraper
cp deploy/digitalocean/env.example deploy/digitalocean/.env
chmod 600 deploy/digitalocean/.env
nano deploy/digitalocean/.env
```

2. Fill in `APP_DOMAIN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `ANTHROPIC_API_KEY` inside `deploy/digitalocean/.env`, then save and exit.
3. Run the Droplet setup script (installs Docker if needed, configures UFW firewall `22/80/443`, adds 2 GB swap, builds the container with Chromium + Node 22, and starts Caddy auto-HTTPS):

```bash
bash deploy/digitalocean/setup-droplet.sh
```

4. Wait ~20 seconds for Caddy to fetch the TLS certificate, then visit `https://YOUR_APP_DOMAIN`.

---

## Step 5. Move Your Existing Local Schools & Results Online (Optional)

You do **not** need to re-scrape schools you already scraped on your Windows PC:

1. On your local `http://localhost:4477` **Start here** tab, click **Save my results for teammates (.zip)** to download a results bundle.
2. Open your live online dashboard `https://YOUR_APP_DOMAIN`, sign in with Google:
   - Upload your `.xlsx` file on **Start here**.
   - Upload that `.zip` bundle on **Start here** -> **Add a teammate's results**.

All 31+ already-scraped schools appear immediately online.

---

## Updating, Checking Logs & Backups

Run these inside `/opt/school-info-scraper/deploy/digitalocean`:

- **Check health & logs:** `docker compose ps` and `docker compose logs -f caddy app`
- **Pull latest updates safely (keeps `/data` untouched):**
  ```bash
  cd /opt/school-info-scraper && git pull
  cd deploy/digitalocean && docker compose up -d --build
  ```
- **Back up `/data` volume:**
  ```bash
  docker run --rm -v digitalocean_school_data:/data -v "$PWD":/backup alpine \
    tar czf "/backup/school-data-$(date +%F).tar.gz" -C /data .
  ```
