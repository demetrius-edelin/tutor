# Engineering Skills Tutor

A personal tutor that teaches from your own books. You make a theme of study, for example "SQL", and add books to it. The tutor finds the concepts in the books and checks which concepts you know. Then it teaches the other concepts one at a time, with references to the books, and tests each one.

The tutor runs on your computer. It uses one large language model (LLM) from Anthropic, OpenAI, or OpenRouter. You select the model.

## Status

Phase 1 and phase 2 are complete. These parts work now:

- The parser reads EPUB files and tagged PDF files, and splits each book into chapters and sections.
- The model client sends requests to the model that you select in `.env`.
- Ingest finds the concepts of a book and puts them into the concept map of a theme.
- The images of a book: the model reads each image one time. Code becomes a code block, a table becomes a Markdown table, and other images get a short description.
- Refresh: after an update of the tutor, give a book that you ingested before the new parse. Your progress stays.
- The app shows the themes, the books, the progress, and the concept map.
- The diagnosis: you mark the concepts of a module, the tutor tests them, and you choose what to learn.
- The study queue: the concepts to learn, in an order that you can change. Use the suggested order of the tutor, or the order of the sections in your books.
- The lessons: the tutor teaches each concept from your books, with references, and answers your questions.
- The test after each lesson: 3 new questions. A pass makes the concept mastered, and the tutor offers the next lesson.
- Test me again: for a mastered concept, the lesson page starts the test again with the questions of your last test.
- The stars: star the important concepts on the lesson page, in the concept map, or on the review board.
- The review board: one short line for each concept, with its status and its star. Filter by status, by star, or by name.

"Add book" in the app comes later. See `PLAN.md` for the build order and `DESIGN-v3.md` for the design.

## Requirements

- Node.js 22 or later.
- An API key for one provider: Anthropic, OpenAI, or OpenRouter.

## Setup

1. Install the packages:

   ```
   npm install
   ```

2. Copy the example settings file:

   ```
   cp .env.example .env
   ```

3. In `.env`, set the provider, the model, the reasoning level, and the API key. For OpenRouter, you can also select the providers that serve the model. The file explains each value. The tutor has no default model.

4. Check the model:

   ```
   npm run llm:check
   ```

   The command sends one JSON request, one text request with references, and one request with an image. If a value in `.env` is missing or not valid, the command tells you which value to change. If the model does not accept images, the command tells you. Then the tutor keeps the images of your books as placeholders, and all other parts work.

## Start the app

```
npm start
```

Then open http://localhost:3000 in a browser. The app has these screens:

- Themes: the list of your themes.
- Theme: the books of the theme and your progress.
- Concept map: the concepts in modules. Open a concept to see its sources and quotes, and read the book section.
- Choose what to test: mark the concepts of a module as Test, Learn, Skip, or Later. Later keeps a concept for another day. You can also change the mark of a concept that you marked already.
- Diagnosis: 2 questions for each concept that you marked Test, then the results. A concept that you do not know goes to your study queue, or you skip it.
- Study queue: the concepts to learn, in order. Drag a concept, or use Top, Up, and Down, to change the order. A red note shows a prerequisite that comes later or that you did not learn. "Use the suggested order" puts prerequisites first, then the module order, then basic before advanced.

- Lesson: the tutor teaches the concept from all its book sections, with references. The length of the lesson follows the concept: a simple concept gets a short lesson. A number in the text is a reference: it opens the book section, with the quote. Ask questions in the box below the lesson. "Teach it again" writes a new lesson from a different angle. If a prerequisite is missing, the lesson page offers to learn it first or to test it.
- Test: after the lesson, click "Test me". The test has a recall question, an explain question, and an apply question. To pass, answer 2 questions correctly. The apply question must be one of them. After a pass, the concept is mastered, and the tutor offers the next lesson. To answer a question again, click "Retake the question" below the feedback. This works until you see the results. For a simple concept, click "Skip the test". The concept then becomes mastered, and the tutor offers the next lesson. After a fail, choose "Teach it again", "Later", or "Skip". The new lesson starts from your wrong answers. After 3 fails, the tutor also offers to test the prerequisites of the concept.

The diagnosis and the test use the model in `.env`. The model writes the questions and grades the open answers. If you think that a grade is wrong, use "Dispute the grade". A disputed answer counts as correct.

The terminal shows one line for each model call: the time, the finish reason, the token counts, and the provider behind OpenRouter. These lines show the steps that wait for the model. A high reasoning level makes each call slower.

The server listens only on your computer. To stop it, press Ctrl+C in the terminal.

## Commands

| Command | What it does |
|---|---|
| `npm run parse -- <book.epub \| book.pdf>` | Split a book into chapters and sections. The command does not use the model. |
| `npm run llm:check` | Check the model that you selected in `.env`. |
| `npm run ingest -- <theme> <book>` | Find the concepts of a book and add them to the concept map of the theme. The command uses the model. |
| `npm run refresh -- <theme> <book>` | Parse a book of the theme again with the current parser, for example after an update of the tutor. Your progress does not change. |
| `npm start` | Build the app and start the server on port 3000. |
| `npm run dev:server` and `npm run dev:app` | Run the server and the app with live reload, for development. Use two terminals. |
| `npm test` | Run the tests. The tests do not call the model. |
| `npm run typecheck` | Check the TypeScript types. |

### Parse a book

```
npm run parse -- /path/to/book.epub
```

The command prints a table with one row for each chapter. Check these columns and lists:

- The chapter list must match the table of contents of the book.
- The "Kept" column must be close to 100%. A lower value means lost text.
- The "Not taught" list must contain only front and back matter, for example the preface.
- The warnings at the end show other problems.

The command writes the results to `data/parse/<book>/`:

- `sections/`: one Markdown file for each section.
- `parse-report.json`: the chapters, the sections, the page numbers, the checklist terms, and the warnings.

To write the results to a different folder, add `--out <folder>`.

### Ingest a book

Ingest sends many requests to the model, and the requests cost money. Start with a preview of one or two chapters:

```
npm run ingest -- SQL /path/to/book.pdf --chapters 2
```

The command shows the number of model requests and asks before it starts. A preview does not change the database. It writes these files to `data/themes/<theme>/books/<book>/`:

- `concept-map.preview.md`: the concepts of the chapters, in modules, with their sources.
- `ingest-report.preview.json`: the sections without a concept, the checklist items with the mark "minor", and the quotes that are not in the text.

Read the concept map. If the concepts look correct, ingest the full book:

```
npm run ingest -- SQL /path/to/book.pdf
```

The full run uses the cached results of the preview chapters, so these chapters cost nothing again. The concept map of the theme goes to `data/themes/<theme>/concept-map.md`.

Before ingest finds the concepts, the model reads the images of the chapters, with one request for each image. The command shows the number of images before it starts. The results go to `work/images.json` in the folder of the book, so each image costs one request only one time.

Ingest options:

- `--chapters <list>`: preview only these chapters, for example `1-3` or `2,5`.
- `--save`: save the chapters of `--chapters` to the database. Use it to learn from some chapters first. A later full run with `--replace` keeps the saved concepts and their progress.
- `--yes`: start without the question.
- `--fresh`: ignore the cached chapter results. The cached image texts stay.
- `--replace`: ingest a book again that the theme has already. The book gets new sections, so the references of your old lessons break. To update the text of a book and keep your progress, use `npm run refresh`.

### Refresh a book

Use this command after an update of the tutor that changes the parser, for example a fix for code blocks or for lost text. The command gives a book that you ingested before the new parse, and it keeps your progress:

```
npm run refresh -- SQL my-sql-book
```

The second value is the folder name of the book in `data/themes/<theme>/books/`, or the title of the book. The command parses the book again with the current parser. The model reads the images that are not in the cache, but only in the chapters with concepts. The command then shows the number of images and asks before it starts. The images of the other chapters keep their placeholders. When you ingest one of these chapters later, the `ingest` command reads its images.

The command writes only the section files and the word counts of the sections. Your concepts, statuses, queue, stars, lessons, and test answers do not change. If a section of the new parse does not match the database, the command stops and changes no section. This happens when a parser change splits the book into different sections. Then only `ingest --replace` can update the book.

Your old lessons do not change. At the end, the command lists the concepts with a lesson from the old text. To get a lesson from the new text, open the lesson and click "Teach it again".

## Books

- EPUB files work best. The parser reads the publisher CSS for headings, bold, and italic.
- PDF files must be tagged. Word and many publishing tools make tagged PDF files. The parser stops with a clear message for an untagged or a scanned PDF.
- The parser does not read the content of images. Some books show code as images. The tutor cannot read that code yet.

## Project layout

```
src/
  cli/          command-line scripts
  config.ts     reads .env
  db/           SQLite schema
  ingest/
    core/       blocks, sections, Markdown, checklist (all formats)
    epub/       EPUB reader
    pdf/        tagged PDF reader
    stages/     extract, review, and merge (the model stages)
  llm/          model client for Anthropic, OpenAI, and OpenRouter
  server/       HTTP API
  app/          browser app (React)
test/           tests and test books
data/           your books, the results, and the database (not in git)
```

## Privacy and copyright

- Do not commit `data/` or `.env`. Git ignores them.
- The `data/` folder contains the text of books that you bought.
- When the tutor sends a request, it sends book text to the provider that you selected. With OpenRouter, the text goes to the vendor of the selected model.
