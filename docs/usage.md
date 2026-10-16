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

A book can come from three places:

- A book file: an EPUB file or a tagged PDF file. See [Add a book file](#add-a-book-file).
- An online book or online documentation. See [Add an online book](#add-an-online-book).
- A YouTube video or playlist. See [Add a YouTube video or playlist](#add-a-youtube-video-or-playlist).

After you add a book, all three kinds work in the same way: you select the chapters, make a preview, and save the chapters.

### Make a subject

On the list of subjects, type a name in the "New subject" field. Then click "Create". The screen of the new subject opens.

### Add a book file

1. On the subject screen, click "Add a book".
2. Select an EPUB file or a tagged PDF file. The file can have a size of up to 200 MB.

The browser sends the file to the tutor. The tutor reads the chapters and keeps a copy of the file. This step uses no model, so it costs nothing. Then the book page opens, with the chapters of the book.

If the tutor cannot read the file, the app shows the reason. For example, the tutor cannot read an untagged or a scanned PDF file.

If the subject has the book already, the page of that book opens. Then you can add more chapters to it.

### Add an online book

The tutor can teach from an online book or from online documentation, for example `https://doc.rust-lang.org/book/`. The tutor downloads the pages into an EPUB file in `data/web/`. Then you study the book as a book file.

1. On the subject screen, click "Add an online book or video".
2. In "Address of the book or video", type the address of the start page.
3. Click "Find the chapters".

The tutor looks for an `llms.txt` file first. Many documentation sites have this file, and it lists the pages of the site. If the site has no `llms.txt` file, the model finds the table of contents in the links of the start page. This is one small request.

The page then shows the title of the book and its chapters, with the number of pages in each chapter. All the chapters start selected.

4. Clear the checkboxes of the chapters that you do not want.
5. Click "Download".

The download uses no model. The tutor downloads one page at a time and waits one second between two pages. It obeys the `robots.txt` file of the site. The bar at the bottom of the page shows the estimated time.

The book page shows the progress of the download. You can leave the page, because the download continues on the server. "Stop" ends the download after the current page or image. A stopped download writes no EPUB file.

After the download, the book page shows the chapters, as for a book file. Then select the chapters for a preview or a save. See [Select the chapters](#select-the-chapters). Above the chapters, the page shows the number of pages, words, and images. "Skipped pages and images" lists the pages that the tutor did not download, with the reason.

The start address sets the part of the site to download. The tutor keeps only the pages in the folder of the start address. For a different part of a large documentation site, start from a page in that part.

If the tutor does not find all the chapters, type the address of a page with the full list of pages in "Table of contents". Then click "Find the chapters" again. The tutor then reads the links of that page.

If you select only some chapters, the title of the book also names the chapters. For example, "The Rust Programming Language - chapters 1-5". The title gives the name of the EPUB file.

If `data/web/` has an EPUB file with the same title from an earlier download, the page shows two buttons:

- "Use the downloaded file": the tutor adds the file to the subject with no new download.
- "Download again": the tutor downloads the pages again and replaces the file.

The tutor cannot read pages behind a login, or pages that show their text only after JavaScript runs. To download an online book in the terminal, see [Download an online book](commands.md#download-an-online-book).

### Add a YouTube video or playlist

The tutor can teach from a YouTube video or playlist. The tutor does not download the video. It sends the YouTube address to a video model, which hears the speech and sees the screen. Thus, the transcript also contains the code, the commands, and the tables on the screen.

First, set the video model in `.env`. The video model must be a Gemini model, so you need an OpenRouter key or a Gemini key from Google AI Studio. An Anthropic key or an OpenAI key alone does not work for videos. See [Which video model to use](../README.md#which-video-model-to-use).

1. On the subject screen, click "Add an online book or video".
2. In "Address of the book or video", type the address of a YouTube video or playlist.
3. Click "Find the videos".

At the first use, the tutor downloads the yt-dlp program into `data/bin/`, so you install nothing. yt-dlp reads the facts of the video: the title, the channel, the length, and the YouTube chapters.

For one video, the page shows its YouTube chapters. Each YouTube chapter becomes a chapter of the book. You cannot select the chapters of one video, because each request contains the full video.

For a playlist, the page shows its videos with their lengths. Each video becomes a chapter of the book, and its YouTube chapters become its sections. All the videos start selected. A video longer than 90 minutes shows "Too long" and has no checkbox. "In the cache" marks a video with a transcript from an earlier download. Such a video costs nothing.

4. For a playlist, clear the checkboxes of the videos that you do not want.
5. Click "Download".

The bar at the bottom of the page shows the total length. For OpenRouter, it also shows the estimated cost. If `.env` has no video model, the bar shows the message about the video model, and the page has no "Download" button.

The book page shows the progress. Each video is one request to the video model, and a long video can take some minutes. "Stop" ends the download after the current video. The finished transcripts stay in the cache, so a new download does not pay for them again. A stopped download writes no EPUB file.

After the download, the book page shows the chapters, as for a book file. Above the chapters, the page shows the number of videos, the words, the requests, and the cost. "Videos with no transcript" lists the videos that the tutor skipped, with the reason. For example, the tutor skips a video after two transcripts that stop early.

Each paragraph of the transcript starts with a link to its time in the video. In "Read the section", a click on the link opens the video at that point.

The terms of YouTube do not allow downloads with other tools. You run your own copy of the tutor, so you take the responsibility for the videos and the transcripts that you use. To get a transcript in the terminal, see [Download a YouTube video or playlist](commands.md#download-a-youtube-video-or-playlist).

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
