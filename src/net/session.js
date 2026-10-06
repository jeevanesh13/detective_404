/**
 * Session memory.
 *
 * Only the signed token + room pointer live here so a refresh restores the
 * exact same detective / console. Scores, timer and case progress are NEVER
 * stored in the browser — they are read back from the database on restore.
 *
 * Player and game-master sessions are kept apart, so the same machine can be
 * signed in as a detective and as the game master at the same time.
 */
const PLAYER_KEY = "d404.player.v2";
const ADMIN_KEY = "d404.admin.v2";
const ROOM_KEY = "d404.activeRoom.v2";

const read = (key) => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.token !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
};

const write = (key, value) => {
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch {
    /* private mode */
  }
};

export const loadPlayer = () => read(PLAYER_KEY);
export const savePlayer = (session) => write(PLAYER_KEY, session);
export const clearPlayer = () => write(PLAYER_KEY, null);

export const loadAdmin = () => read(ADMIN_KEY);
export const saveAdmin = (session) => write(ADMIN_KEY, session);
export const clearAdmin = () => write(ADMIN_KEY, null);

export function loadActiveRoom() {
  try {
    return localStorage.getItem(ROOM_KEY) || null;
  } catch {
    return null;
  }
}

export function saveActiveRoom(code) {
  try {
    if (code) localStorage.setItem(ROOM_KEY, code);
    else localStorage.removeItem(ROOM_KEY);
  } catch {
    /* noop */
  }
}
