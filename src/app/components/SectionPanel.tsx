import { useEffect, useRef, useState, type MouseEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SectionView, VideoMoment } from "../../server/api-types";
import { useApi } from "../api";
import { timeLink } from "../video";
import { Drawer } from "./Drawer";
import { announcePlayer, VideoPlayer } from "./VideoPlayer";

// A panel at the side of the page with the text of one book section.
// With onBack, the panel has a button that goes back to the list of references.
// For a section from a video, the panel shows the player at the point of the quote, or else at the start of the section.
export function SectionPanel({
  sectionId,
  quote,
  video,
  onClose,
  onBack,
}: {
  sectionId: number;
  quote?: string;
  video?: VideoMoment | null;
  onClose: () => void;
  onBack?: () => void;
}) {
  const section = useApi<SectionView>(`/api/sections/${sectionId}`);
  // A click on a time link in the text moves the player to that time.
  const [seek, setSeek] = useState<VideoMoment | null>(null);
  const player = useRef<HTMLDivElement>(null);
  // The panel has its own player, so the players under the references close.
  useEffect(() => announcePlayer(), []);
  useEffect(() => {
    if (seek) player.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [seek]);
  const moment = seek ?? video ?? (section.state === "ready" ? section.data.video : null);

  const playAt = (event: MouseEvent, time: VideoMoment) => {
    // A click with a modifier key opens the link in a new tab, as usual.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setSeek(time);
  };

  return (
    <Drawer
      label="Book section"
      title={
        section.state === "ready" ? (
          <>
            {section.data.book}, {section.data.chapterTitle}
            {section.data.page ? `, page ${section.data.page}` : ""}
          </>
        ) : (
          "Book section"
        )
      }
      actions={
        onBack && (
          <button className="text-button" onClick={onBack}>
            Back to the references
          </button>
        )
      }
      onClose={onClose}
    >
      {quote && (
        <blockquote className="quote panel-quote">
          <span>{quote}</span>
        </blockquote>
      )}
      {moment && (
        <div ref={player}>
          <VideoPlayer moment={moment} autoplay={seek !== null} />
        </div>
      )}
      {section.state === "loading" && <p className="quiet">Loading the section.</p>}
      {section.state === "error" && <p>{section.message}</p>}
      {section.state === "ready" && (
        <article className="reading">
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              // A link to another site opens in a new tab, so that the app stays open. A time link of a video moves the player.
              a: ({ href, children }) => {
                const time = href && moment ? timeLink(href) : null;
                if (href && time) {
                  return (
                    <a href={href} target="_blank" rel="noreferrer" onClick={(event) => playAt(event, time)}>
                      {children}
                    </a>
                  );
                }
                return href && /^https?:\/\//i.test(href) ? (
                  <a href={href} target="_blank" rel="noreferrer">
                    {children}
                  </a>
                ) : (
                  <a href={href}>{children}</a>
                );
              },
            }}
          >
            {section.data.markdown}
          </Markdown>
        </article>
      )}
    </Drawer>
  );
}
