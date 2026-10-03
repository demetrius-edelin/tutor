# Build Plan

Status: draft 2. Date: 2026-10-03. The design is in `DESIGN-v3.md`. This file gives the build order for phase 1 and phase 2.

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
- Milestone 7: done. The study queue has a suggested order, drag and drop, move buttons, prerequisite warnings, and Later and Skip.
- Milestone 8: done. Lessons with checked references, the chat box, Teach it again, Start now in the queue, and the prerequisite actions.
- Milestone 9: done. The test after a lesson has the pass rule, mastered concepts, and the next lesson. After a fail, the user selects an action. After 3 fails, the tutor offers a prerequisite test. Phase 1 is complete.
- Milestone 10: done. The star button is on the lesson page and in the concept map. The columns of the review schedule are gone. The database of the user opens with no error.
- Lesson length fix: done. The tutor writes one lesson with references in one call. The length follows the concept, and the prompt has no minimum length. The "Explain in more detail" button is gone. Schema version 6 keeps the detailed version of each old lesson.
- Milestone 11: done. The "Review board" tab shows one line for each concept, with the status filters, the star filter, and the search. The address keeps the filters.
- Milestone 12: done. "Test me again" on the lesson page of a mastered concept uses the questions of the last test, with no model call to write questions. "Learn again" is dropped, because a click on the board opens the lesson. Phase 2 is complete.
- Milestone 13: planned. See "Later milestones".

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
    - Add the route `#/themes/<slug>/board` and the "Review board" tab after "Study queue".
    - Show one line for each concept, in its module: the status mark, the name, and the star button. The name opens the lesson page.
    - Add the summary line, the status filters with their counts, the "Starred" toggle, and the search box. The address keeps the filters.
    - Use the concept map request for the data.
    - Exit test: select "Learned" and "Starred". The board shows only the starred concepts that are `known` or `mastered`. A reload keeps the filters.
12. Test me again. This milestone replaces "Learn again": a click on a concept on the board opens its lesson, so the board needs no button.
    - Add the "Test me again" button to the "After the lesson" part of the lesson page of a `mastered` concept.
    - The button uses `POST /api/concepts/:id/check` with the body `{ "again": true }`. The server copies the 3 questions of the last finished test into a new test session. The options of the recall question get a new order. The session is ready at once, with no model call.
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
    - Add `npm run refresh -- <theme> <book>`. The command parses the book again and reads its images. It writes only the section files and the word counts of the sections. Concepts, statuses, the queue, stars, lessons, and test answers do not change. If a section does not match its row in the database, the command stops and changes nothing.
    - Do not use `npm run ingest -- --replace` for an existing book. It removes the book row, so the IDs of all sections change. Then the references of the old lessons and the sections of the questions break.
    - Old lessons do not change. For a concept with an image in its sections, use "Teach it again" to get a lesson with the content of the image.
    - Exit test: run `refresh` on a book with code images. A section with a code image contains the code as a code block. The progress in the app is the same as before.

## Options

If the user asks for them, these options can come later:

- Keep the date of the change to `mastered` for each concept. Then the board can show "learned 5 weeks ago".
- Export the starred concepts as a Markdown list, as a summary of the books.
- A "Quiz me" button that asks one question about one concept, with no schedule.

## Test books

- Unit tests build a small EPUB file in the test code. It covers the difficult cases: spine order, parts, nested sections, page breaks, code blocks, tables, asides, footnotes, images, a glossary, and an index.
- A free book helps to test with a real EPUB file: Pro Git, by Scott Chacon and Ben Straub (license CC BY-NC-SA 3.0).
- The books of the user stay in `data/`, which is not in git.
