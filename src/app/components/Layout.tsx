import type { ReactNode } from "react";
import { href, useRoute } from "../router";

export type ThemeTab = "theme" | "map" | "queue" | "board";

const TABS: { tab: ThemeTab; label: string; href: (slug: string) => string }[] = [
  { tab: "theme", label: "Overview", href: href.theme },
  { tab: "map", label: "Concept map", href: (slug) => href.map(slug) },
  { tab: "queue", label: "Study queue", href: href.queue },
  { tab: "board", label: "Review board", href: (slug) => href.board(slug) },
];

// A page in a theme shows the tabs of the theme. The tab of the page has a mark.
// A lesson, a test, or a module page has the mark on the tab that it belongs to.
export function Layout({ theme, tab, children }: { theme?: { slug: string; name: string }; tab?: ThemeTab; children: ReactNode }) {
  const route = useRoute();
  return (
    <div className="shell">
      <header className="topbar">
        <a className="wordmark" href={href.home()} title="All themes">
          Tutor
        </a>
        {theme && (
          <nav className="theme-nav" aria-label={`Theme ${theme.name}`}>
            <span className="theme-name">{theme.name}</span>
            <ul className="tabs">
              {TABS.map((item) => (
                <li key={item.tab}>
                  <a
                    href={item.href(theme.slug)}
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
