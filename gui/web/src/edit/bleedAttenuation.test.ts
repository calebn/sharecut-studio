import { describe, expect, it } from "vitest";
import {
  type BleedAttenuationRegion,
  bleedAttenuationRegionKey,
  bleedAttenuationRegionLabel,
} from "./bleedAttenuation";

const region: BleedAttenuationRegion<{ seal: string }> = {
  trackId: "host",
  occurrenceId: "first-copy",
  kind: "late_gate",
  sourceSpan: { start: 20, end: 21 },
  timelineSpan: { start: 5, end: 6 },
  restore: {
    state: "available",
    target: { seal: "opaque" },
    sourceSpan: { start: 20, end: 21 },
  },
};

describe("automatic reduction display identity", () => {
  it("distinguishes repeated occurrences, kinds and either clock without depending on a target seal", () => {
    const original = bleedAttenuationRegionKey(region);
    for (const change of [
      { occurrenceId: "second-copy" },
      { trackId: "guest" },
      { kind: "bleed_mute:off_speaker" as const },
      { sourceSpan: { start: 20, end: 20.5 } },
      { timelineSpan: { start: 50, end: 51 } },
    ]) {
      expect(bleedAttenuationRegionKey({ ...region, ...change })).not.toBe(
        original,
      );
    }
    expect(
      bleedAttenuationRegionKey({
        ...region,
        restore: { state: "unavailable", reason: "Recording changed" },
      }),
    ).toBe(original);
  });

  it("labels both clocks without claiming foreign speech or audible recovery", () => {
    expect(bleedAttenuationRegionLabel(region)).toBe(
      "Automatic reduction, timeline 5.000 to 6.000 s, source 20.000 to 21.000 s",
    );
    expect(
      bleedAttenuationRegionLabel({
        ...region,
        kind: "bleed_mute:off_speaker",
      }),
    ).toContain("Automatic speaker mute");
  });
});
