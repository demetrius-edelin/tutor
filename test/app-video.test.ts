import { describe, expect, it } from "vitest";
import { embedUrl, formatLength, formatTime, timeLink, watchUrl } from "../src/app/video.js";

describe("Video links in the app", () => {
  it("reads the point of a time link of a transcript, and no other link", () => {
    expect(timeLink("https://www.youtube.com/watch?v=ahCwqrYpIuM&t=245s")).toEqual({ id: "ahCwqrYpIuM", start: 245 });
    expect(timeLink("https://www.youtube.com/watch?v=ahCwqrYpIuM")).toBeNull();
    expect(timeLink("https://example.com/watch?v=ahCwqrYpIuM&t=245s")).toBeNull();
  });

  it("makes the address of the player and of the video at a point", () => {
    const moment = { id: "ahCwqrYpIuM", start: 245 };
    expect(embedUrl(moment, false)).toBe("https://www.youtube-nocookie.com/embed/ahCwqrYpIuM?start=245&rel=0");
    expect(embedUrl(moment, true)).toBe("https://www.youtube-nocookie.com/embed/ahCwqrYpIuM?start=245&rel=0&autoplay=1");
    expect(watchUrl(moment)).toBe("https://www.youtube.com/watch?v=ahCwqrYpIuM&t=245s");
    expect([formatTime(245), formatTime(3845), formatLength(3900)]).toEqual(["4:05", "1:04:05", "1 h 05 min"]);
  });
});
