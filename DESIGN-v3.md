# Engineering Skills Tutor: Design

Status: draft 3, revision 11. Date: 2026-10-04. This file replaces `DESIGN.md` (draft 2).

## Purpose

The tutor helps one user learn from books that the user owns. The user groups the books into themes of study. For each theme, the tutor finds the concepts that the user does not know. Then it teaches those concepts one at a time and tests each one.

The tutor is a learning tool. It is not a job-search tool.

The tutor uses one large language model (LLM) from Anthropic, OpenAI, or OpenRouter. The text in this file calls the LLM "the model".

## Decisions

- Themes are neutral. The tutor has no built-in themes and no code for a specific subject. The user creates a theme with a name and adds books to it. The books define the content of the theme.
- Books are EPUB files or tagged PDF files.
- Until phase 4, the tutor runs on the laptop of the user. In phase 4, each user can also run it on a server. The tutor has no Telegram bot and no other messaging.
- The tutor is free and open source. Each user hosts their own copy. The project offers no public hosted version. See "Self-hosted release (phase 4)".
- The review board shows what the user learned. The user decides what to read again or to test again. The tutor has no review schedule.
- The user makes each decision about what to test, what to learn, what to skip, and the order of study. The tutor only suggests.
- The tutor uses one model. The user selects the provider, the model, and the API key in the `.env` file. The tutor has no default model.

## Principle: the tutor suggests, the user decides

The tutor suggests what to test, what to learn, and in which order. The user makes each decision. The tutor never adds, removes, or moves a concept in the study queue without a click from the user.

## The learning loop

```
 [Select] ───► [Diagnose] ───► [Choose] ───► [Study queue]
 mark each     test the        learn or      the user sets
 concept:      "Test"          skip each     the order
 test, learn,  concepts        failed                │
 or skip                       concept               ▼
                                         first concept in the queue
                                                     │
                                                     ▼
                                    ┌────────────► [Teach]
                                    │                 │
                     fail: the user │                 ▼
                     selects the    └───────────── [Test]
                     next action                      │ pass
                                                      ▼
                                          next concept in the queue
```

The loop has these steps:

1. Select: on the concept map, the user marks concepts "Test", "Learn", or "Skip". One mark can apply to many concepts from different modules.
2. Diagnose: the tutor tests the concepts with the mark "Test".
3. Choose: the tutor shows the results. For each failed concept, the user selects "Learn" or "Skip".
4. Queue: each "Learn" concept goes into the study queue. The tutor suggests an order, and the user can change it.
5. Teach: the tutor teaches the first concept in the queue. The lesson uses the sections of all books that cover the concept, and cites them. The user can ask questions about the lesson.
6. Test: the user clicks "Test me". The tutor asks new questions about the concept.
7. Next: if the user passes, the concept becomes `mastered`, and the tutor goes to the next concept in the queue. If the user fails, the user selects the next action.

The theme is complete after two conditions are true. The queue is empty, and the user marked each concept of the theme.

## Themes

A theme is a separate area of study. It has its own books, concept map, study queue, and progress.

To create a theme, the user types a name on the home screen. Then the user adds EPUB files to the theme. Each new book adds concepts to the concept map of the theme.

The user works in one theme at a time. Each theme keeps its progress.

For a concept that two books cover, the lesson uses both books.

## Concept map

Each theme has one concept map. The map has modules, and each module has concepts. A module is a group of related concepts, for example "Indexes" in a database book.

Each concept has these properties:

- A name and a one-line objective.
- A kind: `knowledge` or `skill`. A `skill` concept is a task that the user must do, for example write a query.
- A level: `basic`, `intermediate`, or `advanced`.
- The prerequisites: other concepts that the user must know first.
- The sources: the book sections that teach the concept.

Size rule: one concept is an idea that the tutor can teach in 5 to 10 minutes and test with 3 questions.

The user does not write the concept map. The model makes it during ingest. The user can see it on the map screen.

## Ingest

Ingest is the most important step. If ingest misses a concept, the user never sees it. Thus, ingest has three goals:

1. Keep all the text of the book.
2. Find all important concepts.
3. Show the user what ingest skipped, so that the user can fix the gaps.

Ingest keeps a doubtful concept. The user can skip a concept with one click, but the user cannot see a concept that ingest missed.

Until phase 3, the user starts ingest from the command line. In phase 3, the user adds a book on the theme screen. See "Ingest in the app (phase 3)".

Ingest has four stages: parse, extract, review, and merge. Between the parse and the extract stage, the model reads the images. At the end, ingest writes an ingest report.

### Stage 1: Parse

The parser does not use the model. It reads the EPUB file. An EPUB file is a ZIP file with XHTML files, a reading order (the spine), and a table of contents.

The parser does these steps:

1. Read the files in the order of the spine. Thus, the parser also reads files that the table of contents does not list.
2. Classify each file: front matter, chapter, appendix, glossary, index, or back matter. Chapters and appendices become sections. The glossary and the index go into the checklist (see stage 3).
3. Split each chapter into sections at its headings. If a long section has no subheadings, split it by size.
4. Convert each section to Markdown with `turndown` and its GFM plugin (for tables).
5. If the EPUB file has a page list, record the page breaks.

The parser keeps these parts of the text:

- Headings, paragraphs, and lists.
- Tables and code blocks.
- Notes, tips, and warnings (asides).
- Footnotes.
- Figure captions and the alternative text of images.

The parser keeps the data of each image in a format that a model can read: PNG, JPEG, GIF, and WebP. The model reads these images after the parse. See "Stage 1b: Images".

### Stage 1 for PDF files

The PDF reader uses `pdfjs-dist`. It reads only tagged PDF files. A tagged PDF has a structure tree with headings, paragraphs, lists, tables, and figures, as HTML has. Word and many publishing tools make tagged PDF files.

The reader does these steps:

1. Read the outline (the bookmarks). The outline gives the chapters and the sections, with the page and the position of each one.
2. For each page, join the text of each structure element. The font names show bold, italic, and code text.
3. Write each page as XHTML. Then the steps for EPUB files continue: blocks, chapters, sections, and the checklist.

The reader also does these things:

- It removes running headers and footers, because a tagged PDF marks them as artifacts. A page number in the footer becomes the print page label.
- It joins consecutive lines of code into one code block, and it keeps the indentation.
- It joins a paragraph that continues on the next page.
- It joins a chapter label with the chapter name in the outline, for example "CHAPTER 1:" and "SQL Interview Questions".
- It finds the image of each figure. pdf.js draws the image inside the marked content of the figure, so the marked content id connects the two. The reader saves the image as a PNG file, with a longest side of 1568 pixels or less.
- It compares the words of each page with the words of the result, and reports the pages that lost text.

An untagged PDF has only text at positions on the page. Many LaTeX books and all scanned books are untagged. The reader stops with a clear message for these books.

The parser checks its own output:

- It counts the words in each XHTML file and in the Markdown result. A large difference means lost text, and the parser records a warning.
- It records empty sections.
- It records files that belong to no chapter.

### Stage 1b: Images

Some books show code, tables, or query results as images. Without the content of these images, a lesson misses the main example of a section.

The model reads each image of the chapters one time. The result has one of three kinds:

- Code: the text of the code. It becomes a code block in the section.
- Table: a Markdown table in the section.
- Other: a description of one sentence, for example "[Image: A diagram of the three states of a file]".

The result replaces the image in the section. A line before code or a table tells the reader that the tutor read it from an image, because the model can make an error. A code block or a table cannot go into a table cell, so an image in a table cell keeps its placeholder.

The results go to `work/images.json` in the folder of the book. The key of each result is a hash of the image, so each image costs one model call only one time. The `--fresh` option does not remove these results.

If three calls fail in a row, the model probably does not accept images, and the reading stops. Then the sections keep the placeholders, and the command shows a warning. A later run reads the other images. An image larger than 4 MB keeps its placeholder.

The parse report shows a warning with the number of images that have no text.

### Stage 2: Extract

The model reads one chapter at a time. For a chapter with more than about 30,000 tokens, the model reads groups of sections.

The output has one entry for each section of the chapter. Each entry lists the concepts that the section teaches. A section without a new concept must give a reason, for example "introduction", "summary", or "exercises". The code checks that each section has an entry. If an entry is missing, the code asks the model again for that section.

Each concept has the properties from "Concept map" and a short quote from its source section. The code checks that the quote is in the text of the section. Thus, the model cannot add a concept that is not in the book. If the quote is not in the text, the code asks the model one more time. Then it records a warning.

The prompt contains the size rule and a second rule: keep a doubtful concept.

### Stage 3: Review

The author of the book shows what is important. The parser collects these signals into a checklist for each chapter:

- Defined terms: the text in `<dfn>` tags, and bold terms in paragraphs.
- The glossary entries.
- The index entries. If the index has links, each entry points to its section.
- The items of summary, objective, and "key takeaways" sections.

After the extraction, the code compares the checklist with the concepts of the chapter. Then the model gets the chapter text, the concept list, and the checklist items that match no concept. The model does these things:

- It maps each item to an existing concept, adds a new concept for it, or marks it "minor" with a reason.
- It finds other important ideas in the chapter that the concept list does not have. It adds each idea as a new concept, with a quote.

This second look at each chapter finds the concepts that the first look missed.

### Stage 4: Merge

The merge step adds the concepts of the book to the concept map of the theme:

- If a new concept and an existing concept are the same idea, the merge step joins them. The existing concept gets one more source.
- It adds each other new concept to the correct module, or it makes a new module.
- It sets the prerequisites and the level of each new concept.

The merge step does not change or delete existing concepts. Thus, a new book does not change the progress of the user.

In the merge step, the model gets only the names and objectives of the concepts, not the book text. This keeps the merge call small.

### Ingest report

After ingest, the tutor writes a report for the book. In phase 3, the theme screen shows it:

- The parse warnings: lost text, empty sections, and files outside of chapters.
- The number of sections and concepts in each chapter.
- The sections without a concept, with the reason.
- The checklist items with the mark "minor".
- The concepts with a quote that the code did not find.

The report has two actions:

- Add as concept: the model writes a concept for a "minor" item or for a section without a concept.
- Run again: ingest runs the extract and review stages again for one chapter.

The report shows the gaps, and the user decides what to fix.

### References

A reference gives the book, the chapter title, and the section title. If the EPUB file has a page list, the reference also gives the page of the print book.

### Refresh a book

A change to the parser, for example a fix for code blocks or the image texts, changes the text of the sections. `npm run refresh -- <theme> <book>` gives an ingested book the new parse:

1. Parse the book again with the current parser.
2. Read the images that are not in the cache, but only in the chapters with concepts. A book can have concepts from some chapters only, after `ingest --chapters <list>`. Ingest reads the images of the other chapters when it ingests them.
3. Check that each section of the new parse has its row in the database, with the same file. If one section does not match, stop and change no section.
4. Write the section files and the word counts of the sections.

The ids of the sections stay, so the concepts, the progress, the lessons, and the test answers do not change. The command lists the concepts with a lesson from the old text. "Teach it again" writes a new lesson from the new text.

A parser change that splits a book into different sections makes the check fail. Then only `ingest --replace` can update the book. It removes the book row, so all sections get new ids, and the references of the old lessons break.

### Ingest test (later)

To measure ingest, select one chapter and write a list of its concepts by hand. A script runs ingest on the chapter and lists the concepts that ingest missed. Run the script after each change to the ingest prompts, and after each change of the model.

## Select

The user marks concepts on the map screen. The map has one page for all modules. The user marks only the concepts that the user selects. Thus, the user does not take a long test at the start.

Each concept row has these buttons:

- "Learn now": the concept goes to the top of the study queue, and its lesson opens.
- "Add to the queue": the concept goes to the end of the study queue.
- "Test it": the tutor starts a diagnosis of this concept.
- "Skip": the concept becomes `skipped`.

A skipped concept has an "Undo" button next to its status. A concept with a lesson (`learning` or `mastered`) has one button that opens the lesson.

To mark many concepts in one step, the user selects their checkboxes. Each module heading has a "Select all" button. The selection can include concepts from different modules. A concept with a lesson has no checkbox, because its actions are on the lesson page.

If the selection is not empty, a bar at the bottom of the page shows these buttons:

- "Test them": the tutor tests all selected concepts in one diagnosis.
- "Add to the queue": the selected concepts go to the end of the study queue.
- "Skip": the selected concepts become `skipped`.

The buttons send marks to the server. One request can mark concepts from all modules of the theme. The marks have these effects:

- Test: the tutor tests the concept in a diagnosis. All concepts with the mark "Test" in one request go into one diagnosis.
- Learn: the concept goes into the study queue directly, without a test. A concept in the queue keeps its place.
- Skip: the concept becomes `skipped`.
- Later: the concept goes back to `new`. The "Undo" button of a skipped concept sends this mark.

A diagnosis of concepts from one module shows the name of the module. A diagnosis of concepts from different modules has no module.

## Diagnose

For each concept with the mark "Test", the tutor asks 2 questions. At least one of the 2 is a short answer or an apply question. Thus, a guess cannot pass.

Each concept gets one of two results: `known` or `failed`.

## Choose

After the diagnosis, the results screen shows each concept:

- A passed concept becomes `known`. The user can still mark it "Learn" to study it.
- A failed concept shows the questions that the user got wrong. It has a control with two marks: "Learn" and "Skip". The default is "Learn".

The "Done" button sends the choices. Each "Learn" concept goes to the end of the study queue.

## Study queue

The study queue is an ordered list of the concepts that the user wants to learn. Each theme has one queue. The tutor always teaches the first concept in the queue.

The tutor suggests an order with these rules:

1. A prerequisite comes before the concepts that need it.
2. Then the module order.
3. Then the level, from `basic` to `advanced`.

The queue screen gives the user these tools:

- Drag a concept to a new position, with the mouse, a finger, or the keyboard.
- The "Top", "Up", and "Down" buttons move a concept.
- The "Later" button takes a concept out of the queue and sets it back to not started.
- The "Skip" button skips a concept.
- Two equal options put the full queue in an order. Each option is a card with a button and a hint. If the queue already has the order of an option, the card shows "in use" in place of the button.
  - "Use the suggested order" applies the order of the tutor.
  - "Use the book order" puts the queue in the order of the sections in the books. The books come in the order of ingest. A concept with more than one source takes the place of its first section. A concept with no source goes to the end.
- The "Start now" button moves a concept to the top and opens its lesson.

The tutor does not block the order of the user. But it shows a warning on a concept with a prerequisite that is not `known` or `mastered`. Before such a lesson starts, the tutor offers three actions: "Learn the prerequisite first", "Test the prerequisite", or "Continue". The user selects one.

## Teach

The model gets these inputs:

- The concept and its objective.
- The text of all source sections for the concept, from all books of the theme.
- The wrong answers of the user in the diagnosis, for a concept that the user tested. The lesson can then address the specific mistakes.

The model writes the lesson in one call. The lesson contains these parts:

- An explanation in plain words.
- One example. A complex concept can have a second example. The model selects the type of example from the sources, for example a query, a code sample, or a worked case.
- The common mistakes: 0 to 4 points. The model writes only the mistakes that learners really make. If there is no such mistake, the lesson has no list.
- A summary of 1 or 2 sentences, only in a lesson of more than 600 words.
- The references: book, chapter, section, and a short quote.

The length of the lesson follows the concept. A simple concept gets about 150 to 300 words. A complex concept gets up to 1200 words. The prompt has no minimum length and no fixed number of parts, because these make the model add filler. A short lesson also costs less, because the model writes fewer output tokens. The app shows each lesson as formatted Markdown.

After the lesson, the user can ask questions in a chat box below the lesson. The model answers with the same sources in the prompt. Then the user clicks "Test me".

If the lesson was not clear, the user clicks "Teach it again". Then the model writes a new lesson round, from a different angle and with different examples. A concept in a lesson has the status `learning`. Only one concept of a theme has this status.

Each reference contains the exact quote from a source section. The tutor checks each quote against the text of the section. Thus, each reference points to text that is in the book. Each provider makes references in a different way. See "Model".

The lesson prompt tells the model to base the lesson on the sources. The model marks a fact or a claim that is not in the sources with "(not from the books)". These rules keep the marker useful:

- The marker comes one time at the end of a paragraph or a list item, not after each sentence.
- The model does not mark the standard behavior of a language or a tool, or the step-by-step explanation of an example.
- If a source has an error or contradicts itself, the lesson says so in one sentence. Then it teaches the correct form.
- A source can contain an image placeholder, for example "[Image]". The model does not guess the content of the image.

The answers in the chat use the same rules.

## Test

A test has 1 to 3 new questions on the concept. The model selects the questions that fit the concept:

- A simple concept gets one question.
- A concept with more than one part gets one question for each part. Two questions do not test the same thing.

The questions have these kinds:

- Apply: a case or a task, for example write a query, predict a result, find an error, or choose a solution. The user writes the answer, and the grader scores it.
- Explain: a short answer of one or two sentences, for an idea that a case cannot test.
- Recall: a multiple-choice question. The model uses it only to test the recognition of something, for example a term or a rule.

Each test has at least one apply or explain question, because a guess can pass a recall question. For a comparison of two things, the question asks the user to choose one of them for a case.

The user types each answer. Thus, each question asks one thing, and a short answer is enough. The grader checks the understanding, not the completeness of the answer. A typo or a missing explanation does not lower the score.

The limit of 3 questions is the constant `MAX_TEST_QUESTIONS` in `src/tutor/questions.ts`. Most concepts come from one section and have an objective of one sentence. Thus, 3 questions cover them.

The model writes the questions from the sections of the concept. The prompt includes the questions that the user saw before, so that each test has new questions. If the user leaves a test before the end, "Test me" opens the same test again.

To pass, the user must answer each question correctly.

After an answer, the user can click "Retake the question". The tutor then removes the answers of the question and shows the empty question again. This also works in a diagnosis. After the results, the answers of the session do not change, because the results come from them.

After a pass, the concept becomes `mastered` and leaves the queue. The results show the next concept in the queue, with a "Next lesson" button.

For a simple concept, the user can click "Skip the test" on the lesson page. Then the concept becomes `mastered` and leaves the queue, with no model call. The lesson page shows the "Next lesson" button.

After a fail, the tutor shows the wrong answers and offers these actions:

- Teach again: a new lesson starts from the wrong answers. It uses a different example or a different book. Then the tutor gives a new test with new questions. This action is the default.
- Later: the concept moves to the end of the queue.
- Skip: the concept becomes `skipped`.

After a fail, the concept stays `learning` until the user selects an action.

After 3 fails on one concept, the tutor also offers "Test the prerequisites". A weak prerequisite is a frequent cause of repeated fails. This action sets each prerequisite to `to_test` and starts a diagnosis of the prerequisites.

## Grader

The grader scores short answers and apply answers. The model gets the question, the key points of a good answer, and the source section. It returns a score and the key points that the answer does not have:

- 0: wrong.
- 1: partly correct.
- 2: correct.

Only a score of 2 counts as correct.

The user can dispute a grade with a button. A disputed answer counts as correct, and the tutor records the case. Use the recorded cases to improve the grader prompt.

The tutor does not run the code of the user. The model reads the code and grades it. If a grade looks wrong, the user can run the code and dispute the grade.

## Review board (phase 2)

The review board shows what the user learned, at a glance. The user decides what to read again or to test again. The tutor has no review schedule and makes no model call for the board.

The board has three uses:

- See the status of each concept of a theme on one or two screens.
- Find a concept that the user forgot. Open its lesson, read it again, and test it again with "Test me again".
- Keep a list of the most important concepts of the books, with stars.

### The board

The board is a tab of each theme, after "Study queue". The tab label is "Review board".

- A summary line at the top gives the number of concepts in each status group and the number of starred concepts.
- The concepts are in their modules, in the order of the concept map. Each module heading shows how many of its concepts are `known` or `mastered`. Skipped concepts do not count, as in the progress of the theme.
- Each concept has one short line: the status mark, the name, and the star button. The line has no goal, no sources, and no level.
- A click on the name opens the lesson page of the concept.

The board uses the data of the concept map request. It needs no new read endpoint.

### Filters

- Status filter: the user selects one filter at a time. Each filter shows its count. The count also follows the star filter and the search. These are the filters:
  - All.
  - Learned: `known` and `mastered`.
  - Learning: `learning`.
  - In the queue: `queued`.
  - Not chosen: `new`, `to_test`, and `failed`.
  - Skipped: `skipped`.
- Starred: a toggle. It works together with the status filter. For example, "Learned" and "Starred" give the list of the key concepts that the user learned.
- Find: a search box for the concept name.

The address of the page keeps the filters. Thus, a link or a bookmark can open the list of starred concepts. A change of a filter does not add an entry to the history of the browser.

### Test me again

The lesson page of a `mastered` concept has the "Test me again" button. The user reads the lesson again, then tests the concept again.

- The test uses the questions of the last finished test of the concept again. The options of the recall question come in a new order. The test is ready at once, with no model call to write questions.
- If the concept has no finished test, for example after "Skip the test", the model writes new questions, as for "Test me".
- The pass rule is the same as for each test. A pass keeps the concept `mastered`.
- After a fail, the concept stays `mastered`. The results offer the usual actions. "Teach it again" writes a new lesson now. "Later" puts the concept at the end of the study queue. "Skip" skips the concept.

### Stars

The user stars the important concepts. The star has no effect on the status or on the queue. A concept keeps its star after a test, a new lesson, or a skip.

The star button is on the board line, in the header of the lesson page, and on the concept row of the concept map. One click adds the star, and one more click removes it.

## Ingest in the app (phase 3)

Now, ingest runs only from the command line. Phase 3 moves ingest into the app, so that the user adds a book with no terminal. Phase 4 needs this step, because the book files are on the laptop and the tutor is on the server.

The `npm run ingest` command stays. The app and the command use the same ingest code.

### Create a theme

The home screen has a field to create a theme. The user types a name, and the tutor creates an empty theme. Then the theme screen opens, with the "Add book" button.

### Add a book

The theme screen has the "Add book" button. The flow has these steps:

1. The user selects an EPUB file or a tagged PDF file.
2. The browser sends the file to the server. The server keeps the file in `data/uploads/` and parses it. The parse uses no model, so it costs nothing.
3. The app shows the parse result: the chapters, the kept text of each chapter, the parse warnings, and the number of model requests. The command line shows the same data.
4. The user starts a preview or a full run.

If the parser cannot read the file, for example an untagged PDF file, the app shows the message of the parser. Then the app offers no run.

If `.env` has no model, the app shows the parse result and the message about the model. The app shows no start button.

The browser sends the file as the body of one request. Thus, the server needs no package for multipart uploads. The upload route needs a body limit that fits a large PDF file.

The app has two types of run:

- Preview: the user selects some chapters. Ingest runs on these chapters and does not change the database. The app shows the preview concept map and the preview report.
- Full run: ingest runs on all chapters and saves the result. The chapters of an earlier preview come from the cache and cost nothing.

The command can also save some chapters to the database: `--chapters` without `--preview`. The command also keeps the options `--fresh` and `--replace`. The app does not offer these runs and options.

Before each run, the app shows the number of model requests, as the command does. If ingest reads the images of the book (milestone 13 in `PLAN.md`), the number includes the images.

A theme can get a second book in phase 3, because the merge step exists already. Phase 5 tests the merge on real books and makes it better.

### Progress

Ingest of a full book takes a long time. Thus, ingest runs in the background, in the server process, as the preparation of a diagnosis does. The tutor has no job queue.

- The new table `ingests` keeps each run, with its status and its progress. See "Data model".
- The theme screen shows the run in progress: the current step, for example "Chapter 4 of 12: review", and the "Stop" button. The app asks the server for the progress every few seconds.
- "Stop" ends the run after the current chapter. The finished chapters stay in the cache. Thus, the next run does not pay for them again.
- Only one ingest runs at a time. Two runs on one theme can overwrite the merge result of each other.
- If the server stops during a run, the run becomes `failed` at the next start. A new run continues from the cache.
- A full run saves the book, its sections, and the concept map in one transaction at the end, as now. Thus, a run that fails or stops does not change the concept map.

### Ingest report in the app

After a run, the theme screen shows the ingest report of the book. The section "Ingest report" gives the content. The app reads the report from the `ingest-report.json` file of the book.

The two actions of the report work in this way:

- Add as concept: the model writes one concept for a "minor" item or for a section without a concept. Then the merge step adds the concept to the concept map.
- Run again: ingest runs the extract and review stages again for one chapter, with no cache. Then the merge step adds the new concepts.

"Run again" keeps the section rows and their IDs. It adds concepts and sources. It does not remove a concept or change its progress.

The app does not offer a full replace of a saved book. A replace removes the book row, and all sections get new IDs. Then the old lessons and the old questions lose their sections.

## Self-hosted release (phase 4)

Phase 4 makes the tutor ready for other people to run. The tutor is free and open source on GitHub. Each user runs their own copy, with their own books and their own API key. Then the user can learn on each device, for example a phone or a second computer.

The project offers no public hosted version. A hosted service stores the text of books that its users bought, and sends the text to model providers. One developer cannot carry this copyright risk.

Each copy of the tutor stays an app for one user.

### Where a user can run the tutor

- Laptop: `npm start`, as now. This needs no Docker and no login.
- Laptop or home server, with Tailscale: Tailscale connects the devices of the user in a private network. The phone reaches the tutor with no public address.
- Rented server: any virtual private server (VPS) with Docker. The compose file of the tutor does the full setup. See "Compose file".
- Server with a reverse proxy already, for example Traefik: the user runs the image behind the existing proxy.
- Platforms with a persistent disk, for example Fly.io, Railway, or Render. Self-hosted platforms such as Coolify or Dokku can also run the compose file.

### Platforms that do not fit

Serverless platforms such as Vercel do not fit the tutor:

- They keep no files between requests. Thus, `tutor.db` and `data/` disappear.
- They stop each request after a time limit. Ingest runs in the background for many minutes.
- A port to such a platform needs a hosted database, file storage, and a job queue. This is a rewrite, and the tutor stays a light build.

### Container image

- A `Dockerfile` builds the image with Node.js 22. The image builds the app one time. On the laptop, `npm start` builds the app at each start, as now.
- A GitHub Action builds the image for each release, for amd64 and arm64 processors. It publishes the image to the GitHub Container Registry (`ghcr.io`).
- `better-sqlite3` is a native module. The published image has the build for each processor type, so the user builds nothing.
- The image has a tag for each version and the tag `latest`. To stay on one version, set its tag in `compose.yaml`.
- The image keeps the data in `/app/data`. A volume must hold this folder. Without a volume, the data disappears at the next update.
- The image has no `.env` file. On a server, the `.env` file is next to the compose file. On a platform, the same values go into the environment variables of the platform.
- The route `/health` answers without a login. The health checks of the platforms use it.

### Compose file

The repository has a `compose.yaml` file and a `Caddyfile`. Caddy is a web server that gets HTTPS certificates automatically. The compose file starts the tutor and Caddy.

To run the tutor on a rented server:

1. Install Docker on the server.
2. Point a domain name to the address of the server.
3. Copy `compose.yaml`, `Caddyfile`, and `.env.example` to the server.
4. Copy `.env.example` to `.env`.
5. In `.env`, set the model, the API key, `TUTOR_PASSWORD`, and `DOMAIN`.
6. Run `docker compose up -d`.

On a server with a reverse proxy already, remove the Caddy service from the compose file. Then connect the tutor to the existing proxy. The guide gives an example for Traefik.

### Platform guides

Each platform guide is a short file in `docs/deploy/`. If the platform needs a config file, the guide gives it. For example, Fly.io uses `fly.toml`.

Write a guide only after a test deploy on that platform. Start with the compose file, then add one platform at a time.

Each guide tells the user to do these steps:

- Attach a persistent disk at `/app/data`. Free plans often have no persistent disk.
- Run exactly one instance, because SQLite works with one process on one disk.
- Turn off the automatic stop of idle machines. A stopped machine stops an ingest run.
- Set the timeouts of the platform so that a long lesson request and a large upload can finish.

### Login

On the laptop, the server listens on localhost only, so it needs no login. On a server, other people can reach the tutor. It holds the text of books that the user bought, and each model request costs money. Thus, each request needs a login.

- The new value `HOST` in `.env` sets the address of the server. The default stays `127.0.0.1`.
- The new value `TUTOR_PASSWORD` in `.env` sets the password.
- If `HOST` is not a localhost address and `TUTOR_PASSWORD` is empty, the server does not start. It shows a clear message.
- The login page asks for the password. After a correct password, the server sets a login cookie for 30 days. The cookie is `HttpOnly`, `Secure`, and `SameSite=Strict`.
- The server signs the cookie with a key from the password. Thus, a new password ends all logins.
- After a wrong password, the server waits 2 seconds before it answers. This makes a password guess slow.
- Each route needs the cookie, except the login page, the login request, and `/health`.
- The tutor has no user accounts and no user table.

### Data on the server

After the move, the server has the only copy of the data. Do not use the tutor on the laptop with a second copy of `data/`. The two copies change in different ways, and the tutor cannot join them.

To move the data:

1. Stop the tutor on the laptop.
2. Copy `data/` to the volume of the server, for example with `rsync`.
3. Start the container. The migrations run at the start, as on the laptop.

SQLite uses a write-ahead log (WAL), a second file with the recent changes. Thus, a plain copy of `tutor.db` can be incomplete. Make backups in this way:

- The new command `npm run backup` writes a copy of `tutor.db` with the backup function of SQLite.
- A daily cron job on the server runs the command in the container.
- Copy the backups and the book folders to a second place, for example the laptop.

### Updates

On a server with the compose file:

1. Make a backup, because a new version can run a migration.
2. Run `docker compose pull` to get the new image.
3. Run `docker compose up -d` to start the new version.

On a platform, make a backup, then deploy the new image. The guide of the platform gives the steps.

### Phone use

The user can open the tutor on a phone. Check each screen at phone width, and correct the layout where necessary. Check the lesson, the test, the study queue, the review board, and the concept map first.

### Long requests

Some requests wait for the model, for example a new lesson. A book upload can also be large. Make sure that the timeouts of the proxy let these requests finish.

### Before the repository becomes public

- Scan the full git history for book text, for example in test fixtures or in copied model output. `data/` is not in git, but an old commit can contain an excerpt.
- If the scan finds book text, remove it from the history before the release.
- Select a license. See "Open questions".
- The README tells the user that the project ships no books. Each user brings books that they own.
- The README tells the user that each model request sends book text to the provider that the user selects.

## Concept status

- `new`: the user did not mark the concept yet.
- `to_test`: the user marked it "Test". It waits for the diagnosis.
- `known`: passed the diagnosis.
- `failed`: failed the diagnosis. It waits for the choice of the user.
- `queued`: in the study queue.
- `learning`: the current concept in a teach and test loop.
- `mastered`: passed a test after a lesson, or skipped the test.
- `skipped`: the user skipped it. The user can undo this on the map screen.

## Screens

- Home: the list of themes, with the progress of each theme. A field to create a new theme (phase 3).
- Theme: the books of the theme and the progress. In phase 3: the "Add book" button, the ingest progress, and the ingest report of each book. Until then, ingest runs from the command line. The "Next to learn" card opens the lesson of the first concept in the queue.
- Map: the modules and concepts, with the status, the star, and the sources of each concept. Mark one concept with its buttons, or select many concepts and mark them in one step. Undo a skip here. A module on the theme screen opens the map at that module.
- Diagnosis: the questions one at a time. Then the results, with the "Learn" and "Skip" choices.
- Queue: the study queue, with drag and drop and the queue buttons.
- Review board: one short line for each concept, with the status filters, the star filter, and the search. See "Review board".
- Lesson: the lesson, the chat box, and the "Test me" and "Skip the test" buttons. The header has the star button. A `mastered` concept has the "Test me again" button.
- Test: the questions, the results, and the actions after a fail.

## Components

```
 Browser (React app)
        │  HTTP on localhost, or HTTPS with a login on a server (phase 4)
        ▼
 [Server] ──► [Ingest] ──► data/themes/<theme>/sections/ (Markdown)
    │
    ├──► [Tutor loop]: select, diagnose, queue, teach, test, board
    │         │
    │         ├──► [Grader]
    │         └──► [Model client] ──► Anthropic, OpenAI, or OpenRouter
    │
    └──► SQLite: themes, books, concept map, progress
```

## Data model (SQLite)

```sql
themes           (id, slug, name, created_at)
books            (id, theme_id, title, file, status, created_at)
sections         (id, book_id, chapter, number, chapter_title, title, page, path, words)
modules          (id, theme_id, position, name)
concepts         (id, theme_id, module_id, slug, name, objective, kind, level, status, queue_pos, starred)
concept_sources  (concept_id, section_id, quote)
concept_prereqs  (concept_id, prereq_id)
questions        (id, concept_id, purpose, kind, text, choices, answer, key_points, section_id)
attempts         (id, question_id, answer, score, feedback, disputed, created_at)
lessons          (id, concept_id, round, text, refs, created_at)
lesson_messages  (id, lesson_id, role, text, created_at)
ingests          (id, theme_id, file, title, mode, chapters, status, done, total, step, error, created_at)
```

- `books.status`: `ingesting`, `ready`, or `failed`. The tutor saves a book only at the end of a full run, so a saved book is `ready`.
- `sections.page`: the print page from the EPUB page list. For an EPUB file without a page list, it is empty.
- `questions.purpose`: `diagnose` or `test`.
- `questions.kind`: `choice`, `short`, or `apply`.
- `concepts.status`: see "Concept status".
- `concepts.queue_pos`: the position in the study queue. It is empty for a concept that is not in the queue.
- `concepts.starred`: 1 for a concept with a star, else 0.
- `ingests` (phase 3): one row for each ingest run in the app.
- `ingests.mode`: `preview`, `full`, or `chapter`. The mode `chapter` is "Run again" for one chapter.
- `ingests.chapters`: the chapters of a preview, as a JSON list. It is empty for a full run.
- `ingests.status`: `running`, `done`, `stopped`, or `failed`.
- `ingests.done` and `ingests.total`: the finished chapters and all chapters of the run.
- `ingests.step`: the current step, for example "Chapter 4 of 12: review".

The concept map is in SQLite, because the merge step changes it for each new book. The section text stays in Markdown files.

## Stack

- TypeScript on Node.js, for the server and for the app.
- Fastify for the HTTP server. On the laptop, the server listens on localhost only. On a server (phase 4), it needs a login.
- React with Vite for the app in the browser.
- SQLite with `better-sqlite3`.
- `jszip` to read EPUB files, and `turndown` to convert XHTML to Markdown.
- The Anthropic TypeScript SDK and the OpenAI TypeScript SDK (software development kits), behind one interface. See "Model".
- zod for the JSON schemas and for the check of model output.

The design has no Telegram bot, no job queue, no vector database, and no cloud services. In phase 4, the tutor runs in one container. The concept map links each concept to its sections. Thus, the tutor needs no search.

## Model

The tutor uses one model for all of its work. The user selects the model in the `.env` file, from one of three providers:

- Anthropic: Claude models, through the Anthropic TypeScript SDK.
- OpenAI: OpenAI models, through the OpenAI TypeScript SDK.
- OpenRouter: models from many vendors, through the OpenAI TypeScript SDK. The OpenRouter API is compatible with the OpenAI API, so the client only changes the base URL to `https://openrouter.ai/api/v1`.

```
LLM_PROVIDER=        # anthropic, openai, or openrouter
LLM_MODEL=           # the model name, exactly as the provider writes it
LLM_REASONING=       # none, minimal, low, medium, high, xhigh, or max. Empty: the default of the model.
OPENROUTER_PROVIDERS= # OpenRouter only: the providers that can serve the model, in order. Empty: OpenRouter selects.
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
OPENROUTER_API_KEY=
```

OpenRouter sends each request to one of several providers that serve the model. The providers differ in speed, price, and quality. With `OPENROUTER_PROVIDERS`, the user selects the providers. The tutor sends them as the `order` list with `allow_fallbacks: false`, so no other provider gets the request.

The tutor has no default model. The tutor sends `LLM_REASONING` to the reasoning setting of the provider. Each model accepts only some of the levels. If the model does not accept the level, the tutor shows the error message of the provider.

If `LLM_PROVIDER`, `LLM_MODEL`, or the key of the selected provider is empty, a step that needs the model stops with a clear message. To change the model, edit `.env` and start the tutor again.

The file `.env.example` shows the format. Copy it to `.env` and fill in the values. Do not commit the `.env` file. A value in `.env` replaces the same variable from the shell. An empty value in `.env` does not change the shell value.

### Model client

The tutor code calls one small interface, not a provider SDK. At start, the tutor makes the client for the provider in `.env`.

```ts
// One book section that the model can use and cite.
interface Source { id: string; title: string; text: string }

// One reference in a lesson: the source and the exact quote from it.
// The text marks the reference with its number, for example "[2]".
interface Reference { number: number; sourceId: string; quote: string }

// An image for the model, for example a code image of a book.
interface ImageInput { mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: Uint8Array }

interface LlmClient {
  // Return JSON that matches the schema.
  // The images come before the prompt.
  object<T>(req: {
    system: string; sources?: Source[]; images?: ImageInput[]; prompt: string; schema: z.ZodType<T>;
  }): Promise<T>;

  // Return free text, with references to the sources.
  text(req: {
    system: string; sources: Source[]; messages: Message[];
  }): Promise<{ text: string; references: Reference[] }>;
}
```

Two classes implement the interface:

- `AnthropicClient` for Anthropic.
- `OpenAiClient` for OpenAI and OpenRouter.

The two classes do the same work in different ways:

- JSON output: each client sends the zod schema as a JSON schema. If a model does not accept a JSON schema, the client asks for JSON in the prompt. The client checks each result with zod. If the check fails, the client tries one more time.
- References: `AnthropicClient` uses the citations of the Anthropic API. `OpenAiClient` tells the model to cite with markers, for example `[S3: "exact quote"]`. Each client returns the same `Reference` list.
- Prompt cache: each client puts the sources at the start of the prompt, in the same order for each call. `AnthropicClient` adds a cache marker after the sources. OpenAI caches long prompt prefixes without a marker.
- Reasoning level: `OpenAiClient` sends `reasoning_effort` to OpenAI. OpenRouter uses a different format, so the client sends `reasoning: { effort }` to OpenRouter.
- Empty answers: some reasoning models on OpenRouter sometimes return an empty answer with a normal finish. The text is then only in the reasoning field. After an empty answer, `OpenAiClient` asks one more time. After a second empty answer, it shows an error with the finish reason, the token counts, and the provider. The tutor never saves an empty lesson or an empty chat answer.
- Images: `AnthropicClient` sends each image as a base64 image block. `OpenAiClient` sends each image as a data URL. OpenRouter accepts the same format.
- Log: each client writes one line for each model call, with the time and the result. The server and `npm run llm:check` print the lines. The tests print nothing.

For each provider, the tutor checks that each quote is in the text of its source. If a quote is not in the source, the tutor removes the reference. If a lesson has no valid reference, the tutor shows a warning on the lesson.

For some Claude models (Claude Fable 5.1, Claude Opus 5.5, Claude Opus 5, and Claude Sonnet 5.5), `AnthropicClient` turns on the server-side fallback. If the model refuses a request, the API runs the request again on a different Claude model.

To check the model in `.env`, run `npm run llm:check`. The command sends one JSON request, one text request with references, and one request with an image. If the model does not accept images, the command says so. The other parts of the tutor work without images.

### Cost

These numbers are rough estimates for one large model (Claude Opus 5.5) from the list prices. Other models have other prices. Measure the real cost in the first week.

- Ingest of one book of 300 pages, with the review stage: about $2 to $5, one time.
- One concept loop, with the lesson, the questions, the test, and the grades: about $0.10 to $0.40.
- A theme with 100 concepts in the study queue: about $10 to $40.

## Where it runs

Until phase 4, the tutor runs on the laptop of the user. Start it with `npm start`, then open `http://localhost:3000` in a browser. The laptop needs no Docker.

In phase 4, the user can also run the tutor on a home server, a rented server, or a platform. See "Self-hosted release (phase 4)".

A Telegram client on the phone is an option for later. It needs a server, as in phase 4.

## Repository layout

```
data/                 (not in git)
  tutor.db            SQLite database
  themes/<theme>/
    concept-map.md    the concept map of the theme, for people to read
    books/<book>/
      <book file>     a copy of the EPUB or PDF file
      sections/       section text in Markdown
      work/           cached results of the extract and review stages, and the image texts
      parse-report.json
      ingest-report.json
  uploads/            uploaded book files that wait for ingest (phase 3)
src/
  server/             HTTP API
  app/                React app
  ingest/core/        blocks, sections, Markdown, checklist (all formats)
  ingest/epub/        EPUB reader
  ingest/pdf/         tagged PDF reader
  ingest/             concept extraction, merge
  tutor/              select, diagnose, queue, teach, test, board
  grader/             scores for short and apply answers
  llm/                model client for each provider, and prompts
  db/                 SQLite schema and queries
.env                  the provider, the model, and the API keys (not in git)
.env.example          the format of .env
Dockerfile            the container image (phase 4)
compose.yaml          the tutor and Caddy, for a rented server (phase 4)
Caddyfile             the HTTPS setup for Caddy (phase 4)
docs/deploy/          one guide for each platform (phase 4)
.github/workflows/    the build of the image for each release (phase 4)
```

Do not commit `data/`. It contains the text of books that the user bought, and the progress of the user.

## Phases

Each phase ends with a tool that the user can learn with.

1. Phase 1: the app, with themes and one book for each theme. Add EPUB ingest with the parse checks, the review stage, and the ingest report. Add the concept map, select and diagnose, the study queue, lessons with references, and tests with multiple-choice and short answers. Add the model client and the `.env` file.
2. Phase 2: the review board and the stars. The user sees what they learned, tests a concept again, and keeps a list of the key concepts.
3. Phase 3: ingest in the app. The user creates a theme, adds a book, follows the progress, and reads the ingest report in the app. See "Ingest in the app (phase 3)".
4. Phase 4: the self-hosted release. Each user runs their own copy on a laptop, a home server, a rented server, or a platform, with a password and HTTPS. See "Self-hosted release (phase 4)".
5. Phase 5: more books for each theme. Test the merge step on real books and make it better.
6. Later: the ingest test, a Telegram client, and untagged PDF files.

## Risks

1. The merge step can join two different ideas, or keep two copies of one idea. Test the merge on two books of one theme early in phase 5. The map screen shows the sources of each concept, so bad merges are easy to see.
2. A guess can pass a multiple-choice question. Thus, each diagnosis and each test includes a short answer or an apply question.
3. The model can teach content that is not in the books. The checked references and the "not from the books" mark make this content visible.
4. Two books can split one idea into concepts of different sizes. The size rule in "Concept map" tells the model the correct size.
5. The user can skip a prerequisite or put it late in the queue. Then the concepts that need it are harder to learn. The prerequisite warnings in the queue show this risk, but the user still decides.
6. Models differ in quality and in support for JSON schemas. A weak model can write bad questions or wrong grades. The zod check, the retry, and the reference check find bad output.
7. With OpenRouter, the prompts and the book text go to the vendor of the selected model. Read the data policy of each vendor before you use it.
8. EPUB files differ in structure. Some have a poor table of contents or few headings, and then the split into sections is bad. The parse checks and the ingest report show these problems.
9. No method finds all concepts. The review stage and the ingest report make a missed concept visible, and the user can add it.

## Open questions

- Phase 4: the license of the repository.
