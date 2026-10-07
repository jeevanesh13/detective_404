/**
 * DETECTIVE 404 — production server.
 *
 * Two sites, two ports, one process:
 *   http://localhost:5175/   detective site   (dist/)
 *   http://localhost:5176/   game master site (dist-admin/)
 *
 * Both listeners share the same API, SSE hub and database — the local SQLite
 * file by default, PostgreSQL when DATABASE_URL is set (see RENDER.md) — so
 * every room, player and countdown stays in sync across the two origins.
 *
 *   npm install && npm run build && npm start
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { PORT, ADMIN_PORT, HOST, ADMIN_USER, DIST_DIR, ADMIN_DIST_DIR } from "./config.js";
import { seedAdmin, engineLabel } from "./db.js";
import { handleRequest } from "./api.js";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const SITES = [
  { key: "player", label: "Detective entrance", dir: DIST_DIR, entry: "index.html", port: PORT },
  { key: "admin", label: "Game master console", dir: ADMIN_DIST_DIR, entry: "admin.html", port: ADMIN_PORT },
];
const entryOf = (key) => SITES.find((s) => s.key === key).entry;

function notFound(res, text) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

/** Serve one site's bundle, refusing the other site's HTML entry. */
function serveStatic(req, res, site) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch {
    pathname = "/";
  }

  // Each site owns its own entry page; the other one does not exist here.
  const otherEntry = `/${entryOf(site.key === "player" ? "admin" : "player")}`;
  if (pathname === otherEntry || (pathname === "/index.html" && site.entry !== "index.html")) {
    notFound(res, "This page lives on the other site.");
    return;
  }
  if (pathname === "/") pathname = `/${site.entry}`;

  let filePath = path.join(site.dir, pathname);
  if (!filePath.startsWith(site.dir)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const entry = path.join(site.dir, site.entry);
    if (!fs.existsSync(entry)) {
      notFound(res, `Build the ${site.label.toLowerCase()} first:  npm run build`);
      return;
    }
    filePath = entry;
  }
  const ext = path.extname(filePath).toLowerCase();
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
  });
  res.end(body);
}

const adminState = await seedAdmin();

/**
 * Single-port mode — for hosts that publish exactly one port (Render, Railway,
 * Fly…): the player entrance stays at `/` and the game master console is served
 * at `/admin`, both from the same listener. Opt in with D404_SINGLE_PORT=1.
 * Without it every site keeps its own port, exactly as before.
 */
const SINGLE_PORT = String(process.env.D404_SINGLE_PORT || "") === "1";
const siteOf = (key) => SITES.find((s) => s.key === key);

function pathnameOf(req) {
  try {
    return decodeURIComponent(new URL(req.url || "/", "http://x").pathname);
  } catch {
    return "/";
  }
}

/** With both bundles behind one port, decide which one owns this path. */
function siteForPath(pathname) {
  if (pathname === "/admin" || pathname === "/admin/" || pathname === "/admin.html") return siteOf("admin");
  // Both builds emit into /assets, but the files are prefixed index-* vs admin-*.
  if (pathname.startsWith("/assets/")) {
    const inPlayer = fs.existsSync(path.join(DIST_DIR, pathname));
    if (!inPlayer && fs.existsSync(path.join(ADMIN_DIST_DIR, pathname))) return siteOf("admin");
  }
  return siteOf("player");
}

const makeHandler = (defaultSite) => async (req, res) => {
  try {
    const handled = await handleRequest(req, res);
    if (!handled && !res.headersSent && !res.writableEnded) {
      const site = SINGLE_PORT ? siteForPath(pathnameOf(req)) : defaultSite;
      serveStatic(req, res, site);
    }
  } catch (err) {
    console.error("[deductive-404]", err);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    if (!res.writableEnded) res.end("Server error");
  }
};

const servers = (SINGLE_PORT ? SITES.slice(0, 1) : SITES).map((site) => {
  const server = http.createServer(makeHandler(site));
  server.on("error", (err) => {
    console.error(`[deductive-404] ${site.label} could not bind port ${site.port} — ${err.message}`);
    process.exit(1);
  });
  return { site, server };
});

let listening = 0;
for (const { site, server } of servers) {
  server.listen(site.port, HOST, () => {
    if (++listening < servers.length) return;
    console.log("");
    console.log("  ┌───────────────────────────────────────────────────┐");
    console.log("  │  DETECTIVE 404 — TWO SITES, ONE BACKEND           │");
    console.log("  └───────────────────────────────────────────────────┘");
    console.log(`   Detective entrance : http://localhost:${PORT}/`);
    console.log(
      SINGLE_PORT
        ? `   Game master console: http://localhost:${PORT}/admin   (single-port mode)`
        : `   Game master console: http://localhost:${ADMIN_PORT}/`
    );
    console.log(`   Database           : ${engineLabel}`);
    console.log(`   Admin account      : ${ADMIN_USER} (${adminState}) · password from D404_ADMIN_PASSWORD`);
    console.log("");
  });
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    for (const { server } of servers) server.close();
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
