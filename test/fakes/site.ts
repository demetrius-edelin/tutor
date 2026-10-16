import type { Fetcher, FetchResult } from "../../src/ingest/web/http.js";

export type FakePage = string | { status?: number; contentType?: string; body: string | Uint8Array };

// A fake site. An address that is not in the map gives a 404 page.
export function fakeSite(pages: Record<string, FakePage>): Fetcher & { requested: string[] } {
  const requested: string[] = [];
  const fetcher = async (url: string): Promise<FetchResult> => {
    requested.push(url);
    const page = pages[url];
    if (page === undefined) return { url, status: 404, contentType: "text/html", body: new TextEncoder().encode("<html><body>Not found</body></html>") };
    const item = typeof page === "string" ? { body: page } : page;
    const body = typeof item.body === "string" ? new TextEncoder().encode(item.body) : item.body;
    return { url, status: item.status ?? 200, contentType: item.contentType ?? "text/html; charset=utf-8", body };
  };
  return Object.assign(fetcher, { requested });
}

export const html = (body: string, title = "Site") =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`;

// Text with different words, for example "value0 value1 value2".
export const prose = (topic: string, count: number) => Array.from({ length: count }, (_, i) => `${topic}${i}`).join(" ");
