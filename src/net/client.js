/**
 * Thin client for the DETECTIVE 404 investigation server.
 * All calls are same-origin; the session token travels in an Authorization
 * header (never in the URL) and only unlocks the caller's own records.
 */

const API_BASE = import.meta.env.VITE_API_BASE || "";

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function call(path, { method = "GET", body, token } = {}) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new ApiError(
      "NETWORK",
      "Cannot reach the investigation server. Start it with  npm run dev  and reload.",
      0
    );
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  if (!res.ok) throw new ApiError(data?.code || "ERROR", data?.message || "Request failed.", res.status);
  return data;
}

/* ------------------------------------------------------------------ *
 * Real-time stream (Server Sent Events over fetch, so the token can
 * stay in a header instead of a query string).
 * ------------------------------------------------------------------ */
function parseChunk(chunk) {
  let event = "message";
  let data = "";
  for (const line of chunk.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return null;
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}

export function openStream({ roomCode, token, onEvent, onStatus }) {
  let closed = false;
  let attempt = 0;
  let controller = null;

  const connect = async () => {
    if (closed) return;
    controller = new AbortController();
    try {
      const query = roomCode ? `?room=${encodeURIComponent(roomCode)}` : "";
      const res = await fetch(API_BASE + "/events" + query, {
        headers: { accept: "text/event-stream", authorization: `Bearer ${token}` },
        signal: controller.signal,
        cache: "no-store",
      });
      if (!res.ok || !res.body) throw new Error("stream unavailable");
      attempt = 0;
      onStatus?.("live");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const parsed = parseChunk(chunk);
          if (parsed) onEvent?.(parsed);
        }
      }
      throw new Error("stream ended");
    } catch (err) {
      if (closed) return;
      onStatus?.("offline");
      attempt = Math.min(8, attempt + 1);
      setTimeout(connect, 800 * attempt + 400);
    }
  };

  connect();

  return () => {
    closed = true;
    try {
      controller?.abort();
    } catch {
      /* noop */
    }
  };
}

/* ------------------------------------------------------------------ *
 * REST surface
 * ------------------------------------------------------------------ */
export const api = {
  health: () => call("/api/health"),

  join: (roomCode, playerName) =>
    call("/api/join", { method: "POST", body: { roomCode, playerName } }),

  session: (token) => call("/api/session", { token }),
  heartbeat: (token) => call("/api/heartbeat", { method: "POST", token }),

  answer: (token, caseId, answer) =>
    call("/api/answer", { method: "POST", token, body: { caseId, answer } }),
  advance: (token) => call("/api/next", { method: "POST", token }),
  leaderboard: (token) => call("/api/leaderboard", { token }),

  adminLogin: (username, password) =>
    call("/api/admin/login", { method: "POST", body: { username, password } }),
  adminRooms: (token) => call("/api/admin/rooms", { token }),
  adminCreateRoom: (token, roomName, duration) =>
    call("/api/admin/rooms", { method: "POST", token, body: { roomName, duration } }),
  adminRoom: (token, code) => call(`/api/admin/room?code=${encodeURIComponent(code)}`, { token }),
  adminAction: (action, token, body) =>
    call(`/api/admin/room/${action}`, { method: "POST", token, body }),
  adminDeleteRoom: (token, code) =>
    call(`/api/admin/rooms?code=${encodeURIComponent(code)}`, { method: "DELETE", token }),

  /* ---- Game Builder ---- */
  games: (token) => call("/api/admin/games", { token }),
  game: (token, id) => call(`/api/admin/game?id=${encodeURIComponent(id)}`, { token }),
  createGame: (token, payload) =>
    call("/api/admin/games", { method: "POST", token, body: payload }),
  saveGame: (token, payload) => call("/api/admin/game/save", { method: "POST", token, body: payload }),
  publishGame: (token, id, status) =>
    call("/api/admin/game/publish", { method: "POST", token, body: { id, status } }),
  deleteGame: (token, id) => call("/api/admin/game/delete", { method: "POST", token, body: { id } }),
  saveCase: (token, payload) => call("/api/admin/game/case", { method: "POST", token, body: payload }),
  deleteCase: (token, gameId, caseId) =>
    call("/api/admin/game/case/delete", { method: "POST", token, body: { gameId, caseId } }),
  moveCase: (token, gameId, caseId, direction) =>
    call("/api/admin/game/case/move", { method: "POST", token, body: { gameId, caseId, direction } }),
  uploadImage: (token, dataUrl) =>
    call("/api/admin/upload", { method: "POST", token, body: { dataUrl } }),
};
