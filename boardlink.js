// boardlink.js - the one connection to the one physical board.
//
// There is a single Granboard on the oche, so there is a single connection to
// it here. That was not true before: game.js and online.js each opened their
// own and wired their own callbacks, which meant the app had TWO board
// connections and the dart went to whichever controller happened to own the
// button you pressed. Connect from the header during an online match and every
// dart was delivered to the local game, which was not running - the board said
// "Connected: GRANBOARD", the match said "Your turn", and nothing happened.
// Nothing in either controller was wrong; the mistake was that there were two.
//
// So the connection is owned here and both controllers subscribe to it. Every
// button that connects a board now connects THE board, and the modes cannot
// disagree about whether one is attached - the same reason dartboard.js and
// matchrecorder.js are shared rather than duplicated.
//
// WHERE A DART GOES. Both controllers see every hit, and each says whether it
// wants it. A dart belongs to the online match when one is in progress, and to
// the local game otherwise, which is decided by priority rather than by asking
// the controllers to know about each other: online.js registers above game.js
// and takes the dart when its match is live. Neither module imports the other.

import { Granboard } from "./granboard.js";

let board = null;
const subscribers = [];
const statusListeners = new Set();

// Registers a consumer of board hits.
//
//   wants()  - true when this consumer is in a state to accept a dart. Called
//              per hit, so it always reflects the live state rather than
//              whatever was true at subscribe time.
//   onHit(s) - given the raw segment, exactly as granboard.js produced it. The
//              board's physical button arrives here too, as RESET_BUTTON, so
//              each controller can decide what ending a turn means to it.
//   priority - higher wins when more than one consumer wants the same dart.
export function subscribeToBoard({ wants, onHit, priority = 0 }) {
  const entry = { wants, onHit, priority };
  subscribers.push(entry);
  subscribers.sort((a, b) => b.priority - a.priority);
  return () => {
    const at = subscribers.indexOf(entry);
    if (at >= 0) subscribers.splice(at, 1);
  };
}

// Connection state, for the labels and dots each controller keeps of its own.
export function onBoardStatusChange(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

export function isBoardConnected() {
  return Boolean(board);
}

export function boardName() {
  return board?.deviceName || "";
}

function announce() {
  const state = { connected: Boolean(board), name: boardName() };
  for (const fn of statusListeners) {
    try {
      fn(state);
    } catch (err) {
      // One controller's broken label must not stop the other being told.
      console.error("Board status listener failed", err);
    }
  }
}

function deliver(segment) {
  for (const sub of subscribers) {
    let wanted = false;
    try {
      wanted = sub.wants();
    } catch (err) {
      console.error("Board subscriber's wants() threw", err);
    }
    if (!wanted) continue;
    sub.onHit(segment);
    return;
  }
  // Nobody is playing. Not an error - a board left switched on between games
  // reports the darts you pull out of it - so this is quiet by design.
}

// Opens the connection, or returns the existing one. Idempotent on purpose:
// both the header button and the in-match button call it, and pressing the
// second while already connected should not tear down a working board.
export async function connectBoard() {
  if (board) return board;

  board = await Granboard.connect();

  board.segmentHitCallback = (segment) => deliver(segment);
  board.disconnectCallback = () => {
    board = null;
    announce();
  };

  announce();
  return board;
}
