/**
 * Vite plugin: mounts the DETECTIVE 404 API + SSE stream inside the Vite dev
 * server (and `vite preview`), so `npm run dev` gives you the full multiplayer
 * stack on one origin with zero extra configuration.
 */
import { handleRequest } from "./api.js";
import { seedAdmin } from "./db.js";

function middleware(req, res, next) {
  handleRequest(req, res)
    .then((handled) => {
      if (!handled) next();
    })
    .catch((err) => {
      console.error("[deductive-404]", err);
      next();
    });
}

export function deductiveBackend() {
  seedAdmin();
  return {
    name: "deductive-404-backend",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
