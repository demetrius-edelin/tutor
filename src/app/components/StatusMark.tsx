import type { Status } from "../../server/api-types";

// Each status has a mark in the margin of the page, as a reader marks a book.
export const STATUS_INFO: Record<Status, { mark: string; label: string }> = {
  new: { mark: "○", label: "Not started" },
  to_test: { mark: "?", label: "To test" },
  known: { mark: "✓", label: "Known" },
  failed: { mark: "✗", label: "Failed" },
  queued: { mark: "◇", label: "In the study queue" },
  learning: { mark: "◐", label: "Learning" },
  mastered: { mark: "✓", label: "Mastered" },
  skipped: { mark: "–", label: "Skipped" },
};

export function StatusMark({ status }: { status: Status }) {
  const info = STATUS_INFO[status];
  return (
    <span className={`mark mark-${status}`} role="img" aria-label={info.label} title={info.label}>
      {info.mark}
    </span>
  );
}
