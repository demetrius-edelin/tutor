import { useEffect, useRef, type ReactNode } from "react";

// A panel at the side of the page. The Escape key, the Close button, and a click outside the panel close it.
export function Drawer(props: { label: string; title: ReactNode; actions?: ReactNode; onClose: () => void; children: ReactNode }) {
  const { onClose } = props;
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="panel-backdrop" onClick={onClose}>
      <aside className="panel" role="dialog" aria-modal="true" aria-label={props.label} onClick={(event) => event.stopPropagation()}>
        <div className="panel-head">
          <p className="panel-source">{props.title}</p>
          <span className="panel-actions">
            {props.actions}
            <button ref={closeButton} className="text-button" onClick={onClose}>
              Close
            </button>
          </span>
        </div>
        {props.children}
      </aside>
    </div>
  );
}
