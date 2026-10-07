/**
 * DETECTIVE 404 — PostgreSQL storage engine (production).
 *
 * Selected automatically when the DATABASE_URL environment variable is set:
 *
 *   DATABASE_URL=postgres://user:pass@host:5432/detective   -> this engine
 *   (unset)                                                  -> local SQLite
 *
 * The same schema, the same SQL and the same store API as the SQLite engine —
 * only the connection layer differs. Timestamps are BIGINT because they are
 * epoch milliseconds, which does not fit a 32-bit INTEGER.
 *
 * Two backends are supported behind this interface:
 *
 *   • `pg` (a real server) — used in production. The pool FAILS FAST when the
 *     server is unreachable: it must never silently fall back to a fresh local
 *     file, because that is exactly how data appears to "disappear".
 *   • `@electric-sql/pglite` (in-process Postgres, no server) — used by
 *     `npm run test:pg`, selected with DATABASE_URL=pglite:, so the whole test
 *     suite can run against real PostgreSQL SQL without a running server.
 *
 * Queries are written once in `?` placeholder dialect (shared with SQLite) and
 * translated to PostgreSQL's $1..$n form on the way out; string literals,
 * quoted identifiers and comments are left untouched.
 */
import fs from "node:fs";
import path from "node:path";
import { DATABASE_URL, DATA_DIR } from "./config.js";

export const dialect = "postgres";
const isPgLite = DATABASE_URL.startsWith("pglite");

function redact(url) {
  try {
    const u = new URL(url);
    const auth = u.user ? `${u.user}${u.password ? ":***" : ""}@` : "";
    return `postgres://${auth}${u.host}${u.pathname}`;
  } catch {
    return "postgres (DATABASE_URL)";
  }
}

export const label = isPgLite
  ? `pglite (in-process test engine · ${path.join(DATA_DIR, "pglite")})`
  : `postgres  ${redact(DATABASE_URL)}`;

let pool = null; // node-postgres pool (production)
let local = null; // PGLite instance (tests)
let tx = null; // the connection currently inside a transaction (pg only)

/* The schema mirrors driver-sqlite.js exactly; only timestamps differ. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS admins (
  id            TEXT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id            TEXT PRIMARY KEY,
  room_code     TEXT UNIQUE NOT NULL,
  room_name     TEXT NOT NULL,
  admin_id      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'waiting',
  duration      INTEGER NOT NULL DEFAULT 2700000,
  started_at    BIGINT,
  paused_since  BIGINT,
  paused_total  INTEGER NOT NULL DEFAULT 0,
  ended_at      BIGINT,
  current_case  INTEGER NOT NULL DEFAULT 1,
  case_auto     INTEGER NOT NULL DEFAULT 1,
  created_at    BIGINT NOT NULL,
  game_id       TEXT
);

CREATE TABLE IF NOT EXISTS players (
  id                TEXT PRIMARY KEY,
  room_id           TEXT NOT NULL,
  player_name       TEXT NOT NULL,
  name_key          TEXT NOT NULL,
  joined_at         BIGINT NOT NULL,
  current_case      INTEGER NOT NULL DEFAULT 1,
  completed_cases   INTEGER NOT NULL DEFAULT 0,
  awaiting_next     INTEGER NOT NULL DEFAULT 0,
  revealed_current  INTEGER NOT NULL DEFAULT 0,
  correct_count     INTEGER NOT NULL DEFAULT 0,
  wrong_count       INTEGER NOT NULL DEFAULT 0,
  score             INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'playing',
  timed_out         INTEGER NOT NULL DEFAULT 0,
  finished_at       BIGINT,
  time_taken        BIGINT,
  case_started_at   BIGINT NOT NULL,
  last_active       BIGINT NOT NULL,
  started_at        BIGINT,
  ends_at           BIGINT,
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
  timestamp  BIGINT NOT NULL,
  time_taken BIGINT
);

CREATE TABLE IF NOT EXISTS game_sessions (
  id         TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL,
  start_time BIGINT,
  end_time   BIGINT,
  duration   INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'waiting',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
  id          TEXT PRIMARY KEY,
  admin_id    TEXT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'draft',
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
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
  completed_at BIGINT,
  UNIQUE (player_id, case_number)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_players_room    ON players(room_id);
CREATE INDEX IF NOT EXISTS idx_answers_player  ON answers(player_id, case_id);
CREATE INDEX IF NOT EXISTS idx_answers_room    ON answers(room_id);
CREATE INDEX IF NOT EXISTS idx_sessions_room   ON game_sessions(room_id);
CREATE INDEX IF NOT EXISTS idx_games_admin     ON games(admin_id);
CREATE INDEX IF NOT EXISTS idx_cases_game      ON game_cases(game_id, case_number);
CREATE INDEX IF NOT EXISTS idx_progress_player ON player_progress(player_id, case_number);
`;

/* ------------------------------------------------------------------ *
 * Placeholder translation:  ?  ->  $1, $2, …  (outside of literals)
 * ------------------------------------------------------------------ */
function toNative(sql) {
  let out = "";
  let n = 0;
  let i = 0;
  let mode = 0; // 0 code, 1 single quote, 2 double quote, 3 line comment, 4 block comment
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (mode === 1) {
      out += ch;
      if (ch === "'") {
        if (next === "'") {
          out += next;
          i += 2;
          continue;
        }
        mode = 0;
      }
      i++;
      continue;
    }
    if (mode === 2) {
      out += ch;
      if (ch === '"') mode = 0;
      i++;
      continue;
    }
    if (mode === 3) {
      out += ch;
      if (ch === "\n") mode = 0;
      i++;
      continue;
    }
    if (mode === 4) {
      out += ch;
      if (ch === "*" && next === "/") {
        out += next;
        mode = 0;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (ch === "'") mode = 1;
    else if (ch === '"') mode = 2;
    else if (ch === "-" && next === "-") mode = 3;
    else if (ch === "/" && next === "*") mode = 4;
    else if (ch === "?") {
      n += 1;
      out += `$${n}`;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * node-postgres answers BIGINT (OID 20) — epoch-ms timestamps, count(*) — as
 * strings by default. Everything the store hands out must be a number, so each
 * int8 column is normalised. Coercion is idempotent: a value the backend
 * already parsed as a number is left as it is.
 */
function normalizeRows(result) {
  const rows = result?.rows || [];
  const fields = result?.fields;
  if (!fields || !fields.length) return rows;
  const bigints = fields.map((f) => f.dataTypeID === 20);
  if (!bigints.some(Boolean)) return rows;
  for (const row of rows) {
    for (let i = 0; i < fields.length; i++) {
      const name = fields[i].name;
      if (bigints[i] && typeof row[name] === "string") row[name] = Number(row[name]);
    }
  }
  return rows;
}

async function query(sql, params) {
  const list = (params || []).map((v) => (v === undefined ? null : v));
  if (local) return local.query(sql, list);
  const client = tx || pool;
  return client.query(sql, list);
}

/* ------------------------------------------------------------------ *
 * Additive migrations — the same three guarded column additions as
 * SQLite, typed BIGINT where they hold epoch milliseconds.
 * ------------------------------------------------------------------ */
async function hasColumn(table, column) {
  const res = await query(
    "SELECT 1 AS one FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2",
    [table, column]
  );
  return res.rows.length > 0;
}

async function migrate() {
  if (!(await hasColumn("rooms", "game_id"))) await exec("ALTER TABLE rooms ADD COLUMN game_id TEXT");
  if (!(await hasColumn("players", "started_at"))) await exec("ALTER TABLE players ADD COLUMN started_at BIGINT");
  if (!(await hasColumn("players", "ends_at"))) await exec("ALTER TABLE players ADD COLUMN ends_at BIGINT");
}

/* ------------------------------------------------------------------ *
 * Engine interface used by store/db.js
 * ------------------------------------------------------------------ */

export async function open() {
  if (pool || local) return;
  if (isPgLite) {
    const { PGlite } = await import("@electric-sql/pglite");
    const dir = path.join(DATA_DIR, "pglite");
    fs.mkdirSync(dir, { recursive: true });
    local = await PGlite.create(dir);
  } else {
    const pg = (await import("pg")).default;
    const needsSsl = /sslmode=(require|allow|prefer|verify-ca|verify-full)/i.test(DATABASE_URL);
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
      max: 10,
      connectionTimeoutMillis: 15_000,
      idleTimeoutMillis: 30_000,
      allowExitOnIdle: true, // an idle pool must never keep the process alive
    });
    // count(*), epoch-ms timestamps -> numbers, matching the SQLite engine
    pg.types.setTypeParser(20, (v) => Number(v));
    pool.on("error", (err) => console.error("[d404] postgres connection error:", err.message));
    const probe = await pool.query("SELECT 1 AS ok");
    if (Number(probe.rows?.[0]?.ok) !== 1) throw new Error("DATABASE_URL did not answer the probe query.");
  }
  await exec(SCHEMA); // IF NOT EXISTS — an existing database is never rebuilt
  await migrate();
}

export const exec = async (sql) => (local ? local.exec(sql) : pool.query(sql));

export async function get(sql, params) {
  return normalizeRows(await query(toNative(sql), params))[0];
}

export async function all(sql, params) {
  return normalizeRows(await query(toNative(sql), params));
}

export async function run(sql, params) {
  const res = await query(toNative(sql), params);
  return { changes: res.rowCount ?? res.affectedRows ?? 0 };
}

export async function begin() {
  if (local) return local.exec("BEGIN");
  tx = await pool.connect();
  try {
    await tx.query("BEGIN");
  } catch (err) {
    tx.release();
    tx = null;
    throw err;
  }
}

export async function commit() {
  if (local) return local.exec("COMMIT");
  const client = tx;
  tx = null;
  try {
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}

export async function rollback() {
  if (local) return local.exec("ROLLBACK");
  const client = tx;
  tx = null;
  if (!client) return;
  try {
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
}

/** Graceful close: release the pool. PostgreSQL itself owns the data, so
 *  there is nothing to flush — every COMMIT already lives on the server. */
export async function close() {
  if (tx) {
    try {
      await rollback();
    } catch {
      /* connection already gone */
    }
  }
  if (local) {
    const instance = local;
    local = null;
    await instance.close();
  }
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}
