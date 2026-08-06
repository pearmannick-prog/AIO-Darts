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

`DATA_DIR` (default `./data`) holds the SQLite database. It must be persistent -
see the note in `render.yaml`.

`ACCOUNTS=off` disables the accounts half deliberately, without opening a
database. This exists because "no disk" and "no accounts" are different states
and the difference is dangerous: an ephemeral filesystem lets the database open
fine, so the app takes sign-ups and then deletes them. Unset means "try", so
every existing deployment is unaffected. Tests: `/healthz` reports
`accounts:false`, `/api/*` 503s, the lobby doesn't start.

Tests: `node --test server/dartnotation.test.js server/statsengine.test.js
server/checkout.test.js server/matchrecorder.test.js`.

**Password reset is the only mail this app sends, and it works with no mail
provider.** `server/email.js` posts to Resend when `EMAIL_API_KEY`, `EMAIL_FROM`
and `PUBLIC_URL` are all set, and otherwise LOGS the reset link. That is not a
degraded mode - it is what makes the feature work on a self-hosted box from day
one, and what makes the flow testable without sending anything. Tokens are
stored as a SHA-256 hash (they travel in email, so a stolen database must not
yield live links), last an hour, work once, and redeeming one deletes every
session for that user.

Note the enumeration asymmetry: `/api/auth/forgot` answers identically for
known and unknown addresses, but `/api/auth/register` still returns 409 for a
taken email, so addresses can be probed there. Throttling register is the
change that would fix it - login already has a throttle (`ATTEMPT_LIMIT`),
register does not.

`SITE_PASSWORD` (unset by default) puts one shared password in front of the whole
deployment. Used on the test build; leave unset in production.

Testing the lobby needs two DIFFERENT accounts, and two browser tabs will not do
it - they share a cookie jar, so signing in as the second player signs the first
one out. Drive it with two `ws` clients carrying different session cookies, or use
two browser profiles.

Testing online play needs no second machine: open `http://localhost:8000` in two
tabs, Create Challenge in one, paste the code into the other.

## Architecture

**One process, one port.** `server/server.js` serves the static front-end, the
signaling WebSocket (`/signaling`), the lobby WebSocket (`/lobby`) and the `/api/*`
surface. This is deliberate — same origin means no second DNS record/TLS cert, no
mixed-content problem, and nothing for a player to configure. Don't split these back
apart. Signaling still never sees gameplay traffic; it relays WebRTC
offer/answer/ICE between the ≤2 sockets in an in-memory room, then drops out. Those
rooms are intentionally ephemeral (lost on restart).

**Both WebSockets are `noServer`, with one `upgrade` listener routing by path.**
This is not a style choice and must not be "simplified" back. A `WebSocketServer`
created with `{server, path}` installs its own upgrade listener and *destroys* any
upgrade whose path it doesn't recognise — so two of them on one HTTP server means
whichever attached first silently hangs up on the other's connections. It presents
as a bare `WebSocket error` in the browser and *nothing at all* in the server log.

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
  is the whole of x01. `X01_RULES` is the full 3×3 in/out matrix (open/double/master
  each way), because the machines let you pick any combination. The four original
  keys keep their exact meaning so recorded matches still read correctly.
  **Both `master` rules include the bullseye**, and both test `section === "BULL"`
  rather than the segment type — the OUTER bull is a *single* in this codebase's
  model, so a type check silently rejects a legitimate 25 finish.
  `highestCheckout()` and `isOneDartFinish()` live here too: the checkout ceiling
  is 170 under double out but **180** where a treble can finish, and getting that
  wrong quietly mis-scores every checkout statistic.
- `cricket.js` — marks, closing, dead targets, win condition.
- `bermuda.js` — Bermuda Triangle. Thirteen rounds in a FIXED, interleaved order
  (12, 13, 14, Any Double, 15, 16, 17, Any Triple, 18, 19, 20, Any Bull, Double
  Bull) — not the numbers grouped together, which changes how the game plays.
  Missing a round with all three darts halves the score, decided when the round
  ends because "all three missed" is not a fact any single dart knows. Pinned to
  split bull: full-bull promotes the outer bull to the inner, which would collapse
  the last two rounds into one.
- `rating.js` — the 1–20 rating and its C→GM ranks. **One table, looked up twice.**
  The 80% and 100% views are not two scales; the thresholds are identical and only
  the average differs, which is why the same player can be an M on 80% and a B on
  100%. The table is data in one array; `combineRatings` is the only judgement in
  the file and is isolated for that reason.
- `medley.js` — match = ordered list of legs. **A single game is a one-leg match**;
  there is no separate single-game code path. A leg is `{game:"x01",score,rules}`,
  `{game:"cricket"}`, `{game:"countup",rounds}` or `{game:"bermuda"}`;
  `normalizeLeg` accepts legacy bare strings.

Shared UI components, extracted specifically so local and online modes cannot drift:
`dartboard.js` (clickable SVG board + marker), `cricketboard.js` (DartConnect-style
mark pad), `quickentry.js` (whole-turn-total keypad), `medleybuilder.js` (format
picker; a factory, not a singleton, because the page renders two instances).

`granboard.js` owns Web Bluetooth and the raw-bytes→`SegmentID` table (adapted from
sobassy/gran-app, MIT — keep the attribution). `SegmentType` doubles as the
multiplier (1/2/3), which several rule functions rely on.

`boardlink.js` owns the ONE connection to the one physical board and routes each
dart to whichever mode is playing — online.js subscribes above game.js and takes
it while its match is live. There used to be two connections, one per
controller, and a board attached from the wrong button delivered its darts to a
game that wasn't running.

**Settings is an OVERLAY, not a fourth tab** (`#settings-overlay`, opened by the
header gear, logic in `online.js`). Leaving a tab ends a match, and the two
things in there — the camera/mic check and the scorer address — are exactly what
someone reaches for mid-match; a tab would have needed an exemption from a rule
better kept absolute. It also has to work for guests, so it cannot live under
the account tab, which does not render without an accounts API. `closeSettings()`
calls `stopDeviceCheck()`: the check holds a live camera, and closing a sheet
over it without releasing it leaves the webcam light on with nothing on screen
explaining why.

## Personalization

Optional and additive, like accounts — but unlike accounts it is **device-first
and guest-first**. Preferences live in `localStorage` (`prefs.js`, one versioned
JSON blob under `aio-darts-prefs`) and work signed out, on the Android build,
and with `ACCOUNTS=off`. Syncing them to an account is a convenience that can be
removed without breaking anything. Values are validated on the way OUT, so a
corrupt or future-versioned blob degrades to "the app looks normal" rather than
to a blank screen; unknown keys survive a write so an older tab cannot delete a
newer build's setting.

**The DOM stamping is an inline `<head>` script in `index.html`, and must stay
one.** A module is deferred: the page would paint the default theme and flip to
yours on every load. `prefs.js` calls back into that script (`__aioApplyPrefs`)
rather than reimplementing it, because two copies of "which attribute does this
set" drift, and the copy that drifts is the one that only runs before first
paint. Absent keys stamp NOTHING and fall through to the CSS defaults, which is
what keeps that script from needing to know the schema at all.

**Themes are CSS, not JavaScript** — `[data-theme=…]` blocks. Scoped to any
element rather than `:root`, which is what lets a theme picker card render a
genuinely live preview by setting the attribute on itself. `theme.js` holds only
the catalogue and the accent contrast maths. Note the app is **already half
dark**: the chrome is felt with cream text and the PANELS are the light
surfaces, so `[data-mode="dark"]` is mostly `--panel-*` overrides. `--fill-strong`
exists because the brand dark used as a fill has to get *lighter* as the page
gets darker.

**Design tokens are two layers**: eight seeds, then roles expressed in terms of
them. Rules may only refer to roles. `dartboard.js` and `charts.js` emit CSS
classes rather than `fill`/`stroke` attributes, because an SVG presentation
attribute cannot read a custom property — so a themed board repaints instead of
needing a re-render, and that is the hook the colourblind-safe palette uses.
Shadows (`rgba(0,0,0,…)`) are deliberately NOT tokenised: they are depth, and
they read correctly over any palette.

**Board View (`data-boardview`) is the most valuable setting in the app**, and
it exists because darts is used at two distances — 40cm on the sofa, 2.5m at the
oche — where every app this borrows from is used at one. It scales the game
panels ONLY, and it must never reach inside `.immersive`: that layout positions
its scoreboard at absolute offsets tuned to fixed type sizes, so scaling the
type without moving the offsets breaks it rather than enlarging it. Hence
`.panel:not(.immersive)` on every shared rule.

**`.immersive` has bitten this twice, and both times the same way.** It is
declared as `#online-game-panel.immersive` — an ID, specificity 1,1,0 — and it
reserves the whole camera band with `padding-top: var(--stage-h)` (460–620px)
plus a solid `::before` backdrop. Any rule trying to override it from a
class-only selector silently loses no matter how far down the file it sits, so
overrides need the ID too. Hiding `#online-video-strip` does **not** reclaim
that space. Anything that changes the game panel's layout must be checked
against all three of: no video, `.immersive`, and `.immersive.cricket-stage`,
because they must look identical in oche view and only one of them is the case
you will happen to be testing. `ocheview.js` is the same idea
taken to fullscreen, and it RESTYLES THE EXISTING PANEL rather than rendering a
second scoreboard — a duplicate scoreboard is one that will eventually disagree
with the real one about who won. It holds a screen wake lock, which the browser
drops on every tab switch without giving back.

**Oche view is ONE picture at many sizes.** Desktop and phone must look the
same — the same proportions, the same relative type, the same gaps — even though
the pixel sizes differ. So oche-view geometry is expressed relative to the
viewport, never in per-device breakpoints; a change that improves one screen and
is not visible on the other is not finished. Two things this rule has already
caught, both of which produce a layout that is right at one end and wrong at the
other:

- **Fixed pixel constants break the proportion at the small end.** The Cricket
  pad measures `16.95u + 21px` — the constant is nine row borders — which is 1.8%
  of a desktop viewport and 5.4% of a landscape phone's. `--ck-u` therefore
  subtracts it *before* dividing (`calc((70vh - 24px) / 17)`), which is what makes
  the pad the same fraction of every screen. A plain `Nvh` fits one device and
  overflows the other, and eight separately-tuned `clamp()`s — the thing this
  replaced — cannot be right at both ends at once, because the constraint being
  divided among them is a single one on the total height.
- **Absolutely-positioned furniture reserves nothing.** The darts strip and the
  control bar are both absolute, so the flow runs underneath them unless padding
  says otherwise; `.cricket-stage` reserves 9vh at *both* ends for exactly that.
  `.game-top` has `flex-grow`, so it swallows whatever the pad leaves and pushes
  the pad down onto the control bar however small the pad is made — which is why
  an overlap there is not evidence the pad is too big.

`cricket-stage` is set by **both** controllers (`game.js` and `online.js`). It
was online-only for a while, and local play inherited the x01 stage underneath
it: the darts overlapped the top of the pad and `#big-score` rendered the
player's Cricket points at 318px, taking three hundred pixels off the stage while
the same number sat in the tiles at the bottom.

**`checkout.js` is pure and composes `scoring.js`.** Which dart may finish is
the `out` rule; the 170-vs-180 ceiling is `highestCheckout`. It takes **bull
mode** because the answer genuinely differs: split bull has a 25 single and a 50
double, full bull has only the 50, so routes through 25 vanish — which is why
darts sites publish two charts. `server/checkout.test.js` exists because a wrong
route is *plausible*; its strongest assertion cross-checks one-dart checkouts
against `isOneDartFinish` for every score under every out rule. `checkouthint.js`
is the DOM half, split off to keep that purity.

**`audio.js` treats a missing file as silence, never an error.** That is what
lets it ship with an empty `sounds/` directory and come alive - partially, if you
like - when recordings appear. The filename is the whole registration; see
`sounds/README.md`.

`scorerlink.js` is the transport for a camera scorer: a WebSocket, the
`dartnotation.js` parser, and two callbacks, with **no DOM** — which is what
lets it be tested against a real stub server rather than only against hardware
nobody has. It feeds `boardlink.js`'s `deliverExternalSegment`, so a camera dart
routes exactly like a Bluetooth one. WebSocket and no REST fallback: a socket to
a local address is not subject to CORS, where `fetch` needs both a Local Network
Access grant AND the scorer sending `Access-Control-Allow-Origin`.

`dartnotation.js` reads external automatic scorers (Autodarts, OpenDartboard)
into the same segment objects, with **one parser but one vocabulary per source**.
That split is not abstraction for its own sake: the numeric forms are universal,
but the word `BULL` is the OUTER bull to Autodarts and the INNER bull to
OpenDartboard, whose `OUTER` is the outer one. A merged table would silently
halve every bull for one of them. Autodarts' bare `BULL` is still an unverified
guess — see the note in the file. OpenDartboard's `END` maps to `RESET_BUTTON`,
so "visit over" reuses the concept the Granboard's physical button already had.
No connection layer exists yet for either.

The two top-level controllers are `game.js` (local pass-and-play) and `online.js`
(WebRTC 1v1); both are loaded on every page load and wire up their own half of
`index.html`. All three input paths — real board, clickable board, manual entry —
converge on the same segment objects before touching scoring code.

**The lobby is stateful; gameplay is not.** `server/lobby.js` holds presence,
challenges, rooms and chat, which is a real change to the "the server is a dumb
relay" principle above. What has NOT changed: an accepted challenge simply mints an
ordinary challenge code and sends it to both sides, after which the match runs over
the identical peer-to-peer path an invite code has always used. The server still
never sees a dart, and a lobby outage cannot interrupt a match in progress.
**Invite codes stay** — they are the only no-account path, the way to play someone
outside your lobby, and the fallback when the lobby is down.

Presence lives in `server/presence.js`, in memory, single-process, deliberately —
and behind a small interface so that adding a second process later is that file
plus a pub/sub bus rather than the protocol or the UI. Presence is per *person*,
not per socket: a phone and a laptop are one entry with two connections, and you go
offline when the last one closes. `detach()` returns the entry as it was, because
the disconnect handler needs to know which room to remove you from and the entry is
already gone by then.

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
about it. `hello` and `match_config` also carry the sender's display name, so a
saved match can name the opponent.

**`undo` is the one message that rewinds.** A player may take back their OWN
darts, and the window closes when the OPPONENT throws — not when the visit
ends, because a misread is usually spotted as the third dart lands or on the
walk to the board. Each side keeps two snapshot stacks (`me` and `opp`) pushed
in the same order for the same dart, so popping one on each keeps them in step;
the sender rolls back and tells the peer, who rolls back their copy. Undoing
restores `activeSide` too, so the turn comes back.

**A completed visit HOLDS for ten seconds before the turn passes**, and that is
what makes undo reach the case it exists for — a misread is spotted as the
third dart lands, after the visit is technically over. While the hold runs it
is still your turn, so the opponent *cannot* have thrown, and the question of
rewinding a dart they already answered never arises. Either player cuts it
short with End turn.

Local play has the same hold behind the `localHold` preference, **off by
default**. Online must hold — it is what makes undo safe there. Local does not
need it, because its undo stack already survives the end of a visit, so the
setting buys a countdown at the price of a pause: worth it alone at the board,
a tax paid every visit in pass-and-play. It is skipped for bot seats, which
never need a chance to undo and would otherwise add ten seconds a round.

**Both sides hold, and the thrower owns the clock.** Holding unilaterally is
worse than not holding: the other side would believe it was their turn, throw,
and have the dart rejected as out of turn. So the thrower counts down and
announces the end with the existing `end_turn` message; the receiver waits for
it, with a longer backstop timer in case it never comes (an older peer, a lost
message) — ending a turn late beats a match that sits still forever.

Undo past the opponent's next dart is still refused, and that is a design limit
rather than a missing feature: with no authoritative server and no
rollback/replay, rewinding a dart they have already answered means rewinding
theirs as well, and in Cricket it retroactively changes whether their marks
scored. The honest fix for a misread noticed that late is a score correction,
which is a different feature and needs the recorder to understand an
adjustment.

**Rematch is the only other handshake**: `rematch_offer` → `rematch_accept` or
`rematch_decline`. It is mutual on purpose and must stay that way — a one-sided
rematch restarts the scoreboard of someone who has already walked away, and they
return to a match they never agreed to. The offer carries the `legs` rather than
assuming the last ones, which costs nothing and is what lets "rematch, but
Cricket this time" become a picker rather than a protocol change. It also
carries `startSeat`, decided by the offerer and adopted by the accepter, so the
opening throw alternates between matches without two independently-maintained
counters that can disagree. No reconnection is involved: both sides are still
connected when a match ends, which is the entire speed of the feature.

**Adding a game mode does not add a peer message.** Bermuda Triangle rides the
existing `dart` message: a dart is a dart, and the pure rules on each side decide
what it meant. Both browsers computed the same halving independently from the same
three darts — that is the determinism guarantee doing real work, and it is why the
rules must stay pure.

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

## Accounts, statistics, leaderboards and the lobby

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

**Averages are split into 80% and 100%, and they mean different things.** The 80%
figure is the pure SCORING phase — x01 visits begun with 100 or more left, Cricket
rounds thrown before the bull was closed. The 100% figure is every visit, including
setup shots and darts thrown at a double that missed. A visit is classified by the
state it BEGAN in, so the visit taking you from 140 to 32, or the one that closes
the bull, still counts as scoring. **The rating reads the 80% figures** — feeding it
the whole-game average under-rates everyone by a band or two.

**`SITE_PASSWORD` puts one shared password in front of a whole deployment** (see
`server/gate.js`), for test builds. It does nothing when unset, which is how
production runs. Two details that are load-bearing: `/healthz` is never gated,
because Render polls it to decide whether the service is alive and gating it would
take the deployment down rather than protect it; and the WebSocket upgrades ARE
gated, since protecting pages but not sockets would leave signaling and the lobby
open to anyone who skipped the front door.

**Never build HTML from a player's display name.** `lobbyui.js` once interpolated
the challenger's name into `innerHTML`, which is stored cross-user XSS — set your
name to an `<img>` with an `onerror` and challenge someone, and it runs in their
session. Build DOM and use `textContent`. Escaping belongs at the point of render,
never at storage, or every legitimate apostrophe gets mangled and the sink is still
unsafe.

`DATA_DIR` must be persistent. On an ephemeral filesystem (Render's free tier)
every account is deleted on each deploy — see the long note in `render.yaml`.

**Litestream replicates that file to R2, and the backup story IS the migration
story.** `docker-entrypoint.sh` restores on boot only when there is no local
database AND the replica is non-empty, so an existing file is never overwritten
by an older copy; it then runs the app as a child of `litestream replicate
-exec`, which is what makes shutdown flush the final WAL segment instead of
racing it. Unset `R2_BUCKET` and the entrypoint exec's node directly — a missing
backup target is not a reason to refuse to serve darts. `sync-interval` is 10s
rather than the 1s default, because 1s is ~2.6M R2 Class A operations a month
against a 1M free allowance.

Replication protects against losing the MACHINE, not the DATA — it replicates a
bad `DELETE` just as faithfully. Snapshots close that, and they are config
rather than a separate job: `snapshot.interval` defaults to 24h, so nightly
snapshots already happened, but `snapshot.retention` also defaults to 24h,
which threw each one away before it was useful. It is set to 720h, giving
point-in-time restore across thirty days. That number is a storage judgement —
thirty snapshots of a 400MB database would exceed R2's free tier — so revisit
it as the database grows rather than treating it as a constant.

## Conventions worth preserving

- Comments in this codebase explain *why*, often at length, and frequently record a
  trade-off that was considered and rejected. Match that register; don't strip them.
- File lists are avoided where possible: the Dockerfile copies the whole context and
  the Android workflow excludes rather than includes, so a new root `.js` file is
  picked up automatically. Prefer exclusion-based lists when adding one is
  unavoidable (`sw.js`'s `PRECACHE` and the workflow's verify step are the
  exceptions that must be updated by hand - a new front-end file, including a new
  `stats/*.js` module, goes in both).
- **Adding a game mode** is: a pure rules module; a branch in `game.js` and
  `online.js` (no new peer message - it rides `dart`); a case in `medley.js`'s
  `normalizeLeg` and `gameLabel`; an option in `medleybuilder.js` and both format
  pickers in `index.html`; a `stats/*.js` module registered in `statsengine.js`;
  and both hand-maintained file lists. Bump `ENGINE_VERSION` if it changes what an
  existing number MEANS. The stats page, dashboard, achievements screen and
  leaderboard picker all iterate the registry, so they need no edit at all.
- Solo (one-player) play is supported in every game mode and must keep working.
- **Adding a preference** is: an entry in `prefs.js`'s `SCHEMA` (with its
  default and what counts as a legal value), a group in `PREF_GROUPS` so reset
  covers it, a control in `customize.js`, and - only if it needs to be visible
  before first paint - a line in the inline `<head>` script. Nothing else: the
  panel is built from the sections it lists, and an absent key falls through to
  the CSS default on its own.
- Edge cases the rules deliberately encode: leaving exactly 1 busts under double/
  master out but is legal under SISO; under double-in, pre-opening darts count as
  darts but score nothing; cricket closing-out while behind on points does not win;
  a quick-total entry finalizes the whole turn and reaching exactly 0 always counts
  as a valid checkout; a Bermuda round missed with all three darts halves the total,
  rounded down.
- Quick Total is refused in Cricket and Bermuda. A bare turn total says nothing
  about which numbers were hit, and in Bermuda it cannot express a halving.

## CI

`docker-build.yml` builds on pushes to `main`, on version tags, and on pull
requests; it publishes to GHCR only from `main` and version tags (`latest`, plus
`1.0.0`/`1.0` for a `v1.0.0` tag). Note that a push to a feature branch runs
NOTHING — only opening a PR does. `android-build.yml` wraps the front-end with
Capacitor into a debug APK artifact (local play only — no Bluetooth or online). It
assembles `www/` by copying the repo minus infrastructure, then hard-fails if an
expected front-end file is missing.

`main` is protected: pull request required (0 approvals, since this is a solo
project), the `build` check must pass, no force pushes, no deletion. Admins are not
bound, so there is an escape hatch — which means it stops accidents rather than
intent. Dependabot alerts and automatic security-fix PRs are enabled at the repo
level; `.github/dependabot.yml` adds scheduled updates and only takes effect once
it is on `main`, because Dependabot reads its config from the default branch.

## Deployments

Three, and it matters which is which:

- **`aio-darts.onrender.com`** — production, deploys from `main`. Has no disk, so
  it must not carry accounts until one is attached.
- **`aio-darts-dev.onrender.com`** — the test build, deploys from `accounts-stats`,
  gated by `SITE_PASSWORD`. Render deploys one branch per service, which is what
  keeps the two apart. Free tier: the filesystem still resets on every deploy AND
  on every spin-down after ~15 minutes idle — but accounts NO LONGER vanish with
  it, because Litestream restores the database from R2 on boot. Verified: a
  redeploy wiped the disk and the session survived. That holds only while the
  `R2_*` variables are set; without them the old behaviour is back and the reset
  is silent.
- **GitHub Pages** — was serving `main` as a static-only copy. Disabled; noted here
  because it is easy to re-enable by accident and it publishes the front-end with
  no server behind it.

Any deployment whose branch is not `main` shows a red banner (see `version.js`), so
a test build cannot be mistaken for the live one.
