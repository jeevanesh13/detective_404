export default function Logo({ size = "lg", stacked = false }) {
  return (
    <div className={`logo logo-${size}${stacked ? " stacked" : ""}`} aria-label="Detective 404">
      <span className="logo-word">DETECTIVE</span>
      <span className="logo-code">404</span>
    </div>
  );
}
