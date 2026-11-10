import { describe, expect, it } from "vitest";
import { laneMarkers } from "../timeline/laneMarkers";
import { shownTitle } from "./clipTitle";

describe("shownTitle", () => {
  it("names a missing, empty or blank title the untitled clip", () => {
    expect(shownTitle(null)).toBe("Untitled clip");
    expect(shownTitle("")).toBe("Untitled clip");
    expect(shownTitle("   ")).toBe("Untitled clip");
  });

  it("trims a real title", () => {
    expect(shownTitle("  A line  ")).toBe("A line");
  });

  it("is the title a lane marker carries for a clip with none", () => {
    const markers = laneMarkers({
      chapters: [],
      socialClips: [
        {
          id: "manual_ab12cd34ef",
          track_id: "t1",
          start: 60,
          end: 75,
          score: 0,
          title_suggestion: null,
          approved: false,
          review_required: true,
        },
      ],
      comments: [],
    });
    expect(markers).toMatchObject([{ kind: "clip", title: "Untitled clip" }]);
  });
});
