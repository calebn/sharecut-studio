import { describe, expect, it } from "vitest";
import {
  chapterOps,
  chaptersOf,
  clipOps,
  clipsOf,
  deliverFacts,
  fixRoute,
} from "./deliverModel";

const chapters = chaptersOf([
  { time: 0, title: "Cold open" },
  { time: 312.4, title: "The old mill" },
]);

const clips = clipsOf([
  {
    id: "s1",
    track_id: "t1",
    start: 10,
    end: 40,
    score: 0.8,
    title_suggestion: "  A line  ",
    approved: false,
    review_required: false,
  },
  {
    id: "s2",
    track_id: "t1",
    start: 50,
    end: 70,
    score: 0.5,
    title_suggestion: null,
    approved: true,
    review_required: false,
  },
]);

describe("chaptersOf / clipsOf", () => {
  it("numbers chapters by position", () => {
    expect(chapters).toEqual([
      { id: "ch-0", at: 0, title: "Cold open" },
      { id: "ch-1", at: 312.4, title: "The old mill" },
    ]);
  });

  it("trims a suggested title and names an empty one", () => {
    expect(clips.map((c) => c.title)).toEqual(["A line", "Untitled clip"]);
    expect(clips[1]).toEqual({
      id: "s2",
      title: "Untitled clip",
      start: 50,
      end: 70,
      score: 0.5,
      approved: true,
    });
  });
});

describe("chapterOps", () => {
  it("is empty when nothing changed", () => {
    expect(chapterOps(chapters, [...chapters])).toEqual([]);
  });

  it("deletes a removed chapter by its time and title", () => {
    expect(chapterOps(chapters, [chapters[0] as (typeof chapters)[0]])).toEqual(
      [{ kind: "delete", at: 312.4, title: "The old mill" }],
    );
  });

  it("adds a chapter the project does not hold", () => {
    expect(
      chapterOps(chapters, [
        ...chapters,
        { id: "new-0", at: 900, title: "Mail" },
      ]),
    ).toEqual([{ kind: "add", at: 900, title: "Mail" }]);
  });

  it("updates a retimed or retitled chapter from its old time and title", () => {
    expect(
      chapterOps(chapters, [
        { id: "ch-0", at: 0, title: "Cold open" },
        { id: "ch-1", at: 320, title: "The mill" },
      ]),
    ).toEqual([
      {
        kind: "update",
        from: { at: 312.4, title: "The old mill" },
        at: 320,
        title: "The mill",
      },
    ]);
  });

  it("deletes before it adds", () => {
    expect(
      chapterOps(chapters, [
        chapters[0] as (typeof chapters)[0],
        { id: "new-0", at: 312.4, title: "Replaced" },
      ]).map((op) => op.kind),
    ).toEqual(["delete", "add"]);
  });
});

describe("clipOps", () => {
  it("keeps only what the document can hold", () => {
    const next = clips.map((c) =>
      c.id === "s1" ? { ...c, title: "New", approved: true } : c,
    );
    expect(clipOps(clips, next)).toEqual([]);
  });

  it("trims and deletes", () => {
    expect(
      clipOps(clips, [
        { ...(clips[0] as (typeof clips)[0]), start: 12, end: 38 },
      ]),
    ).toEqual([
      { kind: "trim", id: "s1", start: 12, end: 38 },
      { kind: "delete", id: "s2" },
    ]);
  });
});

describe("deliverFacts", () => {
  it("states what the project knows", () => {
    expect(
      deliverFacts({
        pendingReviewCount: 2,
        appliedEditCount: 5,
        comments: [
          { resolved: true },
          { resolved: false },
          { resolved: false },
        ],
        unsureWordsLeft: 4,
        mixUpToDate: false,
        chapterCount: 3,
        removedSeconds: 61.5,
      }),
    ).toEqual({
      suggestions: { decided: 5, total: 7 },
      comments: { resolved: 1, total: 3 },
      unsureWordsLeft: 4,
      mixUpToDate: false,
      loudness: "podcast",
      chapters: 3,
      editsSaved: 61.5,
    });
  });
});

describe("fixRoute", () => {
  it.each([
    ["edit", "mix", { kind: "refreshMix" }],
    [
      "review",
      "suggestions",
      { kind: "stage", stage: "review", section: "impact" },
    ],
    [
      "review",
      "comments",
      { kind: "stage", stage: "review", section: "comments" },
    ],
    ["review", "unsure-words", { kind: "stage", stage: "review" }],
    ["edit", "peaks", { kind: "stage", stage: "edit" }],
  ] as const)("%s %s", (stage, target, route) => {
    expect(fixRoute(stage, target)).toEqual(route);
  });
});
