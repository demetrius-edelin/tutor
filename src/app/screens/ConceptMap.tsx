import { useEffect, useMemo, useState } from "react";
import type { ConceptMapView, ConceptView, Status } from "../../server/api-types";
import { postJson, useApi } from "../api";
import { Layout, Notice } from "../components/Layout";
import { SectionPanel } from "../components/SectionPanel";
import { STATUS_INFO, StatusMark } from "../components/StatusMark";
import { href } from "../router";

const LEVEL: Record<ConceptView["level"], string> = { basic: "Basic", intermediate: "Intermediate", advanced: "Advanced" };
const KIND: Record<ConceptView["kind"], string> = { knowledge: "knowledge", skill: "skill" };

export function ConceptMap({ slug, focus }: { slug: string; focus: string | null }) {
  const map = useApi<ConceptMapView>(`/api/themes/${encodeURIComponent(slug)}/map`);
  const name = map.state === "ready" ? map.data.theme.name : slug;
  return (
    <Layout theme={{ slug, name }} tab="map">
      {map.state === "loading" && <p className="quiet">Loading the concept map.</p>}
      {map.state === "error" && <Notice title="The concept map did not load">{<p>{map.message}</p>}</Notice>}
      {map.state === "ready" && <MapView map={map.data} focus={focus} />}
    </Layout>
  );
}

function matches(concept: ConceptView, query: string): boolean {
  const text = `${concept.name} ${concept.objective}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word));
}

function MapView({ map: loaded, focus }: { map: ConceptMapView; focus: string | null }) {
  const [map, setMap] = useState(loaded);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set(focus ? [focus] : []));
  const [section, setSection] = useState<number | null>(null);
  const total = map.modules.reduce((sum, module) => sum + module.concepts.length, 0);

  // A link to a concept opens it and scrolls to it.
  useEffect(() => {
    if (!focus) return;
    setOpen((current) => new Set(current).add(focus));
    requestAnimationFrame(() => document.getElementById(`concept-${focus}`)?.scrollIntoView({ block: "center" }));
  }, [focus]);

  const modules = useMemo(
    () =>
      map.modules
        .map((module) => ({ ...module, concepts: module.concepts.filter((concept) => matches(concept, query)) }))
        .filter((module) => module.concepts.length > 0),
    [map, query],
  );
  const shown = modules.reduce((sum, module) => sum + module.concepts.length, 0);

  // Show the new status of a concept after an action, without a new load of the map.
  const setStatus = (id: number, status: Status) =>
    setMap((current) => ({
      ...current,
      modules: current.modules.map((module) => ({
        ...module,
        concepts: module.concepts.map((concept) => (concept.id === id ? { ...concept, status } : concept)),
      })),
    }));

  const toggle = (slug: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });

  return (
    <>
      <h1>Concept map</h1>
      <p className="lead">
        {map.modules.length} modules and {total} concepts from the books of {map.theme.name}. Open a concept to see its sources. Use
        the links under a concept to learn it or to test it.
      </p>
      <div className="search">
        <label htmlFor="concept-search">Find a concept</label>
        <input
          id="concept-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="For example: index"
          autoComplete="off"
        />
        {query && (
          <span className="quiet" role="status">
            {shown} of {total} concepts
          </span>
        )}
      </div>

      {modules.length === 0 && <p className="quiet">No concept matches "{query}".</p>}
      {modules.map((module) => (
        <section key={module.id} className="module" aria-labelledby={`module-${module.id}`}>
          <div className="module-head">
            <h2 id={`module-${module.id}`}>
              <span className="module-number">{module.position}.</span> {module.name}
            </h2>
            <a className="module-action" href={href.select(map.theme.slug, module.id)}>
              {map.modules
                .find((item) => item.id === module.id)!
                .concepts.some((concept) => ["new", "to_test", "failed"].includes(concept.status))
                ? "Choose what to test"
                : "Change the marks"}
            </a>
          </div>
          <ul className="concepts">
            {module.concepts.map((concept) => (
              <ConceptRow
                key={concept.slug}
                concept={concept}
                moduleId={module.id}
                themeSlug={map.theme.slug}
                open={open.has(concept.slug)}
                onToggle={() => toggle(concept.slug)}
                onRead={setSection}
                onStatus={(status) => setStatus(concept.id, status)}
              />
            ))}
          </ul>
        </section>
      ))}

      {section !== null && <SectionPanel sectionId={section} onClose={() => setSection(null)} />}
    </>
  );
}

function ConceptRow(props: {
  concept: ConceptView;
  moduleId: number;
  themeSlug: string;
  open: boolean;
  onToggle: () => void;
  onRead: (sectionId: number) => void;
  onStatus: (status: Status) => void;
}) {
  const { concept, open } = props;
  const detailsId = `details-${concept.slug}`;
  return (
    <li className="concept" id={`concept-${concept.slug}`}>
      <div className="margin">
        <StatusMark status={concept.status} />
      </div>
      <div className="concept-body">
        <div className="concept-head">
          <button className="concept-name" aria-expanded={open} aria-controls={detailsId} onClick={props.onToggle}>
            {concept.name}
          </button>
          <span className="concept-meta">
            {LEVEL[concept.level]} {KIND[concept.kind]}
            {concept.status !== "new" && `. ${STATUS_INFO[concept.status].label}`}
          </span>
        </div>
        <p className="objective">{concept.objective}</p>
        <ConceptActions concept={concept} moduleId={props.moduleId} onStatus={props.onStatus} />
        {open && (
          <div className="concept-details" id={detailsId}>
            {concept.prerequisites.length > 0 && (
              <p className="needs">
                Needs{" "}
                {concept.prerequisites.map((prerequisite, i) => (
                  <span key={prerequisite.slug}>
                    {i > 0 && ", "}
                    <a href={href.map(props.themeSlug, prerequisite.slug)}>{prerequisite.name}</a>
                  </span>
                ))}
              </p>
            )}
            <ul className="sources">
              {concept.sources.map((source) => (
                <li key={source.sectionId}>
                  <p className="source-ref">
                    {source.book}, section {source.ref} {source.title}
                    {source.page ? `, page ${source.page}` : ""}
                  </p>
                  <blockquote className="quote">
                    <span>{source.quote}</span>
                  </blockquote>
                  <button className="text-button" onClick={() => props.onRead(source.sectionId)}>
                    Read the section
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </li>
  );
}

// The actions on one concept. A concept with a lesson opens the lesson. Other concepts can go into the study queue or get a test.
function ConceptActions({ concept, moduleId, onStatus }: { concept: ConceptView; moduleId: number; onStatus: (status: Status) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // An action that opens a different page keeps the links disabled until the page changes.
  const run = async (action: () => Promise<string | null>) => {
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

  const learnNow = () =>
    run(async () => {
      await postJson(`/api/concepts/${concept.id}/top`);
      return href.lesson(concept.id);
    });
  const addToQueue = () =>
    run(async () => {
      await postJson(`/api/modules/${moduleId}/selection`, { marks: { [concept.id]: "learn" } });
      onStatus("queued");
      return null;
    });
  const testIt = () =>
    run(async () => {
      const { sessionId } = await postJson<{ sessionId: number }>(`/api/concepts/${concept.id}/test`);
      return href.session(sessionId);
    });

  return (
    <>
      <p className="row-actions">
        {concept.status === "learning" || concept.status === "mastered" ? (
          <a className="text-button strong" href={href.lesson(concept.id)}>
            {concept.status === "learning" ? "Continue the lesson" : "Open the lesson"}
          </a>
        ) : (
          <>
            <button className="text-button strong" onClick={learnNow} disabled={busy}>
              Learn now
            </button>
            {concept.status !== "queued" && (
              <button className="text-button" onClick={addToQueue} disabled={busy}>
                Add to the study queue
              </button>
            )}
            {concept.status !== "queued" && (
              <button className="text-button" onClick={testIt} disabled={busy}>
                Test it
              </button>
            )}
          </>
        )}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
