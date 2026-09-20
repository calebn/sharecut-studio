import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortStaleWaveformWork,
  getWaveformTileLru,
  inflightWaveformCount,
  PRIORITY_VISIBLE,
  queuedWaveformCount,
  requestWaveformTiles,
  resetWaveformSchedulerForTests,
} from "./waveformScheduler";
import { fetchDetailPeaks } from "./waveformSource";
import { tileKey } from "./waveformTiles";

vi.mock("./waveformSource", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./waveformSource")>();
  return {
    ...actual,
    fetchDetailPeaks: vi.fn(),
  };
});

afterEach(() => {
  resetWaveformSchedulerForTests();
  vi.unstubAllGlobals();
  vi.mocked(fetchDetailPeaks).mockReset();
});

const base = {
  projectPath: "/tmp/p.json",
  kind: "raw" as const,
  mediaPath: "raw/a.wav",
  mediaVersion: "1",
  binsPerSec: 40,
  priority: PRIORITY_VISIBLE,
};

describe("waveform scheduler", () => {
  it("caps in-flight extracts and aborts stale work", async () => {
    vi.mocked(fetchDetailPeaks).mockImplementation(
      () => new Promise(() => undefined),
    );
    requestWaveformTiles({ ...base, trackId: "a", startSec: 0, endSec: 4 });
    requestWaveformTiles({ ...base, trackId: "b", startSec: 0, endSec: 4 });
    requestWaveformTiles({ ...base, trackId: "c", startSec: 0, endSec: 4 });
    await Promise.resolve();
    expect(inflightWaveformCount()).toBeLessThanOrEqual(2);
    abortStaleWaveformWork();
    expect(queuedWaveformCount()).toBe(0);
    expect(inflightWaveformCount()).toBe(0);
  });

  it("aborts in-flight work when bins_per_sec changes", async () => {
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");
    vi.mocked(fetchDetailPeaks).mockImplementation(
      () => new Promise(() => undefined),
    );
    requestWaveformTiles({ ...base, trackId: "a", startSec: 0, endSec: 4 });
    abortSpy.mockClear();
    requestWaveformTiles({
      ...base,
      trackId: "a",
      startSec: 0,
      endSec: 4,
      binsPerSec: 80,
    });
    expect(abortSpy).toHaveBeenCalled();
    abortSpy.mockRestore();
  });

  it("chunks coalesced ranges to the fetch cap and skips empty slices", async () => {
    const spans: number[] = [];
    vi.mocked(fetchDetailPeaks).mockImplementation(async (req) => {
      const span = req.endSec - req.startSec;
      spans.push(span);
      return new Uint8Array(
        Math.max(1, Math.round(req.binsPerSec * span)),
      ).fill(9);
    });
    requestWaveformTiles({
      ...base,
      trackId: "a",
      startSec: 0,
      endSec: 20,
    });
    await vi.waitFor(() => {
      expect(
        getWaveformTileLru().has(
          tileKey("/tmp/p.json", "a", "raw", "1", 9, 40),
        ),
      ).toBe(true);
    });
    expect(Math.max(...spans)).toBeLessThanOrEqual(8.01);
    for (let i = 0; i < 10; i++) {
      const tile = getWaveformTileLru().get(
        tileKey("/tmp/p.json", "a", "raw", "1", i, 40),
      );
      expect(tile?.peaks.length).toBeGreaterThan(0);
    }
  });

  it("drops queued visible jobs outside the latest window", async () => {
    vi.mocked(fetchDetailPeaks).mockImplementation(
      () => new Promise(() => undefined),
    );
    requestWaveformTiles({ ...base, trackId: "a", startSec: 0, endSec: 4 });
    requestWaveformTiles({
      ...base,
      trackId: "a",
      startSec: 40,
      endSec: 44,
    });
    await Promise.resolve();
    expect(queuedWaveformCount()).toBeGreaterThan(0);
    expect(queuedWaveformCount()).toBeLessThan(6);
  });
});
