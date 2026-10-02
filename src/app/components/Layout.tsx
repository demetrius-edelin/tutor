import type { ReactNode } from "react";
import { href } from "../router";

export interface Crumb {
  label: string;
  href?: string;
}

export function Layout({ crumbs, children }: { crumbs: Crumb[]; children: ReactNode }) {
  return (
    <div className="shell">
      <header className="topbar">
        <a className="wordmark" href={href.home()}>
          Tutor
        </a>
        {crumbs.length > 0 && (
          <nav aria-label="Location">
            <ol className="crumbs">
              {crumbs.map((crumb, i) => (
                <li key={`${crumb.label}-${i}`}>
                  {crumb.href ? <a href={crumb.href}>{crumb.label}</a> : <span aria-current="page">{crumb.label}</span>}
                </li>
              ))}
            </ol>
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
