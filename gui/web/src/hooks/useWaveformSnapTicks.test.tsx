import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadWaveformSnap } from "../api";
import { useWaveformSnapTicks } from "./useWaveformSnapTicks";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  loadWaveformSnap: vi.fn(),
}));

describe("useWaveformSnapTicks", () => {
  beforeEach(() => {
    vi.mocked(loadWaveformSnap).mockReset();
  });

  it("resolves one bounded source window and returns sorted unique ticks", async () => {
    vi.mocked(loadWaveformSnap).mockResolvedValue({
      track_id: "host",
      start: 3.5,
      end: 5.5,
      timeline_mode: false,
      preview: null,
      islands: [],
      ticks: [3.4, 2.4, 3.4],
    });
    const { result, unmount } = renderHook(() =>
      useWaveformSnapTicks("/tmp/p.json", "host", 2.25, true),
    );
    const signal = new AbortController().signal;
    let resolved: number[] = [];
    await act(async () => {
      resolved = await result.current.resolveTicks(2.25, signal);
    });
    expect(loadWaveformSnap).toHaveBeenCalledWith(
      "/tmp/p.json",
      "host",
      1.5,
      3.5,
      false,
      signal,
      2.5,
    );
    expect(resolved).toEqual([2.4, 3.4]);
    expect(result.current.ticks).toEqual([2.4, 3.4]);
    unmount();
  });

  it("rejects failed requests while accepting a valid empty tick response", async () => {
    const { result } = renderHook(() =>
      useWaveformSnapTicks("/tmp/p.json", "host", null, false),
    );
    const controller = new AbortController();
    vi.mocked(loadWaveformSnap).mockResolvedValue(null);
    await expect(
      result.current.resolveTicks(1, controller.signal),
    ).rejects.toThrow("Nearby waveform snap points could not be loaded");
    vi.mocked(loadWaveformSnap).mockResolvedValue({
      track_id: "host",
      start: 0,
      end: 2,
      timeline_mode: false,
      preview: null,
      islands: [],
      ticks: [],
    });
    await expect(
      result.current.resolveTicks(1, controller.signal),
    ).resolves.toEqual([]);
  });
});
