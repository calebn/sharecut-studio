import { describe, expect, it } from "vitest";
import {
  audioErrorLabel,
  NO_PREVIEW_ERROR,
  noPreviewReason,
} from "./audioErrorLabel";

describe("audioErrorLabel", () => {
  it("names the known transport audio problems", () => {
    expect(audioErrorLabel("Failed to load audio (mix)")).toBe(
      "Audio failed to load",
    );
    expect(
      audioErrorLabel("Browser blocked autoplay. Click Play in the transport"),
    ).toBe("Tap Play to start");
  });

  it("falls back to a readable generic label", () => {
    expect(audioErrorLabel("The operation was aborted.")).toBe("Audio error");
  });
});

describe("noPreviewReason", () => {
  it("says Full mix is silent, and who can fix it", () => {
    expect(NO_PREVIEW_ERROR).toBe("No mix yet");
    expect(noPreviewReason(true)).toBe(
      "Full mix is silent until you refresh the mix.",
    );
    expect(noPreviewReason(false)).toBe(
      "Full mix is silent until the host refreshes the mix.",
    );
  });
});
