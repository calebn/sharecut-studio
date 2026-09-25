import { act, render, renderHook } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubMatchMedia } from "../test/matchMedia";
import { stubRaf } from "../test/raf";
import type { ClipRow } from "../types/project";
import { useClipWaveform } from "./useClipWaveform";

const paintWaveform = vi.hoisted(() => vi.fn());

vi.mock("../timeline/drawWaveform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../timeline/drawWaveform")>()),
  paintWaveform,
}));
vi.mock("../audio/waveformScheduler", () => ({
  PRIORITY_LOUPE: 0,
  PRIORITY_POINTER: 1,
  PRIORITY_VISIBLE: 2,
  requestWaveformTiles: () => [],
  subscribeWaveformTiles: () => () => undefined,
}));
vi.mock("../api", () => ({
  loadWaveformSnap: () => Promise.resolve(null),
}));

const mockState = {
  projectPath: "",
  scrollLeft: 0,
  playheadSec: 0,
  waveformAmpZoom: 1,
  auditionMode: "raw",
  guestMode: null,
  shareCapabilities: null,
  pointerTrackId: null,
  measureTimelineViewport: () => 800,
};

vi.mock("../state/useDaw", () => ({
  useDaw: (sel: (s: typeof mockState) => unknown) => sel(mockState),
}));

const clip: ClipRow = {
  id: "c1",
  track_id: "host",
  source_start: 0,
  source_end: 4,
  timeline_start: 0,
  timeline_end: 4,
  fade_in_ms: 0,
  fade_out_ms: 0,
  join_in_mode: "fade",
  source_id: null,
};

function useWave(laneHeight = 72) {
  return useClipWaveform({
    clip,
    trackId: "host",
    mediaPath: null,
    mediaVersion: "",
    zoomPxPerSec: 50,
    sourceStart: 0,
    sourceEnd: 4,
    peaks: null,
    trimActive: false,
    bladeHoverSec: null,
    selected: false,
    color: "var(--clip-dialogue-0)",
    laneHeight,
  });
}

describe("useClipWaveform paint", () => {
  let raf: ReturnType<typeof stubRaf>;

  beforeEach(() => {
    paintWaveform.mockClear();
    raf = stubRaf();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("paints the main canvas and the trim ghost in the same frame", () => {
    const { result } = renderHook(() => useWave());
    const main = document.createElement("canvas");
    const ghost = document.createElement("canvas");
    act(() => {
      result.current.paint(main);
      result.current.paint(ghost, {
        sourceStart: 4,
        sourceEnd: 5,
        cssWidth: 50,
      });
    });
    act(() => raf.fire(16));

    expect(paintWaveform.mock.calls.map(([canvas]) => canvas)).toEqual([
      main,
      ghost,
    ]);
    expect(paintWaveform.mock.calls[0]?.[1]).toMatchObject({
      sourceStart: 0,
      sourceEnd: 4,
    });
    expect(paintWaveform.mock.calls[1]?.[1]).toMatchObject({
      sourceStart: 4,
      sourceEnd: 5,
      cssWidth: 50,
    });
  });

  it("keeps the latest request per canvas", () => {
    const { result } = renderHook(() => useWave());
    const ghost = document.createElement("canvas");
    act(() => {
      result.current.paint(ghost, {
        sourceStart: 4,
        sourceEnd: 5,
        cssWidth: 50,
      });
      result.current.paint(ghost, {
        sourceStart: 4,
        sourceEnd: 6,
        cssWidth: 100,
      });
    });
    act(() => raf.fire(16));

    expect(paintWaveform).toHaveBeenCalledTimes(1);
    expect(paintWaveform.mock.calls[0]?.[1]).toMatchObject({ sourceEnd: 6 });
  });
});

/** Mirrors ClipBlock: paint on every render. */
function Clip({
  laneHeight = 72,
  tick = 0,
}: {
  laneHeight?: number;
  tick?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wave = useWave(laneHeight);
  useEffect(() => {
    wave.paint(canvasRef.current);
  });
  return <canvas ref={canvasRef} data-tick={tick} />;
}

describe("useClipWaveform paint key", () => {
  let raf: ReturnType<typeof stubRaf>;

  beforeEach(() => {
    paintWaveform.mockClear();
    raf = stubRaf();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips repaint when a re-render leaves the inputs unchanged", () => {
    const { rerender } = render(<Clip tick={0} />);
    act(() => raf.fire(16));
    expect(paintWaveform).toHaveBeenCalledTimes(1);

    // A playhead tick re-renders every clip with the same paint inputs.
    for (let tick = 1; tick <= 5; tick++) {
      rerender(<Clip tick={tick} />);
      act(() => raf.fire(16 + tick * 16));
    }
    expect(paintWaveform).toHaveBeenCalledTimes(1);
  });

  it("repaints when the lane height changes", () => {
    const { rerender } = render(<Clip laneHeight={72} />);
    act(() => raf.fire(16));
    rerender(<Clip laneHeight={150} />);
    act(() => raf.fire(32));
    expect(paintWaveform).toHaveBeenCalledTimes(2);
  });
});

describe("useClipWaveform theme", () => {
  let raf: ReturnType<typeof stubRaf>;

  beforeEach(() => {
    paintWaveform.mockClear();
    raf = stubRaf();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.theme;
  });

  it("repaints when the Theme menu flips html[data-theme]", async () => {
    document.documentElement.dataset.theme = "dark";
    render(<Clip />);
    act(() => raf.fire(16));
    expect(paintWaveform).toHaveBeenCalledTimes(1);

    await act(async () => {
      document.documentElement.dataset.theme = "light";
      await Promise.resolve();
    });
    act(() => raf.fire(32));
    expect(paintWaveform).toHaveBeenCalledTimes(2);
  });

  it("repaints when the OS scheme flips under the system theme", async () => {
    const media = stubMatchMedia(false);
    render(<Clip />);
    act(() => raf.fire(16));
    expect(paintWaveform).toHaveBeenCalledTimes(1);

    act(() => media.setMatches(true));
    act(() => raf.fire(32));
    expect(paintWaveform).toHaveBeenCalledTimes(2);
  });
});
