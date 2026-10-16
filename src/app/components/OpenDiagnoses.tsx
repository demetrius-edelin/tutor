import type { OpenDiagnosis } from "../../server/api-types";
import { href } from "../router";

const plural = (count: number, word: string) => `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;

function text(diagnosis: OpenDiagnosis): string {
  const of = `a diagnosis of ${plural(diagnosis.concepts, "concept")}`;
  if (diagnosis.status === "preparing") return `The tutor writes the questions of ${of}.`;
  if (diagnosis.status === "failed") return `The questions of ${of} are not ready, because of an error.`;
  return `You did not finish ${of}. ${diagnosis.answered} of ${plural(diagnosis.questions, "question")} have an answer.`;
}

// The diagnoses that did not finish, each with the button that opens it again. The answers stay.
export function OpenDiagnoses({ diagnoses }: { diagnoses: OpenDiagnosis[] }) {
  if (diagnoses.length === 0) return null;
  return (
    <div className="open-diagnoses">
      {diagnoses.map((diagnosis) => (
        <p key={diagnosis.sessionId} className="run-note open-diagnosis">
          <span>{text(diagnosis)}</span>
          <a className="button small" href={href.session(diagnosis.sessionId)}>
            {diagnosis.status === "ready" ? "Continue the diagnosis" : "Open the diagnosis"}
          </a>
        </p>
      ))}
    </div>
  );
}
