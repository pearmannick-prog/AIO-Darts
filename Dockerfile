# AIO Darts - single image, single port.
#
# Serves the static front-end AND the signaling WebSocket from one Node
# process on one port (see server/server.js for why). This replaces the old
# split nginx-web + separate-signaling-container setup: it means a reverse
# proxy only ever needs one proxy host, with WebSocket upgrades enabled, and
# players never configure a signaling URL.
#
# Note: Web Bluetooth requires a secure context in the browser. Accessing
# this over the network (not localhost) needs HTTPS - e.g. a reverse proxy
# with a TLS cert - or Chrome/Edge will refuse to expose navigator.bluetooth.

FROM node:20-alpine

WORKDIR /app

# Dependencies first so this layer stays cached unless package*.json changes.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

COPY server/server.js ./

# Copies the front-end into public/. Copying the whole build context (minus
# what .dockerignore excludes) rather than listing each .js file by hand means
# a new file added to the repo is included automatically instead of silently
# 404ing until someone remembers to update this line.
COPY . ./public/

# Bakes the exact commit this image was built from into version.json, so the
# running app can show a rolling version number that always matches what's
# actually deployed - no manual version bumping. GitHub Actions passes the
# real commit SHA at build time (see .github/workflows/docker-build.yml); it
# defaults to "dev" for local/manual builds that don't pass it.
ARG GIT_SHA=dev
ARG BUILD_DATE=unknown
RUN echo "{\"sha\":\"${GIT_SHA}\",\"builtAt\":\"${BUILD_DATE}\"}" > /app/public/version.json

ENV PUBLIC_DIR=/app/public
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
