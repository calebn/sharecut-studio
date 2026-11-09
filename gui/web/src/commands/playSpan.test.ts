import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { clearRegisteredCommands } from "./execute";
import { playSpan } from "./playSpan";
import { registerDawCommands } from "./register";

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore
    .getState()
    .hydrate(
      "/tmp/play-span/episode.sharecut",
      minimalProject({ timeline_duration_sec: 60, tracks: [sampleTrack()] }),
    );
  useDawStore.setState({ isPlaying: false, playUntilSec: null });
});

describe("playSpan", () => {
  it("plays the padded span and ends armed with its stop bound", () => {
    expect(playSpan(10, 12, 0.5)).toEqual({ status: "ok" });
    const s = useDawStore.getState();
    expect(s.isPlaying).toBe(true);
    expect(s.playheadSec).toBe(9.5);
    expect(s.playUntilSec).toBe(12.5);
  });
});
