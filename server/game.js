/**
 * Game rules that live on the server.
 *
 * The hard-coded case file (src/cases.js) is gone: every question, clue,
 * answer and image now comes from the database, written by the game master in
 * the Game Builder. What stays in code is the machinery that must not be
 * editable from a browser — the clock, the ranking and the answer rules.
 */

/* Flexible answer rules live in one place so the browser and the
   authoritative API can never disagree — see src/game/logic.js:
     · 1 to 3 words (a full sentence is never required)
     · case, extra spaces and punctuation ignored
     · small spelling variations and word order tolerated
     · what matters is the keyword(s) of the stored answer
     · options picked in a multiple choice / true-false question must match. */
export {
  norm,
  words,
  tooLong,
  matchesAnswer,
  parseBool,
  MAX_ANSWER_WORDS,
  MAX_ATTEMPTS,
  POINTS_FIRST,
  POINTS_SECOND,
  QUESTION_TYPES,
} from "../src/game/logic.js";

import { MAX_ATTEMPTS } from "../src/game/logic.js";

/**
 * Score for one attempt on one question.
 *   correct on the 1st try -> full points
 *   correct on the 2nd try -> half points
 *   both attempts missed   -> nothing (the answer is revealed)
 */
export function pointsFor(caseRow, attemptNumber, correct) {
  if (!correct) return 0;
  const full = Number.isFinite(caseRow?.points_first) ? caseRow.points_first : 100;
  const half = Number.isFinite(caseRow?.points_second) ? caseRow.points_second : 50;
  return attemptNumber <= 1 ? full : half;
}

/** Has the player used both of their attempts on this question? */
export const outOfAttempts = (attempts) => attempts >= MAX_ATTEMPTS;

/**
 * Remaining milliseconds for a room, derived purely from the timestamps the
 * server stored when the game master pressed START. Nothing is read from
 * localStorage, so every player and the admin see the same countdown and it
 * survives refreshes, new tabs and new devices.
 */
export function remainingMs(room, now = Date.now()) {
  if (!room) return 0;
  if (room.status === "ended") return 0;
  if (room.status === "waiting" || !room.started_at) return room.duration;
  const anchor = room.paused_since || now;
  const elapsed = Math.max(0, anchor - room.started_at - (room.paused_total || 0));
  return Math.max(0, room.duration - elapsed);
}

export function elapsedMs(room, now = Date.now()) {
  if (!room || !room.started_at) return 0;
  return Math.max(0, Math.min(room.duration, room.duration - remainingMs(room, now)));
}

/** Ranking: score, then questions solved, then who was fastest. */
export function rank(players) {
  return [...players].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.completed_cases !== a.completed_cases) return b.completed_cases - a.completed_cases;
    const ta = a.time_taken ?? Number.MAX_SAFE_INTEGER;
    const tb = b.time_taken ?? Number.MAX_SAFE_INTEGER;
    if (ta !== tb) return ta - tb;
    return a.joined_at - b.joined_at;
  });
}
