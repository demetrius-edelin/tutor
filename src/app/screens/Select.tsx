import { useMemo, useState } from "react";
import type { ConceptMapView, ConceptView, Mark, SelectionResult, Status } from "../../server/api-types";
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

const LEVEL: Record<ConceptView["level"], string> = { basic: "Basic", intermediate: "Intermediate", advanced: "Advanced" };

// These concepts have no mark yet. A failed concept counts too: the learner decides again.
const UNMARKED = new Set<Status>(["new", "to_test", "failed"]);

// The choice that a concept has now. A concept without a choice shows "Later".
// A known or mastered concept has none of the four choices, so no choice is selected.
function currentMark(status: Status): Mark | undefined {
  if (UNMARKED.has(status)) return "later";
  if (status === "queued" || status === "learning") return "learn";
  if (status === "skipped") return "skip";
  return undefined;
}

export function Select({ slug, moduleId }: { slug: string; moduleId: number }) {
  const map = useApi<ConceptMapView>(`/api/themes/${encodeURIComponent(slug)}/map`);
  const module = map.state === "ready" ? map.data.modules.find((item) => item.id === moduleId) : undefined;
  const name = map.state === "ready" ? map.data.theme.name : slug;
  return (
    <Layout theme={{ slug, name }} tab="theme">
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
  // The choices that the learner picked on this page. A pick that is the same as the current choice is not a change.
  const [marks, setMarks] = useState<Record<number, Mark>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const statusOf = new Map(props.concepts.map((concept) => [concept.id, concept.status]));
  const changes = Object.fromEntries(
    Object.entries(marks).filter(([id, mark]) => mark !== currentMark(statusOf.get(Number(id))!)),
  ) as Record<string, Mark>;
  const counts = { test: 0, learn: 0, skip: 0, later: 0 };
  for (const mark of Object.values(changes)) counts[mark]++;
  const total = Object.keys(changes).length;

  const setMark = (id: number, mark: Mark) => setMarks((current) => ({ ...current, [id]: mark }));

  const submit = async () => {
    setSending(true);
    setError(null);
    try {
      const result = await postJson<SelectionResult>(`/api/modules/${props.moduleId}/selection`, { marks: changes });
      window.location.hash = result.sessionId !== null ? href.session(result.sessionId) : href.theme(props.slug);
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

  const row = (concept: ConceptView) => (
    <SelectRow
      key={concept.id}
      concept={concept}
      value={marks[concept.id] ?? currentMark(concept.status)}
      changed={concept.id in changes}
      onChange={(mark) => setMark(concept.id, mark)}
    />
  );

  return (
    <>
      <h1>Choose concepts</h1>
      <p className="lead">
        Module {props.position}, {props.moduleName}. Choose what to do with each concept. Test asks 2 questions about the concept. Learn puts the
        concept in your study queue without a test. Skip means that you do not want to learn it. Later keeps it for another day.
      </p>

      {unmarked.length > 0 && (
        <section aria-labelledby="unmarked-heading">
          <h2 id="unmarked-heading">Not chosen yet</h2>
          <p className="bulk">
            Choose for all:{" "}
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
          <ul className="concepts status-rows">{unmarked.map(row)}</ul>
        </section>
      )}

      {marked.length > 0 && (
        <section aria-labelledby="marked-heading">
          <h2 id="marked-heading">Chosen already</h2>
          <p className="bulk">To change a choice, select a different one. Later sets the concept back to not chosen.</p>
          <ul className="concepts status-rows">{marked.map(row)}</ul>
        </section>
      )}

      <div className="action-bar">
        <span className="quiet">{summary.length > 0 ? summary.join(", ") : "No changes yet"}</span>
        <button className="button" onClick={submit} disabled={sending || total === 0}>
          {sending ? "Starting" : counts.test > 0 ? "Start the test" : "Save the choices"}
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

// One concept with its status and its four choices. The row has the same look as a row of the concept map.
function SelectRow(props: { concept: ConceptView; value: Mark | undefined; changed: boolean; onChange: (mark: Mark) => void }) {
  const { concept } = props;
  return (
    <li className={`concept status-${concept.status}`}>
      <div className="margin">
        <StatusMark status={concept.status} />
      </div>
      <div className="concept-body">
        <div className="concept-top">
          <div className="concept-head">
            <span className="concept-title">{concept.name}</span>
            <span className="concept-meta">
              {LEVEL[concept.level]} {concept.kind}
            </span>
            {concept.status !== "new" && <span className={`tag tag-${concept.status}`}>{STATUS_INFO[concept.status].label}</span>}
            {props.changed && <span className="tag tag-unsaved">Not saved</span>}
          </div>
          <MarkControl label={`Choice for ${concept.name}`} name={`mark-${concept.id}`} value={props.value} onChange={props.onChange} />
        </div>
        <p className="objective">{concept.objective}</p>
      </div>
    </li>
  );
}
