import type { ThemeSummary } from "../../server/api-types";
import { useApi } from "../api";
import { Layout, Notice } from "../components/Layout";
import { knownShare } from "../components/Progress";
import { href } from "../router";

const plural = (count: number, word: string) => `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;

export function Home() {
  const themes = useApi<ThemeSummary[]>("/api/themes");
  return (
    <Layout>
      {themes.state === "loading" && <p className="quiet">Loading the themes.</p>}
      {themes.state === "error" && <Notice title="The themes did not load">{<p>{themes.message}</p>}</Notice>}
      {themes.state === "ready" && themes.data.length === 0 && (
        <Notice title="No themes yet">
          <p>A theme is an area of study with its own books. To make one, add a book from the terminal:</p>
          <pre className="command">npm run ingest -- SQL /path/to/book.epub --chapters 1 --save</pre>
          <p>Then open this page again.</p>
        </Notice>
      )}
      {themes.state === "ready" && themes.data.length > 0 && (
        <>
          <h1>Themes</h1>
          <ol className="contents">
            {themes.data.map((theme) => {
              const { done, total } = knownShare(theme.progress);
              return (
                <li key={theme.slug}>
                  <a className="contents-entry" href={href.theme(theme.slug)}>
                    <span className="contents-title">{theme.name}</span>
                    <span className="leader" aria-hidden="true" />
                    <span className="contents-figure">
                      {done} of {plural(total, "concept")}
                    </span>
                  </a>
                  <p className="contents-note">
                    {plural(theme.books, "book")}, {plural(theme.modules, "module")}
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
