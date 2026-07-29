# AIO Darts

An "all-in-one" darts app: local pass-and-play scoring, online 1v1 challenges
over a direct P2P connection, Granboard Bluetooth support with a manual-entry
fallback (so it also works with a plain steel-tip board), and room to grow
from there - camera-based hit detection is on the roadmap.

Everything runs as **one container on one port**. The static front-end and the
WebRTC signaling server are served by the same process, which is what keeps
deployment simple (see [Architecture](#architecture)).

The Bluetooth service UUID and dart-hit decoding table in `granboard.js` are
adapted from the open-source project
[sobassy/gran-app](https://github.com/sobassy/gran-app) (MIT License). Credit
to that project for reverse-engineering the protocol in the first place.

## Requirements

- **Chrome or Edge** on desktop, for real board support. (Web Bluetooth isn't
  supported in Firefox or Safari. Manual entry and the clickable dartboard
  work in any modern browser.)
- Your Granboard powered on and **not** already connected to a phone/tablet -
  BLE devices only accept one active connection at a time.
- **Node.js**, if running locally without Docker.

## Running it locally

**Easiest: double-click `start-aio-darts.bat`.** It installs the one
dependency the first time, starts the server on port 8000, and opens your
browser. Leave the console window open while you play - closing it stops the
server.

By hand, if you prefer:

```
cd server
npm install
cd ..
```

then, from the repo root:

```
PUBLIC_DIR=. PORT=8000 node server/server.js
```

(on Windows `cmd`: `set PUBLIC_DIR=.` and `set PORT=8000` on their own lines
first, then `node server\server.js`)

Open **http://localhost:8000**.

Note you can't just double-click `index.html` - Web Bluetooth requires a
"secure context," which a `file://` page isn't. It has to be served, which is
what the above does.

## Using it

1. Click **Start 501 Game** (edit the player names first if you want).
2. Click **Connect Board** - a browser popup will ask you to pick your
   Granboard from a list of nearby Bluetooth devices. Select it and click
   "Pair"/"Connect".
3. Throw darts - hits should show up automatically, update the score, and
   move a marker on the mini dartboard. You can also just **click directly on
   the mini dartboard** to score that segment - a third input method alongside
   a real board and manual entry, available in both local and online mode.
4. Use **Undo last dart** if a throw gets misread, and the **manual entry**
   section at the bottom to record a miss or fix a misread by hand. It has two
   modes:
   - **Per-Dart** - pick a ring and tap the exact segment hit, one dart at a
     time (what the board's own hits look like too).
   - **Quick Total** - a DartConnect-style numeric keypad for entering a whole
     turn's total in one go (with shortcuts for common totals like 26, 45, 60,
     100, 180). Faster if you already know the turn's total and don't need
     per-dart detail - entering a total always finalizes that whole turn
     immediately, and entering exactly enough to reach 0 is always treated as
     a valid double-out checkout.
5. The board's physical button **ends your turn early** - useful if a dart
   bounces out or misses the board and you don't want to wait for 3 registered
   hits before it's the next player's turn. It doesn't undo anything; only a
   bust reverts score.

## Online 1v1 challenges

The "Online Challenge" tab lets two people, each with their own board, play a
remote 1v1 501 match. Gameplay runs over a **direct peer-to-peer WebRTC
connection** - the signaling server is only involved in the initial handshake
(helping the two browsers find each other and swap connection details), never
in gameplay traffic.

In online mode you have the same three input methods as local play: a real
Bluetooth board, the clickable dartboard, and manual entry (Per-Dart or Quick
Total). None of them requires a board to be connected, so someone with no
Granboard can play a full match against someone using one. The marker on your
board tracks your own darts; the opponent's throws appear in the throw log.

**There is nothing to configure.** The signaling server is part of the same
server serving the page, so the front-end derives its address from whatever
URL you loaded the app on. Load the app over HTTPS and the socket is
automatically `wss://`; over plain HTTP it's `ws://`. Because it's the same
origin, it can never be blocked as mixed content.

A "⚙ Signaling server settings" section still exists, collapsed, in case you
ever want to point players at a signaling server somewhere else entirely.
Leave it alone otherwise - clearing the box restores the automatic value.

### Testing it (two tabs on one machine)

1. Start the app as above.
2. Open **http://localhost:8000** in two separate browser tabs.
3. In tab 1: go to "Online Challenge", click **Create Challenge**, note the
   code shown.
4. In tab 2: enter that code, click **Join Challenge**.
5. Both tabs should show "Connected" and the live scoreboard. Each tab can
   connect its own Granboard (or use manual entry) and take turns.

### Playing with someone else

Whoever's hosting just shares the URL they're serving on - a LAN address for
the same house, or a public domain over HTTPS for the internet. Both players
loading the same URL is all the setup there is; the signaling server comes
along with it.

For internet play, serve it over HTTPS behind a reverse proxy (see
[Docker](#docker)). HTTPS isn't optional for real board support anyway - Web
Bluetooth requires it.

### Known limitations

- **No TURN relay configured by default** - only STUN. STUN is enough for
  most networks: it lets each browser discover its own public address so the
  two can connect directly. But if a player is behind a strict/symmetric NAT
  (some corporate and mobile networks), direct P2P can't be established at
  all and they won't be able to connect. The fix is a TURN server, which
  relays the traffic instead - see [Adding a TURN relay](#adding-a-turn-relay).
- **No anti-cheat** - each side reports its own hits; a modified client could
  lie. Fine for playing with people you trust, not tamper-proof.
- **No matchmaking/accounts** - invite-code only for now. A public
  lobby/ranked queue needs persistent accounts and a real backend.
- Challenge codes are **in-memory and ephemeral** - restarting the server
  drops any in-progress ones. That's by design; a code only needs to live for
  the few seconds it takes two players to connect.
- The physical **end-turn button** works in online mode too - it finalizes
  your turn and tells your opponent's browser to advance, keeping both sides
  in sync.

## Architecture

One Node process (`server/server.js`) does two jobs on a single port:

- serves the static front-end (`index.html` and the `*.js` files)
- serves the signaling WebSocket at `/signaling`

That merge is deliberate. Because the socket lives on the same origin as the
page, deploying needs **no second subdomain, no extra DNS record, no separate
TLS certificate, no path-rewriting rules, and no signaling URL for anyone to
type**. A reverse proxy just forwards the site as it would any static site,
with WebSocket upgrades enabled.

Scoring stays in sync between peers without any rollback/replay machinery:
both browsers run the identical deterministic `resolveThrow` logic from
`scoring.js`. Each side only ever applies hits from its own physical board
locally and forwards them to the peer, which applies them to its model of "the
opponent" using the same rules. WebRTC DataChannels guarantee ordered
delivery, so both sides stay in lockstep.

## Docker

**Important if others will connect over the network:** Web Bluetooth only
works in a "secure context" - HTTPS, or literally `localhost`. A plain
`http://192.168.x.x:8887` address, even on your own home network, does **not**
count, and Chrome will silently make `navigator.bluetooth` unavailable - the
app will report "this browser doesn't support Web Bluetooth" when the real
problem is the missing HTTPS. To let people connect a real board over the
network, put the deployment behind a reverse proxy with a TLS certificate
(Nginx Proxy Manager, Caddy, Traefik, etc.). Manual entry and the clickable
dartboard are unaffected.

There is **one** compose file. The service declares both `image:` and
`build:`, so the same file covers running a published release and building
local changes - no separate dev file to drift out of sync, and git history is
the revert path.

```
docker compose up -d          # run it (pulls the pre-built image)
docker compose pull           # update to the latest published image
docker compose up -d --build  # build from THIS source instead of pulling
```

Open **http://localhost:8887**.

Without compose at all:

```
docker build -t aiodarts .
docker run -p 8887:8080 -v /mnt/user/appdata/aiodarts:/data aiodarts
```

### Persistent data

The compose file bind-mounts a data directory to `/data` in the container.
**Nothing is written there yet** - challenge rooms are deliberately in-memory
and ephemeral. It's mounted now because the accounts/stat-tracking phase puts
a SQLite file there, and SQLite is a plain file, so that phase adds no second
container. Having the mount in place means that becomes a code deploy rather
than a compose edit plus downtime.

The default path (`/mnt/user/appdata/aiodarts`) follows Unraid's appdata
convention. Override it elsewhere with a `.env` file next to the compose file:

```
DATA_PATH=./data
```

The server checks this directory is writable at startup and logs the result,
so a misconfigured mount shows up in `docker compose logs` immediately rather
than the first time someone tries to register. A bad mount is currently a
warning, not a fatal error, since nothing depends on it yet.

### Health check

The container reports health via `GET /healthz`, which returns
`{"ok":true,...}` plus current room and client counts. Compose has a
healthcheck wired to it already, so `docker ps` and Unraid's Docker tab show
health status without extra setup.

### Reverse proxy setup

Point your proxy host at the container's published port (`8887` by default)
exactly as you would for any static site, and **enable WebSocket support**.
That's the entire requirement - there's no second host, path rule, or upstream
to add.

In **Nginx Proxy Manager** that's the "Websockets Support" toggle on the Proxy
Host. Other proxies name it differently (Caddy and Traefik handle it
automatically; hand-written nginx needs the `Upgrade` and `Connection` headers
forwarded).

If challenges connect but drop after a minute of no throws, raise the proxy's
idle/read timeout - the server already sends a keepalive ping every 30s, but
some proxies are stricter than that.

### Optional environment variables

None of these are required; the defaults are correct for a normal deployment.
Set them in `docker-compose.yml` under the `darts` service.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Port inside the container. |
| `STUN_URLS` | Google's public STUN | Comma-separated STUN servers. |
| `TURN_URL` | *(unset)* | TURN relay address - see below. |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | *(unset)* | TURN credentials. |
| `SIGNALING_PATH` | `/signaling` | Path the WebSocket is served on. |
| `SIGNALING_URL` | *(unset)* | Only to point players at a *different* signaling server. Leave unset for same-origin. |

### Adding a TURN relay

Only needed if some players can never connect while others can - the symptom
of a network that refuses direct peer-to-peer. Run a TURN server (coturn is
the usual choice) and set `TURN_URL`, `TURN_USERNAME`, and `TURN_CREDENTIAL`.
No code changes required; the front-end picks the servers up from
`/config.json` on load.

Bandwidth cost is negligible here - a dart throw is a few bytes - so
self-hosting coturn alongside this is cheap, unlike TURN for video calls.

## Continuous integration (GitHub Actions)

`.github/workflows/docker-build.yml` builds the image on every push and pull
request, and pushes to GitHub Container Registry (GHCR) on pushes to `main` or
version tags - not on pull requests, so branches don't clutter the registry.
This is what makes the plain `docker compose up` above work: the image already
exists by the time you run it.

**Image tags it produces:**
- Every push to `main` updates **`latest`** - what `docker-compose.yml` points
  at, so it always tracks the newest code on `main`.
- Pushing a version tag like `v1.0.0` *additionally* publishes `1.0.0` and
  `1.0`, so a specific release stays pinnable even after `latest` moves on.

The image is named `aio-darts-web` for backwards compatibility with existing
deployments. There's only one image - if a separate `aio-darts-signaling`
package still shows under your GHCR packages, it's a leftover from the old
two-container setup and can be deleted there.

**Packages are private by default.** For `docker compose up` to work for
anyone who hasn't run `docker login ghcr.io`, open the package's settings and
change visibility to public (the repo itself can stay private - package
visibility is separate).

`docker-compose.yml` points at `ghcr.io/pearmannick-prog/aio-darts/...` -
update that if your GitHub username or repo name differs.

### Cutting a release (no command line needed)

1. On the repo's main page, click **Releases** (right sidebar) → **Create a
   new release**.
2. Click **Choose a tag**, type a new tag name like `v1.0.0`, and select
   "Create new tag on publish."
3. Give the release a title and optionally describe what changed.
4. Click **Publish release**.

That tag push triggers the workflow, publishing the versioned images
(`1.0.0` / `1.0`) alongside `latest`. Keep pushing normal changes to `main` -
`latest` updates with every change - and cut a new release whenever you want a
pinnable snapshot.

## Version footer

The bottom of the page shows `AIO Darts · build <sha> · <date>`. The Docker
build bakes in the exact git commit it came from (see the root `Dockerfile`
and `version.js`), so it always matches what's actually deployed with no
manual version bumping. Running locally without Docker shows "local dev build"
instead, since there's no build step to bake a commit into.

## Roadmap

- 🎯 **Cricket** - coming soon, alongside 501 (both local and online)
- Persistent stats across sessions (accounts + SQLite, staying single-container)
- Matchmaking and a lobby beyond invite codes
- Native Windows (C#/.NET) version
- Webcam-based hit detection for standard steel-tip boards

Let me know how the current 501 scoring and online matches behave with real
boards, and we'll prioritize from there.
