import JSZip from "jszip";

export function xhtml(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Test</title><style>p { color: red; }</style></head>
<body>${body}</body>
</html>`;
}

// Filler text with an exact number of words.
export function words(count: number, word = "lorem"): string {
  return Array.from({ length: count }, () => word).join(" ");
}

export interface FixtureBook {
  title?: string;
  files: Record<string, string>;
  spine: string[];
  nav?: string;
  ncx?: string;
}

export async function buildEpub(book: FixtureBook): Promise<Uint8Array> {
  const zip = new JSZip();
  const paths = Object.keys(book.files);
  const idOf = (path: string) => `f${paths.indexOf(path)}`;
  const mediaType = (path: string) => (path.endsWith(".css") ? "text/css" : "application/xhtml+xml");
  const items = paths.map((path) => `<item id="${idOf(path)}" href="${path}" media-type="${mediaType(path)}"/>`);
  if (book.nav) {
    items.push(`<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`);
    zip.file("OEBPS/nav.xhtml", book.nav);
  }
  if (book.ncx) {
    items.push(`<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`);
    zip.file("OEBPS/toc.ncx", book.ncx);
  }
  zip.file("mimetype", "application/epub+zip");
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${book.title ?? "Fixture Book"}</dc:title><dc:creator>Test Author</dc:creator></metadata>
<manifest>${items.join("")}</manifest>
<spine${book.ncx ? ' toc="ncx"' : ""}>${book.spine.map((path) => `<itemref idref="${idOf(path)}"/>`).join("")}</spine>
</package>`,
  );
  for (const [path, content] of Object.entries(book.files)) zip.file(`OEBPS/${path}`, content);
  return zip.generateAsync({ type: "uint8array" });
}

// A book with the difficult cases: a part, a chapter in two files, two chapters in one file,
// long sections, page breaks, code, a table, callouts, footnotes, images, a glossary, and an index.
export function mainFixture(): FixtureBook {
  return {
    files: {
      "cover.xhtml": xhtml(`<section epub:type="cover"><img src="cover.png" alt="cover.png"/></section>`),
      "copyright.xhtml": xhtml(`<section epub:type="copyright-page"><h1>Copyright</h1><p>Copyright 2026 Test.</p></section>`),
      "part1.xhtml": xhtml(`<section epub:type="part"><h1>Part I. Basics</h1></section>`),
      "ch1.xhtml": xhtml(`
<section epub:type="chapter" id="ch1">
<h1>Getting Started</h1>
<p>This chapter introduces the <dfn>working tree</dfn>&nbsp;and other ideas. ${words(40, "intro")}</p>
<section id="s1"><span epub:type="pagebreak" id="page_5" title="5"/>
<h2>First Section</h2>
<p>A <strong>snapshot</strong> records the state of the files. The text continues here<a id="inline-anchor"/> with more words after the anchor.</p>
<pre class="highlight"><code class="language-sh">git init
git status</code></pre>
<aside epub:type="notice" class="admonition note" title="Note: Be careful"><p>Do not delete the folder.</p></aside>
<figure><img src="d.png" alt="Diagram of the states"/><figcaption>Figure 1. The three states</figcaption></figure>
<table><tr><th>Command</th><th>Effect</th></tr><tr><td><p>init</p></td><td><p>Creates a repository</p></td></tr></table>
<p>The <em>staging area</em> holds changes. It is <em>only</em> a list.<a epub:type="noteref" href="#fn1">1</a></p>
<aside epub:type="footnote" id="fn1"><p>A footnote about the index.</p></aside>
<h3>A Subsection</h3>
<p>Subsection text that stays inside the first section.</p>
</section>
<section id="s2"><h2>Second Section</h2>
<p>Text of the second section with a <a href="https://example.com/docs">link</a> and an <a href="ch2a.xhtml">internal link</a>. ${words(30, "second")}</p>
<span epub:type="pagebreak" title="6"/>
<p>More text on page six.</p></section>
<section id="s3"><h2>Summary</h2><ul><li>Git records snapshots of files.</li><li>The staging area holds the next commit.</li></ul></section>
</section>`),
      "ch2a.xhtml": xhtml(`<h1>Branching</h1><p>${words(50, "branching")}</p><h2>Branches</h2><p>${words(60, "branch")}</p>`),
      "ch2b.xhtml": xhtml(`<h2>Merging</h2><p>${words(60, "merge")}</p>`),
      "ch34.xhtml": xhtml(`
<section id="c3"><h1>Remotes</h1><p>Remote text. ${words(50, "remote")}</p></section>
<section id="c4"><h1>Tags</h1><p>Tag text. ${words(50, "tag")}</p></section>`),
      "ch5.xhtml": xhtml(`<h1>Internals</h1>
<h2>Objects</h2><p>${words(60, "object")}</p>
<h3>Blobs</h3><p>${words(60, "blob")}</p>
<h3>Trees</h3><p>${words(60, "tree")}</p>
<h2>Packfiles</h2><p>${words(60, "pack")}</p><p>${words(60, "pack")}</p><p>${words(60, "pack")}</p>`),
      "glossary.xhtml": xhtml(`<section epub:type="glossary"><h1>Glossary</h1>
<dl><dt>Snapshot</dt><dd>A record of the files at one time.</dd><dt>Rebase</dt><dd>A word that is not in the chapters.</dd></dl></section>`),
      "index.xhtml": xhtml(`<section epub:type="index"><h1>Index</h1>
<ul><li>anchor term, <a href="ch1.xhtml#inline-anchor">3</a></li>
<li>tags<ul><li>annotated, <a href="ch34.xhtml#c4">9</a></li></ul></li></ul></section>`),
    },
    spine: ["cover.xhtml", "copyright.xhtml", "part1.xhtml", "ch1.xhtml", "ch2a.xhtml", "ch2b.xhtml", "ch34.xhtml", "ch5.xhtml", "glossary.xhtml", "index.xhtml"],
    nav: xhtml(`<nav epub:type="toc"><ol>
<li><a href="copyright.xhtml">Copyright</a></li>
<li><a href="part1.xhtml">Part I. Basics</a><ol>
<li><a href="ch1.xhtml">Getting Started</a></li>
<li><a href="ch2a.xhtml">Branching</a></li>
</ol></li>
<li><a href="ch34.xhtml#c3">Remotes</a></li>
<li><a href="ch34.xhtml#c4">Tags</a></li>
<li><a href="ch5.xhtml">Internals</a></li>
<li><a href="glossary.xhtml">Glossary</a></li>
<li><a href="index.xhtml">Index</a></li>
</ol></nav>`),
  };
}

// An EPUB 2 book with only an NCX table of contents and an NCX page list.
export function ncxFixture(): FixtureBook {
  return {
    title: "NCX Book",
    files: {
      "one.xhtml": xhtml(`<h1>One</h1><p>${words(50, "one")}</p><h2>Later</h2><p><span id="p7"/>${words(50, "later")}</p><h2>End</h2><p>${words(50, "end")}</p>`),
      "two.xhtml": xhtml(`<h1>Two</h1><p>${words(50, "two")}</p>`),
    },
    spine: ["one.xhtml", "two.xhtml"],
    ncx: `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<navMap>
<navPoint id="n1"><navLabel><text>One</text></navLabel><content src="one.xhtml"/></navPoint>
<navPoint id="n2"><navLabel><text>Two</text></navLabel><content src="two.xhtml"/></navPoint>
</navMap>
<pageList><pageTarget id="pg7" type="normal" value="7"><navLabel><text>7</text></navLabel><content src="one.xhtml#p7"/></pageTarget></pageList>
</ncx>`,
  };
}

// A book in the style of many publishers: no heading tags, and CSS classes for headings,
// bold, and italic. Each chapter is one large <div>.
export function styledFixture(): FixtureBook {
  const chapter = (number: number, extra = "") =>
    xhtml(`<div class="body_font">
<p class="ct0">PRACTICE</p><p class="ct1">NO. ${number}</p>
<p class="p">${words(30, "intro")}</p>
<p class="h1">First Pose (<span class="h1_i">Asana</span>)</p>
<p class="p"><span class="b">Lie on your back.</span> Keep the <span class="i">drishti</span> steady. ${words(40, "pose")}</p>
<p class="h1">Second Pose</p>
<p class="p">${words(60, "second")}</p>${extra}
</div>`);
  return {
    title: "Styled Book",
    files: {
      "style.css": `/* Publisher styles */
.p { font-size: 1.0em; font-weight: normal; }
.ct0 { font-size: 4.0em; font-weight: bold; }
.ct1 { font-size: 1.4em; }
.h1 { font-size: 2.6em; font-weight: normal; }
.b { font-weight: bold; }
.i { font-style: italic; }
.h1_i { font-style: italic; }
@media amzn-kf8 { .p { font-size: 1em; } }`,
      "c01.xhtml": chapter(1),
      "c02.xhtml": xhtml(`<div class="body_font"><p class="ct0">ESSAY</p>${Array.from({ length: 6 }, () => `<p class="p">${words(100, "essay")}</p>`).join("")}</div>`),
      "bib.xhtml": xhtml(`<div class="body_font"><p class="ct0">For the Curious (Bibliography)</p><p class="p">${words(40, "book")}</p></div>`),
      "glossary.xhtml": xhtml(`<div class="body_font"><p class="ct0">Glossary</p>
<p class="glo"><span class="b">Drishti</span> A steady gaze.</p>
<p class="glo"><span class="b i">Asana</span> A yoga pose.</p></div>`),
      "index.xhtml": xhtml(`<div class="body_font"><p class="ct0">Index</p><p class="idx">drishti, 3</p></div>`),
      "ads.xhtml": xhtml(`<div><p class="p">What is next on your reading list? Sign up now.</p></div>`),
    },
    spine: ["c01.xhtml", "c02.xhtml", "bib.xhtml", "glossary.xhtml", "index.xhtml", "ads.xhtml"],
    nav: xhtml(`<nav epub:type="toc"><ol>
<li><a href="c01.xhtml">Practice No. 1</a></li>
<li><a href="c02.xhtml">Essay</a></li>
<li><a href="bib.xhtml">For the Curious (Bibliography)</a></li>
<li><a href="glossary.xhtml">Glossary</a></li>
<li><a href="index.xhtml">Index</a></li>
</ol></nav>`),
  };
}
