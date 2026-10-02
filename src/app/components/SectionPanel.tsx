import { useEffect, useRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SectionView } from "../../server/api-types";
import { useApi } from "../api";

// A panel at the side of the page with the text of one book section.
export function SectionPanel({ sectionId, onClose }: { sectionId: number; onClose: () => void }) {
  const section = useApi<SectionView>(`/api/sections/${sectionId}`);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="panel-backdrop" onClick={onClose}>
      <aside
        className="panel"
        role="dialog"
        aria-modal="true"
        aria-label="Book section"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="panel-head">
          {section.state === "ready" ? (
            <p className="panel-source">
              {section.data.book}, {section.data.chapterTitle}
              {section.data.page ? `, page ${section.data.page}` : ""}
            </p>
          ) : (
            <p className="panel-source">Book section</p>
          )}
          <button ref={closeButton} className="text-button" onClick={onClose}>
            Close
          </button>
        </div>
        {section.state === "loading" && <p className="quiet">Loading the section.</p>}
        {section.state === "error" && <p>{section.message}</p>}
        {section.state === "ready" && (
          <article className="reading">
            <Markdown remarkPlugins={[remarkGfm]}>{section.data.markdown}</Markdown>
          </article>
        )}
      </aside>
    </div>
  );
}
