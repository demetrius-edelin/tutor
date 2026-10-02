import { useEffect, useState } from "react";

// A small hash router: "#/", "#/themes/sql", "#/themes/sql/map?concept=b-tree-index".

export type Route =
  | { name: "home" }
  | { name: "theme"; slug: string }
  | { name: "map"; slug: string; concept: string | null }
  | { name: "not-found" };

export function parseHash(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#/, "").split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { name: "home" };
  if (parts[0] === "themes" && parts[1] && parts.length === 2) return { name: "theme", slug: parts[1] };
  if (parts[0] === "themes" && parts[1] && parts[2] === "map" && parts.length === 3) {
    return { name: "map", slug: parts[1], concept: new URLSearchParams(query).get("concept") };
  }
  return { name: "not-found" };
}

export const href = {
  home: () => "#/",
  theme: (slug: string) => `#/themes/${encodeURIComponent(slug)}`,
  map: (slug: string, concept?: string) =>
    `#/themes/${encodeURIComponent(slug)}/map${concept ? `?concept=${encodeURIComponent(concept)}` : ""}`,
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
