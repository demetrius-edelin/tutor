import { useCallback, useEffect, useState } from "react";
import type { BookView, ChapterPlan, IngestMode, IngestReportView, IngestView, PreviewModule } from "../../server/api-types";
import { getJson, postJson } from "../api";
import { InlineCode } from "../components/InlineCode";
import { Layout, Notice } from "../components/Layout";
import { Spinner } from "../components/Spinner";
import { href, replaceHash } from "../router";

const n = (value: number) => value.toLocaleString("en-US");
const plural = (count: number, word: string) => `${n(count)} ${word}${count === 1 ? "" : "s"}`;
const sum = (chapters: ChapterPlan[]) => chapters.reduce((total, chapter) => total + chapter.requests, 0);

// The book page: the plan of a run, the progress of a run, and the report of the last run.
export function Book({ slug, book, view }: { slug: string; book: string; view: "plan" | null }) {
  const [data, setData] = useState<BookView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = `/api/subjects/${encodeURIComponent(slug)}/books/${encodeURIComponent(book)}`;

  const load = useCallback(() => {
    getJson<BookView>(url)
      .then((next) => {
        setData(next);
        setError(null);
      })
      .catch((problem: unknown) => setError((problem as Error).message));
  }, [url]);

  useEffect(load, [load]);

  // During a run, ask the server for the progress every 2 seconds. At the end of the run, load the page again for the report.
  const run = data?.run;
  useEffect(() => {
    if (!run || run.status !== "running") return;
    const timer = window.setInterval(() => {
      getJson<IngestView>(`/api/ingests/${run.id}`)
        .then((next) => {
          if (next.status === "running") setData((current) => current && { ...current, run: next });
          else load();
        })
        .catch(() => {
          // The next request tries again.
        });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [run?.id, run?.status, load]);

  const name = data?.subject.name ?? slug;
  const setRun = (next: IngestView) => setData((current) => current && { ...current, run: next, report: null });
  return (
    <Layout subject={{ slug, name }} tab="subject">
      <p className="back-link">
        <a href={href.subject(slug)}>Back to {name}</a>
      </p>
      {!data && !error && <p className="quiet">Reading the book. A large book can take some seconds.</p>}
      {error && !data && <Notice title="The book did not load">{<p>{error}</p>}</Notice>}
      {data && <BookBody data={data} view={view} url={url} onRun={setRun} />}
    </Layout>
  );
}

function BookBody({ data, view, url, onRun }: { data: BookView; view: "plan" | null; url: string; onRun: (run: IngestView) => void }) {
  const withConcepts = data.chapters.filter((chapter) => chapter.hasConcepts).length;
  const state = data.run?.status === "running" ? "run" : view !== "plan" && data.run?.status === "done" && data.report ? "report" : "plan";
  return (
    <>
      <h1>{data.title}</h1>
      <p className="lead">
        {data.format.toUpperCase()} file
        {data.chapters.length > 0 && `, ${plural(data.chapters.length, "chapter")}`}.{" "}
        {data.saved
          ? `${n(withConcepts)} of the chapters have concepts on the concept map.`
          : "This book is not saved yet."}
      </p>
      {state === "run" && <RunPanel run={data.run!} onChange={onRun} />}
      {state === "report" && <ReportView data={data} report={data.report!} url={url} onRun={onRun} />}
      {state === "plan" && <PlanView data={data} url={url} onRun={onRun} />}
    </>
  );
}

// The chapters that a run can select. A chapter with concepts needs the command with --replace.
const openChapters = (data: BookView) => data.chapters.filter((chapter) => !chapter.hasConcepts);

// The checkboxes start empty, because a run costs money. After a preview, a stop, or an error, they keep the chapters of that run.
function firstSelection(data: BookView): number[] {
  const run = data.run;
  if (!run || run.mode === "fetch" || (run.mode === "save" && run.status === "done")) return [];
  const open = openChapters(data).map((chapter) => chapter.number);
  return run.chapters.filter((number) => open.includes(number));
}

function LastRun({ run }: { run: IngestView | null }) {
  if (run?.status === "stopped") {
    return <p className="run-note">The last run stopped. Its finished chapters are in the cache, so a new run does not pay for them again.</p>;
  }
  if (run?.status === "failed") return <p className="run-note error">The last run failed: {run.error}</p>;
  return null;
}

// Start a run and show its progress. The address loses "view=plan", so that the report shows at the end of the run.
async function startRun(url: string, data: BookView, mode: IngestMode, chapters: number[]): Promise<IngestView> {
  const run = await postJson<IngestView>(`${url}/ingest`, { mode, chapters });
  replaceHash(href.book(data.subject.slug, data.slug));
  return run;
}

function PlanView({ data, url, onRun }: { data: BookView; url: string; onRun: (run: IngestView) => void }) {
  const [selected, setSelected] = useState<number[]>(() => firstSelection(data));
  const [busy, setBusy] = useState<IngestMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = openChapters(data);

  if (data.problem) {
    return (
      <>
        <LastRun run={data.run} />
        <Notice title="The tutor cannot run ingest on this book">
          <p className="error">{data.problem}</p>
        </Notice>
      </>
    );
  }

  const chosen = data.chapters.filter((chapter) => selected.includes(chapter.number));
  const toggle = (number: number) =>
    setSelected((current) => (current.includes(number) ? current.filter((item) => item !== number) : [...current, number].sort((a, b) => a - b)));
  const start = async (mode: IngestMode) => {
    setBusy(mode);
    setError(null);
    try {
      onRun(await startRun(url, data, mode, selected));
    } catch (problem) {
      setError((problem as Error).message);
      setBusy(null);
    }
  };

  return (
    <>
      <LastRun run={data.run} />
      <h2>Select the chapters</h2>
      <p className="section-intro">
        A preview shows the concepts of the chapters and changes nothing. A save puts the concepts on the concept map. You can add more chapters
        later.
      </p>
      {data.warnings.length > 0 && <Details title={`Parse warnings (${n(data.warnings.length)})`} items={data.warnings} />}
      {open.length === 0 ? (
        <p className="run-note">All the chapters of this book have concepts. To ingest a chapter again, use the command npm run ingest with --replace.</p>
      ) : (
        <p className="button-row selection-tools">
          <span className="quiet small">
            {n(selected.length)} of {plural(open.length, "chapter")} selected
          </span>
          <button className="text-button" onClick={() => setSelected(open.map((chapter) => chapter.number))}>
            Select all
          </button>
          <button className="text-button" onClick={() => setSelected([])} disabled={selected.length === 0}>
            Clear
          </button>
        </p>
      )}
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
                Sections
              </th>
              <th scope="col" className="number wide-only">
                Words
              </th>
              <th scope="col" className="number wide-only">
                Images
              </th>
              <th scope="col" className="number">
                Requests
              </th>
            </tr>
          </thead>
          <tbody>
            {data.chapters.map((chapter) => {
              const id = `chapter-${chapter.number}`;
              return (
                <tr key={chapter.number} className={selected.includes(chapter.number) ? "selected" : undefined}>
                  <td>
                    {!chapter.hasConcepts && (
                      <input id={id} type="checkbox" checked={selected.includes(chapter.number)} onChange={() => toggle(chapter.number)} />
                    )}
                  </td>
                  <td className="number">{chapter.number}</td>
                  <td>
                    {chapter.hasConcepts ? <span>{chapter.title}</span> : <label htmlFor={id}>{chapter.title}</label>}
                    {chapter.hasConcepts && <span className="tag tag-mastered">Has concepts</span>}
                    {!chapter.hasConcepts && chapter.cached && <span className="tag">In the cache</span>}
                  </td>
                  <td className="number">{n(chapter.sections)}</td>
                  <td className="number wide-only">{n(chapter.words)}</td>
                  <td className="number wide-only">{chapter.images > 0 ? n(chapter.images) : ""}</td>
                  <td className="number">{chapter.hasConcepts ? "" : n(chapter.requests)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="quiet small">
        The requests are an estimate. A chapter in the cache needs only the merge request. An image needs one request, one time.
      </p>
      {open.length > 0 && (
        <div className="action-bar">
          <p className="run-summary" role="status">
            {selected.length === 0
              ? "Select chapters for a run."
              : `${plural(selected.length, "chapter")}, about ${plural(sum(chosen), "model request")}.`}
            <br />
            <span className="quiet">{data.model ? `Model: ${data.model}` : data.modelError}</span>
          </p>
          {data.model && (
            <div className="action-group">
              <button className="button secondary" onClick={() => start("preview")} disabled={selected.length === 0 || busy !== null}>
                {busy === "preview" && <Spinner />}
                Preview
              </button>
              <button className="button" onClick={() => start("save")} disabled={selected.length === 0 || busy !== null}>
                {busy === "save" && <Spinner />}
                Save
              </button>
            </div>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </>
  );
}

function RunPanel({ run, onChange }: { run: IngestView; onChange: (run: IngestView) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      onChange(await postJson<IngestView>(`/api/ingests/${run.id}/stop`));
    } catch (problem) {
      setError((problem as Error).message);
    }
    setBusy(false);
  };
  return (
    <section className="run-panel" aria-labelledby="run-heading">
      <h2 id="run-heading" className="eyebrow">
        {run.mode === "preview" ? "Preview" : "Save"} of {plural(run.chapters.length, "chapter")}
      </h2>
      <p className="run-step" role="status">
        <Spinner />
        {run.stopping ? "The run stops after the current step." : run.step || "Reading the book."}
      </p>
      <div className="progress-bar" aria-hidden="true">
        <span className="segment segment-mastered" style={{ flexGrow: run.done }} />
        <span className="segment segment-new" style={{ flexGrow: Math.max(0, run.total - run.done) || 0.0001 }} />
      </div>
      <p className="quiet small">
        {run.total > 0 ? `${n(run.done)} of about ${plural(run.total, "model request")} are done. ` : ""}You can leave this page: the run
        continues on the server.
      </p>
      <p className="button-row">
        <button className="button secondary small" onClick={stop} disabled={busy || run.stopping}>
          {run.stopping ? "Stopping" : "Stop"}
        </button>
        <span className="quiet small">The finished chapters stay in the cache, so a new run does not pay for them again.</span>
      </p>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function ReportView({ data, report, url, onRun }: { data: BookView; report: IngestReportView; url: string; onRun: (run: IngestView) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = data.run!;
  const subject = data.subject.slug;
  const again = openChapters(data).filter((chapter) => run.chapters.includes(chapter.number));
  const remaining = openChapters(data).length;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onRun(await startRun(url, data, "save", again.map((chapter) => chapter.number)));
    } catch (problem) {
      setError((problem as Error).message);
      setBusy(false);
    }
  };
  const all = <T,>(pick: (chapter: IngestReportView["chapters"][number]) => T[]) => report.chapters.flatMap(pick);
  const empty = all((chapter) => chapter.emptySections);
  const missing = all((chapter) => chapter.missingSections);
  const minor = all((chapter) => chapter.minorItems);
  const quotes = all((chapter) => chapter.quoteWarnings);
  const added = report.chapters.reduce((total, chapter) => total + chapter.added, 0);

  return (
    <>
      <section className="next-card" aria-labelledby="report-heading">
        <h2 id="report-heading" className="eyebrow">
          {report.preview ? "Preview report" : "Ingest report"}
        </h2>
        <p className="objective">
          {report.preview
            ? `The preview of ${plural(run.chapters.length, "chapter")} found ${plural(added, "new concept")}. The database did not change.`
            : `The save of ${plural(run.chapters.length, "chapter")} added ${plural(added, "new concept")}. The concept map of ${data.subject.name} has ${plural(report.concepts, "concept")} in ${plural(report.modules, "module")} now.`}
        </p>
        {report.preview ? (
          <p className="button-row">
            {again.length > 0 && data.model && (
              <button className="button" onClick={save} disabled={busy}>
                {busy && <Spinner />}
                Save these chapters (about {plural(sum(again), "model request")})
              </button>
            )}
            <a className="text-link" href={href.book(subject, data.slug, "plan")}>
              Change the chapters
            </a>
          </p>
        ) : (
          <p className="button-row">
            <a className="button" href={href.map(subject)}>
              Open the concept map
            </a>
            {remaining > 0 && (
              <a className="text-link" href={href.book(subject, data.slug, "plan")}>
                Add more chapters ({n(remaining)} without concepts)
              </a>
            )}
          </p>
        )}
        {error && <p className="error">{error}</p>}
      </section>

      {report.imageWarning && <p className="run-note error">{report.imageWarning}</p>}

      <h2>Chapters</h2>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Chapter</th>
              <th scope="col" className="number">
                Sections
              </th>
              <th scope="col" className="number">
                Concepts
              </th>
              <th scope="col" className="number wide-only">
                Added
              </th>
              <th scope="col" className="number wide-only">
                Joined
              </th>
            </tr>
          </thead>
          <tbody>
            {report.chapters.map((chapter) => (
              <tr key={chapter.number}>
                <td className="number">{chapter.number}</td>
                <td>{chapter.title}</td>
                <td className="number">{n(chapter.sections)}</td>
                <td className="number">{n(chapter.concepts)}</td>
                <td className="number wide-only">{n(chapter.added)}</td>
                <td className="number wide-only">{n(chapter.joined)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="quiet small">Added: new concepts on the concept map. Joined: concepts that are the same idea as a concept on the map.</p>

      <h2>What ingest skipped</h2>
      {empty.length + missing.length + minor.length + quotes.length + report.parseWarnings.length === 0 ? (
        <p className="section-intro">Ingest skipped nothing.</p>
      ) : (
        <>
          <p className="section-intro">
            Ingest did not make concepts from these items. Each item has the reason from the model.
            {report.preview && " Read the list before you save: an important idea in it means that the preview missed it."} The app
            cannot add a skipped item as a concept yet.
          </p>
          {empty.length > 0 && (
            <Details
              title={`Sections without concepts (${n(empty.length)})`}
              items={empty.map((item) => `${item.sectionId} ${item.title}: ${item.reason}`)}
            />
          )}
          {missing.length > 0 && (
            <Details
              title={`Sections with no answer from the model (${n(missing.length)})`}
              items={missing.map((item) => `${item.sectionId} ${item.title}`)}
            />
          )}
          {minor.length > 0 && (
            <Details title={`Terms marked as minor (${n(minor.length)})`} items={minor.map((item) => `${item.term}: ${item.reason}`)} />
          )}
          {quotes.length > 0 && (
            <Details
              title={`Quotes that are not in the text (${n(quotes.length)})`}
              items={quotes.map((item) => `${item.concept}, section ${item.sectionId}: "${item.quote}"`)}
            />
          )}
          {report.parseWarnings.length > 0 && <Details title={`Parse warnings (${n(report.parseWarnings.length)})`} items={report.parseWarnings} />}
        </>
      )}

      {report.conceptMap && <PreviewMap modules={report.conceptMap} book={data.title} />}
    </>
  );
}

const LEVEL: Record<PreviewModule["concepts"][number]["level"], string> = { basic: "Basic", intermediate: "Intermediate", advanced: "Advanced" };
const KIND: Record<PreviewModule["concepts"][number]["kind"], string> = { knowledge: "Knowledge", skill: "Skill" };

// The concepts of a preview, in the modules of the concept map. The level and the type of each concept are badges.
function PreviewMap({ modules, book }: { modules: PreviewModule[]; book: string }) {
  // A source in this book does not repeat the title of the book.
  const source = (text: string) => (text.startsWith(`${book}, `) ? text.slice(book.length + 2) : text);
  const joined = modules.some((module) => module.concepts.some((concept) => concept.onMap));
  return (
    <section aria-labelledby="preview-map-heading">
      <h2 id="preview-map-heading">Concepts of the preview</h2>
      <p className="section-intro">
        The concepts of the selected chapters, in their modules on the concept map.
        {joined && ' "On the map" marks a concept that the concept map has already. The preview adds a source to it.'}
      </p>
      {modules.map((module) => (
        <section key={module.name} className="preview-module">
          <h3>
            {module.position}. {module.name} <span className="board-count">{plural(module.concepts.length, "concept")}</span>
          </h3>
          <ul className="preview-concepts">
            {module.concepts.map((concept) => (
              <li key={concept.name}>
                <p className="preview-head">
                  <span className="preview-name">{concept.name}</span>
                  <span className={`badge badge-${concept.level}`}>{LEVEL[concept.level]}</span>
                  <span className="badge badge-kind">{KIND[concept.kind]}</span>
                  {concept.onMap && <span className="badge badge-on-map">On the map</span>}
                </p>
                <p className="objective">
                  <InlineCode text={concept.objective} />
                </p>
                <p className="preview-facts">
                  Source:{" "}
                  {concept.sources.map((item, j) => (
                    <span key={j}>
                      {j > 0 && "; "}
                      {source(item.text)}
                      {!item.quoteFound && <span className="warning-inline"> (the quote is not in the text)</span>}
                    </span>
                  ))}
                  {concept.needs.length > 0 && (
                    <>
                      <br />
                      Needs: {concept.needs.join(", ")}
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}

function Details({ title, items }: { title: string; items: string[] }) {
  return (
    <details className="report-details">
      <summary>{title}</summary>
      <ul>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </details>
  );
}
