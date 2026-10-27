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
  coversRequest,
  currentExportState,
  estimateBytes,
  exportBlocker,
  exportRequest,
  formatClock,
  itemNames,
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
  validSelection,
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
    expect(clampPart({ start: -5, end: 30 }, 100)).toEqual({
      mode: "part",
      start: 0,
      end: 30,
    });
    expect(clampPart({ start: 90, end: 50 }, 100)).toEqual({
      mode: "part",
      start: 90,
      end: 91,
    });
    expect(clampPart({ start: 10, end: 5 }, 100)).toEqual({
      mode: "part",
      start: 10,
      end: 11,
    });
  });

  it("holds both ends inside the episode", () => {
    expect(clampPart({ start: 99.5, end: 200 }, 100)).toEqual({
      mode: "part",
      start: 99,
      end: 100,
    });
    expect(clampPart({ start: 200, end: 300 }, 100)).toEqual({
      mode: "part",
      start: 99,
      end: 100,
    });
    expect(clampPart({ start: 0, end: 0.2 }, 0.5)).toEqual({
      mode: "part",
      start: 0,
      end: 0.5,
    });
  });

  it("blocks an Out that is not after In", () => {
    const part = (start: number, end: number) => ({
      ...SETTINGS,
      part: { mode: "part" as const, start, end },
    });
    expect(exportBlocker(part(10, 10))).toBe("Out must come after In.");
    expect(exportBlocker(part(10, 5))).toBe("Out must come after In.");
    expect(exportBlocker(part(10, 11))).toBeUndefined();
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
    exportRequest({ ...SETTINGS, ...change }, clips, CHAPTERS);

  it("stays done while nothing changed", () => {
    expect(
      currentExportState(DONE, exportRequest(SETTINGS, CLIPS, CHAPTERS)).phase,
    ).toBe("done");
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

  it("goes stale when an approved clip or a chapter changes, and only then", () => {
    const stale = (clips = CLIPS, chapters = CHAPTERS) =>
      currentExportState(DONE, exportRequest(SETTINGS, clips, chapters))
        .phase === "stale";
    const edit = (id: string, change: object) =>
      CLIPS.map((c) => (c.id === id ? { ...c, ...change } : c));
    expect(stale(edit("k3", { end: 20 }))).toBe(true);
    expect(stale(edit("k3", { title: "Hello" }))).toBe(true);
    expect(stale(edit("k1", { title: "Hello", start: 1 }))).toBe(false);
    expect(stale(CLIPS, retimeChapter(CHAPTERS, "c2", 400))).toBe(true);
    expect(stale(CLIPS, removeChapter(CHAPTERS, "c2"))).toBe(true);
    expect(stale(CLIPS, addChapterAt(CHAPTERS, 50, "n"))).toBe(true);
    expect(stale(CLIPS, [...CHAPTERS])).toBe(false);
  });

  it("goes stale when an approved clip's In moves, not an unapproved one's", () => {
    const moved = (id: string) =>
      CLIPS.map((c) => (c.id === id ? { ...c, start: c.start + 1 } : c));
    const stale = (clips: typeof CLIPS) =>
      currentExportState(DONE, exportRequest(SETTINGS, clips, CHAPTERS))
        .phase === "stale";
    expect(stale(moved("k3"))).toBe(true);
    expect(stale(moved("k1"))).toBe(false);
    expect(stale(CLIPS)).toBe(false);
  });

  it("compares the range", () => {
    const wrote = { ...REQUEST, range: { start: 1, end: 5 } };
    expect(coversRequest(wrote, wrote)).toBe(true);
    expect(
      coversRequest(wrote, { ...wrote, range: { start: 1, end: 6 } }),
    ).toBe(false);
    expect(coversRequest(wrote, { ...wrote, range: null })).toBe(false);
  });

  it("accepts only a selection that can be exported", () => {
    expect(validSelection({ start: 5, end: 5 }, 100)).toBeNull();
    expect(validSelection({ start: 9, end: 3 }, 100)).toBeNull();
    expect(validSelection({ start: Number.NaN, end: 3 }, 100)).toBeNull();
    expect(validSelection({ start: 200, end: 300 }, 100)).toBeNull();
    expect(validSelection({ start: -5, end: 300 }, 100)).toEqual({
      start: 0,
      end: 100,
    });
    expect(validSelection(null, 100)).toBeNull();
  });

  it("plans the range from a selection, else the Deliver part, else the whole", () => {
    const part = { mode: "part", start: 10, end: 20 } as const;
    expect(planRange({ mode: "whole" })).toBeNull();
    expect(planRange(part)).toEqual({ start: 10, end: 20 });
    expect(planRange(part, { start: 50, end: 80 })).toEqual({
      start: 50,
      end: 80,
    });
    expect(REQUEST.clips.map((c) => c.id)).toEqual(["k3"]);
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

  it("never trims below zero or past the end, even for a clip under a second", () => {
    const short = [{ ...CLIPS[0]!, start: 0.2, end: 0.6 }];
    const out = trimClip(short, "k1", "start", -9, 100)[0]!;
    expect(out.start).toBe(0);
    const tail = [{ ...CLIPS[0]!, start: 99.8, end: 100 }];
    expect(trimClip(tail, "k1", "end", 150, 100)[0]!.end).toBe(100);
    expect(trimClip(tail, "k1", "end", 0, 100)[0]!.end).toBeLessThanOrEqual(
      100,
    );
  });

  it("trims only the clip asked for", () => {
    const next = trimClip(CLIPS, "k1", "end", 640, 3120);
    expect(next[0]?.end).toBe(640);
    expect(next[1]).toEqual(CLIPS[1]);
    expect(next[2]).toEqual(CLIPS[2]);
    expect(trimClip(CLIPS, "missing", "end", 640, 3120)).toEqual(CLIPS);
  });

  it("ignores a second restore of the same clip", () => {
    const gone = CLIPS[1]!;
    const once = restoreClip(removeClip(CLIPS, gone.id), gone, 1);
    expect(restoreClip(once, gone, 1)).toHaveLength(3);
  });

  it("names items without a title or with a repeated one", () => {
    expect(itemNames(["", "A", "A", "B"], "clip")).toEqual([
      "clip 1",
      "A 2",
      "A 3",
      "B",
    ]);
  });

  it("puts a removed clip back where it was", () => {
    const gone = CLIPS[1];
    if (!gone) throw new Error("fixture");
    const back = restoreClip(removeClip(CLIPS, gone.id), gone, 1);
    expect(back.map((c) => c.id)).toEqual(["k1", "k2", "k3"]);
  });
});

describe("peaks", () => {
  const peaks = (truePeak?: number) =>
    readinessRows({ ...CLEAR_FACTS, truePeak }).find((r) => r.id === "peaks");

  it("allows the limit itself and flags anything over it", () => {
    expect(peaks(-1.5)?.state).toBe("done");
    expect(peaks(-1.5)?.fix).toBeUndefined();
    expect(peaks(-1.4)?.state).toBe("needs-you");
    expect(peaks(-1.4)?.fix?.stage).toBe("edit");
    expect(peaks(undefined)?.fix).toBeUndefined();
    expect(peaks(-3)?.fix).toBeUndefined();
  });
});

describe("selections that are not finite", () => {
  it("fall back", () => {
    expect(
      validSelection({ start: 0, end: Number.POSITIVE_INFINITY }, 100),
    ).toBeNull();
    expect(
      validSelection({ start: Number.NEGATIVE_INFINITY, end: 5 }, 100),
    ).toBeNull();
    expect(validSelection({ start: 1, end: Number.NaN }, 100)).toBeNull();
  });
});

describe("what makes a finished export current", () => {
  const part = (start: number, end: number) => ({
    ...REQUEST,
    settings: { ...SETTINGS, part: { mode: "part" as const, start, end } },
  });

  it("compares In and Out even when a selection fixed the range", () => {
    const range = { start: 40, end: 90 };
    const wrote = { ...part(10, 20), range };
    expect(coversRequest(wrote, { ...part(10, 20), range })).toBe(true);
    expect(coversRequest(wrote, { ...part(10, 30), range })).toBe(false);
    expect(coversRequest(wrote, { ...part(5, 20), range })).toBe(false);
    expect(coversRequest(wrote, { ...REQUEST, range })).toBe(false);
  });

  it("is stale when something is added after the last item", () => {
    const later = [...CHAPTERS, { id: "z", at: 99999, title: "Epilogue" }];
    expect(coversRequest(REQUEST, { ...REQUEST, chapters: later })).toBe(false);
    expect(
      coversRequest(REQUEST, {
        ...REQUEST,
        clips: [...REQUEST.clips, { id: "zz", start: 0, end: 5, title: "x" }],
      }),
    ).toBe(false);
  });
});

describe("part mode in the stale check", () => {
  it("is stale when a whole-episode export becomes a Part with the same range", () => {
    const range = { start: 10, end: 20 };
    const whole = { ...REQUEST, range };
    const part = {
      ...REQUEST,
      settings: {
        ...SETTINGS,
        part: { mode: "part" as const, start: 10, end: 20 },
      },
      range,
    };
    expect(coversRequest(whole, part)).toBe(false);
    expect(coversRequest(part, whole)).toBe(false);
  });
});

describe("clip file names", () => {
  const named = (title: string) =>
    clipFiles([{ ...CLIPS[0]!, title, approved: true }]).map((f) => f.name);

  it("trim and collapse punctuation", () => {
    expect(named("!Hook")).toEqual(["clips/hook.wav"]);
    expect(named("A: B")).toEqual(["clips/a-b.wav"]);
    expect(named("  --Hook!!  ")).toEqual(["clips/hook.wav"]);
  });

  it("size each file from the clip's length", () => {
    const [file] = clipFiles([
      { ...CLIPS[0]!, start: 10, end: 20, approved: true },
    ]);
    expect(file?.bytes).toBe(estimateBytes("wav", 10));
  });
});

describe("readiness fixes", () => {
  it("one open suggestion is still needs-you and the summary says so", () => {
    const rows = readinessRows({
      ...CLEAR_FACTS,
      suggestions: { decided: 13, total: 14 },
    });
    expect(rows.find((r) => r.id === "suggestions")?.state).toBe("needs-you");
    expect(readinessSummary(rows)).toBe("1 thing left. You can still export.");
  });

  it("sends every open row to its own stage and item", () => {
    const rows = readinessRows({
      ...CLEAR_FACTS,
      suggestions: { decided: 13, total: 14 },
      comments: { resolved: 2, total: 3 },
      unsureWordsLeft: 1,
      mixUpToDate: false,
      truePeak: -1,
    });
    expect(
      rows
        .filter((r) => r.fix)
        .map((r) => [r.id, r.fix?.label, r.fix?.stage, r.fix?.target]),
    ).toEqual([
      ["suggestions", "Review", "review", "suggestions"],
      ["comments", "Resolve", "review", "comments"],
      ["unsure", "Check", "review", "unsure-words"],
      ["mix", "Refresh mix", "edit", "mix"],
      ["peaks", "Fix", "edit", "peaks"],
    ]);
    expect(readinessRows(CLEAR_FACTS).filter((r) => r.fix)).toEqual([]);
  });
});

describe("readiness rows say what they mean", () => {
  const row = (id: string, facts = CLEAR_FACTS) =>
    readinessRows(facts).find((r) => r.id === id);

  it("mix, peaks, chapters and edits saved", () => {
    expect(row("mix")?.state).toBe("done");
    expect(row("mix")?.detail).toBe("Current");
    const stale = row("mix", { ...CLEAR_FACTS, mixUpToDate: false });
    expect(stale?.state).toBe("needs-you");
    expect(stale?.detail).toBe("Edited since the last mix");
    expect(row("peaks")?.title).toBe("Peaks under −1.5 dBTP");
    expect(row("peaks")?.detail).toBe("Checked on export");
    expect(row("peaks", { ...CLEAR_FACTS, truePeak: -2.1 })?.detail).toBe(
      "−2.1 dBTP",
    );
    expect(row("chapters", { ...CLEAR_FACTS, chapters: 7 })?.detail).toBe("7");
    expect(row("saved", { ...CLEAR_FACTS, editsSaved: 4.5 })?.detail).toBe(
      "4.5 s",
    );
    expect(row("unsure", { ...CLEAR_FACTS, unsureWordsLeft: 3 })?.detail).toBe(
      "3 left",
    );
  });
});

describe("comparing what an export wrote", () => {
  it("does not depend on the order clips were approved in", () => {
    const two = [
      { id: "a", start: 0, end: 5, title: "A" },
      { id: "b", start: 6, end: 9, title: "B" },
    ];
    const one = { ...REQUEST, clips: two };
    expect(coversRequest(one, { ...one, clips: [...two].reverse() })).toBe(
      true,
    );
  });

  it("ignores approval order for any number of clips", () => {
    const ids = ["c", "a", "d", "b"];
    const list = ids.map((id, i) => ({ id, start: i, end: i + 5, title: id }));
    const base = { ...REQUEST, clips: list };
    for (const order of [
      [...list].reverse(),
      [list[1]!, list[3]!, list[0]!, list[2]!],
    ]) {
      expect(coversRequest(base, { ...base, clips: order })).toBe(true);
    }
  });

  it("tells a whole-episode export from a ranged one in either direction", () => {
    const ranged = { ...REQUEST, range: { start: 1, end: 5 } };
    expect(coversRequest(REQUEST, ranged)).toBe(false);
    expect(coversRequest(ranged, REQUEST)).toBe(false);
    expect(
      coversRequest(ranged, { ...REQUEST, range: { start: 2, end: 5 } }),
    ).toBe(false);
    expect(
      coversRequest(ranged, { ...REQUEST, range: { start: 1, end: 6 } }),
    ).toBe(false);
  });

  it("notices a clip or chapter that is a different one with the same content", () => {
    const clip = REQUEST.clips[0]!;
    expect(
      coversRequest(REQUEST, { ...REQUEST, clips: [{ ...clip, id: "other" }] }),
    ).toBe(false);
    const first = CHAPTERS[0]!;
    expect(
      coversRequest(REQUEST, {
        ...REQUEST,
        chapters: [{ ...first, id: "other" }, ...CHAPTERS.slice(1)],
      }),
    ).toBe(false);
  });

  it("sizes each approved clip file from its own length", () => {
    const all = CLIPS.map((c) => ({ ...c, approved: true }));
    expect(clipFiles(all).map((f) => f.bytes)).toEqual(
      all.map((c) => estimateBytes("wav", c.end - c.start)),
    );
  });
});

describe("round three of the audit", () => {
  it.each([
    [[], 7, "Chapter 1"],
    [["Chapter 1"], 5, "Chapter 2"],
    [["Chapter 2"], 5, "Chapter 3"],
    [["Chapter 2", "Chapter 3"], 5, "Chapter 4"],
    [["Chapter 3", "Chapter 4"], 5, "Chapter 5"],
    [["Intro", "Chapter 2", "Chapter 3"], 5, "Chapter 4"],
    [["Chapter 2", "Chapter 3", "Chapter 4"], 5, "Chapter 5"],
  ])("names the chapter after %j as %s", (titles, _at, expected) => {
    const chapters = titles.map((title, i) => ({ id: `c${i}`, at: i, title }));
    const next = addChapterAt(chapters, 99, "new");
    expect(next.find((c) => c.id === "new")?.title).toBe(expected);
  });

  it.each([
    ["1:23", 83],
    [" 1:23 ", 83],
    ["1:23 ", 83],
    [" 1:23", 83],
    ["\t83.5\n", 83.5],
    ["1:23.5", 83.5],
    ["0", 0],
    ["83.5s", null],
    ["1:2:3", null],
    ["1:23x", null],
    ["x1:23", null],
    ["-5", null],
    ["", null],
    ["  ", null],
    ["1:", null],
    [":23", null],
    ["1.5:23", null],
  ])("reads %j as %s", (text, seconds) => {
    expect(parseClock(text)).toBe(seconds);
  });

  it.each([
    [
      ["a", "b"],
      ["a", "b"],
    ],
    [
      ["a", "a"],
      ["a 1", "a 2"],
    ],
    [
      ["a", "a ", " a"],
      ["a 1", "a 2", "a 3"],
    ],
    [
      ["", "  ", "b"],
      ["x 1", "x 2", "b"],
    ],
    [
      ["b", "", "b"],
      ["b 1", "x 2", "b 3"],
    ],
  ])("names %j as %j", (titles, names) => {
    expect(itemNames(titles, "x")).toEqual(names);
  });

  it("reads a decided count out of the total for suggestions and comments", () => {
    const rows = readinessRows({
      ...CLEAR_FACTS,
      suggestions: { decided: 10, total: 14 },
      comments: { resolved: 1, total: 3 },
    });
    expect(rows.find((r) => r.id === "suggestions")?.detail).toBe("10 of 14");
    expect(rows.find((r) => r.id === "comments")?.detail).toBe("1 of 3");
  });

  it.each([
    ["podcast", "−16.0 LUFS target, will be checked"],
    ["broadcast", "−23.0 LUFS target, will be checked"],
    ["streaming", "−14.0 LUFS target, will be checked"],
  ] as const)(
    "gives the %s loudness row its own target",
    (loudness, detail) => {
      expect(
        readinessRows({ ...CLEAR_FACTS, loudness }).find(
          (r) => r.id === "loudness",
        )?.detail,
      ).toBe(detail);
    },
  );

  it("blocks Export while the model is missing, before any other reason", () => {
    const needs = { phase: "needs-model", model: "m", size: "1 GB" } as const;
    expect(exportBlocker(SETTINGS, needs)).toBe(
      "Needs the transcription model.",
    );
    expect(exportBlocker({ ...SETTINGS, formats: [] }, needs)).toBe(
      "Needs the transcription model.",
    );
    expect(exportBlocker(SETTINGS)).toBeUndefined();
  });

  it("keeps Out inside the episode when In is the episode end", () => {
    expect(clampPart({ start: 3120, end: 3120 }, 3120)).toEqual({
      mode: "part",
      start: 3119,
      end: 3120,
    });
  });
});

describe("every readiness row keeps its exact title", () => {
  const worst = {
    ...CLEAR_FACTS,
    suggestions: { decided: 1, total: 14 },
    comments: { resolved: 0, total: 3 },
    unsureWordsLeft: 2,
    mixUpToDate: false,
    truePeak: -0.5,
  };
  it.each([
    ["all clear", CLEAR_FACTS, "done"],
    ["everything open", worst, "needs-you"],
  ] as const)("%s", (_name, facts, state) => {
    const rows = readinessRows(facts);
    expect(rows.map((r) => [r.id, r.title])).toEqual([
      ["suggestions", "Suggestions decided"],
      ["comments", "Comments resolved"],
      ["unsure", "Unsure words checked"],
      ["mix", "Mix up to date"],
      ["loudness", "Loudness"],
      ["peaks", "Peaks under −1.5 dBTP"],
      ["chapters", "Chapters"],
      ["saved", "Edits saved"],
    ]);
    const flagged = rows.filter((r) => r.state === "needs-you");
    expect(flagged.map((r) => r.id)).toEqual(
      state === "done"
        ? []
        : ["suggestions", "comments", "unsure", "mix", "peaks"],
    );
  });
});

describe("parseClock fractions", () => {
  it.each([
    ["1:23.45", 83.45],
    ["83.25", 83.25],
    ["0:00.125", 0.125],
    ["12.5", 12.5],
    ["1:23.0", 83],
    ["0.5", 0.5],
  ])("reads %j as %f", (text, seconds) => {
    expect(parseClock(text)).toBeCloseTo(seconds, 9);
  });
  it.each(["1:23.", "1.2.3", ".5", "1:.5", "1:23.4.5"])(
    "rejects %j",
    (text) => {
      expect(parseClock(text)).toBeNull();
    },
  );
});

describe("parseClock integer parts and formatClock rounding", () => {
  it.each([
    ["125", 125],
    ["125.5", 125.5],
    ["3600", 3600],
    ["100", 100],
    ["999.9", 999.9],
    ["10:05", 605],
    ["125:00", 7500],
    ["1:125", 185],
    ["0:07", 7],
    ["007", 7],
  ])("reads %j as %f", (text, seconds) => {
    expect(parseClock(text)).toBeCloseTo(seconds, 9);
  });

  it.each([
    [12.31, "0:12.3"],
    [12.36, "0:12.4"],
    [59.96, "1:00.0"],
    [59.94, "0:59.9"],
    [0, "0:00.0"],
    [-3, "0:00.0"],
    [3119.99, "52:00.0"],
  ])("shows %f s as %s", (seconds, shown) => {
    expect(formatClock(seconds)).toBe(shown);
  });
});
