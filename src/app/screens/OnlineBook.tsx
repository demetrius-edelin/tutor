import { useState, type FormEvent, type ReactNode } from "react";
import type { FetchStartView, OnlineTocView, SubjectDetail, VideoToc } from "../../server/api-types";
import { postJson, useApi } from "../api";
import { Layout, Notice } from "../components/Layout";
import { Spinner } from "../components/Spinner";
import { href } from "../router";
import { formatLength, formatTime } from "../video";

const n = (value: number) => value.toLocaleString("en-US");
const plural = (count: number, word: string) => `${n(count)} ${word}${count === 1 ? "" : "s"}`;

// The time of a download in words, for example "about 2 minutes".
function duration(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  return minutes <= 1 ? "about 1 minute" : `about ${n(minutes)} minutes`;
}

const isYoutube = (text: string) => /(^|[/.])(youtube\.com|youtu\.be)(\/|$)/i.test(text.trim());

// Add an online book or a YouTube video: the address, the chapters or the videos, and the start of the download.
// The server keeps no state between the two requests, so the page sends the table of contents or the facts back with the selection.
export function OnlineBook({ slug }: { slug: string }) {
  const subject = useApi<SubjectDetail>(`/api/subjects/${encodeURIComponent(slug)}`);
  const name = subject.state === "ready" ? subject.data.name : slug;
  // Each answer gets a new number, so that a new answer starts with a new selection.
  const [found, setFound] = useState<{ number: number; view: OnlineTocView } | null>(null);
  return (
    <Layout subject={{ slug, name }} tab="subject">
      <p className="back-link">
        <a href={href.subject(slug)}>Back to {name}</a>
      </p>
      <h1>Add an online book or video</h1>
      <p className="lead">
        The tutor downloads the pages of an online book or of online documentation into an EPUB file. For a YouTube video or playlist, the video
        model writes the transcript. Then you select the chapters to study, as for a book file.
      </p>
      {subject.state === "error" ? (
        <Notice title="The subject did not load">
          <p>{subject.message}</p>
        </Notice>
      ) : (
        <>
          <AddressForm onFound={(view) => setFound((current) => (view ? { number: (current?.number ?? 0) + 1, view } : null))} />
          {found?.view.kind === "web" && <Chapters key={found.number} slug={slug} found={found.view} />}
          {found?.view.kind === "video" && <Videos key={found.number} slug={slug} video={found.view.video} />}
        </>
      )}
    </Layout>
  );
}

function AddressForm({ onFound }: { onFound: (view: OnlineTocView | null) => void }) {
  const [url, setUrl] = useState("");
  const [toc, setToc] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const find = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    onFound(null);
    try {
      onFound(await postJson<OnlineTocView>("/api/fetch/toc", { url, toc }));
    } catch (problem) {
      setError((problem as Error).message);
    }
    setBusy(false);
  };
  const video = isYoutube(url);
  return (
    <form className="online-form" onSubmit={find}>
      <div className="field">
        <label htmlFor="online-url">Address of the book or video</label>
        <input
          id="online-url"
          type="text"
          inputMode="url"
          autoComplete="url"
          placeholder="https://doc.rust-lang.org/book/"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <p className="field-note">
          The start page of an online book or of documentation, or the address of a YouTube video or playlist. For an online book, the tutor
          downloads only the pages in the folder of the start page.
        </p>
      </div>
      {!video && (
        <div className="field">
          <label htmlFor="online-toc">
            Table of contents <span className="quiet">(optional)</span>
          </label>
          <input id="online-toc" type="text" inputMode="url" value={toc} onChange={(event) => setToc(event.target.value)} />
          <p className="field-note">
            The address of a page with the full list of pages. Use this field only if the tutor does not find all the chapters.
          </p>
        </div>
      )}
      <p className="button-row">
        <button className="button" type="submit" disabled={busy || !url.trim()}>
          {busy && <Spinner />}
          {busy ? (video ? "Finding the videos" : "Finding the chapters") : video ? "Find the videos" : "Find the chapters"}
        </button>
      </p>
      {busy && (
        <p className="quiet small" role="status">
          {video
            ? "The tool yt-dlp reads the facts of the video. At the first use, the tutor installs yt-dlp. This can take one minute."
            : "The tutor looks for an llms.txt file first. A site without this file needs one small model request. This can take one minute."}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

// The start of a download, the EPUB file of an earlier download with the same title, and the errors.
function useDownload(slug: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<{ file: string; title: string } | null>(null);
  const subjectUrl = `/api/subjects/${encodeURIComponent(slug)}`;
  const act = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      if (next) {
        window.location.hash = next;
        return;
      }
    } catch (problem) {
      setError((problem as Error).message);
    }
    setBusy(false);
  };
  return {
    busy,
    error,
    existing,
    // A new selection gives a new title, so the file of the earlier download does not apply to it.
    reset: () => setExisting(null),
    // The book page shows the progress of the download.
    start: (body: object, again: boolean) =>
      act(async () => {
        const result = await postJson<FetchStartView>(`${subjectUrl}/fetch`, { ...body, again });
        if (result.run) return href.book(slug, result.run.book);
        setExisting(result.existing);
        return null;
      }),
    addFile: (file: string) => act(async () => href.book(slug, (await postJson<{ book: string }>(`${subjectUrl}/books/web`, { file })).book, "plan")),
  };
}

// The bar at the bottom of the page: the summary of the selection, the "Download" button, and the choice for an earlier file.
function DownloadBar({
  download,
  body,
  summary,
  note,
  ready,
}: {
  download: ReturnType<typeof useDownload>;
  body: object;
  summary: string;
  note: ReactNode;
  // False if the selection is empty. Null if the download is not possible, for example with no video model.
  ready: boolean | null;
}) {
  const { busy, error, existing } = download;
  return (
    <div className="action-bar">
      <p className="run-summary" role="status">
        {summary}
        <br />
        <span className="quiet">{note}</span>
      </p>
      {ready !== null && (
        <button className="button" onClick={() => download.start(body, false)} disabled={!ready || busy}>
          {busy && !existing && <Spinner />}
          Download
        </button>
      )}
      {existing && (
        <div className="existing-file" role="alert">
          <p>
            The folder data/web/ has the file {existing.file} from an earlier download of "{existing.title}".
          </p>
          <p className="button-row">
            <button className="button small" onClick={() => download.addFile(existing.file)} disabled={busy}>
              Use the downloaded file
            </button>
            <button className="button small secondary" onClick={() => download.start(body, true)} disabled={busy}>
              Download again
            </button>
          </p>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// The checkboxes above a table, with "Select all" and "Clear".
function SelectionTools({ selected, all, word, onSelect }: { selected: number[]; all: number[]; word: string; onSelect: (numbers: number[]) => void }) {
  return (
    <p className="button-row selection-tools">
      <span className="quiet small">
        {n(selected.length)} of {plural(all.length, word)} selected
      </span>
      <button className="text-button" onClick={() => onSelect(all)} disabled={selected.length === all.length}>
        Select all
      </button>
      <button className="text-button" onClick={() => onSelect([])} disabled={selected.length === 0}>
        Clear
      </button>
    </p>
  );
}

// The chapters of the table of contents, with checkboxes. All chapters start selected, as in the command.
function Chapters({ slug, found }: { slug: string; found: Extract<OnlineTocView, { kind: "web" }> }) {
  const { toc } = found;
  const all = toc.chapters.map((_, i) => i + 1);
  const [selected, setSelected] = useState<number[]>(all);
  const download = useDownload(slug);
  const pageCount = (numbers: number[]) => numbers.reduce((count, number) => count + toc.chapters[number - 1]!.pages.length, 0);
  const pages = pageCount(selected);
  const select = (numbers: number[]) => {
    setSelected(numbers);
    download.reset();
  };
  const toggle = (number: number) =>
    select(selected.includes(number) ? selected.filter((item) => item !== number) : [...selected, number].sort((a, b) => a - b));

  return (
    <section aria-labelledby="toc-heading">
      <h2 id="toc-heading">{toc.title}</h2>
      <p className="section-intro">
        {toc.source === "llms.txt"
          ? `The table of contents comes from ${toc.tocUrl}.`
          : `The model found the table of contents in the links of ${toc.tocUrl}.`}{" "}
        The tutor downloads only the pages in {toc.scope}. The site has {plural(toc.chapters.length, "chapter")} with {plural(pageCount(all), "page")}.
      </p>
      <SelectionTools selected={selected} all={all} word="chapter" onSelect={select} />
      <div className="table-scroll">
        <table className="data-table chapter-table">
          <thead>
            <tr>
              <th scope="col">
                <span className="visually-hidden">Selected</span>
              </th>
              <th scope="col">#</th>
              <th scope="col">Chapter</th>
              <th scope="col" className="number">
                Pages
              </th>
            </tr>
          </thead>
          <tbody>
            {toc.chapters.map((chapter, i) => {
              const number = i + 1;
              const id = `online-chapter-${number}`;
              return (
                <tr key={number} className={selected.includes(number) ? "selected" : undefined}>
                  <td>
                    <input id={id} type="checkbox" checked={selected.includes(number)} onChange={() => toggle(number)} />
                  </td>
                  <td className="number">{number}</td>
                  <td>
                    <label htmlFor={id}>{chapter.title}</label>
                  </td>
                  <td className="number">{n(chapter.pages.length)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <DownloadBar
        download={download}
        body={{ toc, chapters: selected }}
        summary={
          selected.length === 0
            ? "Select chapters to download."
            : `${plural(selected.length, "chapter")}, ${plural(pages, "page")}, ${duration(pages * found.secondsPerPage)}.`
        }
        note="The download uses no model. The tutor waits one second between two pages. Each image adds about one second."
        ready={selected.length > 0}
      />
    </section>
  );
}

// The cost of the selected videos that are not in the cache, or the reason that there is no estimate.
function costText(video: VideoToc, entries: VideoToc["videos"]): string {
  const toTranscribe = entries.filter((entry) => !entry.cached);
  if (toTranscribe.length === 0) return "The transcripts are in the cache, so the download costs nothing.";
  const requests = plural(toTranscribe.length, "request");
  if (video.dollarsPerSecond === null) return video.costNote ?? `${requests} to the video model.`;
  const unknown = toTranscribe.filter((entry) => entry.duration === null).length;
  const seconds = toTranscribe.reduce((total, entry) => total + (entry.duration ?? 0), 0);
  const cost = `about $${(seconds * video.dollarsPerSecond).toFixed(2)} for ${requests} to the video model`;
  return unknown > 0 ? `Estimated cost: ${cost}, without the ${plural(unknown, "video")} with no known length.` : `Estimated cost: ${cost}.`;
}

// One video with its YouTube chapters, or the videos of a playlist with checkboxes. One video has no selection,
// because each request contains the full video. A video longer than the limit has no checkbox.
function Videos({ slug, video }: { slug: string; video: VideoToc }) {
  const playlist = video.kind === "playlist";
  const tooLong = (entry: VideoToc["videos"][number]) => entry.duration !== null && entry.duration > video.maxSeconds;
  const allowed = video.videos.flatMap((entry, i) => (tooLong(entry) ? [] : [i + 1]));
  const [selected, setSelected] = useState<number[]>(playlist ? allowed : [1]);
  const download = useDownload(slug);
  const select = (numbers: number[]) => {
    setSelected(numbers);
    download.reset();
  };
  const toggle = (number: number) =>
    select(selected.includes(number) ? selected.filter((item) => item !== number) : [...selected, number].sort((a, b) => a - b));
  const entries = selected.map((number) => video.videos[number - 1]!);
  const length = entries.reduce((total, entry) => total + (entry.duration ?? 0), 0);
  const one = video.videos[0]!;
  const limit = `The tutor transcribes videos of up to ${formatLength(video.maxSeconds)}.`;
  // With no video model, or for one video that is too long, the page shows no "Download" button.
  const possible = video.model !== null && (playlist || !tooLong(one));

  let summary: string;
  if (!playlist) summary = tooLong(one) ? `The video is too long. ${limit}` : `1 video, ${formatLength(one.duration ?? 0)}. ${costText(video, [one])}`;
  else if (selected.length === 0) summary = "Select videos to download.";
  else summary = `${plural(selected.length, "video")}, ${formatLength(length)}. ${costText(video, entries)}`;

  return (
    <section aria-labelledby="video-heading">
      <h2 id="video-heading">{video.title}</h2>
      <p className="section-intro">
        {playlist
          ? `A YouTube playlist of ${video.channel} with ${plural(video.videos.length, "video")}. Each video becomes a chapter of the book.`
          : `A YouTube video of ${video.channel}, ${formatLength(one.duration ?? 0)} long.`}{" "}
        The video model writes the transcript, with the code on the screen. Each request contains one full video.
      </p>
      {video.playlist && (
        <p className="run-note">
          The address also names a playlist. To add the full playlist, type this address: {video.playlist}
        </p>
      )}

      {!playlist &&
        (video.chapters.length > 0 ? (
          <div className="table-scroll">
            <table className="data-table time-table">
              <thead>
                <tr>
                  <th scope="col">Start</th>
                  <th scope="col">Chapter</th>
                </tr>
              </thead>
              <tbody>
                {video.chapters.map((chapter, i) => (
                  <tr key={i}>
                    <td>{formatTime(chapter.start)}</td>
                    <td>{chapter.title}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="section-intro">The video has no YouTube chapters. The book gets one chapter, and the tutor splits it into sections by size.</p>
        ))}

      {playlist && (
        <>
          <SelectionTools selected={selected} all={allowed} word="video" onSelect={select} />
          <div className="table-scroll">
            <table className="data-table chapter-table">
              <thead>
                <tr>
                  <th scope="col">
                    <span className="visually-hidden">Selected</span>
                  </th>
                  <th scope="col" className="wide-only">
                    #
                  </th>
                  <th scope="col">Video</th>
                  <th scope="col" className="number">
                    Length
                  </th>
                </tr>
              </thead>
              <tbody>
                {video.videos.map((entry, i) => {
                  const number = i + 1;
                  const id = `video-${number}`;
                  const long = tooLong(entry);
                  return (
                    <tr key={entry.id} className={selected.includes(number) ? "selected" : undefined}>
                      <td>{!long && <input id={id} type="checkbox" checked={selected.includes(number)} onChange={() => toggle(number)} />}</td>
                      <td className="number wide-only">{number}</td>
                      <td>
                        {long ? <span>{entry.title}</span> : <label htmlFor={id}>{entry.title}</label>}
                        {long && <span className="tag">Too long</span>}
                        {!long && entry.cached && <span className="tag">In the cache</span>}
                      </td>
                      <td className="number">{entry.duration === null ? "" : formatLength(entry.duration)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {allowed.length < video.videos.length && <p className="quiet small">{limit} A longer transcript does not fit into the answer of the model.</p>}
        </>
      )}

      <DownloadBar
        download={download}
        body={{ video, chapters: selected }}
        summary={summary}
        note={video.model ? `Video model: ${video.model}. A long video can take some minutes.` : video.modelError}
        ready={possible ? selected.length > 0 : null}
      />
    </section>
  );
}
