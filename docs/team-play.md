# Team play online, with cameras — a design, not an implementation

Status: **proposal, nothing built.** Written to be argued with. Every claim about
the current code carries a file reference so you can check it rather than trust
it.

**Revised 9 August 2026.** Five of the six open questions are now decided, and
the seat model is settled **for Cricket**, on the evidence of a photographed
Arachnid Galaxy 3 running Cricket /200 doubles — see section 3a. That machine is
already this codebase's reference for the x01 in/out matrix (`scoring.js`), so
following it here is consistency rather than a new dependency.

One new question has opened and it is now the most important one in the
document: **the Freeze Rule may mean partners x01 has per-player scores**, which
would make 3a's shared team score true of Cricket and false of x01. See 7a. The
practical answer is to build Cricket doubles first, which needs nothing this
document is unsure about.

---

## 1. The thing that changes the whole shape of this

**"2v2" is two completely different engineering problems depending on where the
four people are standing**, and they are not close in size.

In a pub, doubles is two teams at **one** board, taking turns. Nobody thinks of
that as four connections, because it isn't — it's a scoreboard with four names
on it.

So online doubles has two possible shapes:

| | People per house | Peers | What it costs |
| --- | --- | --- | --- |
| **A. Two at each end** | 2 | **2** | Small. No new networking at all. |
| **B. Four houses** | 1 | **4** | Large. New topology, new failure modes, real bandwidth. |

Shape A is what most people asking for "doubles online" actually picture: you and
your mate round yours, against two of theirs. It needs **no change to the peer
layer whatsoever** — it is still one connection between two boards.

Shape B is a genuinely different app.

I'd build A, ship it, and see whether anyone asks for B. The rest of this
document takes both seriously, but that is the recommendation and section 6 says
why.

---

## 2. What already works, which is more than I expected

The pure rules layer is **already team-ready**, and that is not luck — it's the
purity rule doing its job.

- `scoring.js`'s `resolveThrow(remainingBefore, segment, …)` takes **a score and
  a dart**. It has never known who threw.
- `cricket.js`'s `resolveCricketThrow(players, index, segment)` takes a player
  *slot*, not a person.
- `medley.js`'s `createMatch(legGames, playerCount)` (`medley.js:92`) is already
  N-player; `legsWon` is an array sized at call time.
- `game.js` already runs 3 and 4 handed local games — `currentPlayerIndex` is
  `(i + 1) % players.length` (`game.js:1119`), with no cap anywhere.
- `match_players` is keyed `(match_id, seat)` with no player-count assumption
  (`server/migrations/001_init.sql:97`).

**A team is a scoring seat with more than one person throwing into it.** That
sentence is the whole design. The rules modules already operate on seats, so
teams need no change to a single pure function — only the controllers need to
know that a seat can have two throwers and whose turn it is within it.

### What is hard-wired to exactly two

The 1v1 assumption is real but it is *concentrated*, which is good news:

- `online.js` — 64 references to `myIndex`/`oppIndex`/`activeSide`/`online.me`/
  `online.opp`, of which 22 are a literal binary `side === "me" ? … : …`.
- `webrtc.js` — `PeerLink` is 1:1 by construction, with `role` being exactly
  `"host"` or `"guest"` (`webrtc.js:91`).
- `server/server.js:483` — the signaling room refuses a third socket
  (`if (room.size >= 2) send(ws, { type: "room-full" })`).
- `server/lobby.js` — `startMatch(hostId, guestId)`; a challenge is one person
  asking one person.

Note that only the **last two** matter for Shape A. `online.js` needs work in
both shapes; `webrtc.js` and the signaling cap only matter for Shape B.

---

## 3. Shape A — two at each end

### What it is

Each end of the connection seats a **team**: two people, one board, one device,
one camera view of that board (or two, see below). The peer connection is
unchanged — still exactly two browsers.

Turn order is the standard doubles rotation, alternating both team and player:

```
A1  →  B1  →  A2  →  B2  →  A1 …
```

Score is per **team**. Both partners throw into the same 501, or the same set of
Cricket marks. That is how doubles is scored everywhere, and it falls out for
free because the rules already take a seat rather than a person.

### 3a. The seat model, which is the decision everything else rests on

**Decided: rules seats are TEAMS, recorder seats are PEOPLE, joined by a `team`
column.** Two index spaces where today there is one.

Today the three meanings collapse into a single number, and that is why the
current code reads so cleanly: `game.js` passes `state.currentPlayerIndex`
straight into the recorder (`game.js:676, 890, 931, 984, 1116`) and `online.js`
passes `seatOf(side)` (`online.js:2576–2864`). A rules seat *is* a recorder seat
*is* a person. Teams break that identity, because **a team is one scoring seat
with two people throwing into it**, and both halves are needed: per-team state or
it isn't doubles, per-person darts or the averages are meaningless.

The evidence that this is the right split rather than a guess — an Arachnid
Galaxy 3 mid-match, Cricket /200 doubles, round 5 of 25:

- **Two** mark columns, headed 1 and 2, for **four** players.
- **One** score per team — 240 for Gollon/Mazur, 190 for Bobzien/Cromwell.
- **Four** separate MPRs along the bottom (5.00, 2.50, 3.00, 4.00), one per
  person.

So the machine keeps game state per team and darts per person, which is exactly
this split. It also rules out the cheaper alternative of two seats with a thrower
index: that models the scoreboard correctly and throws away every per-person
statistic, and those four MPRs are the thing a doubles player actually looks at.

Where the boundary falls, which is the useful part:

| | Space | Changes? |
| --- | --- | --- |
| `scoring.js`, `cricket.js`, `bermuda.js` | rules seat = **team** | **No.** A doubles Cricket match is still a players array of length 2. |
| `matchrecorder.js`, `statsengine.js`, `stats/*` | recorder seat = **person** | Yes — four entries, plus the team join. |
| `game.js`, `online.js` | own the mapping | Yes — and they are the **only** place the two can be confused. |

Keeping the mapping in exactly two files is the whole point. `CLAUDE.md` already
records what happens to a convention duplicated across files — the ring→segment
slot mapping lives in four places and is called out as a hazard — and this one
would fail *silently, into people's statistics*, rather than visibly on a board.

**The `=== seat` comparisons are the concrete work**, and there are more of them
than "add a column" suggests. A win is currently attributed to exactly one seat:

- `statsengine.js:121` — `won: leg.winnerSeat === seat`
- `statsengine.js:161, 209, 275` — `match.winnerSeat === seat`
- `matchrecorder.js:407` — `doc.players[winnerSeat].legsWon += 1`

Left alone, **the partner who did not throw the winning dart gets nothing**: no
leg, no match, no win streak, and the achievements at `statsengine.js:453–457`
(`won >= 1 / 10 / 100`) stop counting for half of all players. Every one of those
becomes "is this seat on the winning team". That is what the `team` column is
for, and it is why the statistics half of this is the larger half — the turn
rotation genuinely is nearly free (`game.js:1119` is already modular over
`players.length`), and it is easy to mistake the whole feature for that.

### One thing to steal from the machine's layout

The current thrower is named **large**, with the team pair small underneath —
`BRAD GOLLON` over `GOLLON MAZUR`. That answers "whose turn is it *within* the
team" in space the name already occupies, instead of adding a turn indicator.
It is the one genuinely new piece of information a doubles scoreboard has to
carry, and it costs no layout.

### What actually has to change

**`online.js`** — `online.me` and `online.opp` become team objects. They already
hold `{ remaining, marks, points, dartsThisTurn, … }`; they gain a `throwers`
array and a `throwerIndex`. `activeSide` stays binary — it is still "which end of
the connection is throwing" — and a second, smaller question appears: *which of
my two is at the oche*. Advancing that on `commitTurn` is one line beside the
existing `activeSide` flip.

**The peer protocol barely moves.** `dart`, `quick_total`, `end_turn`,
`next_leg`, `undo` all still mean the same thing, because they are all about the
*side*, and the side is now a team. The only message that grows is `match_config`
/ `hello`, which already carry a display name and would carry a roster instead.
This matters: adding a game mode has never needed a new peer message
(`CLAUDE.md`), and neither does this.

**`matchrecorder.js`** — four seats instead of two. Every dart already records a
seat, so the per-person *throwing* statistics — averages, MPR, checkout
percentage, the heatmap — keep working unchanged, which is a real saving. What
does not is anything derived from **winning**: see the `=== seat` list in 3a.
An earlier draft of this document said per-player statistics keep working
"unchanged" full stop, and that was wrong in the way that matters — it is the
win attribution that silently halves.

**Schema** — `match_players` needs a `team` column. I'd argue hard against the
tempting alternative of "seats 0 and 2 are one team, 1 and 3 the other": that is
a convention that would have to be known by the recorder, the stats engine, the
leaderboards and both controllers, and `CLAUDE.md` already records what happens
to conventions duplicated across files (the ring→segment-ID slot mapping, which
lives in four places and is called out as a hazard). One nullable integer column
is cheaper than five copies of a rule. `team` stays `NULL` for singles, which is
also the honest representation.

**Statistics** — **partly decided.** Per-person darts *are* recorded in a doubles
match: the machine shows four MPRs, and section 3a follows it. What that does not
settle is whether those darts then feed your *singles* averages and leaderboards,
which is still a judgement call. My suggestion stands: the darts count toward
your averages, because they are real darts you threw at a real board; the win
does not count toward singles leaderboards. That is exactly the rule already
applied to matches against a computer opponent (`ENGINE_VERSION` 7), so there is
precedent and a place to put it.

**Cameras — nothing to do, and this is now confirmed rather than argued.**
**DECIDED: the camera setup in Shape A is identical to singles.** The earlier
draft speculated about how a team might allocate its two m-lines — one per
player, or one on the board and one on the thrower. That framing was wrong,
because it treated a camera as belonging to a *person*. It belongs to an **end**:
both partners stand at one board, so what the far side needs to see is exactly
what it needs to see in a singles match, and there is no second viewpoint to
carry.

So the media path does not change at all. One main camera per end plus the
existing optional board camera, the same two m-lines already negotiated up front
and filled with `replaceTrack()`, the same `media_state` message intercepted in
`webrtc.js`, the same device check, the same `switchCamera()` and mirroring
rules. Nothing renegotiates and no bandwidth question arises — **doubling the
players does not double the streams**, which is the single sharpest difference
between Shape A and Shape B, where four cameras in a mesh is the cost that
forces an SFU (section 4).

One small UI consequence, not a networking one: a video tile is now a **team**,
so the tile shows two people while the scoreboard names one. That is consistent
with the existing rule that each player's score sits on their own camera — the
score on a tile is simply the team's — and it pairs with the naming pattern
below, where the tile shows the pair and the large name says which of them is
throwing.

### What is genuinely fiddly

- **Undo.** Today there are two stacks, `me` and `opp`, and the window closes
  when *the opponent* throws. With four people the phrase "your own darts" still
  works (your team's), but "the opponent throws" needs to become "anyone on the
  other team throws". Small, but it is the kind of thing that is wrong quietly.
- **The visit hold.** Unchanged in shape — the thrower still owns the clock and
  announces the end with `end_turn`. It just passes to your partner sometimes
  instead of across the connection.
- **Who checks out.** Standard doubles: anyone on the team may finish. Worth
  confirming (section 7).

### Rough size

Two or three days of careful work, plus one migration. No new failure modes.
Nothing in the networking layer moves.

**Where those days go is not where it looks.** The instinct is that doubles is
"take turns differently", and that part is nearly free — `game.js:1119` already
rotates modulo `players.length`, and the pure rules have never known who threw.
The work is in the statistics: two index spaces to keep straight, and every
`=== seat` win comparison in 3a to widen. Budget it the other way round from
your instinct.

---

## 4. Shape B — four separate houses

This is where it stops being an extension and starts being a different app.

### The real problem is not connections, it is ORDER

`CLAUDE.md` states the sync strategy plainly: *"Determinism is the sync strategy.
There is no rollback/replay, no authoritative server. Both browsers run the
identical pure functions and stay in lockstep because WebRTC DataChannels deliver
in order."*

That guarantee is **per channel, between two peers**. Four peers in a full mesh
have six channels and *no global order at all*. If two messages are in flight at
once, peer B can legitimately apply them in one order and peer D in the other —
and in Cricket the order decides whether a number was closed when a dart landed,
which changes whether it scored. The scoreboards then disagree, permanently, with
no mechanism to reconcile because there is deliberately no rollback and no
authority.

Turn discipline hides most of this — only one person is supposed to be throwing —
but "most" is not the standard the current design holds itself to, and the races
that remain are exactly the ones already known to exist: a dart arriving during
the ten-second hold, and a late message after a turn has passed.

### Three ways out

**(a) Full mesh, trust turn order.** Six connections, no single point of failure.
Rejected: it keeps the topology honest and the *correctness* dishonest, and the
failure mode is two scoreboards silently disagreeing about a Cricket leg.

**(b) Host as sequencer — a star.** Every game message goes to the host; the host
stamps a monotonic sequence number and rebroadcasts to all. Total order is
restored exactly, so the existing determinism argument works again word for word.
The server still never sees a dart, so the project's central principle survives
intact. Costs: one extra hop of latency for guest→guest messages, and the host
leaving ends the match — though `teardownMatch` already treats a lost peer as the
end of the match, so that is a smaller change in behaviour than it sounds.
**This is the one I'd build.**

**(c) Server-authoritative.** Rejected outright. It contradicts *"the server
still never sees a dart, and a lobby outage cannot interrupt a match in
progress"*, which is load-bearing for the whole deployment story.

### What (b) actually requires

- **`server/server.js`** — signaling rooms gain a capacity and a role beyond
  host/guest (`server/server.js:483`). Small.
- **`webrtc.js`** — `PeerLink` stays 1:1; the host simply holds three of them.
  That is less invasive than it sounds, but the transceiver **slot contract**
  ("video m-line 0 is the main camera, m-line 1 is the second one, on both
  sides") is written for one remote and needs re-reading per link. The
  no-renegotiation design still holds, which is the important part.
- **`online.js`** — this is the big one. `me`/`opp` becomes a seat array, and all
  22 binary `side === "me"` branches become seat lookups. Undo goes from two
  stacks to N. The hold's backstop timer has to work for three receivers rather
  than one.

### Media is the part that bites

Four cameras in a mesh means **every player uploads three copies of their own
stream**. At the app's current defaults (640×480, 24fps ≈ 0.5–1 Mbps) that is
1.5–3 Mbps of upstream per person before you count the second camera m-line the
app reserves. Plenty of domestic connections will not do that, and the ones that
will are not the ones a pub laptop is on.

Options, none free:

- **One camera per player in team play**, dropping the second m-line. Halves it.
- **Lower resolution when more than two people are connected** — the tiles are
  smaller in a four-up layout anyway, so this costs nothing visible.
- **Only send video to whoever needs it** — e.g. full rate to the opposing team,
  nothing to your own partner, who is standing next to you. In Shape B they are
  not, so this doesn't apply. In a 2+1+1 hybrid it does.
- **An SFU.** Each peer uploads once. This is the honest answer at four-plus, and
  it is also the point where *"one process, one port… no server in the middle"*
  stops being true and someone starts paying for egress. Not a decision to make
  by accident.

And TURN: relayed traffic multiplies by the number of links. `README.md` already
warns that a relayed 1v1 with cameras is "a video call's worth of traffic". A
relayed four-way is six of them.

### Everything else that quietly assumes two

- **Rematch** is a mutual handshake between two people (`rematch_offer` →
  `rematch_accept`/`decline`), and it is mutual *on purpose*. With four, does it
  need all four to accept? Probably — but that is a real protocol change, and the
  alternative is to send everyone back to the lobby.
- **The lobby has no concept of a party.** `startMatch(hostId, guestId)` is one
  person against one person. Team play needs: invite a partner, form a pair, then
  challenge another pair. That is a genuine lobby feature, comparable in size to
  the rooms work, and it is easy to forget when estimating "2v2".
- **Leaderboards** rank individuals. A doubles result has to not silently become
  a singles win.

### Rough size

Weeks, not days, and it lands on the three files that are hardest to test
(`webrtc.js`, `online.js`, `server/lobby.js`). The signaling and topology work is
the *smallest* part of it; the lobby's party formation and the media budget are
where the time actually goes.

---

## 5. A middle option worth considering

**Three players, or 2v1, or 2+1+1** — i.e. allow *any* seat to be shared, and
allow more than two ends, but do the two independently.

Shape A generalises to "a seat can have N throwers" without touching the
network. Shape B generalises to "there can be N ends". They are orthogonal, and
doing A first does not make B harder — A's work is in the controller and the
recorder, B's is in the transport. That is a good sign the split is along the
right seam.

---

## 6. Recommendation

**Build Shape A first.** *(Updated 9 August 2026: the original recommendation
was "do not build Shape B until someone asks for it by name". Someone has —
both are wanted. That changes the timeline, not the order, for reason 4 below:
A's work is in the controller and the recorder, B's is in the transport, and A
is not a detour on the way to B.)*

The reasoning:

1. It delivers real doubles — the thing people mean — for a small fraction of the
   cost.
2. It touches nothing that is hard to test. No new topology, no new failure
   modes, no bandwidth question, and the camera work is *already done*.
3. It is the shape darts is actually played in. Two people round one board is not
   a compromise version of doubles; it is doubles.
4. It does not foreclose Shape B. The seat/thrower split it introduces is exactly
   what Shape B would need anyway.

The one honest argument against: if what you actually want is four mates in four
different houses, Shape A does not give you that at all. That is now known to be
wanted eventually — so the argument has real force, and the answer to it is
reason 4 rather than a denial. Shape A is not thrown away when B is built; the
seat/thrower split is the foundation B stands on, and B adds ends where A added
throwers. What A does not do is bring B any closer in the transport layer, so if
four-separate-houses is the urgent need rather than the eventual one, this order
is wrong.

---

## 7. Decisions

Three settled on 9 August 2026, three still open.

1. ~~**Which shape do you actually want?**~~ **DECIDED: both, eventually — Shape
   A first.** Shape B is wanted in the future, which does not change the order:
   section 5's point holds that A is controller-and-recorder work and B is
   transport work, so building A first is not a detour that has to be undone.
   Nothing in A touches `webrtc.js` or the signaling cap.
2. ~~**Do doubles darts count toward your singles averages?**~~ **HALF DECIDED.**
   Per-person darts *are* recorded in a doubles match — the reference machine
   shows four separate MPRs and section 3a follows it. Whether they then feed
   the *singles* averages and leaderboards is still open; suggestion unchanged
   (yes for darts, no for wins, as with computer opponents).
3. ~~**Cricket doubles: shared marks?**~~ **DECIDED: yes, shared.** Confirmed
   directly: two mark columns for four players, one team score each. This is
   what keeps `cricket.js` unchanged — a doubles match is still a players array
   of length 2.
4. ~~**x01 doubles: may either partner check out?**~~ **DECIDED: yes, either
   partner may finish** — the standard rule, and the default the code should
   assume. **But it is conditional**, and the condition is the Freeze Rule: see
   7a, which is now the largest open question in this document.
5. ~~**In Shape A, what do the two cameras point at?**~~ **DECIDED: exactly what
   they point at in singles.** Both partners are at one board, so a camera
   belongs to an *end*, not to a person, and there is no second viewpoint to
   carry. The whole media path is unchanged — see section 3. The question was
   malformed: it assumed a team would want to spend its two m-lines differently,
   when the reason Shape A is cheap is that it does not want to spend them at
   all.
6. **What happens when one player of four drops?** Forfeit the team, pause, or
   let their partner throw both? This has no standard answer and it will happen.

### 7a. The Freeze Rule may contradict the shared team score, and that is not a footnote

**Open, and it is the question that could invalidate 3a for x01.**

Section 3a settled the seat model on a photograph of a **Cricket** match: one
score per team, marks per team, darts per person. The Freeze Rule is a **partners
x01** rule, and the note that closed question 4 above is that either partner may
check out *"unless some special circumstances like freeze rules where they depend
on each other's scores."*

**"Each other's scores" is the problem.** If a frozen partner is a fact about one
*person's* score rather than the team's, then partners x01 has per-player scores
as well as — or instead of — a shared one, and the clean statement "rules seat =
team" is true of Cricket and false of x01. That is a materially different data
model, and it is the kind of thing that is very expensive to retrofit: it would
mean the team object carries per-thrower scoring state, `scoring.js`'s caller
changes shape, and the recorder's team join stops being the only place teams are
known.

The two possibilities, which need separating before any x01 doubles code:

- **The freeze compares the two TEAMS' scores.** Shared team score survives
  intact, 3a holds everywhere, and the rule is a check in the controller before
  allowing a finish. Cheap.
- **The freeze compares the two PARTNERS' scores.** Partners x01 needs per-player
  scoring state, and 3a needs a carve-out saying so. Not cheap, but knowing it
  early is what makes it not-cheap rather than a rewrite.

**This document does not currently know which**, and guessing is exactly what the
codebase's convention forbids — the rules layer records edge cases precisely and
says why, and a scoring rule invented from a plausible-sounding name would be
wrong quietly, in the way the 170-vs-180 checkout ceiling was flagged as being
able to go wrong quietly. The Arachnid manual is the reference this project
already uses for the x01 in/out matrix, so it is the place to settle it.

Two consequences even before it is settled:

1. The roadmap's ordering was right for a reason that is now clearer. It lists
   the Freeze Rule as needing teams as a *prerequisite* rather than being a flag
   — and if the second possibility above is the true one, teams are a
   prerequisite in a stronger sense than "you need four players first".
2. **Build Cricket doubles first.** It is fully specified by 3a, needs no rule
   this document is unsure about, and exercises the entire seat/thrower split.
   x01 doubles can follow once the freeze question is answered, and nothing about
   doing Cricket first has to be undone.

---

## 8. The order I'd do it in

**Revised: start with `game.js`, not `online.js`.** The original order below
opened with the seat/thrower split in `online.js`. Local pass-and-play doubles —
four people round one board — is the same split with none of the surrounding
difficulty: no protocol, no roster in `hello`, no undo window to widen across a
connection, no peer that might be running an older build. It is also a real
feature in its own right rather than scaffolding, and the Freeze Rule lands there
too. Doing it first proves the two-index model against the recorder in the one
place where a mistake is cheap to find. Then online is mostly rotation plus the
roster.

This is a recommendation, not a decided point.

1. **Local doubles in `game.js`, Cricket first.** Seat/thrower split, singles
   still working throughout — a team of one is a singles player, so nothing
   needs a special case. Rotation is `game.js:1119`, which is already modular
   over `players.length`. Cricket rather than x01 because 3a fully specifies it
   and 7a does not yet specify x01; x01 doubles slots in unchanged once the
   Freeze Rule question is answered.
2. **Recorder: four seats, `team` column, migration.** Including every
   `=== seat` win comparison listed in 3a — this is the part that silently
   halves if it is missed.
3. **Stats: decide the singles-averages rule, bump `ENGINE_VERSION`.**
4. **`online.js`:** seat/thrower split, then the roster in `hello`/
   `match_config`.
5. **Turn rotation online, and the undo window widening** to "anyone on the
   other team throws".
6. **Lobby: pair formation. This is the biggest single piece and is easy to
   under-estimate** — until it exists, doubles is invite-code only, which is a
   perfectly good first release.
