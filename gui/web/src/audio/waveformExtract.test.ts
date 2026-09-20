import { describe, expect, it } from "vitest";
import { OVERVIEW_BINS_PER_SEC } from "../utils/timelineZoom.generated";
import { extractPeaksFromPcm, pcmToUint8Peaks } from "./waveformExtract";
import {
  coalesceIndices,
  PeakTileLru,
  snapBinsPerSec,
  tileKey,
  tileRange,
} from "./waveformTiles";
import { handleWorkerMessage } from "./waveformWorker";
import {
  byteRangeForTime,
  encodePcmWav,
  parseWavHeader,
  wavPcmToFloat32,
} from "./wavHeader";

describe("pcmToUint8Peaks", () => {
  it("uses abs-max and scales to 0–255", () => {
    const pcm = new Float32Array([0, 0.5, -1, 0.25]);
    const peaks = pcmToUint8Peaks(pcm, 4, 2);
    expect(peaks.length).toBe(2);
    expect(peaks[0]).toBeGreaterThan(100);
    expect(peaks[1]).toBe(255);
  });

  it("abort path in worker handler skips work", () => {
    const aborted = new Set<string>(["a"]);
    const out = handleWorkerMessage(
      {
        type: "extract",
        id: "a",
        pcm: new Float32Array([1, 1]),
        sampleRate: 2,
        binsPerSec: 1,
        startSec: 0,
      },
      aborted,
    );
    expect(out).toBeNull();
  });

  it("extractPeaksFromPcm reports duration", () => {
    const r = extractPeaksFromPcm(new Float32Array(8000), 8000, 16, 1);
    expect(r.startSec).toBe(1);
    expect(r.endSec).toBe(2);
    expect(r.peaks.length).toBeGreaterThan(0);
  });
});

describe("wav header + range", () => {
  it("parses PCM16 and maps time to bytes", () => {
    const samples = new Int16Array(8000);
    samples[0] = 32767;
    const buf = encodePcmWav(samples, 8000, 1).buffer;
    const header = parseWavHeader(buf);
    expect(header.sampleRate).toBe(8000);
    expect(header.dataOffset).toBe(44);
    const range = byteRangeForTime(header, 0, 0.5);
    expect(range.start).toBe(44);
    const pcm = wavPcmToFloat32(buf.slice(header.dataOffset), header);
    expect(pcm[0]).toBeCloseTo(1, 2);
  });
});

describe("tiles", () => {
  it("snaps bins to overview or zoom steps, never a magic 400", () => {
    expect(snapBinsPerSec(8)).toBe(OVERVIEW_BINS_PER_SEC);
    expect(snapBinsPerSec(40)).toBeGreaterThan(OVERVIEW_BINS_PER_SEC);
    expect(tileRange(0, 5, 2)).toEqual([0, 1, 2]);
    expect(coalesceIndices([1, 2, 4, 5, 6])).toEqual([
      [1, 2],
      [4, 6],
    ]);
    expect(tileKey("/p.json", "h", "raw", "v1", 3, 40)).toBe(
      "/p.json|h|raw|v1|3|40",
    );
  });

  it("LRU evicts oldest", () => {
    const lru = new PeakTileLru(2);
    const tile = (key: string) => ({
      key,
      projectPath: "/p.json",
      trackId: "t",
      kind: "raw",
      mediaVersion: "1",
      tileIndex: 0,
      binsPerSec: 16,
      startSec: 0,
      endSec: 2,
      peaks: new Uint8Array([1]),
    });
    lru.set(tile("a"));
    lru.set(tile("b"));
    lru.set(tile("c"));
    expect(lru.has("a")).toBe(false);
    expect(lru.has("c")).toBe(true);
    expect(lru.size).toBe(2);
  });
});
