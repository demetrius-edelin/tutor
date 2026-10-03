import { useMemo, useState } from "react";
import type { ConceptMapView, ConceptView, Mark, SelectionResult } from "../../server/api-types";
import { postJson, useApi } from "../api";
import { Layout, Notice } from "../components/Layout";
import { StatusMark, STATUS_INFO } from "../components/StatusMark";
import { href } from "../router";

const MARKS: { value: Mark; label: string }[] = [
  { value: "test", label: "Test" },
  { value: "learn", label: "Learn" },
  { value: "skip", label: "Skip" },
  { value: "later", label: "Later" },
];

// These concepts have no mark yet. A failed concept counts too: the learner decides again.
const UNMARKED = new Set(["new", "to_test", "failed"]);

export function Select({ slug, moduleId }: { slug: string; moduleId: number }) {
  const map = useApi<ConceptMapView>(`/api/themes/${encodeURIComponent(slug)}/map`);
  const module = map.state === "ready" ? map.data.modules.find((item) => item.id === moduleId) : undefined;
  const name = map.state === "ready" ? map.data.theme.name : slug;
  return (
    <Layout theme={{ slug, name }} tab="map">
      {map.state === "loading" && <p className="quiet">Loading the module.</p>}
      {map.state === "error" && <Notice title="The module did not load">{<p>{map.message}</p>}</Notice>}
      {map.state === "ready" && !module && <Notice title="This module does not exist" />}
      {map.state === "ready" && module && <SelectView slug={slug} moduleId={moduleId} moduleName={module.name} position={module.position} concepts={module.concepts} />}
    </Layout>
  );
}

function MarkControl(props: { label: string; value: Mark | undefined; onChange: (mark: Mark) => void; name: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={props.label}>
      {MARKS.map((mark) => (
        <label key={mark.value} className={props.value === mark.value ? "selected" : ""}>
          <input type="radio" name={props.name} value={mark.value} checked={props.value === mark.value} onChange={() => props.onChange(mark.value)} />
          {mark.label}
        </label>
      ))}
    </div>
  );
}

function SelectView(props: { slug: string; moduleId: number; moduleName: string; position: number; concepts: ConceptView[] }) {
  const unmarked = useMemo(() => props.concepts.filter((concept) => UNMARKED.has(concept.status)), [props.concepts]);
  const marked = props.concepts.filter((concept) => !UNMARKED.has(concept.status));
  // A concept without an entry keeps its status. An unmarked concept shows "Later" until the learner picks a mark.
  const [marks, setMarks] = useState<Record<number, Mark>>({});
  const [changing, setChanging] = useState<Set<number>>(new Set());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setMark = (id: number, mark: Mark) => setMarks((current) => ({ ...current, [id]: mark }));
  const keep = (id: number) => {
    setMarks(({ [id]: _removed, ...rest }) => rest);
    setChanging((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };

  // "Later" on an unmarked concept changes nothing, so it is not sent.
  const changes = Object.fromEntries(
    Object.entries(marks).filter(([id, mark]) => !(mark === "later" && unmarked.some((concept) => concept.id === Number(id)))),
  ) as Record<string, Mark>;
  const counts = { test: 0, learn: 0, skip: 0, later: 0 };
  for (const mark of Object.values(changes)) counts[mark]++;
  const total = Object.keys(changes).length;

  const submit = async () => {
    setSending(true);
    setError(null);
    try {
      const result = await postJson<SelectionResult>(`/api/modules/${props.moduleId}/selection`, { marks: changes });
      window.location.hash = result.sessionId !== null ? href.session(result.sessionId) : href.map(props.slug);
    } catch (problem) {
      setError((problem as Error).message);
      setSending(false);
    }
  };

  const summary = [
    counts.test > 0 && `${counts.test} to test`,
    counts.learn > 0 && `${counts.learn} to learn`,
    counts.skip > 0 && `${counts.skip} to skip`,
    counts.later > 0 && `${counts.later} for later`,
  ].filter(Boolean);

  return (
    <>
      <h1>Choose what to test</h1>
      <p className="lead">
        Module {props.position}, {props.moduleName}. Mark the concepts that you want to work on now. The tutor asks 2 questions about each
        concept that you mark Test. Learn puts a concept in your study queue without a test. Later keeps a concept for another day.
      </p>

      {unmarked.length > 0 && (
        <section aria-labelledby="unmarked-heading">
          <h2 id="unmarked-heading">Not marked yet</h2>
          <p className="bulk">
            Mark all as{" "}
            {MARKS.map((mark, i) => (
              <span key={mark.value}>
                {i > 0 && ", "}
                <button
                  className="text-button"
                  onClick={() => setMarks((current) => ({ ...current, ...Object.fromEntries(unmarked.map((concept) => [concept.id, mark.value])) }))}
                >
                  {mark.label}
                </button>
              </span>
            ))}
          </p>
          <ul className="concepts">
            {unmarked.map((concept) => (
              <li key={concept.id} className="concept concept-select">
                <div className="margin">
                  <StatusMark status={concept.status} />
                </div>
                <div className="concept-body">
                  <div className="concept-head">
                    <span className="concept-title">{concept.name}</span>
                    {concept.status === "failed" && <span className="concept-meta">Failed in a diagnosis</span>}
                  </div>
                  <p className="objective">{concept.objective}</p>
                </div>
                <MarkControl
                  label={`Mark for ${concept.name}`}
                  name={`mark-${concept.id}`}
                  value={marks[concept.id] ?? "later"}
                  onChange={(mark) => setMark(concept.id, mark)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {marked.length > 0 && (
        <section aria-labelledby="marked-heading">
          <h2 id="marked-heading">Marked already</h2>
          <p className="bulk">To change a mark, use Change. Later sets the concept back to not started.</p>
          <ul className="concepts">
            {marked.map((concept) => (
              <li key={concept.id} className="concept concept-select">
                <div className="margin">
                  <StatusMark status={concept.status} />
                </div>
                <div className="concept-body">
                  <div className="concept-head">
                    <span className="concept-title">{concept.name}</span>
                    <span className="concept-meta">{STATUS_INFO[concept.status].label}</span>
                  </div>
                  <p className="objective">{concept.objective}</p>
                </div>
                {changing.has(concept.id) ? (
                  <div className="change">
                    <MarkControl
                      label={`New mark for ${concept.name}`}
                      name={`mark-${concept.id}`}
                      value={marks[concept.id]}
                      onChange={(mark) => setMark(concept.id, mark)}
                    />
                    <button className="text-button" onClick={() => keep(concept.id)}>
                      Keep as it is
                    </button>
                  </div>
                ) : (
                  <button className="text-button" onClick={() => setChanging((current) => new Set(current).add(concept.id))}>
                    Change
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="action-bar">
        <span className="quiet">{summary.length > 0 ? summary.join(", ") : "No marks yet"}</span>
        <button className="button" onClick={submit} disabled={sending || total === 0}>
          {sending ? "Starting" : counts.test > 0 ? "Start the test" : "Save the marks"}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
