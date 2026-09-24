import { describe, expect, it } from "vitest";
import { audioErrorLabel } from "./audioErrorLabel";

describe("audioErrorLabel", () => {
  it("names the known transport audio problems", () => {
    expect(audioErrorLabel("No premix. Run Pipeline or render-preview")).toBe(
      "No preview",
    );
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
