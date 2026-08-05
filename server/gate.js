// gate.js - an optional password wall in front of the whole site.
//
// For test deployments. A dev build sitting on a guessable URL is readable by
// anyone who finds it, and this one has real accounts and real statistics in
// it. This puts a single shared password in front of everything.
//
// OFF UNLESS ASKED FOR. With SITE_PASSWORD unset - which is how production runs
// - this module does nothing at all and every request passes straight through.
// Setting it on one deployment cannot affect another.
//
// WHAT THIS IS NOT: it is not authentication, and it is not a substitute for
// one. It is one shared password that keeps a work-in-progress off the open
// internet, over HTTPS. Player accounts are still the thing that identifies
// anybody.
//
// Two details that matter more than they look:
//
//   /healthz is always allowed through. Render polls it to decide whether the
//   service is alive, and a health check that gets a 401 marks the deployment
//   as failed - the gate would take the site down rather than protect it.
//
//   WebSocket upgrades are gated too. Gating only pages would leave /signaling
//   and /lobby open to anyone who skipped the front door, which is most of what
//   is worth protecting.

import { createHmac, timingSafeEqual } from "node:crypto";

const PASSWORD = process.env.SITE_PASSWORD || "";
const COOKIE = "aiodarts_gate";

// Browsers are inconsistent about attaching an Authorization header to a
// WebSocket handshake, so a successful sign-in also sets a cookie and the
// upgrade check reads that. The cookie holds an HMAC of the password rather
// than the password, so a stolen cookie does not hand over the password itself.
const token = PASSWORD
  ? createHmac("sha256", "aio-darts-site-gate").update(PASSWORD).digest("hex")
  : "";

export const gateEnabled = Boolean(PASSWORD);

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function cookieToken(header) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

function passwordFromHeader(header) {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    // "user:password" - the username is ignored, there is only one password.
    return decoded.slice(decoded.indexOf(":") + 1);
  } catch {
    return null;
  }
}

// Has this request already got through the gate?
export function isAllowed(req) {
  if (!gateEnabled) return true;

  const cookie = cookieToken(req.headers.cookie);
  if (cookie && safeEqual(cookie, token)) return true;

  const supplied = passwordFromHeader(req.headers.authorization);
  return Boolean(supplied) && safeEqual(supplied, PASSWORD);
}

// Returns true if it handled the request (i.e. blocked it), false to carry on.
export function guardRequest(req, res) {
  if (!gateEnabled) return false;

  // The health check must never be gated - see the note at the top.
  const path = (req.url || "").split("?")[0];
  if (path === "/healthz") return false;

  if (isAllowed(req)) {
    // Refresh the cookie on the way through, so a browser that authenticated
    // with the header carries the cookie for its WebSocket upgrades.
    const cookie = cookieToken(req.headers.cookie);
    if (!cookie || !safeEqual(cookie, token)) {
      res.setHeader("Set-Cookie",
        `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
    }
    return false;
  }

  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="AIO Darts test build", charset="UTF-8"',
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end("This is a test deployment. A password is needed to look at it.");
  return true;
}
