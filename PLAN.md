# Build Plan

Status: draft 3. Date: 2026-10-10. The design is in `DESIGN-v3.md`. This file gives the build order for phase 1, phase 2, and the later milestones.

## Rules

- Build one milestone at a time. Each milestone ends with a result that the user can run.
- Build ingest first. A good digest of a book is useful before the app exists.
- Use command-line scripts until milestone 5. The app comes after ingest works.
- Write tests for the code that does not call the model. Use a fake model client in the tests.
- Use real model calls only in scripts that the user starts.

## Progress

- Milestone 1: done.
- Milestone 2: done. Pro Git and a book of the user parse with no lost text. The parser reads publisher CSS for headings, bold, and italic.
- Milestone 2b: done. The parser reads tagged PDF files. A PDF book of the user parses with no lost text.
- Milestone 3: done. `npm run llm:check` passes with a model of the user.
- Milestone 4: done. A preview of one chapter of a book of the user gave a good concept map. The full book can come later with `--replace`.
- Milestone 5: done, with a smaller scope. The app has the home screen, the subject screen, and the map screen. Ingest stays a command for now. "Add book" and the ingest progress in the app come later.
- Milestone 6: done. The app has the select screen, the diagnosis with grades and disputes, and the results with the choices. The database has schema migrations now.
- Milestone 7: done. The study queue has a suggested order, drag and drop, move buttons, prerequisite warnings, and Later and Skip.
- Milestone 8: done. Lessons with checked references, the chat box, Teach it again, Start now in the queue, and the prerequisite actions.
- Milestone 9: done. The test after a lesson has the pass rule, mastered concepts, and the next lesson. After a fail, the user selects an action. After 3 fails, the tutor offers a prerequisite test. Phase 1 is complete.
- Milestone 10: done. The star button is on the lesson page and in the concept map. The columns of the review schedule are gone. The database of the user opens with no error.
- Lesson length fix: done. The tutor writes one lesson with references in one call. The length follows the concept, and the prompt has no minimum length. The "Explain in more detail" button is gone. Schema version 6 keeps the detailed version of each old lesson.
- Milestone 11: done. The "Review board" tab shows one line for each concept, with the status filters, the star filter, and the search. The address keeps the filters.
- Milestone 12: done. "Test me again" on the lesson page of a mastered concept uses the questions of the last test, with no model call to write questions. "Learn again" is dropped, because a click on the board opens the lesson. Phase 2 is complete.
- Milestone 13: done. The parser keeps the images of PDF and EPUB books, ingest reads them with the model, and `npm run refresh` adds them to an ingested book.
- Test size: done. The model gives each concept a number of test questions from 1 to 5. A simple concept gets fewer questions.
- Delete a subject: done. The home screen has a button that deletes a subject with its books, concepts, progress, and files.
- Ingest of sections: done. `npm run ingest -- <subject> <book> --sections <list>` ingests some sections of a chapter. This helps with books that have very large chapters.
- Milestone 14: done. `npm run fetch` reads `/en/llms.txt` of the Cakemail docs and shows the folders of `/en/docs/` as 16 chapters. A download of two chapters parsed with no lost text.
- Milestone 15: built. One model request found the table of contents of the Rust book in `toc.html`: 25 chapters and 111 pages. For "30 Days of Vue", it gave each day one time. The parse of the two books kept 100% to 105% of the words. The exit test needs a preview of one chapter of a fetched book with the model of the user.

## Milestones

1. Setup: the TypeScript project, Vitest, the `.env` loader, and the SQLite schema. Exit test: `npm test` and `npm run typecheck` pass.
2. Parse (ingest stage 1): EPUB or tagged PDF to Markdown sections, the checklist, and the parse warnings. Command: `npm run parse -- <book.epub | book.pdf>`. Exit test: a real EPUB parses, and the parse report shows no lost text.
3. Model client: `LlmClient`, `AnthropicClient`, and `OpenAiClient`. Exit test: a script gets a JSON answer and a text answer with references from the selected provider.
4. Extract, review, and merge (ingest stages 2 to 4), and the ingest report. For the first book, the merge step builds the concept map from an empty map. Command: `npm run ingest -- <subject> <book.epub>`. The command also writes the concept map to a Markdown file. Exit test: the user reads the concept map of one real book and finds no large gaps.
5. App shell: the server, the React app, the home screen, the subject screen, and the map screen. "Add book", the ingest progress, and the ingest report in the app come later.
6. Select, diagnose, and choose.
7. The study queue.
8. Teach: lessons with references, and the chat box.
9. Test and grader. After this milestone, phase 1 is complete.

Milestone 4 gives the first useful result: a full digest of a book.

## Phase 2 milestones

Phase 2 adds the review board and the stars. See "Review board" in `DESIGN-v3.md`. Phase 2 makes no new model calls.

10. Star, and the removal of the review schedule.
    - One migration adds `concepts.starred` and removes `concepts.review_step` and `concepts.review_at`.
    - Remove `"review"` from the session kind type. The SQL CHECK constraints keep the value, because a change of a CHECK constraint needs a rebuild of the table.
    - Add `POST /api/concepts/:id/star` with the body `{ "starred": true }` or `{ "starred": false }`.
    - Add the `starred` field to the data of the concept map and of the lesson page.
    - Add the star button to the lesson header and to the concept rows of the concept map.
    - Exit test: star a concept on the lesson page, then load the concept map again. The concept has its star. The database of the user opens with no error.
11. Review board.
    - Add the route `#/subjects/<slug>/board` and the "Review board" tab after "Study queue".
    - Show one line for each concept, in its module: the status mark, the name, and the star button. The name opens the lesson page.
    - Add the summary line, the status filters with their counts, the "Starred" toggle, and the search box. The address keeps the filters.
    - Use the concept map request for the data.
    - Exit test: select "Learned" and "Starred". The board shows only the starred concepts that are `known` or `mastered`. A reload keeps the filters.
12. Test me again. This milestone replaces "Learn again": a click on a concept on the board opens its lesson, so the board needs no button.
    - Add the "Test me again" button to the "After the lesson" part of the lesson page of a `mastered` concept.
    - The button uses `POST /api/concepts/:id/check` with the body `{ "again": true }`. The server copies the questions of the last finished test into a new test session. The options of the recall question get a new order. The session is ready at once, with no model call.
    - If the concept has no finished test, the server writes new questions, as for "Test me".
    - A pass keeps the concept `mastered`. After a fail, the concept stays `mastered`, and the results offer "Teach it again", "Later", and "Skip".
    - Exit test: on the lesson page of a `mastered` concept with an old test, click "Test me again". The test opens at once with the old questions. After a pass, the concept is still `mastered`.

After milestone 12, phase 2 is complete.

## Later milestones

13. Read the images of a book.
    - Some books show code, tables, or query results as images. The parser cannot read an image, so the section text has only "[Image]". The lesson then misses the content. For example, one PDF book of the user has 96 images, and most of them show code.
    - The parser keeps the data of each image, for EPUB and PDF. For a PDF, the parser finds the image of each `Figure` element.
    - During ingest, the model reads each image one time. Code becomes a code block. A table becomes a Markdown table. Any other image gets a description of one sentence. A cache in the `work` folder of the book keeps the results, so each image costs one model call only one time.
    - The model client can send an image to Anthropic and to OpenAI. If the model in `.env` does not accept images, ingest keeps the placeholder and shows a warning. `npm run llm:check` also tests image input.
    - The parse report shows a warning for each image with no useful alt text. Alt text such as "A black screen with white text" is not useful.
    - Add `npm run refresh -- <subject> <book>`. The command parses the book again and reads its images. It writes only the section files and the word counts of the sections. Concepts, statuses, the queue, stars, lessons, and test answers do not change. If a section does not match its row in the database, the command stops and changes nothing.
    - Do not use `npm run ingest -- --replace` for an existing book. It removes the book row, so the IDs of all sections change. Then the references of the old lessons and the sections of the questions break.
    - Old lessons do not change. For a concept with an image in its sections, use "Teach it again" to get a lesson with the content of the image.
    - Exit test: run `refresh` on a book with code images. A section with a code image contains the code as a code block. The progress in the app is the same as before.
14. Fetch online documentation with `llms.txt`.
    - Some books and most product documentation are on the web only. The tutor reads only EPUB and PDF files.
    - Add `npm run fetch -- <url> [options]`. The command downloads the pages of an online book or of online documentation into one EPUB file in `data/web/`.
    - Then `parse`, `ingest`, and `refresh` read the EPUB file as a usual book. Their code does not change.
    - The EPUB file is the snapshot of the site. A later change to the site does not change the concepts or the references. The user can open the file in an e-book reader to check it.
    - Put the code in `src/ingest/web/` and the command in `src/cli/fetch.ts`.
    - Scope:
      - The start URL sets the scope. `fetch` keeps only the pages in the folder of the start URL.
      - If no page is in the folder of the start URL, `fetch` uses the parent folder. For example, `https://docs.cakemail.com/en/docs/first-steps` gives the scope `/en/docs/`.
      - `fetch` does not follow links from page to page. Only the table of contents gives the pages.
    - The `llms.txt` file:
      - Many documentation sites have an `llms.txt` file. It lists the pages of the site, often with a Markdown version of each page.
      - `fetch` looks for `llms.txt` in each folder of the start URL, from the deepest folder up to the root. For example, the Cakemail docs have the file at `/en/llms.txt`.
      - If the file has more than one `##` heading, each heading starts a chapter. If not, each folder of the page URLs is a chapter. A page that is not in a subfolder is a chapter of its own.
      - Each page is a section of its chapter. Chapters keep the order of their first page in the file. Pages keep the order of the file.
      - If a link ends in `.md`, `fetch` downloads the Markdown and converts it to HTML with a Markdown library, for example `marked`.
      - MDX (Markdown with components) pages can contain component tags such as `<Stepper>`. Remove these tags and keep their content.
      - `fetch` downloads the other links as HTML pages.
    - Selection of chapters:
      - `fetch` shows the chapters as a numbered list, with the number of pages in each chapter.
      - `fetch` asks which chapters to download. The default is all chapters.
      - `--chapters <list>` gives the answer without the question, as in `ingest`. `--yes` takes all chapters without the question.
      - For a book, the user takes all chapters. For a large documentation site, the user takes some parts only.
    - Content of an HTML page:
      - Keep the `<main>` element. If the page has no `<main>`, keep `<article>`. If the page has no `<article>`, keep `<body>`.
      - Remove the elements with no text of the page, for example `<nav>`, `<script>`, `<button>`, `<form>`, `<svg>`, and `<footer>`. Most sites put the previous and next links in a `<nav>` element.
      - Remove the anchor marks next to headings, for example "#" or "¶". A heading keeps only its text and its inline elements.
      - Keep the `class` attribute only on code and on note boxes. Other classes of a site can look like the heading classes of a publisher.
      - If the first heading repeats the title of the page, remove it. Move the next heading to the base level, and move the other headings with it.
      - Download the images of the kept content in the formats that the parser reads. Also download images from other hosts, because many sites use a CDN (content delivery network).
      - Convert each page to XHTML with cheerio, because the EPUB reader parses XHTML in XML mode.
      - Some sites show the same text under two URLs. If a page has the same text as an earlier page, skip it, and show it in the report.
    - The EPUB file:
      - Each chapter is one XHTML file, and each page is a `<section>` in the file. With one file for each page, the parser makes each page a chapter.
      - The title comes from `llms.txt` or from the `<title>` of the start page. The author is the host name of the site.
      - If the user takes some chapters only, the title also names the chapters. The title gives the file name and the folder of the book in a subject. `--title <text>` sets a different title.
      - `dc:source` keeps the start URL, and `dc:date` keeps the date of the fetch.
      - The nav document keeps the chapters and their pages.
    - Polite fetch:
      - Send one request at a time, with a pause of 1 second between requests. Use the user agent `tutor-fetch`.
      - Obey `robots.txt`. Skip the pages that it disallows, and show them in the report.
      - Before the download, show the number of pages and an estimate of the time.
      - If a page fails, try it again one time. Then skip it, and show it in the report.
    - Tests use a fake fetch function with small pages in the test code. They cover the scope rule, the `llms.txt` chapters, the MDX tags, `robots.txt`, and the EPUB file. The EPUB file must parse with `parseBook` into the expected chapters and sections.
    - Update `README.md` and `docs/usage.md`.
    - Exit test: run `npm run fetch -- https://docs.cakemail.com/en/docs/first-steps`. `fetch` uses `/en/llms.txt` and shows the folders of `/en/docs/` as chapters. `npm run parse` on the EPUB file shows no lost text.
15. Fetch online books with no `llms.txt`.
    - If the site has no `llms.txt`, `fetch` reads the table of contents from the HTML of the start page.
    - `fetch` collects the links of the start page in page order, with their depth in lists. It also keeps the text of a list item with no link, for example the title of a group.
    - `fetch` keeps only the links in the scope.
    - If the start page has an `<iframe>` from the same site, `fetch` also reads the links of the `<iframe>`. The Rust book needs this rule. JavaScript fills its sidebar, but `toc.html` in an `<iframe>` has the full list.
    - A card link can contain a heading, a number, and a series name. The text of the heading is the title of the link.
    - One model request turns the link list into the table of contents. The model removes menus, footer links, print versions, and duplicate pages. For example, the start page of "30 Days of Vue" links each day under two URLs.
    - The model answers with the numbers of the links, not with the URLs. This keeps the answer short.
    - `fetch` shows the model name before the request. It does not ask first, because the cost of one request is small. If `.env` has no model, `fetch` stops with a clear message.
    - Add `--toc <url>`. If the start page does not give the full list of pages, the user gives a page that does. `fetch` then reads the links of that page.
    - Tests use the fake model client. They cover the `<iframe>` rule, the scope rule for HTML links, and the duplicate pages.
    - Exit test:
      - `npm run fetch -- https://doc.rust-lang.org/book/` finds the table of contents in `toc.html`. `npm run parse` on the EPUB file shows the chapters and sections with no lost text.
      - `npm run fetch -- https://www.newline.co/30-days-of-vue` gives each day one time.
      - A preview of one chapter of a fetched book gives a good concept map.

Milestones 14 and 15 do not cover these cases:

- Sites that show the text only after JavaScript runs. These sites need a headless browser (a browser with no window), and the build stays light.
- Pages behind a login or a paywall, for example Manning liveBook. The purchase of a Manning book gives an EPUB file, and the tutor reads EPUB files.
- Pages that only list links to other sites, for example the Flutter "Learning resources" page.
- An update of fetched documentation. If the sections of a book change, `refresh` stops. To update, fetch the site again and ingest it as a new book.

## Options

If the user asks for them, these options can come later:

- Keep the date of the change to `mastered` for each concept. Then the board can show "learned 5 weeks ago".
- Export the starred concepts as a Markdown list, as a summary of the books.
- A "Quiz me" button that asks one question about one concept, with no schedule.

## Test books

- Unit tests build a small EPUB file in the test code. It covers the difficult cases: spine order, parts, nested sections, page breaks, code blocks, tables, asides, footnotes, images, a glossary, and an index.
- A free book helps to test with a real EPUB file: Pro Git, by Scott Chacon and Ben Straub (license CC BY-NC-SA 3.0).
- The books of the user stay in `data/`, which is not in git.
