import Logo from "../ui/Logo.jsx";
import { fmtClock } from "../net/time.js";

function rankPlayers(players) {
  return [...players].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if ((b.completed ?? b.cases ?? 0) !== (a.completed ?? a.cases ?? 0))
      return (b.completed ?? b.cases ?? 0) - (a.completed ?? a.cases ?? 0);
    const ta = a.timeTaken ?? Number.MAX_SAFE_INTEGER;
    const tb = b.timeTaken ?? Number.MAX_SAFE_INTEGER;
    return ta - tb;
  });
}

const medal = ["🥇", "🥈", "🥉"];

/** Cinematic end-of-game result screen. */
export default function LeaderboardScreen({ game }) {
  const { room, players, you, leaderboard, leave } = game;
  const rows =
    leaderboard && leaderboard.length
      ? leaderboard
      : rankPlayers(players).map((p, i) => ({
          rank: i + 1,
          id: p.id,
          name: p.name,
          score: p.score,
          cases: p.completed,
          timeTaken: p.timeTaken,
          status: p.status,
        }));

  const podium = rows.slice(0, 3);
  const rest = rows.slice(3);
  const myRank = rows.find((r) => r.id === you?.id);

  return (
    <div className="cinema">
      <div className="cinema-atmos" aria-hidden="true" />
      <div className="grain" aria-hidden="true" />

      <main className="login-shell wide">
        <section className="panel results-panel enter">
          <Logo size="md" />
          <div className="stamp">TIME&apos;S UP</div>
          <h2 className="results-title">FINAL DETECTIVE RANKING</h2>
          <div className="results-sub">
            ROOM {room?.roomCode} · {room?.roomName} · {fmtClock(room?.duration || 0)} CASE FILE
          </div>

          <div className="podium">
            {podium.map((r, i) => (
              <div key={r.id} className={`podium-card rank-${i + 1}${r.id === you?.id ? " me" : ""}`}>
                <div className="medal">{medal[i]}</div>
                <div className="podium-place">#{r.rank}</div>
                <div className="podium-name">Detective {r.name}</div>
                <div className="podium-score">{r.score}</div>
                <div className="podium-unit">points</div>
                <div className="podium-meta">
                  {r.cases} case{r.cases === 1 ? "" : "s"} solved
                  {r.timeTaken != null && <> · {fmtClock(r.timeTaken)}</>}
                </div>
              </div>
            ))}
          </div>

          {rest.length > 0 && (
            <ol className="rank-list">
              {rest.map((r) => (
                <li key={r.id} className={r.id === you?.id ? "me" : ""}>
                  <span className="rank-no">{r.rank}</span>
                  <span className="rank-name">Detective {r.name}</span>
                  <span className="rank-cases">{r.cases} solved</span>
                  <span className="rank-score">{r.score} pts</span>
                </li>
              ))}
            </ol>
          )}

          {myRank && (
            <div className="your-rank">
              YOUR RESULT — <b>#{myRank.rank}</b> · <b>{myRank.score}</b> points ·{" "}
              <b>{myRank.cases}</b> case{myRank.cases === 1 ? "" : "s"} solved
            </div>
          )}

          <div className="waiting-actions">
            <button className="btn-primary" onClick={leave}>
              NEW INVESTIGATION
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
