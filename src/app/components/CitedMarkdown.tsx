import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { LessonReference } from "../../server/api-types";

// Change each reference marker " [2]" into a link "ref:2", outside of code.
export function linkReferences(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/ \[(\d+)\](?!\()/g, " [$1](ref:$1)")))
    .join("");
}

// Markdown with reference markers. A marker opens the book section of the reference.
export function CitedMarkdown(props: { text: string; references: LessonReference[]; onOpen: (reference: LessonReference) => void }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(url) => url}
      components={{
        a: ({ href, children }) => {
          if (href?.startsWith("ref:")) {
            const reference = props.references.find((item) => item.number === Number(href.slice(4)));
            if (!reference) return null;
            return (
              <button
                className="ref"
                onClick={() => props.onOpen(reference)}
                aria-label={`Reference ${reference.number}: ${reference.book}, section ${reference.ref}`}
                title={`${reference.book}, ${reference.ref} ${reference.title}`}
              >
                {reference.number}
              </button>
            );
          }
          // An external link opens in a new tab. The app uses the hash for its own pages.
          return (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          );
        },
      }}
    >
      {linkReferences(props.text)}
    </Markdown>
  );
}

export function ReferenceList(props: { references: LessonReference[]; onOpen: (reference: LessonReference) => void }) {
  if (props.references.length === 0) return null;
  return (
    <ol className="references">
      {props.references.map((reference) => (
        <li key={reference.number} value={reference.number}>
          <span className="source-ref">
            {reference.book}, section {reference.ref} {reference.title}
            {reference.page ? `, page ${reference.page}` : ""}
          </span>
          <blockquote className="quote">
            <span>{reference.quote}</span>
          </blockquote>
          <button className="text-button" onClick={() => props.onOpen(reference)}>
            Read the section
          </button>
        </li>
      ))}
    </ol>
  );
}
