import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  playbackTrackClipped,
  setPlaybackTrackClipped,
  subscribePlaybackClipLatches,
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

it("notifies mounted views on actual latch, track removal and project changes", () => {
  synchronizePlaybackClipLatches(1, ["host"]);
  const changed = vi.fn();
  const unsubscribe = subscribePlaybackClipLatches(changed);
  setPlaybackTrackClipped("host", true);
  setPlaybackTrackClipped("host", true);
  expect(changed).toHaveBeenCalledTimes(1);
  synchronizePlaybackClipLatches(1, []);
  expect(changed).toHaveBeenCalledTimes(2);
  synchronizePlaybackClipLatches(2, ["host"]);
  expect(changed).toHaveBeenCalledTimes(3);
  unsubscribe();
  setPlaybackTrackClipped("host", true);
  expect(changed).toHaveBeenCalledTimes(3);
});
