import { useState } from "react";
import { postJson } from "../api";

// The star marks an important concept. One click adds the star, and one more click removes it.
// The page shows the change at once. If the server does not save it, the star changes back.
export function StarButton({ conceptId, name, starred, onChange }: { conceptId: number; name: string; starred: boolean; onChange: (starred: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    const next = !starred;
    setBusy(true);
    setError(null);
    onChange(next);
    try {
      await postJson(`/api/concepts/${conceptId}/star`, { starred: next });
    } catch (problem) {
      onChange(!next);
      setError((problem as Error).message);
    }
    setBusy(false);
  };

  return (
    <>
      <button
        className={starred ? "star starred" : "star"}
        onClick={toggle}
        disabled={busy}
        aria-pressed={starred}
        aria-label={`Star ${name}`}
        title={starred ? "Remove the star" : "Star this important concept"}
      >
        {starred ? "★" : "☆"}
      </button>
      {error && (
        <span className="error small" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
