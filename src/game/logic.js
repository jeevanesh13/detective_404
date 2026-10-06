/**
 * DETECTIVE 404 answer rules — one implementation, shared by the browser and
 * the authoritative API (server/game.js re-exports it), so the two can never
 * disagree.
 *
 * Every question lives in the database (it is written by the game master in
 * the Game Builder), so the rules below have to work for any wording:
 *
 *  · case, extra spaces and basic punctuation are ignored
 *  · small spelling variations and a different word order are tolerated
 *  · short answers win — 1 to 3 words, a full sentence is never needed
 *  · what has to match is the keyword(s) of the stored answer
 *  · multiple choice and true/false must match an option exactly, so a wrong
 *    option can never be half-accepted
 */

/** A player's deduction is never longer than this. */
export const MAX_ANSWER_WORDS = 3;

/** Every question gives the player exactly two attempts. */
export const MAX_ATTEMPTS = 2;

/** Scoring table: 1st attempt / 2nd attempt / no points. */
export const POINTS_FIRST = 100;
export const POINTS_SECOND = 50;

/** Question types understood today. The builder renders from this list, so a
 *  new type only has to be added here and in the two editors. */
export const QUESTION_TYPES = [
  { id: "text", label: "Text Answer" },
  { id: "mcq", label: "Multiple Choice" },
  { id: "boolean", label: "True / False" },
];

/** Lowercase, drop punctuation, collapse whitespace, trim. */
export const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9:' ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** The typed answer split into words (empty string -> no words). */
export const words = (s) => {
  const n = norm(s);
  return n ? n.split(" ") : [];
};

/** True when a free-text answer is longer than the allowed maximum. */
export const tooLong = (s) => words(s).length > MAX_ANSWER_WORDS;

/** Levenshtein distance, giving up as soon as it passes `limit`. */
function editDistance(a, b, limit) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = [];
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowBest = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowBest) rowBest = cur[j];
    }
    if (rowBest > limit) return limit + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Do two words of the same answer agree closely enough?
 * "stopp" in "stopped", "wndow" in "window", "arun" in "Arun".
 */
function wordMatch(expectedToken, givenToken) {
  if (expectedToken === givenToken) return true;
  const [lo, hi] = expectedToken.length <= givenToken.length ? [expectedToken, givenToken] : [givenToken, expectedToken];

  // stem / prefix, so a plural or a tense still counts
  if (lo.length >= 3 && hi.startsWith(lo)) return true;
  // the keyword sitting inside a longer word
  if (lo.length >= 4 && hi.includes(lo)) return true;
  // a small spelling variation
  if (lo.length >= 4) {
    const tolerance = hi.length >= 8 ? 2 : 1;
    if (Math.abs(expectedToken.length - givenToken.length) <= tolerance && editDistance(expectedToken, givenToken, tolerance) <= tolerance)
      return true;
  }
  return false;
}

/** true / false / yes / no / 1 / 0 -> boolean, or null when unrecognised. */
export function parseBool(value) {
  const v = norm(value);
  if (["true", "t", "yes", "y", "1"].includes(v)) return true;
  if (["false", "f", "no", "n", "0"].includes(v)) return false;
  return null;
}

/**
 * Is the typed deduction good enough for this question?
 * `type` decides how strict we are: free text is forgiving, an option the
 * game master picked has to be the one the player picks.
 */
export function matchesAnswer(expected, given, type = "text") {
  const e = norm(expected);
  const g = norm(given);
  if (!e || !g) return false;

  if (type === "mcq") return e === g;

  if (type === "boolean") {
    const want = parseBool(expected);
    const got = parseBool(given);
    return want !== null && want === got;
  }

  if (e === g) return true;

  const expectedTokens = e.split(" ").filter(Boolean);
  const givenTokens = g.split(" ").filter(Boolean);
  if (!expectedTokens.length || !givenTokens.length) return false;

  // every keyword shows up, in any order
  if (expectedTokens.every((w) => givenTokens.some((t) => wordMatch(w, t)))) return true;
  // the player typed a shorter version that is contained in the expected answer
  if (givenTokens.every((w) => expectedTokens.some((t) => wordMatch(w, t)))) return true;

  return false;
}
