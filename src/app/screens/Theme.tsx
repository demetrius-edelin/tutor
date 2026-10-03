import type { ModuleSummary, StatusCounts, ThemeDetail } from "../../server/api-types";
import { useApi } from "../api";
import { Layout, Notice } from "../components/Layout";
import { knownShare, ProgressBar, ProgressLegend } from "../components/Progress";
import { href } from "../router";

const n = (value: number) => value.toLocaleString("en-US");
const plural = (count: number, word: string) => `${n(count)} ${word}${count === 1 ? "" : "s"}`;

// A concept to test or a failed concept also needs a choice: the module page shows it as not chosen.
const notChosen = (progress: StatusCounts) => progress.new + progress.to_test + progress.failed;

export function Theme({ slug }: { slug: string }) {
  const theme = useApi<ThemeDetail>(`/api/themes/${encodeURIComponent(slug)}`);
  const name = theme.state === "ready" ? theme.data.name : slug;
  return (
    <Layout theme={{ slug, name }} tab="theme">
      {theme.state === "loading" && <p className="quiet">Loading the theme.</p>}
      {theme.state === "error" && <Notice title="The theme did not load">{<p>{theme.message}</p>}</Notice>}
      {theme.state === "ready" && <ThemeView theme={theme.data} />}
    </Layout>
  );
}

function ThemeView({ theme }: { theme: ThemeDetail }) {
  const { done, total } = knownShare(theme.progress);
  return (
    <>
      <h1>{theme.name}</h1>
      <p className="lead">
        You know {n(done)} of {plural(total, "concept")}. The concepts come from {plural(theme.books, "book")}, in{" "}
        {plural(theme.modules, "module")}.
      </p>
      <ProgressBar progress={theme.progress} />
      <ProgressLegend progress={theme.progress} />

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

      <NextCard theme={theme} />

      <section aria-labelledby="modules-heading">
        <h2 id="modules-heading">Choose what to learn</h2>
        <p className="section-intro">
          The concepts are in modules. You can choose concepts from any module, in any order. To find one concept, use the{" "}
          <a href={href.map(theme.slug)}>concept map</a>.
        </p>
        <ol className="module-list">
          {theme.moduleList.map((module) => (
            <ModuleRow key={module.id} slug={theme.slug} module={module} />
          ))}
        </ol>
      </section>

      <section aria-labelledby="books-heading">
        <h2 id="books-heading">Books</h2>
        <ol className="contents">
          {theme.bookList.map((book) => (
            <li key={book.slug}>
              <div className="contents-entry">
                <span className="contents-title">{book.title}</span>
                <span className="leader" aria-hidden="true" />
                <span className="contents-figure">{plural(book.concepts, "concept")}</span>
              </div>
              <p className="contents-note">
                {book.format.toUpperCase()} file, {plural(book.chapters, "chapter")}
                {book.chaptersWithConcepts < book.chapters ? ` (${n(book.chaptersWithConcepts)} with concepts)` : ""},{" "}
                {plural(book.sections, "section")}, {plural(book.words, "word")}
              </p>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

// The first concept of the study queue, with the button that opens its lesson.
function NextCard({ theme }: { theme: ThemeDetail }) {
  const next = theme.nextToLearn;
  const toLearn = theme.progress.queued + theme.progress.learning;
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
          <p className="objective">{next.objective}</p>
          <p className="button-row">
            <a className="button" href={href.lesson(next.conceptId)}>
              {next.status === "learning" ? "Continue the lesson" : "Start the lesson"}
            </a>
            <a className="text-link" href={href.queue(theme.slug)}>
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
          <a className={open > 0 ? "button small secondary" : "text-link"} href={href.select(slug, module.id)}>
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
