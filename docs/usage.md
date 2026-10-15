# Usage guide

This guide explains how to use the tutor in the browser. For an overview, see the [README](../README.md). For the commands in the terminal, see the [command reference](commands.md).

- [Step 1: Set up the tutor](#step-1-set-up-the-tutor)
- [Step 2: Start the app](#step-2-start-the-app)
- [Step 3: Add a book to a subject](#step-3-add-a-book-to-a-subject)
- [Step 4: Study](#step-4-study)

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

4. Optional: check the model. The command sends three small requests:

   ```
   npm run llm:check
   ```

   If a value in `.env` is missing or not valid, the command tells you which value to change. See [Check the model](commands.md#check-the-model).

## Step 2: Start the app

1. Start the app:

   ```
   npm start
   ```

2. Open http://localhost:3000 in a browser.

The command builds the app and starts the server. The server listens only on your computer. To stop it, press Ctrl+C in the terminal. To use a different port, see [Port](../README.md#port).

The terminal shows one line for each model call: the time, the finish reason, the token counts, and the provider behind OpenRouter. These lines show you which steps wait for the model. A high reasoning level makes each call slower.

## Step 3: Add a book to a subject

A subject is an area of study, for example "SQL". Each subject has its own books and its own concept map.

### Make a subject

On the list of subjects, type a name in the "New subject" field. Then click "Create". The screen of the new subject opens.

### Add a book

1. On the subject screen, click "Add a book".
2. Select an EPUB file or a tagged PDF file. The file can have a size of up to 200 MB.

The browser sends the file to the tutor. The tutor reads the chapters and keeps a copy of the file. This step uses no model, so it costs nothing. Then the book page opens, with the chapters of the book.

If the tutor cannot read the file, the app shows the reason. For example, the tutor cannot read an untagged or a scanned PDF file.

If the subject has the book already, the page of that book opens. Then you can add more chapters to it.

### Select the chapters

The book page has one row for each chapter:

| Column | What it shows |
|---|---|
| `#` | The number of the chapter in the tutor. It can be different from the number in the title of the chapter. |
| Chapter | The title of the chapter. "Has concepts" marks a chapter on the concept map. "In the cache" marks a chapter with the model results of an earlier run. |
| Sections | The number of sections in the chapter. A section is the text under one heading. The lessons refer to sections. |
| Words | The number of words that the tutor keeps from the chapter. |
| Images | The images that the model did not read yet. The model reads each image one time. |
| Requests | The model requests for the chapter. The number is an estimate. |

Select the chapters with the checkboxes. "Select all" selects each chapter without concepts. The bar at the bottom of the page shows the number of model requests for your selection, and the model from `.env`.

A chapter with concepts has no checkbox. To ingest such a chapter again, use the [ingest command](commands.md#ingest-a-book-from-the-terminal) with `--replace`.

To see the problems that the tutor found in the book file, open "Parse warnings" above the list.

### Preview and save

The bar at the bottom of the page has two buttons:

- "Preview": the model finds the concepts of the selected chapters. The concept map of the subject does not change.
- "Save": the model finds the concepts and adds them to the concept map. The app shows the new concepts at once.

A click on a button starts the run at once, with no other question. The requests cost money.

We recommend these steps for a new book:

1. Select one chapter and click "Preview".
2. Read the report. If the concepts look correct, click "Save these chapters". The chapter comes from the cache, so the save makes only one merge request.
3. Later, add the next chapters. See [Add more chapters later](#add-more-chapters-later).

A preview that you did not save shows on the subject screen, under "Not saved yet".

### The progress of a run

During a run, the book page shows the current step, a progress bar, and the "Stop" button. A step is one model request, for example "Finding the concepts in chapter 2 of 5". The progress bar moves after each request. With a high reasoning level, one request can take more than a minute.

You can leave the page. The run continues on the server. The subject screen shows the run, with a link to its progress.

Only one run can work at a time, in all subjects. During a run, you cannot delete its subject.

"Stop" ends the run after the current request. The image texts and the finished chapters stay in the cache, so a new run does not pay for them again. A run that stops or fails does not change the concept map.

If the server stops during a run, the run fails. Start the run again. The finished chapters come from the cache.

### The report

After a run, the book page shows the report:

- The summary. After a preview, it has the "Save these chapters" button and the "Change the chapters" link. After a save, it has the "Open the concept map" button.
- Chapters: the sections and the concepts of each chapter. "Added" counts the new concepts. "Joined" counts the concepts that are the same idea as a concept on the map.
- What ingest skipped: the sections without concepts, the terms that the model marked as minor, and the quotes that are not in the text. Each item has the reason from the model.
- Concepts of the preview: the concepts of the selected chapters, in their modules on the concept map. Each concept shows its level (Basic, Intermediate, or Advanced) and its type (Knowledge or Skill). "On the map" marks a concept that the concept map has already. The preview adds a source to it.

Read the list of skipped items before you save. Most items are names from code examples. An important idea in the list means that the preview missed it. The app cannot add a skipped item as a concept yet.

### Add more chapters later

On the subject screen, click "Add chapters" below the book. The book page opens with the chapters of the book. You do not add the book file again, because the tutor keeps a copy.

The new chapters do not change the other chapters. Your concepts, your progress, and your lessons stay.

The concept map follows the order of the book. A concept takes the place of its first section, and a module takes the place of its first concept. Thus, the order in which you add the chapters does not matter.

### Add an online book

The app cannot download an online book yet. First, download the book into an EPUB file with the `fetch` command:

```
npm run fetch -- https://doc.rust-lang.org/book/
```

Then click "Add a book" and select the EPUB file in the `data/web/` folder of the tutor. See [Download an online book](commands.md#download-an-online-book).

### The files of a book

The tutor writes these files to `data/subjects/<subject>/books/<book>/`:

- The copy of the book file.
- `sections/`: one Markdown file for each section. The lessons read the book text from these files.
- `work/`: the cached model results. `work/images.json` keeps the image texts, so you pay for each image only one time.
- `concept-map.preview.md`, `concept-map.preview.json`, and `ingest-report.preview.json`: the results of the last preview.
- `ingest-report.json`: the report of the last save.

The concept map of the subject is in `data/subjects/<subject>/concept-map.md`, for people to read. The database is `data/tutor.db`.

## Step 4: Study

The README lists the [stages of the app](../README.md#in-the-app). The app shows the next action at each stage.

The diagnosis, the lessons, the questions about a lesson, and the tests use the model in `.env`. The model writes the questions and grades the open answers. If you think that a grade is wrong, use "Dispute the grade". A disputed answer counts as correct.
