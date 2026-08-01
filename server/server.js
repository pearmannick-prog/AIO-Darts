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

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = resolve(process.env.PUBLIC_DIR || "./public");
const SIGNALING_PATH = process.env.SIGNALING_PATH || "/signaling";

// Where anything persistent will live. Nothing is written here yet - challenge
// rooms are deliberately in-memory - but the accounts/stat-tracking phase puts
// a SQLite file here, and SQLite is just a file, so this stays a
// single-container app. It's checked at startup rather than first-write so a
// misconfigured bind mount shows up in the logs immediately instead of the
// first time someone tries to register.
const DATA_DIR = resolve(process.env.DATA_DIR || "./data");

async function checkDataDir() {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await access(DATA_DIR, FS.W_OK);
    console.log(`  data dir     : ${DATA_DIR} (writable)`);
  } catch (err) {
    // Not fatal yet, since nothing depends on it - but say so loudly, because
    // it WILL be fatal once accounts land.
    console.warn(`  data dir     : ${DATA_DIR} NOT WRITABLE - ${err.code || err.message}`);
    console.warn("                 Nothing needs it yet, but persistent data will fail.");
    console.warn("                 Check the bind mount and its permissions.");
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
function buildConfig() {
  const stunUrls = (process.env.STUN_URLS || "stun:stun.l.google.com:19302")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

  const iceServers = stunUrls.length ? [{ urls: stunUrls }] : [];

  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(",").map((u) => u.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || undefined,
      credential: process.env.TURN_CREDENTIAL || undefined,
    });
  }

  return {
    // Empty string means "same origin" - the front-end fills it in itself.
    signalingUrl: process.env.SIGNALING_URL || "",
    signalingPath: SIGNALING_PATH,
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
    const urlPath = req.url === "/" ? "/index.html" : req.url;
    const bare = urlPath.split("?")[0];

    // Cheap liveness probe for Docker/Unraid healthchecks - no filesystem or
    // dependency access, so it answers even if something else is wrong.
    if (bare === "/healthz") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, clients: wss.clients.size }));
      return;
    }

    // Runtime config is generated per-request from env vars rather than
    // written to a file at container start, so changing an env var only
    // needs a restart, not a rebuild - and there's no entrypoint script.
    if (bare === "/config.json") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(buildConfig()));
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
const wss = new WebSocketServer({ server: httpServer, path: SIGNALING_PATH });
const rooms = new Map(); // code -> Set<WebSocket>

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

wss.on("connection", (ws) => {
  let joinedCode = null;

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
        room = new Set();
        rooms.set(code, room);
      }

      if (room.size >= 2) {
        send(ws, { type: "room-full" });
        return;
      }

      const isHost = room.size === 0;
      room.add(ws);
      joinedCode = code;

      send(ws, { type: "joined", role: isHost ? "host" : "guest" });

      if (!isHost) {
        for (const peer of room) {
          if (peer !== ws) send(peer, { type: "peer-joined" });
        }
      }
      return;
    }

    // Anything else (offer/answer/ice) is relayed to the other socket in the
    // same room - this server doesn't need to understand it.
    if (joinedCode) {
      const room = rooms.get(joinedCode);
      if (room) {
        for (const peer of room) {
          if (peer !== ws) send(peer, msg);
        }
      }
    }
  });

  ws.on("close", () => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room) return;
    room.delete(ws);
    for (const peer of room) send(peer, { type: "peer-left" });
    if (room.size === 0) rooms.delete(joinedCode);
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

httpServer.listen(PORT, async () => {
  console.log(`AIO Darts listening on port ${PORT}`);
  console.log(`  static files : ${PUBLIC_DIR}`);
  console.log(`  signaling    : ${SIGNALING_PATH} (same port)`);
  await loadBakedVersion();
  const { sha, source } = buildVersion();
  // Printed at startup so the logs answer "which build is this?" without
  // anyone having to load the page - the first thing worth knowing when a
  // deploy looks like it didn't take.
  console.log(`  build        : ${sha === "dev" ? "dev (unknown commit)" : sha} (from ${source})`);
  await checkDataDir();
});
