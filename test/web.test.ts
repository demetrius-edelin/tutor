import { describe, expect, it } from "vitest";
import { encodePng } from "../src/ingest/core/png.js";
import { parseBook } from "../src/ingest/parse.js";
import { bookTitle, fetchBook, formatList, shingles, similarity } from "../src/ingest/web/fetch.js";
import { Downloader, robotsAllow, robotsRules, type Fetcher, type FetchResult } from "../src/ingest/web/http.js";
import { cleanMarkdownPage, cleanPage, stripMdx } from "../src/ingest/web/page.js";
import {
  collectLinks,
  findToc,
  inScope,
  llmsChapters,
  llmsTxtUrls,
  parseLlmsTxt,
  scopedItems,
  scopeOf,
  type WebToc,
} from "../src/ingest/web/toc.js";
import { FakeLlm } from "./fakes/llm.js";

type FakePage = string | { status?: number; contentType?: string; body: string | Uint8Array };

// A fake site. An address that is not in the map gives a 404 page.
function fakeSite(pages: Record<string, FakePage>): Fetcher & { requested: string[] } {
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

const noModel = () => {
  throw new Error("No model is selected.");
};

const html = (body: string, title = "Site") => `<!doctype html><html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`;
// Text with different words, for example "value0 value1 value2".
const prose = (topic: string, count: number) => Array.from({ length: count }, (_, i) => `${topic}${i}`).join(" ");
const png = (value: number) => encodePng({ width: 2, height: 2, channels: 3, data: new Uint8Array(12).fill(value) });

describe("robots.txt", () => {
  const text = `User-agent: *
Disallow: /private/
Allow: /private/open
Disallow: /*.pdf$

User-agent: other-bot
Disallow: /`;

  it("uses the group for all agents, and the longest rule wins", () => {
    const rules = robotsRules(text);
    expect(robotsAllow(rules, "/docs/a")).toBe(true);
    expect(robotsAllow(rules, "/private/secret")).toBe(false);
    expect(robotsAllow(rules, "/private/open/page")).toBe(true);
    expect(robotsAllow(rules, "/files/book.pdf")).toBe(false);
    expect(robotsAllow(rules, "/files/book.pdf.html")).toBe(true);
  });

  it("uses the group for tutor-fetch if the file has one", () => {
    const rules = robotsRules(`${text}\n\nUser-agent: tutor-fetch\nDisallow: /docs/`);
    expect(robotsAllow(rules, "/docs/a")).toBe(false);
    expect(robotsAllow(rules, "/private/secret")).toBe(true);
  });

  it("allows all paths for an empty Disallow line", () => {
    expect(robotsAllow(robotsRules("User-agent: *\nDisallow:"), "/a")).toBe(true);
  });
});

describe("Downloader", () => {
  it("tries a failed request one more time, and obeys robots.txt", async () => {
    let calls = 0;
    const fetcher: Fetcher = async (url) => {
      if (url.endsWith("/robots.txt")) return { url, status: 200, contentType: "text/plain", body: new TextEncoder().encode("User-agent: *\nDisallow: /no/") };
      calls++;
      return { url, status: calls === 1 ? 503 : 200, contentType: "text/html", body: new Uint8Array() };
    };
    const download = new Downloader(fetcher, { pauseMs: 0 });
    expect((await download.get("https://site.test/a")).status).toBe(200);
    expect(calls).toBe(2);
    await expect(download.get("https://site.test/no/page")).rejects.toThrow("robots.txt disallows");
  });
});

describe("scope", () => {
  it("is the folder of the start address, or the parent folder", () => {
    expect(scopeOf("https://site.test/book/", [])).toBe("https://site.test/book/");
    expect(scopeOf("https://site.test/30-days", ["https://site.test/30-days/day-1"])).toBe("https://site.test/30-days/");
    expect(scopeOf("https://site.test/en/docs/first-steps", ["https://site.test/en/docs/first-steps.md"])).toBe("https://site.test/en/docs/");
  });

  it("contains the folder address without the last slash", () => {
    expect(inScope("https://site.test/30-days", "https://site.test/30-days/")).toBe(true);
    expect(inScope("https://site.test/30-days/day-1#top", "https://site.test/30-days/")).toBe(true);
    expect(inScope("https://site.test/blog/", "https://site.test/30-days/")).toBe(false);
  });

  it("looks for llms.txt from the deepest folder to the root", () => {
    expect(llmsTxtUrls("https://site.test/en/docs/first-steps")).toEqual([
      "https://site.test/en/docs/first-steps/llms.txt",
      "https://site.test/en/docs/llms.txt",
      "https://site.test/en/llms.txt",
      "https://site.test/llms.txt",
    ]);
    expect(llmsTxtUrls("https://site.test/book/index.html")).toEqual(["https://site.test/book/llms.txt", "https://site.test/llms.txt"]);
  });
});

const LLMS_TXT = `# Help Center

> Documentation files for language models

## Documentation

- [Welcome](/en/introduction.md): The start page.
- [First Steps](/en/docs/first-steps.md)
- [Managing senders](/en/docs/senders/managing-senders.md)
- [Authenticating domains](/en/docs/senders/authenticating-domains.md): SPF and DKIM.
- [Creating campaigns](/en/docs/campaign-creation/creating-campaigns.md)
- [Managing senders again](/en/docs/senders/managing-senders.md)
- [Changelog](https://other.test/changelog.md)
`;

describe("llms.txt", () => {
  const file = parseLlmsTxt(LLMS_TXT, "https://site.test/en/llms.txt");

  it("reads the title and the links with absolute addresses", () => {
    expect(file.title).toBe("Help Center");
    expect(file.groups).toHaveLength(1);
    expect(file.groups[0]!.links[1]).toEqual({ title: "First Steps", url: "https://site.test/en/docs/first-steps.md" });
    expect(file.groups[0]!.links.at(-1)!.url).toBe("https://other.test/changelog.md");
  });

  it("makes a chapter for each folder in the scope, and a chapter for a page outside a folder", () => {
    const chapters = llmsChapters(file, "https://site.test/en/docs/");
    expect(chapters.map((chapter) => [chapter.title, chapter.pages.length])).toEqual([
      ["First Steps", 1],
      ["Senders", 2],
      ["Campaign creation", 1],
    ]);
  });

  it("makes a chapter for each ## heading with pages in the scope", () => {
    const two = parseLlmsTxt(
      "# Book\n\n## Basics\n- [A](/book/a.md)\n- [B](/book/b.md)\n\n## Advanced\n- [C](/book/c.md)\n\n## Other\n- [D](/blog/d.md)\n",
      "https://site.test/llms.txt",
    );
    const chapters = llmsChapters(two, "https://site.test/book/");
    expect(chapters.map((chapter) => [chapter.title, chapter.pages.map((page) => page.title)])).toEqual([
      ["Basics", ["A", "B"]],
      ["Advanced", ["C"]],
    ]);
  });
});

describe("MDX", () => {
  it("removes the component tags, keeps their content, and does not change code blocks", () => {
    const markdown = `import Tabs from "./tabs";

<Stepper>
1. **Complete your brand**

   <Callout type="info" title="Tip">Add a logo.</Callout>
</Stepper>

\`\`\`jsx
<Stepper>keep</Stepper>
\`\`\`
`;
    const result = stripMdx(markdown);
    const prose = result.split("```jsx")[0]!;
    expect(prose).not.toContain("import Tabs");
    expect(prose).toContain("1. **Complete your brand**");
    expect(prose).toContain("   Add a logo.");
    expect(prose).not.toMatch(/<\/?(Stepper|Callout)\b/);
    expect(result).toContain("```jsx\n<Stepper>keep</Stepper>\n```");
  });
});

describe("cleanPage", () => {
  const page = html(`<header><a href="/">Site</a></header>
<nav><a href="/a">Menu</a></nav>
<main id="content">
  <h1 id="title">4.1. What Is Ownership? <a class="anchor" href="#title">#</a></h1>
  <p>Text with a <a href="other.html#part">link</a> and a <a href="#rules">rule link</a>.</p>
  <h2 id="rules"><div class="wrapper">The rules<div class="inline"><a href="#rules">#</a></div></div></h2>
  <div class="note box"><p>A note.</p></div>
  <div class="text-lg title"><p>Not a heading class.</p></div>
  <pre><code class="language-rust">let a = 1;<br>let b = 2;</code></pre>
  <h3>Details</h3>
  <h2>Summary</h2>
  <img src="/img/code.png" alt="Code"><img src="data:image/gif;base64,R0lG" data-src="lazy.png" alt="Lazy">
  <button>Copy</button><form><input></form><script>alert(1)</script><footer>Edit this page</footer>
</main>
<footer>Site footer</footer>`);

  const clean = cleanPage(page, "https://site.test/book/ch04-01.html", { prefix: "p3", titles: ["What Is Ownership?"], headingBase: 3 });
  const xhtml = clean.render(new Map([["https://site.test/img/code.png", "images/abc.png"]]));

  it("keeps only the content of <main>", () => {
    expect(xhtml).not.toContain("Menu");
    expect(xhtml).not.toContain("Site footer");
    expect(xhtml).not.toContain("Copy");
    expect(xhtml).not.toContain("alert");
    expect(xhtml).not.toContain("Edit this page");
    expect(xhtml).not.toContain("<input");
  });

  it("removes the title heading, and moves the other headings to the base level", () => {
    expect(xhtml).not.toContain("What Is Ownership");
    expect(xhtml).toContain('<h3 id="p3-rules">The rules</h3>');
    expect(xhtml).toContain("<h4>Details</h4>");
  });

  it("moves a heading above the first heading to the base level", () => {
    expect(xhtml).toContain("<h3>Summary</h3>");
    const irregular = cleanPage(html("<main><h1>Flow</h1><h3>If</h3><h4>Else</h4><h2>Summary</h2></main>"), "https://site.test/a", {
      prefix: "p1",
      titles: ["Flow"],
      headingBase: 3,
    }).render(new Map());
    expect(irregular).toBe("<h3>If</h3><h4>Else</h4><h3>Summary</h3>");
  });

  it("makes links absolute and adds the prefix to the ids", () => {
    expect(xhtml).toContain('href="https://site.test/book/other.html#part"');
    expect(xhtml).toContain('href="#p3-rules"');
    expect(xhtml).not.toContain(">#<");
  });

  it("keeps the class of code and of note boxes only", () => {
    expect(xhtml).toContain('class="language-rust"');
    expect(xhtml).toContain('class="note box"');
    expect(xhtml).not.toContain("text-lg");
    expect(xhtml).toContain("let a = 1;\nlet b = 2;");
  });

  it("finds the images, also a lazy image, and uses the local path of a downloaded image", () => {
    expect(clean.images).toEqual(["https://site.test/img/code.png", "https://site.test/book/lazy.png"]);
    expect(xhtml).toContain('src="images/abc.png"');
    expect(xhtml).toContain('src="https://site.test/book/lazy.png"');
  });

  it("writes XHTML", () => {
    expect(xhtml).toMatch(/<img [^>]*\/>/);
  });

  it("converts a Markdown page", () => {
    const markdown = cleanMarkdownPage("# First Steps\n\n## Why\n\nSome **bold** text.\n", "https://site.test/en/docs/first-steps.md", {
      prefix: "p1",
      titles: ["First Steps"],
      headingBase: 2,
    });
    const result = markdown.render(new Map());
    expect(result).not.toContain("First Steps");
    expect(result).toContain("<h2>Why</h2>");
    expect(result).toContain("<strong>bold</strong>");
  });
});

describe("collectLinks", () => {
  it("reads the links with their depth, the group titles, the card headings, and the frames in <noscript>", () => {
    const links = collectLinks(
      html(`<ol>
  <li><a href="ch1.html">1. Start</a><ol><li><a href="ch1-1.html">1.1. Install</a></li></ol></li>
  <li><span>Reference</span><ol><li><a href="ref.html">Keywords</a></li></ol></li>
  <li><label>Guides</label><nav><ul><li><a href="guide.html">Guide</a></li></ul></nav></li>
</ol>
<a href="day-1"><span>Day 1</span><span>Series</span><h4>What is it?</h4></a>
<noscript><iframe src="toc.html"></iframe></noscript>`),
      "https://site.test/book/",
    );
    expect(links.items).toEqual([
      { text: "1. Start", url: "https://site.test/book/ch1.html", depth: 1 },
      { text: "1.1. Install", url: "https://site.test/book/ch1-1.html", depth: 2 },
      { text: "Reference", url: null, depth: 1 },
      { text: "Keywords", url: "https://site.test/book/ref.html", depth: 2 },
      { text: "Guides", url: null, depth: 1 },
      { text: "Guide", url: "https://site.test/book/guide.html", depth: 2 },
      { text: "What is it?", url: "https://site.test/book/day-1", depth: 0 },
    ]);
    expect(links.frames).toEqual(["https://site.test/book/toc.html"]);
    expect(links.language).toBe("en");
  });

  it("keeps a group title only if a link in the scope comes under it", () => {
    const items = scopedItems(
      [
        { text: "Blog", url: null, depth: 1 },
        { text: "Post", url: "https://site.test/blog/post", depth: 2 },
        { text: "Guide", url: null, depth: 1 },
        { text: "Page", url: "https://site.test/book/page", depth: 2 },
      ],
      "https://site.test/book/",
    );
    expect(items.map((item) => item.text)).toEqual(["Guide", "Page"]);
  });
});

describe("findToc", () => {
  it("uses llms.txt, and needs no model", async () => {
    const site = fakeSite({ "https://site.test/en/llms.txt": { contentType: "text/plain", body: LLMS_TXT } });
    const toc = await findToc({ startUrl: "https://site.test/en/docs/first-steps", download: new Downloader(site, { pauseMs: 0 }), llm: noModel });
    expect(toc.source).toBe("llms.txt");
    expect(toc.title).toBe("Help Center");
    expect(toc.scope).toBe("https://site.test/en/docs/");
    expect(toc.chapters.map((chapter) => chapter.title)).toEqual(["First Steps", "Senders", "Campaign creation"]);
  });

  it("ignores an HTML page at the address of llms.txt", async () => {
    const site = fakeSite({
      "https://site.test/book/llms.txt": html("<p>A single page app answers each address.</p>"),
      "https://site.test/book/": html(`<a href="a.html">A</a>`),
    });
    const llm = new FakeLlm();
    const toc = await findToc({ startUrl: "https://site.test/book/", download: new Downloader(site, { pauseMs: 0 }), llm: () => llm });
    expect(toc.source).toBe("html");
  });

  it("reads the links of the start page and of its frame, and the model makes the chapters", async () => {
    const site = fakeSite({
      "https://site.test/book/": html(
        `<nav><noscript><iframe src="toc.html"></iframe></noscript></nav><a href="print.html">Print</a><a href="https://other.test/">Other site</a>`,
        "The Book - The Book",
      ),
      "https://site.test/book/toc.html": html(`<ol>
  <li><a href="intro.html">Introduction</a></li>
  <li><a href="ch1.html">1. Start</a><ol><li><a href="ch1-1.html">1.1. Install</a></li></ol></li>
</ol>`),
    });
    let prompt = "";
    const llm = new FakeLlm({
      toc: (text) => {
        prompt = text;
        return { title: "The Book", chapters: [{ title: "Introduction", links: [2] }, { title: "1. Start", links: [3, 4, 4, 99] }] };
      },
    });
    const toc = await findToc({ startUrl: "https://site.test/book/", download: new Downloader(site, { pauseMs: 0 }), llm: () => llm });
    expect(prompt).toContain("1: Print -> /book/print.html");
    expect(prompt).toContain("4:     1.1. Install -> /book/ch1-1.html");
    expect(prompt).not.toContain("other.test");
    expect(toc.source).toBe("html");
    expect(toc.title).toBe("The Book");
    expect(toc.chapters).toEqual([
      { title: "Introduction", pages: [{ title: "Introduction", url: "https://site.test/book/intro.html" }] },
      {
        title: "1. Start",
        pages: [
          { title: "1. Start", url: "https://site.test/book/ch1.html" },
          { title: "1.1. Install", url: "https://site.test/book/ch1-1.html" },
        ],
      },
    ]);
  });

  it("reads the --toc page and does not look for llms.txt", async () => {
    const site = fakeSite({
      "https://site.test/llms.txt": { contentType: "text/plain", body: LLMS_TXT },
      "https://site.test/docs/all": html(`<a href="/docs/a">A</a>`),
    });
    const toc = await findToc({
      startUrl: "https://site.test/docs/",
      tocUrl: "https://site.test/docs/all",
      download: new Downloader(site, { pauseMs: 0 }),
      llm: () => new FakeLlm(),
    });
    expect(toc.source).toBe("html");
    expect(site.requested).not.toContain("https://site.test/llms.txt");
    expect(toc.chapters[0]!.pages[0]!.url).toBe("https://site.test/docs/a");
  });

  it("stops with a clear message if the page has no links in the scope", async () => {
    const site = fakeSite({ "https://site.test/book/": html(`<a href="https://other.test/">Other</a>`) });
    await expect(
      findToc({ startUrl: "https://site.test/book/", download: new Downloader(site, { pauseMs: 0 }), llm: noModel }),
    ).rejects.toThrow("--toc");
  });
});

describe("fetchBook", () => {
  const lesson = (topic: string) => `<p>${prose(topic, 80)}</p><h2>Details of ${topic}</h2><p>${prose(`${topic}detail`, 80)}</p>`;

  const toc: WebToc = {
    title: "The Book",
    language: "en",
    startUrl: "https://site.test/book/",
    source: "html",
    tocUrl: "https://site.test/book/",
    scope: "https://site.test/book/",
    chapters: [
      { title: "Introduction", pages: [{ title: "Introduction", url: "https://site.test/book/intro.html" }] },
      {
        title: "1. Basics",
        pages: [
          { title: "1. Basics", url: "https://site.test/book/basics.html" },
          { title: "1.1. Values", url: "https://site.test/book/values.html" },
          { title: "1.2. Values again", url: "https://site.test/book/values-copy.html" },
          { title: "1.3. Missing", url: "https://site.test/book/missing.html" },
          { title: "1.4. Secret", url: "https://site.test/book/secret/page.html" },
        ],
      },
      { title: "Tips", pages: [{ title: "Tips", url: "https://site.test/book/tips.md" }] },
    ],
  };

  const site = () =>
    fakeSite({
      "https://site.test/robots.txt": { contentType: "text/plain", body: "User-agent: *\nDisallow: /book/secret/" },
      "https://site.test/book/intro.html": html(`<main><h1>Introduction</h1>${lesson("intro")}</main>`),
      "https://site.test/book/basics.html": html(`<main><h1>Basics</h1><p>${prose("basic", 60)}</p></main>`),
      "https://site.test/book/values.html": html(`<main><h1>Values</h1>${lesson("value")}<img src="img/v.png" alt="Code"></main>`),
      "https://site.test/book/values-copy.html": html(`<main><h1>Values, with examples</h1>${lesson("value")}</main>`),
      "https://site.test/book/tips.md": { contentType: "text/markdown", body: `# Tips\n\n<Callout>${prose("tip", 60)}</Callout>\n` },
      "https://site.test/book/img/v.png": { contentType: "image/png", body: png(200) },
    });

  it("writes an EPUB file that the parser reads as chapters and sections", async () => {
    const lines: string[] = [];
    const result = await fetchBook({
      toc,
      chapters: [1, 2, 3],
      download: new Downloader(site(), { pauseMs: 0 }),
      date: new Date("2026-10-10T12:00:00Z"),
      log: (line) => lines.push(line),
    });
    expect(result.title).toBe("The Book");
    expect(result.pages).toBe(4);
    expect(result.images).toBe(1);
    expect(result.skipped.map((item) => [item.url, item.reason])).toEqual([
      ["https://site.test/book/values-copy.html", "the same text as https://site.test/book/values.html"],
      ["https://site.test/book/missing.html", "HTTP status 404"],
      ["https://site.test/book/secret/page.html", "robots.txt disallows it"],
    ]);

    const book = await parseBook(result.epub, "the-book.epub");
    expect(book.title).toBe("The Book");
    expect(book.authors).toEqual(["site.test"]);
    // The parser asks the model to read the image later, in ingest.
    expect(book.warnings.map((warning) => warning.code)).toEqual(["unread_images"]);
    expect(book.skipped).toEqual([]);
    expect(book.chapters.map((chapter) => [chapter.title, chapter.sections.map((section) => section.title)])).toEqual([
      ["Introduction", ["Introduction", "Details of intro"]],
      ["1. Basics", ["1. Basics", "1.1. Values"]],
      ["Tips", ["Tips"]],
    ]);
    const values = book.chapters[1]!.sections[1]!;
    expect(values.markdown).toContain("### Details of value");
    expect(values.images).toHaveLength(1);
    expect(book.chapters[2]!.sections[0]!.markdown).toContain("tip0 tip1");
    expect(book.chapters[2]!.sections[0]!.markdown).not.toContain("Callout");
  });

  it("names a book with some chapters after the chapters", () => {
    expect(bookTitle(toc, [1, 2, 3])).toBe("The Book");
    expect(bookTitle(toc, [2])).toBe("The Book - 1. Basics");
    expect(bookTitle({ ...toc, chapters: [...toc.chapters, ...toc.chapters] }, [1, 2, 3, 5])).toBe("The Book - chapters 1-3, 5");
    expect(formatList([1, 2, 3, 5, 7, 8])).toBe("1-3, 5, 7-8");
  });

  it("finds two texts that are the same", () => {
    const text = prose("same", 100);
    expect(similarity(shingles(`${text} a b c`), shingles(`x y ${text}`))).toBeGreaterThan(0.8);
    expect(similarity(shingles(prose("one", 100)), shingles(prose("two", 100)))).toBe(0);
  });
});
