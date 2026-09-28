import { describe, expect, it } from "vitest";
import { sampleTrack } from "../test/fixtures";
import {
  outputGainTitle,
  reorderHandleTitle,
  trackSubtitle,
} from "./trackHeaderCopy";

describe("trackSubtitle", () => {
  it("shows nothing that repeats the track name", () => {
    expect(
      trackSubtitle(
        sampleTrack({ id: "caleb", label: "Caleb", role: "Caleb" }),
      ),
    ).toBe("");
  });

  it("trims and case-folds before comparing to the name", () => {
    expect(
      trackSubtitle(
        sampleTrack({ id: "caleb", label: "Caleb", role: " caleb " }),
      ),
    ).toBe("");
  });

  it("joins role and speaker when neither matches the name", () => {
    expect(
      trackSubtitle(
        sampleTrack({
          id: "mira-voice",
          label: "Mira voice",
          role: "dialogue",
          speaker: "Mira",
        }),
      ),
    ).toBe("dialogue · Mira");
  });

  it("falls back to the id when there is no label", () => {
    expect(
      trackSubtitle(sampleTrack({ id: "track-1", label: "", role: "track-1" })),
    ).toBe("");
  });

  it("never repeats the same word twice", () => {
    expect(
      trackSubtitle(
        sampleTrack({
          id: "mira",
          label: "Mira",
          role: "dialogue",
          speaker: "dialogue",
        }),
      ),
    ).toBe("dialogue");
  });
});

describe("reorderHandleTitle", () => {
  it("names both the drag and keyboard paths", () => {
    const title = reorderHandleTitle();
    expect(title).toContain("Drag to reorder");
    expect(title).toContain("↑");
    expect(title).toContain("↓");
  });
});

describe("outputGainTitle", () => {
  it("explains what plays and where to change it", () => {
    expect(outputGainTitle(-3, -1, -2)).toBe(
      "Plays at −3.0 dB: staging −1.0 dB, volume −2.0 dB. Change the volume in the track details",
    );
  });
});
