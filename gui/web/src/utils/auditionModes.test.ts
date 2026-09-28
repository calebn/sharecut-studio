import { describe, expect, it } from "vitest";
import { AUDITION_MODES, GUESTS_HEAR_FULL_MIX } from "./auditionModes";

describe("AUDITION_MODES", () => {
  it("has one row per AuditionMode id, in mix/fx/raw order", () => {
    expect(AUDITION_MODES.map((m) => m.id)).toEqual(["mix", "fx", "raw"]);
  });

  it("labels the rows Full mix / Edited stems / Original", () => {
    expect(AUDITION_MODES.map((m) => m.label)).toEqual([
      "Full mix",
      "Edited stems",
      "Original",
    ]);
  });

  it("keeps a non-empty title for every row", () => {
    for (const mode of AUDITION_MODES) {
      expect(mode.title.length).toBeGreaterThan(0);
    }
  });
});

describe("GUESTS_HEAR_FULL_MIX", () => {
  it("names Full mix", () => {
    expect(GUESTS_HEAR_FULL_MIX).toBe("Guests listen in Full mix");
  });
});
