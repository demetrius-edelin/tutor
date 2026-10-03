# Engineering Skills Tutor

A personal tutor that teaches from your own books. You make a theme of study, for example "SQL", and add books to it. The tutor finds the concepts in the books and checks which concepts you know. Then it teaches the other concepts one at a time, with references to the books, and tests each one.

The tutor runs on your computer. It uses one large language model (LLM) from Anthropic, OpenAI, or OpenRouter. You select the model.

## Status

The project is in phase 1. These parts work now:

- The parser reads EPUB files and tagged PDF files, and splits each book into chapters and sections.
- The model client sends requests to the model that you select in `.env`.
- Ingest finds the concepts of a book and puts them into the concept map of a theme.
- The app shows the themes, the books, the progress, and the concept map.
- The diagnosis: you mark the concepts of a module, the tutor tests them, and you choose what to learn.
- The study queue: the concepts to learn, in an order that you can change.
- The lessons: the tutor teaches each concept from your books, with references, and answers your questions.
- The test after each lesson: 3 new questions. A pass makes the concept mastered, and the tutor offers the next lesson.

Phase 1 is complete. The review schedule and "Add book" in the app come later. See `PLAN.md` for the build order and `DESIGN-v3.md` for the design.

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

   The command sends one JSON request and one text request with references. If a value in `.env` is missing or not valid, the command tells you which value to change.

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

- Lesson: the tutor teaches the concept from all its book sections. The lesson is short: a few paragraphs and one example, with no references. For a complex concept, click "Explain in more detail". The tutor then writes a longer lesson with references. A number in the text is a reference: it opens the book section, with the quote. Ask questions in the box below the lesson. "Teach it again" writes a new lesson from a different angle. If a prerequisite is missing, the lesson page offers to learn it first or to test it.
- Test: after the lesson, click "Test me". The test has a recall question, an explain question, and an apply question. To pass, answer 2 questions correctly. The apply question must be one of them. After a pass, the concept is mastered, and the tutor offers the next lesson. For a simple concept, click "Skip the test". The concept then becomes mastered, and the tutor offers the next lesson. After a fail, choose "Teach it again", "Later", or "Skip". The new lesson starts from your wrong answers. After 3 fails, the tutor also offers to test the prerequisites of the concept.

The diagnosis and the test use the model in `.env`. The model writes the questions and grades the open answers. If you think that a grade is wrong, use "Dispute the grade". A disputed answer counts as correct.

The terminal shows one line for each model call: the time, the finish reason, the token counts, and the provider behind OpenRouter. These lines show the steps that wait for the model. A high reasoning level makes each call slower.

The server listens only on your computer. To stop it, press Ctrl+C in the terminal.

## Commands

| Command | What it does |
|---|---|
| `npm run parse -- <book.epub \| book.pdf>` | Split a book into chapters and sections. The command does not use the model. |
| `npm run llm:check` | Check the model that you selected in `.env`. |
| `npm run ingest -- <theme> <book>` | Find the concepts of a book and add them to the concept map of the theme. The command uses the model. |
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

Ingest options:

- `--chapters <list>`: preview only these chapters, for example `1-3` or `2,5`.
- `--save`: save the chapters of `--chapters` to the database. Use it to learn from some chapters first. A later full run with `--replace` keeps the saved concepts and their progress.
- `--yes`: start without the question.
- `--fresh`: ignore the cached chapter results.
- `--replace`: ingest a book again that the theme has already.

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
