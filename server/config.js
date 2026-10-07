import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Project root (deductive404/) */
export const ROOT = path.resolve(here, "..");

/** Where the database + signing secret live. Override with D404_DATA_DIR. */
export const DATA_DIR = process.env.D404_DATA_DIR || path.join(ROOT, "data");
export const DB_FILE = process.env.D404_DB_FILE || path.join(DATA_DIR, "deductive404.db");
export const SECRET_FILE = path.join(DATA_DIR, "secret.key");

/** Case images uploaded from the Game Builder (never shipped with the site). */
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

/**
 * Two sites, two ports:
 *   player site  -> dist/        (PORT)
 *   admin site   -> dist-admin/  (ADMIN_PORT = PORT + 1)
 */
export const DIST_DIR = path.join(ROOT, "dist");
export const ADMIN_DIST_DIR = path.join(ROOT, "dist-admin");

export const PORT = Number(process.env.PORT || 5175);
export const ADMIN_PORT = Number(process.env.ADMIN_PORT || PORT + 1);
export const HOST = process.env.HOST || "0.0.0.0";

/** Preferred dev ports. `npm run dev` walks upwards from here until free. */
export const PLAYER_DEV_PORT = Number(process.env.PLAYER_DEV_PORT || 5173);
export const ADMIN_DEV_PORT = Number(process.env.ADMIN_DEV_PORT || 5174);

/**
 * Admin credentials live server-side only. They are NEVER shipped to the browser.
 * Override in production:
 *   D404_ADMIN_USER=chief D404_ADMIN_PASSWORD=a-long-secret npm start
 */
export const ADMIN_USER = process.env.D404_ADMIN_USER || "admin";
export const ADMIN_PASSWORD = process.env.D404_ADMIN_PASSWORD || "midnight-hotel";

export const ADMIN_TOKEN_TTL = 1000 * 60 * 60 * 12; // 12h
export const PLAYER_TOKEN_TTL = 1000 * 60 * 60 * 12; // 12h
export const MAX_BODY = 64 * 1024; // 64 KB
/** A single case image may be this large (decoded from a base64 data URL). */
export const MAX_UPLOAD = 6 * 1024 * 1024; // 6 MB
/** Image types the Game Builder accepts. SVG is deliberately excluded. */
export const UPLOAD_TYPES = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};
export const TICK_MS = 1000;
export const HEARTBEAT_MS = 15_000;

/**
 * How many detectives may occupy ONE room at the same time.
 *
 * One room = many players. The count is enforced on the server, inside the
 * same transaction that inserts the player, so two simultaneous joins can
 * never push a room past its limit. Raise it later without touching code:
 *
 *   D404_MAX_PLAYERS_PER_ROOM=100   (or 200, 500, …)
 */
export const MAX_PLAYERS_PER_ROOM = (() => {
  const n = Number(process.env.D404_MAX_PLAYERS_PER_ROOM);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 50;
})();

/**
 * When a detective leaves (closed tab, lost network), their name stays
 * reserved for this long so a reconnect cannot be stolen mid-handshake.
 * After it expires the same name may rejoin and reclaim its own progress.
 */
export const NAME_GRACE_MS = (() => {
  const n = Number(process.env.D404_NAME_GRACE_MS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 15_000;
})();


/** Allowed game durations (ms) + custom upper bound. */
export const MIN_DURATION = 60_000; // 1 minute
export const MAX_DURATION = 6 * 60 * 60 * 1000; // 6 hours

export function clampDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.round(n)));
}
