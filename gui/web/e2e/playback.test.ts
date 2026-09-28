import { describe, expect, it, vi } from "vitest";
import { PAUSE_HOLD_MS, PLAYBACK_ADVANCE_SEC, playButton } from "./playback";

describe("playButton", () => {
  it("queries the exact Play button", () => {
    const getByRole = vi.fn(() => "the-play-button");
    const page = { getByRole } as never;
    expect(playButton(page)).toBe("the-play-button");
    expect(getByRole).toHaveBeenCalledWith("button", {
      name: "Play",
      exact: true,
    });
  });
});

describe("playback timing constants", () => {
  it("are positive", () => {
    expect(PLAYBACK_ADVANCE_SEC).toBeGreaterThan(0);
    expect(PAUSE_HOLD_MS).toBeGreaterThan(0);
  });
});
