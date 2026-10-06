import { useState } from "react";
import Logo from "../ui/Logo.jsx";

/**
 * First screen a detective ever sees: cinematic, quiet, and locked behind a
 * room code issued by the game master.
 */
export default function LoginScreen({ game }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState(null);
  const [joining, setJoining] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const playerName = name.trim().replace(/\s+/g, " ");
    const roomCode = code.trim().toUpperCase();

    if (!playerName) return setErr("Player name is required.");
    if (playerName.length < 2) return setErr("Detective name must be at least 2 characters.");
    if (playerName.length > 24) return setErr("Detective name must be 24 characters or fewer.");
    if (!roomCode) return setErr("Room code is required.");
    if (!/^[A-Z0-9]{6}$/.test(roomCode)) return setErr("Invalid Room Code");

    setErr(null);
    setJoining(true);
    try {
      await game.join(playerName, roomCode);
    } catch (e2) {
      setErr(e2?.message || "Unable to join the room.");
    } finally {
      setJoining(false);
    }
  };

  return (
    <div className="cinema">
      <div className="cinema-atmos" aria-hidden="true" />
      <div className="grain" aria-hidden="true" />
      <main className="login-shell">
        <section className="panel login-panel enter">
          <div className="kicker">CLASSIFIED · CASE FILE 404</div>
          <Logo size="xl" />
          <div className="subtitle">THE MYSTERY OF THE MIDNIGHT HOTEL</div>

          <form onSubmit={submit} noValidate>
            <label className="field-label" htmlFor="player-name">
              PLAYER NAME
            </label>
            <input
              id="player-name"
              autoComplete="nickname"
              placeholder="Enter your detective name"
              value={name}
              maxLength={24}
              onChange={(e) => {
                setName(e.target.value);
                if (err) setErr(null);
              }}
            />

            <label className="field-label" htmlFor="room-code">
              ROOM CODE
            </label>
            <input
              id="room-code"
              className="code-input"
              placeholder="ABC123"
              value={code}
              maxLength={6}
              autoCapitalize="characters"
              spellCheck={false}
              onChange={(e) => {
                setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""));
                if (err) setErr(null);
              }}
            />

            {err && (
              <div className="msg bad shake" role="alert">
                ⚠ {err}
              </div>
            )}

            <button type="submit" className="btn-primary btn-block" disabled={joining}>
              {joining ? "VERIFYING ROOM…" : "JOIN GAME"}
            </button>
          </form>
        </section>

        <p className="cinema-caption">
          Case files, questions, clues and images are set by your game master. Every answer is recorded the
          moment you submit it.
        </p>
      </main>
    </div>
  );
}
