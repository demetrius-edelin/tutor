# Command reference

The app does the main work of the tutor: you add books, preview and save chapters, and study in the browser. This reference explains the commands in the terminal. For the app, see the [usage guide](usage.md).

- [When to use a command](#when-to-use-a-command)
- [Check the model](#check-the-model)
- [Check a book](#check-a-book)
- [Download an online book](#download-an-online-book)
- [Download a YouTube video or playlist](#download-a-youtube-video-or-playlist)
- [Ingest a book from the terminal](#ingest-a-book-from-the-terminal)
- [Update a book after a tutor update](#update-a-book-after-a-tutor-update)

## When to use a command

| Command | Use | Uses the model | What it writes |
|---|---|---|---|
| `npm start` | Each time that you want to study. It starts the app. | Yes, for ingest, the diagnosis, the lessons, and the tests. | Your books and your progress. |
| `npm run llm:check` | Optional. After a change to `.env`. | Yes, 3 small requests. | Nothing. |
| `npm run parse -- <book>` | Optional. To check a book at no cost, and to find the section ids for `--sections`. | No. | A report in `data/parse/<book>/`, for you to read. |
| `npm run fetch -- <url>` | To download an online book, online documentation, or the transcript of a YouTube video or playlist in the terminal. The app can also do this. Then add the EPUB file in the app. | For a site with no `llms.txt` file: one small request. For YouTube: one request of the video model for each video. | An EPUB file in `data/web/`. For YouTube, also the transcripts in `data/web/transcripts/`. |
| `npm run ingest -- <subject> <book> [options]` | For the options that the app does not have: `--sections`, `--fresh`, and `--replace`. | Yes. | The folder of the book and the database. |
| `npm run refresh -- <subject> <book>` | Only after an update of the tutor that changes the parser. | Only for new images. | The section files of the book. |

The folder of a book is `data/subjects/<subject>/books/<book>/`. The database is `data/tutor.db`.

The app and the commands use the same code and the same cache. For example, you can make a preview with the command and save it in the app. The chapters of the preview then come from the cache.

## Check the model

```
npm run llm:check
```

The command sends three requests: one JSON request, one text request with references to a source text, and one request with an image. If a value in `.env` is missing or not valid, the command tells you which value to change.

If the model does not accept images, the command tells you. Then the images of your books stay as placeholders, and all other parts of the tutor work.

## Check a book

```
npm run parse -- /path/to/book.epub
```

This command reads the book and prints a report in the terminal. It does not use the model, so it costs nothing. The command has two uses:

- Find a problem in a book before you pay for ingest.
- Find the section ids for `ingest --sections`.

The app shows the chapters of a book too, after you add the book. The command also shows the kept text of each chapter and writes the text of each section to a file.

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
| `#` | The number of the chapter in the tutor. The app and `ingest --chapters` use this number. |
| Kind | `chapter` or `appendix`. |
| Sections | The number of sections in the chapter. A section is the text under one heading. The lessons refer to sections. |
| Words | The number of words that the tutor keeps from the chapter. |
| Kept | The kept words as a percentage of the words in the book file. A value much lower than 100% means lost text. |
| Terms | The number of bold and italic terms in the chapter. Ingest makes sure that the concepts cover these terms. |
| Title | The title of the chapter. |

The number in the `#` column can be different from the number in the title. In the example, "Chapter 1: SQL Basics" has the number 2, because "Overview" is chapter 1.

Make sure that the report is correct:

- The chapter list must match the table of contents of the book.
- Each value in the "Kept" column must be close to 100%. In the example, chapter 4 lost text.
- The "Not taught" list must contain only front and back matter, for example the preface. Ingest does not teach these parts.
- The warnings at the end show other problems.

The command also writes files to `data/parse/<book>/`. Open them in a text editor to read the text that the tutor will teach from:

- `sections/`: one Markdown file for each section, for example `02-01-sql-basics.md`.
- `parse-report.json`: the chapters, the sections, the page numbers, the checklist terms, and the warnings.

The name of a section file starts with the chapter number and the section number. These two numbers make the id of the section. For example, `02-01-sql-basics.md` is section `2.1`. Use this id with `ingest --sections`. The `id` field in `parse-report.json` shows the same id.

No other command and no part of the app reads these files. You can delete `data/parse/` at any time. To write the files to a different folder, add `--out <folder>`.

## Download an online book

The tutor can teach from an online book or from online documentation, for example `https://doc.rust-lang.org/book/`. The app can download the book. See [Add an online book](usage.md#add-an-online-book). The `fetch` command does the same download in the terminal, and it has more options. It writes the pages into an EPUB file. Then you add the EPUB file in the app, the same as other books.

1. Download the book:

   ```
   npm run fetch -- https://doc.rust-lang.org/book/
   ```

2. The command shows the chapters that it found, with the number of pages in each chapter. Then it asks which chapters to download. To download all the chapters, press Enter. To download some chapters, type a list, for example `1-3,5`.

3. In the app, open the subject and click "Add a book". Select the EPUB file in the `data/web/` folder of the tutor, for example `data/web/the-rust-programming-language.epub`.

The start address sets the part of the site to download. The command keeps only the pages in the folder of the start address. If no page is in that folder, the command uses the parent folder. For example, `https://docs.cakemail.com/en/docs/first-steps` gives the pages in `https://docs.cakemail.com/en/docs/`. For a different part of a large documentation site, start from a page in that part.

The command finds the chapters in one of these places:

1. An `llms.txt` file. Many documentation sites have this file. It lists the pages of the site. With this file, the command uses no model.
2. The links of the start page. One model request finds the table of contents in these links. The request is small. The command shows the model before the request.
3. The links of the page that you give with `--toc <url>`. If the chapter list is wrong or empty, use this option. Give a page that lists all the pages of the book.

The command does not follow links from page to page. It downloads only the pages in the table of contents. It waits one second between two requests, and it obeys `robots.txt`. Some sites show the same text under two addresses. The command keeps only the first of these pages.

The EPUB file is a copy of the site on the day of the download. A later change to the site does not change your concepts or the references of your lessons.

Fetch options:

- `--chapters <list>`: download only these chapters, for example `1-3` or `2,5`. The command does not ask which chapters to download.
- `--toc <url>`: read the table of contents from the links of this page.
- `--title <text>`: the title of the book. The default is the title of the site. If you download only some chapters, the default title also contains these chapters. The title gives the name of the EPUB file and the folder of the book in a subject. If you download two parts of one site, give each part its own title.
- `--yes`: download all the chapters without the question, and replace an old EPUB file with the same name.

The command cannot read these pages:

- Pages that show their text only after JavaScript runs.
- Pages behind a login or a paywall. If you bought the book, use the EPUB file from the publisher.
- Pages that only list links to other sites.

The tutor cannot update a downloaded book yet. If the site changes and you want the new text, download the site again with a new `--title`. Then add the new EPUB file as a new book.

## Download a YouTube video or playlist

The tutor can teach from a YouTube video or a YouTube playlist. The app can get the transcript. See [Add a YouTube video or playlist](usage.md#add-a-youtube-video-or-playlist). The `fetch` command does the same in the terminal, and it has more options. It writes the transcript into an EPUB file. Then you add the EPUB file in the app, the same as other books.

The tutor does not download the video. It sends the YouTube address to a video model, which hears the speech and sees the screen. Thus, the transcript also contains the code, the commands, and the tables on the screen.

1. Set the video model in `.env`. See [Which video model to use](../README.md#which-video-model-to-use).

2. Get the transcript:

   ```
   npm run fetch -- "https://www.youtube.com/watch?v=ahCwqrYpIuM"
   ```

   Put the address in quotes. Some shells, for example zsh, change an address with `?` in it.

3. The command shows the YouTube chapters of the video, or the videos of the playlist. For a playlist, it asks which videos to download. To download all the videos, press Enter. To download some videos, type a list, for example `1-3,5`.

4. The command shows the total length and, for OpenRouter, the estimated cost. Then it asks before it sends the requests.

5. In the app, open the subject and click "Add a book". Select the EPUB file in the `data/web/` folder of the tutor, for example `data/web/typescript-the-basics.epub`.

At the first use, the command downloads the yt-dlp program from GitHub into `data/bin/`. You install nothing. The tutor uses yt-dlp only for the facts about a video: the title, the channel, the length, and the YouTube chapters. YouTube changes often, so the command updates yt-dlp one time a day.

The book has these parts:

- One video: each YouTube chapter is a chapter of the book.
- A playlist: each video is a chapter, and the YouTube chapters of a video are its sections.
- A video with no YouTube chapters is one chapter. The parser splits it into sections by size.
- Each paragraph starts with a link to its time in the video. In "Read the section", a click on the link opens the video at that point.
- Before each code block and each table, a note tells you that the tutor read it from the video. The model can make an error in the code. The lesson model sees the note and can correct a small error.

The command checks each transcript. If a transcript stops early, or has a gap of more than 3 minutes, the command tries one more time. After a second bad transcript, it skips the video and shows the reason.

The command keeps each good transcript in `data/web/transcripts/`, one file for each video. A later download of the same video uses this file and costs nothing, for example in a larger playlist. To get a new transcript of a video, delete its file.

Fetch options for YouTube:

- `--chapters <list>`: for a playlist, download only these videos, for example `1-3` or `2,5`. The command does not ask which videos to download. For one video, this option does not apply, because each request contains the full video.
- `--title <text>`: the title of the book. The default is the title of the video or of the playlist. If you download only some videos of a playlist, the default title also contains these videos.
- `--yes`: download all the videos without the questions, and replace an old EPUB file with the same name.

The command cannot read these videos:

- Videos longer than 90 minutes. The transcript of a longer video does not fit into the answer of the model. In a playlist, the command shows such a video as "too long".
- Private and unlisted videos. The video model reads only public videos.
- Videos from other sites, and video files on your computer.

The terms of YouTube do not allow downloads with other tools. You run your own copy of the tutor, so you take the responsibility for the videos and the transcripts that you use.

## Ingest a book from the terminal

The app does the same work as this command. Use the command for the options that the app does not have:

- `--sections`: ingest some sections of a chapter. This option helps with a very large chapter.
- `--fresh`: ignore the cached chapter results.
- `--replace`: ingest again a chapter or a book that has concepts already.

A subject is an area of study, for example "SQL". If the subject does not exist, the command makes it.

### What ingest does

1. It parses the book with the same parser as `npm run parse`.
2. It keeps a copy of the book file, and writes one Markdown file for each section.
3. The model reads each image of the selected chapters one time. Code becomes a code block, a table becomes a Markdown table, and other images get a short description.
4. The model finds the concepts in each chapter. Then it adds them to the concept map of the subject, in modules.
5. It saves the subject, the book, the sections, and the concepts to the database. A preview skips this part.

The command shows the number of model requests and asks before it starts. The requests cost money.

### Examples

Make a preview of one chapter. The database does not change:

```
npm run ingest -- SQL /path/to/book.pdf --chapters 2 --preview
```

The concept map of the preview goes to `data/subjects/<subject>/books/<book>/concept-map.preview.md`. The app shows the same preview on the book page.

Save some chapters, some sections, or the full book:

```
npm run ingest -- SQL /path/to/book.pdf --chapters 1-3
npm run ingest -- SQL /path/to/book.pdf --sections 2.4,2.7
npm run ingest -- SQL /path/to/book.pdf
```

The chapters of a preview come from the cache, so you do not pay for them again. The concept map of the subject goes to `data/subjects/<subject>/concept-map.md`.

### Add more chapters later

After a run with `--chapters` or `--sections`, the subject has the book. To add more chapters or sections, run `ingest` again with a list of the new parts only. You can also click "Add chapters" in the app.

```
npm run ingest -- SQL /path/to/book.pdf --chapters 4-6
```

The command adds the concepts of the new parts to the subject. The other sections keep their concepts, and your old lessons keep their references. The concept map follows the order of the book, so the order of your runs does not matter.

If a section in the list has concepts already, the command stops. To ingest that section again, add `--replace`. Then only the concepts of the sections in the list change. If a concept loses its last source and you did not start it, the tutor deletes it.

You can also ingest the full book with `--replace`. The chapters that you saved before come from the cache, so you do not pay for them again. Your concepts and their progress stay. But the book gets new sections, so the references of your old lessons break. To get a lesson with correct references, open the lesson and click "Teach it again".

A run with a list needs the same sections as the first run. After a parser change, the sections can be different. Then the command stops, and only a full run with `--replace` can update the book.

### Ingest options

- `--chapters <list>`: ingest only these chapters, for example `1-3` or `2,5`. The app shows the chapter numbers in the `#` column.
- `--sections <list>`: ingest only these sections, for example `2.4` or `2.4-2.7,3.1`. A range contains all the sections between its two ids, in the order of the book. To find the id of a section, see [Check a book](#check-a-book). You can use `--sections` and `--chapters` together. Then the command ingests the sections of the two lists.
- `--preview`: do not change the database. The command writes the concept map and the report as preview files.
- `--yes`: start without the question.
- `--fresh`: ignore the cached chapter results. The cached image texts stay.
- `--replace`: ingest again a book that is already in the subject. With `--chapters` or `--sections`, only the concepts of the sections in the list change. Without a list, the book gets new sections, so the references of your old lessons break. To update the text of a book and keep your progress, use `npm run refresh`.

## Update a book after a tutor update

You need this command only after an update of the tutor that changes the parser. An example is a fix for code blocks or for lost text. The command parses a book again with the new parser, and it keeps your progress:

```
npm run refresh -- SQL my-sql-book
```

The second value is the folder name of the book in `data/subjects/<subject>/books/`, or the title of the book.

The model reads the images that are not in the cache, but only in the chapters with concepts. Before it starts, the command shows the number of these images and asks you. The images of the other chapters keep their placeholders. When you add one of these chapters later, ingest reads its images.

The command writes only the section files and the word counts of the sections. Your concepts, statuses, queue, stars, lessons, and test answers do not change.

If a section of the new parse does not match the database, the command stops and changes no section. The cause of this stop is a parser change that splits the book into different sections. Then only `ingest --replace` can update the book.

Your old lessons do not change. At the end, the command lists the concepts with a lesson from the old text. To get a lesson from the new text, open the lesson and click "Teach it again".
