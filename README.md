# AIO Darts

An "all-in-one" darts app: local pass-and-play scoring, online 1v1 challenges
over a direct P2P connection with optional camera and mic so you can watch your
opponent throw, and three equal ways to score: a Granboard over Bluetooth, a
clickable dartboard, or manual entry - so a plain steel-tip board works just as
well as an electronic one. Room to grow from there, too: camera-based hit
detection is on the roadmap.

Everything runs as **one container on one port**. The static front-end and the
WebRTC signaling server are served by the same process, which is what keeps
deployment simple (see [Architecture](#architecture)).

If you'd like to support the project, there's a small "Support this project"
link in the app's footer, pointing to https://ko-fi.com/nickpearman. No
paywall and nothing is gated behind it - it's just a tip jar for now. A free
tier alongside a paid one is planned for later, once accounts and persistent
stats land, but that's a ways off.

The Bluetooth service UUID and dart-hit decoding table in `granboard.js` are
adapted from the open-source project
[sobassy/gran-app](https://github.com/sobassy/gran-app) (MIT License). Credit
to that project for reverse-engineering the protocol in the first place - that
one piece keeps its original MIT terms even though the rest of this repo is
licensed differently now (see [License](#license) below).

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

1. Choose a **Format**, edit the player names if you want, then click
   **Start Game**.

   A match is an ordered list of legs, each with its own game - so a single
   game is simply a one-leg match, and there's no separate "medley mode" to
   switch on. An x01 leg carries its own **starting score** (301, 501 or 701)
   and its own **rules**:

   The in and out rules are picked independently, so every combination is
   available - "Open in / Master out" is a real selection, not a curiosity.

   | | Open | Double | Master |
   | --- | --- | --- | --- |
   | **In** | any dart scores | nothing scores until a double | a double, triple **or** bull opens you |
   | **Out** | anything finishes, including a single | must finish on a double | a double, triple **or** bull finishes |

   The familiar names are just points on that grid: **SISO** is open/open,
   **DIDO** is double/double, **Master out** is open/master.

   Two details that catch people out. Under **double in**, darts thrown before
   you open still count as darts - they just score nothing, and the throw log
   says "not in yet" rather than logging them as if they counted; the dart
   that opens you does score. And leaving exactly **1** busts under double
   out and master out (nothing makes 1 from a double or triple) but is
   perfectly legal under SISO, where you can finish on a single 1. Presets cover the common shapes (single 501, single Cricket,
   best of 3, best of 5), or use **+ Add leg** and the per-leg dropdowns to
   build your own; editing a leg by hand switches the preset to "Custom".

   **Solo play** works too - remove a player down to one and you can practise
   alone. Both games support it: 501 plays as a straight checkout, and Cricket
   keeps paying out points on numbers you've closed (with no opponent there's
   nobody to close them out against, so nothing goes dead). A solo medley
   plays every leg rather than ending after the first.

   **Computer players.** Every seat has a dropdown next to the name box, set to
   "Human" by default. Change it and that seat is played by the computer, at
   one of seven strengths named for the rank it plays to:

   | Level | Rank | Three-dart average |
   | --- | --- | --- |
   | Beginner | C | ~35 |
   | Casual | CC | ~51 |
   | Club player | B | ~63 |
   | Strong club | BB | ~75 |
   | County | A | ~89 |
   | Elite | AA | ~103 |
   | Professional | S | ~116 |

   Those averages are measured, not claimed - the levels are pegged to the same
   rating table the app scores you against ([Rating and ranks](#rating-and-ranks)),
   so "beat a B player" means the same thing whoever is throwing.

   The computer isn't a table of outcomes or a "70% chance to hit the treble".
   It aims at a point on the board and its dart lands there plus a random
   error, which is then read back off the board as whatever segment it hit.
   That one number - how wide the scatter is, in millimetres - is the entire
   difference between the beginner and the professional, and it produces the
   *right* misses for free: aim at treble 20, miss sideways, hit the 1 or the
   5, exactly as a person does. It plays every game mode, aiming at the round's
   actual target in Bermuda rather than blindly at the 20.

   Any seat can be a computer, so you can watch two of them play, and mixed
   games work in a medley. A match with a computer in it is recorded as
   **practice**: the darts count towards your statistics, because they're real
   darts you threw at a real board, but the result stays off the win-based
   leaderboards - farming a beginner for a hundred wins shouldn't put anyone
   top of a board.

   With more than one leg, a bar shows which leg is in play and the running
   leg tally, and a **Next leg** button appears once a leg is won. Scores
   reset each leg while names and the tally carry over, and the throw
   alternates each leg so the same player isn't always first. A match ends
   when someone's lead can't be caught - 3-0 in a best of 5 finishes there
   rather than playing two dead legs - and an even number of legs can
   genuinely end drawn, which is reported as a draw rather than picking a
   winner.

   In Cricket the board itself is the scorekeeping pad, laid out
   DartConnect-style: the targets run down the centre with **D** and **T**
   buttons either side, so any dart is a single tap, and each player's marks
   sit in a flanking column. Clicking the mini dartboard and a real Bluetooth
   board both work too - all three inputs run through identical scoring code.

   **Bull mode** applies to the whole match, whichever games it contains:

   | Mode | Outer bull | Inner bull |
   | --- | --- | --- |
   | Split bull (default) | 25, counts as a single | 50, counts as a double |
   | Full bull | 50, counts as a double | 50, counts as a double |

   Full bull changes more than the number. Because the whole bull becomes a
   double 25, it also becomes a legal finish in a double-out or master-out
   leg, opens a double-in leg, and is worth **two** marks in Cricket instead
   of one. It's applied as a single transform before any game logic sees the
   dart, so board hits, dartboard clicks and manual entry all behave the same.

   **Count Up** is the practice game: every dart simply adds its face value,
   there's no bust and no double to start or finish, and after a fixed number
   of rounds (8 by default, 5-20 selectable) the highest total wins. The turn
   label shows the round and your running points-per-round average, which is
   the number worth watching - a ton a round is the usual benchmark. Because
   it's a pure accumulation it can genuinely end level, and a drawn leg is
   reported as a draw rather than awarded to someone. Quick Total works well
   here, since a whole-turn total is exactly what the game adds up.

   In Cricket, only 20, 19, 18, 17, 16, 15 and the bull count. Three marks
   closes a number (a single is 1 mark, a double 2, a triple 3); after that,
   hits on it score its face value per mark until your opponent closes it too,
   at which point it's dead and the row greys out. You win by closing
   everything **and** being level or ahead on points - closing out while
   behind doesn't end the game. Quick Total entry is hidden in Cricket, since
   a turn total says nothing about which numbers were hit.

   **Bermuda Triangle** is thirteen rounds with a different target each time,
   in a fixed order: 12, 13, 14, Any Double, 15, 16, 17, Any Triple, 18, 19,
   20, Any Bull, Double Bull. Any segment of the current number scores its own
   value, so a triple 12 is worth 36; on the Double and Triple rounds, any
   double or any triple anywhere on the board counts.

   The catch is what makes the game: **miss the target with all three darts
   and your score is cut in half.** That punishes a good player far more than
   a bad one - somebody on 400 loses 200 for one bad round - so a steady
   player who never misses will beat a big scorer who misses twice. The app
   says so out loud in the throw log when it happens, because a score that
   silently halves reads as a bug. The current target is always in the turn
   label. Quick Total is disabled here, since a bare total can't express which
   target you were on or whether you missed it.
2. *If you have a Granboard*, click **Connect Board** - a browser popup will
   ask you to pick it from a list of nearby Bluetooth devices. Select it and
   click "Pair"/"Connect". This step is entirely optional: the clickable
   dartboard and manual entry are complete ways to play on their own, so a
   plain steel-tip board (or no board at all) works fine.
3. Throw darts - hits should show up automatically, update the score, and
   move a marker on the mini dartboard. You can also just **click directly on
   the mini dartboard** to score that segment - a third input method alongside
   a real board and manual entry, available in both local and online mode.
4. **Manual entry**, at the bottom, is a full input method in its own right -
   plenty of people play a plain steel-tip board this way and never connect
   anything over Bluetooth. If you *do* have a board, it's also what records a
   miss or fixes a misread (alongside **Undo last dart**). Two modes:
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
remote 1v1 match. Gameplay runs over a **direct peer-to-peer WebRTC
connection** - the signaling server is only involved in the initial handshake
(helping the two browsers find each other and swap connection details), never
in gameplay traffic.

Online play uses the same **Format** control as local play - every x01 variant,
Cricket, the best-of presets, and hand-built medleys all work. The player who
creates the challenge picks the format and it's sent to whoever joins, so both
sides are always playing the same thing rather than each guessing. Multi-leg
matches show the leg tally and a **Next leg** button exactly as they do
locally, and either player can advance the match.

In online mode you have the same three input methods as local play: a real
Bluetooth board, the clickable dartboard, and manual entry (Per-Dart or Quick
Total). None of them requires a board to be connected, so someone with no
Granboard can play a full match against someone using one. The marker on your
board tracks your own darts; the opponent's throws appear in the throw log.

### Camera and mic

Press **📹 Start camera & mic** during a match to see and hear your opponent
throw. It's entirely optional and off until you press it: no permission prompt
appears and no media is sent otherwise, so a match between two people who never
touch the button behaves exactly as it did before the feature existed.

Once on, you get **Mute**, **Camera off**, and **Stop** (which releases the
devices - the camera light really does go out). If your opponent switches their
camera off their tile says so, rather than going black and looking like a
dropped connection.

**Switch camera** appears when there's more than one camera to switch to - the
front/rear pair on a phone, or a laptop with a USB webcam plugged in. On a phone
the rear camera is the one worth using: point it at your board and your opponent
can watch the darts land. Switching keeps the mic, the match, and the connection
untouched.

Mirroring follows the camera. Your own tile is mirrored the way video-call apps
show you, *except* on a rear-facing camera, where it isn't - a mirrored board
would be actively misleading. The opponent's tile is never mirrored, for the
same reason.

### Checking your camera and mic first

The setup screen has a collapsed **🎥 Camera & mic check** section. Open it and
press *Start check* to see your camera and watch a live level meter move when
you speak - without creating a challenge or making an opponent wait while you
work out why nobody can hear you.

If you have more than one camera or more than one microphone, a picker appears
for each. Whatever you choose is remembered and reused when you turn the camera
on in a match, so you set your devices up once rather than every game. The
pickers only appear when there's actually a choice to make.

The check releases the camera and mic as soon as you create or join a challenge
(and when you collapse the section), so it never holds a device the match then
needs - which matters on Android, where a camera can only be open once.

Remembered devices are stored per browser. If one is later unplugged, the check
works out which preference died, forgets just that one, and falls back - your
chosen mic survives a swapped-out webcam.

### Ending a match

**End match** at the bottom of the game panel drops the connection and releases
the camera and mic in one action, and tells your opponent so they're not left
staring at a scoreboard for a match that no longer exists. It takes two taps -
the first arms it, and lapses after a few seconds - so a stray tap mid-leg
doesn't end your game.

This rides the *same* peer-to-peer connection as the scoring data, so it needs
no extra ports, no second service, and no configuration. Two caveats:

- Like Web Bluetooth, `getUserMedia` needs a **secure context** - it works on
  `localhost` but not on a plain `http://<ip-address>` LAN address. Put the
  site behind HTTPS.
- If a match falls back to a **TURN relay**, video is no longer free -
  see [Adding a TURN relay](#adding-a-turn-relay).

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
- **Nothing proves a match happened.** Accounts, statistics and leaderboards
  all rest on what the two clients report, and the app has no referee - see
  [Leaderboards are for fun, not for ranking](#leaderboards-are-for-fun-not-for-ranking).
  Appearing on a board is opt-in for exactly that reason.
- **Invite codes are still the only way to play someone outside your lobby** -
  and the fallback when the lobby is down. That's deliberate, not a gap: the
  lobby only mints an ordinary challenge code and hands it to both sides, so
  there's no second code path to keep working.
- Challenge codes are **in-memory and ephemeral** - restarting the server
  drops any in-progress ones. That's by design; a code only needs to live for
  the few seconds it takes two players to connect.
- The physical **end-turn button** works in online mode too - it finalizes
  your turn and tells your opponent's browser to advance, keeping both sides
  in sync.

## Architecture

One Node process (`server/server.js`) does four jobs on a single port:

- serves the static front-end (`index.html` and the `*.js` files)
- serves the signaling WebSocket at `/signaling`
- serves the lobby WebSocket at `/lobby`
- answers the accounts and statistics API under `/api/*`

That merge is deliberate. Because the sockets live on the same origin as the
page, deploying needs **no second subdomain, no extra DNS record, no separate
TLS certificate, no path-rewriting rules, and no signaling URL for anyone to
type**. A reverse proxy just forwards the site as it would any static site,
with WebSocket upgrades enabled.

The two WebSockets share one `upgrade` listener that routes by path, which is
load-bearing rather than tidy: a `WebSocketServer` built with `{server, path}`
installs its own listener and *destroys* any upgrade whose path it doesn't
recognise, so two of them on one HTTP server means whichever attached first
silently hangs up on the other's connections.

Only the lobby holds state. Signaling relays offer/answer/ICE between the two
sockets in a room and then drops out, and an accepted lobby challenge mints an
ordinary invite code and gets out of the way - so the server never sees a dart,
and a lobby outage can't interrupt a match already in progress.

Scoring stays in sync between peers without any rollback/replay machinery:
both browsers run the identical deterministic `resolveThrow` logic from
`scoring.js`. Each side only ever applies hits from its own physical board
locally and forwards them to the peer, which applies them to its model of "the
opponent" using the same rules. WebRTC DataChannels guarantee ordered
delivery, so both sides stay in lockstep.

## The online lobby

Signed in, the Online Challenge tab gains a **lobby**: everyone else who is
online, their status, and a Challenge button. Send one and they get a card with
Accept and Decline; unanswered challenges expire. **Quick Match** puts you in a
queue and pairs you with whoever has waited longest - deliberately not
skill-based, because a queue that holds out for a good match is one nobody comes
out of.

**Rooms** are places to wait and chat - "501 Practice", "Cricket Only" - not
matches. Anyone in one can be challenged. There is room chat and private
whispers, and you can **block** someone, which is silent and stops them
challenging you, whispering to you, seeing you in the lobby, or being paired
with you by Quick Match.

Tapping a player opens their card: their real record, so "am I in for a game
here?" has an answer before you commit.

**Invite codes still work exactly as before, and are not going away.** They are
the only way to play without an account, the way to play someone who isn't in
your lobby, and the fallback if the lobby is unavailable. Accepting a challenge
simply creates one of those codes behind the scenes and hands it to both
players - so the match itself runs over the identical peer-to-peer connection it
always has, and the lobby drops out of the picture entirely. If the lobby went
down mid-match, your match would carry on.

## Rating and ranks

Play enough and you get a **rating from 1 to 20** and a rank from C up to GM,
using the familiar table: your x01 three-dart average ("01 PPR") and your
Cricket marks per round ("CR MPR") each map to a rating, and the two are
averaged.

You will see **two** of them, and they are the same table read twice:

- **80% stats** cover the pure scoring phase - x01 visits begun with 100 or more
  left, Cricket rounds before the bull was closed. This is what the rank table
  is built around, and what the badge shows.
- **100% stats** cover the whole game, including setup shots and darts thrown at
  a double that missed.

The thresholds are identical; only the darts feeding the average differ. That is
why the same player can be an M on their 80% stats and a B on their 100% - not
two systems, one system measuring two different things. Below ten legs you are
simply **unranked**, because an average over one leg is noise.

## Accounts, statistics and leaderboards

Entirely optional. **You never need an account to play** - local and online
darts work exactly as they always have without one, and the Android build,
which has no server behind it, is unaffected. Sign-in only appears when the app
can see an accounts API.

What an account adds:

- **Match history** - every finished match, with the format, opponent, darts
  thrown and result.
- **Statistics by game** - X01 gets three-dart and first-9 averages, checkout %,
  180s/140+/100+, highest checkout and doubles; Cricket gets marks per round,
  white horses, hat tricks, points scored and points prevented; Count Up gets
  round averages. Career totals, trends over time and a "most improved" figure
  sit on top.
- **Achievements**, a **dashboard** with personal bests and current form, and
  **leaderboards** - global, friends-only, or per club, all-time or this month.

### Every dart is stored

The app records each individual dart - the segment, what it scored, the score
before and after, whether it busted - not a summary at the end. Statistics are
computed from that. It means a new metric can be added later and applied to
matches you have already played, instead of starting from zero on the day it
ships, and it is why a corrected formula reprices your whole history rather than
only affecting new games.

### Playing as a guest

Finished matches are stored **on your device first** and uploaded afterwards, so:

- Matches played offline are not lost - they upload when you are next online.
- Statistics work with no account at all, computed in the browser from the
  matches on that device.
- If you later create an account, the matches you played as a guest are uploaded
  and become yours. Nothing is lost by not signing up first.

### Leaderboards are for fun, not for ranking

Scores are computed by each player's own app and uploaded. This is a
peer-to-peer app with no referee, so there is no way to prove a match happened -
these boards are for comparing yourself with friends, not for anything that
matters. Appearing on them is opt-in, under Profile.

Averages have qualifications (300 darts for a three-dart average, 50 rounds for
MPR, and so on) shown next to each board, because otherwise the top of every
board is whoever has thrown nine lucky darts.

### Where the data lives

A single SQLite file in `DATA_DIR` (`./data` locally, `/app/data` in the
container). SQLite is just a file, so the app stays one container with nothing
extra to run, and backing it up is copying it.

> **This directory must be persistent.** On a host with an ephemeral filesystem -
> Render's free tier being the obvious one - it is wiped on every deploy, which
> silently deletes every account. The darts keep working; the accounts do not.
> See the note in `render.yaml`, and the volume in `docker-compose.yml`.
>
> If the database cannot be opened the server does not fall over: it logs the
> problem, reports `"accounts": false` on `/healthz`, and carries on serving
> darts.

Passwords are hashed with scrypt. Sessions are random opaque tokens in the
database, delivered as an HttpOnly cookie - so signing out actually revokes
them, and a server restart does not log everyone out.

## Installing as a desktop app

The app is a PWA, so Chrome or Edge will offer to install it - look for the
install icon in the address bar, or the browser menu's "Install AIO Darts".
It then opens in its own window from the Start menu or taskbar, with no
browser chrome.

Web Bluetooth works exactly as it does in a tab, so a Granboard connects to
the installed app normally.

Installing also enables offline play, which matters if the PC by the board has
patchy wifi. The service worker is **network-first**: it always tries the
network and only falls back to the cache when there's no answer. That's a
deliberate trade - a cache-first worker is faster but would serve stale code
after a deploy, which is a miserable bug to chase. `config.json` and
`version.json` are never cached at all, so the signaling address and build
stamp are always current.

The install prompt needs a secure context (https, or localhost). Over a plain
LAN address the app still works, it just can't be installed - the same
condition Web Bluetooth has, so anywhere the board works, installing works.

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
| `ACCOUNTS` | *(unset - accounts on)* | Set to `off` to run guests-only without opening a database. See below. |

**`ACCOUNTS=off` is the honest setting for a host with no persistent disk.** An
ephemeral filesystem doesn't stop the database opening - it lets people sign up,
records their matches, and then deletes all of it on the next deploy, which is
worse than not offering accounts at all. Setting this skips the database
entirely: `/healthz` reports `accounts:false`, `/api/*` answers 503, the lobby
doesn't start, and the front-end hides the account tab exactly as it does in the
Android APK. Darts is unaffected - local play, invite-code online play and
on-device statistics all work.

### Adding a TURN relay

Only needed if some players can never connect while others can - the symptom
of a network that refuses direct peer-to-peer. Run a TURN server (coturn is
the usual choice) and set `TURN_URL`, `TURN_USERNAME`, and `TURN_CREDENTIAL`.
No code changes required; the front-end picks the servers up from
`/config.json` on load.

Bandwidth cost depends entirely on whether the players use the camera:

- **Scoring only** - negligible. A dart throw is a few bytes, so a relay costs
  effectively nothing and self-hosting coturn alongside this is cheap.
- **With camera and mic on** - this is a video call, and TURN relays every
  frame. Budget roughly 0.5-1 Mbit/s per direction per relayed match, i.e. up
  to ~2 Mbit/s of relay traffic for one match with both cameras on.

This only applies to matches that *need* the relay (the 10-20% of networks that
refuse direct P2P); everyone else connects peer-to-peer and never touches it.
Still, if you enable TURN on a metered connection, that difference is the one
to plan for. Players who don't press "Start camera & mic" cost you nothing
extra - no media is ever sent until they do.

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

## License

This project is licensed under the
[PolyForm Noncommercial License 1.0.0](LICENSE), with one exception: the
Bluetooth UUID and segment-decoding table in `granboard.js`, adapted from
[sobassy/gran-app](https://github.com/sobassy/gran-app), stays under its
original MIT terms (both are in the [`LICENSE`](LICENSE) file).

In plain terms:

- **Free** to view, clone, self-host, modify, and use for personal or
  noncommercial purposes - nothing changes for anyone already self-hosting a
  copy.
- **Not free** to build a commercial product or paid hosted service from
  this code without a separate agreement. A planned freemium tier (accounts,
  persistent stats, cloud sync - see [Roadmap](#roadmap)) depends on that
  restriction actually holding, rather than anyone being able to stand up the
  same paid service from the same code.
- No license file existed before this one, so the repository defaulted to
  standard copyright ("all rights reserved") rather than the open-by-default
  state a public GitHub repo is often assumed to have. This file makes the
  actual terms explicit.

Full terms are in [`LICENSE`](LICENSE). This isn't legal advice; commercial
use requires a separate agreement with the licensor.

## Roadmap

*Last reviewed: 30 July 2026.*

- The remaining Cricket variants (Cut-Throat, Wildcard, Low Ball, Hammer, the
  /200 spread limit) and the rest of the Arachnid "Other Games"
- Teams, and with them the Freeze Rule - which is a partners rule, so teams are
  the prerequisite rather than a flag
- Native Windows (C#/.NET) version
- Webcam-based hit detection for standard steel-tip boards

Done since the last review:

- ✅ **The online lobby** (3 August 2026) - live presence, challenges, Quick
  Match, rooms, chat and blocking. Gameplay stays peer-to-peer: an accepted
  challenge mints an ordinary invite code and hands it to both sides, so the
  match runs over the connection that always existed. Invite codes stay.
- ✅ **Rating and ranks** (3 August 2026) - the 1-20 scale and C-to-GM ranks,
  reported against both the 80% (scoring phase) and 100% (whole game) averages.
- ✅ **Bermuda Triangle** (3 August 2026) - thirteen rounds, and the halving
  that makes the game, playable locally and online with its own statistics.

- ✅ **Accounts, statistics, achievements and leaderboards** (2 August 2026) -
  optional accounts backed by a single SQLite file, with every dart recorded and
  all statistics derived from that. Statistics are modular by game, so a future
  game mode brings its own metrics, achievements and boards without a schema
  change. Guests keep working throughout: matches are stored on-device first,
  statistics are computed in the browser with no account, and anything played as
  a guest is claimed when you sign up.

- ✅ **Pre-match camera & mic check** (30 July 2026) - preview, level meter, and
  camera/mic pickers on the setup screen, so devices can be tested and chosen
  without starting a match. Choices persist and carry into the game; a stale
  device preference is worked out and dropped individually.
- ✅ **Camera switching and End match** (30 July 2026) - front/rear (or any
  multi-camera) switching that keeps the mic and connection untouched, with
  self-view mirroring that follows the camera's facing direction; plus a
  two-tap End match that drops the connection and releases the devices
  together, and tells the opponent.
- ✅ **Camera and mic in online matches** (30 July 2026) - opt-in webcam and
  microphone on the existing peer connection, so you can watch your opponent
  throw. The audio/video m-lines are negotiated up front and left empty, then
  filled in with `replaceTrack()`, which means switching a camera on needs no
  renegotiation and two players can do it simultaneously without glare. This
  changes the TURN bandwidth picture - see [Adding a TURN
  relay](#adding-a-turn-relay).
- ✅ **Cricket and medley matches online** (30 July 2026) - the peer protocol now
  sends the host's chosen format on connect and carries per-dart segments, so
  marks and leg state stay in sync without a separate message type per game.
