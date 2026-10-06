import Logo from "./Logo.jsx";

/** Shared boot panel used by both sites while the session is restored. */
export default function Splash({ label }) {
  return (
    <div className="cinema">
      <div className="cinema-atmos" aria-hidden="true" />
      <div className="grain" aria-hidden="true" />
      <main className="login-shell">
        <section className="panel splash">
          <Logo size="md" />
          <div className="loading-line">
            <span className="pulse-dot" />
            {label}
          </div>
        </section>
      </main>
    </div>
  );
}
