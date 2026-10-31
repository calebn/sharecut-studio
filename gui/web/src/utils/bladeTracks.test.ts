import { describe, expect, it } from "vitest";
import { bladeTrackIds, dialogueTrackIds } from "./bladeTracks";

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
