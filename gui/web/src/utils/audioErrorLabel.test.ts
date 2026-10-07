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
  it("tells an editor to refresh and a guest to ask the host", () => {
    expect(NO_PREVIEW_ERROR).toBe("No mix preview yet");
    expect(noPreviewReason(true)).toBe(
      "No mix preview yet. Refresh the mix to hear it.",
    );
    expect(noPreviewReason(false)).toBe(
      "No mix preview yet. The host needs to refresh the mix.",
    );
  });
});
