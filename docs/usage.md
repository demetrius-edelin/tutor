# Usage guide

This guide explains each step and each command of the tutor. For an overview, see the [README](../README.md).

- [Step 1: Set up the tutor](#step-1-set-up-the-tutor)
- [Step 2: Check the model and the book (optional)](#step-2-check-the-model-and-the-book-optional)
- [Step 3: Add a book to a subject](#step-3-add-a-book-to-a-subject)
- [Step 4: Study in the browser](#step-4-study-in-the-browser)
- [Update a book after a tutor update](#update-a-book-after-a-tutor-update)

## Step 1: Set up the tutor

Do this step one time.

1. Install the packages:

   ```
   npm install
   ```

2. Copy the example configuration file:

   ```
   cp .env.example .env
   ```

   In the Windows command prompt, use `copy` instead of `cp`.

3. In `.env`, set the provider, the model, the reasoning level, and the API key. For OpenRouter, you can also select the providers that serve the model. The file explains each value. The tutor has no default model. For the model that we recommend, see [Configuration](../README.md#configuration).

## Step 2: Check the model and the book (optional)

These two commands are checks. They save nothing that the tutor uses later. You can skip them.

### Check the model

```
npm run llm:check
```

The command sends three requests: one JSON request, one text request with references to a source text, and one request with an image. If a value in `.env` is missing or not valid, the command tells you which value to change.

If the model does not accept images, the command tells you. Then the images of your books stay as placeholders, and all other parts of the tutor work.

### Check a book

```
npm run parse -- /path/to/book.epub
```

This command reads the book and prints a report in the terminal. It does not use the model, so it costs nothing. The command has two uses:

- Find a problem in a book before you pay for ingest.
- Find the chapter numbers for `ingest --chapters` and the section ids for `ingest --sections`.

The report looks like this example:

```
My SQL Book (Jane Doe)
Table of contents: outline

  #  Kind      Sections    Words   Kept  Terms  Title
  1  chapter          4    1,105   100%      7  Overview
  2  chapter         55   14,094   101%    193  Chapter 1: SQL Basics
  3  chapter         25    2,384   100%     44  Chapter 2: Joins
  4  chapter         13    1,993    72%      7  Chapter 3: Queries
 ...

Total: 40 chapters, 272 sections, 50,063 words.

Not taught:
  front     Table of Contents (4,128 words)

Checklist: bold 567, emphasis 15. Glossary entries: 0. Index entries: 0.

Warnings: 1
  [unread_images] 94 images in the chapters have no text, so the sections keep only their alternative text. Ingest and refresh read these images with the model.

Output: data/parse/my-sql-book
Report: data/parse/my-sql-book/parse-report.json
```

The table has one row for each chapter:

| Column | What it shows |
|---|---|
| `#` | The number of the chapter in the tutor. Use this number with `ingest --chapters`. |
| Kind | `chapter` or `appendix`. |
| Sections | The number of sections in the chapter. A section is the text under one heading. The lessons refer to sections. |
| Words | The number of words that the tutor keeps from the chapter. |
| Kept | The kept words as a percentage of the words in the book file. A value much lower than 100% means lost text. |
| Terms | The number of bold and italic terms in the chapter. Ingest makes sure that the concepts cover these terms. |
| Title | The title of the chapter. |

The number in the `#` column can be different from the number in the title. In the example, "Chapter 1: SQL Basics" has the number 2, because "Overview" is chapter 1. To ingest "Chapter 1: SQL Basics", use `--chapters 2`.

Make sure that the report is correct:

- The chapter list must match the table of contents of the book.
- Each value in the "Kept" column must be close to 100%. In the example, chapter 4 lost text.
- The "Not taught" list must contain only front and back matter, for example the preface. Ingest does not teach these parts.
- The warnings at the end show other problems.

The command also writes files to `data/parse/<book>/`. Open them in a text editor to read the text that the tutor will teach from:

- `sections/`: one Markdown file for each section, for example `02-01-sql-basics.md`.
- `parse-report.json`: the chapters, the sections, the page numbers, the checklist terms, and the warnings.

The name of a section file starts with the chapter number and the section number. These two numbers make the id of the section. For example, `02-01-sql-basics.md` is section `2.1`. Use this id with `ingest --sections`. The `id` field in `parse-report.json` shows the same id.

No other command reads these files. To write them to a different folder, add `--out <folder>`.

## Step 3: Add a book to a subject

A subject is an area of study, for example "SQL". The `ingest` command puts a book into a subject. If the subject does not exist, the command makes it.

### What ingest does

1. It parses the book with the same parser as `npm run parse`.
2. It keeps a copy of the book file, and writes one Markdown file for each section.
3. The model reads each image of the book one time. Code becomes a code block, a table becomes a Markdown table, and other images get a short description.
4. The model finds the concepts in each chapter. Then it adds them to the concept map of the subject, in modules.
5. It saves the subject, the book, the sections, and the concepts to the database. A preview skips this part.

The command shows the number of model requests and asks before it starts. The requests cost money.

### Ingest a book

You can ingest the full book at one time, or a book one part at a time.

1. Make a preview of one or two chapters:

   ```
   npm run ingest -- SQL /path/to/book.pdf --chapters 2 --preview
   ```

2. Read the concept map of the preview in `data/subjects/<subject>/books/<book>/concept-map.preview.md`. If the concepts look correct, continue.

3. Ingest the chapters that you want to study now:

   ```
   npm run ingest -- SQL /path/to/book.pdf --chapters 1-3
   ```

   Or ingest only some sections:

   ```
   npm run ingest -- SQL /path/to/book.pdf --sections 2.4,2.7
   ```

   Or ingest the full book:

   ```
   npm run ingest -- SQL /path/to/book.pdf
   ```

   The app shows the concepts of the chapters that you ingested. The chapters of the preview come from the cache, so you do not pay for them again. The concept map of the subject goes to `data/subjects/<subject>/concept-map.md`.

### Add more chapters later

After a run with `--chapters` or `--sections`, the subject has the book. To add more chapters or sections, run `ingest` again with a list of the new parts only:

```
npm run ingest -- SQL /path/to/book.pdf --chapters 4-6
```

The command adds the concepts of the new parts to the subject. The other sections keep their concepts, and your old lessons keep their references.

If a section in the list has concepts already, the command stops. To ingest that section again, add `--replace`. Then only the concepts of the sections in the list change. The tutor deletes each concept that loses its last source, if you did not start the concept.

You can also ingest the full book with `--replace`. The chapters that you saved before come from the cache, so you do not pay for them again. Your concepts and their progress stay. But the book gets new sections, so the references of your old lessons break. To get a lesson with correct references, open the lesson and click "Teach it again".

A run with a list needs the same sections as the first run. After a parser change, the sections can be different. Then the command stops, and only a full run with `--replace` can update the book.

### The files of a book

Ingest writes these files to `data/subjects/<subject>/books/<book>/`:

- The copy of the book file.
- `sections/`: one Markdown file for each section. The lessons read the book text from these files.
- `work/`: the cached model results. `work/images.json` keeps the image texts, so you pay for each image only one time.
- `concept-map.preview.md` and `ingest-report.preview.json`: the results of a run with `--preview`. The report lists the sections without a concept, the checklist items with the mark "minor", and the quotes that are not in the text.
- `ingest-report.json`: the report of a run without `--preview`.

### Ingest options

- `--chapters <list>`: ingest only these chapters, for example `1-3` or `2,5`. Use it to study a book one part at a time. To add more chapters later, see [Add more chapters later](#add-more-chapters-later).
- `--sections <list>`: ingest only these sections, for example `2.4` or `2.4-2.7,3.1`. A range contains all the sections between its two ids, in the order of the book. To find the id of a section, see [Check a book](#check-a-book). You can use `--sections` and `--chapters` together. Then the command ingests the sections of the two lists.
- `--preview`: do not change the database. The command writes the concept map and the report as preview files. Use it with `--chapters` to check the concepts of some chapters before you save them.
- `--yes`: start without the question.
- `--fresh`: ignore the cached chapter results. The cached image texts stay.
- `--replace`: ingest again a book that is already in the subject. With `--chapters` or `--sections`, only the concepts of the sections in the list change. Without a list, the book gets new sections, so the references of your old lessons break. To update the text of a book and keep your progress, use `npm run refresh`.

For now, you add books from the terminal only.

## Step 4: Study in the browser

1. Start the app:

   ```
   npm start
   ```

2. Open http://localhost:3000 in a browser.

The command builds the app and starts the server. The server listens only on your computer. To stop it, press Ctrl+C in the terminal. To use a different port, see [Configuration](../README.md#port).

The README lists the [stages of the app](../README.md#in-the-app). The diagnosis, the lessons, the questions about a lesson, and the tests use the model in `.env`. The model writes the questions and grades the open answers. If you think that a grade is wrong, use "Dispute the grade". A disputed answer counts as correct.

The terminal shows one line for each model call: the time, the finish reason, the token counts, and the provider behind OpenRouter. These lines show you which steps wait for the model. A high reasoning level makes each call slower.

## Update a book after a tutor update

You need this command only after an update of the tutor that changes the parser. An example is a fix for code blocks or for lost text. The command parses a book again with the new parser, and it keeps your progress:

```
npm run refresh -- SQL my-sql-book
```

The second value is the folder name of the book in `data/subjects/<subject>/books/`, or the title of the book.

The model reads the images that are not in the cache, but only in the chapters with concepts. Before it starts, the command shows the number of these images and asks you. The images of the other chapters keep their placeholders. When you ingest one of these chapters later, the `ingest` command reads its images.

The command writes only the section files and the word counts of the sections. Your concepts, statuses, queue, stars, lessons, and test answers do not change.

If a section of the new parse does not match the database, the command stops and changes no section. The cause of this stop is a parser change that splits the book into different sections. Then only `ingest --replace` can update the book.

Your old lessons do not change. At the end, the command lists the concepts with a lesson from the old text. To get a lesson from the new text, open the lesson and click "Teach it again".
