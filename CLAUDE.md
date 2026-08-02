# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A zero-build-step darts app: plain ES modules served as static files, plus one small
Node server. There is no bundler, transpiler, or linter. Editing a `.js` file at the
repo root and refreshing the browser is the entire dev loop.

There is one test file, `server/statsengine.test.js` (`node --test`), covering the
pure statistics arithmetic and nothing else. That is deliberate: a scoring bug shows
up immediately on a board you are looking at, but a checkout percentage that is five
points too high looks exactly like one that is right, for months.

## Commands

Run locally (Windows): double-click `start-aio-darts.bat` — installs `ws` on first
run, serves the repo root on port 8000, opens a browser.

By hand:

```
cd server && npm install && cd ..
PUBLIC_DIR=. PORT=8000 node server/server.js     # bash
```

```
$env:PUBLIC_DIR="."; $env:PORT="8000"; node server\server.js   # PowerShell
```

`PUBLIC_DIR` must point at the repo root — the front-end lives there, not in a build
directory. Opening `index.html` via `file://` does not work: Web Bluetooth needs a
secure context (HTTPS or `localhost`).

Docker:

```
docker compose up -d            # pull + run published image  (http://localhost:8887)
docker compose up -d --build    # build from this source instead
```

Health probe: `GET /healthz` → `{"ok":true,rooms,clients,accounts}`. `accounts` is
false when the database could not be opened; `ok` stays true, because the app can
still serve darts.

Statistics tests: `node --test server/statsengine.test.js`.

`DATA_DIR` (default `./data`) holds the SQLite database. It must be persistent -
see the note in `render.yaml`.

Testing online play needs no second machine: open `http://localhost:8000` in two
tabs, Create Challenge in one, paste the code into the other.

## Architecture

**One process, one port.** `server/server.js` serves both the static front-end and
the signaling WebSocket (`/signaling`). This is deliberate — same origin means no
second DNS record/TLS cert, no mixed-content problem, and nothing for a player to
configure. Don't split these back apart. The server never sees gameplay traffic; it
relays WebRTC offer/answer/ICE between the ≤2 sockets in an in-memory room, then
drops out. Rooms are intentionally ephemeral (lost on restart).

**`/config.json` is generated per-request from env vars** (`STUN_URLS`, `TURN_URL`,
`SIGNALING_URL`, …) — it is not a file in the repo, and adding TURN requires no code
change. `version.json` is written by the Dockerfile with the build's git SHA; absent
locally, so the footer falls back to "local dev build".

**Determinism is the sync strategy.** There is no rollback/replay, no authoritative
server. Both browsers run the identical pure functions and stay in lockstep because
WebRTC DataChannels deliver in order. Each side applies its own board's hits locally
and forwards them; the peer applies them to its model of "the opponent".

The pure, side-effect-free rules layer — keep it that way, and never fork a second
copy of these rules for online mode:

- `scoring.js` — `resolveThrow(remainingBefore, segment, {inRule, outRule, opened})`
  is the whole of x01. In/out variants (`double`/`siso`/`dido`/`master`) live in
  `X01_RULES`.
- `cricket.js` — marks, closing, dead targets, win condition.
- `medley.js` — match = ordered list of legs. **A single game is a one-leg match**;
  there is no separate single-game code path. A leg is `{game:"x01",score,rules}` or
  `{game:"cricket"}`; `normalizeLeg` accepts legacy bare strings.

Shared UI components, extracted specifically so local and online modes cannot drift:
`dartboard.js` (clickable SVG board + marker), `cricketboard.js` (DartConnect-style
mark pad), `quickentry.js` (whole-turn-total keypad), `medleybuilder.js` (format
picker; a factory, not a singleton, because the page renders two instances).

`granboard.js` owns Web Bluetooth and the raw-bytes→`SegmentID` table (adapted from
sobassy/gran-app, MIT — keep the attribution). `SegmentType` doubles as the
multiplier (1/2/3), which several rule functions rely on.

The two top-level controllers are `game.js` (local pass-and-play) and `online.js`
(WebRTC 1v1); both are loaded on every page load and wire up their own half of
`index.html`. All three input paths — real board, clickable board, manual entry —
converge on the same segment objects before touching scoring code.

**Ring→segment-ID slot convention** (`0=inner single, 1=triple, 2=outer single,
3=double`) is duplicated in `granboard.js`'s `SegmentID`, `dartboard.js`'s band
definitions, and `manualSegmentFromRing` in both `game.js` and `online.js`. Changing
it means changing all of them.

**Peer message protocol** (`online.js`, over the DataChannel): `hello` →
`match_config` (host sends legs; guest adopts them, otherwise the two sides could
play different games) → `dart`, `quick_total`, `end_turn`, `next_leg`. Host is
player index 0, guest 1, on both sides. x01, cricket, and medleys all work online.
`end_match` tears both sides down (sent *before* closing, or there's no channel
left to send it on). `media_state` also rides the channel but is intercepted in
`webrtc.js` and never reaches `online.js`'s `onMessage` — game code doesn't know
about it.

**Camera/mic uses pre-negotiated, initially empty transceivers.** `webrtc.js`
calls `addTransceiver("audio"/"video", {direction:"sendrecv"})` before the one
and only offer (host) and flips the auto-created ones to `sendrecv` before the
answer (guest); `startMedia()` later fills them via `replaceTrack()`, which by
spec needs no renegotiation. This is why there is no perfect-negotiation
/glare/rollback code anywhere — don't "fix" it by adding tracks on demand, which
would reintroduce all of it, since either player can start a camera at any time.
The accepted cost is a/v m-lines in every match's SDP even when unused.
`close()` must keep stopping local tracks or the webcam light stays on.

The pre-match **device check** (`online.js`, setup panel) deliberately does not
go through `PeerLink` — there isn't one before you create/join, and coupling a
hardware check to a live connection would mean the only way to test a camera is
to start a match. It holds its own stream and must release it on create/join and
on collapsing the panel. Device choices persist in `localStorage` as
`granboard-camera-id` / `granboard-mic-id` and are passed to `startMedia()`.
Stale IDs are expected: the check walks a ladder dropping one preference at a
time so a dead webcam doesn't wipe a good mic preference; `startMedia()` does the
coarser "drop both" retry. The mic meter's `AudioContext` needs an explicit
`resume()` — it's created after an `await`, so the click's user activation may be
gone, and a suspended context reads as silence.

`switchCamera()` stops the old video track **before** requesting the new one.
That looks backwards but is required: much Android hardware won't open the rear
camera while the front is still held (`NotReadableError`). It restores the
previous camera if the new request fails. Self-view mirroring is off only for
`facingMode === "environment"` — an unknown facingMode (most desktop webcams)
still mirrors.

`sw.js` is **network-first on purpose**. Cache-first would serve stale JS after a
deploy. Adding a new front-end file means adding it to `PRECACHE`. It also
**never caches `/api/*`** — a stored `/api/auth/me` would show the previous
session's user after a sign-out, and letting those requests fail offline is what
makes the app fall back to guest play correctly.

## Accounts, statistics and leaderboards

Optional and additive: **guests play exactly as they always have**. The account
tab and header chip do not render at all until the app confirms there is an
accounts API behind it, so the Android APK (no server) and any deployment with
the database switched off are unaffected.

`server/server.js` now also mounts `/api/*` (`server/api.js`) before static
serving. If the database cannot be opened the server does **not** exit — it logs
loudly, reports `accounts:false` on `/healthz`, and answers `/api/*` with 503.
Crashing would stop people playing darts over a feature darts does not need.

**Storage is SQLite via the built-in `node:sqlite`** — zero new npm dependencies,
which is why the image is `node:24-alpine`. `server/db.js` runs `.sql` migrations
from `server/migrations/` in filename order; an applied migration is never
edited, new schema is always a new file. Note that `node:sqlite` refuses to bind
a JS boolean or `undefined`, hence the `bool()` / `orNull()` helpers.

**Every dart is recorded, and everything else is derived from it.**
`matchrecorder.js` is fed by both `game.js` and `online.js` — shared for the same
reason `dartboard.js` is — and produces one JSON document per finished match,
shaped like the tables it lands in. Its `capture()`/`restore()` ride inside the
controllers' existing undo snapshots, so undo can never desync the record. Only
*finished* matches are saved; an abandoned one is dropped.

**`statsengine.js` is pure and imported by BOTH the browser and the server.**
That is what lets a guest see real statistics computed on-device from the local
queue, and guarantees `/api/stats` cannot drift from what the browser shows. It
is also why the Dockerfile runs `public/server/server.js`: the image mirrors the
repo so `../statsengine.js` resolves identically in both.

**Statistics, achievements and leaderboards are modular by game.** The core owns
matches, wins, streaks and time; each game contributes a module in `stats/`
declaring its own `metrics`, `boards` and `achievements`. Adding Around the Clock
means writing its rules module and a stats module beside it and registering it —
**no schema change, no migration**, and the stats page, dashboard, achievements
screen and leaderboard picker all grow an entry on their own because they iterate
the registry. Game-specific per-visit detail rides in `turns.game_json`, never in
a column.

Bump `ENGINE_VERSION` when a definition changes what a number *means*. The server
stamps it into `stats_cache` and treats a mismatch as a miss, so a formula fix
reprices everyone's history rather than leaving stale numbers behind;
`server/leaderboard.js` rebuilds a few stale rows per request so boards refill
themselves instead of emptying until each player happens to look.

Definitions that are judgement calls are documented next to the number they
produce, and several depend on the leg's rules rather than being constants — the
checkout ceiling is 170 under double out but **180 where a treble can finish**
(`highestCheckout` in `scoring.js`), and doubles are only counted in legs whose
out rule requires one.

Leaderboards rank **self-reported** scores — a peer-to-peer app with no referee
cannot prove a match happened, the UI says so, and appearing is opt-in.

`DATA_DIR` must be persistent. On an ephemeral filesystem (Render's free tier)
every account is deleted on each deploy — see the long note in `render.yaml`.

## Conventions worth preserving

- Comments in this codebase explain *why*, often at length, and frequently record a
  trade-off that was considered and rejected. Match that register; don't strip them.
- File lists are avoided where possible: the Dockerfile copies the whole context and
  the Android workflow excludes rather than includes, so a new root `.js` file is
  picked up automatically. Prefer exclusion-based lists when adding one is
  unavoidable (`sw.js`'s `PRECACHE` and the workflow's verify step are the
  exceptions that must be updated by hand - a new front-end file, including a new
  `stats/*.js` module, goes in both).
- Solo (one-player) play is supported in both games and must keep working.
- Edge cases the rules deliberately encode: leaving exactly 1 busts under double/
  master out but is legal under SISO; under double-in, pre-opening darts count as
  darts but score nothing; cricket closing-out while behind on points does not win;
  a quick-total entry finalizes the whole turn and reaching exactly 0 always counts
  as a valid checkout.

## CI

`docker-build.yml` builds on every push/PR, publishes to GHCR only on `main` and
version tags (`latest`, plus `1.0.0`/`1.0` for a `v1.0.0` tag). `android-build.yml`
wraps the front-end with Capacitor into a debug APK artifact (local play only — no
Bluetooth or online). It assembles `www/` by copying the repo minus infrastructure,
then hard-fails if an expected front-end file is missing.
