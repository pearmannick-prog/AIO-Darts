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

# Node 24 for two reasons: `node:sqlite` (the accounts database, with no npm
# dependency to compile) needs 22.5+, and 24 is what this is developed and
# tested against locally, so the deployed runtime is the tested one.
FROM node:24-alpine

WORKDIR /app

# Litestream, for continuous replication of the SQLite file to object storage.
# See litestream.yml and docker-entrypoint.sh - it does nothing at all unless
# R2_BUCKET is set, so this costs an unconfigured deployment one binary and no
# behaviour.
#
# TARGETARCH is set by BuildKit, so this works for an arm64 image as well as
# amd64 - which matters, because a free ARM VM is one of the hosts this is
# meant to be movable to. Litestream names its assets x86_64 rather than amd64.
ARG LITESTREAM_VERSION=0.5.15
ARG TARGETARCH
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) LS_ARCH=x86_64 ;; \
      arm64) LS_ARCH=arm64 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    wget -qO /tmp/litestream.tar.gz \
      "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-${LS_ARCH}.tar.gz"; \
    tar -C /usr/local/bin -xzf /tmp/litestream.tar.gz litestream; \
    rm /tmp/litestream.tar.gz; \
    litestream version

# Dependencies first so this layer stays cached unless package*.json changes.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# Copies the whole build context (minus what .dockerignore excludes) rather
# than listing each .js file by hand, so a new file added to the repo is
# included automatically instead of silently 404ing until someone remembers to
# update this line.
#
# The server is NOT copied separately to /app any more. It used to be, and that
# flattening is exactly what broke once the server started importing a module
# from the repo root: statsengine.js is shared by the browser and the server so
# the two can never disagree about what an average is, and `../statsengine.js`
# has to mean the same thing here as it does in a source checkout. Because this
# COPY already brings server/ along with everything else, running the server
# from inside public/ makes the image a mirror of the repo and the import
# resolves identically in both.
#
# `ws` still resolves: Node walks up from /app/public/server/ and finds
# /app/node_modules.
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

# Where the SQLite database lives. IMPORTANT: this is inside the container, so
# on a host with an ephemeral filesystem every account is deleted on each
# deploy. Mount a volume here (docker compose does) or point DATA_DIR at a
# persistent disk. The app still serves darts if this is unwritable - it logs
# loudly, reports accounts:false on /healthz, and carries on.
ENV DATA_DIR=/app/data

# Runs as an unprivileged user, not root.
#
# This matters most for the deployment this project is most likely to have: a
# container on somebody's own desktop or NAS, exposed to the internet. Root in
# a container is not root on the host, but it is one kernel bug or one careless
# `--privileged` away from being exactly that - and unlike a cloud VM, the host
# here is the machine with the owner's personal files on it.
#
# `node` (uid/gid 1000) already exists in the official image. DATA_DIR is
# created and handed over at build time, because the running process no longer
# has the rights to create it under /app.
#
# A BIND MOUNT overrides all of this: the host directory's ownership is what
# applies, so it must be readable and writable by uid 1000 -
#   sudo chown -R 1000:1000 /path/on/host
# or set `user:` in compose to match whoever owns it. If you get this wrong the
# app does not crash: it logs that DATA_DIR is unusable, reports
# accounts:false, and keeps serving darts.
RUN mkdir -p /app/data && chown -R node:node /app/data

# The replication config and launcher, at /app rather than only inside
# public/. The COPY above puts a copy of everything in the web root, so these
# two are removed from there - they are templates rather than secrets, but a
# config file and a launch script are not part of the site and there is no
# reason to serve them.
COPY litestream.yml /app/litestream.yml
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh \
    && rm -f /app/public/litestream.yml /app/public/docker-entrypoint.sh

USER node

EXPOSE 8080

# Starts the app directly when replication is unconfigured, and under
# litestream when it isn't. See docker-entrypoint.sh.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
