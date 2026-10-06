import Logo from "../ui/Logo.jsx";
import CopyButton from "../ui/CopyButton.jsx";
import { fmtClock } from "../net/time.js";

/** The lobby a detective waits in until the game master hits START GAME. */
export default function WaitingScreen({ game }) {
  const { room, players, you, serverNow, leave, conn } = game;
  const online = players.filter((p) => p.online).length;

  return (
    <div className="cinema">
      <div className="cinema-atmos" aria-hidden="true" />
      <div className="grain" aria-hidden="true" />

      <header className="mini-hud">
        <Logo size="sm" />
        <span className={`conn-pill ${conn === "live" ? "on" : ""}`}>
          {conn === "live" ? "CONNECTED" : "RECONNECTING…"}
        </span>
      </header>

      <main className="login-shell">
        <section className="panel waiting-panel enter">
          <div className="big-status">YOU ARE IN</div>

          <div className="waiting-rows">
            <div className="waiting-row">
              <span>ROOM CODE</span>
              <b className="room-code-lg">{room?.roomCode || "——————"}</b>
            </div>
            <div className="waiting-row">
              <span>Detective</span>
              <b>{you?.name || game.session?.playerName}</b>
            </div>
            <div className="waiting-row">
              <span>Players Joined</span>
              <b>{players.length}</b>
            </div>
            <div className="waiting-row">
              <span>Online now</span>
              <b>{online}</b>
            </div>
          </div>

          <p className="waiting-copy">
            Waiting for the game master to start the investigation…
          </p>

          <div className="waiting-badge">
            <span className="pulse-dot" />
            WAITING
          </div>

          <div className="waiting-meta">
            <div>
              <span>CASE FILE</span>
              <b>{room?.gameName || room?.roomName || "Awaiting assignment"}</b>
            </div>
            <div>
              <span>DURATION</span>
              <b>{fmtClock(room?.duration || 0)}</b>
            </div>
            <div>
              <span>QUESTIONS</span>
              <b>{room?.totalCases || 0}</b>
            </div>
          </div>

          {players.length > 0 && (
            <div className="roster">
              <div className="roster-title">DETECTIVES IN THE ROOM</div>
              <ul className="roster-list">
                {players.map((p) => (
                  <li key={p.id} className={p.id === you?.id ? "me" : ""}>
                    <span className={`presence${p.online ? " on" : ""}`} />
                    {p.name}
                    {p.id === you?.id && <em>you</em>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="waiting-actions">
            <CopyButton value={room?.roomCode || ""} label="COPY ROOM CODE" />
            <button className="ghost" onClick={leave}>
              LEAVE ROOM
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
