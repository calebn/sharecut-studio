import { describe, expect, it } from "vitest";
import { keeperPcmParts, RECORD_UPLOAD_PART_PCM_BYTES } from "./chunker";

describe("keeperPcmParts", () => {
  it("waits for a full 30s window until the segment is frozen", () => {
    const wav = new Uint8Array(44 + 100);
    expect(keeperPcmParts(wav, false)).toEqual([]);
    const parts = keeperPcmParts(wav, true);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.byteLength).toBe(100);
  });

  it("splits complete PCM on the 30s boundary", () => {
    const wav = new Uint8Array(44 + RECORD_UPLOAD_PART_PCM_BYTES + 10);
    const growing = keeperPcmParts(wav, false);
    expect(growing).toHaveLength(1);
    expect(growing[0]?.byteLength).toBe(RECORD_UPLOAD_PART_PCM_BYTES);
    const frozen = keeperPcmParts(wav, true);
    expect(frozen).toHaveLength(2);
    expect(frozen[1]?.byteLength).toBe(10);
  });
});
