import { useEffect, useMemo, useState } from "react";
import type { ConceptMapView, ConceptView, Mark, SelectionResult, Status } from "../../server/api-types";
import { postJson, useApi } from "../api";
import { Layout, Notice } from "../components/Layout";
import { SectionPanel } from "../components/SectionPanel";
import { StarButton } from "../components/StarButton";
import { STATUS_INFO, StatusMark } from "../components/StatusMark";
import { href } from "../router";

const LEVEL: Record<ConceptView["level"], string> = { basic: "Basic", intermediate: "Intermediate", advanced: "Advanced" };
const KIND: Record<ConceptView["kind"], string> = { knowledge: "knowledge", skill: "skill" };

export function ConceptMap({ slug, focus, focusModule }: { slug: string; focus: string | null; focusModule: number | null }) {
  const map = useApi<ConceptMapView>(`/api/themes/${encodeURIComponent(slug)}/map`);
  const name = map.state === "ready" ? map.data.theme.name : slug;
  return (
    <Layout theme={{ slug, name }} tab="map">
      {map.state === "loading" && <p className="quiet">Loading the concept map.</p>}
      {map.state === "error" && <Notice title="The concept map did not load">{<p>{map.message}</p>}</Notice>}
      {map.state === "ready" && <MapView map={map.data} focus={focus} focusModule={focusModule} />}
    </Layout>
  );
}

// The choice to show the goals stays in this browser. Without storage, the map shows the goals.
const GOALS_KEY = "tutor.map.goals";

function readShowGoals(): boolean {
  try {
    return window.localStorage.getItem(GOALS_KEY) !== "hidden";
  } catch {
    return true;
  }
}

// A concept with a lesson has its own actions on the lesson page, so it has no checkbox.
const selectable = (concept: ConceptView) => concept.status !== "learning" && concept.status !== "mastered";

// Send marks for concepts from any module of the theme.
const sendMarks = (themeSlug: string, ids: number[], mark: Mark) =>
  postJson<SelectionResult>(`/api/themes/${encodeURIComponent(themeSlug)}/selection`, {
    marks: Object.fromEntries(ids.map((id) => [id, mark])),
  });

function matches(concept: ConceptView, query: string): boolean {
  const text = `${concept.name} ${concept.objective}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word));
}

function MapView({ map: loaded, focus, focusModule }: { map: ConceptMapView; focus: string | null; focusModule: number | null }) {
  const [map, setMap] = useState(loaded);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set(focus ? [focus] : []));
  const [section, setSection] = useState<number | null>(null);
  const [showGoals, setShowGoals] = useState(readShowGoals);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const total = map.modules.reduce((sum, module) => sum + module.concepts.length, 0);

  // A link to a concept opens it and scrolls to it.
  useEffect(() => {
    if (!focus) return;
    setOpen((current) => new Set(current).add(focus));
    requestAnimationFrame(() => document.getElementById(`concept-${focus}`)?.scrollIntoView({ block: "center" }));
  }, [focus]);

  // A link to a module, for example from the overview, scrolls to the module.
  useEffect(() => {
    if (focusModule === null) return;
    requestAnimationFrame(() => document.getElementById(`module-${focusModule}`)?.scrollIntoView({ block: "start" }));
  }, [focusModule]);

  const modules = useMemo(
    () =>
      map.modules
        .map((module) => ({ ...module, concepts: module.concepts.filter((concept) => matches(concept, query)) }))
        .filter((module) => module.concepts.length > 0),
    [map, query],
  );
  const shown = modules.reduce((sum, module) => sum + module.concepts.length, 0);

  // Show the new status or star of concepts after an action, without a new load of the map.
  const updateConcepts = (ids: number[], change: Partial<Pick<ConceptView, "status" | "starred">>) =>
    setMap((current) => ({
      ...current,
      modules: current.modules.map((module) => ({
        ...module,
        concepts: module.concepts.map((concept) => (ids.includes(concept.id) ? { ...concept, ...change } : concept)),
      })),
    }));
  const updateConcept = (id: number, change: Partial<Pick<ConceptView, "status" | "starred">>) => updateConcepts([id], change);

  const setChecked = (ids: number[], checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const changeShowGoals = (value: boolean) => {
    setShowGoals(value);
    try {
      window.localStorage.setItem(GOALS_KEY, value ? "shown" : "hidden");
    } catch {
      // The choice then stays only until the page loads again.
    }
  };

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
        the buttons next to a concept to learn it, test it, or skip it. To do this for many concepts in one step, select their
        boxes. The color of a row shows its status: yellow to learn, green known, and gray skipped.
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
        <label className="check">
          <input type="checkbox" checked={showGoals} onChange={(event) => changeShowGoals(event.target.checked)} />
          Show the goals
        </label>
        {query && (
          <span className="quiet" role="status">
            {shown} of {total} concepts
          </span>
        )}
      </div>

      {modules.length === 0 && <p className="quiet">No concept matches "{query}".</p>}
      {modules.map((module) => {
        // Select all acts on the concepts that the search shows.
        const ids = module.concepts.filter(selectable).map((concept) => concept.id);
        const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
        return (
          <section key={module.id} className="module" aria-labelledby={`module-${module.id}`}>
            <div className="module-head">
              <h2 id={`module-${module.id}`}>
                <span className="module-number">{module.position}.</span> {module.name}
              </h2>
              {ids.length > 0 && (
                <button className="text-button module-action" onClick={() => setChecked(ids, !allSelected)}>
                  {allSelected ? "Select none" : "Select all"}
                </button>
              )}
            </div>
            <ul className="concepts status-rows">
              {module.concepts.map((concept) => (
                <ConceptRow
                  key={concept.slug}
                  concept={concept}
                  themeSlug={map.theme.slug}
                  open={open.has(concept.slug)}
                  selected={selected.has(concept.id)}
                  showGoal={showGoals}
                  onToggle={() => toggle(concept.slug)}
                  onSelect={(checked) => setChecked([concept.id], checked)}
                  onRead={setSection}
                  onStatus={(status) => updateConcept(concept.id, { status })}
                  onStar={(starred) => updateConcept(concept.id, { starred })}
                />
              ))}
            </ul>
          </section>
        );
      })}

      {selected.size > 0 && (
        <SelectionBar
          themeSlug={map.theme.slug}
          ids={[...selected]}
          onDone={(ids, status) => {
            updateConcepts(ids, { status });
            setSelected(new Set());
          }}
          onClear={() => setSelected(new Set())}
        />
      )}

      {section !== null && <SectionPanel sectionId={section} onClose={() => setSection(null)} />}
    </>
  );
}

// The bar at the bottom of the page acts on all selected concepts, from all modules.
function SelectionBar(props: { themeSlug: string; ids: number[]; onDone: (ids: number[], status: Status) => void; onClear: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = props.ids.length;

  const apply = async (mark: "test" | "learn" | "skip") => {
    setBusy(true);
    setError(null);
    try {
      const result = await sendMarks(props.themeSlug, props.ids, mark);
      if (result.sessionId !== null) {
        window.location.hash = href.session(result.sessionId);
        return;
      }
      props.onDone(props.ids, mark === "learn" ? "queued" : "skipped");
    } catch (problem) {
      setError((problem as Error).message);
    }
    setBusy(false);
  };

  return (
    <div className="action-bar" role="region" aria-label="Actions for the selected concepts">
      <span className="selection-count">
        <span>
          {count} {count === 1 ? "concept" : "concepts"} selected
        </span>
        <button className="text-button" onClick={props.onClear} disabled={busy}>
          Select none
        </button>
      </span>
      <span className="selection-buttons">
        <button className="button secondary" onClick={() => apply("skip")} disabled={busy}>
          Skip
        </button>
        <button className="button secondary" onClick={() => apply("learn")} disabled={busy}>
          Add to the queue
        </button>
        <button className="button" onClick={() => apply("test")} disabled={busy} title="Answer 2 questions about each concept">
          Test {count === 1 ? "it" : "them"}
        </button>
      </span>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ConceptRow(props: {
  concept: ConceptView;
  themeSlug: string;
  open: boolean;
  selected: boolean;
  onToggle: () => void;
  onSelect: (checked: boolean) => void;
  onRead: (sectionId: number) => void;
  onStatus: (status: Status) => void;
  onStar: (starred: boolean) => void;
  showGoal: boolean;
}) {
  const { concept, open } = props;
  const detailsId = `details-${concept.slug}`;
  const actions = useConceptActions(concept, props.themeSlug, props.onStatus);
  return (
    <li className={`concept status-${concept.status}${props.selected ? " selected" : ""}`} id={`concept-${concept.slug}`}>
      <div className="margin">
        <StatusMark status={concept.status} />
      </div>
      <div className="concept-body">
        <div className="concept-top">
          <div className="concept-head">
            {selectable(concept) ? (
              <label className="select-box">
                <input type="checkbox" checked={props.selected} onChange={(event) => props.onSelect(event.target.checked)} />
                <span className="visually-hidden">Select {concept.name}</span>
              </label>
            ) : (
              <span className="select-box" aria-hidden="true" />
            )}
            <button className="concept-name" aria-expanded={open} aria-controls={detailsId} onClick={props.onToggle}>
              {concept.name}
            </button>
            <StarButton conceptId={concept.id} name={concept.name} starred={concept.starred} onChange={props.onStar} />
            <span className="concept-meta">
              {LEVEL[concept.level]} {KIND[concept.kind]}
            </span>
            {concept.status !== "new" && <span className={`tag tag-${concept.status}`}>{STATUS_INFO[concept.status].label}</span>}
            {concept.status === "skipped" && (
              <button
                className="text-button"
                onClick={() => actions.mark("later", "new")}
                disabled={actions.busy}
                aria-label={`Undo the skip of ${concept.name}`}
                title="Set the concept back to not chosen"
              >
                Undo
              </button>
            )}
          </div>
          <ConceptActions concept={concept} actions={actions} />
        </div>
        {(props.showGoal || open) && <p className="objective">{concept.objective}</p>}
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

// The actions on one concept. The buttons of the concept stay disabled while an action runs.
function useConceptActions(concept: ConceptView, themeSlug: string, onStatus: (status: Status) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // An action that opens a different page keeps the buttons disabled until the page changes.
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
  // "later" sets a skipped concept back to not chosen.
  const mark = (value: "learn" | "skip" | "later", status: Status) =>
    run(async () => {
      await sendMarks(themeSlug, [concept.id], value);
      onStatus(status);
      return null;
    });
  const testIt = () =>
    run(async () => {
      const { sessionId } = await postJson<{ sessionId: number }>(`/api/concepts/${concept.id}/test`);
      return href.session(sessionId);
    });
  return { busy, error, learnNow, mark, testIt };
}

// The buttons of one concept. A concept with a lesson opens the lesson. Other concepts can go into the study queue,
// get a test, or get skipped.
function ConceptActions({ concept, actions }: { concept: ConceptView; actions: ReturnType<typeof useConceptActions> }) {
  const { busy, error, learnNow, mark, testIt } = actions;
  return (
    <div className="concept-actions">
      <div className="chips" role="group" aria-label={`Actions for ${concept.name}`}>
        {concept.status === "learning" || concept.status === "mastered" ? (
          <a className="chip" href={href.lesson(concept.id)}>
            <PlayIcon />
            {concept.status === "learning" ? "Continue the lesson" : "Open the lesson"}
          </a>
        ) : (
          <>
            <button className="chip" onClick={learnNow} disabled={busy}>
              <PlayIcon />
              Learn now
            </button>
            {concept.status !== "queued" && (
              <button className="chip" onClick={() => mark("learn", "queued")} disabled={busy} title="Add the concept to the end of your study queue">
                <span className="chip-icon" aria-hidden="true">
                  +
                </span>
                Add to the queue
              </button>
            )}
            {concept.status !== "queued" && (
              <button className="chip" onClick={testIt} disabled={busy} title="Answer 2 questions about the concept">
                <span className="chip-icon" aria-hidden="true">
                  ?
                </span>
                Test it
              </button>
            )}
            {concept.status !== "skipped" && (
              <button className="chip" onClick={() => mark("skip", "skipped")} disabled={busy} title="You do not want to learn the concept">
                Skip
              </button>
            )}
          </>
        )}
      </div>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function PlayIcon() {
  return (
    <svg className="chip-icon" viewBox="0 0 10 10" width="0.6em" height="0.6em" aria-hidden="true">
      <path d="M2 1 9 5 2 9Z" fill="currentColor" />
    </svg>
  );
}
