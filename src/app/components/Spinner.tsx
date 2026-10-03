// A spinner shows that the model works. It takes the color of the text next to it.
// The text tells what the model does, so screen readers skip the spinner.
export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}
