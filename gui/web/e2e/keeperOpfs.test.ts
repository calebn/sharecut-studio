import { describe, expect, it, vi } from "vitest";
import { KEEPER_OPFS_ROOT } from "../src/record/keeper/opfsPath";
import {
  keeperWavBytes,
  ONE_SECOND_KEEPER_PCM_BYTES,
  ONE_SECOND_KEEPER_WAV_BYTES,
  recordingWavs,
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
