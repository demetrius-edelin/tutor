import { useEffect, useState } from "react";
import type { VideoMoment } from "../../server/api-types";
import { embedUrl, formatTime, watchUrl } from "../video";

// The YouTube player at one point of a video. Some owners do not allow the player in other apps,
// so the link to YouTube stays under the player.
export function VideoPlayer({ moment, autoplay = false }: { moment: VideoMoment; autoplay?: boolean }) {
  return (
    <div className="video-player">
      <iframe
        key={`${moment.id}-${moment.start}`}
        src={embedUrl(moment, autoplay)}
        title={`The video at ${formatTime(moment.start)}`}
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
      />
      <p className="quiet small">
        <a href={watchUrl(moment)} target="_blank" rel="noreferrer">
          Open the video on YouTube at {formatTime(moment.start)}
        </a>
        , if the player shows no video.
      </p>
    </div>
  );
}

// Only one player plays at a time. A new player sends this event, and the players under the other references close.
const PLAYER_EVENT = "tutor:player";
let players = 0;

export function announcePlayer(owner = 0): void {
  window.dispatchEvent(new CustomEvent(PLAYER_EVENT, { detail: owner }));
}

// The button that shows the player under a reference. The player loads only after the click,
// so that a page with many references stays fast.
export function WatchButton({ moment }: { moment: VideoMoment }) {
  const [open, setOpen] = useState(false);
  const [owner] = useState(() => ++players);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if ((event as CustomEvent<number>).detail !== owner) setOpen(false);
    };
    window.addEventListener(PLAYER_EVENT, close);
    return () => window.removeEventListener(PLAYER_EVENT, close);
  }, [open, owner]);
  const toggle = () => {
    if (!open) announcePlayer(owner);
    setOpen(!open);
  };
  return (
    <>
      <button className="text-button" onClick={toggle} aria-expanded={open}>
        {open ? "Hide the video" : `Watch from ${formatTime(moment.start)}`}
      </button>
      {open && <VideoPlayer moment={moment} autoplay />}
    </>
  );
}
