# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A zero-build-step darts app: plain ES modules served as static files, plus one small
Node server. There is no bundler, transpiler, test suite, or linter. Editing a `.js`
file at the repo root and refreshing the browser is the entire dev loop.

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

Health probe: `GET /healthz` → `{"ok":true,rooms,clients}`.

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
`media_state` also rides the channel but is intercepted in `webrtc.js` and never
reaches `online.js`'s `onMessage` — game code doesn't know about it.

**Camera/mic uses pre-negotiated, initially empty transceivers.** `webrtc.js`
calls `addTransceiver("audio"/"video", {direction:"sendrecv"})` before the one
and only offer (host) and flips the auto-created ones to `sendrecv` before the
answer (guest); `startMedia()` later fills them via `replaceTrack()`, which by
spec needs no renegotiation. This is why there is no perfect-negotiation
/glare/rollback code anywhere — don't "fix" it by adding tracks on demand, which
would reintroduce all of it, since either player can start a camera at any time.
The accepted cost is a/v m-lines in every match's SDP even when unused.
`close()` must keep stopping local tracks or the webcam light stays on.

`sw.js` is **network-first on purpose**. Cache-first would serve stale JS after a
deploy. Adding a new front-end file means adding it to `PRECACHE`.

## Conventions worth preserving

- Comments in this codebase explain *why*, often at length, and frequently record a
  trade-off that was considered and rejected. Match that register; don't strip them.
- File lists are avoided where possible: the Dockerfile copies the whole context and
  the Android workflow excludes rather than includes, so a new root `.js` file is
  picked up automatically. Prefer exclusion-based lists when adding one is
  unavoidable (`sw.js`'s `PRECACHE` and the workflow's verify step are the
  exceptions that must be updated by hand).
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
