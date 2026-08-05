// db.js - the SQLite database behind accounts, match history and statistics.
//
// Why SQLite, and why the built-in one:
//
// The server has exactly one npm dependency (ws), and that restraint is worth
// keeping - it's what makes `npm install` here take a second and never break on
// a native build. Node 22.5+ ships `node:sqlite`, so the database costs zero
// dependencies. The alternative, better-sqlite3, is a native module that needs
// python3/make/g++ in the Alpine image to compile.
//
// The cost is that it requires a newer Node than the image used to run, which
// is why the Dockerfile moved to node:24-alpine. `node:sqlite` is still flagged
// "experimental" in Node's docs, but only in the sense that its JS API may
// change - it is real SQLite underneath, and the API surface used here
// (prepare/run/get/all/exec) is the boring part of it.
//
// SQLite is also simply the right shape for this app: one file in DATA_DIR
// means the whole database is backed up by copying it, and the deployment stays
// a single container with no second service to run. DATA_DIR has been
// provisioned for exactly this since before there was anything to put in it -
// see checkDataDir() in server.js.
//
// IMPORTANT deployment note: on a host with an ephemeral filesystem (Render's
// free tier, most obviously) this file is wiped on every deploy. That is not a
// bug here - it's a hosting choice that has to be made deliberately, by
// attaching a persistent disk and pointing DATA_DIR at it. render.yaml says so
// too.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");

// node:sqlite refuses to bind a JS boolean or undefined - it throws "Provided
// value cannot be bound to SQLite parameter". SQLite has no boolean type, so
// this is arguably honest of it, but it turns an ordinary `player.bust` into a
// runtime error at the worst moment. Every caller goes through these two
// helpers instead of remembering the rule.
export function bool(value) {
  return value ? 1 : 0;
}

// For anything nullable: undefined is a bind error, NULL is a value.
export function orNull(value) {
  return value === undefined ? null : value;
}

let db = null;

// Opens (creating if needed) the database and brings it up to the latest
// schema. Safe to call once at startup; returns the same handle afterwards.
export async function openDatabase(dataDir) {
  if (db) return db;

  db = new DatabaseSync(join(dataDir, "aio-darts.db"));

  // Write-Ahead Logging: readers don't block the writer and vice versa. This
  // app's write pattern is "one burst per completed match" against a dashboard
  // that reads on every page load, which is precisely the case WAL exists for.
  db.exec("PRAGMA journal_mode = WAL");

  // Foreign keys are OFF by default in SQLite, per connection, for backwards
  // compatibility with decades-old databases. Every ON DELETE CASCADE in the
  // schema is dead weight without this line - deleting a user would leave its
  // matches behind as orphans.
  db.exec("PRAGMA foreign_keys = ON");

  // If a second process (a stray dev server, a backup script) holds the write
  // lock, wait rather than failing instantly.
  db.exec("PRAGMA busy_timeout = 5000");

  await migrate(db);
  return db;
}

export function getDatabase() {
  if (!db) throw new Error("openDatabase() must be called before getDatabase()");
  return db;
}

export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------
// Plain .sql files applied in filename order, with the applied names recorded
// in a table. Deliberately the simplest thing that works:
//
//   * A schema change is a new file, never an edit to an old one. Editing an
//     applied migration is the classic way to get two databases that claim the
//     same version and disagree about their contents.
//   * Filename order means 001_, 002_, ... and nothing cleverer. Timestamps
//     would be more collision-proof with several developers; there is one here.
//   * There is no "down" migration. Rolling a schema backwards is a thing you
//     want roughly once, and want to do by hand, from a backup, with the
//     specific data in front of you - a generic reverse script is a liability
//     that looks like a safety net.
//
// Each file runs inside a transaction together with the row recording it, so a
// migration that fails halfway leaves the database exactly as it was and gets
// retried on the next boot rather than being half-applied and marked done.
async function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    database.prepare("SELECT name FROM schema_migrations").all().map((row) => row.name)
  );

  let files;
  try {
    files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    // No migrations directory at all is a broken deployment, not an empty one -
    // say so rather than silently running against a schema-less database.
    throw new Error(`No migrations directory at ${MIGRATIONS_DIR}`);
  }

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    database.exec("BEGIN");
    try {
      database.exec(sql);
      database
        .prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
        .run(file, new Date().toISOString());
      database.exec("COMMIT");
      console.log(`  migration    : applied ${file}`);
    } catch (err) {
      database.exec("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${err.message}`);
    }
  }
}

// Runs fn inside a transaction, rolling back if it throws. Used by the match
// upload, which writes a match, its players, legs, turns and throws as one
// unit - a half-written match would corrupt every statistic derived from it.
export function inTransaction(fn) {
  const database = getDatabase();
  database.exec("BEGIN");
  try {
    const result = fn(database);
    database.exec("COMMIT");
    return result;
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
}
