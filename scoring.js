// scoring.js - pure x01 rules (301 / 501 / 701 and their in/out variants),
// shared by local pass-and-play and online play.
//
// Kept dependency-free and side-effect-free so both game modes compute
// identical results from identical inputs (this is what keeps two remote
// browsers in sync without needing a rollback/replay system - see README).
//
// x01 is a family rather than one game. Three things vary, and the machines
// let you pick each independently - so it is a 3x3 matrix, not a short list of
// named presets:
//
//   Starting score - 301, 501, 701 and up. Nothing else changes with it.
//
//   The IN rule - what you must hit before any of your darts count at all.
//     straight ("Open In")  - scoring from the first dart.
//     double   ("Double In") - nothing counts until you land a double.
//     master   ("Masters In") - a double, a triple OR the bullseye opens you.
//   Darts thrown before opening are still darts; they just score zero.
//
//   The OUT rule - what you're allowed to finish on:
//     straight ("Open Out")   - anything, including a single. Leaving 1 is fine.
//     double   ("Double Out") - the standard. Leaving 1 busts, because 1 can't
//                be made with a double.
//     master   ("Masters Out") - a double, a triple OR the bullseye. Leaving 1
//                busts for the same reason.
//
// NOTE on the bullseye: Arachnid's rules name it explicitly in both Masters
// options. That matters here because the OUTER bull is a single in this
// codebase's segment model, so testing the type alone would wrongly reject a
// legitimate 25 finish. Both master tests check the section instead.
//
// The traditional names map onto the matrix:
//   SISO        - open in, open out
//   DIDO        - double in, double out
//   Master out  - open in, master out

import { SegmentType } from "./granboard.js";

// The starting scores Arachnid machines offer. 901 is there because Count Down
// uses it, and the higher two exist on the Galaxy 3.
export const X01_SCORES = [301, 501, 701, 901, 1101, 1501];

// The full in/out matrix, as Arachnid machines offer it. Three ways in times
// three ways out is nine combinations, and a machine lets you pick any of them
// - "501 Open In / Master Out" is a real selection, not a curiosity.
//
// The four original keys are kept exactly as they were so that every match
// already recorded still reads correctly: `double` is open-in/double-out, and
// so on. The rest are new.
//
// In and out are the only two values anything downstream deals with, so adding
// combinations costs nothing beyond this table.
export const X01_RULES = {
  // The originals, unchanged.
  double: { label: "Open in / Double out", in: "straight", out: "double" },
  siso: { label: "Open in / Open out (SISO)", in: "straight", out: "straight" },
  dido: { label: "Double in / Double out (DIDO)", in: "double", out: "double" },
  master: { label: "Open in / Master out", in: "straight", out: "master" },

  // The rest of the matrix.
  "open-open": { label: "Open in / Open out", in: "straight", out: "straight" },
  "open-master": { label: "Open in / Master out", in: "straight", out: "master" },
  "double-open": { label: "Double in / Open out", in: "double", out: "straight" },
  "double-master": { label: "Double in / Master out", in: "double", out: "master" },
  "master-open": { label: "Master in / Open out", in: "master", out: "straight" },
  "master-double": { label: "Master in / Double out", in: "master", out: "double" },
  "master-master": { label: "Master in / Master out", in: "master", out: "master" },
};

export function rulesFor(key) {
  return X01_RULES[key] || X01_RULES.double;
}

export function rulesLabel(key) {
  return rulesFor(key).label;
}

// Does this dart satisfy the "in" requirement - i.e. is it allowed to open a
// player's scoring?
export function segmentOpens(segment, inRule) {
  if (inRule === "double") return segment.type === SegmentType.Double;
  // Masters in: "Doubles, Triples or the bullseye" - the bull counts even
  // though the outer bull is a single, which is why this tests the section
  // rather than only the type.
  if (inRule === "master") {
    return segment.type === SegmentType.Double
      || segment.type === SegmentType.Triple
      || segment.section === "BULL";
  }
  return true;
}

// Is this dart allowed to be the finishing one?
export function segmentCanFinish(segment, outRule) {
  if (outRule === "straight") return true;
  // Masters out: "either a Double, Triple or Bullseye". The bull is named
  // explicitly in the rules, and the OUTER bull is a single in this codebase's
  // model, so it has to be tested by section or a legitimate 25 finish would
  // be rejected.
  if (outRule === "master") {
    return segment.type === SegmentType.Double
      || segment.type === SegmentType.Triple
      || segment.section === "BULL";
  }
  return segment.type === SegmentType.Double;
}

// The highest score a leg can be checked out from in a single visit, which is
// NOT a constant - it depends on the out rule, and getting that wrong silently
// mis-scores every checkout statistic:
//
//   double out - the last dart must be a double, and the biggest double is the
//                bull at 50, so the ceiling is T20 T20 BULL = 170.
//   master out - a triple may finish, so T20 T20 T20 = 180 is a checkout.
//   straight   - anything may finish, so 180 again.
//
// Lives here rather than in the statistics code because it is a fact about the
// rules, and two copies of it would be two things to fix.
export function highestCheckout(rulesKey) {
  return rulesFor(rulesKey).out === "double" ? 170 : 180;
}

// Can this remaining score be finished with ONE legal dart? Used to decide
// which darts were attempts at a finish.
//
// The segments that exist: singles 1-20 and the 25 outer bull; doubles 2-40
// even and the 50 bull; triples 3-60 in multiples of three. Which of them may
// legally finish is what the out rule decides.
export function isOneDartFinish(remaining, rulesKey) {
  if (!Number.isInteger(remaining) || remaining <= 0) return false;

  const isDouble = (remaining <= 40 && remaining % 2 === 0) || remaining === 50;
  const out = rulesFor(rulesKey).out;
  if (out === "double") return isDouble;

  const isTriple = remaining <= 60 && remaining % 3 === 0;
  // 25 is finishable under masters because the bull counts.
  if (out === "master") return isDouble || isTriple || remaining === 25;

  const isSingle = remaining <= 20 || remaining === 25;
  return isDouble || isTriple || isSingle;
}

// Given a player's remaining score before a throw and the segment hit,
// returns what happens - the caller decides how to apply it (bust reverts
// to the start-of-turn value, which only the caller knows).
//
// options:
//   inRule  - "straight" | "double"                (default straight)
//   outRule - "straight" | "double" | "master"     (default double)
//   opened  - has this player already satisfied the in rule? (default true)
//
// The defaults are plain 501 double-out, so callers that don't care about
// variants can keep passing two arguments and behave exactly as before.
export function resolveThrow(remainingBefore, segment, options = {}) {
  const { inRule = "straight", outRule = "double", opened = true } = options;

  // Double-in: until the player opens, darts land but score nothing. They
  // still count as darts thrown, so a turn is still three of them.
  if (!opened) {
    if (!segmentOpens(segment, inRule)) {
      return {
        after: remainingBefore,
        isBust: false,
        isWin: false,
        opened: false,
        ignored: true, // scored nothing because the player hasn't opened yet
      };
    }
    // The opening dart itself counts, so fall through and score it normally.
  }

  const after = remainingBefore - segment.value;
  const canFinish = segmentCanFinish(segment, outRule);

  // Leaving exactly 1 is only a problem when you need a double or triple to
  // finish - there's no double or triple that makes 1. With straight out you
  // can simply hit a single 1 next, so it isn't a bust.
  const strandedOnOne = after === 1 && outRule !== "straight";

  const isWin = after === 0 && canFinish;
  const isBust = after < 0 || strandedOnOne || (after === 0 && !canFinish);

  return { after, isBust, isWin, opened: true, ignored: false };
}

// ---------------------------------------------------------------------------
// The Freeze Rule - partners x01 only
// ---------------------------------------------------------------------------
// "A player may go out and win only if their partners score is equal to or
// less than the combined score of the opposing team."
//   - CAP Amusement, https://www.capamusement.com/article.cfm?ArticleNumber=38
//
// This lives here rather than in a partners module because it is x01 rule
// arithmetic, which is what this file is - the same reason highestCheckout()
// and isOneDartFinish() are here rather than in checkout.js.
//
// THE COMPARISON IGNORES YOUR OWN SCORE, which is the thing that surprises
// everyone including the author. Whether *you* may finish is decided by your
// PARTNER's remaining against the opposing team's COMBINED remaining. You can
// be on a double, unfrozen a moment ago, and be frozen by your opponents
// scoring - because their total falling is what closes the gap.
//
// The rule only exists in the FREEZE VERSION of partners x01, which is also
// the version where all four players carry separate scores. In the other
// version the two partners share one total and there is nothing to compare.
// See docs/team-play.md.

// The combined score is passed already summed rather than as two opponents.
// That keeps this total over a team of any size, and puts the one place that
// knows how many opponents there are in the caller instead of in the rule.
//
// NON-FINITE INPUTS FAIL OPEN - an unknown freeze state reports NOT frozen.
// Both failure directions are bad and this is the less bad one: wrongly
// allowing a finish is a scoring error the players can see and correct,
// whereas wrongly freezing hands the leg to the opposition (see
// resolvePartnersThrow) and there is no undoing that in a way anyone accepts.
export function isFrozen(partnerRemaining, opponentsCombined) {
  if (!Number.isFinite(partnerRemaining)) return false;
  if (!Number.isFinite(opponentsCombined)) return false;
  return partnerRemaining > opponentsCombined;
}

// resolveThrow, plus the freeze. Composes rather than duplicates - every
// existing x01 rule (the in/out matrix, bust on stranded 1, darts that score
// nothing before opening) is decided by resolveThrow exactly as it always was,
// and this only ever reinterprets a WIN.
//
// That ordering matters: a dart that reaches zero without a legal finishing
// segment is already a bust, and being frozen must not upgrade it into a
// conceded leg. So the freeze is asked about only after isWin is true.
//
// options: everything resolveThrow takes, plus
//   freeze            - is this the freeze version at all?   (default false)
//   partnerRemaining  - your partner's score
//   opponentsCombined - both opponents' scores, added up
//   frozenFinish      - "loss" | "bust"                      (default "loss")
//
// frozenFinish is a per-leg setting because the penalty is severe enough that
// houses differ on it. "loss" is the sourced behaviour and therefore the
// default, on the same principle that keeps X01_RULES matching the machines
// rather than matching taste; "bust" is the gentler reading and costs nothing,
// because it reuses the bust path whole.
//
// Adds two fields to resolveThrow's result:
//   frozen   - was the thrower frozen when this dart was thrown? Reported
//              whenever freeze is on, win or not, because the UI wants to warn
//              a player BEFORE they throw at a double they cannot use.
//   concedes - this leg is over and the OPPOSING team has won it. The only
//              place in this codebase where reaching zero is a defeat, so it
//              cannot be folded into isBust: a bust restores the score and
//              passes the turn, this ends the leg.
export function resolvePartnersThrow(remainingBefore, segment, options = {}) {
  const base = resolveThrow(remainingBefore, segment, options);

  const {
    freeze = false,
    partnerRemaining,
    opponentsCombined,
    frozenFinish = "loss",
  } = options;

  if (!freeze) return { ...base, frozen: false, concedes: false };

  const frozen = isFrozen(partnerRemaining, opponentsCombined);
  if (!frozen || !base.isWin) return { ...base, frozen, concedes: false };

  // Reaching zero while frozen. The win is taken away either way; what the
  // setting decides is who, if anyone, gets the leg.
  if (frozenFinish === "bust") {
    return { ...base, isWin: false, isBust: true, frozen, concedes: false };
  }
  return { ...base, isWin: false, isBust: false, frozen, concedes: true };
}
