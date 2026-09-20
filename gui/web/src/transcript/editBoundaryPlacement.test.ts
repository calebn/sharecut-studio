import { describe, expect, it } from "vitest";
import type { EditBoundaryView } from "../types/project";
import {
  indexBoundaryPlacements,
  type PlacementTurn,
  placeEditBoundaries,
} from "./editBoundaryPlacement";

function boundary(
  overrides: Partial<EditBoundaryView> &
    Pick<EditBoundaryView, "id" | "track_id" | "timeline_join_sec">,
): EditBoundaryView {
  return {
    left_clip_id: "L",
    right_clip_id: "R",
    cutaway_source_start: 0,
    cutaway_source_end: 0,
    has_cutaway: false,
    cutaway_word_ids: [],
    ...overrides,
  };
}

describe("placeEditBoundaries", () => {
  it("places every join once, including mid-turn joins", () => {
    const turns: PlacementTurn[] = [
      {
        trackId: "host",
        words: [
          { timelineStart: 0, timelineEnd: 1 },
          { timelineStart: 1, timelineEnd: 2 },
          { timelineStart: 2, timelineEnd: 3 },
        ],
      },
      {
        trackId: "guest",
        words: [{ timelineStart: 3, timelineEnd: 5 }],
      },
      {
        trackId: "host",
        words: [
          { timelineStart: 10, timelineEnd: 11 },
          { timelineStart: 11, timelineEnd: 12 },
        ],
      },
    ];
    const boundaries = [
      boundary({
        id: "eb-mid",
        track_id: "host",
        timeline_join_sec: 2.0,
      }),
      boundary({
        id: "eb-late",
        track_id: "host",
        timeline_join_sec: 11.5,
      }),
      boundary({
        id: "eb-guest",
        track_id: "guest",
        timeline_join_sec: 5.0,
      }),
    ];

    const placed = placeEditBoundaries(turns, boundaries);
    expect(placed).toHaveLength(3);
    expect(new Set(placed.map((p) => p.boundary.id)).size).toBe(3);

    const mid = placed.find((p) => p.boundary.id === "eb-mid")!;
    expect(mid.turnIndex).toBe(0);
    expect(mid.afterWordIndex).toBe(1); // after word ending at 2

    const late = placed.find((p) => p.boundary.id === "eb-late")!;
    expect(late.turnIndex).toBe(2);
    expect(late.afterWordIndex).toBe(0); // after word ending at 11

    const guest = placed.find((p) => p.boundary.id === "eb-guest")!;
    expect(guest.turnIndex).toBe(1);
    expect(guest.afterWordIndex).toBe(0);
  });

  it("indexes placements for render lookup", () => {
    const turns: PlacementTurn[] = [
      {
        trackId: "host",
        words: [
          { timelineStart: 0, timelineEnd: 1 },
          { timelineStart: 1, timelineEnd: 2 },
        ],
      },
    ];
    const placed = placeEditBoundaries(turns, [
      boundary({ id: "a", track_id: "host", timeline_join_sec: 1 }),
      boundary({ id: "b", track_id: "host", timeline_join_sec: 2 }),
    ]);
    const indexed = indexBoundaryPlacements(placed);
    expect(
      indexed
        .get(0)
        ?.get(0)
        ?.map((b) => b.id),
    ).toEqual(["a"]);
    expect(
      indexed
        .get(0)
        ?.get(1)
        ?.map((b) => b.id),
    ).toEqual(["b"]);
  });

  it("skips boundaries for tracks with no turns", () => {
    const placed = placeEditBoundaries(
      [{ trackId: "host", words: [{ timelineStart: 0, timelineEnd: 1 }] }],
      [boundary({ id: "x", track_id: "missing", timeline_join_sec: 1 })],
    );
    expect(placed).toHaveLength(0);
  });
});
