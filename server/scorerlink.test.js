// Tests for the camera-scorer connection layer.
//
// Run against a REAL WebSocket server, not a mock of one, because the things
// most likely to be wrong here are the things a mock would paper over: whether
// a close triggers a reconnect, whether an explicit disconnect suppresses one,
// and whether a frame this app has never seen is dropped loudly rather than
// scored as something plausible.
//
// The stub speaks the shape OpenDartboard's websocket_service.cpp actually
// emits - checked against its source, not its docs.

import test from "node:test";
import assert from "node:assert/strict";
// The bare specifier, not a path into node_modules: `ws` publishes an export
// map that provides named ESM exports, where reaching for index.js directly
// gets the raw CommonJS and no named exports at all. Already a server
// dependency, so this adds nothing to the image.
import { WebSocketServer } from "ws";

import { createScorerLink, scorerUrl } from "../scorerlink.js";
import { SegmentID } from "../granboard.js";

// A stub scorer. Returns the port it landed on so tests never fight over one.
function startStubScorer() {
  const wss = new WebSocketServer({ port: 0, path: "/scores" });
  const clients = new Set();
  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
  });
  return {
    port: () => wss.address().port,
    send: (obj) => { for (const c of clients) c.send(JSON.stringify(obj)); },
    sendRaw: (text) => { for (const c of clients) c.send(text); },
    dropAll: () => { for (const c of clients) c.close(); },
    connectionCount: () => clients.size,
    close: () => new Promise((r) => wss.close(r)),
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(25);
  }
  return false;
}

test("builds a URL from whatever a player is likely to type", () => {
  assert.equal(scorerUrl("192.168.1.50"), "ws://192.168.1.50:13520/scores");
  assert.equal(scorerUrl("192.168.1.50:9999"), "ws://192.168.1.50:9999/scores");
  // A full URL is passed through, which is the escape hatch for anything whose
  // port or path is not what this app assumed.
  assert.equal(scorerUrl("ws://box:1234/other"), "ws://box:1234/other");
  assert.equal(scorerUrl(""), "");
});

test("connects, and maps real OpenDartboard frames to segments", async () => {
  const stub = startStubScorer();
  const segments = [];
  const statuses = [];
  const link = createScorerLink({
    source: "opendartboard",
    onSegment: (s) => segments.push(s),
    onStatus: (s) => statuses.push(s.status),
  });

  link.connect(`127.0.0.1:${stub.port()}`);
  assert.ok(await until(() => link.connected), "never connected");
  assert.ok(statuses.includes("connected"));

  // Exactly the payload formatScoreJson builds.
  stub.send({ score: "T20", position: { x: 150, y: 200 }, confidence: 0.95, camera: 0, processing_time: 15, timestamp: 1 });
  stub.send({ score: "BULL", position: { x: 0, y: 0 }, confidence: 0.9, camera: 1, processing_time: 12, timestamp: 2 });
  stub.send({ score: "OUTER", position: { x: 5, y: 5 }, confidence: 0.9, camera: 1, processing_time: 12, timestamp: 3 });
  stub.send({ score: "END", position: { x: 0, y: 0 }, confidence: 1, camera: -1, processing_time: 0, timestamp: 4 });

  assert.ok(await until(() => segments.length === 4), `got ${segments.length}`);
  assert.equal(segments[0].value, 60);
  // The bull disagreement, end to end: BULL is the INNER bull to OpenDartboard.
  assert.equal(segments[1].value, 50);
  assert.equal(segments[2].value, 25);
  // A takeout is the end of a visit, which is what the board's button sends.
  assert.equal(segments[3].id, SegmentID.RESET_BUTTON);

  link.disconnect();
  await stub.close();
});

test("an unreadable frame is dropped, not invented", async () => {
  const stub = startStubScorer();
  const segments = [];
  const link = createScorerLink({ onSegment: (s) => segments.push(s) });

  link.connect(`127.0.0.1:${stub.port()}`);
  assert.ok(await until(() => link.connected));

  stub.sendRaw("not json at all");
  stub.send({ score: "WHAT" });
  stub.send({ nothing: true });
  await wait(200);
  assert.equal(segments.length, 0, "invented a dart from junk");

  // Still working afterwards - a bad frame must not poison the connection.
  stub.send({ score: "D20" });
  assert.ok(await until(() => segments.length === 1));
  assert.equal(segments[0].value, 40);

  link.disconnect();
  await stub.close();
});

test("reconnects when the scorer drops the connection", async () => {
  const stub = startStubScorer();
  const statuses = [];
  const link = createScorerLink({ onStatus: (s) => statuses.push(s.status) });

  link.connect(`127.0.0.1:${stub.port()}`);
  assert.ok(await until(() => link.connected), "never connected");

  // A Pi rebooting, or wifi dropping.
  stub.dropAll();
  assert.ok(await until(() => statuses.includes("retrying")), "never retried");
  assert.ok(await until(() => link.connected, 5000), "never came back");

  link.disconnect();
  await stub.close();
});

test("an explicit disconnect stays disconnected", async () => {
  const stub = startStubScorer();
  const statuses = [];
  const link = createScorerLink({ onStatus: (s) => statuses.push(s.status) });

  link.connect(`127.0.0.1:${stub.port()}`);
  assert.ok(await until(() => link.connected));

  link.disconnect();
  await wait(600); // longer than the first retry delay
  assert.equal(link.connected, false);
  // The distinction that matters: switching it off must not look like a drop.
  assert.equal(statuses.filter((s) => s === "retrying").length, 0);
  assert.equal(stub.connectionCount(), 0);

  await stub.close();
});

test("a scorer that is not there reports rather than throwing", async () => {
  const statuses = [];
  const link = createScorerLink({ onStatus: (s) => statuses.push(s.status) });
  // Nothing is listening on this port.
  link.connect("127.0.0.1:1");
  assert.ok(await until(() => statuses.includes("retrying"), 4000), statuses.join(","));
  assert.equal(link.connected, false);
  link.disconnect();
});

test("an empty address is refused with something actionable", () => {
  const seen = [];
  const link = createScorerLink({ onStatus: (s) => seen.push(s) });
  link.connect("");
  assert.equal(seen.at(-1).status, "error");
  assert.match(seen.at(-1).detail, /address/i);
});

test("an unknown source is a programming error", () => {
  assert.throws(() => createScorerLink({ source: "dartsmind" }), /Unknown scoring source/);
});
