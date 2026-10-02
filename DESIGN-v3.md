# Engineering Skills Tutor: Design

Status: draft 3, revision 8. Date: 2026-10-02. This file replaces `DESIGN.md` (draft 2).

## Purpose

The tutor helps one user learn from books that the user owns. The user groups the books into themes of study. For each theme, the tutor finds the concepts that the user does not know. Then it teaches those concepts one at a time and tests each one.

The tutor is a learning tool. It is not a job-search tool.

The tutor uses one large language model (LLM) from Anthropic, OpenAI, or OpenRouter. The text in this file calls the LLM "the model".

## Decisions

- Themes are neutral. The tutor has no built-in themes and no code for a specific subject. The user creates a theme with a name and adds books to it. The books define the content of the theme.
- Books are EPUB files or tagged PDF files.
- Phase 1 is a local app on the laptop of the user. It has no Telegram bot and no other messaging.
- The review schedule is part of the design.
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

1. Select: the tutor shows the concepts of a module. The user marks each concept "Test", "Learn", or "Skip".
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
- A kind: `knowledge` or `skill`. A `skill` concept can get hands-on exercises.
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

The user adds a book on the theme screen. The app copies the EPUB file into the data folder of the theme and starts ingest. The theme screen shows the progress.

Ingest has four stages: parse, extract, review, and merge. At the end, it writes an ingest report.

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

The parser does not read the content of images. Thus, a diagram without a caption or alternative text is lost. Image descriptions are an option for later, with a model that reads images.

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
- It compares the words of each page with the words of the result, and reports the pages that lost text.

An untagged PDF has only text at positions on the page. Many LaTeX books and all scanned books are untagged. The reader stops with a clear message for these books. Some PDF books show code as images. The parser does not read these images.

The parser checks its own output:

- It counts the words in each XHTML file and in the Markdown result. A large difference means lost text, and the parser records a warning.
- It records empty sections.
- It records files that belong to no chapter.

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

After ingest, the theme screen shows a report for the book:

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

### Ingest test (later)

To measure ingest, select one chapter and write a list of its concepts by hand. A script runs ingest on the chapter and lists the concepts that ingest missed. Run the script after each change to the ingest prompts, and after each change of the model.

## Select

The user selects one module at a time. The tutor suggests the next module in the map order, but the user can open any module on the map screen. Thus, the user does not take a long test at the start.

The module screen lists the concepts of the module with their objectives. Each concept that has no mark yet has a control with four marks: "Test", "Learn", "Skip", and "Later". The default mark is "Later", so that the user tests only the concepts that the user selects. A "Mark all as" control changes all marks in one step. The "Start the test" button sends the marks.

The screen also lists the concepts that the user marked already, with their status. The "Change" button lets the user give such a concept a new mark. Thus, the user can correct a wrong mark.

The marks have these effects:

- Test: the tutor tests the concept in the diagnosis.
- Learn: the concept goes into the study queue directly, without a test.
- Skip: the concept becomes `skipped`. The user can change this mark later.
- Later: the concept stays `new`, or goes back to `new`. The user decides later.

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

- Drag a concept to a new position.
- The "Top" button moves a concept to the top.
- The "Start now" button moves a concept to the top and starts its lesson.
- The "Skip" button skips a concept.
- The "Suggested order" button applies the order of the tutor to the full queue.

The tutor does not block the order of the user. But it shows a warning on a concept with a prerequisite that is not `known` or `mastered`. Before such a lesson starts, the tutor offers three actions: "Learn the prerequisite first", "Test the prerequisite", or "Continue". The user selects one.

## Teach

The model gets these inputs:

- The concept and its objective.
- The text of all source sections for the concept, from all books of the theme.
- The wrong answers of the user in the diagnosis, for a concept that the user tested. The lesson can then address the specific mistakes.

The lesson contains these parts:

- An explanation in plain words.
- One or two examples. The model selects the type of example from the sources, for example a query, a code sample, or a worked case.
- The common mistakes.
- The references: book, chapter, section, and a short quote.

A lesson takes 5 to 10 minutes to read. The app shows the lesson as formatted Markdown.

After the lesson, the user can ask questions in a chat box below the lesson. The model answers with the same sources in the prompt. Then the user clicks "Test me".

Each reference contains the exact quote from a source section. The tutor checks each quote against the text of the section. Thus, each reference points to text that is in the book. Each provider makes references in a different way. See "Model".

The lesson prompt tells the model to base the lesson on the sources. The model must mark other content as "not from the books".

## Test

A test has 3 new questions on the concept:

1. Recall: a multiple-choice question.
2. Explain: a short answer of 1 to 3 sentences.
3. Apply: a scenario or a task. If the theme has an exercise runner, the apply question of a `skill` concept is a hands-on exercise.

To pass, the user must answer 2 of the 3 questions correctly. One of the 2 must be the apply question.

After a pass, the concept becomes `mastered`, and the tutor goes to the next concept in the queue.

After a fail, the tutor shows the wrong answers and offers these actions:

- Teach again: a new lesson starts from the wrong answers. It uses a different example or a different book. Then the tutor gives a new test with new questions. This action is the default.
- Later: the concept moves to the end of the queue.
- Skip: the concept becomes `skipped`.

After 3 fails on one concept, the tutor also offers "Test the prerequisites". A weak prerequisite is a frequent cause of repeated fails.

## Grader

The grader scores short answers and written apply answers. The model gets the question, the key points of a good answer, and the source section. It returns a score and the key points that the answer does not have:

- 0: wrong.
- 1: partly correct.
- 2: correct.

Only a score of 2 counts as correct.

The user can dispute a grade with a button. A disputed answer counts as correct, and the tutor records the case. Use the recorded cases to improve the grader prompt.

## Review

A concept that the user learns one time fades after some weeks. A short review keeps it:

- After a concept becomes `known` or `mastered`, it gets review dates 3, 10, 30, and 90 days later.
- On each date, the user gets one question on the concept.
- Each session starts with the reviews that are due, a maximum of 5.
- A wrong review answer sets the concept to `failed`. Then the user selects "Learn" or "Skip".

## Exercise runners (phase 4)

An exercise runner is an optional plug-in. It runs the answer of the user and checks it with a program. The tutor has no runner by default. The user can turn on a runner for a theme on the theme screen. For example, the user can turn on the SQL runner for a theme about databases.

Without a runner, the apply question is a written task, and the grader scores it.

With a runner, a program decides pass or fail. Then the model explains the problems. The model does not decide pass or fail.

Before the tutor gives an exercise, it runs the reference solution against the check. If the reference solution fails, the tutor discards the exercise. This step stops exercises that contain errors from the model.

These runners are planned:

- SQL runner: it runs the query of the user and the reference query on a sandbox database. Then it compares the result sets. For tuning tasks, it compares the `EXPLAIN ANALYZE` output. The database engine is a setting of the runner.
- TypeScript runner: it runs `tsc --strict` and the tests that the model wrote.
- Testing runner: the tutor supplies code, and the user writes tests for it. The tests must pass on the correct code. They must also fail on 3 to 5 hidden copies of the code with one bug each (mutants).

The user writes the answer in a code box in the app. The runners use Docker containers. Thus, the tutor needs Docker only from phase 4.

## Concept status

- `new`: the user did not mark the concept yet.
- `to_test`: the user marked it "Test". It waits for the diagnosis.
- `known`: passed the diagnosis.
- `failed`: failed the diagnosis or a review. It waits for the choice of the user.
- `queued`: in the study queue.
- `learning`: the current concept in a teach and test loop.
- `mastered`: passed a test after a lesson.
- `skipped`: the user skipped it. The user can undo this on the map screen.

## Screens

- Home: the list of themes, with the queue length and the due reviews of each theme. A field to create a new theme.
- Theme: the books of the theme and the progress. Later: the "Add book" button, the ingest progress, and the ingest report of each book. Until then, ingest runs from the command line. The "Start session" button starts the due reviews, then the first concept in the queue.
- Map: the modules and concepts, with the status and the sources of each concept. Open a module here to mark its concepts. Undo a skip here.
- Diagnosis: the questions one at a time. Then the results, with the "Learn" and "Skip" choices.
- Queue: the study queue, with drag and drop and the queue buttons.
- Lesson: the lesson with its references, the chat box, and the "Test me" button.
- Test: the questions, the results, and the actions after a fail.

## Components

```
 Browser (React app)
        │  HTTP, localhost only
        ▼
 [Server] ──► [Ingest] ──► data/themes/<theme>/sections/ (Markdown)
    │
    ├──► [Tutor loop]: select, diagnose, queue, teach, test, review
    │         │
    │         ├──► [Grader]
    │         ├──► [Model client] ──► Anthropic, OpenAI, or OpenRouter
    │         └──► [Exercise runners] (phase 4)
    │
    └──► SQLite: themes, books, concept map, progress
```

## Data model (SQLite)

```sql
themes           (id, slug, name, runners, created_at)
books            (id, theme_id, title, file, status, created_at)
sections         (id, book_id, chapter, number, chapter_title, title, page, path, words)
modules          (id, theme_id, position, name)
concepts         (id, theme_id, module_id, slug, name, objective, kind, level, status, queue_pos, review_step, review_at)
concept_sources  (concept_id, section_id, quote)
concept_prereqs  (concept_id, prereq_id)
questions        (id, concept_id, purpose, kind, text, choices, answer, key_points, section_id)
attempts         (id, question_id, answer, score, feedback, disputed, created_at)
lessons          (id, concept_id, round, text, created_at)
lesson_messages  (id, lesson_id, role, text, created_at)
exercises        (id, concept_id, runner, spec, status, created_at)
```

- `themes.runners`: the exercise runners that the user turned on for the theme (phase 4).
- `books.status`: `ingesting`, `ready`, or `failed`.
- `sections.page`: the print page from the EPUB page list. For an EPUB file without a page list, it is empty.
- `questions.purpose`: `diagnose`, `test`, or `review`.
- `questions.kind`: `choice`, `short`, or `apply`.
- `concepts.status`: see "Concept status".
- `concepts.queue_pos`: the position in the study queue. It is empty for a concept that is not in the queue.

The concept map is in SQLite, because the merge step changes it for each new book. The section text stays in Markdown files.

## Stack

- TypeScript on Node.js, for the server and for the app.
- Fastify for the HTTP server. The server listens on localhost only.
- React with Vite for the app in the browser.
- SQLite with `better-sqlite3`.
- `jszip` to read EPUB files, and `turndown` to convert XHTML to Markdown.
- The Anthropic TypeScript SDK and the OpenAI TypeScript SDK (software development kits), behind one interface. See "Model".
- zod for the JSON schemas and for the check of model output.

The design has no Telegram bot, no job queue, no vector database, and no cloud account. The concept map links each concept to its sections. Thus, the tutor needs no search.

## Model

The tutor uses one model for all of its work. The user selects the model in the `.env` file, from one of three providers:

- Anthropic: Claude models, through the Anthropic TypeScript SDK.
- OpenAI: OpenAI models, through the OpenAI TypeScript SDK.
- OpenRouter: models from many vendors, through the OpenAI TypeScript SDK. The OpenRouter API is compatible with the OpenAI API, so the client only changes the base URL to `https://openrouter.ai/api/v1`.

```
LLM_PROVIDER=        # anthropic, openai, or openrouter
LLM_MODEL=           # the model name, exactly as the provider writes it
LLM_REASONING=       # none, minimal, low, medium, high, xhigh, or max. Empty: the default of the model.
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
OPENROUTER_API_KEY=
```

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

interface LlmClient {
  // Return JSON that matches the schema.
  object<T>(req: {
    system: string; sources?: Source[]; prompt: string; schema: z.ZodType<T>;
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

For each provider, the tutor checks that each quote is in the text of its source. If a quote is not in the source, the tutor removes the reference. If a lesson has no valid reference, the tutor shows a warning on the lesson.

For some Claude models (Claude Fable 5.1, Claude Opus 5.5, Claude Opus 5, and Claude Sonnet 5.5), `AnthropicClient` turns on the server-side fallback. If the model refuses a request, the API runs the request again on a different Claude model.

To check the model in `.env`, run `npm run llm:check`. The command sends one JSON request and one text request with references.

### Cost

These numbers are rough estimates for one large model (Claude Opus 5.5) from the list prices. Other models have other prices. Measure the real cost in the first week.

- Ingest of one book of 300 pages, with the review stage: about $2 to $5, one time.
- One concept loop, with the lesson, the questions, the test, and the grades: about $0.10 to $0.40.
- A theme with 100 concepts in the study queue: about $10 to $40.

## Where it runs

The tutor runs on the laptop of the user. Start it with `npm start`, then open `http://localhost:3000` in a browser. Phase 1 needs no Docker.

A Telegram client for reviews on the phone is an option for later. A move to a server is also an option for later.

## Repository layout

```
data/                 (not in git)
  tutor.db            SQLite database
  themes/<theme>/
    concept-map.md    the concept map of the theme, for people to read
    books/<book>/
      <book file>     a copy of the EPUB or PDF file
      sections/       section text in Markdown
      work/           cached results of the extract and review stages
      parse-report.json
      ingest-report.json
src/
  server/             HTTP API
  app/                React app
  ingest/core/        blocks, sections, Markdown, checklist (all formats)
  ingest/epub/        EPUB reader
  ingest/pdf/         tagged PDF reader
  ingest/             concept extraction, merge
  tutor/              select, diagnose, queue, teach, test, review
  grader/             scores for short and apply answers
  llm/                model client for each provider, and prompts
  db/                 SQLite schema and queries
  runners/            exercise runners (phase 4)
.env                  the provider, the model, and the API keys (not in git)
.env.example          the format of .env
```

Do not commit `data/`. It contains the text of books that the user bought, and the progress of the user.

## Phases

Each phase ends with a tool that the user can learn with.

1. Phase 1: the app, with themes and one book for each theme. Add EPUB ingest with the parse checks, the review stage, and the ingest report. Add the concept map, select and diagnose, the study queue, lessons with references, and tests with multiple-choice and short answers. Add the model client and the `.env` file.
2. Phase 2: more books for each theme, with the merge step.
3. Phase 3: the review schedule and the progress views.
4. Phase 4: the exercise runners and Docker.
5. Later: the ingest test, image descriptions, a Telegram client for reviews, more runners, untagged PDF files, and a move to a server.

## Risks

1. The merge step can join two different ideas, or keep two copies of one idea. Test the merge on two books of one theme early in phase 2. The map screen shows the sources of each concept, so bad merges are easy to see.
2. A guess can pass a multiple-choice question. Thus, each diagnosis and each test includes a short answer or an apply question.
3. The model can teach content that is not in the books. The checked references and the "not from the books" mark make this content visible.
4. Two books can split one idea into concepts of different sizes. The size rule in "Concept map" tells the model the correct size.
5. The user can skip a prerequisite or put it late in the queue. Then the concepts that need it are harder to learn. The prerequisite warnings in the queue show this risk, but the user still decides.
6. Models differ in quality and in support for JSON schemas. A weak model can write bad questions or wrong grades. The zod check, the retry, and the reference check find bad output.
7. With OpenRouter, the prompts and the book text go to the vendor of the selected model. Read the data policy of each vendor before you use it.
8. EPUB files differ in structure. Some have a poor table of contents or few headings, and then the split into sections is bad. The parse checks and the ingest report show these problems.
9. No method finds all concepts. The review stage and the ingest report make a missed concept visible, and the user can add it.

## Open questions

None at this time.
