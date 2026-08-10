// Tests for the sequencer - total order across more than two peers.
//
// This one is worth more than most, because what it prevents cannot be seen by
// playing. Two scoreboards that disagree do so silently and permanently: there
// is no rollback in this app, so once two peers have applied the same two darts
// in different orders there is nothing that notices and nothing that repairs
// it. In Cricket it decides whether a number was closed when a dart landed, and
// therefore whether it scored.
//
// So the property under test is not "messages arrive" but "EVERY PEER APPLIES
// THE SAME MESSAGES IN THE SAME ORDER", including the peer that sent them.
//
// The harness below wires real sequencers to each other through a transport
// that can be told to deliver out of order, twice, or not at all - which is the
// whole point, since a network that behaves well proves nothing here.

import test from "node:test";
import assert from "node:assert/strict";

import { createSequencer } from "../sequencer.js";

// A match of `n` peers. Slot 0 is the host. Messages are queued rather than
// delivered, so a test decides when - and in what order - the network runs.
function mesh(n) {
  const inFlight = [];
  const applied = Array.from({ length: n }, () => []);
  const peers = [];

  for (let slot = 0; slot < n; slot++) {
    peers.push(createSequencer({
      isHost: slot === 0,
      send: (message, { to } = {}) => {
        const targets = Number.isInteger(to)
          ? [to]
          : [...Array(n).keys()].filter((s) => s !== slot);
        for (const target of targets) inFlight.push({ target, message });
      },
      apply: (message) => applied[slot].push(message.id),
    }));
  }

  return {
    peers,
    applied,
    // Deliver everything currently queued, in the order it was sent, until
    // nothing is left - including messages produced by delivering others.
    flush() {
      let guard = 0;
      while (inFlight.length) {
        if (++guard > 1000) throw new Error("delivery did not settle");
        const { target, message } = inFlight.shift();
        peers[target].receive(message);
      }
    },
    // Deliver in reverse, which is the case the whole module exists for.
    flushReversed() {
      const batch = inFlight.splice(0, inFlight.length).reverse();
      for (const { target, message } of batch) peers[target].receive(message);
      this.flush();
    },
    pending: () => inFlight.length,
    deliverOne() {
      const item = inFlight.shift();
      if (item) peers[item.target].receive(item.message);
    },
    duplicateAll() {
      inFlight.push(...inFlight.map((x) => ({ ...x })));
    },
  };
}

const ids = (list) => list.join(",");

// ---------------------------------------------------------------------------
// The property

test("every peer applies the same messages in the same order", () => {
  const net = mesh(4);
  net.peers[1].submit({ id: "a" });
  net.peers[3].submit({ id: "b" });
  net.peers[0].submit({ id: "c" });
  net.peers[2].submit({ id: "d" });
  net.flush();

  const order = ids(net.applied[0]);
  assert.equal(order.split(",").length, 4);
  for (let slot = 1; slot < 4; slot++) {
    assert.equal(ids(net.applied[slot]), order, `peer ${slot} disagrees`);
  }
});

test("the same is true when the network delivers in reverse", () => {
  // The case with no equivalent in a two-peer match, and the reason this
  // module exists: out-of-order delivery must not become out-of-order APPLY.
  const net = mesh(4);
  net.peers[1].submit({ id: "a" });
  net.peers[2].submit({ id: "b" });
  net.peers[3].submit({ id: "c" });
  net.flushReversed();

  const order = ids(net.applied[0]);
  for (let slot = 1; slot < 4; slot++) {
    assert.equal(ids(net.applied[slot]), order);
  }
  assert.equal(order.split(",").length, 3);
});

test("a guest does not apply its own message before it is stamped", () => {
  // The cost this design accepts, asserted so nobody "optimises" it away: your
  // own dart has no position in the order until the host gives it one, and
  // applying it early is the rollback this project does not have.
  const net = mesh(4);
  net.peers[2].submit({ id: "mine" });
  assert.equal(net.applied[2].length, 0);

  net.flush();
  assert.equal(ids(net.applied[2]), "mine");
});

test("the host applies its own message through the same path", () => {
  // Not "first because it is the host" - it takes a number like everything
  // else, so its ordering is decided by the same rule.
  const net = mesh(4);
  net.peers[0].submit({ id: "h" });
  assert.equal(ids(net.applied[0]), "h");
  assert.equal(net.peers[0].position().seq, 1);
});

// ---------------------------------------------------------------------------
// What the transport is allowed to do to it

test("a duplicated message is applied once", () => {
  // A resend must not score twice, and nothing on a board would say which was
  // the copy.
  const net = mesh(3);
  net.peers[1].submit({ id: "a" });
  net.flush();
  net.peers[0].submit({ id: "b" });
  net.duplicateAll();
  net.flush();

  for (let slot = 0; slot < 3; slot++) assert.equal(ids(net.applied[slot]), "a,b");
});

test("a gap is HELD, not dropped", () => {
  // A message applied out of its place is a peer permanently out of step. It
  // waits instead - and the wait is visible, so a caller can notice.
  const guest = createSequencer({ isHost: false, send: () => {}, apply: (m) => order.push(m.id) });
  const order = [];

  guest.receive({ id: "second", seq: 2 });
  assert.deepEqual(order, []);
  assert.equal(guest.waiting(), 1);

  guest.receive({ id: "first", seq: 1 });
  assert.deepEqual(order, ["first", "second"]);
  assert.equal(guest.waiting(), 0);
});

test("a long gap fills in one go, still in order", () => {
  const order = [];
  const guest = createSequencer({ isHost: false, send: () => {}, apply: (m) => order.push(m.id) });

  for (const n of [5, 3, 4, 2]) guest.receive({ id: `m${n}`, seq: n });
  assert.deepEqual(order, []);

  guest.receive({ id: "m1", seq: 1 });
  assert.deepEqual(order, ["m1", "m2", "m3", "m4", "m5"]);
});

// ---------------------------------------------------------------------------
// Who is allowed to sequence

test("only the host stamps - a guest claiming to is ignored", () => {
  // Two peers handing out numbers is two orders, which is the bug this
  // prevents wearing a disguise.
  const sent = [];
  const applied = [];
  const host = createSequencer({
    isHost: true, send: (m) => sent.push(m), apply: (m) => applied.push(m.id),
  });

  host.receive({ id: "forged", seq: 99 });
  assert.deepEqual(applied, []);
  assert.deepEqual(sent, []);

  host.receive({ id: "honest" });
  assert.deepEqual(applied, ["honest"]);
  assert.equal(sent[0].seq, 1);
});

test("a guest ignores an unstamped message", () => {
  // Guests never talk to each other about game state; anything unstamped
  // reaching one is not something it can place in the order.
  const applied = [];
  const guest = createSequencer({ isHost: false, send: () => {}, apply: (m) => applied.push(m.id) });
  guest.receive({ id: "loose" });
  assert.deepEqual(applied, []);
});

test("a guest's submission goes to the host and to nobody else", () => {
  const sent = [];
  const guest = createSequencer({
    isHost: false, send: (m, opts) => sent.push({ m, opts }), apply: () => {},
  });
  guest.submit({ id: "a" });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].opts, { to: 0 });
  assert.equal(sent[0].m.seq, undefined);
});

// ---------------------------------------------------------------------------
// The shape that made this necessary

test("two darts in flight at once cannot land in different orders", () => {
  // Two peers throw before either has heard the other - the exact race turn
  // discipline is supposed to prevent and does not always. Whichever reaches
  // the host first wins, and EVERY peer agrees about which that was.
  const net = mesh(4);
  net.peers[1].submit({ id: "left" });
  net.peers[3].submit({ id: "right" });

  // Deliver the two submissions to the host in the order they were sent, then
  // let the broadcasts settle.
  net.deliverOne();
  net.deliverOne();
  net.flush();

  const order = ids(net.applied[0]);
  assert.equal(order, "left,right");
  for (let slot = 1; slot < 4; slot++) assert.equal(ids(net.applied[slot]), order);
});

test("a 1v1 match is the same code with one guest", () => {
  // Remote doubles is where this is needed, but nothing about it is specific
  // to four - so the two-peer case has to come out identical rather than
  // needing a branch.
  const net = mesh(2);
  net.peers[1].submit({ id: "a" });
  net.flush();
  net.peers[0].submit({ id: "b" });
  net.flush();
  assert.equal(ids(net.applied[0]), ids(net.applied[1]));
  assert.equal(ids(net.applied[0]), "a,b");
});

test("order is decided by arrival at the host, not by who sent it", () => {
  // The host's own message is stamped the moment it is submitted, so a guest's
  // message still in flight is genuinely behind it - and both peers agree that
  // it is. Asserted because "the host went first" looks like favouritism until
  // you notice it is simply the message that reached the sequencer first.
  const net = mesh(2);
  net.peers[1].submit({ id: "guest-first-sent" });   // sent, still in flight
  net.peers[0].submit({ id: "host-arrived-first" }); // reaches the clock now
  net.flush();
  assert.equal(ids(net.applied[0]), "host-arrived-first,guest-first-sent");
  assert.equal(ids(net.applied[1]), ids(net.applied[0]));
});
