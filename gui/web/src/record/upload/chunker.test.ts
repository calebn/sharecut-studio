import { describe, expect, it } from "vitest";
import { keeperPcmParts, RECORD_UPLOAD_PART_PCM_BYTES } from "./chunker";

describe("keeperPcmParts", () => {
  it("returns no parts for a header-only WAV", () => {
    expect(keeperPcmParts(new Uint8Array(44))).toEqual([]);
  });

  it("keeps a short finalized segment as one part", () => {
    const wav = new Uint8Array(44 + 100);
    const parts = keeperPcmParts(wav);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.byteLength).toBe(100);
  });

  it("splits complete PCM on the 30s boundary", () => {
    const wav = new Uint8Array(44 + RECORD_UPLOAD_PART_PCM_BYTES + 10);
    const frozen = keeperPcmParts(wav);
    expect(frozen).toHaveLength(2);
    expect(frozen[0]?.byteLength).toBe(RECORD_UPLOAD_PART_PCM_BYTES);
    expect(frozen[1]?.byteLength).toBe(10);
  });
});
