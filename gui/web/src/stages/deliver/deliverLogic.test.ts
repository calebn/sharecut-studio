import { describe, expect, it } from "vitest";
import {
  CHAPTERS,
  CLEAR_FACTS,
  CLIPS,
  DONE,
  OPEN_FACTS,
  REQUEST,
  SETTINGS,
} from "./deliverFixture";
import {
  addChapterAt,
  approveClip,
  clampPart,
  clipFiles,
  clipStrength,
  currentExportState,
  estimateBytes,
  exportBlocker,
  exportRequest,
  formatClock,
  parseClock,
  partSeconds,
  planRange,
  primaryAction,
  readinessRows,
  readinessSummary,
  removeChapter,
  removeClip,
  restoreChapter,
  restoreClip,
  retimeChapter,
  trimClip,
} from "./deliverLogic";

describe("readiness", () => {
  it("says ready when nothing is open", () => {
    expect(readinessSummary(readinessRows(CLEAR_FACTS))).toBe(
      "Ready to export",
    );
  });

  it("counts open rows and never blocks export", () => {
    const rows = readinessRows(OPEN_FACTS);
    expect(readinessSummary(rows)).toBe("2 things left. You can still export.");
    expect(
      exportBlocker({
        formats: ["mp3"],
        loudness: "podcast",
        part: { mode: "whole" },
      }),
    ).toBeUndefined();
  });

  it("opens the right stage with the item selected", () => {
    const fixes = readinessRows(OPEN_FACTS).filter((r) => r.fix);
    expect(
      fixes.map((r) => [r.fix?.label, r.fix?.stage, r.fix?.target]),
    ).toEqual([
      ["Resolve", "review", "comments"],
      ["Check", "review", "unsure-words"],
    ]);
  });

  it("shows the target before an export and the measurement after", () => {
    const before = readinessRows(CLEAR_FACTS).find((r) => r.id === "loudness");
    expect(before?.detail).toBe("−16.0 LUFS target, will be checked");
    const after = readinessRows({ ...CLEAR_FACTS, measuredLufs: -16.2 }).find(
      (r) => r.id === "loudness",
    );
    expect(after?.detail).toBe("−16.2 LUFS");
  });

  it("flags peaks over the limit", () => {
    const row = readinessRows({ ...CLEAR_FACTS, truePeak: -0.4 }).find(
      (r) => r.id === "peaks",
    );
    expect(row?.state).toBe("needs-you");
    expect(row?.fix?.stage).toBe("edit");
  });
});

describe("export settings", () => {
  it("estimates sizes from the length", () => {
    expect(estimateBytes("mp3", 3000)).toBe(48_000_000);
    expect(estimateBytes("mp3", 0)).toBe(0);
  });

  it("exports the part's length, not the episode's", () => {
    expect(partSeconds({ mode: "whole" }, 3000)).toBe(3000);
    expect(partSeconds({ mode: "part", start: 60, end: 150 }, 3000)).toBe(90);
  });

  it("keeps In and Out inside the episode and apart", () => {
    expect(clampPart({ start: -5, end: 30 }, 100, "start")).toEqual({
      mode: "part",
      start: 0,
      end: 30,
    });
    expect(clampPart({ start: 90, end: 50 }, 100, "start")).toEqual({
      mode: "part",
      start: 90,
      end: 91,
    });
    expect(clampPart({ start: 10, end: 5 }, 100, "end")).toEqual({
      mode: "part",
      start: 10,
      end: 11,
    });
  });

  it("needs a format", () => {
    expect(
      exportBlocker({
        formats: [],
        loudness: "podcast",
        part: { mode: "whole" },
      }),
    ).toBe("Choose a format first.");
  });

  it("swaps Export for Reveal or Download only after a current export", () => {
    expect(primaryAction({ phase: "never" }, "app")).toBe("export");
    expect(
      primaryAction({ phase: "running", progress: 0.2, detail: "" }, "app"),
    ).toBe("exporting");
    expect(primaryAction(DONE, "app")).toBe("reveal");
    expect(primaryAction(DONE, "browser")).toBe("download");
    expect(primaryAction({ ...DONE, phase: "stale" }, "app")).toBe("export");
    expect(primaryAction({ phase: "failed", cause: "" }, "app")).toBe("export");
  });
});

describe("export contract", () => {
  const now = (change: Partial<typeof SETTINGS>, clips = CLIPS) =>
    exportRequest({ ...SETTINGS, ...change }, clips);

  it("stays done while nothing changed", () => {
    expect(currentExportState(DONE, exportRequest(SETTINGS, CLIPS)).phase).toBe(
      "done",
    );
  });

  it("goes stale when a format, the loudness, the part or the clips change", () => {
    const stale = (request: ReturnType<typeof now>) =>
      currentExportState(DONE, request).phase === "stale";
    expect(stale(now({ formats: ["mp3", "wav", "flac"] }))).toBe(true);
    expect(stale(now({ loudness: "streaming" }))).toBe(true);
    expect(stale(now({ part: { mode: "part", start: 0, end: 60 } }))).toBe(
      true,
    );
    expect(stale(now({}, approveClip(CLIPS, "k1")))).toBe(true);
    expect(stale(now({ formats: ["wav", "mp3"] }))).toBe(false);
  });

  it("plans the range from a selection, else the Deliver part, else the whole", () => {
    const part = { mode: "part", start: 10, end: 20 } as const;
    expect(planRange({ mode: "whole" })).toBeNull();
    expect(planRange(part)).toEqual({ start: 10, end: 20 });
    expect(planRange(part, { start: 50, end: 80 })).toEqual({
      start: 50,
      end: 80,
    });
    expect(REQUEST.clipIds).toEqual(["k3"]);
  });
});

describe("clock", () => {
  it("round trips", () => {
    expect(formatClock(83.5)).toBe("1:23.5");
    expect(parseClock("1:23.5")).toBe(83.5);
    expect(parseClock("83")).toBe(83);
    expect(parseClock("1:23")).toBe(83);
    expect(parseClock("soon")).toBeNull();
    expect(formatClock(59.96)).toBe("1:00.0");
    expect(formatClock(0)).toBe("0:00.0");
  });
});

describe("chapters", () => {
  it("adds in time order and numbers the title", () => {
    const next = addChapterAt(CHAPTERS, 700, "x");
    expect(next.map((c) => c.id)).toEqual(["c1", "c2", "x", "c3", "c4"]);
    expect(next[2]?.title).toBe("Chapter 5");
  });

  it("never repeats a title after a delete", () => {
    const two = CHAPTERS.slice(0, 2).map((c, i) => ({
      ...c,
      title: `Chapter ${i + 1}`,
    }));
    const next = addChapterAt(removeChapter(two, two[0]?.id ?? ""), 900, "x");
    expect(new Set(next.map((c) => c.title)).size).toBe(next.length);
  });

  it("restores only the removed chapter into the current list", () => {
    const gone = CHAPTERS[1];
    if (!gone) throw new Error("fixture");
    const edited = retimeChapter(removeChapter(CHAPTERS, gone.id), "c1", 5);
    const back = restoreChapter(edited, gone);
    expect(back.map((c) => c.id)).toEqual(["c1", "c2", "c3", "c4"]);
    expect(back[0]?.at).toBe(5);
    expect(restoreChapter(back, gone)).toHaveLength(4);
  });

  it("re-sorts after a retime and removes by id", () => {
    expect(retimeChapter(CHAPTERS, "c1", 2000).map((c) => c.id)).toEqual([
      "c2",
      "c3",
      "c1",
      "c4",
    ]);
    expect(removeChapter(CHAPTERS, "c2")).toHaveLength(3);
  });
});

describe("clips", () => {
  it("maps the score to three bars", () => {
    expect([0.1, 0.4, 0.69, 0.7, 0.99].map(clipStrength)).toEqual([
      1, 2, 2, 3, 3,
    ]);
  });

  it("lists approved clips as files next to the episode", () => {
    expect(clipFiles(CLIPS).map((f) => f.name)).toEqual([
      "clips/cold-open.wav",
    ]);
    expect(clipFiles(approveClip(CLIPS, "k1"))).toHaveLength(2);
  });

  it("gives clips with the same or an empty title their own names", () => {
    const same = CLIPS.map((c) => ({ ...c, approved: true, title: "Hook!" }));
    const named = clipFiles(same).map((f) => f.name);
    expect(new Set(named).size).toBe(3);
    expect(named).toEqual([
      "clips/hook.wav",
      "clips/hook-2.wav",
      "clips/hook-3.wav",
    ]);
    expect(clipFiles([{ ...same[0]!, title: "" }]).map((f) => f.name)).toEqual([
      "clips/clip.wav",
    ]);
  });

  it("trims inside the episode and keeps a second between In and Out", () => {
    expect(trimClip(CLIPS, "k1", "end", 600, 3120)[0]?.end).toBe(613);
    expect(trimClip(CLIPS, "k1", "start", 9999, 3120)[0]?.start).toBe(652);
  });

  it("puts a removed clip back where it was", () => {
    const gone = CLIPS[1];
    if (!gone) throw new Error("fixture");
    const back = restoreClip(removeClip(CLIPS, gone.id), gone, 1);
    expect(back.map((c) => c.id)).toEqual(["k1", "k2", "k3"]);
  });
});
