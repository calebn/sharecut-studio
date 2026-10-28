import { describe, expect, it } from "vitest";
import {
  effectiveSection,
  prepareHandoff,
  reviewSectionsFor,
  stageAvailable,
} from "./hostModels";

describe("stageAvailable", () => {
  it.each([
    ["host", ["record", "prepare", "edit", "review", "deliver"]],
    ["editor", ["edit", "review"]],
    ["commenter", ["review"]],
    ["viewer", ["review"]],
  ] as const)("%s opens only its stages", (role, open) => {
    for (const stage of [
      "record",
      "prepare",
      "edit",
      "review",
      "deliver",
    ] as const) {
      expect(stageAvailable(stage, role)).toBe(open.includes(stage as never));
    }
  });
});

describe("review sections", () => {
  it("gives the host all three and a guest Comments", () => {
    expect(reviewSectionsFor("host")).toEqual([
      "comments",
      "impact",
      "tighten",
    ]);
    expect(reviewSectionsFor("commenter")).toEqual(["comments"]);
    expect(reviewSectionsFor("editor")).toEqual(["comments"]);
  });

  it("falls back to the first section the role has", () => {
    expect(effectiveSection("tighten", ["comments"])).toBe("comments");
    expect(effectiveSection("impact", reviewSectionsFor("host"))).toBe(
      "impact",
    );
  });
});

describe("prepareHandoff", () => {
  it("offers Review with the count once decisions wait, primary when idle", () => {
    expect(prepareHandoff({ busy: false, pendingReviewCount: 14 })).toEqual({
      label: "Review 14 suggestions",
      target: "review",
      primary: true,
    });
    expect(prepareHandoff({ busy: true, pendingReviewCount: 1 })).toMatchObject(
      { label: "Review 1 suggestion", primary: false },
    );
  });

  it("offers Edit when nothing waits", () => {
    expect(prepareHandoff({ busy: false, pendingReviewCount: 0 })).toEqual({
      label: "Edit",
      target: "edit",
      primary: true,
    });
  });
});
