import { afterEach, beforeEach, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { livePlayheadSec } from "./livePlayhead";
import { bindPlaybackClock } from "./playbackClock";

let unbind: (() => void) | null = null;

beforeEach(() => {
  useDawStore.setState({ playheadSec: 40 });
});

afterEach(() => {
  unbind?.();
  unbind = null;
});

it("reads the store playhead when no transport plays", () => {
  expect(livePlayheadSec()).toBe(40);
});

it("reads the audio clock while a transport plays", () => {
  unbind = bindPlaybackClock(() => 100);
  expect(livePlayheadSec()).toBe(100);
});
