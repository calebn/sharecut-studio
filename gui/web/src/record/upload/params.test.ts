import { describe, expect, it } from "vitest";
import { recordUploadSearchParams } from "./params";

describe("recordUploadSearchParams", () => {
  it("includes join_offset_ms when the caller passes joinOffsetMs", () => {
    const q = recordUploadSearchParams({
      takeIndex: 0,
      segmentIndex: 1,
      partSeq: 0,
      digest: "abc",
      joinOffsetMs: 340000,
      final: true,
      fileSha256: "def",
    });
    expect(q.get("join_offset_ms")).toBe("340000");
    expect(q.get("final")).toBe("true");
    expect(q.get("file_sha256")).toBe("def");
  });

  it("includes kind when the caller passes kind", () => {
    const q = recordUploadSearchParams({
      takeIndex: 0,
      segmentIndex: 0,
      partSeq: 0,
      digest: "abc",
      kind: "room_tone",
      final: true,
      fileSha256: "def",
    });
    expect(q.get("kind")).toBe("room_tone");
  });

  it("sends clipping as a-b,c-d only when there are regions", () => {
    const base = {
      takeIndex: 0,
      segmentIndex: 0,
      partSeq: 0,
      digest: "abc",
      final: true,
    };
    expect(
      recordUploadSearchParams({
        ...base,
        clippingRegions: [
          { startMs: 100, endMs: 250 },
          { startMs: 1500, endMs: 1600 },
        ],
      }).get("clipping"),
    ).toBe("100-250,1500-1600");
    expect(
      recordUploadSearchParams({ ...base, clippingRegions: [] }).has(
        "clipping",
      ),
    ).toBe(false);
    expect(recordUploadSearchParams(base).has("clipping")).toBe(false);
  });
});
