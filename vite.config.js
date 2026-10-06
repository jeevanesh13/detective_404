import path from "node:path";
import react from "@vitejs/plugin-react";
import { deductiveBackend } from "./server/vite-plugin.js";
import { ROOT, PORT, ADMIN_PORT, PLAYER_DEV_PORT, ADMIN_DEV_PORT } from "./server/config.js";

/**
 * DETECTIVE 404 runs as two separate sites that share one backend:
 *
 *   player site  index.html  ->  dist/         dev 5173   prod PORT
 *   admin site   admin.html  ->  dist-admin/   dev 5174   prod ADMIN_PORT
 *
 * `siteConfig()` is the single source of truth for both. Each site gets its
 * own HTML entry, its own bundle and its own port, so the game-master console
 * is never shipped inside the player download.
 */
export const SITES = {
  player: { key: "player", entry: "index.html", outDir: "dist", devPort: PLAYER_DEV_PORT },
  admin: { key: "admin", entry: "admin.html", outDir: "dist-admin", devPort: ADMIN_DEV_PORT },
};

const prodPort = { player: PORT, admin: ADMIN_PORT };
const defaultUrl = { player: PORT, admin: ADMIN_PORT };

/** Where the *other* site lives, so each screen can link across. */
function siteUrls({ command, urls }) {
  if (urls) return urls;
  // Single-port deploys (Render, Railway…) serve both sites from one origin:
  // the player entrance at `/`, the game master console at `/admin`. Relative
  // links then keep working whatever domain the service is published on.
  if (String(process.env.D404_SINGLE_PORT || "") === "1") return { player: "/", admin: "/admin" };
  const portFor = (site) =>
    command === "build"
      ? defaultUrl[site]
      : SITES[site].devPort;
  return {
    player: process.env.D404_PLAYER_SITE || `http://localhost:${portFor("player")}`,
    admin: process.env.D404_ADMIN_SITE || `http://localhost:${portFor("admin")}`,
  };
}

/**
 * Keeps the two sites honest inside the shared dev root: `/` always resolves
 * to this site's entry, and the other site's HTML returns 404.
 */
function siteGate({ entry }) {
  const foreign = entry === "index.html" ? "/admin.html" : "/index.html";
  const gate = (req, res, next) => {
    const [pathname, query] = String(req.url || "").split("?");
    if (pathname === foreign) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("This page lives on the other site.");
      return;
    }
    if (pathname === "/" && entry !== "index.html") {
      req.url = `/${entry}${query ? `?${query}` : ""}`;
    }
    next();
  };
  return {
    name: "deductive-404-site-gate",
    configureServer(server) {
      server.middlewares.use(gate);
    },
    configurePreviewServer(server) {
      server.middlewares.use(gate);
    },
  };
}

export function siteConfig(site, { command = "serve", urls } = {}) {
  const meta = SITES[site];
  if (!meta) throw new Error(`Unknown site: ${site}`);

  return {
    plugins: [siteGate({ entry: meta.entry }), react(), deductiveBackend()],
    define: { __SITES__: JSON.stringify(siteUrls({ command, urls })) },
    server: { host: true, port: meta.devPort, strictPort: false },
    preview: { host: true, port: prodPort[site] },
    build: {
      outDir: meta.outDir,
      emptyOutDir: true,
      rollupOptions: { input: path.resolve(ROOT, meta.entry) },
    },
  };
}

/** `vite` with no --config builds/serves the player site. */
export default ({ command } = {}) => siteConfig("player", { command });
