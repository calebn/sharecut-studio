import { describe, expect, it, vi } from "vitest";
import { KEEPER_OPFS_ROOT } from "../src/record/keeper/opfsPath";
import {
  keeperSegmentIndexes,
  keeperSegmentWavBytes,
  keeperWavBytes,
  ONE_SECOND_KEEPER_PCM_BYTES,
  ONE_SECOND_KEEPER_WAV_BYTES,
  recordingWavs,
  segmentIndexesFromNames,
} from "./keeperOpfs";

describe("keeper WAV size constants", () => {
  it("match one second of 48 kHz mono s16 PCM plus a WAV header", () => {
    expect(ONE_SECOND_KEEPER_PCM_BYTES).toBe(96000);
    expect(ONE_SECOND_KEEPER_WAV_BYTES).toBe(96044);
  });
});

describe("recordingWavs", () => {
  it("passes the keeper OPFS root name into the page evaluation", async () => {
    const evaluate = vi.fn(async () => []);
    await recordingWavs({ evaluate } as never);
    expect(evaluate).toHaveBeenCalledWith(
      expect.any(Function),
      KEEPER_OPFS_ROOT,
    );
  });
});

describe("keeperWavBytes", () => {
  it("returns the maximum size across recorded WAVs", async () => {
    const evaluate = vi.fn(async () => [
      { path: "/a.wav", size: 10, header: [] },
      { path: "/b.wav", size: 30, header: [] },
      { path: "/c.wav", size: 20, header: [] },
    ]);
    await expect(keeperWavBytes({ evaluate } as never)).resolves.toBe(30);
  });

  it("returns 0 when the recordings directory does not exist", async () => {
    const evaluate = vi.fn(async () => null);
    await expect(keeperWavBytes({ evaluate } as never)).resolves.toBe(0);
  });

  it("returns 0 when there are no recorded WAVs", async () => {
    const evaluate = vi.fn(async () => []);
    await expect(keeperWavBytes({ evaluate } as never)).resolves.toBe(0);
  });
});

describe("segmentIndexesFromNames", () => {
  it("extracts unique, sorted indexes from wav and json names", () => {
    expect(
      segmentIndexesFromNames([
        "1.wav",
        "0.json",
        "0.wav",
        "2.wav",
        "notes.txt",
      ]),
    ).toEqual([0, 1, 2]);
  });

  it("returns [] for no matching names", () => {
    expect(segmentIndexesFromNames([])).toEqual([]);
    expect(segmentIndexesFromNames(["readme.md"])).toEqual([]);
  });
});

describe("keeperSegmentIndexes", () => {
  const keeper = { sessionId: "s1", takeIndex: 0, participantId: "p_host" };

  it("passes the keeper ref into the page evaluation and dedupes names", async () => {
    const evaluate = vi.fn(async () => ["0.wav", "0.json", "1.wav"]);
    await expect(
      keeperSegmentIndexes({ evaluate } as never, keeper),
    ).resolves.toEqual([0, 1]);
    expect(evaluate).toHaveBeenCalledWith(expect.any(Function), {
      rootName: KEEPER_OPFS_ROOT,
      sessionId: "s1",
      takeIndex: "0",
      participantId: "p_host",
    });
  });

  it("returns [] when the directory is missing", async () => {
    const evaluate = vi.fn(async () => []);
    await expect(
      keeperSegmentIndexes({ evaluate } as never, keeper),
    ).resolves.toEqual([]);
  });
});

describe("keeperSegmentWavBytes", () => {
  const keeper = { sessionId: "s1", takeIndex: 0, participantId: "p_host" };

  it("matches the exact segment path", async () => {
    const evaluate = vi.fn(async () => [
      { path: "/s1/0/p_host/0.wav", size: 44, header: [] },
      { path: "/s1/0/p_host/1.wav", size: 96044, header: [] },
    ]);
    await expect(
      keeperSegmentWavBytes({ evaluate } as never, keeper, 1),
    ).resolves.toBe(96044);
  });

  it("returns 0 when the segment is missing", async () => {
    const evaluate = vi.fn(async () => []);
    await expect(
      keeperSegmentWavBytes({ evaluate } as never, keeper, 0),
    ).resolves.toBe(0);
  });
});
