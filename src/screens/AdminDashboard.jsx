import { useEffect, useState } from "react";
import Logo from "../ui/Logo.jsx";
import Confirm from "../ui/Confirm.jsx";
import CopyButton from "../ui/CopyButton.jsx";
import { fmtClock, fmtElapsed, fmtDuration, remainingMs } from "../net/time.js";

const STATUS_LABEL = { waiting: "WAITING", live: "LIVE", paused: "PAUSED", ended: "ENDED" };
const PLAYER_LABEL = {
  playing: "Playing",
  finished: "Finished",
  timeout: "Time up",
  waiting: "Waiting",
};
const PRESET_MINUTES = [15, 30, 45, 60];

function playerElapsed(p, room, serverNow) {
  if (p.timeTaken != null) return p.timeTaken;
  if (!room?.startedAt) return 0;
  const start = Math.max(room.startedAt, p.joinedAt || room.startedAt);
  let end = serverNow;
  if (room.status === "paused") end = room.pausedSince || serverNow;
  else if (room.status === "ended") end = room.endedAt || serverNow;
  else if (room.status === "waiting") return 0;
  return Math.max(0, end - start);
}

/**
 * The game master's command center: create rooms, drive the clock, watch every
 * detective move in real time. Optimised for desktop/tablet, still usable on a
 * phone if the case master is on the move.
 */
export default function AdminDashboard({ game, onOpenGames }) {
  const {
    session,
    room,
    players,
    recent,
    rooms,
    games,
    activeRoom,
    leaderboard,
    busy,
    serverNow,
    conn,
    error,
    setError,
    adminAction,
    createRoom,
    deleteRoom,
    selectRoom,
    assignGame,
    leave,
  } = game;

  const [confirm, setConfirm] = useState(null);
  const [applyMin, setApplyMin] = useState(45);
  const [gameId, setGameId] = useState("");

  /* create new room */
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null);
  const [roomName, setRoomName] = useState("Investigation Room");
  const [minutes, setMinutes] = useState(45);
  const [custom, setCustom] = useState(75);

  useEffect(() => {
    if (!room) return;
    setGameId(room.gameId || "");
    setApplyMin(Math.max(1, Math.round(room.duration / 60000)));
  }, [room?.id, room?.duration, room?.gameId]);

  /* Always keep a room selected so the command center is never blank. */
  useEffect(() => {
    if (!activeRoom && rooms.length) selectRoom(rooms[0].roomCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoom, rooms.length]);

  const remaining = remainingMs(room, serverNow);
  const online = players.filter((p) => p.online).length;
  const finished = players.filter((p) => p.status === "finished").length;
  const isCustom = !PRESET_MINUTES.includes(Number(minutes));

  const run = async (action, payload = {}) => {
    try {
      await adminAction(action, payload);
      return true;
    } catch {
      return false;
    }
  };

  /* Delete exactly the one room the admin confirmed. */
  const dropRoom = async (code) => {
    try {
      await deleteRoom(code);
      return true;
    } catch {
      return false;
    }
  };

  /* Create a new room and show the generated room code. */
  const onCreate = async () => {
    const mins = isCustom ? Number(custom) : Number(minutes);
    if (!mins || mins < 1) return;
    try {
      const made = await createRoom(roomName.trim() || "Investigation Room", mins * 60000);
      if (made) {
        setCreating(false);
        setCreated(made.roomCode);
      }
    } catch {
      /* the message is already surfaced by useGame */
    }
  };

  /* ------------------------------------------------------------------ *
   * Live dashboard
   * ------------------------------------------------------------------ */
  const dashboard = !room ? (
    <section className="panel placeholder-panel">
      <p className="story">Pick a room from ROOM on the left to open the live dashboard.</p>
    </section>
  ) : (
    <>
      {/* room header + controls */}
      <section className="panel room-head">
        <div className="room-head-top">
          <div>
            <div className="panel-kicker">LIVE GAME</div>
            <h3 className="room-title">{room.roomName}</h3>
          </div>
          <div className="room-code-block">
            <span>ROOM CODE</span>
            <b className="room-code-xl">{room.roomCode}</b>
            <CopyButton value={room.roomCode} small />
          </div>
        </div>

        <div className="controls">
          {room.status === "waiting" && (
            <button
              className="btn-primary"
              disabled={busy || !room.gameId || !room.totalCases}
              onClick={() => run("start")}
            >
              START GAME
            </button>
          )}
          {room.status === "live" && (
            <button className="btn-warn" disabled={busy} onClick={() => run("pause")}>
              PAUSE GAME
            </button>
          )}
          {room.status === "paused" && (
            <button className="btn-primary" disabled={busy} onClick={() => run("resume")}>
              RESUME GAME
            </button>
          )}
          {room.status !== "ended" && (
            <button
              className="btn-danger"
              disabled={busy}
              onClick={() =>
                setConfirm({
                  key: "end",
                  title: "END THE INVESTIGATION?",
                  message:
                    "The countdown stops immediately, every detective is locked out and final scores are frozen. This cannot be undone.",
                  label: "END GAME",
                  danger: true,
                })
              }
            >
              END GAME
            </button>
          )}
          <button
            className="btn-danger ghost-danger"
            disabled={busy}
            onClick={() =>
              setConfirm({
                key: "reset",
                title: "RESET THE ROOM?",
                message:
                  "Every score, answer, hint and case progression in this room will be erased and all detectives return to the waiting screen.",
                label: "RESET GAME",
                danger: true,
              })
            }
          >
            RESET GAME
          </button>
          <CopyButton value={room.roomCode} label="COPY ROOM CODE" />
        </div>

        {room.status === "waiting" && (!room.gameId || !room.totalCases) && (
          <p className="hint-copy start-hint">
            {room.gameId
              ? "⚠ The assigned game has no cases yet — open GAME BUILDER and add one."
              : "⚠ This room has no game yet — choose one under GAME below and press ASSIGN, then START GAME."}
          </p>
        )}

        <div className="settings">
          <div className="setting">
            <label htmlFor="dur">GAME DURATION</label>
            <select
              id="dur"
              value={PRESET_MINUTES.includes(applyMin) ? applyMin : 0}
              disabled={room.status === "live" || busy}
              onChange={(e) => setApplyMin(Number(e.target.value))}
            >
              {PRESET_MINUTES.map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
              <option value={0}>Custom…</option>
            </select>
            {!PRESET_MINUTES.includes(applyMin) && (
              <input
                type="number"
                min={1}
                max={360}
                className="mini-input"
                value={applyMin}
                disabled={busy}
                onChange={(e) => setApplyMin(Number(e.target.value))}
              />
            )}
            <button
              className="ghost"
              disabled={busy || room.status === "live" || !applyMin}
              onClick={() => run("duration", { duration: applyMin * 60000 })}
            >
              APPLY
            </button>
          </div>

          <div className="setting">
            <label htmlFor="gameSel">GAME</label>
            <select
              id="gameSel"
              value={gameId}
              disabled={busy || room.status === "live" || room.status === "paused"}
              onChange={(e) => setGameId(e.target.value)}
            >
              <option value="">— none assigned —</option>
              {games
                .filter((g) => g.status === "published")
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} · {g.caseCount} case{g.caseCount === 1 ? "" : "s"}
                  </option>
                ))}
            </select>
            <button
              className="ghost"
              disabled={
                busy ||
                room.status === "live" ||
                room.status === "paused" ||
                gameId === (room.gameId || "")
              }
              onClick={() => run("game", { gameId })}
            >
              ASSIGN
            </button>
          </div>
        </div>

        {games.filter((g) => g.status === "published").length === 0 && (
          <p className="hint-copy">
            No published game yet — open the Game Builder and create one, then publish it so this room can
            use it.
          </p>
        )}

        <p className="hint-copy">
          Duration {fmtDuration(room.duration)} · created {new Date(room.createdAt).toLocaleString()} ·
          started {room.startedAt ? new Date(room.startedAt).toLocaleTimeString() : "—"}
        </p>
      </section>

      {/* live statistics */}
      <section className="stat-grid">
        <div className="stat-card accent">
          <span>GAME STATUS</span>
          <b className={`status-word s-${room.status}`}>{STATUS_LABEL[room.status]}</b>
          <em>{conn === "live" ? "stream connected" : "reconnecting…"}</em>
        </div>
        <div className="stat-card clock">
          <span>TIME REMAINING</span>
          <b className={remaining <= 60000 && room.status === "live" ? "danger-text" : ""}>
            {fmtClock(remaining)}
          </b>
          <em>of {fmtClock(room.duration)}</em>
        </div>
        <div className="stat-card">
          <span>PLAYERS ONLINE</span>
          <b>{online}</b>
          <em>of {players.length} joined</em>
        </div>
        <div className="stat-card">
          <span>PLAYERS FINISHED</span>
          <b>{finished}</b>
          <em>
            {room.status === "ended"
              ? `${players.length - finished} ran out of time`
              : `${players.length - finished} still working`}
          </em>
        </div>
        <div className="stat-card">
          <span>CURRENT CASE</span>
          <b>CASE {room.currentCase}</b>
          <em>of {room.totalCases} total</em>
        </div>
      </section>

      {/* live player table + side panels */}
      <section className="cmd-columns">
        <div className="panel table-panel">
          <div className="panel-kicker">REAL-TIME ROSTER</div>
          <h3 className="panel-title">DETECTIVES</h3>
          {players.length === 0 ? (
            <p className="story">Nobody has entered the room yet. Share the room code above.</p>
          ) : (
            <div className="table-scroll">
              <table className="player-table">
                <thead>
                  <tr>
                    <th>Player</th>
                    <th>Room</th>
                    <th>Status</th>
                    <th>Current Case / Question</th>
                    <th>Attempts</th>
                    <th>Score</th>
                    <th>Progress</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {players.map((p) => (
                    <tr key={p.id} className={p.online ? "on" : "off"}>
                      <td data-label="Player">
                        <span className={`presence${p.online ? " on" : ""}`} />
                        <span className="pname">{p.name}</span>
                        <span className="dot-sep">·</span>
                        <span className="muted">{p.online ? "online" : "offline"}</span>
                      </td>
                      <td data-label="Room" className="mono">
                        {room.roomCode}
                      </td>
                      <td data-label="Status">
                        <span className={`st st-${p.status}`}>{PLAYER_LABEL[p.status] || p.status}</span>
                      </td>
                      <td data-label="Current Case / Question">
                        Q{p.case} <span className="muted">of {p.totalCases}</span>
                      </td>
                      <td data-label="Attempts" className="mono">
                        {p.attempts} / 2
                      </td>
                      <td data-label="Score" className="mono gold">
                        {p.score}
                      </td>
                      <td data-label="Progress" className="mono">
                        {p.completedCount} / {p.totalCases} done
                      </td>
                      <td data-label="Time" className="mono">
                        {fmtElapsed(playerElapsed(p, room, serverNow))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="side-stack">
          <div className="panel feed-panel">
            <div className="panel-kicker">INCOMING</div>
            <h3 className="panel-title">ACTIVITY</h3>
            {recent.length === 0 ? (
              <p className="story">No deductions submitted yet.</p>
            ) : (
              <ul className="feed">
                {recent.map((a) => (
                  <li key={a.id} className={a.correct ? "ok" : "bad"}>
                    <b>{a.player || "Detective"}</b>
                    <span>
                      CASE {a.caseId} · {a.correct ? `correct +${a.points}` : "incorrect"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="panel board-panel">
            <div className="panel-kicker">RANKING</div>
            <h3 className="panel-title">STANDINGS</h3>
            {players.length === 0 ? (
              <p className="story">Standings appear as soon as detectives join.</p>
            ) : (
              <ol className="rank-list compact">
                {[...players]
                  .sort(
                    (a, b) =>
                      b.score - a.score ||
                      b.completed - a.completed ||
                      (a.timeTaken ?? 1e12) - (b.timeTaken ?? 1e12)
                  )
                  .map((p, i) => (
                    <li key={p.id}>
                      <span className="rank-no">{i + 1}</span>
                      <span className="rank-name">{p.name}</span>
                      <span className="rank-cases">{p.completed} solved</span>
                      <span className="rank-score">{p.score} pts</span>
                    </li>
                  ))}
              </ol>
            )}
          </div>

          {room.status === "ended" && leaderboard?.length > 0 && (
            <div className="panel board-panel final">
              <div className="panel-kicker">FINAL</div>
              <h3 className="panel-title">DETECTIVE RANKING</h3>
              <ol className="rank-list compact">
                {leaderboard.map((r) => (
                  <li key={r.id}>
                    <span className="rank-no">{r.rank}</span>
                    <span className="rank-name">Detective {r.name}</span>
                    <span className="rank-cases">{r.cases} solved</span>
                    <span className="rank-score">{r.score} pts</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </section>
    </>
  );

  return (
    <div className="command">
      <header className="cmd-top">
        <div className="cmd-brand">
          <Logo size="sm" />
          <span className="cmd-label">COMMAND CENTER</span>
        </div>
        <nav className="cmd-nav">
          <span className="nav-tab active">COMMAND CENTER</span>
          <button className="nav-tab" onClick={onOpenGames}>
            GAME BUILDER
          </button>
        </nav>
        <div className="cmd-top-right">
          {room && (
            <span className="cmd-room">
              ROOM <b>{room.roomCode}</b>
            </span>
          )}
          <span className={`conn-pill${conn === "live" ? " on" : ""}`}>
            {conn === "live" ? "ONLINE" : "RECONNECTING"}
          </span>
          <span className="cmd-user">{session?.username}</span>
          <button className="ghost small-btn" onClick={leave}>
            SIGN OUT
          </button>
        </div>
      </header>

      <div className="cmd-grid">
        <aside className="cmd-side">
          <section className="panel rooms-panel">
            <div className="panel-kicker">ROOM</div>
            <h3 className="panel-title">ROOMS</h3>

            <button
              className="btn-primary btn-block create-room-btn"
              disabled={busy}
              onClick={() => setCreating(true)}
            >
              + CREATE NEW ROOM
            </button>

            {rooms.length === 0 ? (
              <p className="story">No rooms yet — create one above.</p>
            ) : (
              <ul className="room-list">
                {rooms.map((r) => (
                  <li key={r.id} className="room-entry">
                    <button
                      className={`room-row${r.roomCode === activeRoom ? " active" : ""}`}
                      onClick={() => selectRoom(r.roomCode)}
                    >
                      <span className="room-row-code">{r.roomCode}</span>
                      <span className="room-row-name">{r.roomName}</span>
                      <span className={`st st-${r.status}`}>{STATUS_LABEL[r.status]}</span>
                      <span className="room-row-meta">
                        {r.players} detective{r.players === 1 ? "" : "s"} · CASE {r.currentCase} ·{" "}
                        {fmtClock(r.remaining)}
                      </span>
                    </button>
                    <button
                      className="room-del"
                      disabled={busy}
                      aria-label={`Delete room ${r.roomCode}`}
                      onClick={() =>
                        setConfirm({
                          kind: "room",
                          code: r.roomCode,
                          title: "DELETE THIS ROOM?",
                          message: `Room ${r.roomCode} — ${r.roomName} — and every player, answer and score inside it will be permanently deleted. Other rooms are not affected. This cannot be undone.`,
                          label: "DELETE ROOM",
                          danger: true,
                        })
                      }
                    >
                      DELETE
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>

        <main className="cmd-main">
          {error && (
            <div className="msg bad banner-error" role="alert" onClick={() => setError(null)}>
              ⚠ {error} <em>(click to dismiss)</em>
            </div>
          )}
          {dashboard}
        </main>
      </div>

      {/* create new room */}
      {creating && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setCreating(false)}>
          <div className="modal">
            <div className="modal-kicker">CREATE NEW ROOM</div>
            <h3>New case room</h3>

            <label className="field-label" htmlFor="new-room-name">
              Room Name
            </label>
            <input
              id="new-room-name"
              value={roomName}
              maxLength={60}
              onChange={(e) => setRoomName(e.target.value)}
              placeholder="Investigation Room"
            />

            <label className="field-label" htmlFor="new-room-duration">
              Game Duration
            </label>
            <select
              id="new-room-duration"
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
            >
              {PRESET_MINUTES.map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
              <option value={0}>Custom…</option>
            </select>

            {isCustom && (
              <input
                type="number"
                min={1}
                max={360}
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="Custom minutes"
              />
            )}

            <div className="modal-actions">
              <button className="ghost" disabled={busy} onClick={() => setCreating(false)}>
                CANCEL
              </button>
              <button className="btn-primary" disabled={busy} onClick={onCreate}>
                {busy ? "WORKING…" : "CREATE ROOM"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* room created — big shareable code */}
      {created && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setCreated(null)}>
          <div className="modal created">
            <div className="modal-kicker">ROOM CREATED</div>
            <div className="big-code">{created}</div>
            <p className="story">Share this code with your detectives at the player entrance.</p>
            <div className="modal-actions">
              <CopyButton value={created} label="COPY ROOM CODE" />
              <button className="btn-primary" onClick={() => setCreated(null)}>
                OPEN ROOM
              </button>
            </div>
          </div>
        </div>
      )}

      <Confirm
        open={!!confirm}
        title={confirm?.title}
        message={confirm?.message}
        confirmLabel={confirm?.label}
        danger={confirm?.danger}
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const ok = confirm.kind === "room" ? await dropRoom(confirm.code) : await run(confirm.key);
          if (ok) setConfirm(null);
        }}
      />
    </div>
  );
}
