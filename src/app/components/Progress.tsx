import { STATUSES, type StatusCounts } from "../../server/api-types";
import { STATUS_INFO, StatusMark } from "./StatusMark";

const n = (value: number) => value.toLocaleString("en-US");

// The statuses that count for the progress. A skipped concept does not count: the learner does not want to learn it.
const COUNTED = STATUSES.filter((status) => status !== "skipped");

// The share of concepts that the learner knows: known in the diagnosis, or mastered after a lesson.
export function knownShare(progress: StatusCounts): { done: number; total: number } {
  const total = COUNTED.reduce((sum, status) => sum + progress[status], 0);
  return { done: progress.known + progress.mastered, total };
}

export function ProgressBar({ progress }: { progress: StatusCounts }) {
  const { total } = knownShare(progress);
  if (total === 0) return null;
  return (
    <div className="progress-bar" aria-hidden="true">
      {COUNTED.filter((status) => progress[status] > 0).map((status) => (
        <span key={status} className={`segment segment-${status}`} style={{ flexGrow: progress[status] }} />
      ))}
    </div>
  );
}

export function ProgressLegend({ progress }: { progress: StatusCounts }) {
  return (
    <ul className="legend">
      {STATUSES.filter((status) => progress[status] > 0).map((status) => (
        <li key={status}>
          <StatusMark status={status} />
          <span>{STATUS_INFO[status].label}</span>
          <span className="count">{n(progress[status])}</span>
        </li>
      ))}
    </ul>
  );
}
