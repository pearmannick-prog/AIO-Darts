// sequencer.js - total order for a match with more than two peers.
//
// WHY THIS EXISTS AT ALL. The sync strategy in this app is determinism: there
// is no authoritative server and no rollback/replay, and both browsers stay in
// step because they run the identical pure functions over the identical
// sequence of darts. WebRTC DataChannels deliver in order, so with two peers
// "the identical sequence" comes free.
//
// That guarantee is PER CHANNEL, BETWEEN TWO PEERS. Four peers in a full mesh
// have six channels and no global order at all. If two messages are in flight
// at once, peer B can legitimately apply them in one order and peer D in the
// other - and in Cricket the order decides whether a number was closed when a
// dart landed, which decides whether it scored. The scoreboards then disagree
// permanently, with nothing to reconcile them, because there is deliberately
// no rollback and no authority.
//
// Turn discipline hides most of this: only one person is supposed to be
// throwing. "Most" is not the standard the rest of this codebase holds itself
// to, and the races that remain are exactly the ones already known to exist -
// a dart arriving during the ten-second hold, and a late message after a turn
// has passed.
//
// THE FIX IS A SEQUENCER, NOT AN AUTHORITY. The host stamps every game message
// with a monotonically increasing number and rebroadcasts it; everyone applies
// strictly in that order. Total order is restored exactly, so the determinism
// argument above works again word for word. The host is not deciding anything
// about darts - it never inspects a message, it only numbers it - so "the
// server never sees a dart" is untouched, and so is "both sides compute the
// result themselves".
//
// THE COST, STATED PLAINLY: a guest's own dart is not applied until it comes
// back stamped, which is one round trip to the host. That is deliberate and is
// the whole point. Applying it locally first and reconciling later is the
// rollback this project does not have, and in Cricket it would mean showing
// marks that a later message takes away. One RTT is imperceptible next to
// walking to the board; a scoreboard that changes its mind is not.
//
// Pure and side-effect-free: it holds no sockets, no DOM and no game state. It
// is given two callbacks and told what arrives.
//
// NOTHING CALLS THIS YET, and that is deliberate rather than an oversight. The
// races it removes only exist above two peers, and there is no three-or-four
// peer mode in the app: `online.js` runs one DataChannel to one opponent, where
// the channel's own ordering already provides the total order this rebuilds.
// Wiring it into the 1v1 path would buy nothing and cost a round trip on every
// dart the guest throws (see THE COST above), so it waits for the mode it is
// for - the sized rooms and slot routing in server.js are the other half of the
// same unfinished feature. It is tested (server/sequencer.test.js) and
// precached because the alternative is writing it later under time pressure,
// against a race that reproduces once a fortnight.

// `submit`  - a message this peer wants applied, from its own play
// `receive` - a message that arrived from another peer
//
// createSequencer({ isHost, send, apply })
//   isHost - does this peer stamp? Exactly one peer in a match may.
//   send   - send(message, { to }) - `to` absent means everyone
//   apply  - apply(message) - the game logic; called ONCE per message, in
//            sequence order, on every peer
export function createSequencer({ isHost = false, send, apply }) {
  // The next number the host will hand out, and the next number everyone
  // expects to apply. They are different questions: the host has stamped `seq`
  // messages, and this peer has applied everything below `nextSeq`.
  let seq = 0;
  let nextSeq = 1;

  // Stamped messages that arrived before their turn. Keyed by seq.
  //
  // A DataChannel is ordered, so within one host→peer channel this should stay
  // empty. It is here because "should" is doing work in that sentence: a
  // reconnect, a resend, or a future unordered channel would all produce a gap,
  // and a gap that is dropped instead of held is a peer silently one dart
  // behind everyone else for the rest of the match.
  const pending = new Map();

  function applyInOrder() {
    while (pending.has(nextSeq)) {
      const message = pending.get(nextSeq);
      pending.delete(nextSeq);
      nextSeq += 1;
      apply(message);
    }
  }

  return {
    // Something this peer did - a dart, an end of turn, a next leg.
    //
    // The host stamps and broadcasts it, then applies it through the same path
    // everyone else does, so its own ordering is decided by the same rule
    // rather than by being first.
    //
    // A guest sends it to the host and applies NOTHING. Its own dart comes back
    // stamped like anyone else's; until then it has not happened, because it
    // has no position in the order yet.
    submit(message) {
      if (!isHost) {
        send({ ...message, seq: undefined }, { to: 0 });
        return;
      }
      seq += 1;
      const stamped = { ...message, seq };
      send(stamped);
      pending.set(seq, stamped);
      applyInOrder();
    },

    // A message from another peer.
    //
    // On the host an UNSTAMPED message is a guest's submission, and stamping it
    // here is what serialises the whole match: whichever arrives first gets the
    // lower number, and every peer then agrees, because there is only one
    // clock. A stamped one on the host would be a peer claiming to sequence,
    // which is a bug in that peer rather than something to honour.
    receive(message) {
      const stamped = Number.isInteger(message?.seq);

      if (isHost) {
        if (stamped) return; // only the host stamps; ignore a claim otherwise
        seq += 1;
        const out = { ...message, seq };
        send(out);
        pending.set(seq, out);
        applyInOrder();
        return;
      }

      if (!stamped) return; // a guest has nothing to do with an unstamped one

      // Already applied. Duplicates are harmless to ignore and dangerous to
      // apply: a resent dart would score twice, and nothing on screen would
      // say which one was the copy.
      if (message.seq < nextSeq) return;

      pending.set(message.seq, message);
      applyInOrder();
    },

    // How far ahead the buffer is holding, for a caller that wants to notice a
    // gap that is not filling. Zero in the ordinary case.
    waiting() {
      return pending.size;
    },

    // Test and diagnostic access. Never used to make a decision - the two
    // counters are the state, and exposing them read-only keeps it that way.
    position() {
      return { seq, nextSeq, waiting: pending.size };
    },
  };
}
