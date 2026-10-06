/**
 * Real-time hub.
 *
 * Server -> browser push uses Server Sent Events: every connected detective
 * and the game-master console subscribe to their room and receive state
 * updates instantly (joins, answers, case changes, presence, timer, game end).
 */
import crypto from "node:crypto";
import { HEARTBEAT_MS } from "./config.js";

/** roomId -> Map(connectionId -> client) */
const byRoom = new Map();
/** connectionId -> client  (game-master consoles) */
const admins = new Map();

export function emit(client, event, data) {
  try {
    if (!client.res.writableEnded) client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* socket already gone */
  }
}

export const hub = {
  emit,

  add(client) {
    client.id = crypto.randomUUID();
    if (!client.res.writableEnded) {
      client.res.write("retry: 3000\n\n");
      emit(client, "hello", { id: client.id, serverTime: Date.now() });
    }
    if (client.roomId) {
      if (!byRoom.has(client.roomId)) byRoom.set(client.roomId, new Map());
      byRoom.get(client.roomId).set(client.id, client);
    }
    if (client.role === "admin") admins.set(client.id, client);

    client.timer = setInterval(() => {
      try {
        if (client.res.writableEnded) return hub.remove(client.id);
        client.res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        hub.remove(client.id);
      }
    }, HEARTBEAT_MS);
    client.timer.unref?.();
    return client;
  },

  remove(id) {
    let found = admins.get(id) || null;
    if (found) admins.delete(id);
    for (const [roomId, map] of byRoom) {
      const client = map.get(id);
      if (client) {
        found = client;
        map.delete(id);
        if (map.size === 0) byRoom.delete(roomId);
        break;
      }
    }
    if (!found) return null;
    clearInterval(found.timer);
    try {
      found.res.end();
    } catch {
      /* noop */
    }
    return found;
  },

  roomClients(roomId) {
    return [...(byRoom.get(roomId)?.values() || [])];
  },

  /** Player ids in this room with an open socket right now. */
  onlineIds(roomId) {
    const set = new Set();
    for (const c of byRoom.get(roomId)?.values() || []) if (c.playerId) set.add(c.playerId);
    return set;
  },

  isOnline(roomId, playerId) {
    for (const c of byRoom.get(roomId)?.values() || []) if (c.playerId === playerId) return true;
    return false;
  },

  broadcastRoom(roomId, event, data) {
    for (const c of byRoom.get(roomId)?.values() || []) emit(c, event, data);
  },

  /** Per-connection payload builder so players never receive private data. */
  broadcastRoomScoped(roomId, event, build) {
    for (const c of byRoom.get(roomId)?.values() || []) emit(c, event, build(c));
  },

  eachAdmin(fn) {
    for (const c of [...admins.values()]) fn(c);
  },

  stats() {
    let connections = 0;
    for (const map of byRoom.values()) connections += map.size;
    return { connections, rooms: byRoom.size, admins: admins.size };
  },
};
