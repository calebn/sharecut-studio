import { describe, expect, it, vi } from "vitest";
import { registerDawCommands } from "../commands/register";
import { seekTransport } from "../commands/seek";
import { useDawStore } from "../state/dawStore";
import { paddedAuditionWindow, playTimelineRange } from "./playRange";

describe("paddedAuditionWindow", () => {
  it("pads and clamps to zero", () => {
    expect(paddedAuditionWindow(10, 12, 0.5)).toEqual({
      start: 9.5,
      end: 12.5,
    });
    expect(paddedAuditionWindow(0.1, 0.2, 0.5).start).toBe(0);
  });
});

describe("playTimelineRange", () => {
  it("uses beginAudition when provided", () => {
    const beginAudition = vi.fn();
    playTimelineRange({
      start: 10,
      end: 12,
      padSec: 0.5,
      beginAudition,
      setPlayheadSec: vi.fn(),
      setPlayUntilSec: vi.fn(),
      setIsPlaying: vi.fn(),
    });
    expect(beginAudition).toHaveBeenCalledWith({
      playheadSec: 9.5,
      untilSec: 12.5,
    });
  });

  it("without beginAudition the stop bound is armed after playback starts", () => {
    useDawStore.setState({ isPlaying: false, playUntilSec: null });
    const { setPlayheadSec, setIsPlaying, setPlayUntilSec } =
      useDawStore.getState();
    playTimelineRange({
      start: 10,
      end: 12,
      padSec: 0.5,
      setPlayheadSec,
      setIsPlaying,
      setPlayUntilSec,
    });
    const s = useDawStore.getState();
    expect(s.isPlaying).toBe(true);
    expect(s.playheadSec).toBe(9.5);
    expect(s.playUntilSec).toBe(12.5);
  });

  it("arms the stop bound after a seek through the transport.seek command", () => {
    registerDawCommands();
    useDawStore.setState({ isPlaying: false, playUntilSec: null });
    const { setIsPlaying, setPlayUntilSec } = useDawStore.getState();
    playTimelineRange({
      start: 10,
      end: 12,
      padSec: 0.5,
      setPlayheadSec: (sec) => void seekTransport(sec),
      setIsPlaying,
      setPlayUntilSec,
    });
    const s = useDawStore.getState();
    expect(s.playheadSec).toBe(9.5);
    expect(s.isPlaying).toBe(true);
    expect(s.playUntilSec).toBe(12.5);
  });
});
