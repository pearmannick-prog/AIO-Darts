# Serves the AIO Darts static files behind nginx.
#
# Note: Web Bluetooth still requires a secure context in the browser. If
# you're accessing this over the network (not localhost), put it behind
# HTTPS (e.g. a reverse proxy with a TLS cert) or Chrome/Edge will refuse
# to expose navigator.bluetooth.

FROM nginx:alpine

# Copies every file in the build context (minus what .dockerignore excludes)
# rather than listing each .js file by hand - a new file added to the repo
# now gets included automatically instead of silently 404ing until someone
# remembers to add it here too.
COPY . /usr/share/nginx/html/

# Bakes the exact commit this image was built from into a version.json file,
# so the running app can show a rolling version number that always matches
# what's actually deployed - no manual version bumping. GitHub Actions
# passes the real commit SHA at build time (see docker-build.yml); it
# defaults to "dev" for local/manual builds that don't pass it.
ARG GIT_SHA=dev
ARG BUILD_DATE=unknown
RUN echo "{\"sha\":\"${GIT_SHA}\",\"builtAt\":\"${BUILD_DATE}\"}" > /usr/share/nginx/html/version.json

# Writes config.json (currently just the signaling server URL) from an env
# var at CONTAINER START, not build time - so the same image works for any
# deployment, configured via docker-compose.yml's `environment:` rather than
# needing a rebuild. See docker-entrypoint-config.sh for what it does.
COPY docker-entrypoint-config.sh /docker-entrypoint.d/40-write-config.sh
RUN chmod +x /docker-entrypoint.d/40-write-config.sh

EXPOSE 80
