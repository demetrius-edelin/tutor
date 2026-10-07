import { useState } from "react";
import type { SubjectSummary } from "../../server/api-types";
import { deleteJson, useApi } from "../api";
import { Layout, Notice } from "../components/Layout";
import { knownShare } from "../components/Progress";
import { Spinner } from "../components/Spinner";
import { href } from "../router";

const plural = (count: number, word: string) => `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;

export function Home() {
  const subjects = useApi<SubjectSummary[]>("/api/subjects");
  // The list does not load again after a delete. The page hides the deleted subjects.
  const [deleted, setDeleted] = useState<string[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const list = subjects.state === "ready" ? subjects.data.filter((subject) => !deleted.includes(subject.slug)) : [];
  return (
    <Layout>
      {subjects.state === "loading" && <p className="quiet">Loading the subjects.</p>}
      {subjects.state === "error" && <Notice title="The subjects did not load">{<p>{subjects.message}</p>}</Notice>}
      {subjects.state === "ready" && list.length === 0 && (
        <Notice title="No subjects yet">
          <p>A subject is an area of study with its own books. To make one, add a book from the terminal:</p>
          <pre className="command">npm run ingest -- SQL /path/to/book.epub --chapters 1</pre>
          <p>Then open this page again.</p>
        </Notice>
      )}
      {list.length > 0 && (
        <>
          <h1>Subjects</h1>
          <ol className="contents">
            {list.map((subject) => {
              const { done, total } = knownShare(subject.progress);
              return (
                <li key={subject.slug}>
                  <a className="contents-entry" href={href.subject(subject.slug)}>
                    <span className="contents-title">{subject.name}</span>
                    <span className="leader" aria-hidden="true" />
                    <span className="contents-figure">
                      {done} of {plural(total, "concept")}
                    </span>
                  </a>
                  <p className="contents-note">
                    {plural(subject.books, "book")}, {plural(subject.modules, "module")}
                    {subject.progress.skipped > 0 && `, ${plural(subject.progress.skipped, "skipped concept")}`}
                    {confirming !== subject.slug && (
                      <button className="text-button contents-action" onClick={() => setConfirming(subject.slug)} aria-label={`Delete ${subject.name}`}>
                        Delete
                      </button>
                    )}
                  </p>
                  {confirming === subject.slug && (
                    <DeleteSubject
                      subject={subject}
                      onCancel={() => setConfirming(null)}
                      onDeleted={() => {
                        setDeleted((slugs) => [...slugs, subject.slug]);
                        setConfirming(null);
                      }}
                    />
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </Layout>
  );
}

// The learner confirms the delete, because the tutor cannot undo it.
function DeleteSubject({ subject, onCancel, onDeleted }: { subject: SubjectSummary; onCancel: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteJson(`/api/subjects/${encodeURIComponent(subject.slug)}`);
      onDeleted();
    } catch (problem) {
      setError((problem as Error).message);
      setBusy(false);
    }
  };
  return (
    <div
      className="confirm-delete"
      role="group"
      aria-label={`Delete ${subject.name}`}
      onKeyDown={(event) => event.key === "Escape" && !busy && onCancel()}
    >
      <p>
        Delete <strong>{subject.name}</strong>? The tutor deletes its books with their files, its concepts, and all your progress: lessons,
        tests, and answers. You cannot undo this.
      </p>
      {error && <p className="error">{error}</p>}
      <p className="button-row">
        <button className="button danger" onClick={remove} disabled={busy}>
          {busy && <Spinner />}
          {busy ? "Deleting" : `Delete ${subject.name}`}
        </button>
        <button className="text-button" onClick={onCancel} disabled={busy} autoFocus>
          Cancel
        </button>
      </p>
    </div>
  );
}
