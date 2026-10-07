/**
 * DETECTIVE 404 — investigation server.
 *
 * Everything that must stay trustworthy (answer checking, scoring, the game
 * clock, room isolation, authorisation) lives here. The browser only ever
 * receives an HMAC-signed session token for its own player record, so a
 * detective cannot touch the timer, the scores, another player or another room.
 */
import * as store from "./db.js";
import crypto from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import { issuePlayer, issueAdmin, verify, bearer } from "./auth.js";
import {
  norm,
  tooLong,
  MAX_ANSWER_WORDS,
  matchesAnswer,
  MAX_ATTEMPTS,
  POINTS_FIRST,
  POINTS_SECOND,
  QUESTION_TYPES,
  pointsFor,
  playerRemainingMs,
  roomRemainingMs,
  rank,
} from "./game.js";
import { MAX_BODY, MAX_UPLOAD, UPLOAD_TYPES, UPLOADS_DIR, clampDuration, TICK_MS, MAX_PLAYERS_PER_ROOM, NAME_GRACE_MS } from "./config.js";
import { hub } from "./hub.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization",
};

export class ApiError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const send = (res, status, obj) => {
  if (res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...CORS,
  });
  res.end(payload);
};

async function jsonBody(req, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ApiError("PAYLOAD_TOO_LARGE", "Request too large.", 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError("BAD_JSON", "Malformed request body.", 400);
  }
}

/* ------------------------------------------------------------------ *
 * The dynamic game attached to a room
 *
 * Nothing about a question is hard-coded: the room points at a game, the
 * game owns an ordered list of cases, and every rule below reads from there.
 * ------------------------------------------------------------------ */
const MAX_CASES = 100;
const safeJson = (raw, fallback) => {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
};

const gameOf = async (room) => (room?.game_id ? store.findGame(room.game_id) : null);
const casesOf = async (room) => {
  const game = await gameOf(room);
  return game ? store.listCases(game.id) : [];
};
const totalCasesOf = async (room) => (await casesOf(room)).length;

/** Case content. `includeSecret` is only ever true for the game master. */
function caseShape(c, includeSecret = false) {
  if (!c) return null;
  return {
    id: c.id,
    caseNumber: c.case_number,
    title: c.case_title,
    imageUrl: c.image_url,
    question: c.question,
    type: c.question_type,
    options: safeJson(c.options, []),
    pointsFirst: c.points_first,
    pointsSecond: c.points_second,
    ...(includeSecret ? { correctAnswer: c.correct_answer, clue: c.clue } : {}),
  };
}

const gameShape = async (game) =>
  game
    ? {
        id: game.id,
        name: game.name,
        description: game.description,
        status: game.status,
        createdAt: game.created_at,
        updatedAt: game.updated_at,
        caseCount: Number.isFinite(game.case_count)
          ? game.case_count
          : (await store.listCases(game.id)).length,
        roomCount: Number.isFinite(game.room_count) ? game.room_count : (await store.roomsUsingGame(game.id)).length,
      }
    : null;

/** Every game for one game master, ready to render (case/room counts included). */
const gamesList = async (adminId) => {
  const games = await store.listGames(adminId);
  const out = [];
  for (const game of games) out.push(await gameShape(game));
  return out;
};

const gameWithCases = async (game) => ({
  ...(await gameShape(game)),
  cases: (await store.listCases(game.id)).map((c) => caseShape(c, true)),
});

/**
 * The single question a player is allowed to see, with everything they have
 * earned on it. The correct answer travels only once the question is closed,
 * so a live question can never be read out of the page source.
 */
function activeQuestionOf(room, player) {
  if (!player) return Promise.resolve(null);
  return store.atomic(async () => {
    const cases = await casesOf(room);
    const c = cases[player.current_case - 1];
    if (!c) return null;
    const prog = await store.getProgress(player.id, player.current_case);
    const done = !!(prog && prog.completed);
    const attempts = prog ? prog.attempts : 0;
    const last = done ? await store.lastAnswer(player.id, player.current_case) : null;
    return {
      ...caseShape(c, false),
      correctAnswer: done ? c.correct_answer : null,
      clue: !done && attempts > 0 && attempts < MAX_ATTEMPTS ? c.clue : null,
      attempts,
      attemptsLeft: Math.max(0, MAX_ATTEMPTS - attempts),
      completed: done,
      correct: done ? !!(last && last.correct) : null,
      points: done ? prog.points : 0,
    };
  });
}

/**
 * Progress list for the player's dashboard: every case with its lock state.
 * Locked cases never carry their question, clue or answer — only the fact
 * that they are locked.
 */
function questionListOf(room, player) {
  // One atomic snapshot: cases + this player's progress list stay consistent.
  return store.atomic(async () => {
    const cases = await casesOf(room);
    const progress = player ? await store.progressMap(player.id) : {};
    const doneCount = player ? await store.completedCount(player.id) : 0;
    return cases.map((c, i) => {
      const n = i + 1;
      const p = progress[n];
      const state =
        p && p.completed
          ? "completed"
          : player && n === player.current_case
            ? "active"
            : n <= doneCount + 1
              ? "unlocked"
              : "locked";
      return {
        caseNumber: n,
        title: c.case_title,
        state,
        points: p && p.completed ? p.points : 0,
        attempts: p ? p.attempts : 0,
      };
    });
  });
}

/** Delete an uploaded case image once no case points at it any more. */
async function releaseUpload(imageUrl) {
  if (!imageUrl || !imageUrl.startsWith("/uploads/")) return;
  if (await store.uploadInUse(imageUrl)) return;
  const file = nodePath.join(UPLOADS_DIR, nodePath.basename(imageUrl));
  if (!file.startsWith(UPLOADS_DIR)) return;
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* removing a stale file is best effort */
  }
}

/* ------------------------------------------------------------------ *
 * Authorisation
 * ------------------------------------------------------------------ */
async function requirePlayer(req, url) {
  const payload = verify(bearer(req, url));
  if (!payload) throw new ApiError("UNAUTHORIZED", "Your session expired. Please join again.", 401);
  if (payload.k !== "player") throw new ApiError("FORBIDDEN", "A detective session is required.", 403);
  const player = await store.findPlayer(payload.i);
  if (!player) throw new ApiError("SESSION_EXPIRED", "Your session expired. Please join again.", 401);
  const room = await store.findRoomById(player.room_id);
  if (!room) throw new ApiError("ROOM_GONE", "This room no longer exists.", 404);
  return { player, room };
}

async function requireAdmin(req, url) {
  const payload = verify(bearer(req, url));
  if (!payload) throw new ApiError("UNAUTHORIZED", "Game master sign-in required.", 401);
  if (payload.k !== "admin") throw new ApiError("FORBIDDEN", "Game master access required.", 403);
  const admin = await store.findAdminById(payload.i);
  if (!admin) throw new ApiError("UNAUTHORIZED", "Game master sign-in required.", 401);
  return { admin };
}

async function ownedRoom(req, url, body = {}) {
  const { admin } = await requireAdmin(req, url);
  const code = url.searchParams.get("code") || body.code;
  const room = await store.findRoomByCode(code);
  if (!room) throw new ApiError("ROOM_NOT_FOUND", "Invalid Room Code", 404);
  if (room.admin_id !== admin.id) throw new ApiError("FORBIDDEN", "This room belongs to another game master.", 403);
  return { admin, room };
}

/* ------------------------------------------------------------------ *
 * Shapes sent to the browser
 * ------------------------------------------------------------------ */
/* One detective's status is derived from THEIR session (did they press
   START, has THEIR clock run out), never from what the room is doing. */
function phaseStatus(p, room) {
  if (p.status === "finished") return "finished";
  if (room.status === "ended") return "timeout";
  if (!p.started_at) return "waiting";
  if (p.timed_out || playerRemainingMs(room, p) <= 0) return "timeout";
  return "playing";
}

async function rosterShape(p, room, online) {
  return {
    id: p.id,
    name: p.player_name,
    status: phaseStatus(p, room),
    case: p.current_case,
    completed: p.completed_cases,
    score: p.score,
    timedOut: !!p.timed_out,
    online: online.has(p.id),
    timeTaken: p.time_taken,
    finishedAt: p.finished_at,
    joinedAt: p.joined_at,
    totalCases: await totalCasesOf(room),
  };
}

/** Build a roster for every player (sequential: safe inside a transaction). */
const rosterAll = async (players, room, online) => {
  const out = [];
  for (const p of players) out.push(await rosterShape(p, room, online));
  return out;
};

/** The same, but with the game-master's per-seat view (timers, attempts). */
const adminRoster = async (players, room, online) => {
  const out = [];
  for (const p of players) out.push(await adminShape(p, room, online));
  return out;
};

async function youShape(p, room, online) {
  if (!p) return null;
  const prog = await store.getProgress(p.id, p.current_case);
  return {
    ...(await rosterShape(p, room, online)),
    // THIS detective's personal session: only ever their own timestamps
    startedAt: p.started_at,
    endsAt: p.ends_at,
    remaining: playerRemainingMs(room, p),
    correct: p.correct_count,
    wrong: p.wrong_count,
    completedCount: await store.completedCount(p.id),
    attempts: prog ? prog.attempts : 0,
    attemptsLeft: Math.max(0, MAX_ATTEMPTS - (prog ? prog.attempts : 0)),
    casePoints: prog && prog.completed ? prog.points : 0,
    awaitingNext: !!p.awaiting_next,
    revealed: !!p.revealed_current,
    caseStartedAt: p.case_started_at,
    lastActive: p.last_active,
    roomId: p.room_id,
    gameId: room.game_id || null,
  };
}

async function adminShape(p, room, online) {
  const prog = await store.getProgress(p.id, p.current_case);
  return {
    ...(await rosterShape(p, room, online)),
    // per-seat clock so the game master can watch every timer individually
    startedAt: p.started_at,
    endsAt: p.ends_at,
    correct: p.correct_count,
    wrong: p.wrong_count,
    attempts: prog ? prog.attempts : 0,
    attemptsLeft: Math.max(0, MAX_ATTEMPTS - (prog ? prog.attempts : 0)),
    completedCount: await store.completedCount(p.id),
    awaitingNext: !!p.awaiting_next,
    revealed: !!p.revealed_current,
    lastActive: p.last_active,
    caseStartedAt: p.case_started_at,
  };
}

async function publicRoom(room, players, onlineCount) {
  const game = await gameOf(room);
  return {
    id: room.id,
    roomCode: room.room_code,
    roomName: room.room_name,
    status: room.status,
    duration: room.duration,
    startedAt: room.started_at,
    pausedSince: room.paused_since,
    pausedTotal: room.paused_total || 0,
    endedAt: room.ended_at,
    currentCase: room.current_case,
    caseAuto: !!room.case_auto,
    createdAt: room.created_at,
    playerCount: players.length,
    capacity: MAX_PLAYERS_PER_ROOM,
    onlineCount,
    gameId: room.game_id || null,
    gameName: game ? game.name : null,
    gameDescription: game ? game.description : "",
    totalCases: await totalCasesOf(room),
    remaining: roomRemainingMs(room, players),
  };
}

/** The ranking as it stands right now — one consistent read view. */
function leaderboardShape(roomId) {
  return store.atomic(async () => {
    const room = await store.findRoomById(roomId);
    const players = await store.listPlayers(roomId);
    return rank(players).map((p, i) => ({
      rank: i + 1,
      id: p.id,
      name: p.player_name,
      score: p.score,
      cases: p.completed_cases,
      timeTaken: p.time_taken,
      status: room ? phaseStatus(p, room) : p.status,
      you: false,
    }));
  });
}

/**
 * The authoritative state for ONE connection. Built inside store.atomic() so
 * the room, its roster and every progress row come from a single consistent
 * snapshot — never half-updated mid-write.
 */
function stateFor(roomId, client) {
  return store.atomic(async () => {
    const room = await store.findRoomById(roomId);
    if (!room) return { type: "state", serverTime: Date.now(), error: "ROOM_GONE" };
    const players = await store.listPlayers(roomId);
    const online = hub.onlineIds(roomId);
    const base = { type: "state", serverTime: Date.now(), room: await publicRoom(room, players, online.size) };
    if (room.status === "ended") base.leaderboard = await leaderboardShape(roomId);
    if (client.role === "admin") {
      const roster = [];
      for (const p of players) roster.push(await adminShape(p, room, online));
      return {
        ...base,
        players: roster,
        recent: await store.recentAnswers(roomId, 12),
        games: await gamesList(client.adminId),
      };
    }
    const me = players.find((p) => p.id === client.playerId) || null;
    return {
      ...base,
      players: await rosterAll(players, room, online),
      you: await youShape(me, room, online),
      // each detective only ever receives their own question and their own
      // lock list — never another case, never another player's answers
      question: await activeQuestionOf(room, me),
      questionList: await questionListOf(room, me),
    };
  });
}

/** Every saved room for one game master, read as a single snapshot. */
function roomsSummaryFor(adminId) {
  return store.atomic(async () => {
    const rooms = await store.listRoomsForAdmin(adminId);
    const out = [];
    for (const room of rooms) {
      const players = await store.listPlayers(room.id);
      const online = hub.onlineIds(room.id);
      const game = await gameOf(room);
      out.push({
        id: room.id,
        roomCode: room.room_code,
        roomName: room.room_name,
        status: room.status,
        duration: room.duration,
        currentCase: room.current_case,
        createdAt: room.created_at,
        startedAt: room.started_at,
        endedAt: room.ended_at,
        players: players.length,
        capacity: MAX_PLAYERS_PER_ROOM,
        online: online.size,
        finished: players.filter((p) => p.status === "finished").length,
        remaining: roomRemainingMs(room, players),
        gameId: room.game_id || null,
        gameName: game ? game.name : null,
        totalCases: await totalCasesOf(room),
      });
    }
    return out;
  });
}

/** Push the authoritative room state to every detective + game master in it. */
function syncRoom(roomId) {
  // One atomic section: snapshot + emits keep their order and no other
  // request can slip a half-written state in between.
  return store.atomic(async () => {
    await hub.broadcastRoomScoped(roomId, "state", (c) => stateFor(roomId, c));
    await hub.eachAdmin(async (c) => {
      hub.emit(c, "rooms", { type: "rooms", serverTime: Date.now(), rooms: await roomsSummaryFor(c.adminId) });
    });
  });
}

/**
 * Push state to ONE detective's own sockets and nobody else's. A personal
 * START (and a personal time-up) is a private event: the rest of the room
 * is never told "the game started" on someone else's behalf.
 */
function syncPlayer(roomId, playerId) {
  return store.atomic(async () => {
    for (const c of hub.roomClients(roomId)) {
      if (c.role === "player" && c.playerId === playerId) hub.emit(c, "state", await stateFor(roomId, c));
    }
  });
}

/** Push state to the game-master consoles watching this room (monitoring). */
function syncAdmins(roomId) {
  return store.atomic(async () => {
    for (const c of hub.roomClients(roomId)) {
      if (c.role === "admin") hub.emit(c, "state", await stateFor(roomId, c));
    }
    await hub.eachAdmin(async (c) => {
      hub.emit(c, "rooms", { type: "rooms", serverTime: Date.now(), rooms: await roomsSummaryFor(c.adminId) });
    });
  });
}

/* ------------------------------------------------------------------ *
 * Game state transitions
 * ------------------------------------------------------------------ */
async function bumpRoomCase(room, caseNo) {
  if (room.case_auto && caseNo > room.current_case) await store.updateRoom(room.id, { current_case: caseNo });
}

export function endRoom(room, reason = "admin") {
  return store.atomic(async () => {
    const now = Date.now();
    const updated = await store.updateRoom(room.id, { status: "ended", ended_at: now, paused_since: null });
    for (const p of await store.listPlayers(room.id)) {
      if (p.status !== "finished") await store.updatePlayer(p.id, { timed_out: 1, last_active: now });
    }
    await store.touchSession(room.id, { end_time: now, status: "ended" });
    await syncRoom(room.id);
    hub.broadcastRoom(room.id, "game_over", {
      type: "game_over",
      serverTime: now,
      reason,
      leaderboard: await leaderboardShape(room.id),
    });
    return updated;
  });
}

/**
 * Lock ONE detective whose personal clock ran out — and only them.
 * Their own sockets are told privately; the game master monitors it like
 * any other roster change. The room itself keeps running for everyone who
 * still has time.
 */
async function expirePlayer(room, player) {
  const now = Date.now();
  if (player.status === "finished") return player; // case already closed — nothing to lock
  const updated = await store.updatePlayer(player.id, { timed_out: 1, last_active: now });
  await syncPlayer(room.id, player.id);
  await syncAdmins(room.id);
  return updated;
}

/**
 * Start ONE detective's personal session.
 *
 * Each seat owns its own clock:
 *   startedAt = the moment THAT detective pressed START
 *   endsAt    = startedAt + the room's configured duration
 * The function only ever reads/writes this player's row (plus, on the very
 * first start, stamps the room itself as live for the game master's console
 * and the pause/end controls). One detective's START therefore can never
 * start, reset, pause or shorten another detective's timer, and pressing it
 * twice is idempotent — an existing clock is NEVER reset.
 */
async function startPlayerSession(room, player, now = Date.now()) {
  if (room.status === "ended") throw new ApiError("ENDED", "Reset the room before starting a new game.");
  if (room.status === "paused")
    throw new ApiError("PAUSED", "The game is paused — the game master has to resume it first.");
  const game = await gameOf(room);
  if (!game) throw new ApiError("NO_GAME", "This room has no game yet — ask the game master to assign one.");
  if (game.status !== "published") throw new ApiError("GAME_DRAFT", "This game is not published yet.");
  if (!(await totalCasesOf(room))) throw new ApiError("GAME_EMPTY", "The assigned game has no cases yet.");

  let roomRow = room;
  let me = player;
  let startedNow = false;
  await store.withTx(async () => {
    const freshRoom = await store.findRoomById(room.id);
    if (freshRoom.status === "ended") throw new ApiError("ENDED", "Reset the room before starting a new game.");
    if (freshRoom.status === "paused")
      throw new ApiError("PAUSED", "The game is paused — the game master has to resume it first.");
    if (freshRoom.status === "waiting") {
      // the room only records when the FIRST seat opened the case file
      roomRow = await store.updateRoom(freshRoom.id, {
        status: "live",
        started_at: now,
        paused_since: null,
        ended_at: null,
      });
      await store.touchSession(freshRoom.id, {
        start_time: now,
        end_time: null,
        duration: roomRow.duration,
        status: "live",
      });
    } else {
      roomRow = freshRoom;
    }
    const fresh = await store.findPlayer(player.id);
    if (!fresh.started_at) {
      startedNow = true;
      me = await store.updatePlayer(fresh.id, {
        started_at: now,
        ends_at: now + roomRow.duration, // their OWN full-length timer
        case_started_at: now, // their personal case clock starts with it
        timed_out: 0,
      });
    }
    // already started -> idempotent, their stored clock stays untouched
  });
  return { room: roomRow, player: me, startedNow };
}

/* ------------------------------------------------------------------ *
 * Personal clocks
 * ------------------------------------------------------------------ */
/** Lock every seat whose own timer has run out. Returns them. */
async function expireElapsedPlayers(room, now = Date.now()) {
  const expired = [];
  for (const p of await store.listPlayers(room.id)) {
    if (!p.started_at || p.timed_out || p.status === "finished") continue;
    if (playerRemainingMs(room, p, now) > 0) continue;
    await store.updatePlayer(p.id, { timed_out: 1, last_active: now });
    expired.push(p);
  }
  return expired;
}

async function pushExpiry(room, expired) {
  if (!expired.length) return;
  for (const p of expired) await syncPlayer(room.id, p.id); // only their own screen flips
  await syncAdmins(room.id); // the game master watches every seat
}

/**
 * The ROOM itself closes only once every seat has had its turn: somebody
 * started, nobody is still waiting to press START, and every started clock
 * is either spent or their case is already closed. One player hitting 00:00
 * therefore never ends the game for the rest of the room.
 */
async function roomTurnsOver(room, now = Date.now()) {
  const players = await store.listPlayers(room.id);
  const started = players.filter((p) => p.started_at);
  if (!started.length) return false;
  if (players.some((p) => !p.started_at)) return false;
  return started.every((p) => p.status === "finished" || p.timed_out || playerRemainingMs(room, p, now) <= 0);
}

/**
 * One tick per second: every detective's countdown is re-derived from the
 * server clock, personal time-ups lock only that detective, and the room
 * closes only when all seats are done. The whole sweep runs as one atomic
 * section, so a request cannot interleave between reading a clock and
 * writing the expiry it just read (same guarantee as the old sync tick).
 * ------------------------------------------------------------------ */
async function tick() {
  const now = Date.now();
  await store.atomic(async () => {
    for (const room of await store.listRooms()) {
      if (room.status !== "live") continue;
      const expired = await expireElapsedPlayers(room, now);
      if (await roomTurnsOver(room, now)) {
        await pushExpiry(room, expired);
        await endRoom(room, "time");
        continue;
      }
      await pushExpiry(room, expired);
      hub.broadcastRoom(room.id, "tick", { type: "tick", serverTime: now, status: "live" });
    }
  });
}

let ready = null;

/**
 * Start the 1s ticker exactly once and settle whatever a previous process
 * left running. The returned promise resolves when the boot reconciliation is
 * done — the first request awaits it so no caller ever sees a room in the
 * state it was in before the restart.
 */
function startTicker() {
  if (ready) return ready;
  globalThis.__d404Ticker = setInterval(() => {
    tick().catch((err) => console.error("[deductive-404] tick failed:", err));
  }, TICK_MS);
  globalThis.__d404Ticker.unref?.();

  // Personal clocks that ran out while the server was down are locked, and a
  // room whose every seat is spent is closed — otherwise it simply carries on.
  ready = store
    .atomic(async () => {
      for (const room of await store.reconcileRooms()) {
        if (room.status !== "live") continue;
        const expired = await expireElapsedPlayers(room);
        if (await roomTurnsOver(room)) {
          await pushExpiry(room, expired);
          await endRoom(room, "restart");
        } else {
          await pushExpiry(room, expired);
        }
      }
    })
    .catch((err) => console.error("[deductive-404] reconcile failed:", err));
  return ready;
}

/* ------------------------------------------------------------------ *
 * Admin login throttling
 * ------------------------------------------------------------------ */
const failures = new Map();
function throttleKey(req) {
  return `${req.socket?.remoteAddress || "?"}`;
}
function checkThrottle(key) {
  const rec = failures.get(key);
  if (!rec) return;
  if (Date.now() - rec.at > 5 * 60_000) {
    failures.delete(key);
    return;
  }
  if (rec.n >= 8) throw new ApiError("RATE_LIMITED", "Too many attempts. Try again in a few minutes.", 429);
}
function bumpThrottle(key) {
  const rec = failures.get(key);
  if (!rec || Date.now() - rec.at > 5 * 60_000) failures.set(key, { n: 1, at: Date.now() });
  else rec.n += 1;
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */
async function route(req, res, url) {
  const method = (req.method || "GET").toUpperCase();
  const path = url.pathname;
  const now = Date.now();

  if (method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  /* ---------------- public ---------------- */
  if (path === "/api/health" && method === "GET") {
    return send(res, 200, { ok: true, serverTime: now, version: "2.0.0" });
  }

  /* ---------------- player ---------------- */
  if (path === "/api/join" && method === "POST") {
    const body = await jsonBody(req); // request body is read BEFORE the lock is taken
    const playerName = String(body.playerName || "")
      .trim()
      .replace(/\s+/g, " ");
    const roomCode = store.normalizeCode(body.roomCode);

    if (!playerName) throw new ApiError("NAME_REQUIRED", "Player name is required.");
    if (playerName.length < 2) throw new ApiError("NAME_REQUIRED", "Detective name must be at least 2 characters.");
    if (playerName.length > 24) throw new ApiError("NAME_TOO_LONG", "Detective name must be 24 characters or fewer.");
    if (!/^[A-Za-z0-9 _.'-]+$/.test(playerName))
      throw new ApiError("NAME_INVALID", "Use letters, numbers, spaces and ' . - _ only.");
    if (!/^[A-Z0-9]{6}$/.test(roomCode))
      throw new ApiError("INVALID_ROOM_CODE", "Invalid Room Code — it is six letters or digits, e.g. ABC123.");

    const payload = await store.atomic(async () => {
      const room = await store.findRoomByCode(roomCode);
      if (!room) throw new ApiError("ROOM_NOT_FOUND", "No room has that code. Check it with your game master.");
      if (room.status === "ended")
        throw new ApiError("ROOM_ENDED", "This investigation has already concluded. Ask the game master for a new room.");

      let player;
      const existing = await store.findPlayerByName(room.id, playerName);
      if (existing) {
        // A returning detective takes their own seat back — the row, score and
        // answers are restored, never erased, and nobody else's data is touched.
        // Rejected only while that name is genuinely occupied right now.
        const busy = hub.isOnline(room.id, existing.id) || now - existing.last_active < NAME_GRACE_MS;
        if (busy) throw new ApiError("NAME_TAKEN", "That detective name is already taken in this room.", 409);
        player = await store.withTx(() => store.updatePlayer(existing.id, { last_active: now }));
      } else {
        // Seat + row are created in ONE transaction: the capacity check and the
        // insert cannot be interleaved, so N simultaneous joins can never push a
        // room past MAX_PLAYERS_PER_ROOM, and a duplicate name reports
        // NAME_TAKEN instead of a generic server error.
        const joined = await store.joinRoomAtomic({
          roomId: room.id,
          playerName,
          maxPlayers: MAX_PLAYERS_PER_ROOM,
        });
        if (joined.code === "ROOM_FULL")
          throw new ApiError(
            "ROOM_FULL",
            `Room is full — ${joined.count} detectives are already in here (limit ${joined.capacity}). Ask the game master for a new room.`,
            409
          );
        if (joined.code === "NAME_TAKEN")
          throw new ApiError("NAME_TAKEN", "That detective name is already taken in this room.", 409);
        player = joined.player;
      }

      const token = issuePlayer(player);
      const players = await store.listPlayers(room.id);
      const online = hub.onlineIds(room.id);
      online.add(player.id);
      await syncRoom(room.id);
      return {
        success: true,
        roomId: room.id,
        roomCode: room.room_code,
        playerId: player.id,
        playerName: player.player_name,
        token,
        room: await publicRoom(room, players, online.size),
        you: await youShape(player, room, online),
        players: await rosterAll(players, room, online),
        question: await activeQuestionOf(room, player),
        questionList: await questionListOf(room, player),
      };
    });
    return send(res, 200, payload);
  }

  if (path === "/api/session" && method === "GET") {
    const payload = verify(bearer(req, url));
    if (!payload) throw new ApiError("UNAUTHORIZED", "No active session.", 401);
    if (payload.k === "admin") {
      const admin = await store.findAdminById(payload.i);
      if (!admin) throw new ApiError("UNAUTHORIZED", "No active session.", 401);
      return send(res, 200, {
        admin: { id: admin.id, username: admin.username },
        rooms: await roomsSummaryFor(admin.id),
        games: await gamesList(admin.id),
      });
    }
    // One consistent snapshot of "who am I, which room, what is my question".
    return send(
      res,
      200,
      await store.atomic(async () => {
        const { player, room } = await requirePlayer(req, url);
        const players = await store.listPlayers(room.id);
        const online = hub.onlineIds(room.id);
        online.add(player.id);
        return {
          room: await publicRoom(room, players, online.size),
          you: await youShape(player, room, online),
          players: await rosterAll(players, room, online),
          question: await activeQuestionOf(room, player),
          questionList: await questionListOf(room, player),
          leaderboard: room.status === "ended" ? await leaderboardShape(room.id) : undefined,
        };
      })
    );
  }

  if (path === "/api/heartbeat" && method === "POST") {
    const result = await store.atomic(async () => {
      const { player, room } = await requirePlayer(req, url);
      const updated = await store.updatePlayer(player.id, { last_active: Date.now() });
      return {
        serverTime: Date.now(),
        roomStatus: room.status,
        remaining: playerRemainingMs(room, updated), // this detective's own clock
        you: await youShape(updated, room, hub.onlineIds(room.id)),
      };
    });
    return send(res, 200, result);
  }

  if (path === "/api/leaderboard" && method === "GET") {
    const payload = verify(bearer(req, url));
    if (!payload) throw new ApiError("UNAUTHORIZED", "Sign in required.", 401);
    let roomId;
    if (payload.k === "admin") {
      const code = url.searchParams.get("code");
      const room = await store.findRoomByCode(code);
      if (!room || room.admin_id !== payload.i) throw new ApiError("FORBIDDEN", "Not your room.", 403);
      roomId = room.id;
    } else {
      roomId = payload.r;
    }
    return send(res, 200, { leaderboard: await leaderboardShape(roomId), serverTime: Date.now() });
  }

  if (path === "/api/answer" && method === "POST") {
    const body = await jsonBody(req); // the request body is read before the transaction opens
    /* The guards, the reads and the writes all live inside ONE transaction, so
       a double-clicked submit, a pause landing mid-answer or a room ending can
       never interleave between "read the attempt count" and "write it" — the
       exact guarantee the old synchronous server got for free.

       Everything a submission changes commits as one unit: the answer row,
       the progress row, this detective's score and the room's case pointer.
       Fifty players answering at the same instant therefore can never leave
       a half-written score behind, and one player's write never touches
       another player's row (every statement is keyed by player.id). */
    let timeUp = false;
    let clockRoom = null;
    let clockPlayer = null;
    const outcome = await store.withTx(async () => {
      const { player, room } = await requirePlayer(req, url);
      if (room.status !== "live")
        throw new ApiError(
          "NOT_LIVE",
          room.status === "waiting"
            ? "The investigation has not started yet."
            : room.status === "paused"
              ? "The game is paused."
              : "TIME'S UP. The investigation is closed."
        );
      if (!player.started_at)
        throw new ApiError("NOT_LIVE", "Your investigation has not started yet — press START GAME.");
      if (player.status === "finished") throw new ApiError("FINISHED", "You have already closed the case.");
      if (playerRemainingMs(room, player) <= 0) {
        // THIS detective's own clock ran out: lock only them — the room plays
        // on. Nothing else in this submission changes; the lock + private push
        // happen right after the (empty) transaction commits.
        timeUp = true;
        clockRoom = room;
        clockPlayer = player;
        return null;
      }

      const game = await gameOf(room);
      if (!game) throw new ApiError("NO_GAME", "The game master has not assigned a game to this room yet.");
      const cases = await casesOf(room);
      if (!cases.length) throw new ApiError("NO_GAME", "This game has no cases yet.");

      const caseId = Number(body.caseId);
      if (!Number.isInteger(caseId) || caseId < 1 || caseId > cases.length)
        throw new ApiError("CASE_MISMATCH", "This question is no longer active for you.");

      /* Locking is enforced here, in the database-backed server, and not only
         in the interface: a future case can never be answered out of order. */
      if (caseId > player.current_case)
        throw new ApiError("LOCKED", "That question is still locked. Finish the current one first.");
      if (caseId < player.current_case)
        throw new ApiError("CASE_MISMATCH", "This question is no longer active for you.");

      const progress = await store.getProgress(player.id, caseId);
      const attemptsUsed = progress ? progress.attempts : 0;
      if (progress && progress.completed)
        throw new ApiError("QUESTION_COMPLETE", "This question is already completed.");
      if (attemptsUsed >= MAX_ATTEMPTS)
        throw new ApiError("OUT_OF_ATTEMPTS", "No attempts left on this question.");

      const c = cases[caseId - 1];
      const type = c.question_type;
      const text = String(body.answer ?? "").slice(0, 400).trim();
      if (norm(text).length <= 1) throw new ApiError("EMPTY", "Type your deduction before submitting.");
      if (type === "text" && tooLong(text))
        throw new ApiError("TOO_LONG", `Keep it short — ${MAX_ANSWER_WORDS} words at most. A full sentence is never needed.`);

      const attemptNo = attemptsUsed + 1;
      const correct = matchesAnswer(c.correct_answer, text, type);
      const points = pointsFor(c, attemptNo, correct);
      const timeTaken = Math.max(0, Date.now() - player.case_started_at);
      /* Two attempts per question:
           1st correct -> full points, question closed, next one unlocked
           1st wrong    -> the configured clue, same question again
           2nd correct -> half points, question closed, next one unlocked
           2nd wrong    -> zero points, the answer is shown, question closed   */
      const closed = correct || attemptNo >= MAX_ATTEMPTS;

      await store.recordAnswer({ playerId: player.id, roomId: room.id, caseId, answer: text, correct, points, timeTaken });
      await store.saveProgress({
        playerId: player.id,
        roomId: room.id,
        gameId: game.id,
        caseNumber: caseId,
        attempts: attemptNo,
        points: closed ? points : 0,
        completed: closed,
      });
      let updated;
      if (closed) {
        updated = await store.updatePlayer(player.id, {
          score: player.score + points,
          correct_count: player.correct_count + (correct ? 1 : 0),
          wrong_count: player.wrong_count + (correct ? 0 : 1),
          completed_cases: caseId,
          awaiting_next: 1,
          revealed_current: correct ? 0 : 1,
          last_active: Date.now(),
        });
        await bumpRoomCase(room, caseId);
      } else {
        updated = await store.updatePlayer(player.id, { wrong_count: player.wrong_count + 1, last_active: Date.now() });
      }
      return { room, c, correct, points, attemptNo, closed, updated };
    });

    if (timeUp) {
      // Locks that one seat, pushes it privately, monitors it on the console.
      await expirePlayer(clockRoom, clockPlayer);
      throw new ApiError("TIME_UP", "TIME'S UP");
    }

    const { room, c, correct, points, attemptNo, closed, updated } = outcome;
    await syncRoom(room.id);
    return send(res, 200, {
      correct,
      points,
      attempt: attemptNo,
      attemptsLeft: Math.max(0, MAX_ATTEMPTS - attemptNo),
      completed: closed,
      // a first miss hands back the clue and nothing else
      clue: !closed ? c.clue : null,
      // the answer is only ever shown once the question is closed
      answer: closed && !correct ? c.correct_answer : null,
      score: updated.score,
      awaitingNext: !!updated.awaiting_next,
      you: await youShape(updated, room, hub.onlineIds(room.id)),
      question: await activeQuestionOf(room, updated),
      questionList: await questionListOf(room, updated),
    });
  }

  if (path === "/api/next" && method === "POST") {
    let timeUp = false;
    let clockRoom = null;
    let clockPlayer = null;
    // Guards + reads + writes commit together (see /api/answer): a double-
    // clicked NEXT re-reads awaiting_next inside the transaction, so a case can
    // never be skipped, and the case pointer moves with the player's row.
    const outcome = await store.withTx(async () => {
      const { player, room } = await requirePlayer(req, url);
      if (!player.awaiting_next) throw new ApiError("NOT_READY", "Complete this question before moving on.");
      if (room.status === "ended") throw new ApiError("ENDED", "The investigation is closed.");
      if (player.started_at && playerRemainingMs(room, player) <= 0) {
        // their personal clock, not the room's — nothing else changes here
        timeUp = true;
        clockRoom = room;
        clockPlayer = player;
        return null;
      }

      const total = await totalCasesOf(room);
      let updated;
      let finished = false;
      if (player.current_case >= total) {
        const finishedAt = Date.now();
        const base = player.started_at || room.started_at || player.joined_at;
        updated = await store.updatePlayer(player.id, {
          status: "finished",
          finished_at: finishedAt,
          time_taken: Math.max(0, finishedAt - base),
          awaiting_next: 0,
          completed_cases: total,
          last_active: finishedAt,
        });
        finished = true;
      } else {
        const nextCase = player.current_case + 1;
        updated = await store.updatePlayer(player.id, {
          current_case: nextCase,
          completed_cases: player.current_case,
          awaiting_next: 0,
          revealed_current: 0,
          case_started_at: Date.now(),
          last_active: Date.now(),
        });
        await bumpRoomCase(room, nextCase);
      }
      return { room, updated, finished };
    });

    if (timeUp) {
      await expirePlayer(clockRoom, clockPlayer); // their personal clock, not the room's
      throw new ApiError("TIME_UP", "TIME'S UP");
    }

    const { room, updated, finished } = outcome;
    await syncRoom(room.id);
    return send(res, 200, {
      finished,
      room: await publicRoom(room, await store.listPlayers(room.id), hub.onlineIds(room.id).size),
      you: await youShape(updated, room, hub.onlineIds(room.id)),
      question: await activeQuestionOf(room, updated),
      questionList: await questionListOf(room, updated),
    });
  }

  /* ---------------------------------------------------------------- *
   * START GAME — INDIVIDUAL, pressed by each detective themselves.
   *
   * This starts ONLY the caller's session: their own started timestamp,
   * their own expiry (start + the configured duration) and their own
   * private push. Nobody else's timer is started, reset, paused or
   * shortened by it, and no "game started" event is broadcast to the
   * room — the game master's console is updated because it monitors.
   * Minimum to start = this one seat; capacity stays a separate ceiling.
   * ---------------------------------------------------------------- */
  if (path === "/api/game/start" && method === "POST") {
    // session valid + room exists + this player's room — read under one lock so
    // no other request can slip between "which room am I in" and the start
    const started = await store.atomic(async () => {
      const { player, room } = await requirePlayer(req, url);
      return await startPlayerSession(room, player); // one personal session for ONE seat
    });
    const online = hub.onlineIds(started.room.id);

    await syncPlayer(started.room.id, started.player.id); // PRIVATE: their own sockets only
    if (started.startedNow) await syncAdmins(started.room.id); // the game master monitors

    const players = await store.listPlayers(started.room.id);
    return send(res, 200, {
      started: true,
      alreadyStarted: !started.startedNow, // re-pressing START never resets the clock
      room: await publicRoom(started.room, players, online.size),
      players: await rosterAll(players, started.room, online),
      you: await youShape(started.player, started.room, online),
      question: await activeQuestionOf(started.room, started.player),
      questionList: await questionListOf(started.room, started.player),
    });
  }

  /* ---------------- admin ---------------- */
  if (path === "/api/admin/login" && method === "POST") {
    const body = await jsonBody(req);
    const key = throttleKey(req);
    checkThrottle(key);
    const admin = await store.verifyAdmin(body.username, body.password);
    if (!admin) {
      bumpThrottle(key);
      throw new ApiError("BAD_CREDENTIALS", "Invalid game master credentials.", 401);
    }
    failures.delete(key);
    return send(res, 200, {
      token: issueAdmin(admin),
      admin: { id: admin.id, username: admin.username },
      rooms: await roomsSummaryFor(admin.id),
      games: await gamesList(admin.id),
    });
  }

  if (path === "/api/admin/rooms" && method === "GET") {
    const { admin } = await requireAdmin(req, url);
    return send(res, 200, {
      rooms: await roomsSummaryFor(admin.id),
      games: await gamesList(admin.id),
      serverTime: Date.now(),
    });
  }

  if (path === "/api/admin/rooms" && method === "POST") {
    const { admin } = await requireAdmin(req, url);
    const body = await jsonBody(req);
    const roomName = String(body.roomName || "").trim().slice(0, 60) || "Investigation Room";
    const duration = clampDuration(body.duration);
    if (!duration) throw new ApiError("BAD_DURATION", "Choose a valid game duration.");
    /* Creating a room SAVES it permanently — status stays "waiting", no game
       starts, nothing is broadcast as live. It only ever goes away through the
       explicit DELETE ROOM below. */
    const room = await store.createRoom({ roomName, duration, adminId: admin.id });
    const players = await store.listPlayers(room.id);
    await syncRoom(room.id);
    return send(res, 200, { room: await publicRoom(room, players, 0), rooms: await roomsSummaryFor(admin.id) });
  }

  /* Delete one room (and only that room) plus its players, answers and scores. */
  if (path === "/api/admin/rooms" && method === "DELETE") {
    const { admin, room } = await ownedRoom(req, url);
    await store.deleteRoom(room.id);
    await syncRoom(room.id);
    return send(res, 200, { rooms: await roomsSummaryFor(admin.id) });
  }

  if (path === "/api/admin/room" && method === "GET") {
    const { room } = await ownedRoom(req, url);
    const players = await store.listPlayers(room.id);
    const online = hub.onlineIds(room.id);
    return send(res, 200, {
      room: await publicRoom(room, players, online.size),
      players: await adminRoster(players, room, online),
      recent: await store.recentAnswers(room.id, 12),
      leaderboard: room.status === "ended" ? await leaderboardShape(room.id) : [],
      serverTime: Date.now(),
    });
  }

  /* ---------------- admin: game builder ---------------- */
  const ownedGame = async (admin, id) => {
    const game = await store.findGame(String(id || ""));
    if (!game) throw new ApiError("GAME_NOT_FOUND", "That game no longer exists.", 404);
    if (game.admin_id !== admin.id) throw new ApiError("FORBIDDEN", "This game belongs to another game master.", 403);
    return game;
  };

  const clampPoints = (value, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(10_000, Math.max(0, Math.round(n)));
  };

  /** Validate one case coming back from the editor. */
  function readCaseInput(body) {
    const type = String(body.questionType || "text");
    if (!QUESTION_TYPES.some((t) => t.id === type))
      throw new ApiError("BAD_TYPE", "Choose one of the supported question types.");

    const caseTitle = String(body.caseTitle || "").trim().slice(0, 80);
    const question = String(body.question || "").trim().slice(0, 400);
    const clue = String(body.clue || "").trim().slice(0, 300);
    let correctAnswer = String(body.correctAnswer || "").trim().slice(0, 120);
    let options = Array.isArray(body.options)
      ? body.options.map((o) => String(o || "").trim().slice(0, 80)).filter(Boolean)
      : [];

    if (type === "boolean") {
      options = ["True", "False"];
      const parsed = ["true", "t", "yes", "y", "1"].includes(correctAnswer.toLowerCase())
        ? true
        : ["false", "f", "no", "n", "0"].includes(correctAnswer.toLowerCase())
          ? false
          : null;
      if (parsed === null) throw new ApiError("BAD_ANSWER", "A true/false question needs True or False as the answer.");
      correctAnswer = parsed ? "True" : "False";
    } else if (type === "mcq") {
      if (options.length < 2) throw new ApiError("OPTIONS_REQUIRED", "Add at least two options.");
      if (options.length > 6) throw new ApiError("TOO_MANY_OPTIONS", "Six options maximum.");
      if (!options.includes(correctAnswer))
        throw new ApiError("BAD_ANSWER", "The correct answer has to be one of the options.");
    } else {
      options = [];
      if (correctAnswer.split(/\s+/).filter(Boolean).length > 12)
        throw new ApiError("ANSWER_TOO_LONG", "Keep the correct answer to a short phrase.");
    }

    if (!question) throw new ApiError("QUESTION_REQUIRED", "Write the question the player has to answer.");
    if (!correctAnswer) throw new ApiError("ANSWER_REQUIRED", "Enter the correct answer.");

    const imageUrl = String(body.imageUrl || "").trim().slice(0, 300);
    if (imageUrl && !/^\/uploads\/[A-Za-z0-9._-]+$/.test(imageUrl))
      throw new ApiError("BAD_IMAGE", "Upload the image from this device.");

    return {
      case_title: caseTitle || "Untitled case",
      image_url: imageUrl,
      question,
      question_type: type,
      options: JSON.stringify(options),
      correct_answer: correctAnswer,
      clue,
      points_first: clampPoints(body.pointsFirst, POINTS_FIRST),
      points_second: clampPoints(body.pointsSecond, POINTS_SECOND),
    };
  }

  if (path === "/api/admin/games" && method === "GET") {
    const { admin } = await requireAdmin(req, url);
    return send(res, 200, { games: await gamesList(admin.id), serverTime: Date.now() });
  }

  if (path === "/api/admin/games" && method === "POST") {
    const { admin } = await requireAdmin(req, url);
    const body = await jsonBody(req);
    const name = String(body.name || "").trim().slice(0, 80);
    if (!name) throw new ApiError("NAME_REQUIRED", "Give the game a name.");
    const description = String(body.description || "").trim().slice(0, 240);

    // The game and its starter cases are written as one saved unit.
    const game = await store.atomic(async () => {
      const created = await store.createGame({ adminId: admin.id, name, description });
      const wanted = Math.min(MAX_CASES, Math.max(0, Number(body.caseCount) || 0));
      for (let n = 1; n <= wanted; n++) {
        await store.insertCase({
          game_id: created.id,
          case_number: n,
          case_title: `CASE ${n}`,
          image_url: "",
          question: "",
          question_type: "text",
          options: "[]",
          correct_answer: "",
          clue: "",
          points_first: POINTS_FIRST,
          points_second: POINTS_SECOND,
          sort_order: n - 1,
        });
      }
      return created;
    });
    return send(res, 200, { game: await gameWithCases(game), games: await gamesList(admin.id) });
  }

  if (path === "/api/admin/game" && method === "GET") {
    const { admin } = await requireAdmin(req, url);
    const game = await ownedGame(admin, url.searchParams.get("id"));
    return send(res, 200, { game: await gameWithCases(game), games: await gamesList(admin.id) });
  }

  if (path === "/api/admin/game/save" && method === "POST") {
    const { admin } = await requireAdmin(req, url);
    const body = await jsonBody(req);
    return send(
      res,
      200,
      await store.atomic(async () => {
        const game = await ownedGame(admin, body.id);
        const patch = {};
        if (body.name !== undefined) {
          const name = String(body.name || "").trim().slice(0, 80);
          if (!name) throw new ApiError("NAME_REQUIRED", "Give the game a name.");
          patch.name = name;
        }
        if (body.description !== undefined) patch.description = String(body.description || "").trim().slice(0, 240);
        const updated = await store.updateGame(game.id, patch);
        return { game: await gameWithCases(updated), games: await gamesList(admin.id) };
      })
    );
  }

  if (path === "/api/admin/game/publish" && method === "POST") {
    const { admin } = await requireAdmin(req, url);
    const body = await jsonBody(req);
    return send(
      res,
      200,
      await store.atomic(async () => {
        const game = await ownedGame(admin, body.id);
        const status = body.status === "published" ? "published" : "draft";
        if (status === "published") {
          const cases = await store.listCases(game.id);
          if (!cases.length) throw new ApiError("GAME_EMPTY", "Add at least one case before publishing.");
          const incomplete = cases.find((c) => !String(c.question).trim() || !String(c.correct_answer).trim());
          if (incomplete)
            throw new ApiError(
              "CASE_INCOMPLETE",
              `Case ${incomplete.case_number} still needs a question and a correct answer.`
            );
        }
        const updated = await store.updateGame(game.id, { status });
        return { game: await gameWithCases(updated), games: await gamesList(admin.id) };
      })
    );
  }

  if (path === "/api/admin/game/delete" && method === "POST") {
    const { admin } = await requireAdmin(req, url);
    const body = await jsonBody(req);
    return send(
      res,
      200,
      await store.atomic(async () => {
        const game = await ownedGame(admin, body.id);
        const inUse = await store.roomsUsingGame(game.id);
        if (inUse.length)
          throw new ApiError("GAME_IN_USE", `This game is assigned to ${inUse.length} room(s). Unassign it first.`);
        await store.deleteGame(game.id);
        return { deleted: game.id, games: await gamesList(admin.id) };
      })
    );
  }

  if (path === "/api/admin/game/case" && method === "POST") {
    const { admin } = await requireAdmin(req, url);
    const body = await jsonBody(req);
    const input = readCaseInput(body); // pure validation — outside the lock
    const payload = await store.atomic(async () => {
      const game = await ownedGame(admin, body.gameId);
      if (body.caseId) {
        const previous = await store.findCase(body.caseId);
        if (!previous || previous.game_id !== game.id)
          throw new ApiError("CASE_NOT_FOUND", "That case no longer exists.", 404);
        const saved = await store.updateCase(previous.id, input);
        if (previous.image_url && previous.image_url !== input.image_url) releaseUpload(previous.image_url);
        return { case: caseShape(saved, true), games: await gamesList(admin.id) };
      }

      const count = (await store.listCases(game.id)).length;
      if (count >= MAX_CASES) throw new ApiError("TOO_MANY_CASES", `${MAX_CASES} cases maximum.`);
      const saved = await store.insertCase({
        game_id: game.id,
        case_number: count + 1,
        sort_order: count,
        ...input,
      });
      return { case: caseShape(saved, true), games: await gamesList(admin.id) };
    });
    return send(res, 200, payload);
  }

  if (path === "/api/admin/game/case/delete" && method === "POST") {
    const { admin } = await requireAdmin(req, url);
    const body = await jsonBody(req);
    const payload = await store.atomic(async () => {
      const game = await ownedGame(admin, body.gameId);
      const existing = await store.findCase(String(body.caseId || ""));
      if (!existing || existing.game_id !== game.id)
        throw new ApiError("CASE_NOT_FOUND", "That case no longer exists.", 404);
      const file = existing.image_url;
      await store.deleteCase(existing.id);
      // case numbers shift when one is removed, so progress recorded against
      // this game cannot be trusted any more
      const touched = await store.clearProgressForGame(game.id);
      releaseUpload(file);
      return { games: await gamesList(admin.id), progressReset: touched };
    });
    return send(res, 200, payload);
  }

  if (path === "/api/admin/game/case/move" && method === "POST") {
    const { admin } = await requireAdmin(req, url);
    const body = await jsonBody(req);
    const payload = await store.atomic(async () => {
      const game = await ownedGame(admin, body.gameId);
      const direction = Number(body.direction) < 0 ? -1 : 1;
      await store.moveCase(game.id, String(body.caseId || ""), direction);
      const touched = await store.clearProgressForGame(game.id);
      return { games: await gamesList(admin.id), progressReset: touched };
    });
    return send(res, 200, payload);
  }

  /* ---------------- admin: case image upload ---------------- */
  if (path === "/api/admin/upload" && method === "POST") {
    await requireAdmin(req, url);
    const body = await jsonBody(req, MAX_UPLOAD);
    const match = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(body.dataUrl || ""));
    const mime = match ? match[1].toLowerCase() : null;
    const ext = mime ? UPLOAD_TYPES[mime] : null;
    if (!ext) throw new ApiError("BAD_IMAGE", "Upload a PNG, JPG, WEBP or GIF image from this device.");
    const buf = Buffer.from(match[2], "base64");
    if (!buf.length) throw new ApiError("BAD_IMAGE", "That image could not be read.");
    if (buf.length > MAX_UPLOAD) throw new ApiError("IMAGE_TOO_LARGE", "Images must be 6 MB or smaller.");
    const name = `${crypto.randomUUID()}${ext}`;
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(nodePath.join(UPLOADS_DIR, name), buf);
    return send(res, 200, { url: `/uploads/${name}`, bytes: buf.length });
  }

  const adminActions = {
    /* START is deliberately absent: the game master monitors the room and
       manages pause / resume / end / reset, but every detective starts
       their OWN session (POST /api/game/start). */
    pause: async ({ room }) => {
      if (room.status !== "live") throw new ApiError("NOT_LIVE", "Only a running game can be paused.");
      await store.touchSession(room.id, { status: "paused" });
      return await store.updateRoom(room.id, { status: "paused", paused_since: Date.now() });
    },
    resume: async ({ room }) => {
      if (room.status !== "paused") throw new ApiError("NOT_PAUSED", "The game is not paused.");
      const now = Date.now();
      const pausedMs = Math.max(0, now - (room.paused_since || now));
      const pausedTotal = (room.paused_total || 0) + pausedMs;
      await store.touchSession(room.id, { status: "live" });
      // Every personal clock is pushed forward by exactly the paused window,
      // so resuming never gives anyone extra time or cuts anyone short.
      return await store.withTx(async () => {
        for (const p of await store.listPlayers(room.id)) {
          if (!p.started_at || p.status === "finished" || p.timed_out) continue;
          if (playerRemainingMs(room, p, now) <= 0) continue; // already spent before the pause
          await store.updatePlayer(p.id, { ends_at: (p.ends_at || now) + pausedMs });
        }
        return await store.updateRoom(room.id, { status: "live", paused_since: null, paused_total: pausedTotal });
      });
    },
    end: ({ room }) => endRoom(room, "admin"),
    reset: async ({ room }) => {
      await store.resetRoomProgress(room.id);
      const updated = await store.updateRoom(room.id, {
        status: "waiting",
        started_at: null,
        paused_since: null,
        paused_total: 0,
        ended_at: null,
        current_case: 1,
        case_auto: 1,
      });
      await store.touchSession(room.id, {
        start_time: null,
        end_time: null,
        duration: updated.duration,
        status: "waiting",
      });
      return updated;
    },
    case: async ({ room, body }) => {
      const patch = {};
      const total = await totalCasesOf(room);
      if (typeof body.auto === "boolean") patch.case_auto = body.auto ? 1 : 0;
      if (body.caseNo !== undefined && body.caseNo !== null && body.caseNo !== "") {
        const n = Number(body.caseNo);
        if (!Number.isInteger(n) || n < 1 || n > total)
          throw new ApiError(
            "BAD_CASE",
            total ? `Case must be between 1 and ${total}.` : "Assign a game to this room first."
          );
        patch.current_case = n;
        if (typeof body.auto !== "boolean") patch.case_auto = 0;
      }
      if (!Object.keys(patch).length) throw new ApiError("BAD_CASE", "No case selection supplied.");
      return await store.updateRoom(room.id, patch);
    },
    duration: async ({ room, body }) => {
      if (room.status === "live") throw new ApiError("LIVE", "Pause or end the game before changing the duration.");
      const duration = clampDuration(body.duration);
      if (!duration) throw new ApiError("BAD_DURATION", "Choose a valid game duration.");
      const updated = await store.updateRoom(room.id, { duration });
      await store.touchSession(room.id, { duration });
      return updated;
    },
    /** Attach (or detach) a game to this room. Progress belongs to the game,
     *  so switching it clears every score in the room. */
    game: async ({ room, body }) => {
      const gameId = body.gameId ? String(body.gameId) : null;
      if (gameId) {
        const game = await store.findGame(gameId);
        if (!game) throw new ApiError("GAME_NOT_FOUND", "That game no longer exists.", 404);
        if (game.admin_id !== room.admin_id) throw new ApiError("FORBIDDEN", "This game belongs to another game master.", 403);
        if (game.status !== "published")
          throw new ApiError("GAME_DRAFT", "Publish this game before assigning it to a room.");
        if (!(await store.listCases(game.id)).length) throw new ApiError("GAME_EMPTY", "Add at least one case to this game first.");
      }
      if (room.game_id === gameId) return room;
      await store.updateRoom(room.id, { game_id: gameId, current_case: 1 });
      await store.resetRoomProgress(room.id);
      return await store.findRoomById(room.id);
    },
  };

  const actionMatch = path.match(/^\/api\/admin\/room\/([a-z]+)$/);
  if (actionMatch && method === "POST" && (actionMatch[1] === "start" || adminActions[actionMatch[1]])) {
    const body = await jsonBody(req);
    if (actionMatch[1] === "start") {
      // The game master never starts the game — a detective in the room does.
      throw new ApiError(
        "ADMIN_START_DISABLED",
        "The game master cannot start the game. A detective in the room presses START GAME.",
        403
      );
    }
    /* Ownership check and the action itself run under one lock: pause, resume,
       end, reset and a player's answer can never interleave mid-transition. */
    let adminId = null;
    let roomId = null;
    const updated = await store.atomic(async () => {
      const { admin, room } = await ownedRoom(req, url, body);
      adminId = admin.id;
      roomId = room.id;
      return await adminActions[actionMatch[1]]({ room, body, admin });
    });
    await syncRoom(roomId);
    return send(res, 200, {
      room: await publicRoom(updated, await store.listPlayers(updated.id), hub.onlineIds(updated.id).size),
      rooms: await roomsSummaryFor(adminId),
      leaderboard: updated.status === "ended" ? await leaderboardShape(updated.id) : undefined,
    });
  }

  /* ---------------- real-time stream ---------------- */
  if (path === "/events" && method === "GET") {
    return openStream(req, res, url);
  }

  throw new ApiError("NOT_FOUND", "Unknown endpoint.", 404);
}

async function openStream(req, res, url) {
  const payload = verify(bearer(req, url));
  if (!payload) throw new ApiError("UNAUTHORIZED", "Sign in required.", 401);

  const code = store.normalizeCode(url.searchParams.get("room"));
  // One consistent view of "which room / who am I" before we subscribe, so a
  // room being deleted mid-handshake can never half-register a connection.
  const client = await store.atomic(async () => {
    const room = code ? await store.findRoomByCode(code) : null;
    if (payload.k === "player") {
      const player = await store.findPlayer(payload.i);
      if (!player) throw new ApiError("SESSION_EXPIRED", "Session expired.", 401);
      if (!room || room.id !== player.room_id)
        throw new ApiError("FORBIDDEN", "Detectives can only follow their own room.", 403);
      return { role: "player", roomId: room.id, playerId: player.id, res };
    }
    const admin = await store.findAdminById(payload.i);
    if (!admin) throw new ApiError("UNAUTHORIZED", "Sign in required.", 401);
    if (room && room.admin_id !== admin.id)
      throw new ApiError("FORBIDDEN", "This room belongs to another game master.", 403);
    return { role: "admin", roomId: room ? room.id : null, adminId: admin.id, res };
  });

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...CORS,
  });

  hub.add(client); // creates the heartbeat timer — deliberately outside any lock
  hub.emit(client, "state", await stateFor(client.roomId, client));
  if (client.role === "admin") {
    hub.emit(client, "rooms", {
      type: "rooms",
      serverTime: Date.now(),
      rooms: await roomsSummaryFor(client.adminId),
      games: await gamesList(client.adminId),
    });
  }
  // A detective just came online: tell everyone else in the room too.
  if (client.role === "player" && client.roomId) await syncRoom(client.roomId);

  const drop = () => {
    const gone = hub.remove(client.id);
    if (gone && gone.role === "player" && gone.roomId) {
      // fire-and-forget: a closed socket must never crash the process — and it
      // only ever affects presence, never stored data
      syncRoom(gone.roomId).catch((err) => console.error("[deductive-404] disconnect sync failed:", err));
    }
  };
  req.on("close", drop);
  req.on("error", drop);
  res.on("close", drop);
}

/* ------------------------------------------------------------------ *
 * Case images uploaded in the Game Builder (data/uploads/)
 * ------------------------------------------------------------------ */
const UPLOAD_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

function serveUpload(res, pathname) {
  const name = nodePath.basename(pathname);
  const mime = UPLOAD_MIME[nodePath.extname(name).toLowerCase()];
  const file = nodePath.join(UPLOADS_DIR, name);
  if (!mime || !file.startsWith(UPLOADS_DIR) || !fs.existsSync(file)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  try {
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": body.length,
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    res.end(body);
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Could not read image");
  }
}

/* ------------------------------------------------------------------ *
 * Entry point used by the Vite dev plugin and by the production server
 * ------------------------------------------------------------------ */
export async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url || "/", "http://deductive.local");
  } catch {
    return false;
  }
  const path = url.pathname;
  if (path.startsWith("/uploads/")) {
    serveUpload(res, path);
    return true;
  }
  if (path !== "/events" && !path.startsWith("/api/")) return false;
  await startTicker(); // starts once; first caller also reconciles prior state
  try {
    await route(req, res, url);
  } catch (err) {
    if (err instanceof ApiError) {
      send(res, err.status, { code: err.code, message: err.message });
    } else if (store.isDbError(err)) {
      // Never leak SQL at the client: name the problem, keep the shape.
      console.error("[deductive-404] database error:", err);
      send(res, 500, {
        code: "DATABASE_ERROR",
        message: "The case file could not be updated. Please try that again.",
      });
    } else {
      console.error("[deductive-404] request failed:", err);
      send(res, 500, { code: "SERVER_ERROR", message: "Unexpected server error." });
    }
  }
  return true;
}

export { syncRoom, roomsSummaryFor, leaderboardShape };
