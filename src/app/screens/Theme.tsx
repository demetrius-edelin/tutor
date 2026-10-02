import type { ThemeDetail } from "../../server/api-types";
import { useApi } from "../api";
import { Layout, Notice } from "../components/Layout";
import { knownShare, ProgressBar, ProgressLegend } from "../components/Progress";
import { href } from "../router";

const n = (value: number) => value.toLocaleString("en-US");
const plural = (count: number, word: string) => `${n(count)} ${word}${count === 1 ? "" : "s"}`;

export function Theme({ slug }: { slug: string }) {
  const theme = useApi<ThemeDetail>(`/api/themes/${encodeURIComponent(slug)}`);
  const name = theme.state === "ready" ? theme.data.name : slug;
  return (
    <Layout crumbs={[{ label: "Themes", href: href.home() }, { label: name }]}>
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
        {plural(theme.books, "book")}, {plural(theme.modules, "module")}, {plural(theme.concepts, "concept")}. You know{" "}
        {n(done)} of {plural(total, "concept")}.
      </p>

      {theme.nextModule && (
        <section aria-labelledby="next-heading" className="next-step">
          <h2 id="next-heading">Next step</h2>
          <p>
            Module {theme.nextModule.position}, {theme.nextModule.name}, has {plural(theme.nextModule.newConcepts, "concept")} that you
            did not mark yet. Choose which concepts to test, to learn, or to skip.
          </p>
          <p>
            <a className="button" href={href.select(theme.slug, theme.nextModule.id)}>
              Choose what to test
            </a>
          </p>
        </section>
      )}

      <section aria-labelledby="progress-heading">
        <h2 id="progress-heading">Progress</h2>
        <ProgressBar progress={theme.progress} />
        <ProgressLegend progress={theme.progress} />
        <p>
          <a className={theme.nextModule ? "text-link" : "button"} href={href.map(theme.slug)}>
            Open the concept map
          </a>
        </p>
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
