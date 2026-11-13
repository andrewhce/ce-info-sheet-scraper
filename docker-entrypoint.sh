#!/bin/sh
# Hosting services mount the data volume owned by root. Fix its owner, then run the program as the unprivileged "node" user.
set -e
mkdir -p "${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "${DATA_DIR:-/data}" 2>/dev/null || true
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
