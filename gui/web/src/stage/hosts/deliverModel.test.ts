import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  chapterOps,
  clipOps,
  clipsOf,
  deliverFacts,
  editHeadOf,
  fixRoute,
  sameClipBounds,
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
  it("keeps only what the document can hold", () => {
    const next = [{ ...lineA, title: "New", approved: true }, lineB];
    expect(clipOps(clips, next)).toEqual([]);
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

describe("sameClipBounds", () => {
  it("is true for the same ids and bounds, whatever else changed", () => {
    expect(sameClipBounds([lineA, lineB], [lineA, lineB])).toBe(true);
    expect(
      sameClipBounds(
        [lineA],
        [{ ...lineA, title: "Renamed", approved: true, score: 0.1 }],
      ),
    ).toBe(true);
  });

  it("is false when a bound, an id or the count differs", () => {
    expect(sameClipBounds([lineA], [{ ...lineA, start: 11 }])).toBe(false);
    expect(sameClipBounds([lineA], [{ ...lineA, end: 41 }])).toBe(false);
    expect(sameClipBounds([lineA], [{ ...lineA, id: "other" }])).toBe(false);
    expect(sameClipBounds([lineA, lineB], [lineA])).toBe(false);
    expect(sameClipBounds([lineA], [lineA, lineB])).toBe(false);
  });
});
