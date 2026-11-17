# The School Info Sheet program, packaged to run on a hosting service.
# Settings come from environment variables (see docs/ONLINE-SETUP.md). Saved data lives in /data: attach a volume there.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    CRAWL_PARALLEL_SITES=8

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Optional Chromium for JS-rendered SPA school sites (pass --build-arg INSTALL_CHROMIUM=1)
ARG INSTALL_CHROMIUM=0
RUN if [ "$INSTALL_CHROMIUM" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates \
      && rm -rf /var/lib/apt/lists/*; \
    fi

COPY config.json ./
COPY src ./src
COPY google-sheet ./google-sheet
COPY deploy ./deploy
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown node:node /data

EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.js", "--no-browser"]
