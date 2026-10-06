import { useEffect } from "react";

/**
 * Cinematic confirmation dialog — used before END GAME / RESET GAME so the
 * game master never nukes an investigation by accident.
 */
export default function Confirm({ open, title, message, confirmLabel = "CONFIRM", cancelLabel = "CANCEL", danger, busy, onConfirm, onCancel }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onCancel?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && onCancel?.()}>
      <div className={`modal${danger ? " danger" : ""}`}>
        <div className="modal-kicker">CONFIRM ACTION</div>
        <h3>{title}</h3>
        <p>{message}</p>
        <div className="modal-actions">
          <button className="ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button className={danger ? "danger-btn" : ""} onClick={onConfirm} disabled={busy}>
            {busy ? "WORKING…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
