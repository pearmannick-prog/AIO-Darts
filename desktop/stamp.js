// stamp.js - record which commit a packaged build came from.
//
// Run automatically before `npm run dist` (npm's "pre" hook), never by hand.
//
// WHY. Without this the footer reads "AIO Darts · local dev build" on an
// installed application, which is the one place that line is actively
// misleading: a packaged build is not local and not dev, it is an artifact
// somebody now has a copy of and may report a bug against. CLAUDE.md already
// calls the version line the most useful thing in the app when someone says "I
// changed it and nothing happened", and an installer is exactly the case where
// the person looking at the screen cannot check for themselves.
//
// It writes the SAME version.json the Dockerfile bakes into the image, into the
// same place the server already looks (PUBLIC_DIR). No server change, no new
// mechanism, no second way of answering "which build is this?".
//
// Note what is deliberately NOT written: the branch. server.js takes `branch`
// from the environment rather than from this file, so it stays undefined here -
// which suppresses version.js's environment banner, and that is the outcome we
// want. The banner reads "Test deployment · <branch> · not the live site", and
// every word of that is about a web deployment being mistaken for the live one.
// An installed desktop app has no live-site counterpart to be confused with.
// The full SHA is still in the footer's title attribute, so provenance is
// recoverable from a screenshot either way.

const { execSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..");

function git(args) {
  try {
    return execSync(`git ${args}`, { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

// A dirty tree is worth knowing about and cheap to detect. A build made from
// uncommitted changes has a SHA that does not describe it, which is a worse
// lie than no SHA at all - so the suffix says so out loud.
const dirty = git("status --porcelain") ? "-dirty" : "";
const sha = git("rev-parse HEAD");

const info = {
  // "dev" is what server.js treats as "no real answer", and it is the honest
  // value when this is not a git checkout at all.
  sha: sha ? sha + dirty : "dev",
  builtAt: new Date().toISOString(),
};

const out = path.join(__dirname, "version.json");
writeFileSync(out, JSON.stringify(info, null, 2) + "\n");
console.log(`stamped ${info.sha.slice(0, 7)}${dirty} at ${info.builtAt}`);
