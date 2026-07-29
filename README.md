# AIO Darts (web app)

An "all-in-one" darts app: local pass-and-play scoring, online 1v1
challenges over a direct P2P connection, Granboard Bluetooth support with a
manual-entry fallback (so it also works with a plain steel-tip board), and
room to grow from there - camera-based hit detection is on the roadmap.

A browser-based 501 scorer for the Granboard, connecting directly over
Bluetooth from the page - no install required.

The Bluetooth service UUID and dart-hit decoding table in `granboard.js` are
adapted from the open-source project
[sobassy/gran-app](https://github.com/sobassy/gran-app) (MIT License).
Credit to that project for reverse-engineering the protocol in the first
place.

## Requirements

- **Chrome or Edge** on desktop. (Web Bluetooth isn't supported in Firefox or
  Safari.)
- Your Granboard powered on and **not** already connected to a phone/tablet -
  BLE devices only accept one active connection at a time.

## Running it

**Easiest: double-click `start-granboard.bat`** in this folder. It starts a
local server and opens the app in your default browser automatically. Leave
the console window it opens running while you play - closing it stops the
server.

If you'd rather run it by hand (or the shortcut can't find Python/Node on
your machine), here's what it's doing under the hood:

Web Bluetooth requires a "secure context" - it won't work if you just
double-click `index.html` and open it as a `file://` page. You need to serve
it from a tiny local web server instead. Easiest options:

**If you have Python installed** (most Windows machines with dev tools do):

```
cd aio-darts
python -m http.server 8000
```

Then open **http://localhost:8000** in Chrome or Edge.

**If you have Node.js installed instead:**

```
cd aio-darts
npx serve .
```

and open whatever local URL it prints (usually http://localhost:3000).

## Using it

1. Click **Start 501 Game** (edit the player names first if you want).
2. Click **Connect Board** - a browser popup will ask you to pick your
   Granboard from a list of nearby Bluetooth devices. Select it and click
   "Pair"/"Connect".
3. Throw darts - hits should show up automatically, update the score, and
   move a marker on the mini dartboard. You can also just **click directly
   on the mini dartboard** to score that segment - handy as a third input
   method alongside a real board and manual entry (local mode only for
   now).
4. Use **Undo last dart** if a throw gets misread, and the **manual entry**
   section at the bottom to record a miss or fix a misread by hand. It has
   two modes:
   - **Per-Dart** - pick a ring and tap the exact segment hit, one dart at a
     time (what the board's own hits look like too).
   - **Quick Total** - a DartConnect-style numeric keypad for entering a
     whole turn's total in one go (with shortcuts for common totals like
     26, 45, 60, 100, 180). Faster if you already know the turn's total and
     don't need per-dart detail - entering a total always finalizes that
     whole turn immediately, and entering exactly enough to reach 0 is
     always treated as a valid double-out checkout.
5. The board's physical button **ends your turn early** - useful if a dart
   bounces out or misses the board and you don't want to wait for 3
   registered hits before it's the next player's turn. It doesn't undo
   anything; only a bust reverts score.

## Online 1v1 challenges (new)

There's now an "Online Challenge" tab alongside local play. Two people, each
with their own Granboard, can play a remote 1v1 501 match. This works over a
direct peer-to-peer WebRTC connection - a small signaling server is only used
for the initial handshake (finding each other and exchanging connection
info), not for the actual gameplay traffic.

### Running the signaling server

**Easiest: double-click `start-signaling-server.bat`** inside the
`signaling-server` folder. It installs dependencies the first time (needs
Node.js), then starts the server on port 8080. Leave the console window
open while people are playing.

If you'd rather run it by hand:

```
cd signaling-server
npm install
npm start
```

By default it listens on port 8080. Leave it running.

### Testing it (easiest: two tabs on one machine)

1. Start the signaling server as above.
2. Open the app (`http://localhost:8000`) in two separate browser tabs.
3. In tab 1: go to "Online Challenge", leave the signaling URL as
   `ws://localhost:8080`, click **Create Challenge**, note the code shown.
4. In tab 2: same tab, enter that code, click **Join Challenge**.
5. Both tabs should show "Connected" and the live scoreboard. Each tab can
   connect its own Granboard (or use manual entry) and take turns.

### Playing with someone else (same house / same Wi-Fi)

Run the signaling server on one PC, then have the other player point their
"Signaling server URL" field at `ws://<that PC's LAN IP>:8080` (e.g.
`ws://192.168.1.42:8080`) instead of localhost.

### Playing over the internet

The signaling server needs to be reachable by both players, so it needs to
be deployed somewhere public - a free tier on Render, Railway, Fly.io, or
similar works fine, since it's a tiny, low-traffic WebSocket relay. Point
both players' "Signaling server URL" field at `wss://your-deployed-url`
(note `wss://`, not `ws://`, once it's served over HTTPS).

### Known limitations (v1)

- **No TURN relay** - only STUN is configured, so if either player is behind
  a strict/symmetric NAT (common on some corporate or mobile networks), the
  direct P2P connection may fail to establish. Adding a TURN server (a relay
  of last resort) is the fix, but usually costs money to run reliably - a
  reasonable next step if this becomes a problem in practice.
- **No anti-cheat** - each side reports its own hits; a modified client
  could lie. Fine for playing with people you trust, not tamper-proof.
- **No matchmaking/accounts** - it's invite-code only for now. A public
  lobby/ranked queue would need persistent accounts and a real backend,
  which is a much bigger addition.
- The physical **end-turn button** on the board works in online mode too -
  it finalizes your turn and tells your opponent's browser to advance,
  keeping both sides in sync.

## Docker

There are two ways to run this in Docker, depending on whether you're
playing or developing:

**Just want to run it (no build step):**

```
docker compose up
```

This uses `docker-compose.yml`, which pulls the pre-built images GitHub
Actions already published to GHCR - nothing gets built on your machine.
Then open **http://localhost:8000** and point "Signaling server URL" at
`ws://localhost:8080`.

**Changing the code and want to test your changes:**

```
docker compose -f docker-compose.dev.yml up --build
```

This builds fresh images from the source in this repo instead of pulling
from GHCR.

Individually, without compose at all:

```
docker build -t aio-darts-web .
docker run -p 8000:80 aio-darts-web

docker build -t aio-darts-signaling ./signaling-server
docker run -p 8080:8080 aio-darts-signaling
```

Note: this repo was put together and syntax/structurally-checked from an
environment without Docker installed, so the actual `docker build`/`docker
compose up` commands above haven't been run end-to-end by me - that first
real test is on you (or CI, see below). If something doesn't build cleanly,
the error output will say exactly what's wrong and it's likely a one-line
fix.

## Continuous integration (GitHub Actions)

`.github/workflows/docker-build.yml` builds both images on every push and
pull request, and pushes them to GitHub Container Registry (GHCR) on pushes
to `main` or version tags (`v1.0.0`, etc.) - not on pull requests, so
random branches don't clutter the registry. This is what makes the plain
`docker compose up` above possible - by the time you run it, the images
already exist on GHCR, built by CI, not by whoever's running the app.

**Image tags it produces:**
- Every push to `main` updates the **`latest`** tag - this is what
  `docker-compose.yml` points at, so it always tracks the newest code on
  `main`.
- Pushing a version tag like `v1.0.0` (see "Cutting a release" below)
  *additionally* publishes that exact version - `1.0.0` and `1.0` - so a
  specific release stays pinnable/pullable even after `latest` moves on.

To use it:

1. Create a new repo on GitHub (this folder is already a local git repo on
   the `main` branch with one commit).
2. `git remote add origin <your-repo-url>` then `git push -u origin main`.
3. Go to the repo's **Actions** tab on GitHub - the workflow should run
   automatically and build both images. No extra setup or secrets needed;
   it authenticates to GHCR using GitHub's built-in token.
4. Once it succeeds, the images show up under your GitHub profile's
   **Packages** tab, as `ghcr.io/<you>/<repo>/aio-darts-web` and
   `.../aio-darts-signaling`.
5. **They're private by default.** For `docker-compose.yml` to work for
   anyone besides you without a `docker login ghcr.io` first, open each
   package's settings and change visibility to public, or add specific
   people under "Manage Actions access" (the repo itself can stay private -
   package visibility is separate). Note that collaborators with repo
   access can inherit package access automatically too.
6. `docker-compose.yml` currently points at
   `ghcr.io/pearmannick-prog/aio-darts/...` - update that if your GitHub
   username or repo name differs.

### Cutting a release (no git command line needed)

1. On the repo's main page, click **Releases** (right sidebar) → **Create a
   new release**.
2. Click **Choose a tag**, type a new tag name like `v1.0.0`, and select
   "Create new tag on publish."
3. Give the release a title (e.g. "v1.0.0 - first playable version") and
   optionally describe what changed.
4. Click **Publish release**.

That tag push triggers the workflow automatically, which builds and
publishes the versioned images (`1.0.0` / `1.0`) alongside `latest`. From
then on, keep pushing normal changes to `main` - `latest` keeps updating
with every change, and you cut a new release (`v1.1.0`, `v2.0.0`, etc.)
whenever you want a stable, pinnable snapshot for deploying somewhere.

## Roadmap

- 🎯 **Cricket** - coming soon, alongside 501 (both local and online)
- Persistent stats across sessions
- Matchmaking beyond invite codes
- Native Windows (C#/.NET) version
- Webcam-based hit detection for standard steel-tip boards

Let me know how the current 501 scoring and online matches behave with real
boards, and we'll prioritize from there.
