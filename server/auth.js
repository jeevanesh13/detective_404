import crypto from "node:crypto";
import fs from "node:fs";
import { SECRET_FILE, ADMIN_TOKEN_TTL, PLAYER_TOKEN_TTL } from "./config.js";
import path from "node:path";

/* ------------------------------------------------------------------ *
 * Server-side signing secret.
 * Generated once on disk (or supplied through D404_SECRET) and never
 * leaves the server, so no secret key is ever exposed in frontend code.
 * ------------------------------------------------------------------ */
let cachedSecret = null;

function getSecret() {
  if (cachedSecret) return cachedSecret;
  if (process.env.D404_SECRET && process.env.D404_SECRET.length >= 16) {
    cachedSecret = process.env.D404_SECRET;
    return cachedSecret;
  }
  try {
    cachedSecret = fs.readFileSync(SECRET_FILE, "utf8").trim();
  } catch {
    /* first run */
  }
  if (!cachedSecret || cachedSecret.length < 32) {
    try {
      fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
      cachedSecret = crypto.randomBytes(48).toString("hex");
      fs.writeFileSync(SECRET_FILE, cachedSecret, { mode: 0o600 });
    } catch {
      cachedSecret = crypto.randomBytes(48).toString("hex");
    }
  }
  return cachedSecret;
}

const hmac = (data) => crypto.createHmac("sha256", getSecret()).update(data).digest("base64url");

/** sign({k:'player', i:playerId, r:roomId, exp:ms}) -> compact tamper-proof token */
export function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `d404.${body}.${hmac(body)}`;
}

export function verify(token) {
  if (typeof token !== "string" || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "d404") return null;
  const [, body, sig] = parts;
  let expected;
  try {
    expected = hmac(body);
  } catch {
    return null;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.exp === "number" && payload.exp < Date.now()) return null;
  return payload;
}

export const issuePlayer = (player, ttl = PLAYER_TOKEN_TTL) =>
  sign({ k: "player", i: player.id, r: player.room_id, n: player.player_name, exp: Date.now() + ttl });

export const issueAdmin = (admin, ttl = ADMIN_TOKEN_TTL) =>
  sign({ k: "admin", i: admin.id, u: admin.username, exp: Date.now() + ttl });

export function bearer(req, url) {
  const header = req.headers["authorization"];
  if (header && /^bearer /i.test(header)) return header.slice(7).trim();
  // EventSource-style transports cannot set headers; allow a query token too.
  const q = url && url.searchParams ? url.searchParams.get("token") : null;
  return q || null;
}

/* ------------------------------------------------------------------ *
 * Password hashing — scrypt with a per-user salt, constant time compare.
 * ------------------------------------------------------------------ */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function checkPassword(password, stored) {
  try {
    const [scheme, salt, hash] = String(stored).split("$");
    if (scheme !== "scrypt" || !salt || !hash) return false;
    const test = crypto.scryptSync(String(password), salt, 64);
    const real = Buffer.from(hash, "hex");
    return test.length === real.length && crypto.timingSafeEqual(test, real);
  } catch {
    return false;
  }
}
