import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useState } from "react";
import type { QueueItem, QueueView } from "../../server/api-types";
import { postJson, useApi } from "../api";
import { Layout, Notice } from "../components/Layout";
import { href } from "../router";

const LEVEL: Record<QueueItem["level"], string> = { basic: "Basic", intermediate: "Intermediate", advanced: "Advanced" };

export function Queue({ slug }: { slug: string }) {
  const loaded = useApi<QueueView>(`/api/themes/${encodeURIComponent(slug)}/queue`);
  const name = loaded.state === "ready" ? loaded.data.theme.name : slug;
  return (
    <Layout crumbs={[{ label: "Themes", href: href.home() }, { label: name, href: href.theme(slug) }, { label: "Study queue" }]}>
      {loaded.state === "loading" && <p className="quiet">Loading the study queue.</p>}
      {loaded.state === "error" && <Notice title="The study queue did not load">{<p>{loaded.message}</p>}</Notice>}
      {loaded.state === "ready" && <QueueEditor slug={slug} initial={loaded.data} />}
    </Layout>
  );
}

function QueueEditor({ slug, initial }: { slug: string; initial: QueueView }) {
  const [queue, setQueue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setQueue(initial), [initial]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Show the new order at once, then save it. If the save fails, show the order of the server again.
  const save = async (url: string, body: unknown, optimistic?: QueueItem[]) => {
    const before = queue;
    if (optimistic) setQueue({ ...queue, items: optimistic.map((item, i) => ({ ...item, position: i + 1 })) });
    setBusy(true);
    setError(null);
    try {
      setQueue(await postJson<QueueView>(url, body));
    } catch (problem) {
      setQueue(before);
      setError((problem as Error).message);
    }
    setBusy(false);
  };

  const order = (items: QueueItem[]) =>
    save(`/api/themes/${encodeURIComponent(slug)}/queue/order`, { conceptIds: items.map((item) => item.conceptId) }, items);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= queue.items.length || from === to) return;
    void order(arrayMove(queue.items, from, to));
  };

  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return;
    const from = queue.items.findIndex((item) => item.conceptId === event.active.id);
    const to = queue.items.findIndex((item) => item.conceptId === event.over!.id);
    move(from, to);
  };

  const startNow = async (item: QueueItem) => {
    setBusy(true);
    try {
      await postJson(`/api/concepts/${item.conceptId}/top`);
      window.location.hash = href.lesson(item.conceptId);
    } catch (problem) {
      setError((problem as Error).message);
      setBusy(false);
    }
  };

  const remove = (item: QueueItem, status: "skipped" | "new") =>
    save(`/api/themes/${encodeURIComponent(slug)}/queue/remove`, { conceptId: item.conceptId, status }, queue.items.filter((other) => other !== item));

  if (queue.items.length === 0) {
    return (
      <Notice title="Your study queue is empty">
        <p>
          To add concepts, open a module on the <a href={href.map(slug)}>concept map</a> and use Choose what to test. Mark a concept Learn,
          or choose Learn after a diagnosis.
        </p>
      </Notice>
    );
  }

  return (
    <>
      <h1>Study queue</h1>
      <p className="lead">
        {queue.items.length} {queue.items.length === 1 ? "concept" : "concepts"} to learn. The tutor teaches them in this order. Drag a
        concept to change the order, or use the buttons.
      </p>

      {queue.suggestionDiffers && (
        <div className="suggestion">
          <p>The tutor suggests a different order: prerequisites first, then the module order, then from basic to advanced.</p>
          <button
            className="button"
            disabled={busy}
            onClick={() => save(`/api/themes/${encodeURIComponent(slug)}/queue/suggested`, {})}
          >
            Use the suggested order
          </button>
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={queue.items.map((item) => item.conceptId)} strategy={verticalListSortingStrategy}>
          <ol className="concepts queue">
            {queue.items.map((item, i) => (
              <QueueRow
                key={item.conceptId}
                item={item}
                slug={slug}
                first={i === 0}
                last={i === queue.items.length - 1}
                busy={busy}
                onTop={() => move(i, 0)}
                onUp={() => move(i, i - 1)}
                onDown={() => move(i, i + 1)}
                onSkip={() => remove(item, "skipped")}
                onLater={() => remove(item, "new")}
                onStart={() => startNow(item)}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
    </>
  );
}

function QueueRow(props: {
  item: QueueItem;
  slug: string;
  first: boolean;
  last: boolean;
  busy: boolean;
  onTop: () => void;
  onUp: () => void;
  onDown: () => void;
  onSkip: () => void;
  onLater: () => void;
  onStart: () => void;
}) {
  const { item } = props;
  const sortable = useSortable({ id: item.conceptId });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  return (
    <li ref={sortable.setNodeRef} style={style} className={`concept queue-item${sortable.isDragging ? " dragging" : ""}${props.first ? " next" : ""}`}>
      <div className="margin">
        <span className="queue-number">{item.position}</span>
      </div>
      <div className="queue-row">
        <button className="drag-handle" aria-label={`Move ${item.name}. Use the arrow keys after you press Space.`} {...sortable.attributes} {...sortable.listeners}>
          ⠿
        </button>
        <div className="concept-body">
          <div className="concept-head">
            <a className="concept-title" href={href.map(props.slug, item.slug)}>
              {item.name}
            </a>
            <span className="concept-meta">
              {props.first ? "Next to learn. " : ""}
              {LEVEL[item.level]} {item.kind}, module {item.module.position}
            </span>
          </div>
          <p className="objective">{item.objective}</p>
          {item.warning && <p className="warning">{item.warning}</p>}
          <p className="row-actions">
            <button className="text-button strong" onClick={props.onStart} disabled={props.busy}>
              {props.first ? "Start the lesson" : "Start now"}
            </button>
            <button className="text-button" onClick={props.onTop} disabled={props.busy || props.first}>
              Top
            </button>
            <button className="text-button" onClick={props.onUp} disabled={props.busy || props.first}>
              Up
            </button>
            <button className="text-button" onClick={props.onDown} disabled={props.busy || props.last}>
              Down
            </button>
            <button className="text-button" onClick={props.onLater} disabled={props.busy}>
              Later
            </button>
            <button className="text-button" onClick={props.onSkip} disabled={props.busy}>
              Skip
            </button>
          </p>
        </div>
      </div>
    </li>
  );
}
