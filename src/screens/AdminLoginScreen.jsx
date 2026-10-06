import { useState } from "react";
import Logo from "../ui/Logo.jsx";
import { SITE_URLS } from "../net/sites.js";

/** Separate, hardened entrance for the game master console. */
export default function AdminLoginScreen({ game }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!username.trim()) return setErr("Game master ID is required.");
    if (!password) return setErr("Passphrase is required.");
    setErr(null);
    setBusy(true);
    try {
      await game.adminLogin(username.trim(), password);
    } catch (e2) {
      setErr(e2?.message || "Access denied.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cinema">
      <div className="cinema-atmos" aria-hidden="true" />
      <div className="grain" aria-hidden="true" />

      <main className="login-shell">
        <section className="panel login-panel enter terminal">
          <div className="kicker">RESTRICTED · COMMAND CHANNEL</div>
          <Logo size="lg" />
          <div className="subtitle">GAME MASTER TERMINAL</div>

          <form onSubmit={submit} noValidate>
            <label className="field-label" htmlFor="admin-user">
              GAME MASTER ID
            </label>
            <input
              id="admin-user"
              autoComplete="username"
              placeholder="admin"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                if (err) setErr(null);
              }}
            />

            <label className="field-label" htmlFor="admin-pass">
              PASSPHRASE
            </label>
            <input
              id="admin-pass"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (err) setErr(null);
              }}
            />

            {err && (
              <div className="msg bad shake" role="alert">
                ⚠ {err}
              </div>
            )}

            <button type="submit" className="btn-primary btn-block" disabled={busy}>
              {busy ? "AUTHENTICATING…" : "AUTHENTICATE"}
            </button>
          </form>

          <div className="login-foot">
            <a className="link-gold" href={SITE_URLS.player}>
              ← BACK TO PLAYER ENTRANCE
            </a>
          </div>
        </section>
      </main>
    </div>
  );
}
