# Build Plan

Status: draft 1. Date: 2026-10-02. The design is in `DESIGN-v3.md`. This file gives the build order for phase 1.

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
- Milestone 5: done, with a smaller scope. The app has the home screen, the theme screen, and the map screen. Ingest stays a command for now. "Add book" and the ingest progress in the app come later.
- Milestone 6: done. The app has the select screen, the diagnosis with grades and disputes, and the results with the choices. The database has schema migrations now.

## Milestones

1. Setup: the TypeScript project, Vitest, the `.env` loader, and the SQLite schema. Exit test: `npm test` and `npm run typecheck` pass.
2. Parse (ingest stage 1): EPUB or tagged PDF to Markdown sections, the checklist, and the parse warnings. Command: `npm run parse -- <book.epub | book.pdf>`. Exit test: a real EPUB parses, and the parse report shows no lost text.
3. Model client: `LlmClient`, `AnthropicClient`, and `OpenAiClient`. Exit test: a script gets a JSON answer and a text answer with references from the selected provider.
4. Extract, review, and merge (ingest stages 2 to 4), and the ingest report. For the first book, the merge step builds the concept map from an empty map. Command: `npm run ingest -- <theme> <book.epub>`. The command also writes the concept map to a Markdown file. Exit test: the user reads the concept map of one real book and finds no large gaps.
5. App shell: the server, the React app, the home screen, the theme screen, and the map screen. "Add book", the ingest progress, and the ingest report in the app come later.
6. Select, diagnose, and choose.
7. The study queue.
8. Teach: lessons with references, and the chat box.
9. Test and grader. After this milestone, phase 1 is complete.

Milestone 4 gives the first useful result: a full digest of a book.

## Test books

- Unit tests build a small EPUB file in the test code. It covers the difficult cases: spine order, parts, nested sections, page breaks, code blocks, tables, asides, footnotes, images, a glossary, and an index.
- A free book helps to test with a real EPUB file: Pro Git, by Scott Chacon and Ben Straub (license CC BY-NC-SA 3.0).
- The books of the user stay in `data/`, which is not in git.
