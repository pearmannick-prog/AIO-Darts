// teams.js - partners play: which seat is on which team, and what that means
// for the Freeze Rule's inputs.
//
// Pure and side-effect-free, like the rest of the rules layer, so local and
// online play can share it rather than each deriving the pairing themselves.
//
// A TEAM IS A SEAT'S LABEL, NOT A CONTAINER. Nothing here holds players or
// scores - it answers questions about an existing seat list. That is what
// keeps it usable by the freeze-ON variant of partners x01, where every player
// carries their own score, and later by the shared-total variants, where they
// do not. See docs/team-play.md.
//
// SEATS ALTERNATE: 0 and 2 are one team, 1 and 3 the other. That is the
// standard doubles order - A1, B1, A2, B2 - and choosing it is what makes the
// existing `(i + 1) % players.length` rotation in game.js correct for partners
// play with no change at all.
//
// The design document argued against seat parity as the way team membership is
// STORED, and that still holds: the recorder gets an explicit team per player,
// because a convention duplicated across the recorder, the stats engine, the
// leaderboards and two controllers is one that drifts. What parity is good for
// is deriving the pairing once, here, from a seat order the player can see on
// screen.

export const TEAM_SIZE = 2;
export const TEAM_COUNT = 2;
export const TEAM_PLAYERS = TEAM_SIZE * TEAM_COUNT;

// Partners is offered at exactly four seats. Three cannot be two equal teams,
// and six is a different game with its own rotation - neither is a partners
// match with a bit missing, so neither is silently allowed.
export function canPlayTeams(playerCount) {
  return playerCount === TEAM_PLAYERS;
}

export function teamOf(seat) {
  return seat % TEAM_COUNT;
}

// 1-based for display. The setup rows and the scoreboard both say "Team 1"
// rather than "Team 0", and having the +1 in one place stops the two
// disagreeing about which team a seat is on.
export function teamLabel(seat) {
  return `Team ${teamOf(seat) + 1}`;
}

// The other seat on your team. Total for any seat in a four-handed game.
export function partnerOf(seat) {
  return (seat + TEAM_COUNT) % TEAM_PLAYERS;
}

export function opponentsOf(seat) {
  const mine = teamOf(seat);
  return [0, 1, 2, 3].filter((s) => teamOf(s) !== mine);
}

// The two numbers the Freeze Rule compares, read off a list of per-player
// remaining scores.
//
// This exists so that neither controller works out "my partner's score" and
// "their combined score" itself. Both are easy to get subtly wrong - the rule
// never reads the thrower's own score, so a mistake still produces a plausible
// answer - and a second copy of the derivation is a second chance to make it.
// See server/freeze.test.js for what the predicate then does with these.
export function freezeInputs(remainings, seat) {
  const partner = remainings[partnerOf(seat)];
  const opponentsCombined = opponentsOf(seat)
    .reduce((sum, s) => sum + (remainings[s] ?? 0), 0);
  return { partnerRemaining: partner, opponentsCombined };
}
