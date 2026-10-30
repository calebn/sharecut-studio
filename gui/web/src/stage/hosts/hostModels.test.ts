import { describe, expect, it } from "vitest";
import {
  effectiveSection,
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
  it("gives every role the Queue alone", () => {
    expect(reviewSectionsFor("host")).toEqual(["queue"]);
    expect(reviewSectionsFor("commenter")).toEqual(["queue"]);
    expect(reviewSectionsFor("editor")).toEqual(["queue"]);
  });

  it("falls back to the first section the role has", () => {
    expect(effectiveSection("queue", ["comments"])).toBe("comments");
    expect(effectiveSection("queue", reviewSectionsFor("host"))).toBe("queue");
    expect(effectiveSection("queue", ["comments"])).toBe("comments");
  });
});
