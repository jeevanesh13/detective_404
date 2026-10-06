import { useState } from "react";

export default function CopyButton({ value, label = "COPY ROOM CODE", small }) {
  const [done, setDone] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(String(value));
    } catch {
      const el = document.createElement("textarea");
      el.value = String(value);
      document.body.appendChild(el);
      el.select();
      try {
        document.execCommand("copy");
      } catch {
        /* ignore */
      }
      document.body.removeChild(el);
    }
    setDone(true);
    setTimeout(() => setDone(false), 1800);
  };

  return (
    <button type="button" className={`ghost copy-btn${small ? " small" : ""}`} onClick={copy}>
      {done ? "✓ COPIED" : label}
    </button>
  );
}
