/**
 * DETECTIVE 404 — store core: everything about the store that is NOT tied to
 * one database engine.
 *
 * Two engines implement the same store API (selected by the environment, see
 * config.js):
 *
 *   store-rel.js    SQLite (local dev) / PostgreSQL (DATABASE_URL)
 *   store-mongo.js  MongoDB Atlas (MONGODB_URI) — the production source of truth
 *
 * Both engines share the serialization machinery below, so the API layer on
 * top of the store (api.js) behaves identically no matter which database is
 * configured. `db.js` is the facade that picks the engine and re-exports it.
 *
 * Concurrency
 * -----------
 * The API is plain async code, so two requests could otherwise interleave
 * inside a read-modify-write flow (a double-clicked SAVE racing another SAVE
 * would write two rows). Every store entry point therefore runs through one
 * process-wide FIFO queue: calls execute strictly one after another, in the
 * order they were issued. `AsyncLocalStorage` marks "this async chain already
 * holds the lock" so that helpers called from inside an entry point (e.g.
 * `findRoomByCode` inside `createRoom`) compose on the same call instead of
 * deadlocking behind it.
 */
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

/** The lock's own state: { tx: 0 } normally; tx counts nested withTx depth. */
export const scope = new AsyncLocalStorage();

/** FIFO chain — every entry point is appended here and runs in order. */
let queue = Promise.resolve();

/**
 * Run `fn` with exclusive access to the store. Re-entrant: if the current
 * async chain already holds the lock the function composes instead of queueing
 * (which would deadlock against its own outer call).
 */
export function locked(fn) {
  if (scope.getStore()) return fn();
  const run = queue.then(() => scope.run({ tx: 0 }, fn), () => scope.run({ tx: 0 }, fn));
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Alias kept for the API layer: a locked read-modify-write unit. */
export const atomic = locked;

/** Wait until everything queued so far has finished (used before close). */
export async function drainQueue() {
  try {
    await queue;
  } catch {
    /* a failed queued call must not block shutdown */
  }
}

/**
 * Graceful-close preamble shared by every engine: drain the queue, then stop
 * the API's 1s ticker (registered on globalThis by api.js) so no tick can run
 * against a closed database.
 */
export async function prepareClose() {
  await drainQueue();
  try {
    if (globalThis.__d404Ticker) {
      clearInterval(globalThis.__d404Ticker);
      globalThis.__d404Ticker = null;
    }
  } catch {
    /* noop */
  }
}

/* ------------------------------------------------------------------ *
 * Pure helpers shared by every engine
 * ------------------------------------------------------------------ */

export const uid = () => crypto.randomUUID();

export const normalizeCode = (code) => String(code || "").trim().toUpperCase();

export const normalizeName = (name) =>
  String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1

/**
 * Pick a room code that `lookup` confirms is free. `lookup` is the engine's
 * own findRoomByCode, so uniqueness is checked against real stored data.
 */
export async function makeRoomCode(lookup) {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = "";
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (!(await lookup(code))) return code;
  }
  return crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
}

/* ------------------------------------------------------------------ *
 * Error classification (used by api.js to answer 409/500 correctly)
 * ------------------------------------------------------------------ */

/** Constraint failures: duplicate room name in a room, duplicate key, … */
export function isUniqueViolation(err) {
  if (!err) return false;
  const code = String(err.code || "");
  const msg = String(err.message || "");
  return (
    code.includes("SQLITE_CONSTRAINT") ||
    err.errcode === 2067 ||
    err.errcode === 1555 ||
    /UNIQUE constraint failed/i.test(msg) ||
    code === "23505" || // postgres unique_violation
    /duplicate key value/i.test(msg) ||
    code === "11000" || // MongoDB duplicate key (E11000)
    code === "11001" ||
    err.codeName === "DuplicateKey"
  );
}

/** Any failure that originated in the database layer (-> 500, logged). */
export function isDbError(err) {
  if (!err) return false;
  if (isUniqueViolation(err)) return true;
  const code = String(err.code || "");
  const msg = String(err.message || "");
  if (code.startsWith("SQLITE_") || /SQLITE_/i.test(msg)) return true;
  if (/^[0-9A-Z]{5}$/.test(code)) return true; // SQLSTATE
  if (/^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE)$/.test(code)) return true;
  // MongoDB driver errors: MongoServerError, MongoNetworkError, MongoServerSelectionError, …
  if (/^Mongo[A-Z]/.test(String(err.name || ""))) return true;
  if (/duplicate key value|Mongo.* timed out|Server selection timed out/i.test(msg)) return true;
  return /postgres|relation .* does not exist|column .* does not exist|pg_/i.test(msg);
}
