import type { ReactNode } from "react";
import { href, useRoute } from "../router";

export type SubjectTab = "subject" | "map" | "queue" | "board";

const TABS: { tab: SubjectTab; label: string; href: (slug: string) => string }[] = [
  { tab: "subject", label: "Overview", href: href.subject },
  { tab: "map", label: "Concept map", href: (slug) => href.map(slug) },
  { tab: "queue", label: "Study queue", href: href.queue },
  { tab: "board", label: "Review board", href: (slug) => href.board(slug) },
];

// A page in a subject shows the tabs of the subject. The tab of the page has a mark.
// A lesson or a test has the mark on the tab that it belongs to.
export function Layout({ subject, tab, children }: { subject?: { slug: string; name: string }; tab?: SubjectTab; children: ReactNode }) {
  const route = useRoute();
  return (
    <div className="shell">
      <header className="topbar">
        <a className="wordmark" href={href.home()} title="All subjects">
          Tutor
        </a>
        {subject && (
          <nav className="subject-nav" aria-label={`Subject ${subject.name}`}>
            <span className="subject-name">{subject.name}</span>
            <ul className="tabs">
              {TABS.map((item) => (
                <li key={item.tab}>
                  <a
                    href={item.href(subject.slug)}
                    className={item.tab === tab ? "active" : undefined}
                    aria-current={route.name === item.tab ? "page" : item.tab === tab ? "true" : undefined}
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </header>
      <main className="page">{children}</main>
    </div>
  );
}

export function Notice({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="notice">
      <h1>{title}</h1>
      {children}
    </div>
  );
}
