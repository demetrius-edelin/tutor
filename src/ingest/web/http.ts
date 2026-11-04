// The name of the fetcher. A group for this name in robots.txt replaces all other groups.
export const USER_AGENT = "tutor-fetch";

// The answer of a site to one request. From Downloader.get, the url is the address after the redirects.
export interface FetchResult {
  url: string;
  status: number;
  contentType: string;
  body: Uint8Array;
  // The Location header of a redirect, or null.
  location?: string | null;
}

// Get one address. The tests use a fake fetcher with pages in the test code.
export type Fetcher = (url: string) => Promise<FetchResult>;

const TIMEOUT_MS = 30_000;

// One request, with no redirect. The Downloader follows the redirects, so that it checks robots.txt and pauses for
// each address. Node gives the status and the Location header of a redirect.
export const httpFetcher: Fetcher = async (url) => {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return {
    url,
    status: response.status,
    contentType: (response.headers.get("content-type") ?? "").toLowerCase(),
    body: new Uint8Array(await response.arrayBuffer()),
    location: response.headers.get("location"),
  };
};

// The most redirects for one address. RFC 9309 asks for at least five for robots.txt.
export const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

// The address without its fragment. A browser does not send the fragment, and the links of a page have none.
function withoutFragment(url: string): string {
  const address = new URL(url);
  address.hash = "";
  return address.href;
}

// The absolute http or https address of a redirect, without its fragment, or null if the answer is not a redirect.
function redirectTarget(result: FetchResult, from: string): string | null {
  if (!REDIRECTS.has(result.status) || !result.location) return null;
  try {
    const target = new URL(result.location, from);
    return target.protocol === "http:" || target.protocol === "https:" ? withoutFragment(target.href) : null;
  } catch {
    return null;
  }
}

export function bodyText(result: FetchResult): string {
  return new TextDecoder().decode(result.body);
}

interface RobotsRule {
  allow: boolean;
  pattern: string;
}

// The crawlers and fetchers of AI services. Many sites block them and allow all other agents. The tutor sends the text
// to an AI model, so these groups also apply to it. In the EU, such a block reserves the rights of the site against
// text and data mining.
const AI_AGENTS = [
  "gptbot",
  "chatgpt-user",
  "claudebot",
  "claude-user",
  "anthropic-ai",
  "google-extended",
  "ccbot",
  "perplexitybot",
  "perplexity-user",
  "applebot-extended",
  "meta-externalagent",
  "bytespider",
  "cohere-ai",
];

// The rules of robots.txt for the tutor, as sets of rules. A path must be allowed by each set. A group is some
// User-agent lines and then their rule lines. A rule line ends the list of agents, also a line with no rule, for example
// an empty Disallow line. A group for "tutor-fetch" is the only set. Else the sets are the group for "*" and each group
// for an AI agent.
export function robotsRules(text: string): RobotsRule[][] {
  const groups: { agents: string[]; rules: RobotsRule[]; closed: boolean }[] = [];
  let current: { agents: string[]; rules: RobotsRule[]; closed: boolean } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      if (!current || current.closed) {
        current = { agents: [], rules: [], closed: false };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((field === "allow" || field === "disallow") && current) {
      current.closed = true;
      // An empty Disallow line allows all paths.
      if (value) current.rules.push({ allow: field === "allow", pattern: value });
    }
  }
  const rulesOf = (agent: string) => groups.filter((group) => group.agents.includes(agent)).flatMap((group) => group.rules);
  if (groups.some((group) => group.agents.includes(USER_AGENT))) return [rulesOf(USER_AGENT)];
  return [rulesOf("*"), ...AI_AGENTS.map(rulesOf).filter((rules) => rules.length > 0)];
}

function ruleMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path);
}

// True if each set of rules allows the path. In a set, the longest rule that matches the path wins. If an Allow rule and
// a Disallow rule have the same length, Allow wins.
export function robotsAllow(sets: RobotsRule[][], path: string): boolean {
  return sets.every((rules) => {
    let best: RobotsRule | null = null;
    for (const rule of rules) {
      if (!ruleMatches(rule.pattern, path)) continue;
      if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
    }
    return best?.allow ?? true;
  });
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
// A redirect is one more request: its address gets the robots.txt check of its own site and the pause.
export class Downloader {
  private readonly pauseMs: number;
  private readonly robots = new Map<string, RobotsRule[][]>();
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

  // The answer for the address, after the redirects. Its url has no fragment. A RobotsError means that robots.txt
  // disallows the address or the address of a redirect.
  async get(url: string): Promise<FetchResult> {
    return this.follow(url, true);
  }

  private async follow(url: string, checkRobots: boolean): Promise<FetchResult> {
    let current = withoutFragment(url);
    for (let redirects = 0; ; redirects++) {
      const address = new URL(current);
      if (checkRobots && !robotsAllow(await this.robotsFor(address.origin), address.pathname + address.search)) {
        throw new RobotsError(`robots.txt disallows ${current}`);
      }
      const result = await this.request(current);
      const next = redirectTarget(result, current);
      if (!next) return { ...result, url: current };
      if (redirects === MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects from ${url}`);
      current = next;
    }
  }

  private async robotsFor(origin: string): Promise<RobotsRule[][]> {
    let rules = this.robots.get(origin);
    if (!rules) {
      try {
        // robots.txt itself needs no check.
        const result = await this.follow(`${origin}/robots.txt`, false);
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
