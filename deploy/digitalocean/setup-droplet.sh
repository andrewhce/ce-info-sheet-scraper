#!/usr/bin/env bash
# Idempotent setup helper for a fresh Ubuntu 22.04 / 24.04 DigitalOcean Droplet.
# Run as root (or sudo bash deploy/digitalocean/setup-droplet.sh) from the repo root or deploy/digitalocean.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Checking Docker & Compose plugin..."
if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  . /etc/os-release
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

echo "==> Ensuring swap space (protects 1-2 GB Droplets during .xlsx imports)..."
if [ ! -f /swapfile ] && [ "$(free -m | awk '/^Swap:/ {print $2}')" -lt 1024 ]; then
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=progress
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Configuring firewall (SSH 22 + HTTP/HTTPS 80/443 only)..."
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null || true
  ufw allow 80/tcp >/dev/null || true
  ufw allow 443/tcp >/dev/null || true
  ufw allow 443/udp >/dev/null || true
  ufw --force enable >/dev/null || true
fi

if [ ! -f "$SCRIPT_DIR/.env" ]; then
  cp "$SCRIPT_DIR/env.example" "$SCRIPT_DIR/.env"
  chmod 600 "$SCRIPT_DIR/.env"
  echo ""
  echo "Created deploy/digitalocean/.env from env.example."
  echo "Next: fill in APP_DOMAIN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and ANTHROPIC_API_KEY in:"
  echo "  $SCRIPT_DIR/.env"
  echo "Then re-run: sudo bash deploy/digitalocean/setup-droplet.sh"
  exit 0
fi

if grep -Eq 'replace-with-' "$SCRIPT_DIR/.env"; then
  echo "ERROR: deploy/digitalocean/.env still contains placeholder values (replace-with-*)." >&2
  echo "Edit $SCRIPT_DIR/.env first, then re-run this script." >&2
  exit 1
fi

echo "==> Building and starting School Info Sheet + Caddy HTTPS..."
docker compose up -d --build
docker compose ps
echo ""
echo "Done! Check live logs with: docker compose logs -f caddy app"
