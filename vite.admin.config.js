import { siteConfig } from "./vite.config.js";

/** Game-master console:  vite --config vite.admin.config.js */
export default ({ command } = {}) => siteConfig("admin", { command });
