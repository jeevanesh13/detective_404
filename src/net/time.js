/**
 * The countdown is always derived from the server's stored start timestamp,
 * never from localStorage, so every detective and the game master share one
 * identical clock — and a page refresh (or a new device) resumes correctly.
 */
export function remainingMs(room, serverNow) {
  if (!room) return 0;
  if (room.status === "ended") return 0;
  if (room.status === "waiting" || !room.startedAt) return room.duration;
  const anchor = room.pausedSince || serverNow;
  const elapsed = Math.max(0, anchor - room.startedAt - (room.pausedTotal || 0));
  return Math.max(0, room.duration - elapsed);
}

export function elapsedMs(room, serverNow) {
  if (!room || !room.startedAt) return 0;
  return Math.max(0, Math.min(room.duration, room.duration - remainingMs(room, serverNow)));
}

/** 45:00 — 00:00 */
export function fmtClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** 32:14 style elapsed */
export function fmtElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function fmtDuration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
