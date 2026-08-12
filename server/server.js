// server.js - AIO Darts single-port server.
//
// Serves BOTH the static front-end and the signaling WebSocket from the same
// HTTP server, on the same port. That's deliberate, and it's what makes this
// deployable behind any reverse proxy with no special routing:
//
//   * No second hostname, DNS record, or TLS cert for signaling.
//   * No path-rewriting rules - the proxy just forwards the site as it
//     already does, and the WebSocket rides along on the same origin.
//   * No mixed-content problem: the page is https, so the socket is wss,
//     automatically, because it's literally the same origin.
//   * Nothing for a player to configure - the front-end derives the socket
//     URL from window.location (see online.js).
//
// The only thing the proxy must do is forward WebSocket upgrades (in NGINX
// Proxy Manager that's the "Websockets Support" toggle on the proxy host).
//
// What the signaling half actually does: it does NOT see game data. Its only
// job is to help two browsers find each other and exchange the handful of
// WebRTC handshake messages (offer/answer/ICE) needed to open a direct
// peer-to-peer connection. Once that's up, all gameplay traffic flows
// browser-to-browser and this server is out of the loop for that match.
//
// Rooms are an in-memory Map keyed by a short challenge code, holding up to 2
// sockets. Nothing is persisted - if this process restarts, in-progress
// challenge codes are gone. That's fine: a code only needs to live for the
// few seconds it takes two players to connect.

import { createServer } from "node:http";
import { readFile, mkdir, access } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";
import { openDatabase } from "./db.js";
import { purgeExpiredSessions } from "./auth.js";
import { handleApiRequest } from "./api.js";
import { createLobby } from "./lobby.js";
import { guardRequest, isAllowed, gateEnabled } from "./gate.js";
import {
  upstreamOrigin,
  proxyApiRequest,
  proxyUpgrade,
  upstreamIceServers,
} from "./apiproxy.js";

// When set, the accounts half of the app is not served from here at all - it
// is forwarded to another deployment. This is how the desktop build signs in
// to a real aiodarts.com account while serving the front-end from a local
// port; see apiproxy.js for why forwarding beats letting the page call the
// remote origin directly. Unset - which is every server deployment, including
// production - and nothing changes.
const UPSTREAM = upstreamOrigin();

const PORT = Number(process.env.PORT || 8080);
// Which interfaces to accept connections on. Unset means all of them, which is
// what a container wants and must stay the default - binding a Docker image to
// loopback makes it unreachable from outside itself, which presents as a
// deployment that starts perfectly and answers nothing.
//
// The desktop build sets this to 127.0.0.1, and needs to. There the server
// exists solely to give the app's own window a secure context, and anything
// else on the network reaching it would find this machine offering a signaling
// relay and - with UPSTREAM_ORIGIN set - an unauthenticated forwarder to
// somebody else's site. Neither is a thing to leave open on a laptop in a pub.
const HOST = process.env.HOST || undefined;
const PUBLIC_DIR = resolve(process.env.PUBLIC_DIR || "./public");
const SIGNALING_PATH = process.env.SIGNALING_PATH || "/signaling";
// The lobby's own socket. Separate from signaling on purpose: the relay is
// deliberately dumb and worth keeping that way, so the stateful half lives on
// its own path rather than being mixed into the code that must not break
// mid-match. Same server, same port, same origin - see the note at the top.
const LOBBY_PATH = process.env.LOBBY_PATH || "/lobby";

// Where persistent data lives: the SQLite database holding accounts, match
// history and statistics. SQLite is just a file, so this stays a
// single-container app with no second service to run.
//
// IMPORTANT: on a host with an ephemeral filesystem - Render's free tier being
// the obvious one - this directory is wiped on every deploy, which silently
// deletes every account. Persistence is a deliberate hosting decision: attach a
// disk and point DATA_DIR at it. See render.yaml.
const DATA_DIR = resolve(process.env.DATA_DIR || "./data");

// ACCOUNTS=off turns the accounts half of the app off DELIBERATELY, without
// touching the database or the disk.
//
// This exists because "no persistent disk" and "no accounts" are not the same
// state, and the difference is dangerous. On an ephemeral filesystem the
// database opens perfectly well - so the app offers sign-up, takes people's
// passwords, records their matches, and then deletes all of it on the next
// deploy. That is strictly worse than not offering accounts at all: it loses
// data that someone believed was saved.
//
// So the honest deployment of this app on a host with no disk is to say so.
// Guests are unaffected - the front-end already hides the account tab and the
// header chip when there is no accounts API behind them, which is the same
// path the Android APK takes.
//
// Unset is the default and means "try": that keeps every existing deployment
// behaving exactly as it did.
const ACCOUNTS_DISABLED = /^(off|0|false|no|disabled)$/i.test(
  (process.env.ACCOUNTS || "").trim()
);

// Whether the accounts half of the app is available. Gameplay does not depend
// on it - local and online darts are pure browser code and a signaling relay -
// so a database that won't open must NOT take the whole server down with it.
//
// The alternative, exiting at startup, is tempting because it's loud. But it
// would mean a bad bind mount stops people playing darts, and on a platform
// that restarts failed containers it turns into a crash loop that serves
// nothing at all. Instead: log it loudly, keep serving the game, and have
// /api/* say plainly that accounts are unavailable. /healthz reports it too, so
// it is still visible to monitoring rather than only to whoever reads the logs.
let accountsEnabled = false;
// The lobby needs accounts (it is a list of who is around, and an anonymous
// entry would be neither identifiable nor challengeable), so it only exists if
// the database opened. Invite codes carry on regardless.
let lobby = null;

async function initDatabase() {
  // Switched off on purpose. Logged as a normal line rather than a warning:
  // the failure path below shouts about bind mounts and permissions, and an
  // operator who chose this should not be told to go and investigate a problem
  // they don't have.
  if (ACCOUNTS_DISABLED) {
    accountsEnabled = false;
    console.log("  accounts     : disabled by ACCOUNTS=off (no database opened)");
    return;
  }

  try {
    await mkdir(DATA_DIR, { recursive: true });
    await access(DATA_DIR, FS.W_OK);
    await openDatabase(DATA_DIR);
    accountsEnabled = true;
    console.log(`  data dir     : ${DATA_DIR} (writable)`);
    console.log("  accounts     : enabled");
  } catch (err) {
    accountsEnabled = false;
    console.warn(`  data dir     : ${DATA_DIR} UNUSABLE - ${err.code || err.message}`);
    console.warn("  accounts     : DISABLED - sign-in, history and stats will not work.");
    console.warn("                 Darts still works; check the bind mount and its permissions.");
  }
}

// ---------------------------------------------------------------------------
// Runtime config served to the front-end
// ---------------------------------------------------------------------------
// Handed to the browser at /config.json. Everything here is optional - the
// defaults are what a normal same-origin deployment wants, so an operator can
// set nothing at all and it just works.
//
//   SIGNALING_URL - only for the unusual case of pointing players at a
//                   signaling server somewhere else entirely. Leave unset and
//                   the front-end uses this same origin, which is what you
//                   want.
//   STUN_URLS     - comma-separated STUN servers. STUN lets each browser
//                   discover its own public address so the two can try to
//                   connect directly. Defaults to Google's public one.
//   TURN_URL      - optional relay for players whose networks refuse direct
//                   P2P (symmetric NAT, strict corporate firewalls - roughly
//                   10-20% of connections). TURN relays the traffic instead,
//                   so it always works but costs bandwidth on whoever hosts
//                   it. For scoring alone that's trivial (a few bytes per
//                   throw) - but players can also switch on camera and mic,
//                   and a relayed match with video is a video call's worth of
//                   traffic (~0.5-1 Mbit/s each way). See the README before
//                   enabling TURN on a metered connection.
//                   Needs TURN_USERNAME and TURN_CREDENTIAL too.
//
//   TURN_KEY_ID + TURN_KEY_API_TOKEN
//                 - Cloudflare Realtime TURN instead of the static pair above.
//                   Cloudflare does NOT issue long-lived credentials: you hold
//                   a key and an API token, and mint short-lived ones per
//                   session. So the API token stays here, on the server, and
//                   only the minted credential is ever sent to a browser -
//                   which is the entire point of the design and why it cannot
//                   be expressed as TURN_USERNAME/TURN_CREDENTIAL.

// Cloudflare's minted ICE servers, cached. Refreshed before expiry rather than
// fetched per request: /config.json is hit on every page load, and a round trip
// to Cloudflare on each one would add latency to startup and invite rate
// limiting for a value that is good for hours.
const TURN_TTL_SECONDS = 86_400;      // what we ask Cloudflare for
const TURN_REFRESH_MARGIN_MS = 3_600_000; // re-mint with an hour to spare
let turnCache = { iceServers: null, expiresAt: 0 };

async function cloudflareIceServers() {
  const keyId = process.env.TURN_KEY_ID;
  const token = process.env.TURN_KEY_API_TOKEN;
  if (!keyId || !token) return null;

  if (turnCache.iceServers && Date.now() < turnCache.expiresAt) {
    return turnCache.iceServers;
  }

  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
        signal: AbortSignal.timeout(5000),
      }
    );

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const iceServers = body?.iceServers
      ? [].concat(body.iceServers)
      : null;
    if (!iceServers?.length) throw new Error("no iceServers in response");

    turnCache = {
      iceServers,
      expiresAt: Date.now() + TURN_TTL_SECONDS * 1000 - TURN_REFRESH_MARGIN_MS,
    };
    return iceServers;
  } catch (err) {
    // Never fatal. A TURN outage must not stop the app serving darts: most
    // players connect directly and never need a relay, and the ones who do get
    // the same failure they would have had with no TURN configured at all.
    // Deliberately does not clear a cached value - a stale credential that
    // still has hours left is far better than none.
    console.warn(`TURN credentials could not be minted: ${err.message}`);
    return turnCache.iceServers;
  }
}

async function buildConfig() {
  const stunUrls = (process.env.STUN_URLS || "stun:stun.l.google.com:19302")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

  // With an upstream, that deployment's relay configuration is the one this
  // build should use - it is the deployment we are a client of. Its servers are
  // fetched below; the default Google STUN is then not added, because it is a
  // fallback for having nothing rather than something to stack on top. An
  // operator who set STUN_URLS explicitly meant it, so that still applies.
  const upstreamIce = UPSTREAM ? await upstreamIceServers(UPSTREAM) : null;
  const stunConfigured = Boolean(process.env.STUN_URLS);

  const iceServers =
    stunUrls.length && (stunConfigured || !upstreamIce?.length)
      ? [{ urls: stunUrls }]
      : [];

  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(",").map((u) => u.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || undefined,
      credential: process.env.TURN_CREDENTIAL || undefined,
    });
  }

  // Cloudflare's minted servers come with their own urls, username and
  // credential, so they are appended whole rather than merged with anything.
  // Both can be configured at once; a browser simply tries all of them.
  const cloudflare = await cloudflareIceServers();
  if (cloudflare) iceServers.push(...cloudflare);

  // Appended last, and whole, for the same reason Cloudflare's are: they arrive
  // with their own urls, username and credential. A browser simply tries
  // everything it is given.
  if (upstreamIce?.length) iceServers.push(...upstreamIce);

  return {
    // Empty string means "same origin" - the front-end fills it in itself.
    signalingUrl: process.env.SIGNALING_URL || "",
    signalingPath: SIGNALING_PATH,
    // Sent so the front-end never hard-codes it, the same way it doesn't
    // hard-code the signaling path.
    lobbyPath: LOBBY_PATH,
    iceServers,
  };
}

// ---------------------------------------------------------------------------
// Which build is actually running
// ---------------------------------------------------------------------------
// Served at /version.json, and the single most useful thing here when someone
// reports "I changed it and nothing happened" - the answer is nearly always
// that they're looking at an older build than they think.
//
// It used to be a plain file baked in by the Dockerfile, which works when the
// image is built by this repo's GitHub Actions workflow, because that passes
// the real commit SHA as a build arg. Nothing else does. A platform that
// builds the Dockerfile itself - Render, most obviously - gets the ARG's "dev"
// default, so the footer read "build dev" no matter what was deployed and the
// one mechanism for answering that question was blind on the deployment it was
// needed for most.
//
// So the file is now only one of the sources, and the first REAL answer wins:
//
//   1. The baked file, when it holds a genuine SHA. It's the strongest
//      evidence there is - it's a property of the image itself.
//   2. GIT_SHA, for an operator wiring this up by hand.
//   3. RENDER_GIT_COMMIT, which Render sets automatically at both build and
//      run time. Other platforms expose their own; add them here.
//
// Read once at startup rather than per request: the image cannot change under
// a running process, so re-reading it would be a filesystem hit per page load
// to learn something that is decided before the server ever starts.
const STARTED_AT = new Date().toISOString();
let bakedVersion = null;

async function loadBakedVersion() {
  try {
    bakedVersion = JSON.parse(await readFile(join(PUBLIC_DIR, "version.json"), "utf8"));
  } catch {
    // Absent when running from a source checkout, which is not an error.
    bakedVersion = null;
  }
}

function buildVersion() {
  const baked = bakedVersion?.sha && bakedVersion.sha !== "dev" ? bakedVersion : null;
  const sha = baked?.sha || process.env.GIT_SHA || process.env.RENDER_GIT_COMMIT || "dev";

  // The image knows when it was built; env vars don't carry a build time. On a
  // platform that redeploys by starting a new container, process start is the
  // deploy time, which is the date you actually want to compare against.
  const builtAt = baked?.builtAt && baked.builtAt !== "unknown" ? baked.builtAt : STARTED_AT;

  return {
    sha,
    builtAt,
    // Not used by the footer - it's here for whoever is diagnosing why the SHA
    // says what it says.
    source: baked ? "image" : sha !== "dev" ? "env" : "unknown",
    branch: process.env.RENDER_GIT_BRANCH || undefined,
  };
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

// Resolves a request path to a real file inside PUBLIC_DIR, or null if it
// escapes the directory (path traversal) - never trust a URL path directly.
function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  const candidate = resolve(join(PUBLIC_DIR, decoded));
  if (candidate !== PUBLIC_DIR && !candidate.startsWith(PUBLIC_DIR + sep)) {
    return null;
  }
  return candidate;
}

async function serveFile(res, filePath) {
  const body = await readFile(filePath);
  const type = MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    // The app is small and updates roll out continuously via :latest images,
    // so revalidate every time rather than serving a stale cached build.
    "Cache-Control": "no-cache",
  });
  res.end(body);
}

const httpServer = createServer(async (req, res) => {
  try {
    // The optional shared-password wall for test deployments. Does nothing
    // unless SITE_PASSWORD is set, and never gates /healthz - see gate.js.
    if (guardRequest(req, res)) return;

    const urlPath = req.url === "/" ? "/index.html" : req.url;
    const bare = urlPath.split("?")[0];

    // Cheap liveness probe for Docker/Unraid healthchecks - no filesystem or
    // dependency access, so it answers even if something else is wrong.
    if (bare === "/healthz") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      // `accounts` is reported but does NOT make ok false: the probe answers
      // "can this serve darts?", and it can. A monitoring system that cares
      // about accounts can watch this field specifically.
      res.end(JSON.stringify({
        ok: true,
        rooms: rooms.size,
        clients: wss.clients.size,
        accounts: accountsEnabled,
        lobby: lobby ? lobby.count() : null,
      }));
      return;
    }

    // The API, before static serving - /api/* is never a file. handleApiRequest
    // returns false for anything that isn't its business, so an unknown path
    // still falls through to the front-end exactly as it did before.
    if (bare.startsWith("/api/")) {
      // Forwarding comes FIRST, and before the accounts check in particular:
      // when there is an upstream, this server has no database of its own and
      // `accountsEnabled` is correctly false, so checking it first would 503
      // every request that was about to be answered perfectly well by someone
      // else.
      if (UPSTREAM) {
        proxyApiRequest(req, res, UPSTREAM);
        return;
      }
      if (!accountsEnabled) {
        res.writeHead(503, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({
          error: "Accounts are unavailable on this server - the database could not be opened.",
        }));
        return;
      }
      if (await handleApiRequest(req, res)) return;
    }

    // Runtime config is generated per-request from env vars rather than
    // written to a file at container start, so changing an env var only
    // needs a restart, not a rebuild - and there's no entrypoint script.
    if (bare === "/config.json") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(await buildConfig()));
      return;
    }

    // Intercepted for the same reason as /config.json, and it must come BEFORE
    // static serving or the baked file would shadow this and keep reporting
    // "dev" on any platform that builds the Dockerfile itself.
    if (bare === "/version.json") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(buildVersion()));
      return;
    }

    const filePath = safePath(urlPath);
    if (!filePath) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    try {
      await serveFile(res, filePath);
    } catch {
      // Directory or unknown path - fall back to index.html so the app still
      // loads, rather than a bare 404 page.
      try {
        await serveFile(res, join(PUBLIC_DIR, "index.html"));
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
      }
    }
  } catch (err) {
    console.error("Request failed:", err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Server error");
  }
});

// ---------------------------------------------------------------------------
// Signaling WebSocket (same server, same port, scoped to SIGNALING_PATH)
// ---------------------------------------------------------------------------
// `noServer` plus the upgrade router below, rather than { server, path }.
//
// A WebSocketServer bound with { server, path } installs its own 'upgrade'
// listener and destroys any upgrade whose path it does not recognise. With two
// of them - signaling and the lobby - on one HTTP server, whichever attached
// first hung up on the other's connections, and it did so silently: the browser
// saw a bare WebSocket error and the server logged nothing at all. Routing
// upgrades in one place is the documented way to share a port.
const wss = new WebSocketServer({ noServer: true });
const rooms = new Map(); // code -> { size, slots: Map<slot, WebSocket> }

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// A signaling room is a Map of slot -> socket rather than a Set, and its size
// is fixed by whoever opens it.
//
// TWO IS NO LONGER THE ONLY ANSWER. Local doubles is still two browsers - two
// people share a board, so their end is one peer - but REMOTE doubles is four
// people on four setups, and that needs four sockets in the room. See
// docs/team-play.md section 0.
//
// The slot is the point. With two peers "relay to everyone else" and "relay to
// the other one" are the same sentence, so the old code broadcast. With four
// they are not: an offer meant for one peer would arrive at all three, and
// each would answer it. So a message may name its recipient, and only a
// message that does not is broadcast - which is what keeps the existing 1v1
// path working unchanged.
const DEFAULT_ROOM_SIZE = 2;
const MAX_ROOM_SIZE = 4;

wss.on("connection", (ws) => {
  let joinedCode = null;
  let mySlot = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed messages
    }

    if (msg.type === "join") {
      const code = String(msg.code || "").toUpperCase().slice(0, 12);
      if (!code) return;

      let room = rooms.get(code);
      if (!room) {
        // Only the FIRST joiner sizes the room, because only they know what
        // kind of match this is. Everyone after takes the room as they find
        // it: a guest cannot widen a 1v1 by asking, and cannot narrow a
        // four-way by arriving with an older build that never sends a size.
        const wanted = Number(msg.size);
        const size = Number.isInteger(wanted) && wanted >= 2 && wanted <= MAX_ROOM_SIZE
          ? wanted
          : DEFAULT_ROOM_SIZE;
        room = { size, slots: new Map() };
        rooms.set(code, room);
      }

      if (room.slots.size >= room.size) {
        send(ws, { type: "room-full" });
        return;
      }

      // The lowest free slot, so a player who drops and rejoins takes their
      // own seat back rather than pushing everyone along.
      let slot = 0;
      while (room.slots.has(slot)) slot += 1;
      room.slots.set(slot, ws);
      joinedCode = code;
      mySlot = slot;

      const isHost = slot === 0;
      send(ws, {
        type: "joined",
        role: isHost ? "host" : "guest",
        slot,
        size: room.size,
        // Who is already here. A four-way needs this: the arriving peer has to
        // open a connection to each of them, and without it would have to
        // guess how many to expect.
        peers: [...room.slots.keys()].filter((s) => s !== slot),
      });

      for (const [peerSlot, peer] of room.slots) {
        if (peerSlot !== slot) send(peer, { type: "peer-joined", slot });
      }
      return;
    }

    // Anything else (offer/answer/ice) is relayed - this server still does not
    // need to understand any of it. `to` names a slot when the sender means
    // one peer in particular; without it the message goes to everyone else,
    // which is what the 1v1 path has always done and still does.
    if (joinedCode) {
      const room = rooms.get(joinedCode);
      if (room) {
        const stamped = mySlot === null ? msg : { ...msg, from: mySlot };
        // typeof, not Number(). `Number(null)` and `Number("")` are both 0,
        // which IS an integer - so a sender writing `to: peerSlot ?? null` to
        // mean "everyone", the natural shape for the four-way client this was
        // built for, would have had every broadcast delivered privately to slot
        // 0 instead. Unreachable from today's webrtc.js, which sends no `to` at
        // all and so lands in the else branch by absence rather than by test.
        const to = typeof msg.to === "number" ? msg.to : null;
        if (Number.isInteger(to)) {
          const peer = room.slots.get(to);
          if (peer && peer !== ws) send(peer, stamped);
        } else {
          for (const [peerSlot, peer] of room.slots) {
            if (peerSlot !== mySlot) send(peer, stamped);
          }
        }
      }
    }
  });

  ws.on("close", () => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room) return;
    room.slots.delete(mySlot);
    // Which slot left, because with four peers "somebody left" is not enough
    // to know whose connection to tear down. The 1v1 path ignores it exactly
    // as it always has.
    for (const peer of room.slots.values()) send(peer, { type: "peer-left", slot: mySlot });
    if (room.slots.size === 0) rooms.delete(joinedCode);
  });
});

// Some proxies drop connections they think are idle. A challenge socket sits
// quiet between throws, so ping every 30s to keep it demonstrably alive.
const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.ping();
  }
}, 30000);
wss.on("close", () => clearInterval(heartbeat));

// The single upgrade listener. Anything that isn't a socket we serve is
// destroyed explicitly - the default with noServer is to leave it hanging.
httpServer.on("upgrade", (req, socket, head) => {
  const path = (req.url || "").split("?")[0];

  // Gating pages but not sockets would leave signaling and the lobby open to
  // anyone who skipped the front door.
  //
  // ANSWER, then hang up. A bare socket.destroy() here sends no HTTP response
  // at all, and a proxy in front of this - Render's, in our case - reports that
  // to the browser as a 502 Bad Gateway. The player is then told the signaling
  // server could not be reached, when the server is running perfectly and has
  // simply refused them for want of the test build's password. It cost hours,
  // and it presents as a phone-only fault: service workers do not intercept
  // WebSocket handshakes, so a phone running the app from cache never makes the
  // ordinary request that would refresh the gate cookie, while a desktop that
  // just loaded the page always has one.
  //
  // The browser still only surfaces this to JavaScript as a generic socket
  // error - the status is not exposed to the WebSocket API - but it is now in
  // the network panel, in the server's reach, and no longer a lie.
  if (!isAllowed(req)) {
    socket.write(
      "HTTP/1.1 401 Unauthorized\r\n" +
      'WWW-Authenticate: Basic realm="AIO Darts test build", charset="UTF-8"\r\n' +
      "Content-Length: 0\r\n" +
      "Connection: close\r\n\r\n"
    );
    socket.destroy();
    return;
  }

  if (path === SIGNALING_PATH) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    return;
  }

  // The lobby is presence, challenges and chat, all of which are keyed to an
  // account - so where the accounts are is where the lobby has to be. Same
  // ordering argument as /api/*: with an upstream there is no local `lobby` to
  // hand this to, and falling through would destroy the socket.
  if (UPSTREAM && path === LOBBY_PATH) {
    proxyUpgrade(req, socket, head, UPSTREAM);
    return;
  }

  if (lobby && path === LOBBY_PATH) {
    lobby.handleUpgrade(req, socket, head);
    return;
  }

  socket.destroy();
});

httpServer.listen(PORT, HOST, async () => {
  console.log(`AIO Darts listening on port ${PORT}`);
  console.log(`  static files : ${PUBLIC_DIR}`);
  console.log(`  signaling    : ${SIGNALING_PATH} (same port)`);
  // Said out loud for the same reason the Litestream line is: forwarding
  // accounts somewhere else is invisible from the outside - the app looks
  // completely normal either way - and "which database am I signing in to"
  // is the first thing worth knowing when it looks like it didn't take.
  if (UPSTREAM) {
    console.log(`  accounts     : forwarded to ${UPSTREAM.origin} (/api/* and ${LOBBY_PATH})`);
  }
  await loadBakedVersion();
  const { sha, source } = buildVersion();
  // Printed at startup so the logs answer "which build is this?" without
  // anyone having to load the page - the first thing worth knowing when a
  // deploy looks like it didn't take.
  console.log(`  build        : ${sha === "dev" ? "dev (unknown commit)" : sha} (from ${source})`);
  if (gateEnabled) {
    console.log("  site gate    : ON (SITE_PASSWORD is set - this deployment is private)");
  }

  await initDatabase();

  // Mounted after the database, because it authenticates every connection
  // against the sessions table.
  if (accountsEnabled) {
    lobby = createLobby();
    console.log(`  lobby        : ${LOBBY_PATH} (same port)`);
  } else {
    console.log("  lobby        : disabled (needs accounts)");
  }

  // Expired sessions are already ignored when resolving a request, so this is
  // housekeeping to stop the table growing forever rather than a security
  // measure. Hourly is far more often than it needs to be and costs nothing.
  if (accountsEnabled) {
    setInterval(() => {
      try {
        purgeExpiredSessions();
      } catch (err) {
        console.warn("Session purge failed:", err.message);
      }
    }, 3600_000).unref();
  }
});
