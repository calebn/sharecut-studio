import { expect, it } from "vitest";
import { bindPlaybackClock, playbackPositionSec } from "./playbackClock";

it("reads the live clock and protects a new owner from old cleanup", () => {
  let position = 3;
  const old = bindPlaybackClock(() => position);
  expect(playbackPositionSec() ?? 0).toBe(3);
  position = 4;
  expect(playbackPositionSec() ?? 0).toBe(4);
  const current = bindPlaybackClock(() => 7);
  old();
  expect(playbackPositionSec() ?? 0).toBe(7);
  current();
  expect(playbackPositionSec() ?? 2).toBe(2);
});

it("falls back while the active player has no usable timeline clock", () => {
  const unavailable = bindPlaybackClock(() => null);
  expect(playbackPositionSec() ?? 2).toBe(2);
  unavailable();
  const invalid = bindPlaybackClock(() => Number.NaN);
  expect(playbackPositionSec() ?? 5).toBe(5);
  invalid();
});
