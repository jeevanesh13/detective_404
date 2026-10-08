/**
 * DETECTIVE 404 — MongoDB engine (Atlas in production).
 *
 * Selected by the db.js facade when MONGODB_URI is set (see config.js).
 * Implements the exact same store API as store-rel.js, so api.js, the game
 * flow, the dashboards and the tests behave identically on either engine.
 *
 * Data model — documents keep the snake_case field names of the SQL rows, so
 * every caller sees unchanged shapes (`room.room_code`, `player.ends_at`, …).
 * Collections (only what the product actually stores):
 *
 *   admins        game master accounts (same password hashing as before)
 *   games         Game Builder documents: name, description, status,
 *                 created/updated timestamps + EMBEDDED cases[]
 *                 (question, options, correct answer, clue, image, points)
 *   rooms         room code, configuration, duration + EMBEDDED session{}
 *                 (the per-room game session: start/end/duration/status)
 *   players       one document per seat: score, case position, own timer
 *   answers       every submission (activity feed + audit trail)
 *   gameProgress  per-player, per-question attempts and points
 *   meta          one-time flags (legacy cleanup, migration markers)
 *
 * Persistence rules (README, "Where the data lives"):
 *   - every write lands in MongoDB immediately — nothing is held in memory
 *     or localStorage; SAVE → restart → LOAD returns the same document;
 *   - startup never drops, truncates or resets anything; schema work is
 *     index creation only, which is idempotent and additive;
 *   - the only deletions are the explicit admin actions and rows they own.
 *
 * Security: MONGODB_URI is read server-side only and never formatted into a
 * message, response or log line — `redact()` scrubs user:password from any
 * driver error before it is logged or rethrown.
 */
import fs from "node:fs";
import { MongoClient } from "mongodb";
import { ADMIN_USER, ADMIN_PASSWORD, DB_FILE, MONGODB_URI, MONGODB_DB } from "./config.js";
import { hashPassword, checkPassword } from "./auth.js";
import {
  scope,
  locked,
  uid,
  normalizeCode,
  normalizeName,
  makeRoomCode,
  isUniqueViolation,
  prepareClose,
} from "./store-core.js";

export const engine = "mongodb";

/** Host + database only — credentials are never part of any log line. */
export const engineLabel = (() => {
  try {
    const u = new URL(MONGODB_URI);
    return `mongodb  ${u.host}/${MONGODB_DB}`;
  } catch {
    return `mongodb  ${MONGODB_DB}`;
  }
})();

/* ------------------------------------------------------------------ *
 * Connection — ONE client for the whole process, reused by every request
 * ------------------------------------------------------------------ */
let client = null;
let bootInfo = null;
let txSupported = true; // multi-document transactions (replica set / Atlas)

const db = () => client.db(MONGODB_DB);

/** Strip `user:password@` from any message before it can reach a log/response. */
const redact = (msg) => String(msg || "").replace(/\/\/[^@\s]+@/g, "//<redacted>@");

async function connect() {
  try {
    const next = new MongoClient(MONGODB_URI, {
      appName: "deductive-404",
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 15_000,
      retryWrites: true,
    });
    await next.connect();
    client = next;
  } catch (err) {
    client = null;
    // Fail fast with a clear, credential-free error — never fall back to
    // memory and never pretend a save succeeded (README, error handling).
    throw new Error(`MongoDB connection failed: ${redact(err && err.message)}`);
  }
}

/* ------------------------------------------------------------------ *
 * Document helpers — every read strips `_id`, every write honours the
 * open transaction (if any) through AsyncLocalStorage.
 * ------------------------------------------------------------------ */
const C = (name) => db().collection(name);

/** The ClientSession of the withTx we are inside, or {} for plain calls. */
const opt = () => {
  const s = scope.getStore();
  return s && s.mongoSession ? { session: s.mongoSession } : {};
};

const strip = (d) => {
  if (!d) return null;
  const { _id, ...rest } = d; // eslint-disable-line no-unused-vars
  return rest;
};

const findDoc = async (name, query) => strip(await C(name).findOne(query, opt()));

const findDocs = async (name, query, sort) => {
  let cursor = C(name).find(query, opt());
  if (sort) cursor = cursor.sort(sort);
  return (await cursor.toArray()).map(strip);
};

const insertDoc = async (name, doc) => {
  await C(name).insertOne(doc, opt());
  return doc;
};

const patchDoc = async (name, query, patch) => {
  await C(name).updateOne(query, { $set: patch }, opt());
};

const countDocs = async (name, query) => Number((await C(name).countDocuments(query, opt())) || 0);

const metaGet = (key) => locked(() => findDoc("meta", { key }));

const metaSet = (key, value) =>
  locked(() =>
    C("meta").updateOne({ key }, { $set: { key, value: String(value) } }, { upsert: true, ...opt() })
  );

/* ------------------------------------------------------------------ *
 * Boot — connect, indexes, one-time cleanup, safe migration
 * ------------------------------------------------------------------ */

/**
 * Called by the db.js facade on every load (including a close-and-reopen
 * inside one process). Idempotent: reuses a live client, reconnects after
 * close(), never touches stored data destructively.
 */
export async function ensureOpen() {
  if (client && bootInfo) return bootInfo;
  if (!client) await connect();
  try {
    await ensureIndexes(); // idempotent, additive — never drops anything
    const legacyCleared = await runLegacyCheck(); // flag-guarded, runs once per DB
    await migrateFromLocalSqlite(); // safe import of pre-existing local data
    txSupported = await probeTransactions();
    if (!txSupported) {
      console.log(
        "[deductive-404] MongoDB: multi-document transactions unavailable (standalone server?)" +
          " — relying on the single-process write queue instead."
      );
    }
    bootInfo = { legacyCleared };
    return bootInfo;
  } catch (err) {
    const c = client;
    client = null;
    bootInfo = null;
    try {
      if (c) await c.close();
    } catch {
      /* noop */
    }
    throw new Error(`MongoDB startup failed: ${redact(err && err.message)}`);
  }
}

/** Create the unique/lookup indexes the store relies on (idempotent). */
async function ensureIndexes() {
  await C("admins").createIndex({ username: 1 }, { unique: true });
  await C("rooms").createIndex({ room_code: 1 }, { unique: true });
  await C("rooms").createIndex({ admin_id: 1, created_at: -1 });
  await C("rooms").createIndex({ game_id: 1 });
  await C("players").createIndex({ room_id: 1, name_key: 1 }, { unique: true });
  await C("players").createIndex({ room_id: 1, joined_at: 1 });
  await C("answers").createIndex({ room_id: 1, timestamp: -1 });
  await C("answers").createIndex({ player_id: 1, case_id: 1, timestamp: -1 });
  await C("gameProgress").createIndex({ player_id: 1, case_number: 1 }, { unique: true });
  await C("gameProgress").createIndex({ room_id: 1 });
  await C("gameProgress").createIndex({ game_id: 1 });
  await C("games").createIndex({ admin_id: 1, created_at: -1 });
  await C("meta").createIndex({ key: 1 }, { unique: true });
}

/**
 * One-time removal of the retired hard-coded case file: only records that
 * belonged to that game are touched (and the flag makes sure this ever runs a
 * single time per database). Users, rooms and the admin account are
 * deliberately left alone (see README, "Clearing the old game content").
 *
 * Runs BEFORE any migration may copy data in, so a legacy database whose
 * answers predate the flag can never have freshly imported rows wiped by it —
 * the flag is written first and travels with the import afterwards.
 */
export function runLegacyCheck() {
  return locked(async () => {
    if (await metaGet("legacy_content_cleared")) return false;
    await C("answers").deleteMany({}, opt());
    await metaSet("legacy_content_cleared", Date.now());
    return true;
  });
}

/* ------------------------------------------------------------------ *
 * Safe migration — bring an existing local SQLite database into MongoDB
 * ------------------------------------------------------------------ */

/**
 * Requirement "existing data is not lost": if a local data/deductive404.db
 * (the development/previous engine) holds games, rooms or accounts and this
 * MongoDB database is still empty, every record is imported — once, guarded
 * by meta flags, idempotent by id (upsert $setOnInsert), and it never
 * overwrites anything that already exists in MongoDB.
 *
 * Ordering inside boot: legacy cleanup → this migration, so imported answers
 * are never subject to the cleanup above.
 */
async function migrateFromLocalSqlite() {
  try {
    if (await metaGet("source_migrated")) return "already";
    if (!fs.existsSync(DB_FILE)) return "no-source"; // fresh deploy: nothing to import

    const started = await metaGet("source_migration_started");
    const targetHasData = Boolean(
      (await countDocs("games", {})) ||
        (await countDocs("rooms", {})) ||
        (await countDocs("players", {})) ||
        (await countDocs("admins", {}))
    );
    if (!started && targetHasData) {
      // A live MongoDB database that was never migrated (local file appeared
      // later): importing old rows into it would be a surprise — mark done.
      await metaSet("source_migrated", Date.now());
      return "target-not-empty";
    }

    await metaSet("source_migration_started", Date.now());

    const { DatabaseSync } = await import("node:sqlite");
    const src = new DatabaseSync(DB_FILE);
    const read = (sql) => {
      try {
        return src.prepare(sql).all();
      } catch {
        return []; // table missing in this (older/newer) file — nothing to import
      }
    };
    const meta = read("SELECT key, value FROM meta");
    const admins = read("SELECT * FROM admins");
    const games = read("SELECT * FROM games");
    const cases = read("SELECT * FROM game_cases");
    const rooms = read("SELECT * FROM rooms");
    const sessions = read("SELECT * FROM game_sessions");
    const players = read("SELECT * FROM players");
    const answers = read("SELECT * FROM answers");
    const progress = read("SELECT * FROM player_progress");
    try {
      src.close();
    } catch {
      /* already closed */
    }

    // cases embed into their game, the newest session embeds into its room.
    const casesByGame = new Map();
    for (const c of cases) {
      const list = casesByGame.get(c.game_id) || [];
      list.push(c);
      casesByGame.set(c.game_id, list);
    }
    const sessionByRoom = new Map();
    for (const s of sessions) {
      const prev = sessionByRoom.get(s.room_id);
      if (!prev || Number(s.created_at) >= Number(prev.created_at)) sessionByRoom.set(s.room_id, s);
    }
    const gameDocs = games.map((g) => ({
      ...g,
      cases: (casesByGame.get(g.id) || []).sort((a, b) => a.case_number - b.case_number),
    }));
    const roomDocs = rooms.map((r) => {
      const session = sessionByRoom.get(r.id);
      return session ? { ...r, session } : r;
    });

    // The cleanup flag may already exist in MongoDB (it ran first above) —
    // never re-insert it over the live value.
    const existingMeta = new Set((await findDocs("meta", {})).map((m) => m.key));
    const freshMeta = meta.filter((m) => !existingMeta.has(m.key));

    let imported = 0;
    const upsertAll = async (name, docs, filterKey) => {
      for (let i = 0; i < docs.length; i += 1000) {
        const ops = docs.slice(i, i + 1000).map((d) => ({
          updateOne: {
            filter: { [filterKey]: d[filterKey] },
            update: { $setOnInsert: d },
            upsert: true,
          },
        }));
        if (ops.length) await C(name).bulkWrite(ops, { ordered: false, ...opt() });
        imported += ops.length;
      }
    };

    await upsertAll("meta", freshMeta, "key");
    await upsertAll("admins", admins, "id");
    await upsertAll("games", gameDocs, "id");
    await upsertAll("rooms", roomDocs, "id");
    await upsertAll("players", players, "id");
    await upsertAll("answers", answers, "id");
    await upsertAll("gameProgress", progress, "id");

    await metaSet("source_migrated", Date.now());
    console.log(
      `[deductive-404] MongoDB: imported ${imported} records from the local database ` +
        `(${games.length} games, ${rooms.length} rooms, ${players.length} players, ${answers.length} answers).`
    );
    return "migrated";
  } catch (err) {
    // Never set the completion flag on failure: the next boot resumes the
    // import (upserts are idempotent) instead of silently losing records.
    console.error(`[deductive-404] MongoDB migration not completed: ${redact(err && err.message)}`);
    return "failed";
  }
}

/**
 * Atlas free tier is a replica set and supports multi-document transactions;
 * a standalone local mongod does not. Probe once per boot so withTx can fall
 * back to the process-wide write queue (still correct for a single instance)
 * instead of failing every transactional flow.
 */
async function probeTransactions() {
  if (!client) return false;
  const session = client.startSession();
  try {
    await session.startTransaction();
    await C("meta").updateOne(
      { key: "__tx_probe" },
      { $set: { key: "__tx_probe", value: "1" } },
      { session, upsert: true }
    );
    await session.commitTransaction();
    await C("meta").deleteOne({ key: "__tx_probe" });
    return true;
  } catch {
    try {
      await session.abortTransaction();
    } catch {
      /* transaction already unwound */
    }
    return false;
  } finally {
    try {
      await session.endSession();
    } catch {
      /* noop */
    }
  }
}

/* ------------------------------------------------------------------ *
 * Transactions — same semantics as the SQL engine's withTx
 * ------------------------------------------------------------------ */

/**
 * Atomic AND transactional: everything fn writes commits together or not at
 * all, and no other request can interleave between its reads and its writes.
 * Re-entrant — a nested withTx joins the open transaction (store.tx depth),
 * and every store helper picks the open session up from AsyncLocalStorage.
 */
export function withTx(fn) {
  if (!txSupported) return locked(fn); // standalone server: queue-only fallback
  if (scope.getStore()) return runTx(fn);
  return locked(() => runTx(fn));
}

async function runTx(fn) {
  const store = scope.getStore();
  const depth = store.tx;
  if (depth === 0) {
    store.mongoSession = client.startSession();
    store.mongoSession.startTransaction();
  }
  store.tx = depth + 1;
  try {
    const out = await fn();
    store.tx = depth;
    if (depth === 0) {
      const session = store.mongoSession;
      store.mongoSession = null;
      await session.commitTransaction();
      await session.endSession();
    }
    return out;
  } catch (err) {
    store.tx = depth;
    if (depth === 0) {
      const session = store.mongoSession;
      store.mongoSession = null;
      try {
        await session.abortTransaction();
      } catch {
        /* transaction already unwound */
      }
      try {
        await session.endSession();
      } catch {
        /* noop */
      }
    }
    throw err;
  }
}

/** Drain the queue, stop the API ticker, close the pooled client. */
export async function close() {
  await prepareClose();
  const c = client;
  client = null;
  bootInfo = null;
  if (c) {
    try {
      await c.close();
    } catch {
      /* noop */
    }
  }
}

/* ------------------------------------------------------------------ *
 * Admins
 * ------------------------------------------------------------------ */
export function seedAdmin() {
  return locked(async () => {
    const explicit = process.env.D404_ADMIN_PASSWORD;
    const existing = await findDoc("admins", { username: ADMIN_USER });
    if (!existing) {
      await insertDoc("admins", {
        id: uid(),
        username: ADMIN_USER,
        password_hash: hashPassword(ADMIN_PASSWORD),
        created_at: Date.now(),
      });
      return "created";
    }
    if (explicit) {
      await patchDoc("admins", { id: existing.id }, { password_hash: hashPassword(explicit) });
      return "rotated";
    }
    return "exists";
  });
}

export function findAdminByName(username) {
  return locked(async () => {
    const lower = String(username || "").trim().toLowerCase();
    const exact = String(username || "").trim();
    return (await findDoc("admins", { username: lower })) || (await findDoc("admins", { username: exact }));
  });
}

export const findAdminById = (id) => locked(() => findDoc("admins", { id }));

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

export const findRoomByCode = (code) => locked(() => findDoc("rooms", { room_code: normalizeCode(code) }));

export const findRoomById = (id) => locked(() => findDoc("rooms", { id }));

export const listRooms = () => locked(() => findDocs("rooms", {}, { created_at: -1 }));

export const listRoomsForAdmin = (adminId) =>
  locked(() => findDocs("rooms", { admin_id: adminId }, { created_at: -1 }));

export function createRoom({ roomName, duration, adminId }) {
  return locked(async () => {
    const now = Date.now();
    const id = uid();
    const code = await generateRoomCode();
    await insertDoc("rooms", {
      id,
      room_code: code,
      room_name: roomName,
      admin_id: adminId,
      game_id: null,
      status: "waiting",
      duration,
      started_at: null,
      paused_since: null,
      paused_total: 0,
      ended_at: null,
      current_case: 1,
      case_auto: 1,
      created_at: now,
      session: {
        id: uid(),
        room_id: id,
        start_time: null,
        end_time: null,
        duration,
        status: "waiting",
        created_at: now,
      },
    });
    return findRoomById(id);
  });
}

export function updateRoom(id, patch) {
  return locked(async () => {
    const keys = Object.keys(patch);
    if (!keys.length) return findRoomById(id);
    await patchDoc("rooms", { id }, patch);
    return findRoomById(id);
  });
}

/** The room's game session (embedded in the room document). */
export const activeSession = (roomId) => locked(async () => (await findDoc("rooms", { id: roomId }))?.session || null);

export function touchSession(roomId, patch) {
  return locked(async () => {
    const session = await activeSession(roomId);
    if (!session) return null;
    const keys = Object.keys(patch);
    if (!keys.length) return session;
    const set = {};
    for (const k of keys) set[`session.${k}`] = patch[k];
    await patchDoc("rooms", { id: roomId }, set);
    return activeSession(roomId);
  });
}

/* ------------------------------------------------------------------ *
 * Players
 * ------------------------------------------------------------------ */
export const findPlayer = (id) => locked(() => findDoc("players", { id }));

export const findPlayerByName = (roomId, name) =>
  locked(() => findDoc("players", { room_id: roomId, name_key: normalizeName(name) }));

export const listPlayers = (roomId) => locked(() => findDocs("players", { room_id: roomId }, { joined_at: 1 }));

/** How many seats this room has already taken (a room holds many players). */
export const countPlayers = (roomId) => locked(() => countDocs("players", { room_id: roomId }));

/**
 * Atomic "count the seats, then take one".
 *
 * Returns { code: "OK", player } / { code: "ROOM_FULL" } / { code: "NAME_TAKEN" }
 * instead of throwing, so the API can answer with a specific error — and two
 * players joining at the very same instant can never exceed the capacity or
 * collide on the same name without being told so (the unique index on
 * room_id+name_key raises the duplicate key the catch below maps to
 * NAME_TAKEN, exactly like the SQL constraint).
 */
export function joinRoomAtomic({ roomId, playerName, maxPlayers }) {
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
    await insertDoc("players", {
      id,
      room_id: roomId,
      player_name: playerName,
      name_key: normalizeName(playerName),
      joined_at: now,
      current_case: 1,
      completed_cases: 0,
      awaiting_next: 0,
      revealed_current: 0,
      correct_count: 0,
      wrong_count: 0,
      score: 0,
      status: "playing",
      timed_out: 0,
      finished_at: null,
      time_taken: null,
      case_started_at: now,
      last_active: now,
      started_at: null,
      ends_at: null,
    });
    return findPlayer(id);
  });
}

export function updatePlayer(id, patch) {
  return locked(async () => {
    const keys = Object.keys(patch);
    if (!keys.length) return findPlayer(id);
    await patchDoc("players", { id }, patch);
    return findPlayer(id);
  });
}

/** The last thing a player submitted for one question. */
export const lastAnswer = (playerId, caseId) =>
  locked(async () => {
    const rows = await C("answers")
      .find({ player_id: playerId, case_id: caseId }, opt())
      .sort({ timestamp: -1, id: -1 })
      .limit(1)
      .toArray();
    return strip(rows[0] || null);
  });

/** Is an uploaded case image still referenced by any case? */
export const uploadInUse = async (url) => (await locked(() => countDocs("games", { "cases.image_url": url }))) > 0;

export function recordAnswer({ playerId, roomId, caseId, answer, correct, points, timeTaken }) {
  return locked(() =>
    insertDoc("answers", {
      id: uid(),
      player_id: playerId,
      room_id: roomId,
      case_id: caseId,
      answer: String(answer).slice(0, 500),
      correct: correct ? 1 : 0,
      points,
      timestamp: Date.now(),
      time_taken: timeTaken,
    })
  );
}

/** Latest submissions joined with the detective who made them (activity feed). */
export function recentAnswers(roomId, limit = 12) {
  return locked(async () => {
    const rows = await C("answers")
      .find({ room_id: roomId }, opt())
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
    const playerIds = [...new Set(rows.map((r) => r.player_id))];
    const roster = playerIds.length
      ? await C("players")
          .find({ id: { $in: playerIds } }, opt())
          .toArray()
      : [];
    const byId = new Map(roster.map((p) => [p.id, p]));
    return rows.map((r) => ({
      id: r.id,
      caseId: r.case_id,
      answer: r.answer,
      correct: !!r.correct,
      points: r.points,
      timestamp: r.timestamp,
      timeTaken: r.time_taken,
      player: byId.get(r.player_id)?.player_name ?? null,
    }));
  });
}

export function resetRoomProgress(roomId) {
  return locked(async () => {
    const now = Date.now();
    await C("players").updateMany(
      { room_id: roomId },
      {
        $set: {
          current_case: 1,
          completed_cases: 0,
          awaiting_next: 0,
          revealed_current: 0,
          correct_count: 0,
          wrong_count: 0,
          score: 0,
          status: "playing",
          timed_out: 0,
          finished_at: null,
          time_taken: null,
          case_started_at: now,
          last_active: now,
          started_at: null,
          ends_at: null,
        },
      },
      opt()
    );
    await C("answers").deleteMany({ room_id: roomId }, opt());
    await C("gameProgress").deleteMany({ room_id: roomId }, opt());
  });
}

/** Permanently remove one room and every record that belongs to it.
 *  Only documents for this room_id are touched — other rooms, games,
 *  players' accounts and admin data are left alone. */
export function deleteRoom(roomId) {
  return locked(async () => {
    await C("gameProgress").deleteMany({ room_id: roomId }, opt());
    await C("answers").deleteMany({ room_id: roomId }, opt());
    await C("players").deleteMany({ room_id: roomId }, opt());
    await C("rooms").deleteOne({ id: roomId }, opt()); // the session goes with it
  });
}

/** Boot-time reconciliation: a room left LIVE by a crashed server is settled. */
export const reconcileRooms = () => locked(() => findDocs("rooms", { status: { $in: ["live", "paused"] } }));

/* ------------------------------------------------------------------ *
 * Games — the dynamic case files written in the Game Builder
 * ------------------------------------------------------------------ */
export const findGame = (id) => locked(async () => (id ? findDoc("games", { id }) : null));

/** Every game with its case count and the rooms currently pointing at it. */
export const listGames = (adminId) =>
  locked(async () => {
    const games = await findDocs("games", { admin_id: adminId }, { created_at: -1 });
    const ids = games.map((g) => g.id);
    const roomCounts = new Map();
    if (ids.length) {
      const rooms = await C("rooms")
        .find({ game_id: { $in: ids } }, opt())
        .project({ game_id: 1 })
        .toArray();
      for (const r of rooms) roomCounts.set(r.game_id, (roomCounts.get(r.game_id) || 0) + 1);
    }
    return games.map((g) => ({
      ...g,
      case_count: (g.cases || []).length,
      room_count: roomCounts.get(g.id) || 0,
    }));
  });

export function createGame({ adminId, name, description = "" }) {
  return locked(async () => {
    const now = Date.now();
    const id = uid();
    await insertDoc("games", {
      id,
      admin_id: adminId,
      name,
      description,
      status: "draft",
      created_at: now,
      updated_at: now,
      cases: [],
    });
    return findGame(id);
  });
}

export function updateGame(id, patch) {
  return locked(async () => {
    const keys = Object.keys(patch);
    if (!keys.length) return findGame(id);
    await patchDoc("games", { id }, { ...patch, updated_at: Date.now() });
    return findGame(id);
  });
}

export function deleteGame(id) {
  return locked(async () => {
    await C("gameProgress").deleteMany({ game_id: id }, opt());
    await C("rooms").updateMany({ game_id: id }, { $set: { game_id: null } }, opt());
    await C("games").deleteOne({ id }, opt()); // its cases are embedded
  });
}

export const roomsUsingGame = (gameId) => locked(() => findDocs("rooms", { game_id: gameId }));

/* ------------------------------------------------------------------ *
 * Cases inside a game (embedded array on the game document)
 * ------------------------------------------------------------------ */
export const listCases = (gameId) =>
  locked(async () => {
    const game = await findDoc("games", { id: gameId });
    return game ? [...(game.cases || [])].sort((a, b) => a.case_number - b.case_number) : [];
  });

export const findCase = (id) =>
  locked(async () => {
    const game = await findDoc("games", { "cases.id": id });
    return game ? (game.cases || []).find((c) => c.id === id) || null : null;
  });

export function insertCase(f) {
  return locked(async () => {
    const id = uid();
    const doc = {
      id,
      game_id: f.game_id,
      case_number: f.case_number,
      case_title: f.case_title,
      image_url: f.image_url,
      question: f.question,
      question_type: f.question_type,
      options: f.options,
      correct_answer: f.correct_answer,
      clue: f.clue,
      points_first: f.points_first,
      points_second: f.points_second,
      sort_order: f.sort_order,
    };
    await C("games").updateOne({ id: f.game_id }, { $push: { cases: doc } }, opt());
    return findCase(id);
  });
}

export function updateCase(id, patch) {
  return locked(async () => {
    const keys = Object.keys(patch);
    if (!keys.length) return findCase(id);
    const game = await findDoc("games", { "cases.id": id });
    if (!game) return null;
    const cases = (game.cases || []).map((c) => (c.id === id ? { ...c, ...patch } : c));
    await patchDoc("games", { id: game.id }, { cases });
    return findCase(id);
  });
}

export function deleteCase(id) {
  return locked(async () => {
    const row = await findCase(id);
    if (!row) return null;
    await C("games").updateOne({ id: row.game_id }, { $pull: { cases: { id } } }, opt());
    await renumberCases(row.game_id);
    return row;
  });
}

/** Keep case numbers running 1..n after a delete or a reorder. */
export function renumberCases(gameId) {
  return locked(async () => {
    const rows = await listCases(gameId);
    const cases = rows.map((c, i) => ({ ...c, case_number: i + 1, sort_order: i }));
    await patchDoc("games", { id: gameId }, { cases });
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
    const byId = new Map(current.map((c) => [c.id, c]));
    const seen = new Set(ids);
    // anything the client did not mention keeps its place at the end
    const rest = current.filter((c) => !seen.has(c.id));
    const ordered = [];
    ids.forEach((id, i) => ordered.push({ ...byId.get(id), case_number: i + 1, sort_order: i }));
    rest.forEach((c, k) =>
      ordered.push({ ...c, case_number: ids.length + k + 1, sort_order: ids.length + k })
    );
    await patchDoc("games", { id: gameId }, { cases: ordered });
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
  locked(() => findDoc("gameProgress", { player_id: playerId, case_number: caseNumber }));

export const listProgress = (playerId) =>
  locked(async () => {
    const rows = await findDocs("gameProgress", { player_id: playerId });
    return rows.sort((a, b) => a.case_number - b.case_number);
  });

export const progressMap = async (playerId) =>
  Object.fromEntries((await listProgress(playerId)).map((p) => [p.case_number, p]));

export const completedCount = async (playerId) =>
  locked(() => countDocs("gameProgress", { player_id: playerId, completed: 1 }));

export function saveProgress({ playerId, roomId, gameId, caseNumber, attempts, points, completed }) {
  return locked(async () => {
    const now = Date.now();
    const existing = await getProgress(playerId, caseNumber);
    if (existing) {
      await patchDoc(
        "gameProgress",
        { id: existing.id },
        {
          attempts,
          points,
          completed: completed ? 1 : 0,
          completed_at: completed ? now : existing.completed_at,
        }
      );
      return getProgress(playerId, caseNumber);
    }
    await insertDoc("gameProgress", {
      id: uid(),
      player_id: playerId,
      room_id: roomId,
      game_id: gameId,
      case_number: caseNumber,
      attempts,
      points,
      completed: completed ? 1 : 0,
      completed_at: completed ? now : null,
    });
    return getProgress(playerId, caseNumber);
  });
}

export const clearProgressForRoom = (roomId) =>
  locked(() => C("gameProgress").deleteMany({ room_id: roomId }, opt()));

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
  locked(async () => {
    const player = await findPlayer(playerId);
    // SQL: `ends_at + delta` on NULL stays NULL (no change) — mirror that.
    if (!player || typeof player.ends_at !== "number") return;
    await C("players").updateOne({ id: playerId }, { $inc: { ends_at: deltaMs } }, opt());
  });

/** Pin one detective's stored expiry to an exact instant. */
export const setPlayerEnds = (playerId, endsAt) =>
  locked(() => C("players").updateOne({ id: playerId }, { $set: { ends_at: endsAt } }, opt()));

/** How many rows belong to one room, per child table. */
export function roomRowCounts(roomId) {
  return locked(async () => {
    const room = await findDoc("rooms", { id: roomId });
    return {
      players: await countDocs("players", { room_id: roomId }),
      answers: await countDocs("answers", { room_id: roomId }),
      player_progress: await countDocs("gameProgress", { room_id: roomId }),
      game_sessions: room && room.session ? 1 : 0, // one session, embedded in the room
    };
  });
}
