import { useState } from "react";
import type { ConceptMapView, ConceptView, Status } from "../../server/api-types";
import { useApi } from "../api";
import { Layout, Notice } from "../components/Layout";
import { StarButton } from "../components/StarButton";
import { StatusMark } from "../components/StatusMark";
import { href, replaceHash, type BoardFilters, type BoardShow } from "../router";

// The review board: one short line for each concept, to see at a glance what the learner learned.
// The board uses the data of the concept map. The address keeps the filters.

const SHOWS: { value: BoardShow; label: string; statuses: Status[] | null }[] = [
  { value: "all", label: "All", statuses: null },
  { value: "learned", label: "Learned", statuses: ["known", "mastered"] },
  { value: "learning", label: "Learning", statuses: ["learning"] },
  { value: "queued", label: "In the queue", statuses: ["queued"] },
  { value: "not-chosen", label: "Not chosen", statuses: ["new", "to_test", "failed"] },
  { value: "skipped", label: "Skipped", statuses: ["skipped"] },
];

const LEARNED: Status[] = ["known", "mastered"];

export function Board({ slug, filters }: { slug: string; filters: BoardFilters }) {
  const map = useApi<ConceptMapView>(`/api/subjects/${encodeURIComponent(slug)}/map`);
  const name = map.state === "ready" ? map.data.subject.name : slug;
  return (
    <Layout subject={{ slug, name }} tab="board">
      {map.state === "loading" && <p className="quiet">Loading the review board.</p>}
      {map.state === "error" && <Notice title="The review board did not load">{<p>{map.message}</p>}</Notice>}
      {map.state === "ready" && <BoardView map={map.data} filters={filters} />}
    </Layout>
  );
}

const inShow = (concept: ConceptView, show: BoardShow) => {
  const statuses = SHOWS.find((item) => item.value === show)!.statuses;
  return statuses === null || statuses.includes(concept.status);
};

// The search looks only at the name, because the board shows only the name.
const matchesName = (concept: ConceptView, find: string) => {
  const name = concept.name.toLowerCase();
  return find
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => name.includes(word));
};

function BoardView({ map: loaded, filters }: { map: ConceptMapView; filters: BoardFilters }) {
  const [map, setMap] = useState(loaded);
  const concepts = map.modules.flatMap((module) => module.concepts);
  const setFilters = (change: Partial<BoardFilters>) => replaceHash(href.board(map.subject.slug, { ...filters, ...change }));

  const setStarred = (id: number, starred: boolean) =>
    setMap((current) => ({
      ...current,
      modules: current.modules.map((module) => ({
        ...module,
        concepts: module.concepts.map((concept) => (concept.id === id ? { ...concept, starred } : concept)),
      })),
    }));

  // The count of each filter tells how many concepts the board shows with that filter and the other filters.
  const found = concepts.filter((concept) => matchesName(concept, filters.find));
  const showCount = (show: BoardShow) => found.filter((concept) => (!filters.starred || concept.starred) && inShow(concept, show)).length;
  const starredCount = found.filter((concept) => concept.starred && inShow(concept, filters.show)).length;
  const visible = (concept: ConceptView) =>
    matchesName(concept, filters.find) && inShow(concept, filters.show) && (!filters.starred || concept.starred);

  const total = (statuses: Status[]) => concepts.filter((concept) => statuses.includes(concept.status)).length;
  const facts = [
    { count: total(LEARNED), label: "learned" },
    { count: total(["learning"]), label: "learning" },
    { count: total(["queued"]), label: "in the queue" },
    { count: total(["new", "to_test", "failed"]), label: "not chosen" },
    { count: total(["skipped"]), label: "skipped" },
    { count: concepts.filter((concept) => concept.starred).length, label: "starred" },
  ].filter((fact) => fact.count > 0);
  const modules = map.modules
    .map((module) => ({ ...module, shown: module.concepts.filter(visible) }))
    .filter((module) => module.shown.length > 0);

  return (
    <>
      <h1>Review board</h1>
      <p className="lead">
        The concepts of {map.subject.name}, at a glance. Star the important concepts, then filter the board to see your list of them.
      </p>
      <p className="queue-facts">
        {facts.map((fact) => (
          <span key={fact.label}>
            <strong>{fact.count}</strong> {fact.label}
          </span>
        ))}
      </p>

      <div className="board-filters">
        <div className="segmented" role="radiogroup" aria-label="Show the concepts">
          {SHOWS.map((item) => (
            <label key={item.value} className={filters.show === item.value ? "selected" : ""}>
              <input
                type="radio"
                name="board-show"
                value={item.value}
                checked={filters.show === item.value}
                onChange={() => setFilters({ show: item.value })}
              />
              {item.label} <span className="count">{showCount(item.value)}</span>
            </label>
          ))}
        </div>
        <button className="toggle" aria-pressed={filters.starred} onClick={() => setFilters({ starred: !filters.starred })}>
          <span className="toggle-star" aria-hidden="true">
            ★
          </span>
          Starred <span className="count">{starredCount}</span>
        </button>
      </div>
      <div className="search">
        <label htmlFor="board-find">Find a concept</label>
        <input
          id="board-find"
          type="search"
          value={filters.find}
          onChange={(event) => setFilters({ find: event.target.value })}
          placeholder="For example: index"
          autoComplete="off"
        />
      </div>

      {modules.length === 0 && <p className="quiet">No concept matches these filters.</p>}
      {modules.map((module) => {
        const counted = module.concepts.filter((concept) => concept.status !== "skipped").length;
        const learned = module.concepts.filter((concept) => LEARNED.includes(concept.status)).length;
        return (
          <section key={module.id} className="board-module" aria-labelledby={`board-module-${module.id}`}>
            <div className="module-head">
              <h2 id={`board-module-${module.id}`}>
                <span className="module-number">{module.position}.</span> {module.name}
              </h2>
              <span className="board-count">
                {learned} of {counted} learned
              </span>
            </div>
            <ul className="board-lines">
              {module.shown.map((concept) => (
                <li key={concept.id} className={`board-line status-${concept.status}`}>
                  <StatusMark status={concept.status} />
                  <a href={href.lesson(concept.id)}>{concept.name}</a>
                  <StarButton conceptId={concept.id} name={concept.name} starred={concept.starred} onChange={(starred) => setStarred(concept.id, starred)} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}
