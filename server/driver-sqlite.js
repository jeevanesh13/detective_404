/**
 * DETECTIVE 404 — SQLite storage engine (the local development default).
 *
 * The whole product state (rooms, games, cases, questions, answers, scores,
 * per-player timers) lives in ONE file: data/deductive404.db. This module owns
 * that file and, above all, keeps it durable — the file must never end up
 * behind the latest committed transaction when the machine sleeps, the process
 * is killed or the folder is synced by a cloud client.
 *
 * Durability rules implemented here:
 *
 *   1. WAL journal + synchronous=FULL — every COMMIT is fsync'd to disk, so a
 *      laptop shutdown mid-game cannot lose a committed score.
 *   2. A checkpoint (PRAGMA wal_checkpoint(TRUNCATE)) runs at boot, every
 *      CHECKPOINT_MS and on every shutdown, so the committed data is folded
 *      back into the main .db file at least that often. The .db-wal sidecar
 *      therefore never holds more than ~30s of work — if a sync tool ever
 *      separates it from the main file, nothing important is lost with it.
 *   3. Rolling backups (data/backups/) via VACUUM INTO at boot, every
 *      BACKUP_MS and on shutdown — a point-in-time copy that survives even if
 *      the main file itself is reverted by something outside the process.
 *   4. Signal + exit hooks flush before the process goes away.
 *
 * Initialization is create-if-missing only: schema uses IF NOT EXISTS and the
 * migrations are additive column additions. Nothing is ever dropped, truncated
 * or re-seeded, so existing rooms and games survive every restart.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { DB_FILE, DATA_DIR, ROOT } from "./config.js";

export const dialect = "sqlite";
/** Boot-log label: the file, relative to the project root when possible. */
export const label = (() => {
  const rel = path.relative(ROOT, DB_FILE);
  return `sqlite  ${rel && !rel.startsWith("..") ? rel : DB_FILE}`;
})();

/** How often the WAL is folded back into the main file. */
const CHECKPOINT_MS = 30_000;
/** How often a rolling backup copy is taken while the server runs. */
const BACKUP_MS = 6 * 60 * 60_000;
/** How many backup copies to keep in data/backups/. */
const BACKUP_KEEP = 5;

let db = null;
let closed = false;
let checkpointTimer = null;
let backupTimer = null;
let lastBackup = 0;
let hooksInstalled = false;

/* The schema is identical in shape to the PostgreSQL engine (see
   driver-pg.js); only the timestamp column type differs (INTEGER here). */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS admins (
  id            TEXT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id            TEXT PRIMARY KEY,
  room_code     TEXT UNIQUE NOT NULL,
  room_name     TEXT NOT NULL,
  admin_id      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'waiting',
  duration      INTEGER NOT NULL DEFAULT 2700000,
  started_at    INTEGER,
  paused_since  INTEGER,
  paused_total  INTEGER NOT NULL DEFAULT 0,
  ended_at      INTEGER,
  current_case  INTEGER NOT NULL DEFAULT 1,
  case_auto     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  game_id       TEXT
);

CREATE TABLE IF NOT EXISTS players (
  id                TEXT PRIMARY KEY,
  room_id           TEXT NOT NULL,
  player_name       TEXT NOT NULL,
  name_key          TEXT NOT NULL,
  joined_at         INTEGER NOT NULL,
  current_case      INTEGER NOT NULL DEFAULT 1,
  completed_cases   INTEGER NOT NULL DEFAULT 0,
  awaiting_next     INTEGER NOT NULL DEFAULT 0,
  revealed_current  INTEGER NOT NULL DEFAULT 0,
  correct_count     INTEGER NOT NULL DEFAULT 0,
  wrong_count       INTEGER NOT NULL DEFAULT 0,
  score             INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'playing',
  timed_out         INTEGER NOT NULL DEFAULT 0,
  finished_at       INTEGER,
  time_taken        INTEGER,
  case_started_at   INTEGER NOT NULL,
  last_active       INTEGER NOT NULL,
  started_at        INTEGER,
  ends_at           INTEGER,
  UNIQUE (room_id, name_key)
);

CREATE TABLE IF NOT EXISTS answers (
  id         TEXT PRIMARY KEY,
  player_id  TEXT NOT NULL,
  room_id    TEXT NOT NULL,
  case_id    INTEGER NOT NULL,
  answer     TEXT NOT NULL,
  correct    INTEGER NOT NULL,
  points     INTEGER NOT NULL DEFAULT 0,
  timestamp  INTEGER NOT NULL,
  time_taken INTEGER
);

CREATE TABLE IF NOT EXISTS game_sessions (
  id         TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL,
  start_time INTEGER,
  end_time   INTEGER,
  duration   INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'waiting',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
  id          TEXT PRIMARY KEY,
  admin_id    TEXT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'draft',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS game_cases (
  id             TEXT PRIMARY KEY,
  game_id        TEXT NOT NULL,
  case_number    INTEGER NOT NULL,
  case_title     TEXT NOT NULL DEFAULT '',
  image_url      TEXT NOT NULL DEFAULT '',
  question       TEXT NOT NULL DEFAULT '',
  question_type  TEXT NOT NULL DEFAULT 'text',
  options        TEXT NOT NULL DEFAULT '[]',
  correct_answer TEXT NOT NULL DEFAULT '',
  clue           TEXT NOT NULL DEFAULT '',
  points_first   INTEGER NOT NULL DEFAULT 100,
  points_second  INTEGER NOT NULL DEFAULT 50,
  sort_order     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS player_progress (
  id           TEXT PRIMARY KEY,
  player_id    TEXT NOT NULL,
  room_id      TEXT NOT NULL,
  game_id      TEXT NOT NULL,
  case_number  INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  points       INTEGER NOT NULL DEFAULT 0,
  completed    INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER,
  UNIQUE (player_id, case_number)
);

/* Small key/value store for one-off schema flags. */
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_players_room   ON players(room_id);
CREATE INDEX IF NOT EXISTS idx_answers_player ON answers(player_id, case_id);
CREATE INDEX IF NOT EXISTS idx_answers_room   ON answers(room_id);
CREATE INDEX IF NOT EXISTS idx_sessions_room  ON game_sessions(room_id);
CREATE INDEX IF NOT EXISTS idx_games_admin    ON games(admin_id);
CREATE INDEX IF NOT EXISTS idx_cases_game     ON game_cases(game_id, case_number);
CREATE INDEX IF NOT EXISTS idx_progress_player ON player_progress(player_id, case_number);
`;

/**
 * Additive migrations for files created by an older version of the app.
 * A column is only ever ADDED when missing — never rewritten, never dropped —
 * so every existing room, player and score survives an upgrade untouched.
 */
function migrate() {
  const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols("rooms").includes("game_id")) db.exec("ALTER TABLE rooms ADD COLUMN game_id TEXT;");
  if (!cols("players").includes("started_at")) db.exec("ALTER TABLE players ADD COLUMN started_at INTEGER;");
  if (!cols("players").includes("ends_at")) db.exec("ALTER TABLE players ADD COLUMN ends_at INTEGER;");
}

/* ------------------------------------------------------------------ *
 * Durability
 * ------------------------------------------------------------------ */

/** Fold everything committed so far into the main .db file (idempotent). */
function checkpoint() {
  if (!db || closed) return false;
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return true;
  } catch (err) {
    console.error("[d404] checkpoint failed:", err.message);
    return false;
  }
}

function backupDir() {
  return path.join(path.dirname(DB_FILE), "backups");
}

/** One point-in-time copy of the whole database, pruned to BACKUP_KEEP. */
function backup() {
  if (!db || closed) return null;
  let created = null;
  try {
    const dir = backupDir();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `deductive404-${stamp}.db`);
    if (!fs.existsSync(file)) {
      db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      created = file;
    }
    lastBackup = Date.now();
    const keep = fs
      .readdirSync(dir)
      .filter((f) => /^deductive404-.*\.db$/.test(f))
      .sort();
    while (keep.length > BACKUP_KEEP) fs.rmSync(path.join(dir, keep.shift()), { force: true });
  } catch (err) {
    console.error("[d404] backup failed:", err.message);
  }
  return created;
}

function schedule() {
  if (checkpointTimer || backupTimer) return;
  checkpointTimer = setInterval(() => checkpoint(), CHECKPOINT_MS);
  checkpointTimer.unref?.();
  backupTimer = setInterval(() => {
    if (Date.now() - lastBackup >= BACKUP_MS) backup();
  }, BACKUP_MS);
  backupTimer.unref?.();
}

/**
 * Flush and close, synchronously — safe to call from a signal handler or a
 * process 'exit' hook. Idempotent, so double Ctrl+C or close-after-close is
 * harmless.
 */
function shutdown({ withBackup } = {}) {
  if (closed || !db) return;
  const wantsBackup = withBackup === undefined ? true : withBackup;
  closed = true;
  try {
    if (checkpointTimer) clearInterval(checkpointTimer);
    if (backupTimer) clearInterval(backupTimer);
  } catch {
    /* noop */
  }
  checkpointTimer = null;
  backupTimer = null;
  // The API's 1s ticker cannot count down without a database: stop it here so
  // no tick ever runs against a closed engine (api.js watches this global).
  try {
    if (globalThis.__d404Ticker) {
      clearInterval(globalThis.__d404Ticker);
      globalThis.__d404Ticker = null;
    }
  } catch {
    /* noop */
  }
  checkpoint(); // main file is current before anything else happens
  if (wantsBackup) backup();
  try {
    db.close();
  } catch {
    /* already closed */
  }
  db = null;
}

/**
 * Ctrl+C / kill must never leave the last few seconds behind: flush first,
 * then hand the signal back to whatever else is listening (dev.js, index.js)
 * — or terminate ourselves when nothing else will. Listeners are tagged so
 * several engine instances in one process (the close-and-reopen test) count
 * as one "family": they must not block each other's exit.
 */
function installFlushHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on("exit", () => shutdown({ withBackup: true }));
  for (const sig of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      shutdown({ withBackup: true });
      const others = process.listeners(sig).filter((l) => !l.__d404Flush);
      if (!others.length) process.exit(130);
      /* otherwise another handler (dev.js / index.js) finishes the shutdown */
    };
    handler.__d404Flush = true;
    process.on(sig, handler);
  }
}

/* ------------------------------------------------------------------ *
 * Engine interface used by store/db.js
 * ------------------------------------------------------------------ */

export async function open() {
  if (db) return;
  closed = false; // a close-and-reopen in the same process is a real reopen
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
  `);
  db.exec(SCHEMA); // IF NOT EXISTS — an existing file is never rebuilt
  migrate();
  checkpoint(); // the main file reflects everything committed so far
  backup(); // recovery point before this process changes anything
  schedule();
  installFlushHooks();
}

export const get = async (sql, params = []) => db.prepare(sql).get(...params);
export const all = async (sql, params = []) => db.prepare(sql).all(...params);
export const run = async (sql, params = []) => db.prepare(sql).run(...params);
export const exec = async (sql) => db.exec(sql);

/** BEGIN IMMEDIATE takes the write lock up front so two writers queue. */
export const begin = async () => db.exec("BEGIN IMMEDIATE");
export const commit = async () => db.exec("COMMIT");
export const rollback = async () => db.exec("ROLLBACK");

/** Graceful close (tests, explicit shutdown): flush + backup + close. */
export const close = async () => shutdown({ withBackup: true });
