# Team play online, with cameras — a design, not an implementation

Status: **proposal, nothing built.** Written to be argued with. Every claim about
the current code carries a file reference so you can check it rather than trust
it.

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
seat, so per-player statistics keep working unchanged; the thing that becomes
ambiguous is *legs won*, which belongs to the team.

**Schema** — `match_players` needs a `team` column. I'd argue hard against the
tempting alternative of "seats 0 and 2 are one team, 1 and 3 the other": that is
a convention that would have to be known by the recorder, the stats engine, the
leaderboards and both controllers, and `CLAUDE.md` already records what happens
to conventions duplicated across files (the ring→segment-ID slot mapping, which
lives in four places and is called out as a hazard). One nullable integer column
is cheaper than five copies of a rule. `team` stays `NULL` for singles, which is
also the honest representation.

**Statistics** — this needs a decision from you, see section 7. My suggestion:
the *darts* count toward your averages, because they are real darts you threw at
a real board; the *win* does not count toward singles leaderboards. That is
exactly the rule already applied to matches against a computer opponent
(`ENGINE_VERSION` 7), so there is precedent and a place to put it.

**Cameras — nothing to do.** Two peers, and `webrtc.js` already reserves **two**
video m-lines per connection for the second-camera feature. A team gets one
camera on each player, or one on the board and one on whoever is throwing, with
no renegotiation and no new code. This is the single strongest argument for
Shape A: the camera story is already built.

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

Two or three days of careful work, most of it in `online.js` and the recorder,
plus one migration. No new failure modes. Nothing in the networking layer moves.

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

**Build Shape A. Do not build Shape B until someone asks for it by name.**

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
different houses, Shape A does not give you that at all, and building it first is
a detour. Which is why the first question in the next section matters more than
the rest put together.

---

## 7. Decisions I need from you

1. **Which shape do you actually want?** Two at each end, or four separate
   houses? Everything above hinges on this.
2. **Do doubles darts count toward your singles averages?** My suggestion: yes
   for darts, no for wins — the same split already applied to practice matches
   against a computer.
3. **Cricket doubles: shared marks?** Standard says yes, the team closes numbers
   together. Confirm.
4. **x01 doubles: may either partner check out?** Standard says yes.
5. **In Shape A, what do the two cameras point at?** One per player, or one on
   the board and one on the thrower? The connection supports either today.
6. **What happens when one player of four drops?** Forfeit the team, pause, or
   let their partner throw both? This has no standard answer and it will happen.

---

## 8. If you say go on Shape A, the order I'd do it in

1. Seat/thrower split in `online.js`, singles still working throughout — a team
   of one is a singles player, so nothing needs a special case.
2. Roster in `hello`/`match_config`.
3. Recorder: four seats, `team` column, migration.
4. Turn rotation and the undo window widening to "anyone on the other team".
5. Stats: decide the doubles rule, bump `ENGINE_VERSION`.
6. Lobby: pair formation. **This is the biggest single piece and is easy to
   under-estimate** — until it exists, doubles is invite-code only, which is a
   perfectly good first release.
