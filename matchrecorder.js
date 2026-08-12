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
// Three, everywhere, and not a rule any game gets to vary: a visit is three
// darts unless it finished the leg. It is here rather than inline because
// endTurn and the quick-total path both stand on it for the same reason - each
// knows how many darts were THROWN without having a segment for each of them.
const DARTS_PER_VISIT = 3;

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
    // The winning TEAM in a partners match, null in singles. Kept beside
    // winnerSeat rather than replacing it: a singles match genuinely has a
    // winning seat, and collapsing both into one field would mean every reader
    // having to know which kind of index it was looking at.
    winnerTeam: null,
    drawn: false,
    players: (players ?? []).map((p, seat) => ({
      seat,
      displayName: p.displayName,
      isSelf: Boolean(p.isSelf),
      // Which team this seat plays for, or null in singles. Carried even
      // though nothing derives statistics from it yet, because the alternative
      // - inferring partners from seat parity when the time comes - is a rule
      // that would then live in the recorder, the stats engine, the
      // leaderboards and both controllers at once. One field, written by
      // whoever knows the answer. See docs/team-play.md.
      team: Number.isInteger(p.team) ? p.team : null,
      legsWon: 0,
      setsWon: 0, // see the schema: sets don't exist in this app yet
    })),
    legs: [],
  };

  // The leg currently being played, and the visit currently being thrown.
  let leg = null;
  let turn = null;
  let turnCounter = 0;
  // Set when a QUICK TOTAL has already finalised the visit, cleared the moment
  // a new one opens. endTurn needs it to tell two states apart that look
  // identical from here - "no open turn because all three darts missed", which
  // must be recorded, and "no open turn because the visit is already closed",
  // which must not be recorded again. See endTurn.
  let closedByQuick = false;

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
    closedByQuick = false;
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
    if (turn.throws.length === 0 && !turn.darts) {
      // A visit with no darts in it isn't a visit. This happens when the
      // board's physical end-turn button is pressed before anything registers.
      //
      // `!turn.darts` is what distinguishes that from a visit where all three
      // darts MISSED, which registers nothing either and is a real visit that
      // has to be counted. endTurn sets darts before calling this, so the two
      // cases are told apart by whether anyone claimed the visit happened
      // rather than by guessing from an empty throw list.
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

  // Marks in one visit, for the two games whose live figure is an MPR.
  //
  // The RULE is identical - a dart is worth its multiplier on a target it
  // actually found, so a visit runs 0 to 9 either way - but the two games record
  // the answer differently, and neither should be made to record it twice.
  // Cricket resolves marks in its rules (a dart on a dead number is worth
  // nothing) and stores the count. Bermuda only knows whether the dart hit the
  // round's target, so the multiplier on the throw IS the mark count - which is
  // also why "Any Double" and "Any Triple" rounds come out at 2 and 3 a dart
  // without a special case.
  function turnMarks(t) {
    return (t.throws ?? []).reduce((sum, th) => {
      if (th.extra?.marks !== undefined) return sum + (th.extra.marks || 0);
      if (th.extra?.hit) return sum + (th.multiplier || 1);
      return sum;
    }, 0);
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
    // NULL AND "NO DARTS YET" ARE DIFFERENT ANSWERS, and the difference is the
    // label. Returning null for both made the scoreboard fall back to a
    // hardcoded caption, so a Cricket player who had not thrown yet was shown
    // "PPD -" - the wrong number's name, on the one screen where the name is
    // all there is to read. Which figure a game shows is knowledge this module
    // already has and the renderer should never acquire a second copy of, so an
    // empty average comes back LABELLED, with a null value.
    //
    // null now means only "there is no leg" - the caller hides the whole thing
    // rather than captioning an absence.
    //
    // EVERY GAME GETS ONE, and they fall into two kinds rather than four.
    // A game is either counting MARKS on a target - Cricket and Bermuda, where
    // the question is how much of a round found what it was aimed at - or
    // counting POINTS off darts, which is x01 and Count Up alike whichever
    // direction the total moves in. Deciding by that rather than by game name
    // is what keeps a fifth game from needing a third branch.
    liveStats(seat) {
      if (!leg) return null;
      // The open visit counts too - an average that only moved when a turn
      // ended would sit still for the three darts you are actually throwing.
      const all = turn ? [...leg.turns, turn] : leg.turns;
      const mine = all.filter((t) => t.seat === seat);

      if (leg.game === "cricket" || leg.game === "bermuda") {
        if (!mine.length) return { kind: "mpr", label: "MPR", value: null, digits: 2 };
        // A round IS a visit here, matching cricketstats.js.
        //
        // MPR alone, with no second figure. Marks are the whole story of one of
        // these visits - how fast you are closing, or how much of the round
        // found the target - and the points are already on the pad or the
        // scoreboard, where they mean something. A second average beside it
        // would be a number nobody was looking for.
        let marks = 0;
        for (const t of mine) marks += turnMarks(t);
        return { kind: "mpr", label: "MPR", value: marks / mine.length, digits: 2 };
      }

      const blank = { kind: "ppd", label: "PPD", value: null, digits: 2, secondaryLabel: "3DA" };
      if (!mine.length) return blank;

      let darts = 0;
      let scored = 0;
      for (const t of mine) {
        // t.darts, NOT t.throws.length. A quick total records the whole visit
        // as a single throw but sets darts to 3, because three darts is what
        // the person actually threw - which is the entire reason that field
        // exists separately. Counting throws made a 180 read as 180 points off
        // ONE dart: a PPD of 180 against a ceiling of 60.
        darts += t.darts || t.throws.length;
        // A bust visit scores nothing however good its darts looked on the way
        // there - the same rule closeTurn applies when it writes the visit.
        // Count Up cannot bust, so this costs it nothing.
        scored += t.bust ? 0 : (t.scored || 0);
      }
      if (!darts) return blank;
      return {
        kind: "ppd", label: "PPD", value: scored / darts, digits: 2,
        // The three-dart average, which is the number darts players actually
        // talk in - "a 60 average" means 60 a visit, not 60 a dart.
        secondary: (scored / darts) * 3,
        secondaryLabel: "3DA",
      };
    },

    startLeg({ legIndex, game, x01Start, rules, bull, rounds }) {
      closeTurn();
      cricketTally = new Map();
      turnCounter = 0;
      // Per-LEG state, and this flag is per-visit state that can outlive its
      // leg. Checking out with a quick total goes quickTotal -> finishLeg ->
      // endLeg, which never passes through the endTurn that would clear it, so
      // it was still set when the next leg began. The first visit of that leg
      // in which nobody entered a dart - all three missed, "End turn" pressed -
      // then looked exactly like the double-count endTurn guards against, and
      // was silently dropped: the visit vanished from the MPR and average
      // denominators, which is the failure the seat argument to endTurn exists
      // to prevent. Cleared here because endTurn cannot read it without a leg.
      closedByQuick = false;
      leg = {
        legIndex,
        game,
        x01Start: x01Start ?? null,
        rules: rules ?? null,
        bull: bull ?? null,
        rounds: rounds ?? null,
        winnerSeat: null,
        winnerTeam: null,
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
      closedByQuick = true;
    },

    // A VISIT IS THREE DARTS. Ending a turn asserts the visit is over, and the
    // darts that were never entered were thrown - they simply went nowhere.
    // Recording only the ones that registered was silently flattering: a visit
    // of 60 and two misses, entered as one dart, read as a PPD of 60 against a
    // ceiling of 60 rather than the 20 it was, and every average that counts
    // darts inherited the error. It is also what makes deleting Cricket's Miss
    // button safe - the misses are accounted for by the visit ending, which is
    // the thing the player was going to do anyway.
    //
    // `darts` is the field that carries this, not a fourth entry in `throws`.
    // A dart nobody recorded has no segment, and inventing one would put a
    // phantom miss in the heatmap and in every per-dart statistic. The split
    // between "darts thrown" and "darts recorded" already exists for quick
    // totals, which is exactly the same problem arriving from the other side.
    //
    // seat is passed because an all-missed visit registers nothing at all,
    // leaving no open turn to read it from - and that visit still has to be
    // counted, or a player who misses everything has the round quietly dropped
    // from the denominator and their MPR goes UP for missing.
    endTurn(seat) {
      if (!leg) return;
      // A quick total has already recorded the whole visit and closed it, so
      // there is nothing left to end. Without this the controllers' ordinary
      // "the visit is over" call landed on an empty recorder and the
      // all-missed rule below invented a SECOND visit for the same three
      // darts - scoring zero, counting three darts, and halving every average
      // of anyone who scores by whole-turn totals. It read as a plausible
      // record of someone who missed every other visit.
      if (!turn && closedByQuick) {
        closedByQuick = false;
        return;
      }
      if (!turn && seat !== null && seat !== undefined) openTurn(seat, null, "dart");
      if (turn && !turn.isCheckout) turn.darts = Math.max(turn.darts || 0, DARTS_PER_VISIT);
      closeTurn();
    },

    // The dart that wins a leg does not go through endTurn - the controllers
    // finish the leg then and there - so this closes whatever is open and
    // marks the winning visit as the checkout.
    //
    // `winnerSeat` is the person who threw the finishing dart, and it is NOT
    // the same question as who won the leg once teams exist:
    //
    //   - In a partners leg the leg belongs to a TEAM, so `winnerTeam` is what
    //     decides legsWon, and both partners get it.
    //   - A leg can be won with no finishing dart at all. Reaching zero while
    //     frozen hands the leg to the opposition (see scoring.js), so
    //     winnerSeat is null while winnerTeam is set - and the player who did
    //     reach zero must not be credited with a checkout for it, which the
    //     seat comparison below already handles because the two differ.
    endLeg(winnerSeat, { winnerTeam = null } = {}) {
      if (!leg) return;
      if (turn && winnerSeat !== null && winnerSeat !== undefined && turn.seat === winnerSeat) {
        turn.isCheckout = true;
      }
      closeTurn();
      leg.winnerSeat = winnerSeat ?? null;
      leg.winnerTeam = Number.isInteger(winnerTeam) ? winnerTeam : null;

      // Credit the side, whichever kind of side this match has. Singles is the
      // one-player case of the same statement rather than a separate branch.
      const winners = leg.winnerTeam === null
        ? (Number.isInteger(leg.winnerSeat) ? [doc.players[leg.winnerSeat]] : [])
        : doc.players.filter((p) => p.team === leg.winnerTeam);
      for (const player of winners) {
        if (player) player.legsWon += 1;
      }
      leg = null;
    },

    // winnerTeam is the match result in a partners game, where winnerSeat has
    // nothing to say - a match is won by a pair, and naming one of them would
    // be the same silent half-credit the leg tally used to give.
    endMatch({ winnerSeat = null, drawn = false, winnerTeam = null } = {}) {
      closeTurn();
      doc.winnerSeat = winnerSeat ?? null;
      doc.winnerTeam = Number.isInteger(winnerTeam) ? winnerTeam : null;
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
        closedByQuick,
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
      closedByQuick = Boolean(snap.closedByQuick);
      cricketTally = new Map(snap.cricket.map(([seat, v]) => [seat, { ...v }]));
    },
  };
}
