import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import type { ClipRow } from "../types/project";

const snap = vi.hoisted(() => vi.fn());
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  loadWaveformSnap: snap,
}));

const { useSnapTicks } = await import("./useSnapTicks");

const clip: ClipRow = {
  id: "c1",
  track_id: "host",
  source_start: 10,
  source_end: 20,
  timeline_start: 0,
  timeline_end: 10,
  fade_in_ms: 0,
  fade_out_ms: 0,
  join_in_mode: "fade",
  source_id: null,
};

function useTicks(trim: number | null = null, enabled = true) {
  return useSnapTicks({
    clip,
    trackId: "host",
    sourceStart: 10,
    sourceEnd: 20,
    trimFocusSourceSec: trim,
    enabled,
  });
}

describe("useSnapTicks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    snap.mockReset();
    snap.mockResolvedValue({ ticks: [12.5, 12.5, 13] });
    useDawStore.setState({
      projectPath: "/tmp/p.json",
      guestMode: null,
      isPlaying: false,
      playheadSec: 3,
      bladeHoverSec: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function settle() {
    await act(async () => {
      vi.advanceTimersByTime(80);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("loads ticks around the paused playhead, after a debounce", async () => {
    const { result } = renderHook(() => useTicks());
    expect(snap).not.toHaveBeenCalled();
    await settle();
    expect(snap).toHaveBeenCalledWith(
      "/tmp/p.json",
      "host",
      12,
      14,
      false,
      expect.any(AbortSignal),
      13,
    );
    expect(result.current).toEqual([12.5, 13]);
  });

  it("prefers the blade hover, and ignores a playing playhead", async () => {
    useDawStore.setState({ bladeHoverSec: 5, isPlaying: true });
    renderHook(() => useTicks());
    await settle();
    expect(snap.mock.calls[0]![6]).toBe(15);
    snap.mockClear();
    act(() => useDawStore.setState({ bladeHoverSec: null }));
    await settle();
    expect(snap).not.toHaveBeenCalled();
  });

  it("focuses the trim edge while trimming", async () => {
    useDawStore.setState({ playheadSec: 50 });
    renderHook(() => useTicks(18.5));
    await settle();
    expect(snap.mock.calls[0]![6]).toBe(18.5);
  });

  it("does not re-render while the playhead plays or moves outside the clip", () => {
    let renders = 0;
    useDawStore.setState({ isPlaying: true });
    renderHook(() => {
      renders += 1;
      return useTicks();
    });
    const before = renders;
    act(() => {
      for (let i = 0; i < 10; i++) {
        useDawStore.setState({ playheadSec: i });
      }
    });
    act(() => useDawStore.setState({ isPlaying: false, playheadSec: 40 }));
    act(() => useDawStore.setState({ playheadSec: 41 }));
    expect(renders).toBe(before);
  });

  it("is off when disabled or without a project", async () => {
    const { result } = renderHook(() => useTicks(null, false));
    await settle();
    expect(snap).not.toHaveBeenCalled();
    expect(result.current).toEqual([]);
    useDawStore.setState({ projectPath: "" });
    renderHook(() => useTicks());
    await settle();
    expect(snap).not.toHaveBeenCalled();
  });

  it("shows no ticks outside the loaded window or for another project", async () => {
    const { result } = renderHook(() => useTicks());
    await settle();
    expect(result.current).toEqual([12.5, 13]);
    snap.mockReturnValue(new Promise(() => {}));
    // Playhead 8 s is source 18 s: outside the loaded 12..14 window.
    act(() => useDawStore.setState({ playheadSec: 8 }));
    expect(result.current).toEqual([]);
    act(() => useDawStore.setState({ playheadSec: 3 }));
    expect(result.current).toEqual([12.5, 13]);
    act(() => useDawStore.setState({ projectPath: "/tmp/q.json" }));
    expect(result.current).toEqual([]);
  });

  it("fetches a trim drag's ticks on a 0.5 s grid, not after every move", async () => {
    const { result, rerender } = renderHook(
      ({ trim }: { trim: number }) => useTicks(trim),
      { initialProps: { trim: 18.5 } },
    );
    for (const trim of [18.52, 18.55, 18.6, 18.64]) {
      act(() => {
        vi.advanceTimersByTime(30);
      });
      rerender({ trim });
    }
    await settle();
    expect(snap).toHaveBeenCalledTimes(1);
    expect(snap.mock.calls[0]!.slice(2, 5)).toEqual([17.5, 19.5, false]);
    expect(snap.mock.calls[0]![6]).toBe(18.5);
    expect(result.current).toEqual([12.5, 13]);
  });

  it("fetches blade-hover ticks on the same 0.5 s grid", async () => {
    useDawStore.setState({ bladeHoverSec: 5.1 });
    const { result } = renderHook(() => useTicks());
    for (const hover of [5.12, 5.18, 5.2]) {
      act(() => {
        vi.advanceTimersByTime(30);
        useDawStore.setState({ bladeHoverSec: hover });
      });
    }
    await settle();
    expect(snap).toHaveBeenCalledTimes(1);
    expect(snap.mock.calls[0]!.slice(2, 5)).toEqual([14, 16, false]);
    expect(snap.mock.calls[0]![6]).toBe(15);
    expect(result.current).toEqual([12.5, 13]);
  });
});
