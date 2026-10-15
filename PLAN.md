# Build Plan

Status: draft 5. Date: 2026-10-15. The design is in `DESIGN-v3.md`. This file gives the build order for phases 1 to 3 and the later milestones.

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

## Phase 3 milestones

Phase 3 moves ingest into the app. See "Ingest in the app (phase 3)" in `DESIGN-v3.md`. The commands stay, and the app uses the same code.

16. Add a book in the app.
    - Shared code:
      - Move the code around `ingestBook` from `src/cli/ingest.ts` into `src/ingest/`. The command and the server use this code.
      - This code parses the book with the cached image texts, counts the model requests, reads the images, and builds the book again.
      - The count gives the number of model requests for each chapter. The command adds up the numbers. Its output does not change.
      - Give `readImages` and `ingestBook` a progress callback and a stop check. The stop check runs before each image, each chapter, and each merge.
    - Database:
      - Migration 9 adds the table `ingests`. See "Data model" in `DESIGN-v3.md`.
      - At the start of the server, a run with the status `running` becomes `failed`. A session with the status `preparing` does the same now.
    - Server routes:
      - `POST /api/subjects` with the body `{ "name": "SQL" }` creates an empty subject. If the subject exists, the route answers 409.
      - `POST /api/subjects/:slug/books?name=<file name>` takes the book file as the body, with the type `application/octet-stream`.
      - The upload route has a body limit of 200 MB. It keeps only the base name of the file. It parses the file, keeps it in the folder of the book, and answers with the folder name.
      - `GET /api/subjects/:slug/books/:book` answers with the plan of the book, the last run of the book, and the report of that run.
      - `POST /api/subjects/:slug/books/:book/ingest` with the body `{ "mode": "preview", "chapters": [1, 2] }` starts a run. The mode is `preview` or `save`.
      - If a run is in progress, the start route answers 409.
      - `GET /api/ingests/:id` answers with the status and the progress of a run.
      - `POST /api/ingests/:id/stop` stops a run after the current image, chapter, or merge.
      - `GET /api/subjects/:slug` also gives the run in progress of the subject.
      - `DELETE /api/subjects/:slug` answers 409 during a run on the subject.
    - The plan of a book has these parts:
      - The title, the format, the parse warnings, and the model name. If `.env` has no model, the plan has the message about the model.
      - For each chapter: the number, the title, the sections, the words, the images to read, the model requests, and a mark for a chapter with concepts.
      - For a saved book, the server parses the copy of the book file again and compares the sections with the database. If they do not match, the plan has the message and no run.
    - App:
      - Home: add the "New subject" field. A new subject opens its subject screen. If there are no subjects, the notice shows the field, not the `npm run ingest` command.
      - Subject screen: add the "Add a book" button, with a file picker for `.epub` and `.pdf` files.
      - Subject screen: add "Add chapters" to each book with chapters without concepts. Show a run in progress as one line, with a link to the book page.
      - An empty subject shows only the part with the books and the "Add a book" button.
      - Book page: add the route `#/subjects/<slug>/books/<book>` with the plan, run, and report states. See "The book page" in `DESIGN-v3.md`.
      - The checkboxes start empty. "Select all" selects the chapters without concepts. The "Preview" and "Save" buttons show the number of model requests for the selection.
      - The report shows the table of chapters that the command prints, the sections without concepts, the minor items, the quote warnings, and the parse warnings.
      - The report of a preview also shows the preview concept map, with `react-markdown`. It has the "Save these chapters" and "Change the chapters" buttons.
    - Book order of the concept map:
      - A concept takes the place of its first source, and a module takes the place of its first concept. See "Concept map" in `DESIGN-v3.md`.
      - Each save gives the modules new numbers in the book order. Migration 10 does the same one time for the existing modules.
      - The map screen shows the concepts of each module in the book order.
    - Tests use the fake model client. They cover these cases:
      - The upload route, also with a file that the parser cannot read.
      - The plan, with chapters in the cache and chapters with concepts.
      - A preview, and a save of some chapters.
      - "Stop", the rule of one run at a time, and a run that becomes `failed` at the start of the server.
    - Update `README.md` and `docs/usage.md`. The app becomes the main way to add a book. The commands move to a new reference, `docs/commands.md`.
    - Exit test:
      - In the app, create a subject. Upload a real EPUB file and preview one chapter. The report and the preview concept map show.
      - Click "Save these chapters". The run makes only the merge request, and the concepts show on the concept map.
      - On the subject screen, click "Add chapters". Select two more chapters and click "Save". Stop the run in the second chapter.
      - Start the run again. The first of the two chapters comes from the cache.
17. Fetch a YouTube video or playlist.
    - Many courses exist only as YouTube videos. See "Videos (phase 3)" in `DESIGN-v3.md`.
    - `npm run fetch -- <YouTube address>` accepts a video or a playlist, and writes an EPUB file to `data/web/`.
    - The options `--title` and `--yes` work as for an online book. For a playlist, `--chapters` selects the videos. `--toc` does not apply.
    - Put the code in `src/ingest/video/`. `src/cli/fetch.ts` sends a YouTube address to this code.
    - Configuration:
      - `config.ts` reads `VIDEO_PROVIDER` (`openrouter` or `google`), `VIDEO_MODEL`, and the key of the video provider: `OPENROUTER_API_KEY` or `GEMINI_API_KEY`.
      - If one of these values is empty, a video step stops with a clear message.
      - Add `VIDEO_PROVIDER`, `VIDEO_MODEL`, and `GEMINI_API_KEY` to `.env.example`, with a short explanation.
    - yt-dlp:
      - At the first use, download the yt-dlp program into `data/bin/`. Use the file of the latest GitHub release for the system: `yt-dlp_macos`, `yt-dlp.exe`, `yt-dlp_linux`, or `yt-dlp_linux_aarch64`.
      - If the last update is more than one day old, run `yt-dlp -U` before the download.
      - Read the facts as JSON with `-J`. For a playlist, add `--flat-playlist`. Then read each selected video with one more call, for its YouTube chapters.
      - Always pass `--js-runtimes node:<path>` with the path of the running Node.js program, and `--no-warnings`.
      - Keep only these facts: the ID, the title, the channel, the length, and the YouTube chapters.
      - Put the call of yt-dlp behind a function, so that the tests use a fake function.
    - Video client:
      - Add a small `VideoClient` interface with one method, `transcribe`. It takes the YouTube address, the prompt, and the token limit. It returns the text, the finish reason, and the token counts.
      - The OpenRouter class uses the OpenAI SDK, as `OpenAiClient` does. It sends a `video_url` part with `processing: "static"`, and `reasoning: { effort: "low" }`.
      - The Google class sends one request to `https://generativelanguage.googleapis.com/v1beta/interactions` with `fetch`, and needs no SDK. The input has a `video` part with the `uri` of the video and `processing: { type: "static" }`. Use the lowest thinking level of the model.
    - Selection and cost:
      - For a playlist, show the videos as a numbered list with their lengths, and ask which ones to download. For one video, show its chapters.
      - Show a video longer than 90 minutes as "too long". For one such video, the command stops with a clear message.
      - Before the download, show the total length. Ask before the download. `--yes` gives the answer.
      - For `openrouter`, also show the estimated cost. Get the prices of `VIDEO_MODEL` from the public model list of OpenRouter. The estimate uses 100 input tokens for each second, and 550 output tokens for each minute.
      - For `google`, show no cost. Say that the free tier allows 8 hours of YouTube video a day.
    - Transcripts:
      - Write the prompt from the rules of the transcript in `DESIGN-v3.md`.
      - Check each transcript, as "Checks of the transcript" in `DESIGN-v3.md` says. If a check fails, try one more time. Then skip the video, and show the reason in the report.
      - Keep each transcript that passes in `data/web/transcripts/<video id>.json`. A later run uses this file and makes no request.
    - The EPUB file:
      - Put each paragraph into the chapter or the section of its start time.
      - Start each paragraph with the link to its time in the video.
      - Put "_The tutor read this code from the video:_" before each code block, and "_The tutor read this table from the video:_" before each table.
      - Convert the Markdown to XHTML with `marked`, and write the file with `writeEpub`.
    - App: the section panel opens external links in a new tab. Now a click on a link replaces the app.
    - Tests use the fake yt-dlp function and a fake `VideoClient`. They cover these cases:
      - The request body of each provider class, with a fake `fetch`.
      - One video with YouTube chapters, one video without them, and a playlist.
      - A transcript that fails a check, the second try, and a skipped video.
      - The cache: a second run makes no request.
      - The EPUB file parses with `parseBook` into the expected chapters and sections. The bold terms are in the checklist.
    - Update `README.md`, `docs/usage.md`, and `docs/commands.md`. The README names the video models that we tested. It also says that each user takes the responsibility for the videos and the transcripts.
    - Exit test:
      - Use only videos of 15 minutes or less, to keep the cost small.
      - `npm run fetch -- https://www.youtube.com/watch?v=ahCwqrYpIuM` writes an EPUB file with 6 chapters. `npm run parse` on the file shows no lost text.
      - With a Gemini key and `VIDEO_PROVIDER=google`, the same video gives the same 6 chapters.
      - A playlist of 2 or 3 short videos gives one chapter for each video.
      - A second run of the same video makes no model request.
      - Add the EPUB file in the app. A preview of one chapter gives a good concept map.
      - In "Read the section", a time link opens the video at the correct time.
18. Add an online book in the app.
    - Add the "Add an online book" button to the subject screen. The form has the address and an optional address of a table of contents.
    - `POST /api/fetch/toc` with the body `{ "url": "<address>", "toc": "<address>" }` finds the table of contents. The app waits for the answer, as for a new lesson.
    - The answer has the title, the scope, the chapters with their pages, and the estimated time.
    - The app shows the chapters with checkboxes. All chapters start selected, as in the command.
    - `POST /api/subjects/:slug/fetch` with the table of contents and the chapters starts a run with the mode `fetch`.
    - The server keeps no state between the two requests, so the app sends the table of contents back. The server downloads only the pages in the scope.
    - If `data/web/` has a file with the same title, the route starts no run and answers with the file name. Then the app offers "Use the downloaded file" and "Download again".
    - `POST /api/subjects/:slug/books/web` with the body `{ "file": "<name>.epub" }` adds a file from `data/web/` as a book. "Use the downloaded file" uses this route.
    - Give `fetchBook` a progress callback and a stop check, as `ingestBook` has. The stop check runs before each page.
    - At the end of the run, the server writes the EPUB file to `data/web/`. Then it parses the file and keeps a copy in the folder of the book, as for an upload.
    - The book page opens in the plan state. The skipped pages of the download show above the plan.
    - Tests use a fake fetch function and the fake model client. They cover these cases:
      - The route of the table of contents.
      - A download with "Stop". The stopped download writes no EPUB file.
      - An EPUB file with the same title in `data/web/`.
      - The plan after the download.
    - Update `README.md`, `docs/usage.md`, and `docs/commands.md`. The app becomes the main way to add an online book.
    - Exit test:
      - In the app, add `https://doc.rust-lang.org/book/` with two chapters. The book page opens with the plan of the two chapters.
      - A preview of one chapter gives a good concept map.
19. Add a YouTube video or playlist in the app.
    - The "Add an online book" form of milestone 18 also accepts a YouTube address. The button becomes "Add an online book or video".
    - `POST /api/fetch/toc` with a YouTube address answers with the facts of the video or the playlist, the lengths, and the estimated cost.
    - For a playlist, the app shows the videos with checkboxes and their lengths. For one video, it shows the chapters with no checkboxes, because each request contains the full video.
    - The download is a run with the mode `fetch`, as for an online book. Each video is one step, for example "Transcribing video 2 of 5". "Stop" ends the run after the current video.
    - The finished transcripts stay in the cache. A stopped run writes no EPUB file.
    - If the video provider, the video model, or its key is empty, the app shows the message about the video model and no "Download" button.
    - Tests use the fake yt-dlp function and the fake `VideoClient`. They cover the route with a YouTube address, a run with "Stop", and a run with transcripts in the cache.
    - Update `docs/usage.md`.
    - Exit test: in the app, add `https://www.youtube.com/watch?v=ahCwqrYpIuM`. The book page opens with the plan of 6 chapters. A preview of one chapter gives a good concept map.

After milestone 19, phase 3 is complete.

## Options

If the user asks for them, these options can come later:

- Keep the date of the change to `mastered` for each concept. Then the board can show "learned 5 weeks ago".
- Export the starred concepts as a Markdown list, as a summary of the books.
- A "Quiz me" button that asks one question about one concept, with no schedule.
- With `VIDEO_PROVIDER=google`, one request for each YouTube chapter, with the clip offsets of the Gemini API. First test that the offsets work with a YouTube address. See "Open questions" in `DESIGN-v3.md`.
- Videos longer than 90 minutes, with the Gemini processing mode `agentic` and one request for each YouTube chapter. Test it first with one chapter of a video of about 1 hour. Never send a video of 3 hours for a test, because of the cost.

## Test books

- Unit tests build a small EPUB file in the test code. It covers the difficult cases: spine order, parts, nested sections, page breaks, code blocks, tables, asides, footnotes, images, a glossary, and an index.
- A free book helps to test with a real EPUB file: Pro Git, by Scott Chacon and Ben Straub (license CC BY-NC-SA 3.0).
- The books of the user stay in `data/`, which is not in git.
