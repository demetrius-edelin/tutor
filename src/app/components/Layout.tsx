import { useId, useRef, type ReactNode } from "react";
import type { SubjectSummary } from "../../server/api-types";
import { useApi } from "../api";
import { href, useRoute, type Route } from "../router";
import { knownShare } from "./Progress";

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
            <SubjectSwitch subject={subject} route={route} />
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

// The same tab in another subject. A lesson or a test has no page in another subject, so the link opens the overview.
// The link does not keep the filters of the page, because a concept or a module belongs to one subject.
function sameTab(route: Route, slug: string): string {
  return TABS.find((item) => item.tab === route.name)?.href(slug) ?? href.subject(slug);
}

// The name of the subject opens a menu with all subjects and their progress.
function SubjectSwitch({ subject, route }: { subject: { slug: string; name: string }; route: Route }) {
  const subjects = useApi<SubjectSummary[]>("/api/subjects");
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  // A switch to the same tab keeps the same screen on the page, and the menu stays open. Thus each link closes the menu.
  const close = () => menu.current?.hidePopover();
  return (
    <div className="subject-switch">
      <button type="button" popoverTarget={menuId} aria-label={`${subject.name}, switch subject`} title="Switch subject">
        {subject.name}
        <svg className="chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div ref={menu} id={menuId} className="subject-menu" popover="auto">
        {subjects.state === "loading" && <p className="subject-menu-note">Loading the subjects.</p>}
        {subjects.state === "error" && <p className="subject-menu-note">{subjects.message}</p>}
        {subjects.state === "ready" && (
          <ul>
            {subjects.data.map((item) => {
              const { done, total } = knownShare(item.progress);
              return (
                <li key={item.slug}>
                  <a href={sameTab(route, item.slug)} aria-current={item.slug === subject.slug ? "true" : undefined} onClick={close}>
                    <span>{item.name}</span>
                    <span className="subject-menu-figure">
                      {done} of {total}
                      <span className="visually-hidden"> concepts known</span>
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
        <a className="subject-menu-all" href={href.home()} onClick={close}>
          All subjects
        </a>
      </div>
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
