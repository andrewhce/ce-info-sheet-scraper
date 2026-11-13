# The School Info Sheet program, packaged to run on a hosting service.
# Settings come from environment variables (see docs/ONLINE-SETUP.md). Saved data lives in /data: attach a volume there.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    CRAWL_PARALLEL_SITES=4

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY config.json ./
COPY src ./src
COPY google-sheet ./google-sheet
COPY deploy ./deploy
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown node:node /data

EXPOSE 8080
VOLUME /data
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.js", "--no-browser"]
