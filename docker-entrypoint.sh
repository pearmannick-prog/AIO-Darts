#!/bin/sh
# docker-entrypoint.sh - start the app, with replication if it is configured.
#
# REPLICATION IS OPTIONAL, and the unconfigured path must stay boring: with no
# R2 bucket set this exec's node directly and the container behaves exactly as
# it did before Litestream existed. That matters because the same image runs on
# a laptop, a free host with no persistence, and eventually a real one - and a
# missing backup target is not a reason to refuse to serve darts.
set -e

DB="${DATA_DIR:-/app/data}/aio-darts.db"
APP="node public/server/server.js"

if [ -z "${R2_BUCKET}" ]; then
  echo "  replication  : off (R2_BUCKET unset - the database is NOT backed up)"
  exec $APP
fi

echo "  replication  : R2 bucket ${R2_BUCKET}, prefix ${R2_PATH}"

# Restore before starting, but ONLY when there is no local database and there IS
# something to restore from. Those two guards are what make this safe to run on
# every boot: an existing local file is never overwritten by an older replica,
# and a first-ever start with an empty bucket is not an error.
#
# Not fatal on failure. A restore that cannot reach R2 should leave the app
# starting with an empty database - which is what would have happened anyway -
# rather than crash-looping a container that could be serving darts.
if [ ! -f "$DB" ]; then
  echo "  restore      : no local database, checking R2..."
  litestream restore -if-db-not-exists -if-replica-exists -config /app/litestream.yml "$DB" \
    || echo "  restore      : nothing restored (empty replica, or R2 unreachable)"
fi

# replicate -exec runs the app as a CHILD of litestream, which is what makes
# this correct rather than merely convenient: litestream sees the process exit,
# flushes the final WAL segment, and shuts down. Running the two side by side
# would race on shutdown and lose whatever happened after the last sync.
exec litestream replicate -config /app/litestream.yml -exec "$APP"
