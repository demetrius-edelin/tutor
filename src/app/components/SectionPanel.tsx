import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SectionView } from "../../server/api-types";
import { useApi } from "../api";
import { Drawer } from "./Drawer";

// A panel at the side of the page with the text of one book section.
// With onBack, the panel has a button that goes back to the list of references.
export function SectionPanel({ sectionId, quote, onClose, onBack }: { sectionId: number; quote?: string; onClose: () => void; onBack?: () => void }) {
  const section = useApi<SectionView>(`/api/sections/${sectionId}`);

  return (
    <Drawer
      label="Book section"
      title={
        section.state === "ready" ? (
          <>
            {section.data.book}, {section.data.chapterTitle}
            {section.data.page ? `, page ${section.data.page}` : ""}
          </>
        ) : (
          "Book section"
        )
      }
      actions={
        onBack && (
          <button className="text-button" onClick={onBack}>
            Back to the references
          </button>
        )
      }
      onClose={onClose}
    >
      {quote && (
        <blockquote className="quote panel-quote">
          <span>{quote}</span>
        </blockquote>
      )}
      {section.state === "loading" && <p className="quiet">Loading the section.</p>}
      {section.state === "error" && <p>{section.message}</p>}
      {section.state === "ready" && (
        <article className="reading">
          <Markdown remarkPlugins={[remarkGfm]}>{section.data.markdown}</Markdown>
        </article>
      )}
    </Drawer>
  );
}
