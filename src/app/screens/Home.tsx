import type { SubjectSummary } from "../../server/api-types";
import { useApi } from "../api";
import { Layout, Notice } from "../components/Layout";
import { knownShare } from "../components/Progress";
import { href } from "../router";

const plural = (count: number, word: string) => `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;

export function Home() {
  const subjects = useApi<SubjectSummary[]>("/api/subjects");
  return (
    <Layout>
      {subjects.state === "loading" && <p className="quiet">Loading the subjects.</p>}
      {subjects.state === "error" && <Notice title="The subjects did not load">{<p>{subjects.message}</p>}</Notice>}
      {subjects.state === "ready" && subjects.data.length === 0 && (
        <Notice title="No subjects yet">
          <p>A subject is an area of study with its own books. To make one, add a book from the terminal:</p>
          <pre className="command">npm run ingest -- SQL /path/to/book.epub --chapters 1</pre>
          <p>Then open this page again.</p>
        </Notice>
      )}
      {subjects.state === "ready" && subjects.data.length > 0 && (
        <>
          <h1>Subjects</h1>
          <ol className="contents">
            {subjects.data.map((subject) => {
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
                  </p>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </Layout>
  );
}
