# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A zero-build-step darts app: plain ES modules served as static files, plus one small
Node server. There is no bundler, transpiler, or linter. Editing a `.js` file at the
repo root and refreshing the browser is the entire dev loop.

That still holds with the Windows desktop build in the tree. `desktop/` packages
the app, it does not compile it — `npm start` there serves this same working
tree, so an edit and a refresh work exactly as they do in a browser. The only
build step is producing an installer.

Tests are `node --test` over the files in `server/`, and what they cover is chosen
rather than sampled: the **arithmetic and the parsing**, never the UI. That is the
whole principle — a scoring bug shows up immediately on a board you are looking at,
but a checkout percentage that is five points too high looks exactly like one that
is right, for months. So `statsengine`, `checkout`, `freeze` and `matchrecorder`
test numbers whose wrongness is invisible; `dartnotation` and `scorerlink` test
input from hardware nobody has to hand; `sequencer` tests an ordering guarantee
that only breaks under a race. Everything a human would notice in one leg is left
to the human.

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

Windows desktop app (Electron — see the section below):

```
cd desktop && npm install
npm start          # run it from the working tree
npm run dist       # NSIS installer into desktop/dist/
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

Tests: `node --test "server/*.test.js"` — every test file in `server/`.

**Quote the glob.** Node expands it itself, so the one command works in bash and
PowerShell alike and picks up a new test file on its own. It replaced a
hand-written list of paths which had already gone stale — `scorerlink.test.js`
was missing from it, so the documented command silently skipped a file for as
long as it existed. Do not expand this back into a list, and do not write the
count here either: that is the same failure one step removed. Note also that a
bare directory (`node --test server/`) is NOT the same thing and hangs — it
descends into `server/node_modules`.

Note that **CI does not run these** — `docker-build.yml` builds the image and
nothing else — so they are a manual gate, which is worth knowing before
trusting a green check on a PR.

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
  pad measures `15.58u + 10.5px` — the constant is the row borders — which is a
  far larger share of a landscape phone's height than a desktop's. `--ck-u`
  therefore subtracts it *before* dividing, which is what makes the pad the same
  fraction of every screen. A plain `Nvh` fits one device and overflows the
  other, and eight separately-tuned `clamp()`s — the thing this replaced —
  cannot be right at both ends at once, because the constraint being divided
  among them is a single one on the total height.
  **RE-MEASURE the multiplier whenever a row's contents change height**; it has
  moved three times (16.95 → 17.07 when the marks grew, → 15.58 when the Miss
  footer went). Measure the ROWS and add them up: the pad carries `max-height:
  84vh`, so a test unit large enough to hit it reports a clipped height and
  yields a slope that is far too shallow.
- **`min()` of height and width, not height alone.** The vw term was removed
  once on the reasoning that a row is only ~5.5u of buttons against 92vw so
  width never runs out first — true of every desktop aspect ratio and false of a
  portrait phone, where height is abundant and width is scarce. There `u` came
  out large, the pad's 12.5u exceeded the width cap, and the cap took the
  difference out of the only elastic part of the row: the two mark columns,
  which collapsed to nothing. The buttons still looked right, so the pad looked
  fine while showing **no marks at all**, on a board whose marks are the score.
- **Absolutely-positioned furniture reserves nothing.** The darts strip and the
  control bar are both absolute, so the flow runs underneath them unless padding
  says otherwise. The strip's geometry is therefore one pair of variables —
  `--darts-top` and `--dart-slot-h` — read by the slot itself, by the strip's
  offset AND by everything reserving room for it, because two copies of "how
  tall is a dart slot" means the reservation is the one that drifts, and it
  fails by printing the score through the darts rather than by looking wrong on
  its own. `.cricket-stage` reserves exactly that at the top and 7vh at the
  bottom. Getting the top reservation *nearly* right is its own bug: `.game-top`
  centres the turn label in the band it is given, so a band starting above the
  darts centred the label against an edge the eye cannot see.
  `.game-top` also has `flex-grow`, so it swallows whatever the pad leaves and
  pushes the pad down onto the control bar however small the pad is made — which
  is why an overlap there is not evidence the pad is too big.
- **The ordinary game screen has the same one-unit pad, on its own unit.**
  `.cricket-board` sets `--ck-u` as a plain length and states `width: 12.5u`,
  sharing oche view's shape so the pad reads the same on the sofa and at the
  board. Sharing the *unit* would be wrong: this page scrolls, so height is not
  a constraint to divide up, and Board View is what "how far away am I" means
  here — it sets `u` directly, one number per step. Before this the pad had no
  stated width at all, and `.ck-row` being `1fr auto 1fr` meant a desktop panel
  fed five hundred pixels of slack straight into the mark columns.

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

**Match Settings sits ABOVE the lobby, and cannot be moved into it.** The format
picker governs both routes out of the tab — a lobby challenge and an invite code
alike — but the lobby panel does not render for guests or with `ACCOUNTS=off`,
so putting the picker inside it would take the format controls away from the one
path that has no account. It is ordered above rather than moved, with `order` on
a flex `#online-mode`, because `online.js` shows and hides `#online-setup-panel`
from six places and relocating the element would mean keeping all of them right
for no visible gain. The panel is titled "Match Settings" and the tab "Online
Play": the tab already says which mode you are in, so naming the panel after the
section rather than its contents was what made the format feel unrelated to the
challenge you were about to send.

**Standing rooms are how tip type is expressed, and why it is not a format.**
Steel and soft tip change nothing this app scores — same rules, same checkout
ceiling, same bull — so tip type is not a property of a match, and a picker
beside Bull would have the host declaring something they cannot enforce on the
guest's board. It is a property of the board in your room, and what a player
wants from it is to find someone with the same one: a place to stand. So
`STANDING_ROOMS` in `server/lobby.js` seeds Steel Tip and Soft Tip, plus **one
room per game mode** — which is why adding a game mode adds a room.

Two things about them are load-bearing. **There is no "Open" room**: the lobby
already is one, everybody signed in and not in a room is in it by definition, and
minting a room for the default would make people join it or look like they were
nowhere. And **standing rooms survive being empty**, which is the exception in
`releaseRoom` — every other room is swept when the last person leaves, and
sweeping these would delete Steel and Soft the moment the lobby emptied, so they
would only exist once somebody had already managed to meet somebody else. An
empty room is exactly the state a tip room has to survive.

**A room narrows who may challenge you, and it is enforced on the handler as
well as reported on the row.** `canBeChallengedBy(target, viewer)` is the single
rule: in a room, only people standing in it with you, unless your status is
`looking` ("Open to challenges"). The `challengeable` flag on each player row is
that function, and so is the guard in the `challenge` message handler — a hidden
button is a suggestion, and a message can be sent by something that never drew
one. It is deliberately asymmetric: a player in a ROOM can still challenge a
player in the open lobby, because the open one has expressed no preference to
override. The room roster is filtered client-side from presence, which already
carries every player's `roomId`, rather than sent with the room — a second copy
of the membership is one that disagrees with the first.

Note that "Open to challenges" was **write-only** before this: it set your status
and was never set back from it, so the box and the server disagreed after a
reconnect. That was cosmetic while it only meant "actively looking"; now that
being in a room hangs off it, a stale tick is the difference between anyone being
able to challenge you and nobody. `render` syncs it from your own presence entry.

**Lobby rows carry the player's averages, fetched lazily by the client.** Not in
the presence payload: presence is pushed to everyone on every change, so that
would mean reading statistics for every person online and sending them all to
everybody each time someone went idle. One request per visible player, answered
from `stats_cache`, cached for the session. The permission check is simply
*whether the server sent a headline at all* — it withholds figures for anyone
opted out — and `lobbyui.js` deliberately does not read `shared` itself, because
your own card is served in full whatever that flag says, so testing it there hid
your own figures from you.

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

**A dart thrown DURING the hold belongs to the next visit, and both controllers
now say so — differently, for the same reason.** Neither used to: the dart was
appended to the visit that had already finished, so its marks were credited to a
player who had stopped throwing, and in pass-and-play the next player's darts
scored for their opponent. It surfaced as Cricket MPR reading 12 and 15 — marks
over ROUNDS, against a ceiling of the nine marks three treble beds are worth —
which is the only figure in the app with a ceiling low enough to make the bug
visible. x01 has no equivalent, so it had been silently wrong there too.
`game.js` COMMITS the hold and applies the dart to whoever is next, because in
pass-and-play the next visit is at this same board and someone stepping up is
the clearest possible statement that the last one is over. `online.js` REFUSES
it, because the opponent throws at their own board and there is no next visit
here to give it to; a fourth dart is a stray one, and undo is the honest answer.
The refusal happens before the peer message is sent, so the two sides cannot
disagree — and peer darts are still applied exactly as sent, which is what keeps
an older build on the other end in step rather than desynced.

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

**A refused upgrade must ANSWER before hanging up.** Rejecting one with a bare
`socket.destroy()` sends no HTTP response at all, and Render's proxy turns that
into a **502 Bad Gateway** — so the player is told the signaling server cannot be
reached while the server is running perfectly and has merely refused them for
want of the site password. It reads as a phone-only fault, because service
workers do not intercept WebSocket handshakes: a phone running the app from cache
never makes the ordinary request that would refresh the gate cookie, while a
desktop that just loaded the page always carries one. The browser still only
exposes a generic socket error to JavaScript, which is why `online.js` probes
`/healthz` — the one thing the gate never blocks — before deciding whether
"couldn't reach the server" is actually true.

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

## The Windows desktop build

`desktop/` is an Electron wrapper, and it is **not a second copy of the app**. It
starts the SAME `server/server.js` the Docker image runs, on a loopback port, and
points a window at it. "One process, one port" is untouched — this supplies the
process and opens the window.

**Serving over HTTP is not a stylistic choice, it is the whole architecture.**
`file://` is not a secure context in Chromium and Web Bluetooth is refused
outside one, so the obvious Electron build — load `index.html` off disk — runs
perfectly and never sees the Granboard, which is most of the point of darts on a
machine plugged into a board. `http://127.0.0.1` IS a secure context. The same
fact **disqualifies Tauri**, which would otherwise be the better-sized tool: it
renders in WebView2, which does not implement Web Bluetooth at all. Don't
revisit that without checking WebView2 again first.

The server is spawned with `ELECTRON_RUN_AS_NODE`, so it runs on Electron's own
Node and **a packaged build needs no Node installed** — the one dependency a
desktop app must not have. The port is taken from the OS rather than fixed,
because `start-aio-darts.bat` already uses 8000 and someone may have it open
alongside.

**`HOST` binds the listener, and its default must stay "all interfaces".**
Unset is what a container needs; binding a Docker image to loopback makes it
unreachable from outside itself, which presents as a deployment that starts
perfectly, logs nothing wrong and answers nothing. The desktop build sets
`127.0.0.1` and needs to: there the server exists only to give our own window a
secure context, and on all interfaces it offers the local network a signaling
relay plus — with `UPSTREAM_ORIGIN` set — an unauthenticated forwarder to
somebody else's site. A stranger cannot reach the player's *account* that way,
since the session is a cookie in one browser and the proxy carries no
credentials of its own; they can still reach aiodarts.com through a laptop that
never volunteered to be a relay.

**`select-bluetooth-device` is the trap, and it fails by lying about who
cancelled.** Electron ships no device chooser, so `requestDevice()` hangs
forever unless that event is answered — but it fires ONCE PER DISCOVERY UPDATE,
and the first fire routinely carries an empty list because the radio has turned
nothing up yet. Answering `""` means *cancel*, so replying to that first empty
fire aborts the chooser milliseconds after it opens and the page reports **"User
cancelled the requestDevice() chooser"** when the user did nothing and the board
never had a chance to appear. An empty list means KEEP WAITING. A 30s deadline,
started on the first fire only so discovery updates cannot push it back, turns
that message into a true one when the board really is absent. The callback is
answered exactly once — Electron treats a second answer as an error, and there
are three routes in: device found, scan timed out, window closed mid-scan.

Picking the first device is safe **only** because `granboard.js` filters by the
Granboard service UUID, so Chromium has already excluded everything that is not
a board. Two boards in range would be guessed at; that is where a chooser window
would go.

**The desktop app is a CLIENT of aiodarts.com.** `UPSTREAM_ORIGIN` in
`server/apiproxy.js` forwards `/api/*` and the lobby socket to another
deployment, so sign-in, statistics, friends and the lobby are the real ones.
Unset — every server deployment, production included — and none of it runs. Keep
it that way: this is the same file that serves aiodarts.com, and a proxy that
switched itself on there would forward the site somewhere else.

Three things about it are load-bearing:

- **Forwarding, not letting the page call the remote origin.** Direct would make
  every `/api/*` request cross-site: production grows a CORS policy naming a
  localhost origin, and the session cookie has to become `SameSite=None; Secure`
  to be sent at all — relaxing a live deployment's security, permanently and for
  everyone, to suit a local build. Forwarding keeps the page same-origin with its
  API exactly as on the web, so `accountstore.js` needs **no change at all**: its
  single `apiFetch` choke point and `credentials: "same-origin"` stay literally
  true.
- **TURN is borrowed, never configured.** Cloudflare Realtime issues no
  long-lived credentials — you hold an API token and mint short-lived ones, which
  is why `server.js` takes `TURN_KEY_ID`/`TURN_KEY_API_TOKEN` rather than a
  username and password. Putting that token in a desktop package ships a live
  production secret to every player's machine. Asking upstream for the
  already-minted credential gives the same relay with nothing to leak. Only
  `iceServers` is taken: the upstream's `signalingUrl` is the empty string meaning
  "same origin", true there and false here, and adopting it would resolve to
  `127.0.0.1` and make every challenge code joinable from one machine.
- **Both proxy hooks come BEFORE their local equivalents**, and that ordering is
  the bug waiting to happen. With an upstream there is no local database and no
  local lobby, so `accountsEnabled` is correctly false and the socket has no
  handler — checking those first would 503 and destroy requests someone else was
  about to answer perfectly well.

The WebSocket relay copies bytes rather than using `ws` as a client. A relay that
parses frames has opinions about fragmentation, ping/pong, close codes and
extensions, and each one is a chance for two ends to disagree about a protocol
neither is speaking to us in.

**Updates exist because of determinism, not convenience.** The accounts, lobby,
signaling and TURN halves are forwarded to production and so are always current
— but the FRONT-END is baked into the package at build time, and the front-end
is where the pure rules live. An installed copy that never updates is a peer
running different rules against a web player running the newest, which is the
silent scoreboard disagreement the whole design exists to prevent.
`electron-updater` therefore downloads in the background and **installs on quit,
never mid-session**: restarting between visits would end a match, and
`checkForUpdatesAndNotify` uses a native notification rather than a dialog so
nothing steals focus from a throw. Every failure path is a warning and nothing
more — no network, a rate limit, a missing release: none of those is a reason to
interrupt someone playing darts.

`desktop-release.yml` publishes on `v*` tags, **the same tags
`docker-build.yml` already uses**, so one version number covers the container
and the app. Two things about that are easy to get wrong:

- **The GitHub Release IS the update feed.** `electron-updater` reads
  `latest.yml` from the assets of the *latest* release. This repo's existing
  releases (up to `v1.1.0`) are notes-only with no assets, so an installed app
  404s on every check until a tag has been through this workflow. Harmless — it
  warns and carries on — but it means a release published by hand, without the
  workflow running, silently switches updates off for everyone.
- **`releaseType: release`, not electron-builder's default draft.** A draft is
  invisible to the updater, so a forgotten "publish" button is indistinguishable
  from a broken feed. Set it back to `draft` if you would rather check an
  installer before it reaches machines — but then publishing it is a step that
  must actually happen.

The version comes from the tag, set in CI with `npm version --no-git-tag-version`
rather than committed, because a hand-bumped `desktop/package.json` eventually
disagrees with the tag it shipped under and that number is exactly what decides
whether an install is out of date.

**The installer is unsigned, and that matters more for the updater than for the
installer itself.** SmartScreen is a one-time annoyance; an unsigned update
channel is a standing one, since anything able to serve a release gets code
execution. GitHub Releases over HTTPS makes that hard, but signing is the actual
mitigation and it costs money.

**Packaging is exclusion-based, so a new front-end file needs no edit here** —
`electron-builder` copies the repo minus infrastructure, the same approach the
Dockerfile and the Android workflow take. `sw.js`'s `PRECACHE` and the Android
verify step remain the only hand-maintained file lists. The installer is
unsigned, so SmartScreen challenges it on first run, and it carries a whole
Chromium: a ~94MB installer that unpacks to ~327MB on disk.

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
  and both hand-maintained file lists; plus an entry in `STANDING_ROOMS` in
  `server/lobby.js`, since there is one lobby room per game mode. Bump
  `ENGINE_VERSION` if it changes what an existing number MEANS. The stats page,
  dashboard, achievements screen and leaderboard picker all iterate the registry,
  so they need no edit at all.
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
- **A visit is three darts unless it checked out**, and `recorder.endTurn(seat)`
  is where that is enforced. Darts nobody entered were still thrown, so ending a
  turn sets `darts` to 3 rather than counting the throws — otherwise a visit of
  60 and two misses read as a PPD of 60 against a ceiling of 60. It is carried
  on `darts`, never as a fourth entry in `throws`: a dart with no segment would
  put a phantom miss in the heatmap and in every per-dart statistic, which is
  the same split quick totals already need. `endTurn` takes the SEAT because a
  visit where all three missed registers nothing at all and leaves no open turn
  to read it from — and that visit must still be recorded, or a player who
  misses everything has the round dropped from their MPR denominator and their
  average goes UP for missing. This is what lets Cricket's pad have no Miss
  button: End turn already says the visit is over, which is the thing the player
  was going to do anyway.
- **The live average names its own figure.** `liveStats` returns a labelled
  object with a null value before the first dart, and null ONLY when the game
  offers no average at all. Returning null for both let the renderer fall back
  to a hardcoded "PPD", which is the wrong number's name in Cricket. It splits
  by what is being counted rather than by game: marks on a target (Cricket,
  Bermuda) or points off darts (x01, Count Up), so a fifth game needs no third
  branch. It is shown on the ordinary game screen as well as in oche view —
  everything oche view offers is reachable without going fullscreen for it,
  including Undo dart, End turn and End game.

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

- **`aiodarts.com`** — production, deploys from `main`, served by the Render
  service `aio-darts` (`aio-darts.onrender.com` still answers and is the same
  service, not a fourth deployment). It **carries accounts, statistics and the
  lobby**: they landed on `main` in PRs #16 and #17, so the long-standing split
  where production was the darts and the dev build was the accounts is over.
  Still on the free tier, so the filesystem is ephemeral and persistence rests
  entirely on Litestream restoring from R2 on boot — the same arrangement the
  dev build proved out, now load-bearing for real accounts rather than test
  ones. **The boot log is the only place that says which state it is in**: the
  entrypoint prints either `replication : R2 bucket …` or `replication : off
  (R2_BUCKET unset - the database is NOT backed up)`, and the second one is
  silent everywhere else, because an empty database serves darts perfectly and
  reports `accounts:true`. All five `R2_*` variables are set here (confirmed 9
  August 2026), so it is the first. Production and the dev build **must not
  share `R2_PATH`** — one bucket, two prefixes — or each restores and
  overwrites the other's database. They don't: production replicates under
  `prod`, the test build under `dev`. That pair is worth re-checking whenever a
  service is recreated, because the failure is mutual destruction of both
  databases and it looks like ordinary operation until someone cannot sign in.

  Two other things are live here that are optional everywhere else, and both
  are easy to forget when reasoning about the code's fallback paths. **TURN is
  on**, via Cloudflare Realtime (`TURN_KEY_ID` + `TURN_KEY_API_TOKEN`), which
  mints a credential per session rather than holding a static pair. And
  **password reset actually sends mail** — `EMAIL_API_KEY`, `EMAIL_FROM` and
  `PUBLIC_URL` are all set, so `server/email.js` posts to Resend instead of
  taking the log-the-link path. That path is still the one that runs locally
  and in tests.
- **`aio-darts-dev.onrender.com`** — the test build, deploys from `accounts-stats`,
  gated by `SITE_PASSWORD`. Render deploys one branch per service, which is what
  keeps the two apart. Free tier: the filesystem still resets on every deploy AND
  on every spin-down after ~15 minutes idle — but accounts NO LONGER vanish with
  it, because Litestream restores the database from R2 on boot. Verified: a
  redeploy wiped the disk and the session survived. That holds only while the
  `R2_*` variables are set; without them the old behaviour is back and the reset
  is silent. Note that since the merge this branch is level with `main`, so the
  two deployments are currently running the same code and the dev build is
  earning its keep only when there is unmerged work on it.
- **GitHub Pages** — was serving `main` as a static-only copy. Disabled; noted here
  because it is easy to re-enable by accident and it publishes the front-end with
  no server behind it.

Any deployment whose branch is not `main` shows a red banner (see `version.js`), so
a test build cannot be mistaken for the live one.
