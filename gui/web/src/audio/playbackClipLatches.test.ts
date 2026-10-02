import { beforeEach, describe, expect, it } from "vitest";
import {
  playbackTrackClipped,
  setPlaybackTrackClipped,
  synchronizePlaybackClipLatches,
} from "./playbackClipLatches";

beforeEach(() => synchronizePlaybackClipLatches(-1, []));

describe("playback clip safety state", () => {
  it("keeps latches on retained tracks and drops removed tracks", () => {
    synchronizePlaybackClipLatches(1, ["host", "guest"]);
    setPlaybackTrackClipped("host", true);
    setPlaybackTrackClipped("guest", true);
    synchronizePlaybackClipLatches(1, ["host"]);
    expect(playbackTrackClipped("host", 1)).toBe(true);
    expect(playbackTrackClipped("guest", 1)).toBe(false);
    synchronizePlaybackClipLatches(1, ["host", "guest"]);
    expect(playbackTrackClipped("guest", 1)).toBe(false);
  });

  it("resets latches for a new project even when track IDs match", () => {
    synchronizePlaybackClipLatches(1, ["host"]);
    setPlaybackTrackClipped("host", true);
    expect(playbackTrackClipped("host", 2)).toBe(false);
    synchronizePlaybackClipLatches(2, ["host"]);
    expect(playbackTrackClipped("host", 2)).toBe(false);
  });
});
