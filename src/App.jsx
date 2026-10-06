import { useGame } from "./net/useGame.js";
import LoginScreen from "./screens/LoginScreen.jsx";
import WaitingScreen from "./screens/WaitingScreen.jsx";
import GameScreen from "./screens/GameScreen.jsx";
import LeaderboardScreen from "./screens/LeaderboardScreen.jsx";
import Splash from "./ui/Splash.jsx";

/**
 * DETECTIVE (PLAYER) SITE — the default entry (index.html).
 * The game-master console lives on a separate site, so no admin route or
 * admin component is reachable — or even bundled — here.
 */
export default function App() {
  const game = useGame("player");

  if (game.booting) return <Splash label="OPENING CASE FILE…" />;
  if (!game.playerSession) return <LoginScreen game={game} />;
  if (!game.room) return <Splash label="SYNCING WITH THE ARCHIVE…" />;

  switch (game.room.status) {
    case "ended":
      return <LeaderboardScreen game={game} />;
    case "waiting":
      return <WaitingScreen game={game} />;
    default:
      return <GameScreen game={game} />;
  }
}
