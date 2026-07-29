#!/bin/sh
# Runs automatically at container startup - this is the official nginx:alpine
# image's own extension mechanism (anything executable in
# /docker-entrypoint.d/ gets run before nginx starts, no custom ENTRYPOINT
# needed). Writes the deployment's signaling server URL - set once via an
# environment variable in docker-compose.yml - into a config.json the
# front-end fetches on load. This is what lets players connect without ever
# typing a signaling URL in: it's set once per deployment, not per player.
set -e

SIGNALING_URL="${SIGNALING_URL:-}"
echo "{\"signalingUrl\":\"${SIGNALING_URL}\"}" > /usr/share/nginx/html/config.json
