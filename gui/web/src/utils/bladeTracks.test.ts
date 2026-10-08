import { describe, expect, it } from "vitest";
import { bladeCutNote, bladeTrackIds, dialogueTrackIds } from "./bladeTracks";

describe("bladeTrackIds", () => {
  it("uses selection when present", () => {
    expect(bladeTrackIds(["host"], ["host", "guest"])).toEqual(["host"]);
  });

  it("falls back to all dialogue tracks", () => {
    expect(bladeTrackIds([], ["host", "guest"])).toEqual(["host", "guest"]);
  });
});

const tracks = [
  { id: "host", label: "Avery", role: "dialogue" },
  { id: "guest", label: "Blair", role: "dialogue" },
  { id: "music", label: "Bed", role: "music" },
] as const;

describe("dialogueTrackIds", () => {
  it("lists the dialogue tracks in order", () => {
    expect(dialogueTrackIds(tracks)).toEqual(["host", "guest"]);
  });
});

describe("bladeCutNote", () => {
  it("names every dialogue track when none is selected", () => {
    expect(bladeCutNote(tracks, [])).toBe("Cuts all dialogue tracks");
  });

  it("names the selected tracks by their labels", () => {
    expect(bladeCutNote(tracks, ["guest", "music"])).toBe("Cuts Blair, Bed");
  });

  it("falls back to the id of a selected track it does not know", () => {
    expect(bladeCutNote(tracks, ["gone"])).toBe("Cuts gone");
  });
});
