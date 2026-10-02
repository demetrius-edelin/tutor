import { useEffect, useState } from "react";

export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(body?.error ?? `The server answered ${response.status}.`);
  return body as T;
}

export type Loadable<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: T };

// Load JSON from the API. A new URL loads again.
export function useApi<T>(url: string | null): Loadable<T> {
  const [result, setResult] = useState<Loadable<T>>({ state: "loading" });
  useEffect(() => {
    if (!url) return;
    let active = true;
    setResult({ state: "loading" });
    getJson<T>(url)
      .then((data) => active && setResult({ state: "ready", data }))
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof TypeError ? "The tutor server does not answer. Start it with npm start." : String((error as Error).message);
        setResult({ state: "error", message });
      });
    return () => {
      active = false;
    };
  }, [url]);
  return result;
}
