import { describe, expect, it } from "vitest";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import type { Selection } from "../types/project";
import {
  clipClickSelection,
  inspectKeyOf,
  selectedClipIdsOf,
  selectedTrackIdsOf,
  settleSelection,
  trackClickSelection,
  tracksSelection,
} from "./selection";

const project = minimalProject({
  tracks: [sampleTrack({ id: "host" }), sampleTrack({ id: "guest" })],
  clips: {
    tracks: {
      host: [clipRow({ id: "c1", track_id: "host" })],
      guest: [clipRow({ id: "g1", track_id: "guest" })],
    },
    clip_count: 2,
  },
});

const clip = (id: string, trackId: string, ids?: string[]): Selection =>
  ids ? { kind: "clip", id, trackId, ids } : { kind: "clip", id, trackId };

describe("the sets a selection holds", () => {
  it("reads clips from a clip selection and nothing from any other kind", () => {
    expect(selectedClipIdsOf(clip("c1", "host"))).toEqual(["c1"]);
    expect(selectedClipIdsOf(clip("g1", "guest", ["c1", "g1"]))).toEqual([
      "c1",
      "g1",
    ]);
    expect(selectedClipIdsOf({ kind: "track", trackId: "host" })).toEqual([]);
    expect(selectedClipIdsOf(null)).toEqual([]);
  });

  it("reads tracks from a track selection or a range, and nothing from any other kind", () => {
    expect(selectedTrackIdsOf({ kind: "track", trackId: "host" })).toEqual([
      "host",
    ]);
    expect(
      selectedTrackIdsOf({
        kind: "track",
        trackId: "host",
        trackIds: ["guest", "host"],
      }),
    ).toEqual(["guest", "host"]);
    expect(
      selectedTrackIdsOf({
        kind: "range",
        target: {
          kind: "exact_range",
          intervals: [{ start: 1, end: 2 }],
          track_ids: ["guest"],
          clips: [],
          media_seals: {},
        },
      }),
    ).toEqual(["guest"]);
    expect(selectedTrackIdsOf(clip("c1", "host"))).toEqual([]);
    expect(selectedTrackIdsOf(null)).toEqual([]);
  });

  it("returns the same array for the same selection", () => {
    const selection = clip("c1", "host");
    expect(selectedClipIdsOf(selection)).toBe(selectedClipIdsOf(selection));
    const tracks = tracksSelection(["host", "guest"]);
    expect(selectedTrackIdsOf(tracks)).toBe(selectedTrackIdsOf(tracks));
  });
});

describe("writing a selection", () => {
  it("keeps the held clips when the primary is chosen again", () => {
    const held = clip("g1", "guest", ["c1", "g1"]);
    expect(settleSelection(held, clip("c1", "host"))).toEqual(
      clip("c1", "host", ["c1", "g1"]),
    );
  });

  it("replaces the clips when another clip is chosen", () => {
    const held = clip("g1", "guest", ["c1", "g1"]);
    const next = clip("other", "host");
    expect(settleSelection(held, next)).toEqual(next);
  });

  it("drops the clip set when the selection leaves clips", () => {
    const held = clip("g1", "guest", ["c1", "g1"]);
    const next: Selection = { kind: "track", trackId: "host" };
    expect(settleSelection(held, next)).toEqual(next);
    expect(selectedClipIdsOf(settleSelection(held, next))).toEqual([]);
  });

  it("keeps the held tracks when one of them is chosen again", () => {
    const held = tracksSelection(["host", "guest"]);
    expect(settleSelection(held, { kind: "track", trackId: "guest" })).toEqual({
      kind: "track",
      trackId: "guest",
      trackIds: ["host", "guest"],
    });
  });
});

describe("clicking a clip", () => {
  it("selects it alone on a plain click", () => {
    const held = clip("c1", "host");
    expect(clipClickSelection(held, project, "g1", "guest")).toEqual(
      clip("g1", "guest"),
    );
  });

  it("adds it and makes it primary on Shift", () => {
    const held = clip("c1", "host");
    expect(
      clipClickSelection(held, project, "g1", "guest", { shift: true }),
    ).toEqual(clip("g1", "guest", ["c1", "g1"]));
  });

  it("toggles it on Mod, handing the primary to the last clip held", () => {
    const held = clip("g1", "guest", ["c1", "g1"]);
    expect(
      clipClickSelection(held, project, "g1", "guest", { mod: true }),
    ).toEqual(clip("c1", "host"));
    expect(
      clipClickSelection(held, project, "c1", "host", { mod: true }),
    ).toEqual(clip("g1", "guest"));
  });

  it("clears the selection when Mod removes the last clip", () => {
    expect(
      clipClickSelection(clip("c1", "host"), project, "c1", "host", {
        mod: true,
      }),
    ).toBeNull();
  });
});

describe("clicking a track header", () => {
  it("selects the track alone on a plain click", () => {
    expect(
      trackClickSelection(tracksSelection(["host", "guest"]), "guest", false),
    ).toEqual({ kind: "track", trackId: "guest" });
  });

  it("toggles it into the held tracks when additive", () => {
    const one = trackClickSelection(null, "host", true);
    const two = trackClickSelection(one, "guest", true);
    expect(selectedTrackIdsOf(two)).toEqual(["host", "guest"]);
    expect(two).toMatchObject({ trackId: "guest" });
    expect(trackClickSelection(two, "guest", true)).toEqual({
      kind: "track",
      trackId: "host",
    });
  });

  it("clears the selection when the last track is toggled off", () => {
    expect(
      trackClickSelection({ kind: "track", trackId: "host" }, "host", true),
    ).toBeNull();
  });

  it("names no tracks as no selection", () => {
    expect(tracksSelection([])).toBeNull();
  });
});

describe("what the Inspector is open for", () => {
  it("keeps a track, its envelope and its points as one object", () => {
    const track = inspectKeyOf({ kind: "track", trackId: "host" });
    expect(inspectKeyOf({ kind: "envelope", trackId: "host" })).toBe(track);
    expect(
      inspectKeyOf({ kind: "envelopePoint", trackId: "host", pointId: "p1" }),
    ).toBe(track);
    expect(inspectKeyOf({ kind: "track", trackId: "guest" })).not.toBe(track);
  });

  it("gives another clip another object", () => {
    expect(inspectKeyOf(clip("c1", "host"))).not.toBe(
      inspectKeyOf(clip("c2", "host")),
    );
  });
});
