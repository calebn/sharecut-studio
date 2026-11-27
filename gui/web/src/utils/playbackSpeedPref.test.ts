import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatPlaybackSpeed,
  nextPlaybackSpeed,
  PLAYBACK_SPEED_STORAGE_KEY,
  PLAYBACK_SPEEDS,
  readPlaybackSpeedPref,
  writePlaybackSpeedPref,
} from "./playbackSpeedPref";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("playback speed preference", () => {
  it("offers four presets", () => {
    expect([...PLAYBACK_SPEEDS]).toEqual([1, 1.25, 1.5, 2]);
  });

  it("reads 1x when nothing is stored", () => {
    expect(readPlaybackSpeedPref()).toBe(1);
  });

  it("round-trips every preset", () => {
    for (const speed of PLAYBACK_SPEEDS) {
      writePlaybackSpeedPref(speed);
      expect(localStorage.getItem(PLAYBACK_SPEED_STORAGE_KEY)).toBe(
        String(speed),
      );
      expect(readPlaybackSpeedPref()).toBe(speed);
    }
  });

  it.each(["3", "0", "-1", "1.3", "fast", "", "NaN", "Infinity"])(
    "falls back to 1x for a stored %j",
    (stored) => {
      localStorage.setItem(PLAYBACK_SPEED_STORAGE_KEY, stored);
      expect(readPlaybackSpeedPref()).toBe(1);
    },
  );

  it("never throws when storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readPlaybackSpeedPref()).toBe(1);
    expect(() => writePlaybackSpeedPref(1.5)).not.toThrow();
  });

  it("steps through the presets and wraps 2x to 1x", () => {
    expect(nextPlaybackSpeed(1)).toBe(1.25);
    expect(nextPlaybackSpeed(1.25)).toBe(1.5);
    expect(nextPlaybackSpeed(1.5)).toBe(2);
    expect(nextPlaybackSpeed(2)).toBe(1);
  });

  it("steps an unknown rate to the first preset after 1x", () => {
    expect(nextPlaybackSpeed(4)).toBe(1);
  });

  it("formats with the multiplication sign", () => {
    expect(formatPlaybackSpeed(1.5)).toBe("1.5×");
    expect(formatPlaybackSpeed(2)).toBe("2×");
  });
});
