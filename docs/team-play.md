# Team play online, with cameras — a design, not an implementation

Status: **proposal, nothing built.** Written to be argued with. Every claim about
the current code carries a file reference so you can check it rather than trust
it.

**Revised 9 August 2026.** Five of the six original questions are decided, the
sixth is online-only and blocks nothing, and the Freeze Rule — which opened as a
seventh and larger question — now has a sourced answer in 7a.

**The seat model differs by game AND by variant, and that is the headline.**
There are two models, not one: freeze-ON partners x01 gives every player their
own score (four scores, one index space), while freeze-OFF partners x01 and
Cricket doubles both share a team total (two scores, two index spaces). So the
Freeze Rule is not a rule modifying a game — it is a format selecting a data
model. See the table in 3a and the rule in 7a.

Build order: **freeze-ON x01 doubles first** as a thin first step where every
error is visible, then the shared-total model once, serving freeze-OFF x01 and
Cricket together. 7c sets out the honest argument against that ordering, which is
that it ships the niche variant before the expected one.

---

## 0. The two kinds of doubles, and what they are called

**Adopted 9 August 2026, and it supersedes the "Shape A / Shape B" labels used
throughout the rest of this document.** The distinction is not about online
versus offline — it is about **where the players are standing**, which is the
thing that actually decides the engineering:

- **LOCAL DOUBLES** — partners share **one board and one machine**. They take
  turns at the same oche, and the app sees one device for the pair. This is
  what a pub doubles match is, and it works both in pass-and-play and online,
  where each *end* of the connection is a local pair.
- **REMOTE DOUBLES** — every player has **their own setup**: their own board,
  their own machine, their own connection. Four people, four devices.

The old names map straight onto these: Shape A is local doubles at each end of
an online match, and Shape B is remote doubles. The new names are better
because they say what is true of the players rather than which section of this
document described it first, and because "local doubles" is a real thing you
can play with nobody online at all — which `game.js` now does.

Everything built so far is **local doubles**. Remote doubles is unbuilt, and
section 4 is still the honest account of what it costs.

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

Score is per **team** — *in Cricket.* Both partners throw into the same set of
marks, and that falls out for free because the rules already take a seat rather
than a person.

**x01 is not like this, and an earlier draft of this document was wrong to
assume it was.** Partners x01 on the reference machines is played with **four
separate scores**, one per person, and the team exists only for the win
condition and the Freeze Rule. See 7a, which now has a definite answer, and 3a,
which carves x01 out.

### 3a. The seat model, which is the decision everything else rests on

**Decided, and it differs by game — which is the single most important line in
this document.**

| Game | Rules seats | Recorder seats | Index spaces |
| --- | --- | --- | --- |
| **x01 doubles, freeze ON** | **4** — every player has their own remaining | 4 — one per person | **One.** Same as today. |
| **x01 doubles, freeze OFF** | **2** — 2v2 with a shared team total | 4 — one per person | **Two.** |
| **Cricket doubles** | **2** — the team shares marks and points | 4 — one per person | **Two.** |

Recorder seats are PEOPLE in all three, joined to teams by a `team` column. What
varies is whether the *rules* layer sees teams at all — it does in every row but
the first. The evidence for each is direct: a photographed Cricket /200 doubles
match shows two mark columns for four players, and the reference explanation of
the Freeze Rule (7a) describes partners x01 as "X01 games with 4 Scores".

The consequence is counter-intuitive and worth stating plainly, because it
reverses the obvious guess about which game is easier to build:

- **Cricket doubles has the two-index problem.** Rules seat ≠ recorder seat, and
  the controllers own a mapping that can be silently wrong.
- **x01 doubles does not.** A rules seat is a person is a recorder seat, exactly
  as today, so `game.js` can keep passing `state.currentPlayerIndex` straight
  into the recorder. What x01 adds instead is a *rule* — the freeze predicate —
  which is pure, self-contained and testable, and a team-based win condition.

The rest of this section describes the two-index split, which applies **to
Cricket doubles and to freeze-OFF x01 doubles** — the two rows that share a
team total, and therefore one piece of work rather than two.

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

### 3b. One shared board per end — and why the thrower index is safety-critical

**Confirmed: both partners at an end share one board, one camera and one mic.**
The hardware path needs no change at all, which is worth checking rather than
assuming: `boardlink.js` has **no concept of a player**. It owns the one
connection and routes each segment to whichever controller wants it
(`boardlink.js:44, 81`), and `deliverExternalSegment` feeds camera scorers into
the identical path. A dart carries a segment and nothing else.

That is exactly why it works, and exactly where the danger is. **A dart has no
identity, so the only thing deciding which partner is credited is the controller's
thrower index.** In singles that is safe, because the current seat *is* the
person and getting it wrong shows up immediately as the wrong score on the wrong
side of the board.

Under teams it is not safe, and the reason is the whole argument of this section:
**both partners score into the same team total, so a dart credited to the wrong
partner produces an identical scoreboard.** The team score is right. The marks
are right. The leg plays out correctly and the winner is correct. Nothing on
screen is wrong. The only thing that is wrong is the per-person average — quietly,
permanently, and in the direction of whichever partner happened to be indexed.

This is the same class of failure the codebase already worries about elsewhere
and for the same reason — a scoring bug shows up on a board you are looking at, a
statistics bug looks exactly like a correct one for months (`CLAUDE.md`, on why
`statsengine.test.js` exists at all). Two consequences:

- **The thrower index deserves test coverage**, not just care. It is the one
  piece of team state with no visible symptom when it is wrong, which makes it
  the one piece that a test has to hold rather than a play-through.
- **It is another argument for the four-seat model.** Under two seats with a
  thrower index the per-person figures do not exist, so the bug is unreachable —
  but only because the feature is absent. Recording per person is what makes
  those four MPRs possible *and* what makes them worth protecting.

The mic is shared too, which has one small user-visible consequence: the existing
"mute the opponent" control now mutes **two people**, because it mutes an end.
That is the correct behaviour and needs no change, but the control's wording is
written for one person.

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
2. ~~**Do doubles darts count toward your singles averages?**~~ **DECIDED: yes
   for darts, no for wins.** Doubles darts are real darts thrown at a real
   board, so they feed your averages, MPR, checkout percentage and heatmap. The
   *win* does not touch the singles win count, win percentage, streaks or the
   `won >= N` achievements — a doubles result must not silently become a singles
   one. Doubles wins can get their own counters and boards later; see 7b, which
   also corrects this document's claim that there was an existing precedent for
   this shape.
3. ~~**Cricket doubles: shared marks?**~~ **DECIDED: yes, shared.** Confirmed
   directly: two mark columns for four players, one team score each. This is
   what keeps `cricket.js` unchanged — a doubles match is still a players array
   of length 2.
4. ~~**x01 doubles: may either partner check out?**~~ **DECIDED: yes, subject to
   the freeze test.** Either partner may finish, *unless they are frozen* —
   which is the case when their partner's score exceeds the opposing team's
   combined score. Finishing while frozen does not merely fail; it hands the leg
   to the opponents. The rule is now fully specified in 7a.
5. ~~**In Shape A, what do the two cameras point at?**~~ **DECIDED: exactly what
   they point at in singles.** Both partners are at one board, so a camera
   belongs to an *end*, not to a person, and there is no second viewpoint to
   carry. The whole media path is unchanged — see section 3. The question was
   malformed: it assumed a team would want to spend its two m-lines differently,
   when the reason Shape A is cheap is that it does not want to spend them at
   all.
6. **What happens when one player of four drops?** Forfeit the team, pause, or
   let their partner throw both? This has no standard answer and it will happen.

### 7a. The Freeze Rule — ANSWERED, and it reshapes x01 doubles

**Source:** CAP Amusement, "Freeze Rule",
<https://www.capamusement.com/article.cfm?ArticleNumber=38>.

**The rule, as stated:** *"A player may go out and win only if their partners
score is equal to or less than the combined score of the opposing team."*

Three facts follow, and each one changes something:

**1. Partners x01 has FOUR SEPARATE SCORES.** The rule is scoped to "X01 games
with 4 Scores" — each of the four players carries their own remaining. This is
the per-partner reading, and it is stronger than feared: it is not that the
freeze *condition* needs per-player state bolted onto a shared score, it is that
there is no shared score at all. 3a is carved accordingly.

The unexpected consequence is that this makes x01 doubles **simpler**, not
harder. With a score per person, a rules seat is a person is a recorder seat —
one index space, exactly as today — so the two-index hazard that Cricket doubles
introduces does not exist here. `game.js` already runs four-handed x01 with four
scores. What x01 doubles adds is the team grouping, the win condition, and the
freeze predicate.

**2. The comparison is asymmetric, and reads three of the four scores.** Whether
*I* may finish depends on **my partner's** score against the **opposing team's
combined** score — the sum of both opponents' remaining. It does not involve my
own score at all. So the predicate is:

```
canGoOut(partnerRemaining, oppA + oppB)  →  partnerRemaining <= oppA + oppB
```

Pure, total, trivially testable, and it belongs beside `resolveThrow` in
`scoring.js` — or in a small partners module — rather than in a controller. It
is precisely the kind of arithmetic `server/checkout.test.js` exists to pin down.

**3. Checking out while frozen LOSES THE LEG — and that outcome is itself a
setting.** The source says *"If a player reaches zero when he/she is 'frozen',
the win is credited to the opposing team."* **Decided: make it a per-leg
choice**, because the penalty is severe enough that houses differ on it and the
gentler reading is a plain bust.

```
rules.frozenFinish: "loss" | "bust"      default "loss"
```

- **`"loss"`** — the leg ends and the **opponents** win it. The sourced
  behaviour, and the default, on the same principle that keeps `X01_RULES`
  matching the machines rather than matching taste.
- **`"bust"`** — the score is restored and the turn passes, exactly like any
  other bust. This costs nothing to implement: it reuses the bust path whole,
  which is the point of offering it.

It sits in `rules` beside the in/out matrix and the freeze flag, and it is a
**dependent setting** — meaningless when freeze is off. `normalizeLeg` should
still default it unconditionally (an absent key must never mean "undefined
behaviour"), and the format picker should disable rather than hide it when
freeze is off, so it is discoverable as belonging to the freeze.

**Only `"loss"` needs anything new**: `medley.js`'s leg resolution has to express
*"this leg was won by the side that did not finish it"*, which is the only place
in the app where reaching zero is a defeat.

**The recorder already survives this, and it is worth knowing why before someone
tidies it.** `matchrecorder.js:399–408` marks the winning visit as a checkout
only when `turn.seat === winnerSeat`. Under a frozen loss the open turn belongs
to the player who reached zero and `winnerSeat` is an opponent, so the two
differ and **`isCheckout` correctly stays false** — a leg lost by finishing is
not a checkout, and it must not inflate that player's checkout percentage. That
is the right outcome, but it is right *by seat comparison* rather than by
intent: the comment above it reads "marks the winning visit as the checkout",
which quietly assumes the winner is the finisher. Under this rule that
assumption is false. Anyone simplifying it to "mark the open turn as the
checkout" would silently start crediting frozen losses as successful checkouts.

**The opportunity, which is worth taking.** The source notes: *"The board does
not prompt you for this so it is the player's responsibility to spot it."* That
is a hardware limitation, not a design intent, and this app is under no such
constraint — the predicate is pure and the app already knows all four scores. A
frozen player can simply be **told**, in the same place the checkout hint is
shown (`checkouthint.js`), and the catastrophic outcome above becomes
unreachable rather than merely rare. This is the clearest example so far of the
app being able to beat the machine it takes its rules from, and it costs almost
nothing.

**The freeze is a GAME VERSION, and it selects the SCORING STRUCTURE.** Not all
four-or-more-player x01 games carry it. Confirmed:

- **Freeze ON** — four separate scores, one per player. The team exists only for
  the win condition and the freeze test.
- **Freeze OFF** — 2v2 with a **shared team total**, the ordinary doubles most
  people picture.

**A correction to an earlier revision of this section**, which called the freeze
"one more key beside the in/out matrix" and said "nothing else learns a new
concept". That was wrong, and wrong in the direction that matters. The in/out
rules change what a dart *does*; this changes **how many scores exist on the
board**. It is a format that selects a data model, not a rule that modifies one,
and treating it as a mere flag would mean discovering halfway through the
controller that the scoreboard has a different number of lines depending on a
checkbox.

It still lives in the leg descriptor — `{game:"x01", score, rules}`, with the
freeze beside the in/out matrix in `rules` — because that is where a format
belongs and `normalizeLeg` is already where legacy shapes are absorbed. What
changes is that reading it is not optional for anything downstream: the
controller, the scoreboard and the recorder's team join all branch on it.

The shortcut to avoid is still "partners x01 ⇒ freeze". Both partners x01
variants exist, and they are different games.

**The useful consequence: freeze-OFF x01 doubles and Cricket doubles have the
SAME seat model.** Two rules seats, four recorder seats, joined by `team`. So the
two-index work described in the rest of 3a is done **once** and serves both, and
the freeze-ON variant is the only one that escapes it. That is what makes the
build order in 7c coherent rather than arbitrary.

### 7b. Darts in, wins out — and why the practice-match precedent does NOT transfer

**Decided (question 2): doubles darts feed your averages; doubles wins do not
feed your singles wins.** Reason: the darts are real darts you threw at a real
board, so excluding them would under-report how much you have played and drag
nothing but noise out of your averages. The win belongs to two people, so
counting it as a singles win overstates you by exactly one partner.

**Correction.** Earlier revisions of this document twice said this was "exactly
the rule already applied to matches against a computer opponent, so there is
precedent and a place to put it". Checked, and that is wrong in a way that
matters for implementation.

A practice match is excluded **entirely** — darts and all. `statsengine.js:518`
is `match.mode === "practice"`, and `computeStats` filters those matches out at
the door before anything is computed (`statsengine.js:527`), then re-runs the
whole engine over the other pile to report them separately. It is all-or-nothing
by design: *"the darts are real darts, but the record is not a record of playing
anybody."*

Doubles is the first split in this app that is **partial**, and the filter
mechanism cannot express it. A doubles match must stay in the main pile, because
its darts count. So the exclusion moves from a filter at the entry point to a
**predicate consulted inside the win counting** — `careerStats`' `won`,
`winPct`, the streak walk, the per-game buckets at `statsengine.js:275`, and the
`won >= 1 / 10 / 100` achievements at `statsengine.js:453–457`. Every one of
those is a place where a doubles match has to be skipped while its darts have
already been counted somewhere else.

That is more scattered than "add a filter", and it is the same list as the
`=== seat` list in 3a — which is convenient, because both are fixed in the same
pass over the same functions.

**Doubles wins later cost no migration.** Once matches carry `team` and
`winnerSeat`, "who won this doubles match" is already recorded; adding doubles
win counts, a doubles win percentage, doubles streaks and a doubles leaderboard
is a presentation and aggregation change with no schema work — the same property
that lets a new game mode bring its own metrics without touching the database.
Designing the exclusion as *"not counted here"* rather than *"not recorded"* is
what keeps that door open, and is the reason to resist the shortcut of simply
not writing a `winnerSeat` for doubles legs.

**Bump `ENGINE_VERSION` to 9 when this lands.** No historical number moves —
there are no doubles matches yet — so the cache does not strictly need
invalidating. But the convention in that file is that the version records what a
number *means*, and "your average now includes darts thrown in doubles" is
exactly that. The numbered list of definitions is load-bearing documentation
here, and an entry costs nothing.

### 7c. Which game to build first — and the one honest tension in this document

There are now **two** seat models to build, not three: freeze-ON x01 stands
alone, while freeze-OFF x01 and Cricket share one. The order is therefore a
choice between starting with the easy model or the important one, and they are
not the same.

**Recommendation: freeze-ON x01 doubles first, as a deliberately thin first
step.** It is the only variant with **one index space**, so it proves turn
rotation, team grouping, the team win condition and the recorder's `team` column
in a setting where **every mistake is visible**. The silently mis-attributed dart
of 3b cannot happen when each player has their own score — credit a dart to the
wrong partner and it lands on the wrong line immediately. `game.js` already runs
four-handed x01 with four separate scores, so the throwing half is close to done,
and the genuinely new part is a pure predicate that is trivial to test.

Then the shared-total model **once**, serving freeze-OFF x01 doubles and Cricket
doubles together.

**The honest argument against, which you should weigh rather than take my word
on.** The variant I am recommending building first is the *niche* one. What most
people mean by "2v2 darts" is the shared team total — freeze OFF — and that is
also the model Cricket needs. So this order ships the unusual variant first and
defers the expected one. If what you want is the most-wanted feature soonest, go
straight at the shared-total model and accept that the first team code written is
also the code carrying the invisible-failure risk of 3b.

I would still take the thin first step, because the risk it retires is
specifically the one this codebase treats as most dangerous — a statistics error
with no visible symptom — and it retires it for a few days' work rather than by
being careful. But it is a judgement, not a deduction.

The roadmap's ordering was right all along, and for a reason now visible: it
lists the Freeze Rule as needing teams as a **prerequisite** rather than as a
flag. It is a prerequisite in the strong sense — the rule is unstatable without
partners.

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

1. ~~**The freeze predicate, pure and tested, before any UI.**~~ **DONE.**
   `isFrozen` and `resolvePartnersThrow` in `scoring.js`, with 23 tests in
   `server/freeze.test.js`. `resolvePartnersThrow` composes `resolveThrow`
   rather than reimplementing any of it, and asks about the freeze only once
   `isWin` is true — so a dart that busts on the out rule still busts instead
   of conceding the leg.
2. ~~**Local x01 doubles, freeze ON, in `game.js`.**~~ **DONE.** A Partners
   (2 v 2) toggle at exactly four seats, `teams.js` for the pairing, the freeze
   on the leg descriptor, the team win condition, both `frozenFinish` outcomes,
   and the frozen warning of step 4 — which turned out to cost one line once
   the predicate existed, so it was not worth deferring. Turn rotation needed
   **no change at all**: seats alternate, so `(i + 1) % players.length` was
   already the doubles order.

   Two things learned in the doing, both recorded above: `rules` is a string
   key and could not hold the freeze (7a), and partners is refused on non-x01
   legs for now rather than silently mis-scoring a Cricket leg with a
   team-sized leg tally.
3. ~~**Recorder: four seats, `team` column, migration.**~~ **DONE.** Migration
   `006_teams.sql` adds `match_players.team` plus `winner_team` on both
   `matches` and `legs`; the save gate is gone and partners matches are
   recorded like any other.

   The `=== seat` comparisons became four functions in `statsengine.js` —
   `isTeamMatch`, `matchWonBy`, `legWonBy` and a private `teamOfSeat` — and
   every previous copy of the question now calls one. `server/matches.js`
   answers its history-row "did I win?" through `matchWonBy` too rather than
   keeping a second copy of the rule, which is how a history row and a win
   count end up disagreeing about the same match.

   `winner_seat` keeps its exact meaning and is **NULL in a partners game**,
   which is also what represents a leg with no finisher at all — the frozen
   concession of 7a.
4. ~~**Tell the player they are frozen.**~~ **DONE** as part of step 2 — it is
   one line in the turn label once the predicate exists, and deferring it would
   have meant shipping the worst outcome in the game with no warning attached.
5. ~~**The shared-total model, once**~~ **DONE**, delivering freeze-OFF x01
   doubles **and** Cricket, Count Up and Bermuda doubles together — every game
   mode plays in partners now, and a medley may mix the two models freely
   because which one applies is decided per LEG, not per match.

   `isSharedTotal()` is that decision and `recorderSeat()` is the only bridge
   between the two index spaces. `scoring.js`, `cricket.js` and `bermuda.js`
   were not touched at all: with a shared total they are handed a players array
   of length two, exactly as in singles, which is the purity rule paying out
   for the last time in this feature.

   **Already true ONLINE, for free.** `online.me` / `online.opp` have always
   held one score per *side*, which is the shared-total shape exactly — so
   online local doubles arrived at the shared-total model without anyone
   building it, and Cricket doubles online works for the same reason. What is
   still outstanding is the shared-total model in `game.js`, where scores are
   per person.

   **The general lesson, worth applying to the next controller:** give each
   controller the variant that matches the model it already has. `game.js` was
   already four scores for four players, so freeze-ON x01 was nearly free
   there; `online.js` was already one score per side, so shared-total doubles
   was nearly free here. Picking one variant to build "first" across the whole
   app would have meant fighting one of the two controllers for no reason.
6. ~~**Stats: decide the singles-averages rule, bump `ENGINE_VERSION`.**~~
   **DONE** alongside step 3, because the two touch the same functions.
   `ENGINE_VERSION` is 9. Doubles darts feed the averages; doubles wins stay
   out of the singles win count, win percentage, streaks and the win
   achievements. Two details worth knowing: the win-percentage **denominator**
   moved too (`decided`, the matches winnable alone — otherwise playing
   doubles would quietly lower your win rate), and a doubles match is
   **skipped** by the streak walk rather than treated as a loss, so it cannot
   break a run.
7. ~~**`online.js`:** seat/thrower split, then the roster in `hello`/
   `match_config`.~~ **DONE**, and far smaller than this list expected — see
   the note below on why.
8. ~~**Turn rotation online, and the undo window widening**~~ **DONE / NOT
   NEEDED.** Rotation is one line beside the existing side flip. The undo
   window needed **no widening at all**: the two stacks are per SIDE, and in
   local doubles a side *is* a team, so "the window closes when the other side
   throws" was already "when anyone on the other team throws".
9. ~~**Lobby: pair formation. This is the biggest single piece and is easy to
   under-estimate.**~~ **MOSTLY NOT A THING — see 8a.** The lobby now shows a
   pair as a pair, which is what local doubles actually needed. Forming a pair
   with a REMOTE partner is a remote-doubles feature and is blocked on remote
   doubles existing.

### 8b. A partner can sign in, so their darts reach their own account

**Built.** Until this, a partner was only a NAME: their visits were recorded in
the board owner's match document with `isSelf` false, uploaded to the owner's
account, and their own statistics never saw a dart they threw. For a feature
whose whole justification is per-person figures (3a), that was the gap.

`POST /api/auth/partner` signs the second person in, and three things about it
are deliberate:

- **No `Set-Cookie`.** The session cookie is HttpOnly and there is one per
  browser, so issuing one would sign the OWNER of the board out in order to
  sign their guest in. The token comes back in the body and the page holds it
  in memory.
- **Hours, not thirty days** (`PARTNER_SESSION_HOURS`). Nobody means to stay
  signed in on somebody else's board. A reload, a tab close, or the owner
  signing out all end it too, because it is never written to `localStorage` —
  persisting a guest's credential on hardware they do not own is the one thing
  this must not do.
- **One capability, not a session.** Only `POST /api/matches` accepts the
  bearer token. A partner can have their darts counted and can do nothing else
  — not read statistics, not change a password, not touch the lobby. Widening
  that is a decision to make on purpose rather than by adding a caller.

It is throttled on the same counter as login, because it is a second
password-checking surface on the same accounts and leaving it open would make
the throttle on the first one decorative. Signing in as the account already
signed in here is refused: it would record both seats against one person.

**The upload is the shape that already existed.** The same match document is
sent twice with `isSelf` on a different seat — exactly what an online match has
always done, where both players record their own copy and neither is the
authority. `client_uuid` is scoped per user, so the two rows are legitimately
their own rather than a duplicate.

One accepted limitation: the partner's upload is **best-effort and not
queued**. The offline queue lives in `localStorage`, and queuing this would
mean writing their credential to disk to retry it later. A failed partner
upload is lost, which is a better trade than persisting somebody else's session
on your board.

### 8a. Pair formation was the wrong shape of problem

This document called lobby pair formation "the biggest single piece" of team
play, and estimated it as comparable to the rooms work. That was wrong, and the
reason is worth keeping because it is the same mistake in miniature that
section 0 renames away from.

**In local doubles your partner is standing next to you.** They need no
account, no connection, no presence entry and nothing for the lobby to link to
— their name is a string you type. "Invite a partner, form a pair, then
challenge another pair" describes finding a partner who is somewhere else,
which is REMOTE doubles, and it cannot be built before remote doubles exists
because there would be nothing for the formed pair to do.

Doubles through the lobby already worked before any of this: a challenge mints
an ordinary invite code, and the rosters ride in `hello`/`match_config` exactly
as they do on the invite-code path.

What was genuinely missing was **visibility** — pairs need to be able to find
pairs, because challenging someone who is playing alone gets you a singles
match rather than the game you were looking for. So presence carries a
`partner` name, the lobby row reads "Ann & Cat" with a doubles tag, and that is
the whole feature.

One bug found on the way in, of a shape this lobby has now had twice: the
`status` message defaulted an ABSENT status to "lobby", so a client updating
only its partner would have knocked the player out of "Open to challenges", or
out of the room they were standing in, as a side effect of typing a name. An
absent status now keeps the current one; only an unrecognised one falls back.
