/**
 * `npm run dev` — starts BOTH sites from one process:
 *
 *   Detective site   http://localhost:5173/
 *   Game master site http://localhost:5174/
 *
 * They are separate origins with separate HTML entries and separate bundles,
 * but they share one API + SSE hub + SQLite database, because this file loads
 * `server/api.js` exactly once and hands the same plugin to both Vite servers
 * (`configFile: false` so Vite cannot pull in a second copy).
 */
import net from "node:net";
import { createServer } from "vite";
import { siteConfig, SITES } from "../vite.config.js";

/**
 * First free port at or after `start`, held open until the caller releases it
 * — so the two sites can never be handed the same port.
 */
function reservePort(start, limit = 60) {
  return new Promise((resolve, reject) => {
    const attempt = (p, left) => {
      if (left <= 0) return reject(new Error(`No free port near ${start}. Set PLAYER_DEV_PORT / ADMIN_DEV_PORT.`));
      const probe = net.createServer();
      probe.once("error", () => attempt(p + 1, left - 1));
      probe.once("listening", () =>
        resolve({ port: p, release: () => new Promise((done) => probe.close(done)) })
      );
      // No host: binds the same dual-stack wildcard Vite uses, so a listener
      // on `::` (invisible to an IPv4-only probe) is detected too.
      probe.listen(p);
    };
    attempt(start, limit);
  });
}

const playerSlot = await reservePort(SITES.player.devPort);
const adminSlot = await reservePort(Math.max(SITES.admin.devPort, playerSlot.port + 1));
await playerSlot.release();
await adminSlot.release();

const playerPort = playerSlot.port;
const adminPort = adminSlot.port;

const urls = {
  player: process.env.D404_PLAYER_SITE || `http://localhost:${playerPort}`,
  admin: process.env.D404_ADMIN_SITE || `http://localhost:${adminPort}`,
};

const make = (site, port) =>
  createServer({
    ...siteConfig(site, { command: "serve", urls }),
    configFile: false,
    server: { host: true, port, strictPort: true },
  });

const servers = await Promise.all([make("player", playerPort), make("admin", adminPort)]);
await Promise.all(servers.map((s) => s.listen()));

console.log("");
console.log("  ┌───────────────────────────────────────────────────┐");
console.log("  │  DETECTIVE 404 — TWO SITES, ONE BACKEND           │");
console.log("  └───────────────────────────────────────────────────┘");
console.log(`   Detective site   : ${urls.player}/`);
console.log(`   Game master site : ${urls.admin}/`);
console.log("   Shared           : API · realtime stream · database");
console.log("   Ctrl+C stops both");
console.log("");

const shutdown = async () => {
  await Promise.all(servers.map((s) => s.close()));
  process.exit(0);
};
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, shutdown);
