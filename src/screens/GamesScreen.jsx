import { useEffect, useState } from "react";
import Logo from "../ui/Logo.jsx";
import Confirm from "../ui/Confirm.jsx";
import { QUESTION_TYPES, MAX_ANSWER_WORDS } from "../game/logic.js";

let seq = 0;
const nextKey = () => `k${++seq}`;

const blankCase = (n) => ({
  key: nextKey(),
  id: null,
  caseNumber: n,
  title: "",
  imageUrl: "",
  question: "",
  type: "text",
  options: [],
  correctAnswer: "",
  clue: "",
  pointsFirst: 100,
  pointsSecond: 50,
  dirty: false,
});

const fromServer = (c) => ({
  key: c.id || nextKey(),
  id: c.id || null,
  caseNumber: c.caseNumber,
  title: c.title || "",
  imageUrl: c.imageUrl || "",
  question: c.question || "",
  type: c.type || "text",
  options: Array.isArray(c.options) ? c.options : [],
  correctAnswer: c.correctAnswer || "",
  clue: c.clue || "",
  pointsFirst: c.pointsFirst ?? 100,
  pointsSecond: c.pointsSecond ?? 50,
  dirty: false,
});

const EMPTY_FORM = { name: "", description: "", caseCount: 5 };

/**
 * GAME BUILDER — where every question, image, clue and answer comes from.
 *
 * Nothing about the game content lives in the code any more: a game is a name
 * plus an ordered list of cases, saved straight to the database. Rooms point at
 * a published game, players then see exactly what was written here.
 */
export default function GamesScreen({ app, mode = "library", onBack, onNew }) {
  const {
    games,
    busy,
    error,
    setError,
    session,
    conn,
    leave,
    loadGame,
    createGame,
    saveGame,
    publishGame,
    removeGame,
    saveCase,
    removeCase,
    moveCase,
    uploadImage,
  } = app;

  const [editing, setEditing] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(mode === "new");
  const [confirm, setConfirm] = useState(null);
  const [preview, setPreview] = useState(null);
  const [flash, setFlash] = useState(null);

  useEffect(() => {
    if (mode === "new") {
      setCreating(true);
      setEditing(null);
      setDrafts([]);
    }
  }, [mode]);

  const open = (game) => setEditing(game);

  const load = async (id) => {
    try {
      const data = await loadGame(id);
      setEditing(data.game);
      setDrafts((data.game.cases || []).map(fromServer));
    } catch {
      /* message already surfaced */
    }
  };

  const onCreate = async (e) => {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) {
      setError("Give the game a name.");
      return;
    }
    try {
      const data = await createGame({
        name,
        description: form.description.trim(),
        caseCount: Number(form.caseCount) || 0,
      });
      setCreating(false);
      setForm(EMPTY_FORM);
      setEditing(data.game);
      setDrafts((data.game.cases || []).map(fromServer));
      setFlash("Game created — add your first case below.");
    } catch {
      /* surfaced */
    }
  };

  const patch = (key, values) =>
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...values, dirty: true } : d)));

  const storeCase = async (draft) => {
    try {
      const data = await saveCase({
        gameId: editing.id,
        caseId: draft.id || undefined,
        caseTitle: draft.title,
        imageUrl: draft.imageUrl,
        question: draft.question,
        questionType: draft.type,
        options: draft.options,
        correctAnswer: draft.correctAnswer,
        clue: draft.clue,
        pointsFirst: draft.pointsFirst,
        pointsSecond: draft.pointsSecond,
      });
      const saved = fromServer(data.case);
      setDrafts((prev) => prev.map((d) => (d.key === draft.key ? saved : d)));
      setFlash(`Case ${saved.caseNumber} saved.`);
      return saved;
    } catch {
      return null;
    }
  };

  const addCase = () => setDrafts((prev) => [...prev, blankCase(prev.length + 1)]);

  const dropCase = (draft) =>
    setConfirm({
      key: "case",
      title: `DELETE CASE ${draft.caseNumber}?`,
      message: "Players in rooms using this game will start again from question 1.",
      label: "DELETE CASE",
      danger: true,
      run: async () => {
        if (draft.id) await removeCase(editing.id, draft.id);
        setDrafts((prev) => prev.filter((d) => d.key !== draft.key).map((d, i) => ({ ...d, caseNumber: i + 1 })));
        return true;
      },
    });

  const shift = async (draft, direction) => {
    if (!draft.id) return;
    await moveCase(editing.id, draft.id, direction);
    await load(editing.id);
  };

  /**
   * The server's save rules, mirrored here: an image upload must never trigger
   * a save the server is going to reject. A half-written case simply keeps the
   * image in the draft (already marked unsaved) and is stored later by
   * SAVE CASE / SAVE ALL, exactly like any other edit.
   */
  /* The server allows a stored correct answer of up to 12 words — the shorter
   * MAX_ANSWER_WORDS cap is how much a player may type, not what may be stored. */
  const MAX_STORED_ANSWER_WORDS = 12;

  const isComplete = (d) => {
    const question = String(d.question || "").trim();
    const answer = String(d.correctAnswer || "").trim();
    if (!question || !answer) return false;
    if (d.type === "boolean")
      return ["true", "t", "yes", "y", "1", "false", "f", "no", "n", "0"].includes(answer.toLowerCase());
    if (d.type === "mcq") {
      const opts = (d.options || []).map((o) => String(o || "").trim()).filter(Boolean);
      return opts.length >= 2 && opts.length <= 6 && opts.includes(answer);
    }
    return answer.split(/\s+/).filter(Boolean).length <= MAX_STORED_ANSWER_WORDS;
  };

  const pickImage = async (draft, file) => {
    if (!file) return;
    try {
      const res = await uploadImage(file);
      const next = { ...draft, imageUrl: res.url, dirty: true };
      patch(draft.key, { imageUrl: res.url });
      if (isComplete(next)) {
        await storeCase(next);
      } else {
        setFlash("Image attached — add the question and answer, then press SAVE CASE.");
      }
    } catch {
      /* surfaced */
    }
  };

  const saveDetails = async () => {
    try {
      const data = await saveGame({ id: editing.id, name: editing.name, description: editing.description });
      setEditing(data.game);
      setFlash("Game details saved.");
    } catch {
      /* surfaced */
    }
  };

  const togglePublish = async () => {
    const next = editing.status === "published" ? "draft" : "published";
    try {
      const data = await publishGame(editing.id, next);
      setEditing({ ...editing, ...data.game });
      setFlash(next === "published" ? "Game published — it can now be assigned to a room." : "Game unpublished.");
    } catch {
      /* surfaced */
    }
  };

  const deleteGame = () =>
    setConfirm({
      key: "game",
      title: "DELETE THIS GAME?",
      message: "Every case, image and clue in it is removed. Rooms are not affected — they are unassigned.",
      label: "DELETE GAME",
      danger: true,
      run: async () => {
        await removeGame(editing.id);
        setEditing(null);
        setDrafts([]);
        return true;
      },
    });

  const runConfirm = async () => {
    const ok = await confirm.run();
    if (ok) setConfirm(null);
  };

  const dirtyCount = drafts.filter((d) => d.dirty || !d.id).length;

  const saveAll = async () => {
    for (const d of [...drafts]) {
      if (d.dirty || !d.id) {
        // eslint-disable-next-line no-await-in-loop
        const saved = await storeCase(d);
        if (!saved) return;
      }
    }
    setFlash("All cases saved.");
  };

  /* ------------------------------------------------------------------ *
   * Header (shared with the command center)
   * ------------------------------------------------------------------ */
  const header = (
    <header className="cmd-top">
      <div className="cmd-brand">
        <Logo size="sm" />
        <span className="cmd-label">GAME BUILDER</span>
      </div>
      <nav className="cmd-nav">
        <button className="nav-tab" onClick={onBack}>
          COMMAND CENTER
        </button>
        <span className="nav-tab active">GAME BUILDER</span>
      </nav>
      <div className="cmd-top-right">
        <span className={`conn-pill${conn === "live" ? " on" : ""}`}>{conn === "live" ? "ONLINE" : "RECONNECTING"}</span>
        <span className="cmd-user">{session?.username}</span>
        <button className="ghost small-btn" onClick={leave}>
          SIGN OUT
        </button>
      </div>
    </header>
  );

  /* ------------------------------------------------------------------ *
   * Create a new game
   * ------------------------------------------------------------------ */
  if (creating)
    return (
      <div className="command">
        {header}
        <div className="builder-shell">
          <section className="panel builder-panel">
            <div className="panel-kicker">NEW GAME</div>
            <h3 className="panel-title">CREATE NEW GAME</h3>
            <form onSubmit={onCreate}>
              <label className="field-label" htmlFor="g-name">
                Game Name
              </label>
              <input
                id="g-name"
                value={form.name}
                maxLength={80}
                autoFocus
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Mystery of the Hidden Diamond"
              />

              <label className="field-label" htmlFor="g-desc">
                Description <em>(optional)</em>
              </label>
              <textarea
                id="g-desc"
                rows={3}
                maxLength={240}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="What the detectives are walking into…"
              />

              <label className="field-label" htmlFor="g-count">
                Number of cases <em>(optional — you can add them one by one)</em>
              </label>
              <input
                id="g-count"
                type="number"
                min={0}
                max={100}
                value={form.caseCount}
                onChange={(e) => setForm({ ...form, caseCount: e.target.value })}
              />

              <div className="modal-actions">
                <button type="button" className="ghost" onClick={() => setCreating(false)} disabled={busy}>
                  CANCEL
                </button>
                <button type="submit" className="btn-primary" disabled={busy}>
                  {busy ? "WORKING…" : "CREATE GAME"}
                </button>
              </div>
            </form>
          </section>
        </div>
        <ErrorBar error={error} setError={setError} />
      </div>
    );

  /* ------------------------------------------------------------------ *
   * Game editor
   * ------------------------------------------------------------------ */
  if (editing)
    return (
      <div className="command">
        {header}
        <div className="builder-shell">
          {flash && (
            <div className="msg hint banner-error" onClick={() => setFlash(null)}>
              ✓ {flash} <em>(click to dismiss)</em>
            </div>
          )}

          <section className="panel builder-panel">
            <div className="builder-head">
              <div>
                <div className="panel-kicker">GAME DETAILS</div>
                <h3 className="panel-title">{editing.name}</h3>
              </div>
              <span className={`st st-${editing.status === "published" ? "live" : "waiting"}`}>
                {editing.status === "published" ? "PUBLISHED" : "DRAFT"}
              </span>
            </div>

            <label className="field-label" htmlFor="e-name">
              Game Name
            </label>
            <input
              id="e-name"
              value={editing.name}
              maxLength={80}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />

            <label className="field-label" htmlFor="e-desc">
              Description <em>(optional)</em>
            </label>
            <textarea
              id="e-desc"
              rows={2}
              maxLength={240}
              value={editing.description}
              onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            />

            <div className="modal-actions">
              <button className="ghost" onClick={saveDetails} disabled={busy}>
                SAVE DETAILS
              </button>
              <button className="ghost" onClick={() => setPreview({ ...editing, cases: drafts })} disabled={busy}>
                PREVIEW
              </button>
              <button
                className={editing.status === "published" ? "btn-warn" : "btn-primary"}
                onClick={togglePublish}
                disabled={busy}
              >
                {editing.status === "published" ? "UNPUBLISH GAME" : "PUBLISH GAME"}
              </button>
              <button className="btn-danger ghost-danger" onClick={deleteGame} disabled={busy}>
                DELETE GAME
              </button>
            </div>
          </section>

          <div className="case-stack">
            {drafts.length === 0 && (
              <section className="panel builder-panel">
                <p className="story">No cases yet. Add the first one.</p>
              </section>
            )}
            {drafts.map((d) => (
              <CaseCard
                key={d.key}
                draft={d}
                total={drafts.length}
                busy={busy}
                onPatch={patch}
                onSave={storeCase}
                onDelete={dropCase}
                onMove={shift}
                onImage={pickImage}
              />
            ))}
          </div>

          <section className="panel builder-panel builder-foot">
            <div className="modal-actions">
              <button className="ghost" onClick={addCase} disabled={busy}>
                + ADD CASE
              </button>
              <button className="btn-primary" onClick={saveAll} disabled={busy || dirtyCount === 0}>
                {busy ? "SAVING…" : "SAVE GAME"}
              </button>
              <button className="ghost" onClick={() => setPreview({ ...editing, cases: drafts })} disabled={busy}>
                PREVIEW
              </button>
            </div>
            <p className="hint-copy">
              {dirtyCount > 0
                ? `${dirtyCount} case${dirtyCount === 1 ? "" : "s"} not saved yet.`
                : "All cases saved. Publish the game before assigning it to a room."}
            </p>
          </section>

          <button className="ghost back-link" onClick={() => setEditing(null)}>
            ← ALL GAMES
          </button>
        </div>
        <ErrorBar error={error} setError={setError} />
        {preview && <PreviewModal game={preview} onClose={() => setPreview(null)} />}
        <Confirm
          open={!!confirm}
          title={confirm?.title}
          message={confirm?.message}
          confirmLabel={confirm?.label}
          danger={confirm?.danger}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={runConfirm}
        />
      </div>
    );

  /* ------------------------------------------------------------------ *
   * Library
   * ------------------------------------------------------------------ */
  return (
    <div className="command">
      {header}
      <div className="builder-shell">
        <section className="panel builder-panel">
          <div className="builder-head">
            <div>
              <div className="panel-kicker">GAME LIBRARY</div>
              <h3 className="panel-title">YOUR GAMES</h3>
            </div>
            <button className="btn-primary" onClick={onNew} disabled={busy}>
              + CREATE NEW GAME
            </button>
          </div>

          {games.length === 0 ? (
            <div className="empty-state">
              <div className="big">🗂️</div>
              <p className="story">
                No games yet. Every question, image, clue and answer you build here is stored in the database —
                nothing is hard-coded.
              </p>
              <button className="btn-primary" onClick={onNew} disabled={busy}>
                + CREATE NEW GAME
              </button>
            </div>
          ) : (
            <ul className="game-grid">
              {games.map((g) => (
                <li key={g.id} className="game-card">
                  <div className="game-card-top">
                    <span className={`st st-${g.status === "published" ? "live" : "waiting"}`}>
                      {g.status === "published" ? "PUBLISHED" : "DRAFT"}
                    </span>
                    <span className="muted">
                      {g.caseCount} case{g.caseCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <h4>{g.name}</h4>
                  {g.description && <p className="story">{g.description}</p>}
                  <div className="game-card-actions">
                    <button className="btn-primary" onClick={() => load(g.id)}>
                      OPEN EDITOR
                    </button>
                    <span className="muted">{g.roomCount} room{g.roomCount === 1 ? "" : "s"}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <button className="ghost back-link" onClick={onBack}>
          ← COMMAND CENTER
        </button>
      </div>
      <ErrorBar error={error} setError={setError} />
      <Confirm
        open={!!confirm}
        title={confirm?.title}
        message={confirm?.message}
        confirmLabel={confirm?.label}
        danger={confirm?.danger}
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={runConfirm}
      />
    </div>
  );
}

function ErrorBar({ error, setError }) {
  if (!error) return null;
  return (
    <div className="msg bad banner-error fixed-error" role="alert" onClick={() => setError(null)}>
      ⚠ {error} <em>(click to dismiss)</em>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * One case: image, question, type, answer, clue, points
 * ------------------------------------------------------------------ */
function CaseCard({ draft, total, busy, onPatch, onSave, onDelete, onMove, onImage }) {
  const set = (values) => onPatch(draft.key, values);
  const isChoice = draft.type !== "text";

  const setOption = (i, value) => {
    const options = [...draft.options];
    options[i] = value;
    set({ options });
    if (draft.correctAnswer === draft.options[i]) set({ options, correctAnswer: value });
  };

  return (
    <section className="panel builder-panel case-card">
      <div className="builder-head">
        <div>
          <div className="panel-kicker">CASE {draft.caseNumber}</div>
          <h3 className="panel-title">{draft.title || "Untitled case"}</h3>
        </div>
        <div className="case-tools">
          <button className="ghost small-btn" title="Move up" disabled={busy || draft.caseNumber <= 1} onClick={() => onMove(draft, -1)}>
            ↑
          </button>
          <button
            className="ghost small-btn"
            title="Move down"
            disabled={busy || draft.caseNumber >= total}
            onClick={() => onMove(draft, 1)}
          >
            ↓
          </button>
          <button className="btn-danger ghost-danger small-btn" disabled={busy} onClick={() => onDelete(draft)}>
            DELETE
          </button>
        </div>
      </div>

      <label className="field-label" htmlFor={`t-${draft.key}`}>
        Case Title
      </label>
      <input
        id={`t-${draft.key}`}
        value={draft.title}
        maxLength={80}
        placeholder="The Missing Necklace"
        onChange={(e) => set({ title: e.target.value })}
      />

      <label className="field-label">Case Image / Puzzle Image</label>
      <div className="upload-row">
        {draft.imageUrl ? (
          <img className="thumb" src={draft.imageUrl} alt="Case" />
        ) : (
          <div className="thumb empty">NO IMAGE</div>
        )}
        <label className="file-btn">
          UPLOAD IMAGE
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) onImage(draft, file);
            }}
          />
        </label>
        {draft.imageUrl && (
          <button className="ghost" disabled={busy} onClick={() => set({ imageUrl: "" })}>
            REMOVE
          </button>
        )}
      </div>

      <label className="field-label" htmlFor={`q-${draft.key}`}>
        Question
      </label>
      <textarea
        id={`q-${draft.key}`}
        rows={2}
        maxLength={400}
        value={draft.question}
        placeholder="Who stole the necklace?"
        onChange={(e) => set({ question: e.target.value })}
      />

      <label className="field-label" htmlFor={`ty-${draft.key}`}>
        Question Type
      </label>
      <select
        id={`ty-${draft.key}`}
        value={draft.type}
        onChange={(e) => {
          const type = e.target.value;
          const next = { type };
          if (type === "boolean") {
            next.options = ["True", "False"];
            if (!["true", "false"].includes(String(draft.correctAnswer).toLowerCase()))
              next.correctAnswer = "True";
          } else if (type === "mcq") {
            next.options = draft.options.length ? draft.options : ["", ""];
            if (!draft.options.includes(draft.correctAnswer)) next.correctAnswer = draft.options[0] || "";
          } else {
            next.options = [];
          }
          set(next);
        }}
      >
        {QUESTION_TYPES.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>

      {isChoice && (
        <div className="options-edit">
          <div className="field-label">
            Options <em>— pick the correct one</em>
          </div>
          {draft.options.map((opt, i) => (
            <div className="option-row" key={i}>
              <input
                type="radio"
                name={`correct-${draft.key}`}
                checked={draft.correctAnswer === opt && opt !== ""}
                disabled={!opt}
                onChange={() => set({ correctAnswer: opt })}
                title="Correct option"
              />
              <input
                value={opt}
                maxLength={80}
                placeholder={`Option ${i + 1}`}
                onChange={(e) => setOption(i, e.target.value)}
              />
              {draft.type === "mcq" && draft.options.length > 2 && (
                <button
                  className="ghost small-btn"
                  disabled={busy}
                  onClick={() => {
                    const options = draft.options.filter((_, n) => n !== i);
                    const correctAnswer = draft.correctAnswer === opt ? options[0] || "" : draft.correctAnswer;
                    set({ options, correctAnswer });
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          {draft.type === "mcq" && draft.options.length < 6 && (
            <button
              className="ghost small-btn"
              disabled={busy}
              onClick={() => set({ options: [...draft.options, ""] })}
            >
              + ADD OPTION
            </button>
          )}
        </div>
      )}

      <label className="field-label" htmlFor={`a-${draft.key}`}>
        Correct Answer
      </label>
      {isChoice ? (
        <select value={draft.correctAnswer} onChange={(e) => set({ correctAnswer: e.target.value })}>
          {draft.options.filter(Boolean).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : (
        <>
          <input
            id={`a-${draft.key}`}
            value={draft.correctAnswer}
            maxLength={120}
            placeholder="Arun"
            onChange={(e) => set({ correctAnswer: e.target.value })}
          />
          <p className="hint-copy">
            Players may answer in {MAX_ANSWER_WORDS} words or fewer — case, spacing and small spelling
            differences are ignored. Keep it to the keyword.
          </p>
        </>
      )}

      <label className="field-label" htmlFor={`c-${draft.key}`}>
        First Attempt Clue
      </label>
      <textarea
        id={`c-${draft.key}`}
        rows={2}
        maxLength={300}
        value={draft.clue}
        placeholder="Look carefully at the security-camera timing."
        onChange={(e) => set({ clue: e.target.value })}
      />

      <div className="points-row">
        <div>
          <label className="field-label" htmlFor={`p1-${draft.key}`}>
            Points (1st attempt)
          </label>
          <input
            id={`p1-${draft.key}`}
            type="number"
            min={0}
            max={10000}
            value={draft.pointsFirst}
            onChange={(e) => set({ pointsFirst: Number(e.target.value) })}
          />
        </div>
        <div>
          <label className="field-label" htmlFor={`p2-${draft.key}`}>
            Points (2nd attempt)
          </label>
          <input
            id={`p2-${draft.key}`}
            type="number"
            min={0}
            max={10000}
            value={draft.pointsSecond}
            onChange={(e) => set({ pointsSecond: Number(e.target.value) })}
          />
        </div>
      </div>

      <div className="modal-actions">
        <span className="muted">{draft.dirty || !draft.id ? "Not saved" : "Saved"}</span>
        <button className="btn-primary" disabled={busy} onClick={() => onSave(draft)}>
          {busy ? "SAVING…" : "SAVE CASE"}
        </button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Preview — what a detective will see
 * ------------------------------------------------------------------ */
function PreviewModal({ game, onClose }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal preview">
        <div className="modal-kicker">PREVIEW</div>
        <h3>{game.name}</h3>
        {game.description && <p className="story">{game.description}</p>}
        <div className="preview-list">
          {(game.cases || []).map((c) => (
            <div className="preview-case" key={c.key || c.id}>
              <span className="tag">CASE {c.caseNumber}</span>
              <b>{c.title || "Untitled case"}</b>
              {c.imageUrl && <img className="photo" src={c.imageUrl} alt="" />}
              <p className="q">{c.question || "—"}</p>
              {c.type === "text" ? (
                <input placeholder="Type your deduction…" disabled />
              ) : (
                <div className="options">
                  {(c.options || []).filter(Boolean).map((o) => (
                    <span className="option" key={o}>
                      {o}
                    </span>
                  ))}
                </div>
              )}
              {c.clue && <p className="hint-copy">CLUE shown after attempt 1: “{c.clue}”</p>}
              <p className="hint-copy">
                1st attempt {c.pointsFirst ?? 100} pts · 2nd attempt {c.pointsSecond ?? 50} pts · both wrong 0 pts
              </p>
            </div>
          ))}
          {(game.cases || []).length === 0 && <p className="story">This game has no cases yet.</p>}
        </div>
        <div className="modal-actions">
          <button className="btn-primary" onClick={onClose}>
            CLOSE PREVIEW
          </button>
        </div>
      </div>
    </div>
  );
}
