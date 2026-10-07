import { useGame } from "./net/useGame.js";
import LoginScreen from "./screens/LoginScreen.jsx";
import WaitingScreen from "./screens/WaitingScreen.jsx";
import GameScreen from "./screens/GameScreen.jsx";
import LeaderboardScreen from "./screens/LeaderboardScreen.jsx";
import Splash from "./ui/Splash.jsx";
import { playerRemainingMs } from "./net/time.js";

/**
 * DETECTIVE (PLAYER) SITE — the default entry (index.html).
 * The game-master console lives on a separate site, so no admin route or
 * admin component is reachable — or even bundled — here.
 *
 * START GAME is individual: which screen you see depends on YOUR session
 * (did you press START, has YOUR clock run out) — never on what the rest
 * of the room is doing.
 */
export default function App() {
  const game = useGame("player");

  if (game.booting) return <Splash label="OPENING CASE FILE…" />;
  if (!game.playerSession) return <LoginScreen game={game} />;
  if (!game.room) return <Splash label="SYNCING WITH THE ARCHIVE…" />;

  const { room, you, serverNow } = game;

  // The room itself was closed (game master pressed END / time ran out for all)
  if (room.status === "ended") return <LeaderboardScreen game={game} />;

  // Not started yet → the lobby, no matter who else in the room is playing
  if (!you || !you.startedAt) return <WaitingScreen game={game} />;

  // YOUR personal clock ran out → only your game is over; the room plays on
  if (you.timedOut || playerRemainingMs(you, room, serverNow) <= 0)
    return <LeaderboardScreen game={game} />;

  return <GameScreen game={game} />;
}
