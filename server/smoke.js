/**
 * End-to-end smoke test for the DETECTIVE 404 multiplayer backend.
 * Run with:  npm test            (SQLite — the local engine)
 *      or:  npm run test:pg     (PostgreSQL SQL via the in-process test engine)
 *      or:  npm run test:mongo  (MongoDB — in-process throw-away server, or
 *                                D404_MONGO_TEST_URI for a cluster; always uses
 *                                the d404-test database)
 * Uses an isolated throw-away database, so it never touches real rooms.
 *
 * The suite walks the whole new product loop:
 *   Game Builder -> publish -> assign to a room -> players join ->
 *   per-player START (independent timers, private start events) ->
 *   2 attempts per question (100 / 50 / 0) -> locked questions ->
 *   pause/resume -> final ranking -> reset -> second run.
 *
 * It ends by proving persistence: close the database, reopen it (a fresh
 * process would do the same), and everything created is still there — rooms,
 * games, cases, answers, scores and the admin account.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const usePg = process.argv.includes("--pg");
const useMongo = process.argv.includes("--mongo");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "d404-test-"));
process.env.D404_DATA_DIR = tmp;
process.env.D404_ADMIN_PASSWORD = "smoke-secret";

/** Throw-away MongoDB for this run (set before db.js loads, see config.js). */
let memoryServer = null;
if (useMongo) {
  if (process.env.D404_MONGO_TEST_URI) {
    process.env.MONGODB_URI = process.env.D404_MONGO_TEST_URI;
  } else {
    // A single-node replica set, like Atlas free tier — so the run exercises
    // the same multi-document transaction path production uses.
    const { MongoMemoryReplSet } = await import("mongodb-memory-server");
    memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    process.env.MONGODB_URI = memoryServer.getUri();
  }
  process.env.D404_MONGODB_DB = "d404-test"; // never a real database
  delete process.env.DATABASE_URL;
} else if (usePg) {
  process.env.DATABASE_URL = "pglite:"; // must be set before db.js loads
  delete process.env.MONGODB_URI; // an ambient Atlas URI must not hijack this run
} else {
  delete process.env.DATABASE_URL;
  delete process.env.MONGODB_URI;
}

const store = await import("./db.js");
const { handleRequest } = await import("./api.js");
const { MAX_PLAYERS_PER_ROOM } = await import("./config.js");

let passed = 0;
const failures = [];
const ok = (cond, label) => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
};

await store.seedAdmin();

const server = http.createServer((req, res) => {
  handleRequest(req, res).then((handled) => {
    if (!handled && !res.headersSent) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "NOT_FOUND" }));
    }
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

async function call(pathname, { method = "GET", body, token } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, data };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`\nDETECTIVE 404 — backend smoke test  ·  engine: ${store.engineLabel}\n`);

/* ---------------------------------------------------------------- *
 * 1. health
 * ---------------------------------------------------------------- */
{
  const { status, data } = await call("/api/health");
  ok(status === 200 && data.ok && data.serverTime > 0, "health endpoint is alive");
}

/* ---------------------------------------------------------------- *
 * 2. admin auth
 * ---------------------------------------------------------------- */
let adminToken;
{
  const bad = await call("/api/admin/login", { method: "POST", body: { username: "admin", password: "wrong" } });
  ok(bad.status === 401, "wrong admin password is rejected");

  const good = await call("/api/admin/login", {
    method: "POST",
    body: { username: "admin", password: "smoke-secret" },
  });
  ok(good.status === 200 && !!good.data.token, "admin can log in");
  ok(Array.isArray(good.data.games), "admin login hands back the game library");
  adminToken = good.data.token;
}

/* ---------------------------------------------------------------- *
 * 3. anonymous callers are locked out of the admin API
 * ---------------------------------------------------------------- */
{
  const anon = await call("/api/admin/games");
  ok(anon.status === 401, "anonymous caller cannot reach the admin API");
}

/* ---------------------------------------------------------------- *
 * 4. Game Builder — create a game (old hard-coded cases are gone)
 * ---------------------------------------------------------------- */
let game, cases;
{
  const { status, data } = await call("/api/admin/games", {
    method: "POST",
    token: adminToken,
    body: { name: "Mystery of the Hidden Diamond", description: "A gala, a locked case, one missing stone.", caseCount: 3 },
  });
  ok(status === 200 && data.game.status === "draft", "game is created as a draft");
  ok(Array.isArray(data.game.cases) && data.game.cases.length === 3, "three empty cases are pre-created");
  ok(Array.isArray(data.games) && data.games.length === 1, "the game appears in the library");
  game = data.game;
  cases = data.game.cases;

  const incomplete = await call("/api/admin/game/publish", {
    method: "POST",
    token: adminToken,
    body: { id: game.id, status: "published" },
  });
  ok(
    incomplete.status === 400 && incomplete.data.code === "CASE_INCOMPLETE",
    "a game with empty cases cannot be published"
  );
}

/* ---------------------------------------------------------------- *
 * 5. rooms cannot start without a game
 * ---------------------------------------------------------------- */
let room;
{
  const { status, data } = await call("/api/admin/rooms", {
    method: "POST",
    token: adminToken,
    body: { roomName: "Validation Test", duration: 45 * 60 * 1000 },
  });
  ok(status === 200 && /^[A-Z0-9]{6}$/.test(data.room.roomCode), "room created with a 6 character code");
  ok(!data.room.gameId, "a new room starts with no game assigned");
  room = data.room;

  const adminStart = await call("/api/admin/room/start", {
    method: "POST",
    token: adminToken,
    body: { code: room.roomCode },
  });
  ok(
    adminStart.status === 403 && adminStart.data.code === "ADMIN_START_DISABLED",
    "the game master has no START GAME control"
  );

  const draft = await call("/api/admin/room/game", {
    method: "POST",
    token: adminToken,
    body: { code: room.roomCode, gameId: game.id },
  });
  ok(draft.status === 400 && draft.data.code === "GAME_DRAFT", "an unpublished game cannot be assigned");
}

/* ---------------------------------------------------------------- *
 * 6. write the three cases (text / multiple choice / true-false)
 * ---------------------------------------------------------------- */
{
  const first = await call("/api/admin/game/case", {
    method: "POST",
    token: adminToken,
    body: {
      gameId: game.id,
      caseId: cases[0].id,
      caseTitle: "The Missing Necklace",
      imageUrl: "",
      question: "Who stole the necklace?",
      questionType: "text",
      options: [],
      correctAnswer: "Arun",
      clue: "Look carefully at the security-camera timing.",
      pointsFirst: 100,
      pointsSecond: 50,
    },
  });
  ok(first.status === 200 && first.data.case.correctAnswer === "Arun", "text case saved with its answer and clue");

  const second = await call("/api/admin/game/case", {
    method: "POST",
    token: adminToken,
    body: {
      gameId: game.id,
      caseId: cases[1].id,
      caseTitle: "The Sealed Room",
      imageUrl: "",
      question: "Where was the spare key hidden?",
      questionType: "mcq",
      options: ["Under the bed", "In the safe", "Behind the painting", "In the flower pot"],
      correctAnswer: "Behind the painting",
      clue: "Not where anyone would normally look.",
      pointsFirst: 100,
      pointsSecond: 50,
    },
  });
  ok(second.status === 200 && second.data.case.type === "mcq", "multiple choice case saved with its options");

  const third = await call("/api/admin/game/case", {
    method: "POST",
    token: adminToken,
    body: {
      gameId: game.id,
      caseId: cases[2].id,
      caseTitle: "The Staged Break-in",
      imageUrl: "",
      question: "Was the trap ever real?",
      questionType: "boolean",
      options: [],
      correctAnswer: "yes",
      clue: "Ask who benefits from a sealed room.",
      pointsFirst: 100,
      pointsSecond: 50,
    },
  });
  ok(third.status === 200 && third.data.case.correctAnswer === "True", "true/false normalises the stored answer");

  const badChoice = await call("/api/admin/game/case", {
    method: "POST",
    token: adminToken,
    body: {
      gameId: game.id,
      caseId: cases[1].id,
      caseTitle: "The Sealed Room",
      imageUrl: "",
      question: "Where was the spare key hidden?",
      questionType: "mcq",
      options: ["Under the bed", "In the safe"],
      correctAnswer: "Behind the painting",
      clue: "",
      pointsFirst: 100,
      pointsSecond: 50,
    },
  });
  ok(badChoice.status === 400 && badChoice.data.code === "BAD_ANSWER", "a multiple choice answer must be an option");
}

/* ---------------------------------------------------------------- *
 * 7. case image upload
 * ---------------------------------------------------------------- */
let uploadedUrl;
{
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  const anon = await call("/api/admin/upload", { method: "POST", body: { dataUrl: PNG } });
  ok(anon.status === 401, "anonymous caller cannot upload images");

  const up = await call("/api/admin/upload", { method: "POST", token: adminToken, body: { dataUrl: PNG } });
  ok(up.status === 200 && /^\/uploads\/[A-Za-z0-9._-]+$/.test(up.data.url), "case image uploads and returns a URL");
  uploadedUrl = up.data.url;

  const served = await fetch(BASE + uploadedUrl);
  ok(served.status === 200 && served.headers.get("content-type") === "image/png", "the uploaded image is served back");

  const save = await call("/api/admin/game/case", {
    method: "POST",
    token: adminToken,
    body: {
      gameId: game.id,
      caseId: cases[0].id,
      caseTitle: "The Missing Necklace",
      imageUrl: uploadedUrl,
      question: "Who stole the necklace?",
      questionType: "text",
      options: [],
      correctAnswer: "Arun",
      clue: "Look carefully at the security-camera timing.",
      pointsFirst: 100,
      pointsSecond: 50,
    },
  });
  ok(save.data.case.imageUrl === uploadedUrl, "the case now carries its uploaded image");

  const badImage = await call("/api/admin/upload", {
    method: "POST",
    token: adminToken,
    body: { dataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" },
  });
  ok(badImage.status === 400 && badImage.data.code === "BAD_IMAGE", "SVG uploads are refused");
}

/* ---------------------------------------------------------------- *
 * 8. publish, then assign to the room
 * ---------------------------------------------------------------- */
{
  const pub = await call("/api/admin/game/publish", {
    method: "POST",
    token: adminToken,
    body: { id: game.id, status: "published" },
  });
  ok(pub.status === 200 && pub.data.game.status === "published", "a complete game can be published");

  const assign = await call("/api/admin/room/game", {
    method: "POST",
    token: adminToken,
    body: { code: room.roomCode, gameId: game.id },
  });
  ok(assign.status === 200 && assign.data.room.gameId === game.id, "published game is assigned to the room");
  ok(assign.data.room.totalCases === 3, "the room now reports three questions");
}

/* ---------------------------------------------------------------- *
 * 9. players join
 * ---------------------------------------------------------------- */
let tokA, tokB;
{
  const missingName = await call("/api/join", {
    method: "POST",
    body: { roomCode: "ZZZZZZ", playerName: "Detective" },
  });
  ok(missingName.status === 400 && missingName.data.code === "ROOM_NOT_FOUND", "unknown room code -> Invalid Room Code");

  const badCode = await call("/api/join", { method: "POST", body: { roomCode: "!!", playerName: "Arjun" } });
  ok(
    badCode.status === 400 && badCode.data.code === "INVALID_ROOM_CODE",
    "malformed room code -> INVALID_ROOM_CODE"
  );
  ok(/six letters or digits/i.test(badCode.data.message), "the malformed-code message explains the format");

  const a = await call("/api/join", {
    method: "POST",
    body: { roomCode: room.roomCode, playerName: "Arjun" },
  });
  ok(a.status === 200 && !!a.data.token && a.data.you.case === 1, "detective Arjun joins the room");
  ok(a.data.question && a.data.question.caseNumber === 1, "the join response carries the first question");
  tokA = a.data.token;

  const dup = await call("/api/join", {
    method: "POST",
    body: { roomCode: room.roomCode, playerName: "arjun" },
  });
  ok(dup.status === 409 && dup.data.code === "NAME_TAKEN", "duplicate detective name is blocked");

  const b = await call("/api/join", {
    method: "POST",
    body: { roomCode: room.roomCode, playerName: "Sarah" },
  });
  ok(b.status === 200, "second detective joins");
  tokB = b.data.token;
}

/* ---------------------------------------------------------------- *
 * 10. locking + answer secrecy (backend enforced)
 * ---------------------------------------------------------------- */
{
  const state = await call("/api/session", { token: tokA });
  ok(state.data.room.roomCode === room.roomCode, "player session stays locked to its own room");
  ok(state.data.room.totalCases === 3, "the player dashboard sees the assigned game size");
  ok(state.data.question.correctAnswer === null, "a live question never leaks its answer to the browser");
  ok(state.data.question.completed === false, "the question starts as not completed");

  const list = state.data.questionList;
  ok(
    list.length === 3 && list[0].state === "active" && list[1].state === "locked" && list[2].state === "locked",
    "future questions are reported as LOCKED"
  );

  const early = await call("/api/answer", {
    method: "POST",
    token: tokA,
    body: { caseId: 1, answer: "Arun" },
  });
  ok(early.status === 400 && early.data.code === "NOT_LIVE", "answers are refused before START GAME");
}

/* ---------------------------------------------------------------- *
 * 11. start the game — INDIVIDUAL, one clock per detective
 * ---------------------------------------------------------------- */
{
  const gmAttempt = await call("/api/admin/room/start", {
    method: "POST",
    token: adminToken,
    body: { code: room.roomCode },
  });
  ok(gmAttempt.status === 403, "the admin cannot start the game even with players waiting");

  const { status, data } = await call("/api/game/start", { method: "POST", token: tokA });
  ok(status === 200 && data.room.status === "live" && data.room.startedAt > 0, "a detective starts the game");
  ok(data.started === true && data.alreadyStarted === false, "the response confirms THIS seat started");
  ok(data.players.length >= 2, "the whole room roster comes back — not just the caller");
  ok(data.room.remaining > 0 && data.room.remaining <= 45 * 60 * 1000, "countdown derives from the stored start time");
  ok(
    data.you.startedAt > 0 && data.you.endsAt - data.you.startedAt === 45 * 60 * 1000,
    "the starter opens a full-length PERSONAL clock (start + duration)"
  );

  const other = await call("/api/session", { token: tokB });
  ok(other.data.room.status === "live", "the room itself reads live once anyone starts");
  ok(!other.data.you.startedAt, "the OTHER detective is still waiting — start is individual, not room-wide");
  ok(!other.data.you.endsAt, "no timer exists for a detective who has not pressed START");

  await sleep(10);
  const startB = await call("/api/game/start", { method: "POST", token: tokB });
  ok(startB.status === 200 && startB.data.you.startedAt > 0, "the second detective then starts their OWN session");
  ok(
    startB.data.you.endsAt - startB.data.you.startedAt === 45 * 60 * 1000,
    "their timer starts fresh from the full configured duration"
  );
  const afterB = await call("/api/session", { token: tokA });
  ok(afterB.data.you.endsAt === data.you.endsAt, "one detective's START never resets or touches another's timer");

  const jumped = await call("/api/answer", {
    method: "POST",
    token: tokA,
    body: { caseId: 2, answer: "Behind the painting" },
  });
  ok(jumped.status === 400 && jumped.data.code === "LOCKED", "the next question cannot be answered out of order");
}

/* ---------------------------------------------------------------- *
 * 12. question 1 — attempt 1 wrong (clue), attempt 2 correct (+50)
 * ---------------------------------------------------------------- */
{
  const tooLong = await call("/api/answer", {
    method: "POST",
    token: tokA,
    body: { caseId: 1, answer: "the security guard had access to the display case" },
  });
  ok(tooLong.status === 400 && tooLong.data.code === "TOO_LONG", "answers longer than 3 words are refused");

  const wrong = await call("/api/answer", {
    method: "POST",
    token: tokA,
    body: { caseId: 1, answer: "the moon" },
  });
  ok(wrong.status === 200 && wrong.data.correct === false && wrong.data.attempt === 1, "first wrong attempt is recorded");
  ok(wrong.data.points === 0 && wrong.data.completed === false, "a wrong first attempt closes nothing");
  ok(typeof wrong.data.clue === "string" && wrong.data.clue.includes("security-camera"), "the configured clue is revealed");
  ok(wrong.data.answer === null, "the correct answer is NOT revealed after one miss");

  const right = await call("/api/answer", {
    method: "POST",
    token: tokA,
    body: { caseId: 1, answer: "  ARUN!  " },
  });
  ok(right.status === 200 && right.data.correct === true, "case, spacing and punctuation are ignored");
  ok(right.data.attempt === 2 && right.data.points === 50, "second attempt correct awards 50 points");
  ok(right.data.completed === true && right.data.awaitingNext === true, "the question is closed and the next unlocks");

  const replay = await call("/api/answer", {
    method: "POST",
    token: tokA,
    body: { caseId: 1, answer: "Arun" },
  });
  ok(replay.status === 400 && replay.data.code === "QUESTION_COMPLETE", "a completed question cannot be re-submitted");

  const state = await call("/api/session", { token: tokA });
  ok(state.data.you.score === 50 && state.data.you.completedCount === 1, "score and progress are stored server-side");
  ok(state.data.questionList[0].state === "completed", "question 1 shows ✓ COMPLETED");
  ok(state.data.questionList[1].state === "unlocked", "question 2 is unlocked once question 1 is done");
  ok(state.data.questionList[2].state === "locked", "question 3 is still locked");

  const other = await call("/api/session", { token: tokB });
  ok(other.data.you.score === 0 && other.data.questionList[0].state === "active", "players keep their own progress");
}

/* ---------------------------------------------------------------- *
 * 13. advance (and nobody can skip)
 * ---------------------------------------------------------------- */
{
  const early = await call("/api/next", { method: "POST", token: tokB });
  ok(early.status === 400 && early.data.code === "NOT_READY", "cannot skip an unanswered question");

  const skipped = await call("/api/next", { method: "POST", token: tokA });
  ok(skipped.status === 200 && skipped.data.you.case === 2, "detective advances to question 2");

  const state = await call("/api/session", { token: tokA });
  ok(state.data.you.case === 2 && state.data.you.score === 50, "progress survives a refresh (server restored)");
  ok(state.data.question.type === "mcq" && state.data.question.options.length === 4, "the next question arrives as options");
  ok(state.data.question.correctAnswer === null, "an unlocked live question still hides its answer");

  const notReady = await call("/api/answer", {
    method: "POST",
    token: tokB,
    body: { caseId: 2, answer: "Behind the painting" },
  });
  ok(notReady.status === 400 && notReady.data.code === "LOCKED", "another detective cannot answer past their lock");
}

/* ---------------------------------------------------------------- *
 * 14. question 2 — correct on the first attempt (+100)
 * ---------------------------------------------------------------- */
{
  const right = await call("/api/answer", {
    method: "POST",
    token: tokA,
    body: { caseId: 2, answer: "behind the painting" },
  });
  ok(right.status === 200 && right.data.correct === true && right.data.points === 100, "first attempt correct awards 100 points");

  const state = await call("/api/session", { token: tokA });
  ok(state.data.you.score === 150, "total score is now 150");

  const next = await call("/api/next", { method: "POST", token: tokA });
  ok(next.status === 200 && next.data.you.case === 3, "detective advances to question 3");
}

/* ---------------------------------------------------------------- *
 * 15. question 3 — wrong twice (0 points, answer revealed)
 * ---------------------------------------------------------------- */
{
  const first = await call("/api/answer", {
    method: "POST",
    token: tokA,
    body: { caseId: 3, answer: "false" },
  });
  ok(first.status === 200 && first.data.correct === false && first.data.clue, "true/false first miss hands back the clue");

  const second = await call("/api/answer", {
    method: "POST",
    token: tokA,
    body: { caseId: 3, answer: "no" },
  });
  ok(second.status === 200 && second.data.correct === false, "second wrong attempt is recorded");
  ok(second.data.points === 0 && second.data.completed === true, "two wrong attempts award zero and close the question");
  ok(second.data.answer === "True", "the correct answer is revealed only at the end");

  const next = await call("/api/next", { method: "POST", token: tokA });
  ok(next.status === 200 && next.data.finished === true, "the last question closes the case");

  const state = await call("/api/session", { token: tokA });
  ok(state.data.you.status === "finished" && state.data.you.completedCount === 3, "every question is marked completed");
  ok(state.data.you.score === 150, "final score is 50 + 100 + 0 = 150");
}

/* ---------------------------------------------------------------- *
 * 16. players cannot touch admin routes
 * ---------------------------------------------------------------- */
{
  const asPlayer = await call("/api/admin/room/end", {
    method: "POST",
    token: tokA,
    body: { code: room.roomCode },
  });
  ok(asPlayer.status === 403, "player token cannot end the game");

  const forged = "d404.eyJrIjoiYWRtaW4ifQ.forged-signature";
  const spoof = await call("/api/admin/games", { token: forged });
  ok(spoof.status === 401, "forged token is rejected");
}

/* ---------------------------------------------------------------- *
 * 17. pause / resume keeps the clock honest
 * ---------------------------------------------------------------- */
{
  const paused = await call("/api/admin/room/pause", {
    method: "POST",
    token: adminToken,
    body: { code: room.roomCode },
  });
  ok(paused.status === 200 && paused.data.room.status === "paused", "game master pauses");
  const before = paused.data.room.remaining;

  await new Promise((r) => setTimeout(r, 250));
  const still = await call("/api/session", { token: tokB });
  ok(Math.abs(still.data.room.remaining - before) < 60, "paused clock does not keep counting down");

  const resumed = await call("/api/admin/room/resume", {
    method: "POST",
    token: adminToken,
    body: { code: room.roomCode },
  });
  ok(resumed.status === 200 && resumed.data.room.status === "live", "game master resumes");
}

/* ---------------------------------------------------------------- *
 * 18. leaderboard + lockout
 * ---------------------------------------------------------------- */
{
  const end = await call("/api/admin/room/end", { method: "POST", token: adminToken, body: { code: room.roomCode } });
  ok(end.status === 200 && end.data.room.status === "ended", "game master ends the game");
  ok(Array.isArray(end.data.leaderboard) && end.data.leaderboard.length === 2, "leaderboard is generated");
  ok(end.data.leaderboard[0].name === "Arjun" && end.data.leaderboard[0].score === 150, "ranking puts the highest score first");

  const locked = await call("/api/answer", {
    method: "POST",
    token: tokB,
    body: { caseId: 1, answer: "Arun" },
  });
  ok(locked.status === 400, "answers are locked after TIME'S UP");
}

/* ---------------------------------------------------------------- *
 * 19. reset + a second run
 * ---------------------------------------------------------------- */
{
  const reset = await call("/api/admin/room/reset", { method: "POST", token: adminToken, body: { code: room.roomCode } });
  ok(reset.status === 200 && reset.data.room.status === "waiting", "reset returns the room to WAITING");

  const state = await call("/api/session", { token: tokA });
  ok(
    state.data.you.case === 1 && state.data.you.score === 0 && state.data.you.completedCount === 0,
    "reset clears every detective's progress"
  );

  await call("/api/game/start", { method: "POST", token: tokA });
  const fresh = await call("/api/answer", {
    method: "POST",
    token: tokA,
    body: { caseId: 1, answer: "Arun" },
  });
  ok(fresh.status === 200 && fresh.data.correct === true && fresh.data.points === 100, "room is playable again after reset");
  ok(fresh.data.attempt === 1, "attempts restart at one");
}

/* ---------------------------------------------------------------- *
 * 20. editing the case list resets progress and renumbers
 * ---------------------------------------------------------------- */
{
  const del = await call("/api/admin/game/case/delete", {
    method: "POST",
    token: adminToken,
    body: { gameId: game.id, caseId: cases[2].id },
  });
  ok(del.status === 200 && del.data.games[0].caseCount === 2, "deleting a case renumbers the game");

  const state = await call("/api/session", { token: tokA });
  ok(state.data.you.score === 0 && state.data.you.completedCount === 0, "changing the case list resets that game's progress");
}

/* ---------------------------------------------------------------- *
 * 21. multiple games + deletion rules
 * ---------------------------------------------------------------- */
let secondGame;
{
  const two = await call("/api/admin/games", {
    method: "POST",
    token: adminToken,
    body: { name: "The Haunted Hotel", caseCount: 1 },
  });
  ok(two.status === 200 && two.data.games.length === 2, "a second game can be created without touching the code");
  secondGame = two.data.game;

  const inUse = await call("/api/admin/game/delete", {
    method: "POST",
    token: adminToken,
    body: { id: game.id },
  });
  ok(inUse.status === 400 && inUse.data.code === "GAME_IN_USE", "a game assigned to a room cannot be deleted");

  const detach = await call("/api/admin/room/game", {
    method: "POST",
    token: adminToken,
    body: { code: room.roomCode, gameId: "" },
  });
  ok(detach.status === 200 && !detach.data.room.gameId, "a game can be unassigned from a room");

  const gone = await call("/api/admin/game/delete", { method: "POST", token: adminToken, body: { id: game.id } });
  ok(gone.status === 200 && gone.data.games.length === 1, "an unassigned game can be deleted");

  const detail = await call(`/api/admin/game?id=${secondGame.id}`, { token: adminToken });
  ok(detail.status === 200 && detail.data.game.cases.length === 1, "a game can be re-opened in the editor");
}

/* ---------------------------------------------------------------- *
 * 14. rooms — one room can be created and deleted on its own
 * ---------------------------------------------------------------- */
{
  const mk = async (name) => {
    const { data } = await call("/api/admin/rooms", {
      method: "POST",
      token: adminToken,
      body: { roomName: name, duration: 30 * 60 * 1000 },
    });
    return data.room;
  };
  const doomed = await mk("Room To Delete");
  const keeper = await mk("Room That Stays");

  const doomedId = (await store.findRoomByCode(doomed.roomCode))?.id;
  const keeperId = (await store.findRoomByCode(keeper.roomCode))?.id;

  const joined = await call("/api/join", {
    method: "POST",
    body: { roomCode: doomed.roomCode, playerName: "Ada" },
  });
  ok(joined.status === 200, "a detective can join the room that is about to be deleted");

  const rows = await store.roomRowCounts(doomedId);
  ok(rows.players === 1, "the room holds exactly that detective before the delete");

  const anon = await call(`/api/admin/rooms?code=${doomed.roomCode}`, { method: "DELETE" });
  ok(anon.status === 401, "an anonymous caller cannot delete a room");

  const del = await call(`/api/admin/rooms?code=${doomed.roomCode}`, { method: "DELETE", token: adminToken });
  ok(del.status === 200 && Array.isArray(del.data.rooms), "the room is deleted once the admin confirms");

  const after = await call("/api/admin/rooms", { token: adminToken });
  ok(!after.data.rooms.some((r) => r.roomCode === doomed.roomCode), "the deleted room is gone from the room list");
  ok(after.data.rooms.some((r) => r.roomCode === keeper.roomCode), "the other room is still in the list");
  ok(after.data.rooms.some((r) => r.roomCode === room.roomCode), "the original test room still exists");

  ok(!(await store.findRoomById(doomedId)), "the room row itself is removed");
  const afterCounts = await store.roomRowCounts(doomedId);
  ok(
    afterCounts.players === 0 &&
      afterCounts.answers === 0 &&
      afterCounts.player_progress === 0 &&
      afterCounts.game_sessions === 0,
    "its players, answers, scores and session rows are removed with it"
  );
  ok(!!(await store.findRoomById(keeperId)), "the other room's row is intact");

  const again = await call(`/api/admin/rooms?code=${doomed.roomCode}`, { method: "DELETE", token: adminToken });
  ok(again.status === 404, "deleting the same room twice reports it no longer exists");
}

/* ---------------------------------------------------------------- *
 * 21. MULTIPLAYER — ONE ROOM, MANY SIMULTANEOUS PLAYERS
 *
 * The heart of the product: a room is a container for up to
 * MAX_PLAYERS_PER_ROOM detectives, each with their own id, session,
 * progress and score. Nothing here may be satisfied by a single
 * in-memory "current player".
 * ---------------------------------------------------------------- */
const makeRoom = async (name) => {
  const r = await call("/api/admin/rooms", { method: "POST", token: adminToken, body: { name, duration: 30 } });
  return r.data.room.roomCode;
};
const joinMany = (code, n, prefix) =>
  Promise.all(
    Array.from({ length: n }, (_, i) =>
      call("/api/join", { method: "POST", body: { roomCode: code, playerName: `${prefix} ${i + 1}` } })
    )
  );
const roomRoster = async (code) => (await call(`/api/admin/room?code=${code}`, { token: adminToken })).data;

{
  ok(MAX_PLAYERS_PER_ROOM === 50, `room capacity defaults to 50 players (got ${MAX_PLAYERS_PER_ROOM})`);

  /* --- 10 / 25 / 50 players joining the same room at once --- */
  for (const n of [10, 25, 50]) {
    const code = await makeRoom(`Load test ${n}`);
    const res = await joinMany(code, n, `L${n}`);
    const good = res.filter((r) => r.status === 200);
    const ids = new Set(good.map((r) => r.data.playerId));

    ok(good.length === n, `${n} simultaneous joins: all ${n} accepted`);
    ok(ids.size === n, `${n} simultaneous joins: ${n} distinct player ids`);
    ok(
      good.every((r, i) => r.data.success === true && r.data.roomCode === code),
      `${n} simultaneous joins: every response names the same room`
    );

    const list = await roomRoster(code);
    ok(list.players.length === n, `the game master roster lists all ${n} players`);
    ok(
      new Set(list.players.map((p) => p.id)).size === n,
      `no player record was overwritten by another (${n} rows, ${n} ids)`
    );
    ok(list.room.capacity === MAX_PLAYERS_PER_ROOM, `the room advertises capacity ${MAX_PLAYERS_PER_ROOM}`);
    ok(
      list.players.every((p) => typeof p.lastActive === "number"),
      "every player carries last-seen / heartbeat information"
    );
  }

  /* --- player 51 is rejected, and only because the room is full --- */
  {
    const code = await makeRoom("Capacity test");
    const first = await joinMany(code, MAX_PLAYERS_PER_ROOM, "C");
    ok(first.every((r) => r.status === 200), `the first ${MAX_PLAYERS_PER_ROOM} detectives are all let in`);

    const extra = await call("/api/join", {
      method: "POST",
      body: { roomCode: code, playerName: "Detective Fifty-One" },
    });
    ok(extra.status === 409, "player 51 is rejected");
    ok(extra.data.code === "ROOM_FULL", `the rejection is ROOM_FULL (got ${extra.data.code})`);
    ok(/full/i.test(extra.data.message), "the message tells the player the room is full");

    const list = await roomRoster(code);
    ok(list.players.length === MAX_PLAYERS_PER_ROOM, "the room still holds exactly 50 players");

    const rooms = await call("/api/admin/rooms", { token: adminToken });
    const other = rooms.data.rooms.find((r) => r.players < MAX_PLAYERS_PER_ROOM);
    const lateButOpen = await call("/api/join", {
      method: "POST",
      body: { roomCode: other.roomCode, playerName: "Detective Fifty-One" },
    });
    ok(lateButOpen.status === 200, "the same player joins a different, emptier room straight away");
  }

  /* --- two players, one display name --- */
  {
    const code = await makeRoom("Same name test");
    const clashes = await Promise.all([
      call("/api/join", { method: "POST", body: { roomCode: code, playerName: "Arun Kumar" } }),
      call("/api/join", { method: "POST", body: { roomCode: code, playerName: "Arun Kumar" } }),
    ]);
    const won = clashes.filter((r) => r.status === 200);
    const lost = clashes.filter((r) => r.status !== 200);
    ok(won.length === 1, "exactly one of two identical names gets the seat");
    ok(
      lost.length === 1 && lost[0].data.code === "NAME_TAKEN",
      `the other is told NAME_TAKEN, not a generic error (got ${lost[0]?.data?.code})`
    );
    ok(clashes.every((r) => r.status !== 500), "a duplicate name never produces a server error");

    const list = await roomRoster(code);
    ok(list.players.length === 1, "a name clash leaves exactly one player record");
  }

  /* --- one returning detective reclaims their own seat + progress --- */
  {
    const code = await makeRoom("Reconnect test");
    const first = await call("/api/join", { method: "POST", body: { roomCode: code, playerName: "Priya" } });
    const playerId = first.data.playerId;
    ok(first.status === 200 && !!playerId, "a detective joins and receives a session token");

    // Simulate a browser refresh / dropped network: last heartbeat ages out.
    await store.updatePlayer(playerId, { last_active: 0 });
    const again = await call("/api/join", { method: "POST", body: { roomCode: code, playerName: "Priya" } });
    ok(again.status === 200, "the same name may rejoin after the session drops");
    ok(again.data.playerId === playerId, "rejoining restores the SAME player id — nothing is overwritten");
    const list = await roomRoster(code);
    ok(list.players.length === 1, "rejoining does not create a second row for one detective");
  }

  /* --- several rooms side by side, joined at the same moment --- */
  {
    const [a, b] = await Promise.all([makeRoom("Parallel A"), makeRoom("Parallel B")]);
    const [ra0, rb0] = await Promise.all([joinMany(a, 5, "A"), joinMany(b, 7, "B")]);
    const mixed = [...ra0, ...rb0];
    ok(mixed.filter((r) => r.status === 200).length === 12, "twelve players join two rooms at the same moment");
    const ra = await roomRoster(a);
    const rb = await roomRoster(b);
    ok(ra.players.length === 5 && rb.players.length === 7, "each room keeps its own roster (5 and 7)");
    ok(
      ra.players.every((p) => p.name.startsWith("A ")) && rb.players.every((p) => p.name.startsWith("B ")),
      "no player leaked from one room into another"
    );
  }

  /* --- disconnecting removes ONE player, never the room --- */
  {
    const code = await makeRoom("Disconnect test");
    const res = await joinMany(code, 4, "D");
    const tokens = res.map((r) => r.data.token);
    ok(tokens.every(Boolean), "every player receives its own session token");
    ok(new Set(tokens).size === 4, "session tokens are unique per player");

    // Every player opens their own live stream — four sockets, one room.
    const controllers = [];
    for (const t of tokens) {
      const ac = new AbortController();
      const stream = await fetch(`${BASE}/events?room=${code}`, {
        headers: { authorization: `Bearer ${t}`, accept: "text/event-stream" },
        signal: ac.signal,
      });
      ok(stream.status === 200, "a player opens a live stream for the room");
      controllers.push(ac);
    }
    await sleep(200);
    const live = await roomRoster(code);
    ok(live.room.onlineCount === 4, `all four streams count as online (got ${live.room.onlineCount})`);

    // Detective 1 disconnects: only their socket may drop.
    controllers[0].abort();
    await sleep(300);

    const list = await roomRoster(code);
    ok(list.players.length === 4, "closing one connection leaves all four players in the room");
    ok(list.room.onlineCount === 3, `exactly one player went offline (got ${list.room.onlineCount})`);
    const others = await Promise.all(tokens.slice(1).map((t) => call("/api/session", { token: t })));
    ok(others.every((s) => s.status === 200), "the other three sessions are untouched by that disconnect");
    for (const ac of controllers.slice(1)) ac.abort();
    await sleep(200);
  }
}

/* ---------------------------------------------------------------- *
 * 22. START GAME belongs to each player — INDIVIDUAL, min 1, max 50
 *
 * Every seat starts its own session: its own start timestamp, its own
 * expiry (start + configured duration) and its own private push. The
 * game master has no start control at all, and one detective's START
 * is never broadcast as a "game started" to the rest of the room.
 * ---------------------------------------------------------------- */
{
  // (a) no game assigned -> a player cannot start it either
  const bare = await makeRoom("Start without a game");
  const solo = await call("/api/join", { method: "POST", body: { roomCode: bare, playerName: "Early Bird" } });
  ok(solo.status === 200, "one detective joins a room that has no game yet");
  const noGame = await call("/api/game/start", { method: "POST", token: solo.data.token });
  ok(noGame.status === 400 && noGame.data.code === "NO_GAME", "a room without a game cannot start");

  // (b) a real room, published game, ONE player -> enough to start
  //     (section 21 deleted the first game and left this one with an empty
  //     placeholder case, so complete it before publishing)
  const detail = await call(`/api/admin/game?id=${secondGame.id}`, { token: adminToken });
  const placeholder = detail.data.game.cases[0];
  const filled = await call("/api/admin/game/case", {
    method: "POST",
    token: adminToken,
    body: {
      gameId: secondGame.id,
      caseId: placeholder.id,
      caseTitle: "The Sealed Study",
      imageUrl: "",
      question: "Where was the key hidden?",
      questionType: "text",
      options: [],
      correctAnswer: "loose brick",
      clue: "Check behind the fireplace.",
      pointsFirst: 100,
      pointsSecond: 50,
    },
  });
  ok(filled.status === 200, "the surviving game's placeholder case is completed");

  const pub = await call("/api/admin/game/publish", {
    method: "POST",
    token: adminToken,
    body: { id: secondGame.id, status: "published" },
  });
  ok(pub.status === 200 && pub.data.game.status === "published", "the game can be published for the start test");

  const code = await makeRoom("Player start test");
  const assign = await call("/api/admin/room/game", {
    method: "POST",
    token: adminToken,
    body: { code, gameId: secondGame.id },
  });
  ok(assign.status === 200, `the published game is assigned to the test room (got ${assign.status} ${assign.data?.code || ""})`);

  const one = await call("/api/join", { method: "POST", body: { roomCode: code, playerName: "First Detective" } });
  ok(one.status === 200 && one.data.room.playerCount === 1, "a single detective is enough — no waiting for 50");

  const gm = await call("/api/admin/room/start", { method: "POST", token: adminToken, body: { code } });
  ok(gm.status === 403 && gm.data.code === "ADMIN_START_DISABLED", "the game master is refused with a clear code");

  // Player 2 opens a live stream and just watches.
  const two = await call("/api/join", { method: "POST", body: { roomCode: code, playerName: "Second Detective" } });
  const ac = new AbortController();
  const stream = await fetch(`${BASE}/events?room=${code}`, {
    headers: { authorization: `Bearer ${two.data.token}`, accept: "text/event-stream" },
    signal: ac.signal,
  });
  ok(stream.status === 200, "the second detective is connected to the room stream");
  let pushed = "";
  const pump = (async () => {
    const dec = new TextDecoder();
    const reader = stream.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pushed += dec.decode(value, { stream: true });
      }
    } catch {
      /* aborted */
    }
  })();
  await sleep(250);
  ok(pushed.includes('"status":"waiting"'), "the waiting state was pushed before the start");

  const started = await call("/api/game/start", { method: "POST", token: one.data.token });
  ok(started.status === 200 && started.data.started === true, `player 1 starts their own game (got ${started.status} ${started.data?.code || ""})`);
  ok(started.data?.room?.status === "live", "the room flips to live so the game master can monitor it");
  ok(started.data?.players?.length === 2, "the start response carries every player in the room");
  ok(
    started.data?.you?.startedAt > 0 && started.data?.you?.endsAt - started.data?.you?.startedAt === 60_000,
    "player 1 receives their own start timestamp and full-length expiry"
  );

  // Give a (wrongly) room-wide broadcast time to arrive, then prove the
  // OTHER detective's stream never received a game-start STATE event.
  for (let i = 0; i < 6; i++) await sleep(250);
  const blocks = pushed.split("\n\n").filter(Boolean);
  const startPushedToOther = blocks.some((b) => b.startsWith("event: state") && b.includes('"status":"live"'));
  ok(
    !startPushedToOther,
    "the OTHER detective is NOT pushed a game start — START is private to the seat that pressed it"
  );

  const watcher = await call("/api/session", { token: two.data.token });
  ok(watcher.data.room.status === "live", "the room itself reads live");
  ok(!watcher.data.you.startedAt, "the watching detective is still WAITING — nobody started their game for them");
  ok(watcher.data.you.id === two.data.you.id, "player identity stays separate from the shared state");

  // The waiting detective then starts their OWN session, when they choose.
  const startTwo = await call("/api/game/start", { method: "POST", token: two.data.token });
  ok(
    startTwo.status === 200 && startTwo.data.you.startedAt > 0,
    "the second detective starts independently — a fresh personal clock"
  );

  const again = await call("/api/game/start", { method: "POST", token: two.data.token });
  ok(
    again.status === 200 &&
      again.data.alreadyStarted === true &&
      again.data.you.startedAt === startTwo.data.you.startedAt,
    "pressing START twice never resets their own clock"
  );
  const firstStill = await call("/api/session", { token: one.data.token });
  ok(firstStill.data.you.endsAt === started.data.you.endsAt, "the FIRST detective's timer is untouched by any of it");
  ac.abort();

  // (c) capacity and starting are independent: 50 is a ceiling, not a gate
  const full = await makeRoom("Ceiling test");
  const seated = await joinMany(full, MAX_PLAYERS_PER_ROOM, "S");
  ok(seated.every((r) => r.status === 200), `all ${MAX_PLAYERS_PER_ROOM} seats fill — capacity is a ceiling, not a start gate`);
  const refused = await call("/api/join", {
    method: "POST",
    body: { roomCode: full, playerName: "Too Late" },
  });
  ok(refused.status === 409 && refused.data.code === "ROOM_FULL", "player 51 is still refused");
}

/* ---------------------------------------------------------------- *
 * 23. PER-PLAYER TIMERS — staggered starts, individual expiry
 *
 *   A presses START  -> only A has a timer (full configured duration)
 *   (time passes)    -> A's clock runs down; B and C have NO timer
 *   B presses START  -> B gets a FRESH full clock; A's is untouched
 *   C presses START  -> C gets a fresh full clock; A keeps counting
 *   A hits 00:00     -> ONLY A is locked; the room and the others play on
 * ---------------------------------------------------------------- */
{
  const DURATION = 5 * 60_000;
  const mk = await call("/api/admin/rooms", {
    method: "POST",
    token: adminToken,
    body: { roomName: "Personal clocks", duration: DURATION },
  });
  const code = mk.data.room.roomCode;
  ok(mk.data.room.duration === DURATION, "the configured duration is the maximum PER PLAYER");
  const assign = await call("/api/admin/room/game", {
    method: "POST",
    token: adminToken,
    body: { code, gameId: secondGame.id },
  });
  ok(assign.status === 200, "the published game is assigned to the timer room");

  const seats = [];
  for (const name of ["Alpha", "Bravo", "Charlie"]) {
    const r = await call("/api/join", { method: "POST", body: { roomCode: code, playerName: name } });
    seats.push(r.data);
  }
  ok(seats.every((s) => s.token), "three detectives take their seats");
  const [tokA2, tokB2, tokC2] = seats.map((s) => s.token);

  const roomId = (await store.findRoomByCode(code)).id;
  const alphaId = (await store.findPlayerByName(roomId, "Alpha")).id;

  /* --- A starts: only A has a timer --- */
  const a0 = await call("/api/game/start", { method: "POST", token: tokA2 });
  ok(a0.status === 200 && a0.data.you.startedAt > 0, "A presses START -> A enters the game");
  ok(a0.data.you.endsAt - a0.data.you.startedAt === DURATION, "A's timer starts at exactly the full duration");
  const b0 = await call("/api/session", { token: tokB2 });
  const c0 = await call("/api/session", { token: tokC2 });
  ok(!b0.data.you.startedAt && b0.data.you.endsAt == null, "B is still waiting — no timer exists for B");
  ok(!c0.data.you.startedAt && c0.data.you.endsAt == null, "C is still waiting — no timer exists for C");
  ok(b0.data.room.status === "live", "the room reads live while B and C remain in the lobby");

  /* --- time passes for A (two minutes of play, server-side) --- */
  await store.adjustPlayerEnds(alphaId, -120_000);
  const aMid = await call("/api/session", { token: tokA2 });
  ok(
    aMid.data.you.remaining > 0 && aMid.data.you.remaining <= DURATION - 120_000 + 2_000,
    "A's clock keeps running down while nobody else has started"
  );

  /* --- B starts later: fresh full clock, A untouched --- */
  await sleep(10);
  const bStart = await call("/api/game/start", { method: "POST", token: tokB2 });
  ok(bStart.status === 200 && bStart.data.you.startedAt > 0, "B presses START -> B enters the game");
  ok(bStart.data.you.endsAt - bStart.data.you.startedAt === DURATION, "B receives a fresh full-duration timer");
  ok(bStart.data.you.remaining > aMid.data.you.remaining, "B has more time left than A");
  const aAfter = await call("/api/session", { token: tokA2 });
  ok(aAfter.data.you.endsAt === aMid.data.you.endsAt, "B's START never resets or touches A's stored expiry");
  ok(aAfter.data.you.remaining < bStart.data.you.remaining, "A keeps counting from where it was");
  const c1 = await call("/api/session", { token: tokC2 });
  ok(!c1.data.you.startedAt, "C is still waiting after two others started");

  /* --- C starts last: its own fresh clock --- */
  const cStart = await call("/api/game/start", { method: "POST", token: tokC2 });
  ok(cStart.status === 200 && cStart.data.you.remaining > 0, "C presses START -> C enters the game");
  ok(
    cStart.data.you.endsAt >= bStart.data.you.endsAt && bStart.data.you.endsAt > aAfter.data.you.endsAt,
    "three independent clocks: C ends last, B next, A earliest"
  );

  /* --- A runs out: ONLY A is locked --- */
  await store.setPlayerEnds(alphaId, Date.now() - 1);
  await sleep(1300); // the next server tick picks it up

  const aEnd = await call("/api/session", { token: tokA2 });
  ok(aEnd.data.you.timedOut === true, "A's clock hitting 00:00 marks A as time-up");
  ok(aEnd.data.you.status === "timeout", "A's status flips to Time up");
  ok(aEnd.data.room.status === "live", "the ROOM does not end with A — it keeps running");

  const bLive = await call("/api/session", { token: tokB2 });
  ok(!bLive.data.you.timedOut && bLive.data.you.remaining > 0, "B still has time and continues normally");
  const cLive = await call("/api/session", { token: tokC2 });
  ok(!cLive.data.you.timedOut && cLive.data.you.remaining > 0, "C still has time and continues normally");

  const aLocked = await call("/api/answer", {
    method: "POST",
    token: tokA2,
    body: { caseId: 1, answer: "loose brick" },
  });
  ok(aLocked.status === 400 && aLocked.data.code === "TIME_UP", "A's answers are locked at 00:00");

  const bPlays = await call("/api/answer", {
    method: "POST",
    token: tokB2,
    body: { caseId: 1, answer: "loose brick" },
  });
  ok(bPlays.status === 200 && bPlays.data.correct === true, "B keeps answering normally after A's clock ran out");

  const bRefresh = await call("/api/session", { token: tokB2 });
  ok(
    bRefresh.data.you.endsAt === bLive.data.you.endsAt,
    "a refresh continues the same stored clock — never a fresh one"
  );
}

/* ---------------------------------------------------------------- *
 * 24. PERSISTENCE — close the database, reopen it: nothing is lost
 *
 * Everything the sections above created is read back after a full shutdown
 * (flush + checkpoint + backup) — exactly what a laptop closed tonight or a
 * server redeployed would find tomorrow. Rooms, durations, games, cases,
 * answer rows, scores and the admin account must all be identical, and
 * reopening must never re-run content cleanup.
 * ---------------------------------------------------------------- */
{
  // Freeze the ticker first: nothing may change between snapshot and close.
  if (globalThis.__d404Ticker) {
    clearInterval(globalThis.__d404Ticker);
    globalThis.__d404Ticker = null;
  }
  server.close();

  const adminId = (await store.findAdminByName("admin")).id;
  const snapshot = async (s) => {
    const rooms = [];
    for (const r of await s.listRoomsForAdmin(adminId)) {
      rooms.push({
        code: r.room_code,
        name: r.room_name,
        duration: r.duration,
        status: r.status,
        gameId: r.game_id,
        ...(await s.roomRowCounts(r.id)), // players / answers / scores / sessions
      });
    }
    const games = [];
    for (const g of await s.listGames(adminId)) {
      games.push({ name: g.name, status: g.status, cases: (await s.listCases(g.id)).length });
    }
    const admin = await s.findAdminByName("admin");
    return { rooms, games, admin: admin?.username ?? null };
  };

  const before = await snapshot(store);
  ok(before.rooms.length > 0 && before.games.length > 0, "there are real rooms and games to preserve");
  ok(
    before.rooms.some((r) => r.answers > 0 || r.player_progress > 0),
    "there are recorded answers and scores to preserve"
  );

  await store.close(); // flush + checkpoint + backup, exactly like a shutdown

  if (store.engine === "sqlite") {
    const walPath = path.join(tmp, "deductive404.db-wal");
    const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    ok(walSize === 0, "shutdown folded every commit into the main file (the .db-wal sidecar is empty)");
    ok(fs.statSync(path.join(tmp, "deductive404.db")).size > 0, "the main database file holds the data");
    ok(fs.existsSync(path.join(tmp, "backups")), "shutdown left a point-in-time backup copy behind");
  }

  // A fresh module instance over the same file: what tomorrow's process sees.
  const reopened = await import("./db.js?reopen=1");
  const after = await snapshot(reopened);
  ok(
    JSON.stringify(after.rooms) === JSON.stringify(before.rooms),
    "every room, duration, status and row count is identical after reopen"
  );
  ok(
    JSON.stringify(after.games) === JSON.stringify(before.games),
    "every game, its status and its case count are identical after reopen"
  );
  ok(after.admin === "admin", "the admin account still exists after reopen");
  ok(reopened.legacyCleared === false, "reopening never re-runs content cleanup (meta flag respected)");
  await reopened.close();
}

/* ---------------------------------------------------------------- *
 * 25. DAY 1 → DAY 2 — a server that is killed keeps everything
 *
 * A child process creates ROOM001 with a published case and a 15 minute
 * duration, then shuts down the way Ctrl+C does (flush + checkpoint + exit).
 * A SECOND child process opens the same file "the next morning" and must
 * find the room, the game, the case content and the admin account — with the
 * room still "waiting", because saving a room never starts a game.
 * (Runs on SQLite and MongoDB; PostgreSQL durability is the database's job.)
 * ---------------------------------------------------------------- */
if (store.engine !== "postgres") {
  const childDir = fs.mkdtempSync(path.join(os.tmpdir(), "d404-signal-"));
  const dbUrl = new URL("./db.js", import.meta.url).href;
  const env = { ...process.env, D404_DATA_DIR: childDir };
  delete env.DATABASE_URL; // local engine probe — never the pg connection
  delete env.D404_SECRET; // each child gets its own throw-away key file

  const runChild = (script) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => resolve({ code, out, err }));
    });
  const lastJson = (out) => {
    const lines = out.split("\n").map((s) => s.trim()).filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  };

  const created = await runChild(`
    const store = await import(${JSON.stringify(dbUrl)});
    await store.seedAdmin();
    const admin = await store.findAdminByName("admin");
    const room = await store.createRoom({ roomName: "ROOM001", duration: 15 * 60 * 1000, adminId: admin.id });
    const game = await store.createGame({ adminId: admin.id, name: "Overnight Case", description: "built on day 1" });
    await store.insertCase({
      game_id: game.id, case_number: 1, case_title: "The Locked Study", image_url: "",
      question: "Where was the spare key hidden?", question_type: "text", options: "[]",
      correct_answer: "loose brick", clue: "Check the fireplace.",
      points_first: 100, points_second: 50, sort_order: 0,
    });
    await store.updateGame(game.id, { status: "published" });
    await store.updateRoom(room.id, { game_id: game.id, current_case: 1 });
    console.log(JSON.stringify({ code: room.room_code, name: room.room_name, duration: room.duration }));
    if (store.engine === "mongodb") {
      // Clean shutdown: drain + close the pooled client, exit like Ctrl+C.
      await store.close();
      process.exit(130);
    }
    process.emit("SIGINT"); // exactly what a real Ctrl+C dispatches to listeners
    setTimeout(() => process.exit(9), 3000); // the flush handler must exit by itself
  `);
  const day1 = lastJson(created.out);
  ok(created.code === 130, `day 1: the server flushes and exits on Ctrl+C (exit code ${created.code})`);
  if (store.engine === "sqlite") {
    const walPath = path.join(childDir, "deductive404.db-wal");
    const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    ok(walSize === 0, "day 1: shutdown checkpointed every commit into the main file (empty .db-wal)");
  }
  ok(day1.duration === 15 * 60 * 1000, "day 1: ROOM001 was saved with a 15 minute duration");

  const morning = await runChild(`
    const store = await import(${JSON.stringify(dbUrl)});
    const room = await store.findRoomByCode(${JSON.stringify(day1.code)});
    const game = room ? await store.findGame(room.game_id) : null;
    const cases = game ? await store.listCases(game.id) : [];
    const admin = await store.findAdminByName("admin");
    console.log(JSON.stringify({
      found: !!room, name: room?.room_name, duration: room?.duration, status: room?.status,
      game: game?.name, published: game?.status,
      caseTitle: cases[0]?.case_title, question: cases[0]?.question, answer: cases[0]?.correct_answer,
      admin: !!admin,
    }));
    if (store.engine === "mongodb") {
      // tidy the shared throw-away database, then release the pooled client
      if (room) await store.deleteRoom(room.id);
      if (game) await store.deleteGame(game.id);
      await store.close();
    }
  `);
  ok(morning.code === 0, `day 2: a fresh process opens the same file (exit code ${morning.code})`);
  const day2 = lastJson(morning.out);
  ok(day2.found && day2.name === "ROOM001", "day 2: the room created last night is still there");
  ok(day2.duration === 15 * 60 * 1000, "day 2: its 15 minute duration is unchanged");
  ok(day2.status === "waiting", "day 2: creating/saving a room never auto-starts the game");
  ok(
    day2.caseTitle === "The Locked Study" &&
      day2.question === "Where was the spare key hidden?" &&
      day2.answer === "loose brick",
    "day 2: the case question, answer and clue are intact"
  );
  ok(day2.game === "Overnight Case" && day2.published === "published", "day 2: the published game survived intact");
  ok(day2.admin === true, "day 2: the admin account survived too");

  fs.rmSync(childDir, { recursive: true, force: true });
}

try {
  server.close();
  await store.close(); // idempotent — section 24 may already have closed it
} catch {
  /* ignore */
}
try {
  if (memoryServer) await memoryServer.stop();
} catch {
  /* throw-away server is best effort */
}
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* temp cleanup is best effort */
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  console.log("Failed:\n - " + failures.join("\n - "));
  process.exit(1);
}
process.exit(0);
