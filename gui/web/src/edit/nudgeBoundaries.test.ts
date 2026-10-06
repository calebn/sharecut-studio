import { describe, expect, it } from "vitest";
import {
  clipRow,
  minimalProject,
  pendingEditView,
  sampleTrack,
} from "../test/fixtures";
import { firstBoundaryCrossed, softBoundaries } from "./nudgeBoundaries";

const project = minimalProject({
  tracks: [sampleTrack({ id: "host" }), sampleTrack({ id: "guest" })],
  clips: {
    tracks: {
      host: [
        clipRow({
          id: "a",
          track_id: "host",
          timeline_start: 0,
          timeline_end: 10,
        }),
        clipRow({
          id: "b",
          track_id: "host",
          timeline_start: 10,
          timeline_end: 20,
        }),
        clipRow({
          id: "c",
          track_id: "host",
          timeline_start: 20,
          timeline_end: 30,
        }),
      ],
      guest: [
        clipRow({
          id: "g",
          track_id: "guest",
          timeline_start: 5,
          timeline_end: 15,
        }),
      ],
    },
    clip_count: 4,
  },
  chapters: [{ time: 12, title: "Intro" }],
  pending_edits: [
    pendingEditView({
      id: "p1",
      track_id: "host",
      timeline_start: 24,
      timeline_end: 26,
    }),
  ],
});

const secs = (b: { sec: number; label: string }[]) =>
  b.map((x) => `${x.sec} ${x.label}`).sort();

describe("softBoundaries", () => {
  it("lists the playhead, chapters and the track's clip and pending edges, less the mover's own", () => {
    expect(
      secs(
        softBoundaries(
          project,
          { kind: "pending", editId: "p1", trackId: "host" },
          3,
        ),
      ),
    ).toEqual(
      [
        "3 the playhead",
        "12 chapter “Intro”",
        "0 a clip edge",
        "10 a clip edge",
        "10 a clip edge",
        "20 a clip edge",
        "20 a clip edge",
        "30 a clip edge",
      ].sort(),
    );
  });

  it("leaves out what a ripple trim carries along: the rest of its track", () => {
    expect(
      secs(
        softBoundaries(
          project,
          { kind: "clip", clipId: "b", trackId: "host", ripple: true },
          null,
        ),
      ),
    ).toEqual(["0 a clip edge", "12 chapter “Intro”"].sort());
  });
});

describe("firstBoundaryCrossed", () => {
  const marks = [
    { sec: 10, label: "ten" },
    { sec: 12, label: "twelve" },
  ];

  it("finds the nearest boundary reached or crossed, either way", () => {
    expect(firstBoundaryCrossed(9, 13, marks)?.label).toBe("ten");
    expect(firstBoundaryCrossed(13, 9, marks)?.label).toBe("twelve");
    expect(firstBoundaryCrossed(11, 12, marks)?.label).toBe("twelve");
  });

  it("does not count the boundary a move starts on, nor one out of reach", () => {
    expect(firstBoundaryCrossed(10, 11, marks)).toBeNull();
    expect(firstBoundaryCrossed(10.5, 11.5, marks)).toBeNull();
  });
});
