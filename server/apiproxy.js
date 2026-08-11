// apiproxy.js - forward the accounts half of the app to ANOTHER deployment.
//
// WHY THIS EXISTS. The desktop build serves the front-end from a local port,
// because Web Bluetooth needs a secure context and `file://` is not one - so
// the Granboard only connects if the page came from http://127.0.0.1. But the
// player's account, statistics, friends and lobby live on aiodarts.com. Those
// two facts have to be joined up somewhere.
//
// There were two places to do it, and the choice matters more than it looks.
//
// LET THE PAGE CALL THE REMOTE ORIGIN DIRECTLY. Every /api/* request becomes
// cross-site, which means production must grow a CORS policy naming a
// localhost origin AND the session cookie must become SameSite=None; Secure to
// be sent at all. That is relaxing a live deployment's security to suit a local
// build, permanently, for everyone - and `accountstore.js` would need an API
// base URL threaded through its one `apiFetch` choke point, whose
// `credentials: "same-origin"` is currently exactly right.
//
// FORWARD FROM HERE. The page stays same-origin with its API, precisely as it
// is on the web. `accountstore.js` needs no change whatsoever - not one line -
// because a relative /api/ path and a same-origin cookie are still literally
// true. Production is untouched. The cost is this file.
//
// The second one, obviously. It is also the honest shape: the desktop app is a
// client of aiodarts.com, and a client is what this makes it.
//
// Unset UPSTREAM_ORIGIN and nothing here runs - every existing deployment,
// including production itself, is unaffected. It must stay that way: this
// server is the same file that serves aiodarts.com, and a proxy that switched
// itself on by accident there would forward the site to somewhere else.

import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { connect as tlsConnect } from "node:tls";
import { connect as netConnect } from "node:net";

// How long to reuse the upstream's ICE servers. Chosen against the upstream's
// own refresh policy rather than picked round: server.js mints Cloudflare
// credentials with a 24h TTL and re-mints with an hour to spare, so anything it
// hands out has at least an hour of life left. Half of that is comfortably
// inside the margin, and a credential only has to be valid at connection setup
// - once a relay allocation exists the match holds it.
const ICE_CACHE_MS = 30 * 60 * 1000;
let iceCache = { iceServers: null, expiresAt: 0 };

// Borrow the upstream deployment's ICE servers, TURN included.
//
// WHY NOT JUST CONFIGURE TURN HERE. Cloudflare Realtime does not issue
// long-lived credentials - you hold an API token and mint short-lived ones per
// session, which is precisely why server.js takes TURN_KEY_ID and
// TURN_KEY_API_TOKEN rather than a username and password. Putting that token in
// a desktop app ships a live production secret to every player's machine, where
// it can be read straight out of the package. Asking the upstream for the
// already-minted, already-short-lived credential gives the same relay with
// nothing to leak.
//
// Only the iceServers are taken. The upstream's `signalingUrl` is deliberately
// NOT adopted: it is the empty string meaning "same origin", which is true
// there and false here - it would resolve to 127.0.0.1 and every challenge code
// would be joinable only from this one machine.
export async function upstreamIceServers(origin) {
  if (iceCache.iceServers && Date.now() < iceCache.expiresAt) {
    return iceCache.iceServers;
  }
  try {
    const res = await fetch(new URL("/config.json", origin), {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const iceServers = Array.isArray(body?.iceServers) ? body.iceServers : null;
    if (!iceServers?.length) throw new Error("no iceServers in the response");
    iceCache = { iceServers, expiresAt: Date.now() + ICE_CACHE_MS };
    return iceServers;
  } catch (err) {
    // Never fatal, and deliberately keeps a stale value - the same judgement
    // cloudflareIceServers() makes for the same reason. Most players connect
    // directly and never touch a relay; the ones who do are no worse off than
    // they would have been with no TURN configured at all, and darts still
    // works either way.
    console.warn(`Upstream ICE servers unavailable: ${err.message}`);
    return iceCache.iceServers;
  }
}

// Headers that describe THIS hop and must not be copied to the next one.
// Forwarding `connection` or `transfer-encoding` produces a response the
// client cannot parse, and the failure looks like a corrupt body rather than
// like a proxy bug.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// Returns the upstream as a URL, or null when this whole feature is off.
// Anything unparseable is treated as off rather than as an error: a typo in an
// env var should not stop the app serving darts, which is the same judgement
// `ACCOUNTS=off` and the missing-mail-provider path already make.
export function upstreamOrigin() {
  const raw = (process.env.UPSTREAM_ORIGIN || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url;
  } catch {
    return null;
  }
}

// The session cookie is issued by a server reached over HTTPS, so it arrives
// carrying `Secure`. The browser is talking to us over http://127.0.0.1, and
// while Chromium does treat loopback as a trustworthy origin and will store a
// Secure cookie set over it, that is a browser-specific kindness rather than
// something to rely on. Strip it: this hop is loopback and cannot be observed
// by anything the flag would protect against.
//
// `Domain` is deliberately NOT handled, because `auth.js` never sets one - a
// host-only cookie is what we want, and it binds to 127.0.0.1 correctly on its
// own. If that ever changes, a Domain=aiodarts.com would be silently rejected
// by the browser here and sign-in would fail with no error anywhere.
function rewriteCookie(cookie) {
  return cookie.replace(/;\s*Secure\b/gi, "");
}

// Forward one /api/* request upstream and stream the answer back.
//
// Streamed rather than buffered because avatars go through this path
// (`/api/users/:id/avatar`), and a buffered proxy turns every image into
// resident memory for no reason.
export function proxyApiRequest(req, res, origin) {
  const isTls = origin.protocol === "https:";
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value;
  }

  // The upstream is a real deployment serving a real hostname - TLS SNI and
  // virtual hosting both key off this, and Render routes on it.
  headers.host = origin.host;

  // Ask for an unencoded body so we can pass bytes straight through. We are
  // proxying over loopback to a process on the same machine; the compression
  // would be undone and redone for nothing, and honouring `content-encoding`
  // correctly is a class of bug not worth owning here.
  delete headers["accept-encoding"];

  const upstream = (isTls ? httpsRequest : httpRequest)(
    {
      protocol: origin.protocol,
      hostname: origin.hostname,
      port: origin.port || (isTls ? 443 : 80),
      method: req.method,
      path: req.url,
      headers,
    },
    (up) => {
      const out = {};
      for (const [name, value] of Object.entries(up.headers)) {
        if (!HOP_BY_HOP.has(name.toLowerCase())) out[name] = value;
      }
      const cookies = up.headers["set-cookie"];
      if (cookies) out["set-cookie"] = cookies.map(rewriteCookie);
      res.writeHead(up.statusCode || 502, out);
      up.pipe(res);
    }
  );

  // A dead upstream must read as a dead upstream. Answering 502 with a JSON
  // body keeps `apiFetch`'s error path working - it parses JSON and shows the
  // message - rather than leaving the socket to hang until the fetch times out
  // with nothing to report.
  upstream.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({
        error: `Couldn't reach ${origin.host}: ${err.code || err.message}`,
      }));
    } else {
      res.destroy();
    }
  });

  req.pipe(upstream);
}

// Forward a WebSocket upgrade upstream by opening a socket and relaying bytes.
//
// Deliberately NOT done with the `ws` library acting as a client. A relay that
// parses frames has opinions about them - fragmentation, ping/pong, close
// codes, extensions - and every one of those is a chance for the two ends to
// disagree about a protocol neither of them is talking to us in. Copying bytes
// has no opinions. `server.js` already refuses any upgrade it does not
// recognise, so nothing reaches here by accident.
export function proxyUpgrade(req, socket, head, origin) {
  const isTls = origin.protocol === "https:";
  const port = origin.port || (isTls ? 443 : 80);

  const upstream = isTls
    ? tlsConnect({ host: origin.hostname, port, servername: origin.hostname })
    : netConnect({ host: origin.hostname, port });

  const onReady = () => {
    const lines = [`GET ${req.url} HTTP/1.1`, `Host: ${origin.host}`];
    for (const [name, value] of Object.entries(req.headers)) {
      // `host` is replaced above. Everything else - and it is the WebSocket
      // handshake headers that matter, Sec-WebSocket-Key chief among them,
      // plus the session Cookie the lobby authenticates with - goes as sent.
      if (name.toLowerCase() === "host") continue;
      for (const one of Array.isArray(value) ? value : [value]) {
        lines.push(`${name}: ${one}`);
      }
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");

    // Bytes the HTTP server had already read past the headers. Rare on an
    // upgrade, and dropping them corrupts the first frame when it happens.
    if (head && head.length) upstream.write(head);

    socket.pipe(upstream);
    upstream.pipe(socket);
  };

  upstream.on(isTls ? "secureConnect" : "connect", onReady);

  // Answer before hanging up, for exactly the reason server.js's gate does:
  // a bare destroy() on an upgrade sends no HTTP response, and what reaches
  // the browser is an unexplained socket error.
  upstream.on("error", () => {
    if (!socket.destroyed) {
      socket.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });
  socket.on("error", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
  socket.on("close", () => upstream.destroy());
}
