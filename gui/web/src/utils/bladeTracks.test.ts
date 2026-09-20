import { describe, expect, it } from "vitest";
import { bladeTrackIds } from "./bladeTracks";

describe("bladeTrackIds", () => {
  it("uses selection when present", () => {
    expect(bladeTrackIds(["host"], ["host", "guest"])).toEqual(["host"]);
  });

  it("falls back to all dialogue tracks", () => {
    expect(bladeTrackIds([], ["host", "guest"])).toEqual(["host", "guest"]);
  });
});
