/**
 * DETECTIVE 404 — the store facade.
 *
 * One API, two engines. Everything the product persists (rooms, games, cases,
 * questions, answers, scores, per-player timers, admin accounts) is read and
 * written through this module — never kept in memory, localStorage or a
 * temporary file. The engine is chosen once, from the environment:
 *
 *   MONGODB_URI set     → store-mongo.js — MongoDB Atlas, the production
 *                         source of truth (SAVE → MongoDB → restart → LOAD
 *                         returns the same game, verified by npm test).
 *   otherwise           → store-rel.js   — SQLite locally, PostgreSQL when
 *                         DATABASE_URL is set (unchanged dev/test behaviour).
 *
 * Both engines implement the identical function surface below, so api.js and
 * every caller work unchanged no matter which database is configured. The
 * engine-neutral serialization helpers (queue, locked(), normalize*, error
 * classification) live in store-core.js and are re-exported here.
 *
 * Rules every engine obeys (README, "Where the data lives"):
 *   - nothing is ever initialised destructively: no drop/truncate/reset on
 *     startup, schema is created only where missing;
 *   - each write is persisted immediately, on its own;
 *   - the only deletions are the explicit admin actions (DELETE ROOM /
 *     delete game) and the rows they own.
 *
 * MONGODB_URI is read server-side only (config.js is never bundled for the
 * browser) and is never formatted into a message, response or log line — only
 * host and database name ever appear in output.
 */
import { MONGODB_URI } from "./config.js";

const impl = MONGODB_URI
  ? await import("./store-mongo.js") // MongoDB Atlas (production)
  : await import("./store-rel.js"); // SQLite / PostgreSQL (dev, tests)

/** Opens (or reopens) the engine and runs boot checks — see each engine. */
const boot = await impl.ensureOpen();

/* Engine facts + transaction/shutdown control, forwarded from the engine. */
export const engine = impl.engine;
export const engineLabel = impl.engineLabel;
export const withTx = impl.withTx;
export const close = impl.close;
/** True only when the one-time legacy-content cleanup ran during THIS boot. */
export const legacyCleared = boot.legacyCleared;

/* Engine-neutral primitives — identical on every engine (store-core.js). */
export {
  uid,
  atomic,
  locked,
  normalizeCode,
  normalizeName,
  isUniqueViolation,
  isDbError,
} from "./store-core.js";

/* ------------------------------------------------------------------ *
 * The store API — each function forwards to the selected engine.
 * Signatures and return shapes are identical on every engine.
 * ------------------------------------------------------------------ */

/* Admins (game master accounts + login) */
export const seedAdmin = (...args) => impl.seedAdmin(...args);
export const findAdminByName = (...args) => impl.findAdminByName(...args);
export const findAdminById = (...args) => impl.findAdminById(...args);
export const verifyAdmin = (...args) => impl.verifyAdmin(...args);

/* Rooms (codes, configuration, per-room game session) */
export const generateRoomCode = (...args) => impl.generateRoomCode(...args);
export const findRoomByCode = (...args) => impl.findRoomByCode(...args);
export const findRoomById = (...args) => impl.findRoomById(...args);
export const listRooms = (...args) => impl.listRooms(...args);
export const listRoomsForAdmin = (...args) => impl.listRoomsForAdmin(...args);
export const createRoom = (...args) => impl.createRoom(...args);
export const updateRoom = (...args) => impl.updateRoom(...args);
export const activeSession = (...args) => impl.activeSession(...args);
export const touchSession = (...args) => impl.touchSession(...args);

/* Players (one row per seat: score, case position, own timer) */
export const findPlayer = (...args) => impl.findPlayer(...args);
export const findPlayerByName = (...args) => impl.findPlayerByName(...args);
export const listPlayers = (...args) => impl.listPlayers(...args);
export const countPlayers = (...args) => impl.countPlayers(...args);
export const joinRoomAtomic = (...args) => impl.joinRoomAtomic(...args);
export const createPlayer = (...args) => impl.createPlayer(...args);
export const updatePlayer = (...args) => impl.updatePlayer(...args);

/* Answers (every submission: activity feed + audit trail) */
export const lastAnswer = (...args) => impl.lastAnswer(...args);
export const uploadInUse = (...args) => impl.uploadInUse(...args);
export const recordAnswer = (...args) => impl.recordAnswer(...args);
export const recentAnswers = (...args) => impl.recentAnswers(...args);
export const resetRoomProgress = (...args) => impl.resetRoomProgress(...args);
export const deleteRoom = (...args) => impl.deleteRoom(...args);
export const reconcileRooms = (...args) => impl.reconcileRooms(...args);

/* Games (Game Builder documents: name, description, status, timestamps) */
export const findGame = (...args) => impl.findGame(...args);
export const listGames = (...args) => impl.listGames(...args);
export const createGame = (...args) => impl.createGame(...args);
export const updateGame = (...args) => impl.updateGame(...args);
export const deleteGame = (...args) => impl.deleteGame(...args);
export const roomsUsingGame = (...args) => impl.roomsUsingGame(...args);

/* Cases (questions, images, options, correct answers, clues, points) */
export const listCases = (...args) => impl.listCases(...args);
export const findCase = (...args) => impl.findCase(...args);
export const insertCase = (...args) => impl.insertCase(...args);
export const updateCase = (...args) => impl.updateCase(...args);
export const deleteCase = (...args) => impl.deleteCase(...args);
export const renumberCases = (...args) => impl.renumberCases(...args);
export const setCaseOrder = (...args) => impl.setCaseOrder(...args);
export const moveCase = (...args) => impl.moveCase(...args);

/* Progress (per-player, per-question attempts and points) */
export const getProgress = (...args) => impl.getProgress(...args);
export const listProgress = (...args) => impl.listProgress(...args);
export const progressMap = (...args) => impl.progressMap(...args);
export const completedCount = (...args) => impl.completedCount(...args);
export const saveProgress = (...args) => impl.saveProgress(...args);
export const clearProgressForRoom = (...args) => impl.clearProgressForRoom(...args);
export const clearProgressForGame = (...args) => impl.clearProgressForGame(...args);

/* Per-player timers + test/maintenance helpers */
export const adjustPlayerEnds = (...args) => impl.adjustPlayerEnds(...args);
export const setPlayerEnds = (...args) => impl.setPlayerEnds(...args);
export const roomRowCounts = (...args) => impl.roomRowCounts(...args);
