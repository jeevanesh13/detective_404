/**
 * URLs of the two sites, injected at build time by vite.config.js.
 *
 *   player site  →  __SITES__.player
 *   admin site   →  __SITES__.admin
 *
 * Override with D404_PLAYER_SITE / D404_ADMIN_PORT when deploying behind a
 * domain (e.g. https://play.example.com and https://gm.example.com).
 */
export const SITE_URLS =
  typeof __SITES__ === "object" && __SITES__
    ? __SITES__
    : { player: "/", admin: "/" };
