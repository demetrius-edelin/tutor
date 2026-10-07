// Text from the model, with code in backticks, for example "Use `*` to read a value".
// Show each code part in a code element. The other text stays plain, because a "*" or a "_" outside code is not Markdown.
export function InlineCode({ text }: { text: string }) {
  const parts = text.split(/`([^`\n]+)`/);
  return <>{parts.map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part))}</>;
}
