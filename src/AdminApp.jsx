import { useState } from "react";
import { useGame } from "./net/useGame.js";
import AdminLoginScreen from "./screens/AdminLoginScreen.jsx";
import AdminDashboard from "./screens/AdminDashboard.jsx";
import GamesScreen from "./screens/GamesScreen.jsx";
import Splash from "./ui/Splash.jsx";

/**
 * GAME MASTER SITE — served on its own port (see vite.config.js / server/index.js).
 * Players never load this bundle, so the console, its routes and its session
 * key only exist on the admin origin.
 *
 * Two sections, one shell:
 *   COMMAND CENTER — rooms, clock, live roster
 *   GAME BUILDER   — create/edit/publish the dynamic game content
 */
export default function AdminApp() {
  const game = useGame("admin");
  const [view, setView] = useState("dashboard");

  if (game.booting) return <Splash label="RESTORING COMMAND CHANNEL…" />;
  if (!game.adminSession) return <AdminLoginScreen game={game} />;

  if (view === "games" || view === "new")
    return (
      <GamesScreen
        app={game}
        mode={view === "new" ? "new" : "library"}
        onBack={() => setView("dashboard")}
        onNew={() => setView("new")}
      />
    );

  return <AdminDashboard game={game} onOpenGames={() => setView("games")} />;
}
