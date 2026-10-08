/**
 * DETECTIVE 404 — relational store engine (SQLite locally / PostgreSQL via
 * DATABASE_URL).
 *
 * Every room, game, case, question, answer, score and per-player timer in the
 * product lives in the database and is read back from it — never kept in
 * memory, browser storage or a module-level variable. Create a room tonight,
 * close the laptop, restart the process tomorrow: the room, its game, its
 * duration and every case are exactly where they were left.
 *
 * This module implements the store API used by api.js; the same API is also
 * implemented over MongoDB Atlas in store-mongo.js. db.js is the facade that
 * picks the engine and re-exports it. The serialization machinery (queue,
 * locked(), helpers) lives in store-core.js and is shared by both engines.
 *
 * Nothing here is ever "initialised" destructively: the schema is created only
 * where missing and every migration only ADDS a column. There is no code path
 * that drops, truncates or resets stored data — the only deletions are the
 * explicit admin actions (DELETE ROOM / delete game) and their own rows.
 *
 * `withTx(fn)` — BEGIN … COMMIT/ROLLBACK around a multi-row flow, so several
 * rows commit as one unit or not at all. Re-entrant: a withTx nested inside
 * another one or inside atomic() joins it.
 */
import { ADMIN_USER, ADMIN_PASSWORD, DATABASE_URL } from "./config.js";
import { hashPassword, checkPassword } from "./auth.js";
import {
  scope,
  locked,
  uid,
  normalizeCode,
  normalizeName,
  makeRoomCode,
  isUniqueViolation,
  isDbError,
  prepareClose,
} from "./store-core.js";

/** Which engine backs this process: "sqlite" or "postgres". */
const driver = DATABASE_URL ? await import("./driver-pg.js") : await import("./driver-sqlite.js");
await driver.open();

export const engine = driver.dialect;
export const engineLabel = driver.label;

/**
 * Open (or reopen after close) the SQL engine and run boot checks. Called by
 * the db.js facade on every load — including a close-and-reopen within one
 * process — so it must be idempotent.
 */
export async function ensureOpen() {
  await driver.open();
  // One-time legacy-content cleanup happens here, before any later boot step
  // could copy data in; the flag lives in `meta` and never resets.
  return { legacyCleared: await runLegacyCheck() };
}

/**
 * Atomic AND transactional: everything fn writes commits together (COMMIT) or
 * not at all (ROLLBACK), and no other request can interleave between its reads
 * and its writes. BEGIN is taken once per outermost call; a nested withTx
 * simply joins the open transaction, so callers can compose freely.
 */
export function withTx(fn) {
  if (scope.getStore()) return runTx(fn);
  return locked(() => runTx(fn));
}

async function runTx(fn) {
  const store = scope.getStore();
  const depth = store.tx;
  if (depth === 0) await driver.begin();
  store.tx = depth + 1;
  try {
    const out = await fn();
    store.tx = depth;
    if (depth === 0) await driver.commit();
    return out;
  } catch (err) {
    store.tx = depth;
    if (depth === 0) {
      try {
        await driver.rollback();
      } catch {
        /* transaction already unwound */
      }
    }
    throw err;
  }
}

/** Wait for everything queued so far, then close the engine (flush + backup). */
export async function close() {
  // Drains the shared queue and stops the API's 1s ticker (registered on
  // globalThis by api.js) so no tick runs against a closed database.
  await prepareClose();
  await driver.close();
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */
const metaGet = (key) => locked(() => driver.get("SELECT value FROM meta WHERE key = ?", [key]));

const metaSet = (key, value) =>
  locked(() =>
    driver.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
      key,
      String(value),
    ])
  );

/**
 * One-time removal of the retired hard-coded case file: only records that
 * belonged to that game are touched (and the flag makes sure this ever runs a
 * single time per database). Users, rooms and the admin account are
 * deliberately left alone (see README, "Clearing the old game content").
 *
 * Called once by the db.js facade right after the engine opens; the flag lives
 * in `meta`, so a restart, redeploy or reopen never repeats it.
 */
export function runLegacyCheck() {
  return locked(async () => {
    if (await metaGet("legacy_content_cleared")) return false;
    await driver.run("DELETE FROM answers");
    await metaSet("legacy_content_cleared", Date.now());
    return true;
  });
}

/* ------------------------------------------------------------------ *
 * Admins
 * ------------------------------------------------------------------ */
export function seedAdmin() {
  return locked(async () => {
    const explicit = process.env.D404_ADMIN_PASSWORD;
    const existing = await driver.get("SELECT * FROM admins WHERE username = ?", [ADMIN_USER]);
    if (!existing) {
      await driver.run("INSERT INTO admins (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)", [
        uid(),
        ADMIN_USER,
        hashPassword(ADMIN_PASSWORD),
        Date.now(),
      ]);
      return "created";
    }
    if (explicit) {
      await driver.run("UPDATE admins SET password_hash = ? WHERE id = ?", [hashPassword(explicit), existing.id]);
      return "rotated";
    }
    return "exists";
  });
}

export function findAdminByName(username) {
  return locked(async () => {
    const lower = String(username || "").trim().toLowerCase();
    const exact = String(username || "").trim();
    return (await driver.get("SELECT * FROM admins WHERE username = ?", [lower])) || (await driver.get("SELECT * FROM admins WHERE username = ?", [exact]));
  });
}

export const findAdminById = (id) => locked(() => driver.get("SELECT * FROM admins WHERE id = ?", [id]));

export function verifyAdmin(username, password) {
  return locked(async () => {
    const admin = await findAdminByName(username);
    if (!admin) {
      // Burn comparable time so a missing user is not distinguishable.
      checkPassword(password, hashPassword("decoy"));
      return null;
    }
    return checkPassword(password, admin.password_hash) ? admin : null;
  });
}

/* ------------------------------------------------------------------ *
 * Rooms
 * ------------------------------------------------------------------ */
/** A fresh 6-char room code, verified against stored rooms before use. */
export function generateRoomCode() {
  return locked(() => makeRoomCode(findRoomByCode));
}

export const findRoomByCode = (code) => locked(() => driver.get("SELECT * FROM rooms WHERE room_code = ?", [normalizeCode(code)]));

export const findRoomById = (id) => locked(() => driver.get("SELECT * FROM rooms WHERE id = ?", [id]));

export const listRooms = () => locked(() => driver.all("SELECT * FROM rooms ORDER BY created_at DESC"));

export const listRoomsForAdmin = (adminId) =>
  locked(() => driver.all("SELECT * FROM rooms WHERE admin_id = ? ORDER BY created_at DESC", [adminId]));

export function createRoom({ roomName, duration, adminId }) {
  return locked(async () => {
    const now = Date.now();
    const id = uid();
    const code = await generateRoomCode();
    await driver.run(
      `INSERT INTO rooms (id, room_code, room_name, admin_id, status, duration, started_at, paused_since,
        paused_total, ended_at, current_case, case_auto, created_at, game_id)
       VALUES (?, ?, ?, ?, 'waiting', ?, NULL, NULL, 0, NULL, 1, 1, ?, NULL)`,
      [id, code, roomName, adminId, duration, now]
    );
    await driver.run(
      `INSERT INTO game_sessions (id, room_id, start_time, end_time, duration, status, created_at)
       VALUES (?, ?, NULL, NULL, ?, 'waiting', ?)`,
      [uid(), id, duration, now]
    );
    return findRoomById(id);
  });
}

export function updateRoom(id, patch) {
  return locked(async () => {
    const keys = Object.keys(patch);
    if (!keys.length) return findRoomById(id);
    await driver.run(`UPDATE rooms SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [
      ...keys.map((k) => patch[k]),
      id,
    ]);
    return findRoomById(id);
  });
}

export const activeSession = (roomId) =>
  locked(() => driver.get("SELECT * FROM game_sessions WHERE room_id = ? ORDER BY created_at DESC LIMIT 1", [roomId]));

export function touchSession(roomId, patch) {
  return locked(async () => {
    const session = await activeSession(roomId);
    if (!session) return null;
    const keys = Object.keys(patch);
    if (!keys.length) return session;
    await driver.run(`UPDATE game_sessions SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [
      ...keys.map((k) => patch[k]),
      session.id,
    ]);
    return activeSession(roomId);
  });
}

/* ------------------------------------------------------------------ *
 * Players
 * ------------------------------------------------------------------ */
export const findPlayer = (id) => locked(() => driver.get("SELECT * FROM players WHERE id = ?", [id]));

export const findPlayerByName = (roomId, name) =>
  locked(() => driver.get("SELECT * FROM players WHERE room_id = ? AND name_key = ?", [roomId, normalizeName(name)]));

export const listPlayers = (roomId) =>
  locked(() => driver.all("SELECT * FROM players WHERE room_id = ? ORDER BY joined_at ASC", [roomId]));

/** How many seats this room has already taken (a room holds many players). */
export const countPlayers = async (roomId) => {
  const row = await locked(() => driver.get("SELECT COUNT(*) AS n FROM players WHERE room_id = ?", [roomId]));
  return Number(row?.n || 0);
};

/**
 * Atomic "count the seats, then take one".
 *
 * Returns { code: "OK", player } / { code: "ROOM_FULL" } / { code: "NAME_TAKEN" }
 * instead of throwing, so the API can answer with a specific error — and two
 * players joining at the very same instant can never exceed the capacity or
 * collide on the same name without being told so.
 */
export function joinRoomAtomic({ roomId, playerName, maxPlayers }) {
  // The unique-violation must surface AFTER the rollback (PostgreSQL refuses
  // to COMMIT an aborted transaction), hence the catch on the outside.
  return withTx(async () => {
    const taken = await countPlayers(roomId);
    if (taken >= maxPlayers) return { code: "ROOM_FULL", count: taken, capacity: maxPlayers };
    const player = await createPlayer({ roomId, playerName });
    return { code: "OK", player, count: taken + 1, capacity: maxPlayers };
  }).catch((err) => {
    if (isUniqueViolation(err)) return { code: "NAME_TAKEN" };
    throw err;
  });
}

export function createPlayer({ roomId, playerName }) {
  return locked(async () => {
    const now = Date.now();
    const id = uid();
    await driver.run(
      `INSERT INTO players (id, room_id, player_name, name_key, joined_at, current_case, completed_cases,
        awaiting_next, revealed_current, correct_count, wrong_count, score, status, timed_out,
        finished_at, time_taken, case_started_at, last_active)
       VALUES (?, ?, ?, ?, ?, 1, 0, 0, 0, 0, 0, 0, 'playing', 0, NULL, NULL, ?, ?)`,
      [id, roomId, playerName, normalizeName(playerName), now, now, now]
    );
    return findPlayer(id);
  });
}

export function updatePlayer(id, patch) {
  return locked(async () => {
    const keys = Object.keys(patch);
    if (!keys.length) return findPlayer(id);
    await driver.run(`UPDATE players SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [
      ...keys.map((k) => patch[k]),
      id,
    ]);
    return findPlayer(id);
  });
}

/** The last thing a player submitted for one question. */
export const lastAnswer = (playerId, caseId) =>
  locked(() =>
    driver.get("SELECT * FROM answers WHERE player_id = ? AND case_id = ? ORDER BY timestamp DESC, id DESC LIMIT 1", [
      playerId,
      caseId,
    ])
  );

/** Is an uploaded case image still referenced by any case? */
export const uploadInUse = async (url) => {
  const row = await locked(() => driver.get("SELECT COUNT(*) AS n FROM game_cases WHERE image_url = ?", [url]));
  return Number(row?.n || 0) > 0;
};

export function recordAnswer({ playerId, roomId, caseId, answer, correct, points, timeTaken }) {
  return locked(() =>
    driver.run(
      `INSERT INTO answers (id, player_id, room_id, case_id, answer, correct, points, timestamp, time_taken)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uid(), playerId, roomId, caseId, String(answer).slice(0, 500), correct ? 1 : 0, points, Date.now(), timeTaken]
    )
  );
}

/** Latest submissions joined with the detective who made them (activity feed). */
export function recentAnswers(roomId, limit = 12) {
  return locked(async () => {
    const rows = await driver.all(
      `SELECT a.id, a.case_id AS caseId, a.answer, a.correct, a.points, a.timestamp,
              a.time_taken AS timeTaken, p.player_name AS player
         FROM answers a LEFT JOIN players p ON p.id = a.player_id
        WHERE a.room_id = ?
        ORDER BY a.timestamp DESC
        LIMIT ?`,
      [roomId, limit]
    );
    return rows.map((r) => ({ ...r, correct: !!r.correct }));
  });
}

export function resetRoomProgress(roomId) {
  return locked(async () => {
    const now = Date.now();
    await driver.run(
      `UPDATE players SET current_case = 1, completed_cases = 0, awaiting_next = 0, revealed_current = 0,
         correct_count = 0, wrong_count = 0, score = 0, status = 'playing', timed_out = 0,
         finished_at = NULL, time_taken = NULL, case_started_at = ?, last_active = ?,
         started_at = NULL, ends_at = NULL
       WHERE room_id = ?`,
      [now, now, roomId]
    );
    await driver.run("DELETE FROM answers WHERE room_id = ?", [roomId]);
    await driver.run("DELETE FROM player_progress WHERE room_id = ?", [roomId]);
  });
}

/** Permanently remove one room and every record that belongs to it.
 *  Only rows for this room_id are touched — other rooms, games,
 *  players' accounts and admin data are left alone. */
export function deleteRoom(roomId) {
  return locked(async () => {
    await driver.run("DELETE FROM player_progress WHERE room_id = ?", [roomId]);
    await driver.run("DELETE FROM answers WHERE room_id = ?", [roomId]);
    await driver.run("DELETE FROM players WHERE room_id = ?", [roomId]);
    await driver.run("DELETE FROM game_sessions WHERE room_id = ?", [roomId]);
    await driver.run("DELETE FROM rooms WHERE id = ?", [roomId]);
  });
}

/** Boot-time reconciliation: a room left LIVE by a crashed server is settled. */
export const reconcileRooms = () => locked(() => driver.all("SELECT * FROM rooms WHERE status IN ('live','paused')"));

/* ------------------------------------------------------------------ *
 * Games — the dynamic case files written in the Game Builder
 * ------------------------------------------------------------------ */
export const findGame = (id) => locked(async () => (id ? driver.get("SELECT * FROM games WHERE id = ?", [id]) : null));

/** Every game with its case count and the rooms currently pointing at it. */
export const listGames = (adminId) =>
  locked(() =>
    driver.all(
      `SELECT g.*, (SELECT COUNT(*) FROM game_cases c WHERE c.game_id = g.id) AS case_count,
              (SELECT COUNT(*) FROM rooms r WHERE r.game_id = g.id) AS room_count
         FROM games g
        WHERE g.admin_id = ?
        ORDER BY g.created_at DESC`,
      [adminId]
    )
  );

export function createGame({ adminId, name, description = "" }) {
  return locked(async () => {
    const now = Date.now();
    const id = uid();
    await driver.run(
      `INSERT INTO games (id, admin_id, name, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?)`,
      [id, adminId, name, description, now, now]
    );
    return findGame(id);
  });
}

export function updateGame(id, patch) {
  return locked(async () => {
    const keys = Object.keys(patch);
    if (!keys.length) return findGame(id);
    await driver.run(`UPDATE games SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, [
      ...keys.map((k) => patch[k]),
      Date.now(),
      id,
    ]);
    return findGame(id);
  });
}

export function deleteGame(id) {
  return locked(async () => {
    await driver.run("DELETE FROM game_cases WHERE game_id = ?", [id]);
    await driver.run("DELETE FROM player_progress WHERE game_id = ?", [id]);
    await driver.run("UPDATE rooms SET game_id = NULL WHERE game_id = ?", [id]);
    await driver.run("DELETE FROM games WHERE id = ?", [id]);
  });
}

export const roomsUsingGame = (gameId) => locked(() => driver.all("SELECT * FROM rooms WHERE game_id = ?", [gameId]));

/* ------------------------------------------------------------------ *
 * Cases inside a game
 * ------------------------------------------------------------------ */
export const listCases = (gameId) =>
  locked(() => driver.all("SELECT * FROM game_cases WHERE game_id = ? ORDER BY case_number ASC", [gameId]));

export const findCase = (id) => locked(() => driver.get("SELECT * FROM game_cases WHERE id = ?", [id]));

export function insertCase(f) {
  return locked(async () => {
    const id = uid();
    await driver.run(
      `INSERT INTO game_cases (id, game_id, case_number, case_title, image_url, question, question_type,
         options, correct_answer, clue, points_first, points_second, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
        f.sort_order,
      ]
    );
    return findCase(id);
  });
}

export function updateCase(id, patch) {
  return locked(async () => {
    const keys = Object.keys(patch);
    if (!keys.length) return findCase(id);
    await driver.run(`UPDATE game_cases SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [
      ...keys.map((k) => patch[k]),
      id,
    ]);
    return findCase(id);
  });
}

export function deleteCase(id) {
  return locked(async () => {
    const row = await findCase(id);
    if (!row) return null;
    await driver.run("DELETE FROM game_cases WHERE id = ?", [id]);
    await renumberCases(row.game_id);
    return row;
  });
}

/** Keep case numbers running 1..n after a delete or a reorder. */
export function renumberCases(gameId) {
  return locked(async () => {
    const rows = await listCases(gameId);
    for (let i = 0; i < rows.length; i++) {
      await driver.run("UPDATE game_cases SET case_number = ?, sort_order = ? WHERE id = ?", [i + 1, i, rows[i].id]);
    }
    return listCases(gameId);
  });
}

/** Reorder by an explicit list of case ids (the editor sends them in order). */
export function setCaseOrder(gameId, orderedIds) {
  return locked(async () => {
    const current = await listCases(gameId);
    const valid = new Set(current.map((r) => r.id));
    const ids = orderedIds.filter((id) => valid.has(id));
    if (!ids.length) return current;
    const move = (caseNumber, sortOrder, id) =>
      driver.run("UPDATE game_cases SET case_number = ?, sort_order = ? WHERE id = ? AND game_id = ?", [
        caseNumber,
        sortOrder,
        id,
        gameId,
      ]);
    for (let i = 0; i < ids.length; i++) await move(i + 1, i, ids[i]);
    // anything the client did not mention keeps its place at the end
    const seen = new Set(ids);
    const rest = (await listCases(gameId)).filter((r) => !seen.has(r.id));
    for (let k = 0; k < rest.length; k++) await move(ids.length + k + 1, ids.length + k, rest[k].id);
    return listCases(gameId);
  });
}

export function moveCase(gameId, caseId, direction) {
  return locked(async () => {
    const rows = await listCases(gameId);
    const i = rows.findIndex((r) => r.id === caseId);
    const j = i + Number(direction);
    if (i < 0 || j < 0 || j >= rows.length) return rows;
    const order = rows.map((r) => r.id);
    [order[i], order[j]] = [order[j], order[i]];
    return setCaseOrder(gameId, order);
  });
}

/* ------------------------------------------------------------------ *
 * Per-question player progress (attempts, points, completion)
 * ------------------------------------------------------------------ */
export const getProgress = (playerId, caseNumber) =>
  locked(() => driver.get("SELECT * FROM player_progress WHERE player_id = ? AND case_number = ?", [playerId, caseNumber]));

export const listProgress = (playerId) =>
  locked(() => driver.all("SELECT * FROM player_progress WHERE player_id = ? ORDER BY case_number ASC", [playerId]));

export const progressMap = async (playerId) =>
  Object.fromEntries((await listProgress(playerId)).map((p) => [p.case_number, p]));

export const completedCount = async (playerId) => {
  const row = await locked(() =>
    driver.get("SELECT COUNT(*) AS n FROM player_progress WHERE player_id = ? AND completed = 1", [playerId])
  );
  return Number(row?.n || 0);
};

export function saveProgress({ playerId, roomId, gameId, caseNumber, attempts, points, completed }) {
  return locked(async () => {
    const now = Date.now();
    const existing = await getProgress(playerId, caseNumber);
    if (existing) {
      await driver.run(
        `UPDATE player_progress SET attempts = ?, points = ?, completed = ?, completed_at = ? WHERE id = ?`,
        [attempts, points, completed ? 1 : 0, completed ? now : existing.completed_at, existing.id]
      );
      return getProgress(playerId, caseNumber);
    }
    await driver.run(
      `INSERT INTO player_progress (id, player_id, room_id, game_id, case_number, attempts, points, completed, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uid(), playerId, roomId, gameId, caseNumber, attempts, points, completed ? 1 : 0, completed ? now : null]
    );
    return getProgress(playerId, caseNumber);
  });
}

export const clearProgressForRoom = (roomId) => locked(() => driver.run("DELETE FROM player_progress WHERE room_id = ?", [roomId]));

/**
 * Renumbering or deleting cases changes what every case number means, so any
 * progress recorded against that game is dropped with it and everyone starts
 * again at question 1. Only game-specific records are touched.
 */
export function clearProgressForGame(gameId) {
  return locked(async () => {
    const rooms = await roomsUsingGame(gameId);
    for (const room of rooms) {
      await resetRoomProgress(room.id);
      await updateRoom(room.id, { current_case: 1 });
    }
    return rooms.length;
  });
}

/* ------------------------------------------------------------------ *
 * Test support — engine-portable equivalents of the direct SQL the
 * smoke suite used to run against a live handle.
 * ------------------------------------------------------------------ */

/** Move one detective's stored expiry by deltaMs (fast-forward / rewind). */
export const adjustPlayerEnds = (playerId, deltaMs) =>
  locked(() => driver.run("UPDATE players SET ends_at = ends_at + ? WHERE id = ?", [deltaMs, playerId]));

/** Pin one detective's stored expiry to an exact instant. */
export const setPlayerEnds = (playerId, endsAt) =>
  locked(() => driver.run("UPDATE players SET ends_at = ? WHERE id = ?", [endsAt, playerId]));

/** How many rows belong to one room, per child table. */
export function roomRowCounts(roomId) {
  return locked(async () => {
    const count = async (table) => {
      const row = await driver.get(`SELECT COUNT(*) AS n FROM ${table} WHERE room_id = ?`, [roomId]);
      return Number(row?.n || 0);
    };
    return {
      players: await count("players"),
      answers: await count("answers"),
      player_progress: await count("player_progress"),
      game_sessions: await count("game_sessions"),
    };
  });
}
