import { useEffect, useMemo, useState } from "react";
import type { ConceptMapView, ConceptView } from "../../server/api-types";
import { useApi } from "../api";
import { Layout, Notice } from "../components/Layout";
import { SectionPanel } from "../components/SectionPanel";
import { StatusMark } from "../components/StatusMark";
import { href } from "../router";

const LEVEL: Record<ConceptView["level"], string> = { basic: "Basic", intermediate: "Intermediate", advanced: "Advanced" };
const KIND: Record<ConceptView["kind"], string> = { knowledge: "knowledge", skill: "skill" };

export function ConceptMap({ slug, focus }: { slug: string; focus: string | null }) {
  const map = useApi<ConceptMapView>(`/api/themes/${encodeURIComponent(slug)}/map`);
  const name = map.state === "ready" ? map.data.theme.name : slug;
  return (
    <Layout crumbs={[{ label: "Themes", href: href.home() }, { label: name, href: href.theme(slug) }, { label: "Concept map" }]}>
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

function MapView({ map, focus }: { map: ConceptMapView; focus: string | null }) {
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
        {map.modules.length} modules and {total} concepts from the books of {map.theme.name}. Open a concept to see its sources.
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
          <h2 id={`module-${module.id}`}>
            <span className="module-number">{module.position}.</span> {module.name}
          </h2>
          <ul className="concepts">
            {module.concepts.map((concept) => (
              <ConceptRow
                key={concept.slug}
                concept={concept}
                themeSlug={map.theme.slug}
                open={open.has(concept.slug)}
                onToggle={() => toggle(concept.slug)}
                onRead={setSection}
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
  themeSlug: string;
  open: boolean;
  onToggle: () => void;
  onRead: (sectionId: number) => void;
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
          </span>
        </div>
        <p className="objective">{concept.objective}</p>
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
