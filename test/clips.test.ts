import { describe, expect, it } from "vitest";
import { clipProblem, inParallel, joinTranscripts, placedWords, planClips } from "../src/ingest/video/clips.js";
import { parseTranscript } from "../src/ingest/video/transcript.js";

describe("the clips of a long video", () => {
  it("cuts a video into clips of equal length, each with the first minute of the next clip", () => {
    expect(planClips(1800)).toEqual([{ start: 0, end: 1800 }]);
    expect(planClips(2700)).toEqual([{ start: 0, end: 2700 }]);
    expect(planClips(2760)).toEqual([
      { start: 0, end: 1440 },
      { start: 1380, end: 2760 },
    ]);
    expect(planClips(7200)).toEqual([
      { start: 0, end: 2460 },
      { start: 2400, end: 4860 },
      { start: 4800, end: 7200 },
    ]);
    expect(planClips(600, 240)).toEqual([
      { start: 0, end: 260 },
      { start: 200, end: 460 },
      { start: 400, end: 600 },
    ]);
  });

  it("finds the words of the prose, with no times, no code, and no tables", () => {
    const text = "[1:05] The loop ends.\n\n```python\nfor word in words:\n```\n\n| Name | Type |\n|---|---|\n\n[1:30] Then, e.g. this";
    const words = placedWords(text);
    expect(words.map((word) => word.word)).toEqual(["the", "loop", "ends", "then", "e", "g", "this"]);
    expect(words.map((word) => word.at)).toEqual([65, 65, 65, 90, 90, 90, 90]);
    expect(words.filter((word) => word.sentenceEnd).map((word) => text.slice(word.from, word.to))).toEqual(["ends.", "e.", "g."]);
  });

  it("checks a clip with the times of the full video", () => {
    const clip = { start: 2400, end: 2700 };
    expect(clipProblem("[40:00] Start.\n[42:00] Middle.\n[44:00] End.", clip, "stop")).toBeNull();
    // An introduction before the first time is not a problem.
    expect(clipProblem("Here is the transcript.\n[40:05] Start.\n[42:00] Middle.\n[44:00] End.", clip, "stop")).toBeNull();
    expect(clipProblem("[0:00] Start.\n[2:00] Middle.\n[4:00] End.", clip, "stop")).toBe("the first time is 0:00, before the start of the clip at 40:00");
    expect(clipProblem("[40:00] Start.", clip, "stop")).toBe("the transcript stops at 0:00, but the video is 5:00 long");
    expect(clipProblem("[40:00] Start.\n[44:00] End.", clip, "length")).toBe("the transcript reached the token limit");
  });

  it("runs at most the limit at the same time, and keeps the order of the items", async () => {
    let running = 0;
    let most = 0;
    const results = await inParallel([30, 10, 20, 5, 15], 2, async (ms) => {
      most = Math.max(most, ++running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running--;
      return ms * 2;
    });
    expect(results).toEqual([60, 20, 40, 10, 30]);
    expect(most).toBe(2);
  });
});

describe("the join of two clips", () => {
  const overlap = { start: 2700, end: 2760 };

  it("joins at a sentence that both transcripts contain, and removes both broken edges", () => {
    const first = "[44:00] We start with a loop.\n\n[45:10] So the loop ends here and the program prints the result. Then we look at the next example, and the code is";
    const second = "[45:00] here and the program prints the result. Then we look at the next example, and the code is short.\n\n[45:40] More words.";
    const { text, join } = joinTranscripts(first, second, overlap);
    expect(text).toBe(
      "[44:00] We start with a loop.\n\n[45:10] So the loop ends here and the program prints the result. Then we look at the next example, and the code is short.\n\n[45:40] More words.",
    );
    expect(join).toMatchObject({ method: "text", at: 2710, words: "here and the program prints the result" });
  });

  it("does not use the words of a code block for the join", () => {
    const code = "```python\n# the words in this comment are the same in both clips of the video\n```";
    const first = `[44:00] One.\n\n[45:10] The first clip says this.\n\n${code}\n\n[45:40] And it stops in the middle of`;
    const second = `[45:00] the second clip says that.\n\n${code}\n\n[45:35] Here the text goes on.`;
    expect(joinTranscripts(first, second, overlap).join.method).toBe("time");
  });

  it("cuts at the middle of the overlap when no sentence is in both transcripts", () => {
    const first = "[44:00] Alpha words.\n\n[45:10] Beta words from the first clip.\n\n[45:40] Gamma words cut";
    const second = "[45:00] Different start.\n\n[45:35] Delta words from the second clip.\n\n[46:20] Epsilon.";
    const { text, join } = joinTranscripts(first, second, overlap);
    expect(text).toBe("[44:00] Alpha words.\n\n[45:10] Beta words from the first clip.\n\n[45:35] Delta words from the second clip.\n\n[46:20] Epsilon.");
    expect(join).toMatchObject({ method: "time", at: 2730, words: "" });
    expect(parseTranscript(text).map((paragraph) => paragraph.start)).toEqual([2640, 2710, 2735, 2780]);
  });
});
