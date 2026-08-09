// Tests for the Freeze Rule in partners x01.
//
// This one earns its place for a reason the other rules tests do not share:
// the rule is COUNTER-INTUITIVE, and code that implements it wrongly still
// looks right. Whether you may finish depends on your PARTNER's score against
// the OPPOSING TEAM's combined score, and never on your own - so the natural
// mistakes are to compare the wrong pair of numbers, or to compare them the
// wrong way round, and both produce a predicate that is correct roughly half
// the time. On a board that reads as "the machine let them go out that time
// and not this time", which is indistinguishable from not understanding the
// rule, which is what players already assume about the freeze.
//
// The stated rule, which every assertion here is derived from:
//
//   "A player may go out and win only if their partners score is equal to or
//    less than the combined score of the opposing team."
//   - CAP Amusement, https://www.capamusement.com/article.cfm?ArticleNumber=38
//
// Note the EQUAL case is explicitly a permission, not a freeze. That single
// word is the whole of the boundary and it is asserted on its own below.

import test from "node:test";
import assert from "node:assert/strict";

import { isFrozen, resolvePartnersThrow, resolveThrow } from "../scoring.js";
import {
  canPlayTeams, teamOf, teamLabel, partnerOf, opponentsOf, freezeInputs,
} from "../teams.js";
import { normalizeLeg, gameLabel } from "../medley.js";
import { SegmentType } from "../granboard.js";

// Segment builders. resolveThrow only reads value, type and section, so these
// are the whole of what a dart is as far as this file is concerned.
const D = (n) => ({ value: n * 2, type: SegmentType.Double, section: String(n) });
const S = (n) => ({ value: n, type: SegmentType.Single, section: String(n) });
const T = (n) => ({ value: n * 3, type: SegmentType.Triple, section: String(n) });
const BULL = { value: 50, type: SegmentType.Double, section: "BULL" };

// A frozen thrower: partner on 100, opponents on 40 + 40 = 80. 100 > 80.
const FROZEN = { freeze: true, partnerRemaining: 100, opponentsCombined: 80 };
// An unfrozen thrower: partner on 60 against the same 80.
const CLEAR = { freeze: true, partnerRemaining: 60, opponentsCombined: 80 };

// ---------------------------------------------------------------------------
// The predicate

test("frozen when the partner's score exceeds the opponents' combined score", () => {
  assert.equal(isFrozen(101, 100), true);
  assert.equal(isFrozen(200, 100), true);
  assert.equal(isFrozen(501, 2), true);
});

test("not frozen when the partner's score is below the combined score", () => {
  assert.equal(isFrozen(99, 100), false);
  assert.equal(isFrozen(2, 501), false);
});

test("EQUAL is not frozen - the rule says 'equal to or less than'", () => {
  // The entire boundary. Off by one here and every frozen call at the moment
  // the scores level is wrong, which is exactly when it matters most.
  assert.equal(isFrozen(100, 100), false);
  assert.equal(isFrozen(1, 1), false);
  assert.equal(isFrozen(0, 0), false);
});

test("the comparison never reads the thrower's own score", () => {
  // There is no argument for it, which is the point - this test exists to
  // fail loudly if someone "fixes" the signature to take it.
  assert.equal(isFrozen.length, 2);
});

test("it is the COMBINED opposing score, so one opponent alone can be lower", () => {
  // Partner on 90. Each opponent is on 50, so either one alone is less than
  // 90 and comparing against a single opponent would report frozen - but
  // together they are 100, and the team is not frozen.
  assert.equal(isFrozen(90, 50), true);
  assert.equal(isFrozen(90, 50 + 50), false);
});

test("non-finite inputs fail OPEN, reporting not frozen", () => {
  // Deliberate, and documented beside the function: wrongly allowing a finish
  // is a visible scoring error the players can correct, whereas wrongly
  // freezing concedes the leg to the opposition and cannot be undone in a way
  // anyone accepts.
  assert.equal(isFrozen(undefined, 100), false);
  assert.equal(isFrozen(100, undefined), false);
  assert.equal(isFrozen(NaN, 100), false);
  assert.equal(isFrozen(100, NaN), false);
  assert.equal(isFrozen(Infinity, 100), false);
  assert.equal(isFrozen(null, null), false);
});

// ---------------------------------------------------------------------------
// Composition with the existing x01 rules

test("with freeze off, the result is resolveThrow's, untouched", () => {
  for (const remaining of [40, 60, 121, 2]) {
    for (const segment of [D(20), S(20), T(20), BULL]) {
      const plain = resolveThrow(remaining, segment);
      const partners = resolvePartnersThrow(remaining, segment);
      assert.equal(partners.after, plain.after);
      assert.equal(partners.isWin, plain.isWin);
      assert.equal(partners.isBust, plain.isBust);
      assert.equal(partners.frozen, false);
      assert.equal(partners.concedes, false);
    }
  }
});

test("freeze changes nothing about a dart that does not finish", () => {
  // 100 left, hits a treble 20. Not a finish either way, and being frozen is
  // irrelevant to it - the score must fall by 60 exactly as always.
  const clear = resolvePartnersThrow(100, T(20), CLEAR);
  const frozen = resolvePartnersThrow(100, T(20), FROZEN);
  assert.equal(clear.after, 40);
  assert.equal(frozen.after, 40);
  assert.equal(frozen.isWin, false);
  assert.equal(frozen.isBust, false);
  assert.equal(frozen.concedes, false);
});

test("an unfrozen player checks out normally", () => {
  const r = resolvePartnersThrow(40, D(20), CLEAR);
  assert.equal(r.isWin, true);
  assert.equal(r.isBust, false);
  assert.equal(r.concedes, false);
  assert.equal(r.frozen, false);
});

test("frozen is reported even on a dart that is not a finish", () => {
  // The UI needs this to warn a player BEFORE they throw at a double they
  // cannot use, so it must not only appear on the winning dart.
  const r = resolvePartnersThrow(140, S(20), FROZEN);
  assert.equal(r.frozen, true);
  assert.equal(r.isWin, false);
  assert.equal(r.concedes, false);
});

// ---------------------------------------------------------------------------
// Reaching zero while frozen

test("frozenFinish 'loss' concedes the leg to the opposition", () => {
  const r = resolvePartnersThrow(40, D(20), { ...FROZEN, frozenFinish: "loss" });
  assert.equal(r.after, 0);
  assert.equal(r.isWin, false);
  assert.equal(r.concedes, true);
  // NOT a bust. A bust restores the score and passes the turn; this ends the
  // leg. Folding the two together would silently turn a lost leg into a
  // continuing one.
  assert.equal(r.isBust, false);
});

test("'loss' is the default, because it is the sourced behaviour", () => {
  const explicit = resolvePartnersThrow(40, D(20), { ...FROZEN, frozenFinish: "loss" });
  const implied = resolvePartnersThrow(40, D(20), FROZEN);
  assert.deepEqual(implied, explicit);
});

test("frozenFinish 'bust' restores the turn instead, and concedes nothing", () => {
  const r = resolvePartnersThrow(40, D(20), { ...FROZEN, frozenFinish: "bust" });
  assert.equal(r.isWin, false);
  assert.equal(r.isBust, true);
  assert.equal(r.concedes, false);
});

test("the two frozenFinish settings never both fire", () => {
  for (const frozenFinish of ["loss", "bust"]) {
    const r = resolvePartnersThrow(40, D(20), { ...FROZEN, frozenFinish });
    assert.equal(r.isBust && r.concedes, false);
    assert.equal(r.isWin, false);
  }
});

// ---------------------------------------------------------------------------
// Order of operations - the freeze is asked LAST

test("a dart that busts on the out rule busts, rather than conceding", () => {
  // 20 left, single 20 under double out: it REACHES ZERO but on a segment
  // that cannot finish, so resolveThrow already calls it a bust. Being frozen
  // must not upgrade that into a lost leg - which is why the freeze is asked
  // about only once isWin is true.
  const r = resolvePartnersThrow(20, S(20), FROZEN);
  assert.equal(r.after, 0);
  assert.equal(r.isWin, false);
  assert.equal(r.isBust, true);
  assert.equal(r.concedes, false);
});

test("overthrowing busts rather than conceding, frozen or not", () => {
  const r = resolvePartnersThrow(20, D(20), FROZEN);
  assert.equal(r.after, -20);
  assert.equal(r.isBust, true);
  assert.equal(r.concedes, false);
});

test("stranded on 1 busts rather than conceding", () => {
  const r = resolvePartnersThrow(41, D(20), FROZEN);
  assert.equal(r.after, 1);
  assert.equal(r.isBust, true);
  assert.equal(r.concedes, false);
});

test("a dart that scores nothing before opening cannot concede", () => {
  // Double in, not yet opened: the dart lands, scores nothing, and is not a
  // finish - so there is nothing for the freeze to reinterpret.
  const r = resolvePartnersThrow(40, S(20), {
    ...FROZEN, inRule: "double", opened: false,
  });
  assert.equal(r.ignored, true);
  assert.equal(r.after, 40);
  assert.equal(r.concedes, false);
});

// ---------------------------------------------------------------------------
// The freeze applies under every out rule

test("the freeze blocks a finish under every out rule", () => {
  const cases = [
    { outRule: "double", remaining: 40, segment: D(20) },
    { outRule: "master", remaining: 60, segment: T(20) },
    { outRule: "master", remaining: 25, segment: { value: 25, type: SegmentType.Single, section: "BULL" } },
    { outRule: "straight", remaining: 20, segment: S(20) },
  ];
  for (const { outRule, remaining, segment } of cases) {
    // Unfrozen, this is a win under that rule - the premise of the case.
    const clear = resolvePartnersThrow(remaining, segment, { ...CLEAR, outRule });
    assert.equal(clear.isWin, true, `${outRule} should win when clear`);

    const frozen = resolvePartnersThrow(remaining, segment, { ...FROZEN, outRule });
    assert.equal(frozen.isWin, false, `${outRule} should not win when frozen`);
    assert.equal(frozen.concedes, true, `${outRule} should concede when frozen`);
  }
});

test("the bull finishes and concedes like any other segment", () => {
  assert.equal(resolvePartnersThrow(50, BULL, CLEAR).isWin, true);
  assert.equal(resolvePartnersThrow(50, BULL, FROZEN).concedes, true);
});

// ---------------------------------------------------------------------------
// The rule in motion, which is where its strangeness shows

test("a player can be frozen by the OPPONENTS scoring, without throwing", () => {
  // Partner sits on 100 throughout. The opponents' combined total falls from
  // 120 to 80 because they are scoring well - and that alone freezes this
  // player, who has not thrown a dart in between.
  assert.equal(isFrozen(100, 120), false);
  assert.equal(isFrozen(100, 80), true);
});

test("a player is unfrozen by their PARTNER scoring", () => {
  // The partner is the one who can release the freeze, which is the whole
  // tactical point of the rule: you feed your partner rather than going out.
  assert.equal(isFrozen(120, 100), true);
  assert.equal(isFrozen(60, 100), false);
});

test("your own score is irrelevant - on a double either way", () => {
  // Identical position for the thrower, opposite outcomes, decided entirely
  // by the other three scores.
  const onADouble = 40;
  assert.equal(resolvePartnersThrow(onADouble, D(20), CLEAR).isWin, true);
  assert.equal(resolvePartnersThrow(onADouble, D(20), FROZEN).isWin, false);
});

// ---------------------------------------------------------------------------
// The pairing - teams.js
//
// Which seat is my partner is the other half of getting the freeze right, and
// it fails the same silent way: pair the wrong seats and the predicate still
// answers, still plausibly, and the only symptom is a leg that ends when it
// should not have.

test("partners is offered at exactly four seats", () => {
  // Three cannot be two equal teams and six is a different game with its own
  // rotation. Neither is a partners match with a bit missing.
  assert.equal(canPlayTeams(4), true);
  for (const n of [0, 1, 2, 3, 5, 6, 8]) assert.equal(canPlayTeams(n), false);
});

test("seats alternate, which is what keeps the existing rotation correct", () => {
  // A1 B1 A2 B2. game.js advances with (i + 1) % players.length and needs no
  // change at all because of this - so if the pairing ever stops alternating,
  // turn ORDER breaks too, not just the teams.
  assert.deepEqual([0, 1, 2, 3].map(teamOf), [0, 1, 0, 1]);
});

test("partnerOf is symmetric and never yourself", () => {
  for (const seat of [0, 1, 2, 3]) {
    assert.notEqual(partnerOf(seat), seat);
    assert.equal(partnerOf(partnerOf(seat)), seat);
    assert.equal(teamOf(partnerOf(seat)), teamOf(seat));
  }
});

test("opponents are the other team, both of them", () => {
  assert.deepEqual(opponentsOf(0), [1, 3]);
  assert.deepEqual(opponentsOf(1), [0, 2]);
  assert.deepEqual(opponentsOf(2), [1, 3]);
  assert.deepEqual(opponentsOf(3), [0, 2]);
  for (const seat of [0, 1, 2, 3]) {
    assert.equal(opponentsOf(seat).length, 2);
    assert.equal(opponentsOf(seat).includes(seat), false);
    assert.equal(opponentsOf(seat).includes(partnerOf(seat)), false);
  }
});

test("teamLabel is 1-based, and agrees with teamOf", () => {
  assert.equal(teamLabel(0), "Team 1");
  assert.equal(teamLabel(1), "Team 2");
  assert.equal(teamLabel(2), "Team 1");
  assert.equal(teamLabel(3), "Team 2");
});

test("freezeInputs reads the partner and the opponents, never the thrower", () => {
  // Seats 0 and 2 are one team, 1 and 3 the other.
  const remaining = [40, 60, 300, 20];
  assert.deepEqual(freezeInputs(remaining, 0), {
    partnerRemaining: 300,          // seat 2
    opponentsCombined: 60 + 20,     // seats 1 and 3
  });
  // The thrower's own 40 appears in neither number. Change it and nothing
  // about the answer moves.
  const moved = [180, 60, 300, 20];
  assert.deepEqual(freezeInputs(moved, 0), freezeInputs(remaining, 0));
});

test("the pairing and the predicate agree end to end", () => {
  // Seat 0 throws. Partner (seat 2) is on 300 against 80 combined: frozen.
  // Seat 1 throws. Partner (seat 3) is on 20 against 340 combined: clear.
  const remaining = [40, 60, 300, 20];
  const a = freezeInputs(remaining, 0);
  const b = freezeInputs(remaining, 1);
  assert.equal(isFrozen(a.partnerRemaining, a.opponentsCombined), true);
  assert.equal(isFrozen(b.partnerRemaining, b.opponentsCombined), false);
});

// ---------------------------------------------------------------------------
// The leg descriptor - medley.js
//
// The freeze sits BESIDE `rules` rather than inside it, because `rules` is a
// string key into X01_RULES and has no room for another field. Asserted here
// because docs/team-play.md originally assumed otherwise.

test("an x01 leg always describes its freeze, even when off", () => {
  // An absent key must mean the default rather than undefined behaviour - a
  // stored match has to be readable without knowing which build wrote it.
  const plain = normalizeLeg({ game: "x01", score: 501 });
  assert.equal(plain.freeze, false);
  assert.equal(plain.frozenFinish, "loss");
});

test("'loss' is the default penalty, and only 'bust' overrides it", () => {
  assert.equal(normalizeLeg({ game: "x01", freeze: true }).frozenFinish, "loss");
  assert.equal(normalizeLeg({ game: "x01", freeze: true, frozenFinish: "bust" }).frozenFinish, "bust");
  // Anything unrecognised falls back to the sourced behaviour rather than
  // being carried through as-is.
  assert.equal(normalizeLeg({ game: "x01", frozenFinish: "nonsense" }).frozenFinish, "loss");
});

test("freeze is only truthy when it is exactly true", () => {
  // Legacy legs, and legs from an older build, carry no freeze key at all.
  assert.equal(normalizeLeg("501").freeze, false);
  assert.equal(normalizeLeg({ game: "x01", freeze: "yes" }).freeze, false);
  assert.equal(normalizeLeg({ game: "x01", freeze: 1 }).freeze, false);
});

test("the label names the freeze only when it is on", () => {
  assert.equal(gameLabel({ game: "x01", score: 501 }).includes("freeze"), false);
  assert.equal(gameLabel({ game: "x01", score: 501, freeze: true }).includes("· freeze"), true);
  assert.equal(gameLabel({ game: "x01", score: 501, freeze: true, frozenFinish: "bust" }).includes("freeze (bust)"), true);
});
