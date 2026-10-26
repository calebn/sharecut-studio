import { describe, expect, it } from "vitest";
import { CHAPTERS, CLEAR_FACTS, CLIPS, OPEN_FACTS } from "./deliverFixture";
import {
  addChapterAt,
  approveClip,
  clampPart,
  clipFiles,
  clipStrength,
  estimateBytes,
  exportBlocker,
  formatBytes,
  formatClock,
  parseClock,
  partSeconds,
  primaryAction,
  readinessRows,
  readinessSummary,
  removeChapter,
  retimeChapter,
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
    expect(formatBytes(48_000_000)).toBe("48 MB");
    expect(formatBytes(1_500_000_000)).toBe("1.5 GB");
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
    expect(primaryAction({ phase: "done", files: [], when: "" }, "app")).toBe(
      "reveal",
    );
    expect(
      primaryAction({ phase: "done", files: [], when: "" }, "browser"),
    ).toBe("download");
    expect(primaryAction({ phase: "stale", files: [], when: "" }, "app")).toBe(
      "export",
    );
    expect(primaryAction({ phase: "failed", cause: "" }, "app")).toBe("export");
  });
});

describe("clock", () => {
  it("round trips", () => {
    expect(formatClock(83.5)).toBe("1:23.5");
    expect(parseClock("1:23.5")).toBe(83.5);
    expect(parseClock("83")).toBe(83);
    expect(parseClock("1:23")).toBe(83);
    expect(parseClock("soon")).toBeNull();
  });
});

describe("chapters", () => {
  it("adds in time order and numbers the title", () => {
    const next = addChapterAt(CHAPTERS, 700, "x");
    expect(next.map((c) => c.id)).toEqual(["c1", "c2", "x", "c3", "c4"]);
    expect(next[2]?.title).toBe("Chapter 5");
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
});
