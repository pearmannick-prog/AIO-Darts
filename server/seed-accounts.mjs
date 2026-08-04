// seed-accounts.mjs - recreate the two test accounts the lobby needs.
//
// Testing the lobby needs two DIFFERENT accounts, and a deployment on an
// ephemeral filesystem (Render's free tier) deletes them on every deploy AND
// on every spin-down after about fifteen minutes idle. That turns a five
// second test into a two minute one, several times an hour, which is exactly
// the kind of friction that stops things being tested at all.
//
// So: one command, two accounts, ready to sign in.
//
// Deliberately talks to the HTTP API rather than the database. The database is
// inside the container and unreachable from here, and going through /api also
// means this exercises the same registration path a real player does - a seed
// script that bypassed it could quietly keep working after that path broke.
//
// Usage:
//   node server/seed-accounts.mjs                            # localhost:8000
//   node server/seed-accounts.mjs https://aio-darts-dev.onrender.com
//   SITE_PASSWORD=... node server/seed-accounts.mjs https://...
//
// These credentials are for throwaway test deployments and are meant to be
// boring and memorable. Do not seed a deployment that anybody real uses.
const ACCOUNTS = [
  { email: "test1@aiodarts.local", displayName: "Test One", password: "darts-test-1" },
  { email: "test2@aiodarts.local", displayName: "Test Two", password: "darts-test-2" },
];

const base = (process.argv[2] || "http://localhost:8000").replace(/\/+$/, "");
const sitePassword = process.env.SITE_PASSWORD || "";

// The site gate accepts HTTP Basic, which is how a script gets past it - the
// username is ignored and only the password is checked (see server/gate.js).
const headers = { "Content-Type": "application/json" };
if (sitePassword) {
  headers.Authorization = `Basic ${Buffer.from(`x:${sitePassword}`).toString("base64")}`;
}

async function seed({ email, displayName, password }) {
  let res;
  try {
    res = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email, displayName, password }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    return `unreachable (${err.message})`;
  }

  // Already there is a success, not a failure: this is meant to be run
  // repeatedly without thinking about whether it is needed.
  if (res.status === 409) return "already exists";
  if (res.ok) return "created";

  if (res.status === 503) {
    return "accounts are disabled on this deployment (ACCOUNTS=off, or no database)";
  }
  if (res.status === 401) {
    return "blocked by the site gate - set SITE_PASSWORD in the environment";
  }

  let detail = "";
  try {
    detail = (await res.json())?.error || "";
  } catch { /* not JSON */ }
  return `failed: HTTP ${res.status}${detail ? ` - ${detail}` : ""}`;
}

console.log(`Seeding test accounts on ${base}`);
let failed = false;
for (const account of ACCOUNTS) {
  const result = await seed(account);
  const ok = result === "created" || result === "already exists";
  if (!ok) failed = true;
  console.log(`  ${account.email.padEnd(24)} ${result}`);
}

if (!failed) {
  console.log("\nSign in with:");
  for (const a of ACCOUNTS) console.log(`  ${a.email} / ${a.password}   (${a.displayName})`);
  console.log("\nUse two browser PROFILES, not two tabs - tabs share a cookie jar,");
  console.log("so signing in as the second player signs the first one out.");
}

// exitCode rather than exit(): calling exit() while fetch's handles are still
// closing trips a libuv assertion on Windows and prints an alarming crash after
// a run that actually succeeded. Setting the code lets Node wind down normally.
process.exitCode = failed ? 1 : 0;
