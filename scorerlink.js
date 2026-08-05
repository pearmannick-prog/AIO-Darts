// scorerlink.js - a WebSocket connection to an automatic camera scorer.
//
// The transport half of what dartnotation.js parses. A camera scorer sits on
// the network and streams a segment name every time it sees a dart land; this
// connects to one, reads its frames, and hands the resulting segments to
// boardlink.js - which routes them exactly like a Bluetooth board's, so an
// online match takes them while it is live and local play takes them otherwise.
// Nothing downstream can tell a camera from a Granboard, which is the point.
//
// NO DOM IN HERE. It is a socket, a parser and two callbacks, which makes it
// testable against a stub server rather than only against hardware nobody here
// has - and that is the difference between this being verified and being hoped
// for. The UI lives in game.js.
//
// WHY WEBSOCKET AND NOT fetch. Measured from the live HTTPS site: a WebSocket
// to a local address is not subject to CORS and needs no permission for
// loopback, where fetch is gated by BOTH a Local Network Access grant and the
// server sending Access-Control-Allow-Origin. A scorer on a Pi is on the LAN,
// which prompts once per origin either way - but the WebSocket cannot be broken
// by the scorer's CORS configuration, and a REST fallback would reintroduce a
// problem this avoids.

import { segmentFrom, SOURCES } from "./dartnotation.js";

// Reconnection is expected rather than exceptional: a scorer is a Raspberry Pi
// on a home network, so it reboots, drops off wifi, and gets unplugged. Backing
// off avoids hammering something that is genuinely gone, and the ceiling keeps
// it responsive when it comes back.
const RETRY_START_MS = 1000;
const RETRY_MAX_MS = 15000;

// Builds the URL from what a player would actually type - "192.168.1.50",
// "192.168.1.50:13520", or a full ws:// URL. Guessing correctly here is worth
// more than it looks: the alternative is a text box that demands a scheme, a
// port and a path, and gets one of them wrong every time.
export function scorerUrl(input, source = "opendartboard") {
  const raw = String(input || "").trim();
  if (!raw) return "";
  if (/^wss?:\/\//i.test(raw)) return raw;

  const { defaultPort, path } = SOURCES[source] ?? {};
  const hasPort = /:\d+$/.test(raw);
  const host = raw.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return `ws://${host}${hasPort ? "" : `:${defaultPort}`}${path}`;
}

// One connection. Created rather than a singleton so a test can run several,
// and so the caller owns the lifetime rather than this module owning a global.
//
//   onSegment(segment)  - a dart, already mapped. RESET_BUTTON arrives here too
//                         for scorers that report a takeout, and means "the
//                         visit is over" exactly as the board's button does.
//   onStatus(state)     - {status, detail}. Purely for the UI; nothing in here
//                         behaves differently because of it.
//   WebSocketImpl       - injectable so tests can run without a browser. Node
//                         has a global WebSocket, so the default works there
//                         too, but being explicit keeps the test honest.
export function createScorerLink({
  source = "opendartboard",
  onSegment = () => {},
  onStatus = () => {},
  WebSocketImpl = typeof WebSocket !== "undefined" ? WebSocket : null,
} = {}) {
  if (!SOURCES[source]) throw new Error(`Unknown scoring source: ${source}`);

  let socket = null;
  let retryTimer = null;
  let retryDelay = RETRY_START_MS;
  let url = "";
  // Distinguishes "the socket closed" from "the player asked it to close",
  // which is the difference between reconnecting and staying shut.
  let wanted = false;

  function report(status, detail = "") {
    onStatus({ status, detail, url });
  }

  function scheduleRetry() {
    if (!wanted) return;
    clearTimeout(retryTimer);
    report("retrying", `reconnecting in ${Math.round(retryDelay / 1000)}s`);
    retryTimer = setTimeout(open, retryDelay);
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  }

  function open() {
    if (!wanted || !url) return;
    if (!WebSocketImpl) {
      report("error", "This browser has no WebSocket support.");
      return;
    }

    try {
      socket = new WebSocketImpl(url);
    } catch (err) {
      // A malformed URL throws synchronously rather than firing onerror, so
      // this path is reachable and would otherwise be a silent no-op.
      report("error", err.message);
      scheduleRetry();
      return;
    }

    report("connecting");

    socket.onopen = () => {
      // Only reset the backoff once actually connected. Resetting on the
      // ATTEMPT would turn a scorer that accepts and immediately drops the
      // connection into a tight loop.
      retryDelay = RETRY_START_MS;
      report("connected");
    };

    socket.onmessage = (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        // Not JSON. Nothing to do with it, and not worth tearing the
        // connection down over.
        return;
      }

      const segment = segmentFrom(source, frame);
      if (!segment) {
        // A frame this doesn't understand is a gap in the vocabulary, not a
        // dart to invent. Logged loudly rather than dropped silently, because
        // the symptom otherwise is darts that just don't count.
        console.warn("Unrecognised scorer frame:", event.data);
        return;
      }
      onSegment(segment);
    };

    socket.onerror = () => {
      // Deliberately quiet: onclose always follows, and reporting both makes
      // an ordinary reconnection look like two failures.
    };

    socket.onclose = () => {
      socket = null;
      if (!wanted) {
        report("disconnected");
        return;
      }
      scheduleRetry();
    };
  }

  return {
    connect(target) {
      const next = scorerUrl(target, source);
      if (!next) {
        report("error", "Enter the scorer's address, e.g. 192.168.1.50");
        return;
      }
      this.disconnect();
      url = next;
      wanted = true;
      retryDelay = RETRY_START_MS;
      open();
    },

    disconnect() {
      wanted = false;
      clearTimeout(retryTimer);
      retryTimer = null;
      if (socket) {
        // Cleared first: close() fires onclose, and without this the handler
        // would schedule a reconnection for something just switched off.
        const s = socket;
        socket = null;
        s.onclose = null;
        s.onmessage = null;
        try { s.close(); } catch { /* already closing */ }
      }
      report("disconnected");
    },

    get connected() {
      return Boolean(socket && socket.readyState === 1);
    },

    get target() {
      return url;
    },
  };
}
