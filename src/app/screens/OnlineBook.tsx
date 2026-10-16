import { useState, type FormEvent } from "react";
import type { FetchStartView, OnlineTocView, SubjectDetail } from "../../server/api-types";
import { postJson, useApi } from "../api";
import { Layout, Notice } from "../components/Layout";
import { Spinner } from "../components/Spinner";
import { href } from "../router";

const n = (value: number) => value.toLocaleString("en-US");
const plural = (count: number, word: string) => `${n(count)} ${word}${count === 1 ? "" : "s"}`;

// The time of a download in words, for example "about 2 minutes".
function duration(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  return minutes <= 1 ? "about 1 minute" : `about ${n(minutes)} minutes`;
}

// Add an online book: the address, the chapters of the table of contents, and the start of the download.
// The server keeps no state between the two requests, so the page sends the table of contents back with the selection.
export function OnlineBook({ slug }: { slug: string }) {
  const subject = useApi<SubjectDetail>(`/api/subjects/${encodeURIComponent(slug)}`);
  const name = subject.state === "ready" ? subject.data.name : slug;
  // Each answer gets a new number, so that a new table of contents starts with a new selection.
  const [found, setFound] = useState<{ number: number; view: OnlineTocView } | null>(null);
  return (
    <Layout subject={{ slug, name }} tab="subject">
      <p className="back-link">
        <a href={href.subject(slug)}>Back to {name}</a>
      </p>
      <h1>Add an online book</h1>
      <p className="lead">
        The tutor downloads the pages of an online book or of online documentation into an EPUB file. Then you select the chapters to study, as
        for a book file.
      </p>
      {subject.state === "error" ? (
        <Notice title="The subject did not load">
          <p>{subject.message}</p>
        </Notice>
      ) : (
        <>
          <AddressForm onFound={(view) => setFound((current) => (view ? { number: (current?.number ?? 0) + 1, view } : null))} />
          {found && <Chapters key={found.number} slug={slug} found={found.view} />}
        </>
      )}
    </Layout>
  );
}

function AddressForm({ onFound }: { onFound: (view: OnlineTocView | null) => void }) {
  const [url, setUrl] = useState("");
  const [toc, setToc] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const find = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    onFound(null);
    try {
      onFound(await postJson<OnlineTocView>("/api/fetch/toc", { url, toc }));
    } catch (problem) {
      setError((problem as Error).message);
    }
    setBusy(false);
  };
  return (
    <form className="online-form" onSubmit={find}>
      <div className="field">
        <label htmlFor="online-url">Address of the book</label>
        <input
          id="online-url"
          type="text"
          inputMode="url"
          autoComplete="url"
          placeholder="https://doc.rust-lang.org/book/"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <p className="field-note">The start page of the book or of the documentation. The tutor downloads only the pages in its folder.</p>
      </div>
      <div className="field">
        <label htmlFor="online-toc">
          Table of contents <span className="quiet">(optional)</span>
        </label>
        <input id="online-toc" type="text" inputMode="url" value={toc} onChange={(event) => setToc(event.target.value)} />
        <p className="field-note">
          The address of a page with the full list of pages. Use this field only if the tutor does not find all the chapters.
        </p>
      </div>
      <p className="button-row">
        <button className="button" type="submit" disabled={busy || !url.trim()}>
          {busy && <Spinner />}
          {busy ? "Finding the chapters" : "Find the chapters"}
        </button>
      </p>
      {busy && (
        <p className="quiet small" role="status">
          The tutor looks for an llms.txt file first. A site without this file needs one small model request. This can take one minute.
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

// The chapters of the table of contents, with checkboxes. All chapters start selected, as in the command.
function Chapters({ slug, found }: { slug: string; found: OnlineTocView }) {
  const { toc } = found;
  const all = toc.chapters.map((_, i) => i + 1);
  const [selected, setSelected] = useState<number[]>(all);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The EPUB file in data/web/ with the title of the selection, from an earlier download.
  const [existing, setExisting] = useState<{ file: string; title: string } | null>(null);
  const pageCount = (numbers: number[]) => numbers.reduce((count, number) => count + toc.chapters[number - 1]!.pages.length, 0);
  const pages = pageCount(selected);
  const subjectUrl = `/api/subjects/${encodeURIComponent(slug)}`;

  // A new selection gives a new title, so the file of the earlier download does not apply to it.
  const select = (numbers: number[]) => {
    setSelected(numbers);
    setExisting(null);
  };
  const toggle = (number: number) =>
    select(selected.includes(number) ? selected.filter((item) => item !== number) : [...selected, number].sort((a, b) => a - b));

  const act = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      if (next) {
        window.location.hash = next;
        return;
      }
    } catch (problem) {
      setError((problem as Error).message);
    }
    setBusy(false);
  };
  // The book page shows the progress of the download.
  const download = (again: boolean) =>
    act(async () => {
      const result = await postJson<FetchStartView>(`${subjectUrl}/fetch`, { toc, chapters: selected, again });
      if (result.run) return href.book(slug, result.run.book);
      setExisting(result.existing);
      return null;
    });
  const useFile = (file: string) =>
    act(async () => href.book(slug, (await postJson<{ book: string }>(`${subjectUrl}/books/web`, { file })).book, "plan"));

  return (
    <section aria-labelledby="toc-heading">
      <h2 id="toc-heading">{toc.title}</h2>
      <p className="section-intro">
        {toc.source === "llms.txt"
          ? `The table of contents comes from ${toc.tocUrl}.`
          : `The model found the table of contents in the links of ${toc.tocUrl}.`}{" "}
        The tutor downloads only the pages in {toc.scope}. The site has {plural(toc.chapters.length, "chapter")} with {plural(pageCount(all), "page")}.
      </p>
      <p className="button-row selection-tools">
        <span className="quiet small">
          {n(selected.length)} of {plural(toc.chapters.length, "chapter")} selected
        </span>
        <button className="text-button" onClick={() => select(all)} disabled={selected.length === all.length}>
          Select all
        </button>
        <button className="text-button" onClick={() => select([])} disabled={selected.length === 0}>
          Clear
        </button>
      </p>
      <div className="table-scroll">
        <table className="data-table chapter-table">
          <thead>
            <tr>
              <th scope="col">
                <span className="visually-hidden">Selected</span>
              </th>
              <th scope="col">#</th>
              <th scope="col">Chapter</th>
              <th scope="col" className="number">
                Pages
              </th>
            </tr>
          </thead>
          <tbody>
            {toc.chapters.map((chapter, i) => {
              const number = i + 1;
              const id = `online-chapter-${number}`;
              return (
                <tr key={number} className={selected.includes(number) ? "selected" : undefined}>
                  <td>
                    <input id={id} type="checkbox" checked={selected.includes(number)} onChange={() => toggle(number)} />
                  </td>
                  <td className="number">{number}</td>
                  <td>
                    <label htmlFor={id}>{chapter.title}</label>
                  </td>
                  <td className="number">{n(chapter.pages.length)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="action-bar">
        <p className="run-summary" role="status">
          {selected.length === 0
            ? "Select chapters to download."
            : `${plural(selected.length, "chapter")}, ${plural(pages, "page")}, ${duration(pages * found.secondsPerPage)}.`}
          <br />
          <span className="quiet">The download uses no model. The tutor waits one second between two pages. Each image adds about one second.</span>
        </p>
        <button className="button" onClick={() => download(false)} disabled={selected.length === 0 || busy}>
          {busy && !existing && <Spinner />}
          Download
        </button>
        {existing && (
          <div className="existing-file" role="alert">
            <p>
              The folder data/web/ has the file {existing.file} from an earlier download of "{existing.title}".
            </p>
            <p className="button-row">
              <button className="button small" onClick={() => useFile(existing.file)} disabled={busy}>
                Use the downloaded file
              </button>
              <button className="button small secondary" onClick={() => download(true)} disabled={busy}>
                Download again
              </button>
            </p>
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
