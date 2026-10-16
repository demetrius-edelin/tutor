import { useRef, useState } from "react";
import type { IngestView, ModuleSummary, StatusCounts, SubjectDetail } from "../../server/api-types";
import { postFile, useApi } from "../api";
import { InlineCode } from "../components/InlineCode";
import { Layout, Notice } from "../components/Layout";
import { OpenDiagnoses } from "../components/OpenDiagnoses";
import { knownShare, ProgressBar, ProgressLegend } from "../components/Progress";
import { Spinner } from "../components/Spinner";
import { href } from "../router";

const n = (value: number) => value.toLocaleString("en-US");
const plural = (count: number, word: string) => `${n(count)} ${word}${count === 1 ? "" : "s"}`;

// A concept to test or a failed concept also needs a choice: the concept map counts it as not chosen.
const notChosen = (progress: StatusCounts) => progress.new + progress.to_test + progress.failed;

export function Subject({ slug }: { slug: string }) {
  const subject = useApi<SubjectDetail>(`/api/subjects/${encodeURIComponent(slug)}`);
  const name = subject.state === "ready" ? subject.data.name : slug;
  return (
    <Layout subject={{ slug, name }} tab="subject">
      {subject.state === "loading" && <p className="quiet">Loading the subject.</p>}
      {subject.state === "error" && <Notice title="The subject did not load">{<p>{subject.message}</p>}</Notice>}
      {subject.state === "ready" && <SubjectView subject={subject.data} />}
    </Layout>
  );
}

function SubjectView({ subject }: { subject: SubjectDetail }) {
  const { done, total } = knownShare(subject.progress);
  // A new subject has no books. It shows only the books part, with the buttons that add a book.
  if (subject.books === 0 && subject.concepts === 0) {
    return (
      <>
        <h1>{subject.name}</h1>
        <p className="lead">
          This subject has no books yet. Add a book file, an online book, or a video, and the tutor finds its concepts. You select the chapters, and you
          can add more chapters later.
        </p>
        <Books subject={subject} />
      </>
    );
  }
  return (
    <>
      <h1>{subject.name}</h1>
      <p className="lead">
        You know {n(done)} of {plural(total, "concept")}.
        {subject.progress.skipped > 0 &&
          ` The ${plural(subject.progress.skipped, "skipped concept")} ${subject.progress.skipped === 1 ? "does" : "do"} not count.`} The concepts come from{" "}
        {plural(subject.books, "book")}, in {plural(subject.modules, "module")}.
      </p>
      <ProgressBar progress={subject.progress} />
      <ProgressLegend progress={subject.progress} />

      <ol className="steps" aria-label="How the tutor works">
        <li>
          <span className="step-number">1</span>
          <span>
            <strong>Choose</strong> concepts from any module, in any order. Test a concept, learn it, or skip it.
          </span>
        </li>
        <li>
          <span className="step-number">2</span>
          <span>
            <strong>Learn</strong> the concepts in your study queue. The tutor teaches one concept at a time from your books.
          </span>
        </li>
        <li>
          <span className="step-number">3</span>
          <span>
            <strong>Pass the test</strong> after the lesson. The concept is then mastered.
          </span>
        </li>
      </ol>

      <OpenDiagnoses diagnoses={subject.openDiagnoses} />
      <NextCard subject={subject} />

      <section aria-labelledby="modules-heading">
        <h2 id="modules-heading">Choose what to learn</h2>
        <p className="section-intro">
          The concepts are in modules. You can choose concepts from any module, in any order. To find one concept, use the{" "}
          <a href={href.map(subject.slug)}>concept map</a>.
        </p>
        <ol className="module-list">
          {subject.moduleList.map((module) => (
            <ModuleRow key={module.id} slug={subject.slug} module={module} />
          ))}
        </ol>
      </section>

      <Books subject={subject} />
    </>
  );
}

const RUN_NAME: Record<IngestView["mode"], string> = { preview: "Preview", save: "Ingest", fetch: "Download" };

// The current step of a run, without its last period, because the note adds its own period.
function stepNote(run: IngestView): string {
  return (run.step || (run.mode === "fetch" ? "the tutor downloads the pages" : "the tutor reads the book")).replace(/\.$/, "");
}

// The books of the subject, the run in progress, the books that are not saved, and the buttons that add a book.
function Books({ subject }: { subject: SubjectDetail }) {
  const { slug, ingest } = subject;
  return (
    <section aria-labelledby="books-heading">
      <h2 id="books-heading">Books</h2>
      {ingest && (
        <p className="run-note" role="status">
          <Spinner />
          {RUN_NAME[ingest.mode]} of "{ingest.title}": {stepNote(ingest)}.{" "}
          <a href={href.book(slug, ingest.book)}>Show the progress</a>
        </p>
      )}
      {subject.bookList.length > 0 && (
        <ol className="contents">
          {subject.bookList.map((book) => (
            <li key={book.slug}>
              <a className="contents-entry" href={href.book(slug, book.slug)}>
                <span className="contents-title">{book.title}</span>
                <span className="leader" aria-hidden="true" />
                <span className="contents-figure">{plural(book.concepts, "concept")}</span>
              </a>
              <p className="contents-note">
                {book.format.toUpperCase()} file, {plural(book.chapters, "chapter")}
                {book.chaptersWithConcepts < book.chapters ? ` (${n(book.chaptersWithConcepts)} with concepts)` : ""},{" "}
                {plural(book.sections, "section")}, {plural(book.words, "word")}
              </p>
              {book.chaptersWithConcepts < book.chapters && (
                <p className="book-actions">
                  <a className="button small secondary" href={href.book(slug, book.slug, "plan")}>
                    Add chapters
                  </a>
                  <span className="quiet small">{plural(book.chapters - book.chaptersWithConcepts, "chapter")} without concepts</span>
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
      {subject.unsavedBooks.length > 0 && (
        <>
          <h3 className="eyebrow unsaved-heading">Not saved yet</h3>
          <ul className="plain-list">
            {subject.unsavedBooks.map((book) => (
              <li key={book.slug}>
                <a href={href.book(slug, book.slug)}>{book.title}</a>
              </li>
            ))}
          </ul>
        </>
      )}
      <AddBook slug={slug} main={subject.bookList.length === 0} />
    </section>
  );
}

// The browser sends the file to the server, and the server parses it. The parse uses no model, so it costs nothing.
// "Add an online book or video" opens the form for the address. The two are the main buttons of a subject with no books.
// After the first book, "Add chapters" is more frequent, so they are text links.
function AddBook({ slug, main }: { slug: string; main: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const upload = async (file: File) => {
    setBusy(file.name);
    setError(null);
    try {
      const { book } = await postFile<{ book: string }>(`/api/subjects/${encodeURIComponent(slug)}/books?name=${encodeURIComponent(file.name)}`, file);
      window.location.hash = href.book(slug, book, "plan");
    } catch (problem) {
      setError((problem as Error).message);
      setBusy(null);
    }
  };
  return (
    <div className={main ? "add-book" : "add-book add-book-inline"}>
      <input
        ref={input}
        type="file"
        accept=".epub,.pdf,application/epub+zip,application/pdf"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void upload(file);
        }}
      />
      <span className="add-book-buttons">
        <button className={main ? "button" : "text-button strong"} onClick={() => input.current?.click()} disabled={busy !== null}>
          {busy && <Spinner />}
          {busy ? `Reading ${busy}` : "Add a book"}
        </button>
        <a className={main ? "button secondary" : "text-button strong"} href={href.online(slug)}>
          Add an online book or video
        </a>
      </span>
      <p className="quiet small">
        A book file: an EPUB file or a tagged PDF file. The tutor reads the chapters with no model, so this step costs nothing. An online book: the
        tutor downloads its pages into an EPUB file. A YouTube video or playlist: the video model writes the transcript.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// The first concept of the study queue, with the button that opens its lesson.
function NextCard({ subject }: { subject: SubjectDetail }) {
  const next = subject.nextToLearn;
  const toLearn = subject.progress.queued + subject.progress.learning;
  return (
    <section className="next-card" aria-labelledby="next-heading">
      <h2 id="next-heading" className="eyebrow">
        Next to learn
      </h2>
      {next ? (
        <>
          <p className="next-name">{next.name}</p>
          <p className="next-meta">
            Module {next.module.position}, {next.module.name}. {next.status === "learning" ? "You started the lesson." : "First in your study queue."}
          </p>
          <p className="objective">
            <InlineCode text={next.objective} />
          </p>
          <p className="button-row">
            <a className="button" href={href.lesson(next.conceptId)}>
              {next.status === "learning" ? "Continue the lesson" : "Start the lesson"}
            </a>
            <a className="text-link" href={href.queue(subject.slug)}>
              Open the study queue ({plural(toLearn, "concept")})
            </a>
          </p>
        </>
      ) : (
        <p className="objective">Your study queue is empty. Choose concepts to learn from a module below.</p>
      )}
    </section>
  );
}

function ModuleRow({ slug, module }: { slug: string; module: ModuleSummary }) {
  const { progress } = module;
  const open = notChosen(progress);
  const toLearn = progress.queued + progress.learning;
  const parts = [
    progress.new + progress.failed > 0 && `${n(progress.new + progress.failed)} not chosen yet`,
    progress.to_test > 0 && `${n(progress.to_test)} to test`,
    toLearn > 0 && `${n(toLearn)} in the study queue`,
    progress.known > 0 && `${n(progress.known)} known`,
    progress.mastered > 0 && `${n(progress.mastered)} mastered`,
    progress.skipped > 0 && `${n(progress.skipped)} skipped`,
  ].filter(Boolean);
  const state = open > 0 ? "" : toLearn > 0 ? "All concepts are chosen. " : "Done. ";
  return (
    <li className="module-row">
      <span className="module-number">{module.position}.</span>
      <div>
        <div className="module-title-row">
          <span className="module-name">{module.name}</span>
          <a className={open > 0 ? "button small secondary" : "text-link"} href={href.mapModule(slug, module.id)}>
            {open > 0 ? "Choose concepts" : "Change the choices"}
          </a>
        </div>
        <ProgressBar progress={progress} />
        <p className="module-status">
          {state}
          {plural(module.concepts, "concept")}: {parts.join(", ")}.
        </p>
      </div>
    </li>
  );
}
