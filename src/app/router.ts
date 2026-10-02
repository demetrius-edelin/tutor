import { useEffect, useState } from "react";

// A small hash router: "#/", "#/themes/sql", "#/themes/sql/map?concept=b-tree-index".

export type Route =
  | { name: "home" }
  | { name: "theme"; slug: string }
  | { name: "map"; slug: string; concept: string | null }
  | { name: "select"; slug: string; moduleId: number }
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
  if (parts[0] === "themes" && parts[1] && parts[2] === "modules" && parts[3] && parts.length === 4) {
    return { name: "select", slug: parts[1], moduleId: Number(parts[3]) };
  }
  if (parts[0] === "sessions" && parts[1] && parts.length === 2) return { name: "session", id: Number(parts[1]) };
  return { name: "not-found" };
}

export const href = {
  home: () => "#/",
  theme: (slug: string) => `#/themes/${encodeURIComponent(slug)}`,
  map: (slug: string, concept?: string) =>
    `#/themes/${encodeURIComponent(slug)}/map${concept ? `?concept=${encodeURIComponent(concept)}` : ""}`,
  select: (slug: string, moduleId: number) => `#/themes/${encodeURIComponent(slug)}/modules/${moduleId}`,
  session: (id: number) => `#/sessions/${id}`,
};

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const update = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return route;
}
