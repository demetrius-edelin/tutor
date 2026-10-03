import { useEffect, useState } from "react";

// A small hash router: "#/", "#/themes/sql", "#/themes/sql/map?concept=b-tree-index".

// The status filters of the review board. "all" is the default, so the address does not show it.
export const BOARD_SHOWS = ["all", "learned", "learning", "queued", "not-chosen", "skipped"] as const;
export type BoardShow = (typeof BOARD_SHOWS)[number];

// The filters of the review board. The address keeps them, so a link or a bookmark opens the same list.
export interface BoardFilters {
  show: BoardShow;
  starred: boolean;
  find: string;
}

export type Route =
  | { name: "home" }
  | { name: "theme"; slug: string }
  | { name: "map"; slug: string; concept: string | null }
  | { name: "select"; slug: string; moduleId: number }
  | { name: "queue"; slug: string }
  | ({ name: "board"; slug: string } & BoardFilters)
  | { name: "lesson"; conceptId: number }
  | { name: "session"; id: number }
  | { name: "not-found" };

export function parseHash(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#/, "").split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { name: "home" };
  if (parts[0] === "themes" && parts[1] && parts.length === 2) return { name: "theme", slug: parts[1] };
  if (parts[0] === "themes" && parts[1] && parts[2] === "map" && parts.length === 3) {
    return { name: "map", slug: parts[1], concept: new URLSearchParams(query).get("concept") };
  }
  if (parts[0] === "themes" && parts[1] && parts[2] === "queue" && parts.length === 3) return { name: "queue", slug: parts[1] };
  if (parts[0] === "themes" && parts[1] && parts[2] === "board" && parts.length === 3) {
    const params = new URLSearchParams(query);
    const show = params.get("show");
    return {
      name: "board",
      slug: parts[1],
      show: BOARD_SHOWS.find((value) => value === show) ?? "all",
      starred: params.get("starred") === "1",
      find: params.get("find") ?? "",
    };
  }
  if (parts[0] === "themes" && parts[1] && parts[2] === "modules" && parts[3] && parts.length === 4) {
    return { name: "select", slug: parts[1], moduleId: Number(parts[3]) };
  }
  if (parts[0] === "sessions" && parts[1] && parts.length === 2) return { name: "session", id: Number(parts[1]) };
  if (parts[0] === "lessons" && parts[1] && parts.length === 2) return { name: "lesson", conceptId: Number(parts[1]) };
  return { name: "not-found" };
}

export const href = {
  home: () => "#/",
  theme: (slug: string) => `#/themes/${encodeURIComponent(slug)}`,
  map: (slug: string, concept?: string) =>
    `#/themes/${encodeURIComponent(slug)}/map${concept ? `?concept=${encodeURIComponent(concept)}` : ""}`,
  select: (slug: string, moduleId: number) => `#/themes/${encodeURIComponent(slug)}/modules/${moduleId}`,
  queue: (slug: string) => `#/themes/${encodeURIComponent(slug)}/queue`,
  board: (slug: string, filters: Partial<BoardFilters> = {}) => {
    const params = new URLSearchParams();
    if (filters.show && filters.show !== "all") params.set("show", filters.show);
    if (filters.starred) params.set("starred", "1");
    // The search text stays as the user types it, with its spaces.
    if (filters.find) params.set("find", filters.find);
    const query = params.toString();
    return `#/themes/${encodeURIComponent(slug)}/board${query ? `?${query}` : ""}`;
  },
  session: (id: number) => `#/sessions/${id}`,
  lesson: (conceptId: number) => `#/lessons/${conceptId}`,
};

// The event after replaceHash. The browser sends no "hashchange" event after history.replaceState.
const REPLACE_EVENT = "tutor:replacehash";

// Change the address with no new entry in the history of the browser, for example for the filters of a page.
export function replaceHash(hash: string): void {
  window.history.replaceState(null, "", hash);
  window.dispatchEvent(new Event(REPLACE_EVENT));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const update = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", update);
    window.addEventListener(REPLACE_EVENT, update);
    return () => {
      window.removeEventListener("hashchange", update);
      window.removeEventListener(REPLACE_EVENT, update);
    };
  }, []);
  return route;
}
