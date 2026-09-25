import { describe, expect, it } from "vitest";
import { isReady, refKind } from "./types";

describe("waveform types", () => {
  it("maps refs to the status kind that lists them", () => {
    expect(refKind("stem:host")).toBe("stem");
    expect(refKind("track:host")).toBe("raw");
    expect(refKind("source:abc")).toBe("raw");
  });

  it("narrows ready entries", () => {
    expect(isReady({ status: "generating" })).toBe(false);
    expect(isReady(null)).toBe(false);
    expect(
      isReady({
        status: "ready",
        key: "0".repeat(20),
        sample_rate: 48000,
        channels: 1,
        total_frames: 0,
        base_spp: 64,
        level_factor: 4,
        bins_per_tile: 4096,
        levels: [{ spp: 64, bins: 0 }],
      }),
    ).toBe(true);
  });
});
