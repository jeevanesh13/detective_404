/**
 * End-to-end smoke test for the DETECTIVE 404 multiplayer backend.
 * Run with:  npm test
 * Uses an isolated throw-away database, so it never touches real rooms.
 *
 * The suite walks the whole new product loop:
 *   Game Builder -> publish -> assign to a room -> players join ->
 *   2 attempts per question (100 / 50 / 0) -> locked questions ->
 *   pause/resume -> final ranking -> reset -> second run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "d404-test-"));
process.env.D404_DATA_DIR = tmp;
process.env.D404_ADMIN_PASSWORD = "smoke-secret";

const { seedAdmin, db } = await import("./db.js");
const { handleRequest } = await import("./api.js");

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

seedAdmin();

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

console.log("\nDETECTIVE 404 — backend smoke test\n");

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

  const noGame = await call("/api/admin/room/start", { method: "POST", token: adminToken, body: { code: room.roomCode } });
  ok(noGame.status === 400 && noGame.data.code === "NO_GAME", "a room without a game cannot start");

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
  ok(badCode.status === 400 && badCode.data.code === "ROOM_NOT_FOUND", "malformed room code -> Invalid Room Code");

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
 * 11. start the game
 * ---------------------------------------------------------------- */
{
  const { status, data } = await call("/api/admin/room/start", {
    method: "POST",
    token: adminToken,
    body: { code: room.roomCode },
  });
  ok(status === 200 && data.room.status === "live" && data.room.startedAt > 0, "game master starts the game");
  ok(data.room.remaining > 0 && data.room.remaining <= 45 * 60 * 1000, "countdown derives from the stored start time");

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

  await call("/api/admin/room/start", { method: "POST", token: adminToken, body: { code: room.roomCode } });
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

  const doomedId = db.prepare("SELECT id FROM rooms WHERE room_code = ?").get(doomed.roomCode)?.id;
  const keeperId = db.prepare("SELECT id FROM rooms WHERE room_code = ?").get(keeper.roomCode)?.id;

  const joined = await call("/api/join", {
    method: "POST",
    body: { roomCode: doomed.roomCode, playerName: "Ada" },
  });
  ok(joined.status === 200, "a detective can join the room that is about to be deleted");

  const rows = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE room_id = ?`).get(doomedId).n;
  ok(rows("players") === 1, "the room holds exactly that detective before the delete");

  const anon = await call(`/api/admin/rooms?code=${doomed.roomCode}`, { method: "DELETE" });
  ok(anon.status === 401, "an anonymous caller cannot delete a room");

  const del = await call(`/api/admin/rooms?code=${doomed.roomCode}`, { method: "DELETE", token: adminToken });
  ok(del.status === 200 && Array.isArray(del.data.rooms), "the room is deleted once the admin confirms");

  const after = await call("/api/admin/rooms", { token: adminToken });
  ok(!after.data.rooms.some((r) => r.roomCode === doomed.roomCode), "the deleted room is gone from the room list");
  ok(after.data.rooms.some((r) => r.roomCode === keeper.roomCode), "the other room is still in the list");
  ok(after.data.rooms.some((r) => r.roomCode === room.roomCode), "the original test room still exists");

  ok(
    db.prepare("SELECT COUNT(*) AS n FROM rooms WHERE id = ?").get(doomedId).n === 0,
    "the room row itself is removed"
  );
  ok(
    rows("players") === 0 &&
      rows("answers") === 0 &&
      rows("player_progress") === 0 &&
      rows("game_sessions") === 0,
    "its players, answers, scores and session rows are removed with it"
  );
  ok(db.prepare("SELECT COUNT(*) AS n FROM rooms WHERE id = ?").get(keeperId).n === 1, "the other room's row is intact");

  const again = await call(`/api/admin/rooms?code=${doomed.roomCode}`, { method: "DELETE", token: adminToken });
  ok(again.status === 404, "deleting the same room twice reports it no longer exists");
}

server.close();
try {
  db.close();
} catch {
  /* ignore */
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
