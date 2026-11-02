import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  chapterOps,
  clipOps,
  clipsOf,
  clipWordsOf,
  deliverFacts,
  editHeadOf,
  fixRoute,
  sameClips,
} from "./deliverModel";

const coldOpen = { id: "ch-0", at: 0, title: "Cold open" };
const oldMill = { id: "ch-1", at: 312.4, title: "The old mill" };
const chapters = [coldOpen, oldMill];

const lineA = {
  id: "s1",
  title: "A line",
  start: 10,
  end: 40,
  score: 0.8,
  approved: false,
};
const lineB = {
  id: "s2",
  title: "Untitled clip",
  start: 50,
  end: 70,
  score: 0.5,
  approved: true,
};
const clips = [lineA, lineB];

describe("clipsOf", () => {
  it("trims a suggested title and names an empty one", () => {
    const view = (id: string, title: string | null) => ({
      id,
      track_id: "t1",
      start: 10,
      end: 40,
      score: 0.8,
      title_suggestion: title,
      approved: false,
      review_required: false,
    });
    expect(
      clipsOf([view("s1", "  A line  "), view("s2", null)]).map((c) => c.title),
    ).toEqual(["A line", "Untitled clip"]);
  });
});

describe("chapterOps", () => {
  it("is empty when nothing changed", () => {
    expect(chapterOps(chapters, [...chapters])).toEqual([]);
  });

  it("deletes a removed chapter by its time and title", () => {
    expect(chapterOps(chapters, [coldOpen])).toEqual([
      { kind: "delete", at: 312.4, title: "The old mill" },
    ]);
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
        coldOpen,
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
        coldOpen,
        { id: "new-0", at: 312.4, title: "Replaced" },
      ]).map((op) => op.kind),
    ).toEqual(["delete", "add"]);
  });
});

describe("clipOps", () => {
  it("sends a retitle and an approval as one details op", () => {
    const next = [{ ...lineA, title: " New ", approved: true }, lineB];
    expect(clipOps(clips, next)).toEqual([
      { kind: "details", id: "s1", title: "New", approved: true },
    ]);
  });

  it("sends only the field that changed, and unapproves", () => {
    expect(clipOps(clips, [{ ...lineA, title: "New" }, lineB])).toEqual([
      { kind: "details", id: "s1", title: "New" },
    ]);
    expect(clipOps(clips, [lineA, { ...lineB, approved: false }])).toEqual([
      { kind: "details", id: "s2", approved: false },
    ]);
  });

  it("clears a title that was emptied, and ignores one the project already shows as untitled", () => {
    expect(clipOps(clips, [{ ...lineA, title: "  " }, lineB])).toEqual([
      { kind: "details", id: "s1", title: "" },
    ]);
    expect(clipOps(clips, [lineA, { ...lineB, title: "" }])).toEqual([]);
  });

  it("sends nothing for a title only padded with spaces", () => {
    expect(clipOps(clips, [{ ...lineA, title: "A line " }, lineB])).toEqual([]);
  });

  it("trims and deletes", () => {
    expect(clipOps(clips, [{ ...lineA, start: 12, end: 38 }])).toEqual([
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
      { kind: "stage", stage: "review", section: "queue" },
    ],
    [
      "review",
      "comments",
      { kind: "stage", stage: "review", section: "queue", comment: true },
    ],
    [
      "review",
      "unsure-words",
      { kind: "stage", stage: "review", section: "queue" },
    ],
    ["edit", "peaks", { kind: "stage", stage: "edit" }],
  ] as const)("%s %s", (stage, target, route) => {
    expect(fixRoute(stage, target)).toEqual(route);
  });
});

describe("editHeadOf", () => {
  const cut = { id: "e1", operation: "cut" };
  const preview = { id: "p1", operation: "render_preview" };
  it("is the head when it is an edit", () => {
    expect(editHeadOf({ head_id: "e1", groups: [cut] })).toBe("e1");
  });
  it("skips mix rebuild entries", () => {
    expect(editHeadOf({ head_id: "p1", groups: [cut, preview] })).toBe("e1");
    expect(
      editHeadOf({
        head_id: "p1",
        groups: [{ before_id: "b", after_id: "a", operation: "cut" }, preview],
      }),
    ).toBe("a");
  });
  it("counts the state before a mix rebuild as the edit head", () => {
    expect(
      editHeadOf({
        head_id: "p2",
        groups: [
          { before_id: "p1", after_id: "p2", operation: "render_preview" },
        ],
      }),
    ).toBe("p1");
  });
  it("stops at the head, so an undone edit is not counted", () => {
    expect(
      editHeadOf({
        head_id: "e1",
        groups: [cut, { id: "e2", operation: "cut" }],
      }),
    ).toBe("e1");
  });
  it("falls back to the head with no groups", () => {
    expect(editHeadOf({ head_id: "root", groups: [] })).toBe("root");
  });
  it("does not know the edit head of a history shown without groups", () => {
    expect(editHeadOf({ head_id: "p1", groups: [] })).toBeUndefined();
  });

  type FixtureEntry = {
    id: string;
    label: string;
    operation: string | null;
  };
  function groupsOf(entries: FixtureEntry[]) {
    const groups: {
      id?: string;
      before_id?: string;
      after_id?: string;
      operation: string | null;
    }[] = [];
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const next = entries[i + 1];
      if (
        next &&
        entry.label.startsWith("before ") &&
        next.label.startsWith("after ")
      ) {
        groups.push({
          before_id: entry.id,
          after_id: next.id,
          operation: next.operation,
        });
        i += 1;
      } else {
        groups.push({ id: entry.id, operation: entry.operation });
      }
    }
    return groups;
  }
  const fixture = JSON.parse(
    readFileSync(
      `${process.cwd()}/../../tests/fixtures/edit_head/cases.json`,
      "utf8",
    ),
  ) as {
    cases: {
      name: string;
      entries: FixtureEntry[];
      cursor: number;
      expected: string;
    }[];
  };
  it.each(fixture.cases)("agrees with the server on $name", (c) => {
    const head = c.entries[c.cursor]?.id ?? "root";
    expect(editHeadOf({ head_id: head, groups: groupsOf(c.entries) })).toBe(
      c.expected,
    );
  });
});

describe("sameClips", () => {
  it("is true for the same clips, whatever else changed", () => {
    expect(sameClips([lineA, lineB], [lineA, lineB])).toBe(true);
    expect(sameClips([lineA], [{ ...lineA, score: 0.1 }])).toBe(true);
  });

  it("reads an empty title as the untitled clip", () => {
    expect(sameClips([lineB], [{ ...lineB, title: "  " }])).toBe(true);
    expect(sameClips([lineA], [{ ...lineA, title: " A line " }])).toBe(true);
  });

  it("is false when a bound, an id, a title, an approval or the count differs", () => {
    expect(sameClips([lineA], [{ ...lineA, start: 11 }])).toBe(false);
    expect(sameClips([lineA], [{ ...lineA, end: 41 }])).toBe(false);
    expect(sameClips([lineA], [{ ...lineA, id: "other" }])).toBe(false);
    expect(sameClips([lineA], [{ ...lineA, title: "Renamed" }])).toBe(false);
    expect(sameClips([lineA], [{ ...lineA, approved: true }])).toBe(false);
    expect(sameClips([lineA, lineB], [lineA])).toBe(false);
    expect(sameClips([lineA], [lineA, lineB])).toBe(false);
  });
});

describe("clipWordsOf", () => {
  const utterance = (words: object[]) =>
    [
      { track_id: "t", speaker: "A", start: 0, end: 9, text: "", words },
    ] as unknown as Parameters<typeof clipWordsOf>[0];
  const w = (text: string, extra: object = {}) => ({
    text,
    start: 1,
    end: 2,
    timeline_start: 11,
    timeline_end: 12,
    ...extra,
  });

  it("takes timeline-clock times, not source times", () => {
    expect(clipWordsOf(utterance([w("hi")]))).toEqual([
      { text: "hi", start: 11, end: 12 },
    ]);
  });

  it("leaves out cut, suppressed and ignored words", () => {
    expect(
      clipWordsOf(
        utterance([
          w("cut", { timeline_start: null, timeline_end: null }),
          w("gone", { suppressed: true }),
          w("muted", { ignored: true }),
          w("bad", { mappable: false }),
          w("backwards", { timeline_start: 12, timeline_end: 11 }),
          w("never", { timeline_end: Number.NaN }),
          w("forever", { timeline_end: Number.POSITIVE_INFINITY }),
          w("kept"),
        ]),
      ),
    ).toEqual([{ text: "kept", start: 11, end: 12 }]);
  });

  it("is undefined with no words", () => {
    expect(clipWordsOf(undefined)).toBeUndefined();
    expect(clipWordsOf(utterance([]))).toBeUndefined();
  });

  it("reads an utterance that carries no words field as empty", () => {
    const bare = [
      { track_id: "t", speaker: "A", start: 0, end: 9, text: "" },
    ] as unknown as Parameters<typeof clipWordsOf>[0];
    expect(clipWordsOf(bare)).toBeUndefined();
  });
});
