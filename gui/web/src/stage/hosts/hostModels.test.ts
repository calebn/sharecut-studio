import { describe, expect, it } from "vitest";
import type { RecordSnapshot } from "../../record";
import {
  effectiveSection,
  recordStatusOf,
  reviewSectionsFor,
  stageAvailable,
} from "./hostModels";

const snap = (state: RecordSnapshot["state"]): RecordSnapshot => ({
  session_id: "s",
  state,
  take_index: 0,
  participants: [],
  caps: { recorded: 0, producers: 0 },
});

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

describe("recordStatusOf", () => {
  it("separates idle, live, paused and saving", () => {
    expect(recordStatusOf(null).kind).toBe("idle");
    expect(recordStatusOf(snap("lobby")).kind).toBe("idle");
    expect(recordStatusOf(snap("recording")).kind).toBe("live");
    expect(recordStatusOf(snap("paused")).kind).toBe("paused");
    expect(recordStatusOf(snap("stopped")).kind).toBe("saving");
  });

  it("says a take survives a stage switch", () => {
    expect(recordStatusOf(snap("recording")).detail).toMatch(/does not stop/);
  });
});
