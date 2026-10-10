export const USER_AGENT = "tutor-fetch";

// The answer of a site to one request. The url is the address after the redirects.
export interface FetchResult {
  url: string;
  status: number;
  contentType: string;
  body: Uint8Array;
}

// Get one address. The tests use a fake fetcher with pages in the test code.
export type Fetcher = (url: string) => Promise<FetchResult>;

const TIMEOUT_MS = 30_000;

export const httpFetcher: Fetcher = async (url) => {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return {
    url: response.url || url,
    status: response.status,
    contentType: (response.headers.get("content-type") ?? "").toLowerCase(),
    body: new Uint8Array(await response.arrayBuffer()),
  };
};

export function bodyText(result: FetchResult): string {
  return new TextDecoder().decode(result.body);
}

interface RobotsRule {
  allow: boolean;
  pattern: string;
}

// The rules of robots.txt for this user agent. A group for "tutor-fetch" replaces the group for "*".
export function robotsRules(text: string): RobotsRule[] {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((field === "allow" || field === "disallow") && current) {
      // An empty Disallow line allows all paths.
      if (value) current.rules.push({ allow: field === "allow", pattern: value });
    }
  }
  const own = groups.filter((group) => group.agents.includes(USER_AGENT));
  const chosen = own.length > 0 ? own : groups.filter((group) => group.agents.includes("*"));
  return chosen.flatMap((group) => group.rules);
}

function ruleMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path);
}

// The longest rule that matches the path wins. If an Allow rule and a Disallow rule have the same length, Allow wins.
export function robotsAllow(rules: RobotsRule[], path: string): boolean {
  let best: RobotsRule | null = null;
  for (const rule of rules) {
    if (!ruleMatches(rule.pattern, path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
  }
  return best?.allow ?? true;
}

export class RobotsError extends Error {
  override name = "RobotsError";
}

export interface DownloaderOptions {
  // The pause between two requests.
  pauseMs?: number;
  log?: (line: string) => void;
}

// Get pages one at a time, with a pause between the requests. Obey robots.txt, and try a failed request one more time.
export class Downloader {
  private readonly pauseMs: number;
  private readonly robots = new Map<string, RobotsRule[]>();
  private last = 0;
  requests = 0;

  constructor(
    private readonly fetcher: Fetcher,
    options: DownloaderOptions = {},
  ) {
    this.pauseMs = options.pauseMs ?? 1000;
  }

  get pause(): number {
    return this.pauseMs;
  }

  // The answer for the address. A RobotsError means that robots.txt disallows the address.
  async get(url: string): Promise<FetchResult> {
    const address = new URL(url);
    if (!robotsAllow(await this.robotsFor(address.origin), address.pathname + address.search)) {
      throw new RobotsError(`robots.txt disallows ${url}`);
    }
    return this.request(url);
  }

  private async robotsFor(origin: string): Promise<RobotsRule[]> {
    let rules = this.robots.get(origin);
    if (!rules) {
      try {
        const result = await this.request(`${origin}/robots.txt`);
        const text = bodyText(result);
        rules = result.status === 200 && !/^\s*</.test(text) ? robotsRules(text) : [];
      } catch {
        rules = [];
      }
      this.robots.set(origin, rules);
    }
    return rules;
  }

  private async request(url: string): Promise<FetchResult> {
    for (let attempt = 1; ; attempt++) {
      const wait = this.last + this.pauseMs - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.last = Date.now();
      this.requests++;
      try {
        const result = await this.fetcher(url);
        const retry = result.status === 429 || result.status >= 500;
        if (!retry || attempt === 2) return result;
      } catch (error) {
        if (attempt === 2) throw error;
      } finally {
        this.last = Date.now();
      }
    }
  }
}
