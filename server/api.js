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
  remainingMs,
  rank,
} from "./game.js";
import { MAX_BODY, MAX_UPLOAD, UPLOAD_TYPES, UPLOADS_DIR, clampDuration, TICK_MS } from "./config.js";
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

const gameOf = (room) => (room?.game_id ? store.findGame(room.game_id) : null);
const casesOf = (room) => {
  const game = gameOf(room);
  return game ? store.listCases(game.id) : [];
};
const totalCasesOf = (room) => casesOf(room).length;

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

const gameShape = (game) =>
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
          : store.listCases(game.id).length,
        roomCount: Number.isFinite(game.room_count) ? game.room_count : store.roomsUsingGame(game.id).length,
      }
    : null;

/** Every game for one game master, ready to render (case/room counts included). */
const gamesList = (adminId) => store.listGames(adminId).map(gameShape);

const gameWithCases = (game) => ({
  ...gameShape(game),
  cases: store.listCases(game.id).map((c) => caseShape(c, true)),
});

/**
 * The single question a player is allowed to see, with everything they have
 * earned on it. The correct answer travels only once the question is closed,
 * so a live question can never be read out of the page source.
 */
function activeQuestionOf(room, player) {
  if (!player) return null;
  const cases = casesOf(room);
  const c = cases[player.current_case - 1];
  if (!c) return null;
  const prog = store.getProgress(player.id, player.current_case);
  const done = !!(prog && prog.completed);
  const attempts = prog ? prog.attempts : 0;
  const last = done ? store.lastAnswer(player.id, player.current_case) : null;
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
}

/**
 * Progress list for the player's dashboard: every case with its lock state.
 * Locked cases never carry their question, clue or answer — only the fact
 * that they are locked.
 */
function questionListOf(room, player) {
  const cases = casesOf(room);
  const progress = player ? store.progressMap(player.id) : {};
  const doneCount = player ? store.completedCount(player.id) : 0;
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
}

/** Delete an uploaded case image once no case points at it any more. */
function releaseUpload(imageUrl) {
  if (!imageUrl || !imageUrl.startsWith("/uploads/")) return;
  if (store.uploadInUse(imageUrl)) return;
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
function requirePlayer(req, url) {
  const payload = verify(bearer(req, url));
  if (!payload) throw new ApiError("UNAUTHORIZED", "Your session expired. Please join again.", 401);
  if (payload.k !== "player") throw new ApiError("FORBIDDEN", "A detective session is required.", 403);
  const player = store.findPlayer(payload.i);
  if (!player) throw new ApiError("SESSION_EXPIRED", "Your session expired. Please join again.", 401);
  const room = store.findRoomById(player.room_id);
  if (!room) throw new ApiError("ROOM_GONE", "This room no longer exists.", 404);
  return { player, room };
}

function requireAdmin(req, url) {
  const payload = verify(bearer(req, url));
  if (!payload) throw new ApiError("UNAUTHORIZED", "Game master sign-in required.", 401);
  if (payload.k !== "admin") throw new ApiError("FORBIDDEN", "Game master access required.", 403);
  const admin = store.findAdminById(payload.i);
  if (!admin) throw new ApiError("UNAUTHORIZED", "Game master sign-in required.", 401);
  return { admin };
}

function ownedRoom(req, url, body = {}) {
  const { admin } = requireAdmin(req, url);
  const code = url.searchParams.get("code") || body.code;
  const room = store.findRoomByCode(code);
  if (!room) throw new ApiError("ROOM_NOT_FOUND", "Invalid Room Code", 404);
  if (room.admin_id !== admin.id) throw new ApiError("FORBIDDEN", "This room belongs to another game master.", 403);
  return { admin, room };
}

/* ------------------------------------------------------------------ *
 * Shapes sent to the browser
 * ------------------------------------------------------------------ */
function phaseStatus(p, room) {
  if (p.status === "finished") return "finished";
  if (room.status === "ended") return "timeout";
  if (room.status === "waiting") return "waiting";
  return "playing";
}

function rosterShape(p, room, online) {
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
    totalCases: totalCasesOf(room),
  };
}

function youShape(p, room, online) {
  if (!p) return null;
  const prog = store.getProgress(p.id, p.current_case);
  return {
    ...rosterShape(p, room, online),
    correct: p.correct_count,
    wrong: p.wrong_count,
    completedCount: store.completedCount(p.id),
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

function adminShape(p, room, online) {
  const prog = store.getProgress(p.id, p.current_case);
  return {
    ...rosterShape(p, room, online),
    correct: p.correct_count,
    wrong: p.wrong_count,
    attempts: prog ? prog.attempts : 0,
    attemptsLeft: Math.max(0, MAX_ATTEMPTS - (prog ? prog.attempts : 0)),
    completedCount: store.completedCount(p.id),
    awaitingNext: !!p.awaiting_next,
    revealed: !!p.revealed_current,
    lastActive: p.last_active,
    caseStartedAt: p.case_started_at,
  };
}

function publicRoom(room, players, onlineCount) {
  const game = gameOf(room);
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
    onlineCount,
    gameId: room.game_id || null,
    gameName: game ? game.name : null,
    gameDescription: game ? game.description : "",
    totalCases: totalCasesOf(room),
    remaining: remainingMs(room),
  };
}

function leaderboardShape(roomId) {
  const room = store.findRoomById(roomId);
  const players = store.listPlayers(roomId);
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
}

function stateFor(roomId, client) {
  const room = store.findRoomById(roomId);
  if (!room) return { type: "state", serverTime: Date.now(), error: "ROOM_GONE" };
  const players = store.listPlayers(roomId);
  const online = hub.onlineIds(roomId);
  const base = { type: "state", serverTime: Date.now(), room: publicRoom(room, players, online.size) };
  if (room.status === "ended") base.leaderboard = leaderboardShape(roomId);
  if (client.role === "admin") {
    return {
      ...base,
      players: players.map((p) => adminShape(p, room, online)),
      recent: store.recentAnswers(roomId, 12),
      games: gamesList(client.adminId),
    };
  }
  const me = players.find((p) => p.id === client.playerId) || null;
  return {
    ...base,
    players: players.map((p) => rosterShape(p, room, online)),
    you: youShape(me, room, online),
    // each detective only ever receives their own question and their own
    // lock list — never another case, never another player's answers
    question: activeQuestionOf(room, me),
    questionList: questionListOf(room, me),
  };
}

function roomsSummaryFor(adminId) {
  return store.listRoomsForAdmin(adminId).map((room) => {
    const players = store.listPlayers(room.id);
    const online = hub.onlineIds(room.id);
    const game = gameOf(room);
    return {
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
      online: online.size,
      finished: players.filter((p) => p.status === "finished").length,
      remaining: remainingMs(room),
      gameId: room.game_id || null,
      gameName: game ? game.name : null,
      totalCases: totalCasesOf(room),
    };
  });
}

/** Push the authoritative room state to every detective + game master in it. */
function syncRoom(roomId) {
  hub.broadcastRoomScoped(roomId, "state", (c) => stateFor(roomId, c));
  hub.eachAdmin((c) => {
    hub.emit(c, "rooms", { type: "rooms", serverTime: Date.now(), rooms: roomsSummaryFor(c.adminId) });
  });
}

/* ------------------------------------------------------------------ *
 * Game state transitions
 * ------------------------------------------------------------------ */
function bumpRoomCase(room, caseNo) {
  if (room.case_auto && caseNo > room.current_case) store.updateRoom(room.id, { current_case: caseNo });
}

export function endRoom(room, reason = "admin") {
  const now = Date.now();
  const updated = store.updateRoom(room.id, { status: "ended", ended_at: now, paused_since: null });
  for (const p of store.listPlayers(room.id)) {
    if (p.status !== "finished") store.updatePlayer(p.id, { timed_out: 1, last_active: now });
  }
  store.touchSession(room.id, { end_time: now, status: "ended" });
  syncRoom(room.id);
  hub.broadcastRoom(room.id, "game_over", {
    type: "game_over",
    serverTime: now,
    reason,
    leaderboard: leaderboardShape(room.id),
  });
  return updated;
}

/* ------------------------------------------------------------------ *
 * One tick per second: keep every client's countdown identical to the
 * server's and auto-close the case when time runs out.
 * ------------------------------------------------------------------ */
function tick() {
  const now = Date.now();
  for (const room of store.listRooms()) {
    if (room.status !== "live") continue;
    const left = remainingMs(room, now);
    if (left <= 0) {
      endRoom(room, "time");
      continue;
    }
    hub.broadcastRoom(room.id, "tick", { type: "tick", serverTime: now, remaining: left, status: "live" });
  }
}

function startTicker() {
  if (globalThis.__d404Ticker) return;
  globalThis.__d404Ticker = setInterval(tick, TICK_MS);
  globalThis.__d404Ticker.unref?.();

  // Settle any room a previous process left running.
  for (const room of store.reconcileRooms()) {
    if (remainingMs(room) <= 0) endRoom(room, "restart");
  }
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
    const body = await jsonBody(req);
    const playerName = String(body.playerName || "")
      .trim()
      .replace(/\s+/g, " ");
    const roomCode = store.normalizeCode(body.roomCode);

    if (!playerName) throw new ApiError("NAME_REQUIRED", "Player name is required.");
    if (playerName.length < 2) throw new ApiError("NAME_REQUIRED", "Detective name must be at least 2 characters.");
    if (playerName.length > 24) throw new ApiError("NAME_TOO_LONG", "Detective name must be 24 characters or fewer.");
    if (!/^[A-Za-z0-9 _.'-]+$/.test(playerName))
      throw new ApiError("NAME_INVALID", "Use letters, numbers, spaces and ' . - _ only.");
    if (!/^[A-Z0-9]{6}$/.test(roomCode)) throw new ApiError("ROOM_NOT_FOUND", "Invalid Room Code");

    const room = store.findRoomByCode(roomCode);
    if (!room) throw new ApiError("ROOM_NOT_FOUND", "Invalid Room Code");
    if (room.status === "ended")
      throw new ApiError("ROOM_ENDED", "This investigation has already concluded. Ask the game master for a new room.");

    let player;
    const existing = store.findPlayerByName(room.id, playerName);
    if (existing) {
      // Duplicate names are rejected while that detective is active. A
      // rejoin with the same name only succeeds when the old session is
      // gone, and it restores — never erases — their progress.
      const busy = hub.isOnline(room.id, existing.id) || now - existing.last_active < 15_000;
      if (busy) throw new ApiError("NAME_TAKEN", "That detective name is already taken in this room.", 409);
      player = store.updatePlayer(existing.id, { last_active: now });
    } else {
      player = store.createPlayer({ roomId: room.id, playerName });
    }

    const token = issuePlayer(player);
    const players = store.listPlayers(room.id);
    const online = hub.onlineIds(room.id);
    online.add(player.id);
    syncRoom(room.id);
    return send(res, 200, {
      token,
      room: publicRoom(room, players, online.size),
      you: youShape(player, room, online),
      players: players.map((p) => rosterShape(p, room, online)),
      question: activeQuestionOf(room, player),
      questionList: questionListOf(room, player),
    });
  }

  if (path === "/api/session" && method === "GET") {
    const payload = verify(bearer(req, url));
    if (!payload) throw new ApiError("UNAUTHORIZED", "No active session.", 401);
    if (payload.k === "admin") {
      const admin = store.findAdminById(payload.i);
      if (!admin) throw new ApiError("UNAUTHORIZED", "No active session.", 401);
      return send(res, 200, {
        admin: { id: admin.id, username: admin.username },
        rooms: roomsSummaryFor(admin.id),
        games: gamesList(admin.id),
      });
    }
    const { player, room } = requirePlayer(req, url);
    const players = store.listPlayers(room.id);
    const online = hub.onlineIds(room.id);
    online.add(player.id);
    return send(res, 200, {
      room: publicRoom(room, players, online.size),
      you: youShape(player, room, online),
      players: players.map((p) => rosterShape(p, room, online)),
      question: activeQuestionOf(room, player),
      questionList: questionListOf(room, player),
      leaderboard: room.status === "ended" ? leaderboardShape(room.id) : undefined,
    });
  }

  if (path === "/api/heartbeat" && method === "POST") {
    const { player, room } = requirePlayer(req, url);
    const updated = store.updatePlayer(player.id, { last_active: Date.now() });
    return send(res, 200, {
      serverTime: Date.now(),
      roomStatus: room.status,
      remaining: remainingMs(room),
      you: youShape(updated, room, hub.onlineIds(room.id)),
    });
  }

  if (path === "/api/leaderboard" && method === "GET") {
    const payload = verify(bearer(req, url));
    if (!payload) throw new ApiError("UNAUTHORIZED", "Sign in required.", 401);
    let roomId;
    if (payload.k === "admin") {
      const code = url.searchParams.get("code");
      const room = store.findRoomByCode(code);
      if (!room || room.admin_id !== payload.i) throw new ApiError("FORBIDDEN", "Not your room.", 403);
      roomId = room.id;
    } else {
      roomId = payload.r;
    }
    return send(res, 200, { leaderboard: leaderboardShape(roomId), serverTime: Date.now() });
  }

  if (path === "/api/answer" && method === "POST") {
    const body = await jsonBody(req);
    const { player, room } = requirePlayer(req, url);
    if (room.status !== "live")
      throw new ApiError(
        "NOT_LIVE",
        room.status === "waiting"
          ? "The investigation has not started yet."
          : room.status === "paused"
            ? "The game is paused."
            : "TIME'S UP. The investigation is closed."
      );
    if (remainingMs(room) <= 0) {
      endRoom(room, "time");
      throw new ApiError("TIME_UP", "TIME'S UP");
    }
    if (player.status === "finished") throw new ApiError("FINISHED", "You have already closed the case.");

    const game = gameOf(room);
    if (!game) throw new ApiError("NO_GAME", "The game master has not assigned a game to this room yet.");
    const cases = casesOf(room);
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

    const progress = store.getProgress(player.id, caseId);
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
    store.recordAnswer({ playerId: player.id, roomId: room.id, caseId, answer: text, correct, points, timeTaken });

    /* Two attempts per question:
         1st correct -> full points, question closed, next one unlocked
         1st wrong    -> the configured clue, same question again
         2nd correct -> half points, question closed, next one unlocked
         2nd wrong    -> zero points, the answer is shown, question closed   */
    const closed = correct || attemptNo >= MAX_ATTEMPTS;
    store.saveProgress({
      playerId: player.id,
      roomId: room.id,
      gameId: game.id,
      caseNumber: caseId,
      attempts: attemptNo,
      points: closed ? points : 0,
      completed: closed,
    });

    let updated = player;
    if (closed) {
      updated = store.updatePlayer(player.id, {
        score: player.score + points,
        correct_count: player.correct_count + (correct ? 1 : 0),
        wrong_count: player.wrong_count + (correct ? 0 : 1),
        completed_cases: caseId,
        awaiting_next: 1,
        revealed_current: correct ? 0 : 1,
        last_active: Date.now(),
      });
      bumpRoomCase(room, caseId);
    } else {
      updated = store.updatePlayer(player.id, { wrong_count: player.wrong_count + 1, last_active: Date.now() });
    }

    syncRoom(room.id);
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
      you: youShape(updated, room, hub.onlineIds(room.id)),
      question: activeQuestionOf(room, updated),
      questionList: questionListOf(room, updated),
    });
  }

  if (path === "/api/next" && method === "POST") {
    const { player, room } = requirePlayer(req, url);
    if (!player.awaiting_next) throw new ApiError("NOT_READY", "Complete this question before moving on.");
    if (room.status === "ended") throw new ApiError("ENDED", "The investigation is closed.");

    const total = totalCasesOf(room);
    let updated;
    let finished = false;
    if (player.current_case >= total) {
      const finishedAt = Date.now();
      const base = room.started_at || player.joined_at;
      updated = store.updatePlayer(player.id, {
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
      updated = store.updatePlayer(player.id, {
        current_case: nextCase,
        completed_cases: player.current_case,
        awaiting_next: 0,
        revealed_current: 0,
        case_started_at: Date.now(),
        last_active: Date.now(),
      });
      bumpRoomCase(room, nextCase);
    }
    syncRoom(room.id);
    return send(res, 200, {
      finished,
      room: publicRoom(room, store.listPlayers(room.id), hub.onlineIds(room.id).size),
      you: youShape(updated, room, hub.onlineIds(room.id)),
      question: activeQuestionOf(room, updated),
      questionList: questionListOf(room, updated),
    });
  }

  /* ---------------- admin ---------------- */
  if (path === "/api/admin/login" && method === "POST") {
    const body = await jsonBody(req);
    const key = throttleKey(req);
    checkThrottle(key);
    const admin = store.verifyAdmin(body.username, body.password);
    if (!admin) {
      bumpThrottle(key);
      throw new ApiError("BAD_CREDENTIALS", "Invalid game master credentials.", 401);
    }
    failures.delete(key);
    return send(res, 200, {
      token: issueAdmin(admin),
      admin: { id: admin.id, username: admin.username },
      rooms: roomsSummaryFor(admin.id),
      games: gamesList(admin.id),
    });
  }

  if (path === "/api/admin/rooms" && method === "GET") {
    const { admin } = requireAdmin(req, url);
    return send(res, 200, {
      rooms: roomsSummaryFor(admin.id),
      games: gamesList(admin.id),
      serverTime: Date.now(),
    });
  }

  if (path === "/api/admin/rooms" && method === "POST") {
    const { admin } = requireAdmin(req, url);
    const body = await jsonBody(req);
    const roomName = String(body.roomName || "").trim().slice(0, 60) || "Investigation Room";
    const duration = clampDuration(body.duration);
    if (!duration) throw new ApiError("BAD_DURATION", "Choose a valid game duration.");
    const room = store.createRoom({ roomName, duration, adminId: admin.id });
    const players = store.listPlayers(room.id);
    syncRoom(room.id);
    return send(res, 200, { room: publicRoom(room, players, 0), rooms: roomsSummaryFor(admin.id) });
  }

  /* Delete one room (and only that room) plus its players, answers and scores. */
  if (path === "/api/admin/rooms" && method === "DELETE") {
    const { admin, room } = ownedRoom(req, url);
    store.deleteRoom(room.id);
    syncRoom(room.id);
    return send(res, 200, { rooms: roomsSummaryFor(admin.id) });
  }

  if (path === "/api/admin/room" && method === "GET") {
    const { room } = ownedRoom(req, url);
    const players = store.listPlayers(room.id);
    const online = hub.onlineIds(room.id);
    return send(res, 200, {
      room: publicRoom(room, players, online.size),
      players: players.map((p) => adminShape(p, room, online)),
      recent: store.recentAnswers(room.id, 12),
      leaderboard: room.status === "ended" ? leaderboardShape(room.id) : [],
      serverTime: Date.now(),
    });
  }

  /* ---------------- admin: game builder ---------------- */
  const ownedGame = (admin, id) => {
    const game = store.findGame(String(id || ""));
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
    const { admin } = requireAdmin(req, url);
    return send(res, 200, { games: gamesList(admin.id), serverTime: Date.now() });
  }

  if (path === "/api/admin/games" && method === "POST") {
    const { admin } = requireAdmin(req, url);
    const body = await jsonBody(req);
    const name = String(body.name || "").trim().slice(0, 80);
    if (!name) throw new ApiError("NAME_REQUIRED", "Give the game a name.");
    const description = String(body.description || "").trim().slice(0, 240);

    const game = store.createGame({ adminId: admin.id, name, description });
    const wanted = Math.min(MAX_CASES, Math.max(0, Number(body.caseCount) || 0));
    for (let n = 1; n <= wanted; n++) {
      store.insertCase({
        game_id: game.id,
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
    return send(res, 200, { game: gameWithCases(game), games: gamesList(admin.id) });
  }

  if (path === "/api/admin/game" && method === "GET") {
    const { admin } = requireAdmin(req, url);
    const game = ownedGame(admin, url.searchParams.get("id"));
    return send(res, 200, { game: gameWithCases(game), games: gamesList(admin.id) });
  }

  if (path === "/api/admin/game/save" && method === "POST") {
    const { admin } = requireAdmin(req, url);
    const body = await jsonBody(req);
    const game = ownedGame(admin, body.id);
    const patch = {};
    if (body.name !== undefined) {
      const name = String(body.name || "").trim().slice(0, 80);
      if (!name) throw new ApiError("NAME_REQUIRED", "Give the game a name.");
      patch.name = name;
    }
    if (body.description !== undefined) patch.description = String(body.description || "").trim().slice(0, 240);
    const updated = store.updateGame(game.id, patch);
    return send(res, 200, { game: gameWithCases(updated), games: gamesList(admin.id) });
  }

  if (path === "/api/admin/game/publish" && method === "POST") {
    const { admin } = requireAdmin(req, url);
    const body = await jsonBody(req);
    const game = ownedGame(admin, body.id);
    const status = body.status === "published" ? "published" : "draft";
    if (status === "published") {
      const cases = store.listCases(game.id);
      if (!cases.length) throw new ApiError("GAME_EMPTY", "Add at least one case before publishing.");
      const incomplete = cases.find((c) => !String(c.question).trim() || !String(c.correct_answer).trim());
      if (incomplete)
        throw new ApiError(
          "CASE_INCOMPLETE",
          `Case ${incomplete.case_number} still needs a question and a correct answer.`
        );
    }
    const updated = store.updateGame(game.id, { status });
    return send(res, 200, { game: gameWithCases(updated), games: gamesList(admin.id) });
  }

  if (path === "/api/admin/game/delete" && method === "POST") {
    const { admin } = requireAdmin(req, url);
    const body = await jsonBody(req);
    const game = ownedGame(admin, body.id);
    const inUse = store.roomsUsingGame(game.id);
    if (inUse.length)
      throw new ApiError("GAME_IN_USE", `This game is assigned to ${inUse.length} room(s). Unassign it first.`);
    store.deleteGame(game.id);
    return send(res, 200, { deleted: game.id, games: gamesList(admin.id) });
  }

  if (path === "/api/admin/game/case" && method === "POST") {
    const { admin } = requireAdmin(req, url);
    const body = await jsonBody(req);
    const game = ownedGame(admin, body.gameId);
    const input = readCaseInput(body);

    if (body.caseId) {
      const previous = store.findCase(body.caseId);
      if (!previous || previous.game_id !== game.id)
        throw new ApiError("CASE_NOT_FOUND", "That case no longer exists.", 404);
      const saved = store.updateCase(previous.id, input);
      if (previous.image_url && previous.image_url !== input.image_url) releaseUpload(previous.image_url);
      return send(res, 200, { case: caseShape(saved, true), games: gamesList(admin.id) });
    }

    const count = store.listCases(game.id).length;
    if (count >= MAX_CASES) throw new ApiError("TOO_MANY_CASES", `${MAX_CASES} cases maximum.`);
    const saved = store.insertCase({
      game_id: game.id,
      case_number: count + 1,
      sort_order: count,
      ...input,
    });
    return send(res, 200, { case: caseShape(saved, true), games: gamesList(admin.id) });
  }

  if (path === "/api/admin/game/case/delete" && method === "POST") {
    const { admin } = requireAdmin(req, url);
    const body = await jsonBody(req);
    const game = ownedGame(admin, body.gameId);
    const existing = store.findCase(String(body.caseId || ""));
    if (!existing || existing.game_id !== game.id)
      throw new ApiError("CASE_NOT_FOUND", "That case no longer exists.", 404);
    const file = existing.image_url;
    store.deleteCase(existing.id);
    // case numbers shift when one is removed, so progress recorded against
    // this game cannot be trusted any more
    const touched = store.clearProgressForGame(game.id);
    releaseUpload(file);
    return send(res, 200, { games: gamesList(admin.id), progressReset: touched });
  }

  if (path === "/api/admin/game/case/move" && method === "POST") {
    const { admin } = requireAdmin(req, url);
    const body = await jsonBody(req);
    const game = ownedGame(admin, body.gameId);
    const direction = Number(body.direction) < 0 ? -1 : 1;
    store.moveCase(game.id, String(body.caseId || ""), direction);
    const touched = store.clearProgressForGame(game.id);
    return send(res, 200, { games: gamesList(admin.id), progressReset: touched });
  }

  /* ---------------- admin: case image upload ---------------- */
  if (path === "/api/admin/upload" && method === "POST") {
    requireAdmin(req, url);
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
    start: ({ room }) => {
      if (room.status === "live") throw new ApiError("ALREADY_LIVE", "The game is already running.");
      if (room.status === "paused") throw new ApiError("PAUSED", "Resume the game instead.");
      if (room.status === "ended") throw new ApiError("ENDED", "Reset the room before starting a new game.");
      const game = gameOf(room);
      if (!game) throw new ApiError("NO_GAME", "Assign a game to this room before starting it.");
      if (game.status !== "published")
        throw new ApiError("GAME_DRAFT", "Publish this game before starting the room.");
      if (!totalCasesOf(room)) throw new ApiError("GAME_EMPTY", "The assigned game has no cases yet.");
      const start = Date.now();
      const updated = store.updateRoom(room.id, {
        status: "live",
        started_at: start,
        paused_since: null,
        paused_total: 0,
        ended_at: null,
      });
      store.touchSession(room.id, { start_time: start, end_time: null, duration: updated.duration, status: "live" });
      return updated;
    },
    pause: ({ room }) => {
      if (room.status !== "live") throw new ApiError("NOT_LIVE", "Only a running game can be paused.");
      store.touchSession(room.id, { status: "paused" });
      return store.updateRoom(room.id, { status: "paused", paused_since: Date.now() });
    },
    resume: ({ room }) => {
      if (room.status !== "paused") throw new ApiError("NOT_PAUSED", "The game is not paused.");
      const now = Date.now();
      const pausedTotal = (room.paused_total || 0) + Math.max(0, now - (room.paused_since || now));
      store.touchSession(room.id, { status: "live" });
      return store.updateRoom(room.id, { status: "live", paused_since: null, paused_total: pausedTotal });
    },
    end: ({ room }) => endRoom(room, "admin"),
    reset: ({ room }) => {
      store.resetRoomProgress(room.id);
      const updated = store.updateRoom(room.id, {
        status: "waiting",
        started_at: null,
        paused_since: null,
        paused_total: 0,
        ended_at: null,
        current_case: 1,
        case_auto: 1,
      });
      store.touchSession(room.id, {
        start_time: null,
        end_time: null,
        duration: updated.duration,
        status: "waiting",
      });
      return updated;
    },
    case: ({ room, body }) => {
      const patch = {};
      const total = totalCasesOf(room);
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
      return store.updateRoom(room.id, patch);
    },
    duration: ({ room, body }) => {
      if (room.status === "live") throw new ApiError("LIVE", "Pause or end the game before changing the duration.");
      const duration = clampDuration(body.duration);
      if (!duration) throw new ApiError("BAD_DURATION", "Choose a valid game duration.");
      const updated = store.updateRoom(room.id, { duration });
      store.touchSession(room.id, { duration });
      return updated;
    },
    /** Attach (or detach) a game to this room. Progress belongs to the game,
     *  so switching it clears every score in the room. */
    game: ({ room, body }) => {
      const gameId = body.gameId ? String(body.gameId) : null;
      if (gameId) {
        const game = store.findGame(gameId);
        if (!game) throw new ApiError("GAME_NOT_FOUND", "That game no longer exists.", 404);
        if (game.admin_id !== room.admin_id) throw new ApiError("FORBIDDEN", "This game belongs to another game master.", 403);
        if (game.status !== "published")
          throw new ApiError("GAME_DRAFT", "Publish this game before assigning it to a room.");
        if (!store.listCases(game.id).length) throw new ApiError("GAME_EMPTY", "Add at least one case to this game first.");
      }
      if (room.game_id === gameId) return room;
      store.updateRoom(room.id, { game_id: gameId, current_case: 1 });
      store.resetRoomProgress(room.id);
      return store.findRoomById(room.id);
    },
  };

  const actionMatch = path.match(/^\/api\/admin\/room\/([a-z]+)$/);
  if (actionMatch && method === "POST" && adminActions[actionMatch[1]]) {
    const body = await jsonBody(req);
    const { admin, room } = ownedRoom(req, url, body);
    const updated = await adminActions[actionMatch[1]]({ room, body, admin });
    syncRoom(room.id);
    return send(res, 200, {
      room: publicRoom(updated, store.listPlayers(updated.id), hub.onlineIds(updated.id).size),
      rooms: roomsSummaryFor(admin.id),
      leaderboard: updated.status === "ended" ? leaderboardShape(updated.id) : undefined,
    });
  }

  /* ---------------- real-time stream ---------------- */
  if (path === "/events" && method === "GET") {
    return openStream(req, res, url);
  }

  throw new ApiError("NOT_FOUND", "Unknown endpoint.", 404);
}

function openStream(req, res, url) {
  const payload = verify(bearer(req, url));
  if (!payload) throw new ApiError("UNAUTHORIZED", "Sign in required.", 401);

  const code = store.normalizeCode(url.searchParams.get("room"));
  const room = code ? store.findRoomByCode(code) : null;
  let client;

  if (payload.k === "player") {
    const player = store.findPlayer(payload.i);
    if (!player) throw new ApiError("SESSION_EXPIRED", "Session expired.", 401);
    if (!room || room.id !== player.room_id)
      throw new ApiError("FORBIDDEN", "Detectives can only follow their own room.", 403);
    client = { role: "player", roomId: room.id, playerId: player.id, res };
  } else {
    const admin = store.findAdminById(payload.i);
    if (!admin) throw new ApiError("UNAUTHORIZED", "Sign in required.", 401);
    if (room && room.admin_id !== admin.id)
      throw new ApiError("FORBIDDEN", "This room belongs to another game master.", 403);
    client = { role: "admin", roomId: room ? room.id : null, adminId: admin.id, res };
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...CORS,
  });

  hub.add(client);
  hub.emit(client, "state", stateFor(client.roomId, client));
  if (client.role === "admin") {
    hub.emit(client, "rooms", {
      type: "rooms",
      serverTime: Date.now(),
      rooms: roomsSummaryFor(client.adminId),
      games: gamesList(client.adminId),
    });
  }
  // A detective just came online: tell everyone else in the room too.
  if (client.role === "player" && client.roomId) syncRoom(client.roomId);

  const drop = () => {
    const gone = hub.remove(client.id);
    if (gone && gone.role === "player" && gone.roomId) syncRoom(gone.roomId);
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
  startTicker();
  try {
    await route(req, res, url);
  } catch (err) {
    if (err instanceof ApiError) {
      send(res, err.status, { code: err.code, message: err.message });
    } else {
      console.error("[deductive-404] request failed:", err);
      send(res, 500, { code: "SERVER_ERROR", message: "Unexpected server error." });
    }
  }
  return true;
}

export { syncRoom, roomsSummaryFor, leaderboardShape };
