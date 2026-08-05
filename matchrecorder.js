// matchrecorder.js - turns a match being played into a record of every dart.
//
// Shared by game.js (local) and online.js, for exactly the reason dartboard.js
// and quickentry.js are shared: two copies of this would drift, and the moment
// they did, a player's statistics would depend on which mode they happened to
// play in.
//
// WHY EVERY DART. It would be far less code to store "player X averaged 62.4
// in a 501 win". But every statistic that gets asked for later - first-9,
// checkout percentage, MPR, doubles hit versus attempted, a scoring heatmap,
// whatever gets asked for next year - is derivable from the darts and is not
// derivable from the summary. Recording the darts means new statistics are a
// change to the stats engine, applied retroactively to matches already played.
// Recording summaries means every new statistic starts from zero.
//
// This module is pure in the sense that matters: it holds no DOM, no network,
// no clock beyond the timestamps it is asked to stamp, and it never reaches
// back into the game. It is fed events and hands back a JSON document.
//
// THE DOCUMENT is deliberately shaped like the database it ends up in (see
// server/migrations/001_init.sql) so that uploading it is a walk of the tree
// rather than a translation:
//
//   match -> players[]
//         -> legs[] -> turns[] -> throws[]

// A match is identified by a UUID generated here, on the client, rather than by
// the server. That is what makes uploading idempotent: the offline queue can
// retry the same match any number of times and the server recognises it.
//
// crypto.randomUUID needs a secure context, which this app always has in
// practice (Web Bluetooth requires one too) - but the fallback keeps recording
// working on a plain-http LAN address, where the app otherwise still runs.
function newUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createRecorder({ mode, format, players }) {
  const startedAt = Date.now();

  const doc = {
    clientUuid: newUuid(),
    mode,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: null,
    durationMs: 0,
    // The leg list exactly as configured, so a match can be described the way
    // it was set up even after the format presets change.
    format: JSON.parse(JSON.stringify(format ?? [])),
    winnerSeat: null,
    drawn: false,
    players: (players ?? []).map((p, seat) => ({
      seat,
      displayName: p.displayName,
      isSelf: Boolean(p.isSelf),
      legsWon: 0,
      setsWon: 0, // see the schema: sets don't exist in this app yet
    })),
    legs: [],
  };

  // The leg currently being played, and the visit currently being thrown.
  let leg = null;
  let turn = null;
  let turnCounter = 0;

  // Cricket's running MPR needs marks and completed rounds per seat, which is
  // per-leg state rather than something a single visit knows. Kept here so the
  // number stored on each turn is the one that was true at the time.
  let cricketTally = new Map();

  function tallyFor(seat) {
    if (!cricketTally.has(seat)) cricketTally.set(seat, { marks: 0, rounds: 0 });
    return cricketTally.get(seat);
  }

  // Opened lazily by the first dart of a visit. Nothing calls "startTurn":
  // the controllers don't have such a moment - a turn begins because someone
  // threw - and inventing one would mean two places to keep in step.
  function openTurn(seat, remainingBefore, entry) {
    if (turn && turn.seat === seat) return turn;
    turn = {
      turnIndex: turnCounter++,
      seat,
      darts: 0,
      scored: 0,
      remainingBefore: remainingBefore ?? null,
      remainingAfter: remainingBefore ?? null,
      bust: false,
      isCheckout: false,
      entry,
      game: null,
      throws: [],
    };
    return turn;
  }

  function closeTurn() {
    if (!turn) return;
    if (turn.throws.length === 0) {
      // A visit with no darts in it isn't a visit. This happens when the
      // board's physical end-turn button is pressed before anything registers.
      turn = null;
      return;
    }
    // A bust visit scores nothing, whatever its darts were worth on the way
    // there. Recording the darts' face value as the visit's score would inflate
    // every average that counts it - the darts are still stored individually,
    // flagged as bust, so nothing is lost by zeroing the total here.
    if (turn.bust) turn.scored = 0;
    if (leg?.game === "cricket") turn.game = cricketTurnPayload(turn);
    if (leg?.game === "bermuda") turn.game = bermudaTurnPayload(turn);
    leg?.turns.push(turn);
    turn = null;
  }

  // The per-visit Cricket payload: which targets the three darts hit, the marks
  // and points the visit earned, and the MPR the player was on afterwards.
  //
  // Every number here is recomputable from the throws plus cricket.js, so this
  // is a convenience for reading a match back, never the only copy. It is also
  // the shape a future game module would follow - see turns.game_json.
  function cricketTurnPayload(t) {
    const tally = tallyFor(t.seat);
    const marks = t.throws.reduce((sum, th) => sum + (th.extra?.marks || 0), 0);
    const points = t.throws.reduce((sum, th) => sum + (th.extra?.points || 0), 0);

    tally.marks += marks;
    tally.rounds += 1;

    return {
      targets: t.throws.map((th) => th.extra?.target ?? null),
      // The full per-dart detail, kept here rather than in a column of its own.
      // It is what lets a match read back from the database with exactly the
      // information it had when it was played - "points prevented" needs to
      // know how many of a dart's marks actually counted, and that cannot be
      // recovered from the visit total afterwards.
      darts: t.throws.map((th) => th.extra ?? null),
      marks,
      points,
      // Rounded to two places at write time because it is a display value; the
      // exact figure is always recomputable from the marks and rounds.
      runningMpr: Number((tally.marks / Math.max(1, tally.rounds)).toFixed(2)),
    };
  }

  // The per-visit Bermuda payload. Without one, a Bermuda turn writes no
  // game_json and the per-dart detail is dropped the moment the match is read
  // back out of the database - the throws table has no column for it, by
  // design, because game-specific detail is supposed to ride here.
  //
  // `missed` is derived rather than reported: a visit missed if not one of its
  // darts found the target, which is exactly what halves the score. The
  // recorder can see that without being told, and deriving it keeps the
  // controllers from having to remember to say so.
  function bermudaTurnPayload(t) {
    const darts = t.throws.map((th) => th.extra ?? null);
    return {
      // Every dart of a visit is thrown at the same target, so it is recorded
      // once rather than three times.
      target: darts.find((d) => d?.target)?.target ?? null,
      darts,
      points: t.throws.reduce((sum, th) => sum + (th.extra?.points || 0), 0),
      missed: !darts.some((d) => d?.hit),
    };
  }

  return {
    get clientUuid() {
      return doc.clientUuid;
    },

    // The average for the leg IN PROGRESS, for a scoreboard to show while it is
    // still being played.
    //
    // It lives here because the recorder is the only thing that already sees
    // every dart from BOTH controllers - game.js and online.js feed it the
    // same way - so a live figure computed here cannot drift between local and
    // online play, and cannot drift from what is saved at the end either.
    // Counting darts a second time inside each controller is exactly the kind
    // of duplicate bookkeeping this module exists to avoid.
    //
    // The 100% figure, deliberately: every visit, including the ones spent
    // setting up a finish. That is what an arcade machine shows mid-match and
    // what a player expects to see moving after every visit. The 80% scoring
    // average is a post-match statistic and needs the whole leg to mean
    // anything (see the note on averages in statsengine.js).
    liveStats(seat) {
      if (!leg) return null;
      // The open visit counts too - an average that only moved when a turn
      // ended would sit still for the three darts you are actually throwing.
      const all = turn ? [...leg.turns, turn] : leg.turns;
      const mine = all.filter((t) => t.seat === seat);
      if (!mine.length) return null;

      if (leg.game === "cricket") {
        // A round IS a visit here, matching cricketstats.js.
        let marks = 0;
        let points = 0;
        for (const t of mine) {
          marks += t.throws.reduce((sum, th) => sum + (th.extra?.marks || 0), 0);
          points += t.throws.reduce((sum, th) => sum + (th.extra?.points || 0), 0);
        }
        return {
          kind: "mpr", label: "MPR", value: marks / mine.length, digits: 2,
          // The machines show points alongside the marks, and the two say
          // different things: marks are how fast you are closing, points are
          // what you did with the numbers you already own.
          secondary: points / mine.length,
        };
      }

      // Bermuda and Count Up count upwards and have no meaningful per-dart
      // average to offer mid-leg, so they get nothing rather than a number
      // that looks like one.
      if (leg.game !== "x01") return null;

      let darts = 0;
      let scored = 0;
      for (const t of mine) {
        darts += t.throws.length;
        // A bust visit scores nothing however good its darts looked on the way
        // there - the same rule closeTurn applies when it writes the visit.
        scored += t.bust ? 0 : (t.scored || 0);
      }
      if (!darts) return null;
      return {
        kind: "ppd", label: "PPD", value: scored / darts, digits: 2,
        // The three-dart average, which is the number darts players actually
        // talk in - "a 60 average" means 60 a visit, not 60 a dart.
        secondary: (scored / darts) * 3,
      };
    },

    startLeg({ legIndex, game, x01Start, rules, bull, rounds }) {
      closeTurn();
      cricketTally = new Map();
      turnCounter = 0;
      leg = {
        legIndex,
        game,
        x01Start: x01Start ?? null,
        rules: rules ?? null,
        bull: bull ?? null,
        rounds: rounds ?? null,
        winnerSeat: null,
        turns: [],
      };
      doc.legs.push(leg);
    },

    // One dart. `facts` is what the game rules concluded about it, which the
    // controller has already computed - this module deliberately does not
    // re-run any rules, because a second opinion about a dart is precisely the
    // drift this design exists to prevent.
    dart(seat, segment, facts = {}) {
      if (!leg) return;
      const t = openTurn(seat, facts.remainingBefore, "dart");

      t.throws.push({
        dartIndex: t.throws.length,
        segmentId: segment?.id ?? null,
        section: String(segment?.section ?? "Other"),
        ring: String(segment?.ring ?? "other"),
        // SegmentType doubles as the multiplier (1/2/3) - see granboard.js.
        // Anything else (a miss, the reset button) is recorded as 1 so that
        // "multiplier" always means what it says.
        multiplier: segment?.type >= 1 && segment?.type <= 3 ? segment.type : 1,
        value: Number(segment?.value ?? 0),
        remainingBefore: facts.remainingBefore ?? null,
        remainingAfter: facts.remainingAfter ?? null,
        bust: Boolean(facts.bust),
        ignored: Boolean(facts.ignored),
        atMs: Date.now() - startedAt,
        // Per-game detail for this dart (Cricket: target/marks/points). Kept
        // out of the columns because it is game-specific by nature.
        extra: facts.extra ?? null,
      });

      t.darts = t.throws.length;
      t.scored += Number(facts.scored ?? 0);
      t.remainingAfter = facts.remainingAfter ?? t.remainingAfter;
      if (facts.bust) t.bust = true;
    },

    // A whole-turn total typed in by someone who watched the darts land. It is
    // recorded as one throw standing for the visit, and flagged as such: it
    // says nothing about which segments were hit, so per-dart statistics have
    // to exclude it rather than treat it as a single enormous dart.
    quickTotal(seat, { total, remainingBefore, remainingAfter, bust, isCheckout }) {
      if (!leg) return;
      closeTurn();
      const t = openTurn(seat, remainingBefore, "quick");

      t.throws.push({
        dartIndex: 0,
        segmentId: null,
        section: "Other",
        ring: "quick",
        multiplier: 1,
        value: Number(total ?? 0),
        remainingBefore: remainingBefore ?? null,
        remainingAfter: remainingAfter ?? null,
        bust: Boolean(bust),
        ignored: false,
        atMs: Date.now() - startedAt,
        extra: null,
      });

      // Three darts is the convention for a turn total - it is what the person
      // entering it threw, even though only the sum was recorded. Anything else
      // would quietly deflate every three-dart average that counts it.
      t.darts = 3;
      t.scored = bust ? 0 : Number(total ?? 0);
      t.remainingAfter = remainingAfter ?? null;
      t.bust = Boolean(bust);
      t.isCheckout = Boolean(isCheckout);
      closeTurn();
    },

    endTurn() {
      closeTurn();
    },

    // The dart that wins a leg does not go through endTurn - the controllers
    // finish the leg then and there - so this closes whatever is open and
    // marks the winning visit as the checkout.
    endLeg(winnerSeat) {
      if (!leg) return;
      if (turn && winnerSeat !== null && winnerSeat !== undefined && turn.seat === winnerSeat) {
        turn.isCheckout = true;
      }
      closeTurn();
      leg.winnerSeat = winnerSeat ?? null;
      if (winnerSeat !== null && winnerSeat !== undefined && doc.players[winnerSeat]) {
        doc.players[winnerSeat].legsWon += 1;
      }
      leg = null;
    },

    endMatch({ winnerSeat = null, drawn = false } = {}) {
      closeTurn();
      doc.winnerSeat = winnerSeat ?? null;
      doc.drawn = Boolean(drawn);
      doc.endedAt = new Date().toISOString();
      doc.durationMs = Date.now() - startedAt;
      return this.document();
    },

    // Renaming after the fact, which online play needs: the opponent's name
    // arrives in their `hello` message, which can land after the first darts.
    setPlayerName(seat, displayName) {
      if (doc.players[seat] && displayName) doc.players[seat].displayName = displayName;
    },

    document() {
      return JSON.parse(JSON.stringify(doc));
    },

    // ---------------------------------------------------------------------
    // Undo
    // ---------------------------------------------------------------------
    // The recorder only ever appends, so undo is a truncation: remember how
    // many legs, turns and throws there were, and cut back to it. That is
    // O(1) to capture, unlike deep-copying a growing match on every dart.
    //
    // It mirrors the controllers' existing undo exactly - game.js pushes one
    // snapshot per recorded action - so the two cannot get out of step.
    capture() {
      return {
        legCount: doc.legs.length,
        turnCount: leg ? leg.turns.length : 0,
        turnCounter,
        turn: turn ? { ...turn, throws: turn.throws.slice() } : null,
        cricket: [...cricketTally.entries()].map(([seat, v]) => [seat, { ...v }]),
      };
    },

    restore(snap) {
      if (!snap) return;
      doc.legs.length = Math.min(doc.legs.length, snap.legCount);
      leg = doc.legs[doc.legs.length - 1] ?? null;
      if (leg) leg.turns.length = Math.min(leg.turns.length, snap.turnCount);
      turnCounter = snap.turnCounter;
      turn = snap.turn ? { ...snap.turn, throws: snap.turn.throws.slice() } : null;
      cricketTally = new Map(snap.cricket.map(([seat, v]) => [seat, { ...v }]));
    },
  };
}
