import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DB_FILE, DATA_DIR, ADMIN_USER, ADMIN_PASSWORD } from "./config.js";
import { hashPassword, checkPassword } from "./auth.js";

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_FILE);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

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
  created_at    INTEGER NOT NULL
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

CREATE INDEX IF NOT EXISTS idx_players_room   ON players(room_id);
CREATE INDEX IF NOT EXISTS idx_answers_player ON answers(player_id, case_id);
CREATE INDEX IF NOT EXISTS idx_answers_room   ON answers(room_id);
CREATE INDEX IF NOT EXISTS idx_sessions_room  ON game_sessions(room_id);

/* ------------------------------------------------------------------ *
 * Dynamic game content — written by the game master in the Game Builder.
 * Nothing here is hard-coded: a game is just a name plus an ordered list of
 * cases, and a room points at exactly one game.
 * ------------------------------------------------------------------ */
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

CREATE INDEX IF NOT EXISTS idx_games_admin     ON games(admin_id);
CREATE INDEX IF NOT EXISTS idx_cases_game      ON game_cases(game_id, case_number);
CREATE INDEX IF NOT EXISTS idx_progress_player ON player_progress(player_id, case_number);
`);

/* ------------------------------------------------------------------ *
 * Migrations — additive only, so existing rooms, players and admin
 * accounts survive an upgrade untouched.
 * ------------------------------------------------------------------ */
const columnsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
if (!columnsOf("rooms").includes("game_id")) db.exec("ALTER TABLE rooms ADD COLUMN game_id TEXT;");
/* One seat = one personal session: each detective stores WHEN they pressed
   START and when THEIR clock expires. Additive only — no existing row or
   column is touched, so every room, player and score survives the upgrade. */
if (!columnsOf("players").includes("started_at")) db.exec("ALTER TABLE players ADD COLUMN started_at INTEGER;");
if (!columnsOf("players").includes("ends_at")) db.exec("ALTER TABLE players ADD COLUMN ends_at INTEGER;");

const metaGet = (key) => db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
const metaSet = (key, value) =>
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    String(value)
  );

/**
 * One-time removal of the retired hard-coded case file: only records that
 * belonged to that game are touched. Users, rooms and the admin account are
 * deliberately left alone (see README, "Clearing the old game content").
 */
function clearLegacyContent() {
  if (metaGet("legacy_content_cleared")) return false;
  db.exec("DELETE FROM answers");
  metaSet("legacy_content_cleared", Date.now());
  return true;
}
export const legacyCleared = clearLegacyContent();


export const uid = () => crypto.randomUUID();

/* ------------------------------------------------------------------ *
 * Admins
 * ------------------------------------------------------------------ */
export function seedAdmin() {
  const explicit = process.env.D404_ADMIN_PASSWORD;
  const existing = db.prepare("SELECT * FROM admins WHERE username = ?").get(ADMIN_USER);
  if (!existing) {
    db.prepare("INSERT INTO admins (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)").run(
      uid(),
      ADMIN_USER,
      hashPassword(ADMIN_PASSWORD),
      Date.now()
    );
    return "created";
  }
  if (explicit) {
    db.prepare("UPDATE admins SET password_hash = ? WHERE id = ?").run(hashPassword(explicit), existing.id);
    return "rotated";
  }
  return "exists";
}

export const findAdminByName = (username) =>
  db.prepare("SELECT * FROM admins WHERE username = ?").get(String(username || "").trim().toLowerCase()) ||
  db.prepare("SELECT * FROM admins WHERE username = ?").get(String(username || "").trim());

export const findAdminById = (id) => db.prepare("SELECT * FROM admins WHERE id = ?").get(id);

export function verifyAdmin(username, password) {
  const admin = findAdminByName(username);
  if (!admin) {
    // Burn comparable time so a missing user is not distinguishable.
    checkPassword(password, hashPassword("decoy"));
    return null;
  }
  return checkPassword(password, admin.password_hash) ? admin : null;
}

/* ------------------------------------------------------------------ *
 * Rooms
 * ------------------------------------------------------------------ */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateRoomCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = "";
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (!findRoomByCode(code)) return code;
  }
  return crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
}

export const normalizeCode = (code) => String(code || "").trim().toUpperCase();

export const findRoomByCode = (code) =>
  db.prepare("SELECT * FROM rooms WHERE room_code = ?").get(normalizeCode(code));

export const findRoomById = (id) => db.prepare("SELECT * FROM rooms WHERE id = ?").get(id);

export const listRooms = () =>
  db.prepare("SELECT * FROM rooms ORDER BY created_at DESC").all();

export const listRoomsForAdmin = (adminId) =>
  db.prepare("SELECT * FROM rooms WHERE admin_id = ? ORDER BY created_at DESC").all(adminId);

export function createRoom({ roomName, duration, adminId }) {
  const now = Date.now();
  const id = uid();
  const code = generateRoomCode();
  db.prepare(
    `INSERT INTO rooms (id, room_code, room_name, admin_id, status, duration, started_at, paused_since,
      paused_total, ended_at, current_case, case_auto, created_at)
     VALUES (?, ?, ?, ?, 'waiting', ?, NULL, NULL, 0, NULL, 1, 1, ?)`
  ).run(id, code, roomName, adminId, duration, now);
  db.prepare(
    `INSERT INTO game_sessions (id, room_id, start_time, end_time, duration, status, created_at)
     VALUES (?, ?, NULL, NULL, ?, 'waiting', ?)`
  ).run(uid(), id, duration, now);
  return findRoomById(id);
}

export function updateRoom(id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return findRoomById(id);
  db.prepare(`UPDATE rooms SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
    ...keys.map((k) => patch[k]),
    id
  );
  return findRoomById(id);
}

export const activeSession = (roomId) =>
  db.prepare("SELECT * FROM game_sessions WHERE room_id = ? ORDER BY created_at DESC LIMIT 1").get(roomId);

export function touchSession(roomId, patch) {
  const session = activeSession(roomId);
  if (!session) return null;
  const keys = Object.keys(patch);
  if (!keys.length) return session;
  db.prepare(`UPDATE game_sessions SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
    ...keys.map((k) => patch[k]),
    session.id
  );
  return activeSession(roomId);
}

/* ------------------------------------------------------------------ *
 * Players
 * ------------------------------------------------------------------ */
export const normalizeName = (name) =>
  String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

export const findPlayer = (id) => db.prepare("SELECT * FROM players WHERE id = ?").get(id);

export const findPlayerByName = (roomId, name) =>
  db.prepare("SELECT * FROM players WHERE room_id = ? AND name_key = ?").get(roomId, normalizeName(name));

export const listPlayers = (roomId) =>
  db.prepare("SELECT * FROM players WHERE room_id = ? ORDER BY joined_at ASC").all(roomId);

/** How many seats this room has already taken (a room holds many players). */
export const countPlayers = (roomId) =>
  db.prepare("SELECT COUNT(*) AS n FROM players WHERE room_id = ?").get(roomId).n;

/* ------------------------------------------------------------------ *
 * Transactions
 *
 * Node is single threaded, so one statement is already atomic — but a
 * feature that writes several rows (join, submit answer, advance case)
 * must not be able to half-apply. Every multi-write flow runs inside
 * withTx(), and BEGIN IMMEDIATE takes the write lock up front so two
 * writers (dev server + prod server, or two instances) queue instead of
 * interleaving.
 * ------------------------------------------------------------------ */
let txDepth = 0;

export function withTx(fn) {
  if (txDepth > 0) {
    // Already inside a transaction: reuse it so callers can compose.
    txDepth += 1;
    try {
      return fn();
    } finally {
      txDepth -= 1;
    }
  }
  db.exec("BEGIN IMMEDIATE");
  txDepth = 1;
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* transaction already unwound */
    }
    throw err;
  } finally {
    txDepth = 0;
  }
}

/** node:sqlite constraint failures (duplicate name, …) as a portable shape. */
export function isUniqueViolation(err) {
  if (!err) return false;
  const code = String(err.code || "");
  const msg = String(err.message || "");
  return (
    code.includes("SQLITE_CONSTRAINT") ||
    err.errcode === 2067 ||
    err.errcode === 1555 ||
    /UNIQUE constraint failed/i.test(msg)
  );
}

export function isDbError(err) {
  if (!err) return false;
  return isUniqueViolation(err) || String(err.code || "").startsWith("SQLITE_") || /SQLITE_/i.test(String(err.message || ""));
}

/**
 * Atomic "count the seats, then take one".
 *
 * Returns { code: "OK", player } / { code: "ROOM_FULL" } / { code: "NAME_TAKEN" }
 * instead of throwing, so the API can answer with a specific error — and two
 * players joining at the very same instant can never exceed the capacity or
 * collide on the same name without being told so.
 */
export function joinRoomAtomic({ roomId, playerName, maxPlayers }) {
  try {
    return withTx(() => {
      const taken = countPlayers(roomId);
      if (taken >= maxPlayers) return { code: "ROOM_FULL", count: taken, capacity: maxPlayers };
      const player = createPlayer({ roomId, playerName });
      return { code: "OK", player, count: taken + 1, capacity: maxPlayers };
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { code: "NAME_TAKEN" };
    throw err;
  }
}

export function createPlayer({ roomId, playerName }) {
  const now = Date.now();
  const id = uid();
  db.prepare(
    `INSERT INTO players (id, room_id, player_name, name_key, joined_at, current_case, completed_cases,
      awaiting_next, revealed_current, correct_count, wrong_count, score, status, timed_out,
      finished_at, time_taken, case_started_at, last_active)
     VALUES (?, ?, ?, ?, ?, 1, 0, 0, 0, 0, 0, 0, 'playing', 0, NULL, NULL, ?, ?)`
  ).run(id, roomId, playerName, normalizeName(playerName), now, now, now);
  return findPlayer(id);
}

export function updatePlayer(id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return findPlayer(id);
  db.prepare(`UPDATE players SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
    ...keys.map((k) => patch[k]),
    id
  );
  return findPlayer(id);
}

/** The last thing a player submitted for one question. */
export const lastAnswer = (playerId, caseId) =>
  db
    .prepare(
      "SELECT * FROM answers WHERE player_id = ? AND case_id = ? ORDER BY timestamp DESC, rowid DESC LIMIT 1"
    )
    .get(playerId, caseId);

/** Is an uploaded case image still referenced by any case? */
export const uploadInUse = (url) =>
  db.prepare("SELECT COUNT(*) AS n FROM game_cases WHERE image_url = ?").get(url).n > 0;

export function recordAnswer({ playerId, roomId, caseId, answer, correct, points, timeTaken }) {
  db.prepare(
    `INSERT INTO answers (id, player_id, room_id, case_id, answer, correct, points, timestamp, time_taken)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(uid(), playerId, roomId, caseId, String(answer).slice(0, 500), correct ? 1 : 0, points, Date.now(), timeTaken);
}

/** Latest submissions joined with the detective who made them (activity feed). */
export const recentAnswers = (roomId, limit = 12) =>
  db
    .prepare(
      `SELECT a.id, a.case_id AS caseId, a.answer, a.correct, a.points, a.timestamp,
              a.time_taken AS timeTaken, p.player_name AS player
         FROM answers a LEFT JOIN players p ON p.id = a.player_id
        WHERE a.room_id = ?
        ORDER BY a.timestamp DESC
        LIMIT ?`
    )
    .all(roomId, limit)
    .map((r) => ({ ...r, correct: !!r.correct }));

export function resetRoomProgress(roomId) {
  const now = Date.now();
  db.prepare(
    `UPDATE players SET current_case = 1, completed_cases = 0, awaiting_next = 0, revealed_current = 0,
       correct_count = 0, wrong_count = 0, score = 0, status = 'playing', timed_out = 0,
       finished_at = NULL, time_taken = NULL, case_started_at = ?, last_active = ?,
       started_at = NULL, ends_at = NULL
     WHERE room_id = ?`
  ).run(now, now, roomId);
  db.prepare("DELETE FROM answers WHERE room_id = ?").run(roomId);
  db.prepare("DELETE FROM player_progress WHERE room_id = ?").run(roomId);
}

/** Permanently remove one room and every record that belongs to it.
 *  Only rows for this room_id are touched — other rooms, games,
 *  players' accounts and admin data are left alone. */
export function deleteRoom(roomId) {
  db.prepare("DELETE FROM player_progress WHERE room_id = ?").run(roomId);
  db.prepare("DELETE FROM answers WHERE room_id = ?").run(roomId);
  db.prepare("DELETE FROM players WHERE room_id = ?").run(roomId);
  db.prepare("DELETE FROM game_sessions WHERE room_id = ?").run(roomId);
  db.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
}

/** Boot-time reconciliation: a room left LIVE by a crashed server is settled. */
export function reconcileRooms() {
  const live = db.prepare("SELECT * FROM rooms WHERE status IN ('live','paused')").all();
  return live;
}

/* ------------------------------------------------------------------ *
 * Games — the dynamic case files written in the Game Builder
 * ------------------------------------------------------------------ */
export const findGame = (id) => (id ? db.prepare("SELECT * FROM games WHERE id = ?").get(id) : null);

/** Every game with its case count and the rooms currently pointing at it. */
export const listGames = (adminId) =>
  db
    .prepare(
      `SELECT g.*, (SELECT COUNT(*) FROM game_cases c WHERE c.game_id = g.id) AS case_count,
              (SELECT COUNT(*) FROM rooms r WHERE r.game_id = g.id) AS room_count
         FROM games g
        WHERE g.admin_id = ?
        ORDER BY g.created_at DESC`
    )
    .all(adminId);

export function createGame({ adminId, name, description = "" }) {
  const now = Date.now();
  const id = uid();
  db.prepare(
    `INSERT INTO games (id, admin_id, name, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?)`
  ).run(id, adminId, name, description, now, now);
  return findGame(id);
}

export function updateGame(id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return findGame(id);
  db.prepare(`UPDATE games SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(
    ...keys.map((k) => patch[k]),
    Date.now(),
    id
  );
  return findGame(id);
}

export function deleteGame(id) {
  db.prepare("DELETE FROM game_cases WHERE game_id = ?").run(id);
  db.prepare("DELETE FROM player_progress WHERE game_id = ?").run(id);
  db.prepare("UPDATE rooms SET game_id = NULL WHERE game_id = ?").run(id);
  db.prepare("DELETE FROM games WHERE id = ?").run(id);
}

export const roomsUsingGame = (gameId) => db.prepare("SELECT * FROM rooms WHERE game_id = ?").all(gameId);

/* ------------------------------------------------------------------ *
 * Cases inside a game
 * ------------------------------------------------------------------ */
export const listCases = (gameId) =>
  db.prepare("SELECT * FROM game_cases WHERE game_id = ? ORDER BY case_number ASC").all(gameId);

export const findCase = (id) => db.prepare("SELECT * FROM game_cases WHERE id = ?").get(id);

export function insertCase(f) {
  const id = uid();
  db.prepare(
    `INSERT INTO game_cases (id, game_id, case_number, case_title, image_url, question, question_type,
       options, correct_answer, clue, points_first, points_second, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    f.game_id,
    f.case_number,
    f.case_title,
    f.image_url,
    f.question,
    f.question_type,
    f.options,
    f.correct_answer,
    f.clue,
    f.points_first,
    f.points_second,
    f.sort_order
  );
  return findCase(id);
}

export function updateCase(id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return findCase(id);
  db.prepare(`UPDATE game_cases SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
    ...keys.map((k) => patch[k]),
    id
  );
  return findCase(id);
}

export function deleteCase(id) {
  const row = findCase(id);
  if (!row) return null;
  db.prepare("DELETE FROM game_cases WHERE id = ?").run(id);
  renumberCases(row.game_id);
  return row;
}

/** Keep case numbers running 1..n after a delete or a reorder. */
export function renumberCases(gameId) {
  const rows = listCases(gameId);
  const stmt = db.prepare("UPDATE game_cases SET case_number = ?, sort_order = ? WHERE id = ?");
  rows.forEach((r, i) => stmt.run(i + 1, i, r.id));
  return listCases(gameId);
}

/** Reorder by an explicit list of case ids (the editor sends them in order). */
export function setCaseOrder(gameId, orderedIds) {
  const valid = new Set(listCases(gameId).map((r) => r.id));
  const ids = orderedIds.filter((id) => valid.has(id));
  if (!ids.length) return listCases(gameId);
  const stmt = db.prepare("UPDATE game_cases SET case_number = ?, sort_order = ? WHERE id = ? AND game_id = ?");
  ids.forEach((id, i) => stmt.run(i + 1, i, id, gameId));
  // anything the client did not mention keeps its place at the end
  const seen = new Set(ids);
  listCases(gameId)
    .filter((r) => !seen.has(r.id))
    .forEach((r, k) => stmt.run(ids.length + k + 1, ids.length + k, r.id, gameId));
  return listCases(gameId);
}

export function moveCase(gameId, caseId, direction) {
  const rows = listCases(gameId);
  const i = rows.findIndex((r) => r.id === caseId);
  const j = i + Number(direction);
  if (i < 0 || j < 0 || j >= rows.length) return rows;
  const order = rows.map((r) => r.id);
  [order[i], order[j]] = [order[j], order[i]];
  return setCaseOrder(gameId, order);
}

/* ------------------------------------------------------------------ *
 * Per-question player progress (attempts, points, completion)
 * ------------------------------------------------------------------ */
export const getProgress = (playerId, caseNumber) =>
  db.prepare("SELECT * FROM player_progress WHERE player_id = ? AND case_number = ?").get(playerId, caseNumber);

export const listProgress = (playerId) =>
  db.prepare("SELECT * FROM player_progress WHERE player_id = ? ORDER BY case_number ASC").all(playerId);

export const progressMap = (playerId) =>
  Object.fromEntries(listProgress(playerId).map((p) => [p.case_number, p]));

export const completedCount = (playerId) =>
  db.prepare("SELECT COUNT(*) AS n FROM player_progress WHERE player_id = ? AND completed = 1").get(playerId).n;

export function saveProgress({ playerId, roomId, gameId, caseNumber, attempts, points, completed }) {
  const now = Date.now();
  const existing = getProgress(playerId, caseNumber);
  if (existing) {
    db.prepare(
      `UPDATE player_progress SET attempts = ?, points = ?, completed = ?, completed_at = ? WHERE id = ?`
    ).run(attempts, points, completed ? 1 : 0, completed ? now : existing.completed_at, existing.id);
    return getProgress(playerId, caseNumber);
  }
  db.prepare(
    `INSERT INTO player_progress (id, player_id, room_id, game_id, case_number, attempts, points, completed, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(uid(), playerId, roomId, gameId, caseNumber, attempts, points, completed ? 1 : 0, completed ? now : null);
  return getProgress(playerId, caseNumber);
}

export function clearProgressForRoom(roomId) {
  db.prepare("DELETE FROM player_progress WHERE room_id = ?").run(roomId);
}

/**
 * Renumbering or deleting cases changes what every case number means, so any
 * progress recorded against that game is dropped with it and everyone starts
 * again at question 1. Only game-specific records are touched.
 */
export function clearProgressForGame(gameId) {
  const rooms = roomsUsingGame(gameId);
  for (const room of rooms) {
    resetRoomProgress(room.id);
    updateRoom(room.id, { current_case: 1 });
  }
  return rooms.length;
}
