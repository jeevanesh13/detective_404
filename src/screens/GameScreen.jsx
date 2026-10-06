import { useEffect, useState } from "react";
import { norm, tooLong, MAX_ANSWER_WORDS, MAX_ATTEMPTS } from "../game/logic.js";
import Logo from "../ui/Logo.jsx";
import { fmtClock, remainingMs } from "../net/time.js";

/**
 * The detective game screen.
 *
 * The layout, HUD, cards and countdown come from the original build; only the
 * content is new. Every question, image, clue and answer now arrives from the
 * room's assigned game, written by the game master in the Game Builder, and
 * every state below is decided by the server:
 *
 *   attempt 1 correct -> +100, question closed, next one unlocked
 *   attempt 1 wrong    -> the configured clue, same question again
 *   attempt 2 correct -> +50,  question closed, next one unlocked
 *   attempt 2 wrong    -> +0, the answer is shown, question closed
 *
 * Nothing about a locked question (its text, clue or answer) is ever sent to
 * this page — the list only shows that it is locked.
 */
export default function GameScreen({ game }) {
  const { room, you, serverNow, conn, question, questionList } = game;

  const [val, setVal] = useState("");
  const [choice, setChoice] = useState("");
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState(null);
  const [result, setResult] = useState(null);

  const total = Math.max(room?.totalCases || 0, 0);
  const i = Math.min(Math.max((you?.case || 1) - 1, 0), Math.max(total - 1, 0));
  const last = i + 1 >= total;

  /* The question is closed once the server says both attempts are spent or
     the answer landed — that survives a refresh, so the result panel does too. */
  const closed = !!you?.awaitingNext;
  const restored =
    closed && question?.completed
      ? { kind: question.correct ? "correct" : "final", points: question.points, answer: question.correctAnswer }
      : null;
  const shown = result || restored;

  const attemptsUsed = question ? question.attempts : you?.attempts || 0;
  const attemptsLeft = question ? question.attemptsLeft : you?.attemptsLeft ?? MAX_ATTEMPTS;

  const remaining = remainingMs(room, serverNow);
  const low = remaining <= 60_000;
  const done = you?.status === "finished";
  const isText = question?.type === "text";

  useEffect(() => {
    setVal("");
    setChoice("");
    setResult(null);
    setErr(null);
  }, [you?.case]);

  if (!room || !you) {
    return (
      <div className="cinema">
        <main className="login-shell">
          <section className="panel">
            <Logo size="md" />
            <p className="story">Retrieving your case file…</p>
          </section>
        </main>
      </div>
    );
  }

  const submit = async () => {
    if (closed || pending || !question) return;
    if (isText) {
      if (norm(val).trim().length <= 1) {
        setErr("Type your deduction…");
        return;
      }
      if (tooLong(val)) {
        setErr(`Keep it short — ${MAX_ANSWER_WORDS} words at most. A full sentence is never needed.`);
        return;
      }
    } else if (!choice) {
      setErr("Pick one of the options.");
      return;
    }
    setErr(null);
    setPending(true);
    try {
      const res = await game.submitAnswer(you.case, isText ? val : choice);
      if (res.completed) {
        setResult(
          res.correct
            ? { kind: "correct", points: res.points, attempt: res.attempt }
            : { kind: "final", points: res.points, answer: res.answer, attempt: res.attempt }
        );
        setVal("");
        setChoice("");
      } else {
        setResult({ kind: "clue", text: res.clue, attempt: res.attempt });
      }
    } catch (e) {
      setErr(e?.message || "Could not submit. Try again.");
    } finally {
      setPending(false);
    }
  };

  const retry = () => {
    setResult(null);
    setErr(null);
  };

  const next = async () => {
    if (pending) return;
    setErr(null);
    setPending(true);
    try {
      await game.advance();
      setVal("");
      setChoice("");
      setResult(null);
    } catch (e) {
      setErr(e?.message || "Could not move on.");
    } finally {
      setPending(false);
    }
  };

  /* ---------------- finished every question ---------------- */
  if (done)
    return (
      <>
        <GameHud game={game} remaining={remaining} low={low} />
        <div className="wrap">
          <div className="bar">
            <i style={{ width: "100%" }} />
          </div>
          <div className="card">
            <div className="big">🔍</div>
            <h2 style={{ textAlign: "center" }}>Case closed!</h2>
            <p className="story" style={{ textAlign: "center" }}>
              You completed {you.completedCount} of {total} questions and banked{" "}
              <b className="gold">{you.score} points</b>
              {you.correct > 0 && <> on {you.correct} first-try solves</>}.
            </p>
            <p className="story" style={{ textAlign: "center" }}>
              Your case file has been submitted to the archive. Results appear the moment the
              game master closes the investigation.
            </p>
            <Standings game={game} />
          </div>
        </div>
      </>
    );

  return (
    <>
      <GameHud game={game} remaining={remaining} low={low} />

      {room.status === "paused" && (
        <div className="overlay">
          <div className="overlay-card">
            <div className="stamp">PAUSED</div>
            <p>The game master has paused the investigation.</p>
          </div>
        </div>
      )}

      <div className="wrap">
        <div className="bar">
          <i style={{ width: (total ? (you.completedCount / total) * 100 : 0) + "%" }} />
        </div>
        <div className="sub row-sub">
          <span>
            Case {i + 1} of {total}
          </span>
          <span className="score-pill">SCORE {you.score}</span>
        </div>

        {room.gameName && (
          <div className="game-strip">
            <span className="panel-kicker">GAME</span>
            <b>{room.gameName}</b>
          </div>
        )}

        {conn !== "live" && (
          <div className="msg hint">📡 Reconnecting to the case archive… progress is safe.</div>
        )}

        <ProgressList list={questionList} active={you.case} />

        <div className="card">
          {question ? (
            <>
              <span className="tag">CASE {question.caseNumber}</span>
              <h2>{question.title || `Case ${question.caseNumber}`}</h2>
              {question.imageUrl && (
                <img className="photo" src={question.imageUrl} alt={question.title || "Case file"} />
              )}
              <div className="q">{question.question}</div>

              {closed && shown ? (
                <div>
                  {shown.kind === "correct" ? (
                    <div className="msg good">
                      ✅ Correct! {shown.points ? <b>+{shown.points} points</b> : <b>Completed</b>}
                    </div>
                  ) : (
                    <div className="msg bad">
                      <b>Incorrect Again</b>
                      <div className="reveal-row">
                        Correct Answer: <b>{shown.answer || "—"}</b>
                      </div>
                      <div className="reveal-row">
                        Points Earned: <b>{shown.points || 0}</b>
                      </div>
                    </div>
                  )}
                  <button onClick={next} disabled={pending}>
                    {pending ? "Working…" : last ? "Finish" : "NEXT QUESTION →"}
                  </button>
                </div>
              ) : shown?.kind === "clue" ? (
                <div>
                  <div className="msg bad">
                    <b>Incorrect Answer</b>
                    <div className="clue-row">
                      💡 CLUE:{" "}
                      <em>{shown.text ? `“${shown.text}”` : "Look again at the details you were given."}</em>
                    </div>
                  </div>
                  <button onClick={retry} disabled={pending}>
                    TRY AGAIN
                  </button>
                </div>
              ) : (
                <div>
                  {question.type === "text" ? (
                    <input
                      value={val}
                      placeholder="Type your deduction…"
                      onChange={(e) => {
                        setVal(e.target.value);
                        if (err) setErr(null);
                      }}
                      onKeyDown={(e) => e.key === "Enter" && submit()}
                      disabled={pending || room.status !== "live"}
                    />
                  ) : (
                    <div className="options">
                      {(question.options || []).map((opt) => (
                        <button
                          key={opt}
                          type="button"
                          className={`option${choice === opt ? " on" : ""}`}
                          onClick={() => {
                            setChoice(opt);
                            if (err) setErr(null);
                          }}
                          disabled={pending || room.status !== "live"}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  )}

                  <button
                    onClick={submit}
                    disabled={pending || room.status !== "live" || (!isText && !choice)}
                  >
                    {pending ? "Checking…" : "Submit Answer"}
                  </button>

                  <div className="dots">
                    Attempts:
                    {[0, 1].map((n) => (
                      <b key={n} className={n < attemptsUsed ? "x" : ""} />
                    ))}
                    <span>
                      {attemptsLeft} of {MAX_ATTEMPTS} left
                    </span>
                  </div>

                  {err && <div className="msg bad">⚠ {err}</div>}
                </div>
              )}
            </>
          ) : (
            <p className="story">Waiting for the game master to assign a case file…</p>
          )}
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Every question of the assigned game: completed / active / locked
 * ------------------------------------------------------------------ */
function ProgressList({ list, active }) {
  if (!Array.isArray(list) || !list.length) return null;
  return (
    <div className="q-list">
      <div className="roster-title">QUESTIONS</div>
      <ul>
        {list.map((q) => (
          <li key={q.caseNumber} className={`q-row ${q.state}`}>
            <span className="q-no">CASE {q.caseNumber}</span>
            <span className="q-name">{q.title || "Untitled"}</span>
            <span className="q-state">
              {q.state === "completed" && <>✓ COMPLETED{q.points ? ` · ${q.points}` : ""}</>}
              {q.state === "active" && <>▶ ACTIVE</>}
              {q.state === "unlocked" && <>🔓 NEXT</>}
              {q.state === "locked" && <>🔒 LOCKED</>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Top HUD — room, detective, live countdown
 * ------------------------------------------------------------------ */
function GameHud({ game, remaining, low }) {
  const { room, you, conn } = game;
  return (
    <header className="hud">
      <div className="hud-inner">
        <Logo size="sm" />
        <div className="hud-chip">
          <span>ROOM</span>
          <b>{room.roomCode}</b>
        </div>
        <div className="hud-chip">
          <span>PLAYER</span>
          <b>{you.name}</b>
        </div>
        <div className="hud-chip hide-sm">
          <span>CASE</span>
          <b>
            {you.case} / {room.totalCases}
          </b>
        </div>
        <div className={`hud-timer${low ? " low" : ""}`}>
          <span>
            TIME REMAINING
            {conn !== "live" ? " · RECONNECTING" : ""}
          </span>
          <b>{fmtClock(remaining)}</b>
        </div>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ *
 * Live standings shown after a detective finishes all questions
 * ------------------------------------------------------------------ */
function Standings({ game }) {
  const { players, you } = game;
  const sorted = [...players].sort(
    (a, b) => b.score - a.score || b.completed - a.completed || (a.timeTaken ?? 1e12) - (b.timeTaken ?? 1e12)
  );
  return (
    <div className="mini-board">
      <div className="roster-title">LIVE STANDINGS</div>
      <ol>
        {sorted.slice(0, 8).map((p, idx) => (
          <li key={p.id} className={p.id === you.id ? "me" : ""}>
            <span className="rank-no">{idx + 1}</span>
            <span className="rank-name">{p.name}</span>
            <span className="rank-cases">{p.completed} solved</span>
            <span className="rank-score">{p.score}</span>
          </li>
        ))}
      </ol>
      <p className="story" style={{ marginTop: 10, marginBottom: 0 }}>
        Final ranking is published the moment the countdown reaches 00:00.
      </p>
    </div>
  );
}
