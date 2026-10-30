import { Fragment } from "react";
import { plainMath } from "../math";

// Text from the model, with code in backticks, for example "Use `*` to read a value".
// Show each code part in a code element. The other text stays plain, because a "*" or a "_" outside code is not Markdown.
// Code of more than one line is in a code block with three backticks. The block keeps its lines. It is a code element,
// not a pre element, so that it can be in a paragraph. Math in LaTeX becomes plain text.
export function InlineCode({ text }: { text: string }) {
  const blocks = plainMath(text, false).split(/```[^\n]*\n([\s\S]*?)\n?```/);
  return (
    <>
      {blocks.map((block, i) =>
        i % 2 === 1 ? (
          <code key={i} className="code-block">
            {block}
          </code>
        ) : (
          <Fragment key={i}>{block.split(/`([^`\n]+)`/).map((part, j) => (j % 2 === 1 ? <code key={j}>{part}</code> : part))}</Fragment>
        ),
      )}
    </>
  );
}
