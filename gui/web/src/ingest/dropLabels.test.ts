import { afterEach, describe, expect, it } from "vitest";
import {
  fileCountFromDataTransfer,
  isAudioIngestFile,
  laneDropLabel,
  newTracksDropLabel,
  trackHasMedia,
} from "./dropLabels";

describe("dropLabels", () => {
  afterEach(() => {
    window.localStorage.clear();
  });
  it("labels replace vs add for a single file", () => {
    expect(
      laneDropLabel({ trackLabel: "guest", replacing: true, fileCount: 1 }),
    ).toBe("Replace guest");
    expect(
      laneDropLabel({ trackLabel: "guest", replacing: false, fileCount: 1 }),
    ).toBe("Add to guest");
  });

  it("mentions spill to new tracks for multi-file lane drops", () => {
    expect(
      laneDropLabel({ trackLabel: "guest", replacing: true, fileCount: 3 }),
    ).toBe("1 replaces guest · 2 new tracks");
  });

  it("labels new-track drop targets", () => {
    expect(newTracksDropLabel(1)).toBe("Create new track");
    expect(newTracksDropLabel(2)).toBe("Create 2 new tracks");
  });

  it("counts file items from a DataTransfer", () => {
    expect(fileCountFromDataTransfer(null)).toBe(0);
    expect(fileCountFromDataTransfer({ items: [] as never })).toBe(0);
    const items = [
      { kind: "file" },
      { kind: "string" },
      { kind: "file" },
    ] as unknown as DataTransferItemList;
    expect(fileCountFromDataTransfer({ items })).toBe(2);
  });

  it("detects media from path or clips", () => {
    expect(trackHasMedia({ mediaPath: null, clipCount: 0 })).toBe(false);
    expect(trackHasMedia({ mediaPath: "raw/a.wav", clipCount: 0 })).toBe(true);
    expect(trackHasMedia({ mediaPath: null, clipCount: 1 })).toBe(true);
  });

  it("accepts audio MIME or allowlisted extensions", () => {
    expect(isAudioIngestFile({ name: "x.bin", type: "audio/wav" })).toBe(true);
    expect(isAudioIngestFile({ name: "take.wav", type: "" })).toBe(true);
    expect(
      isAudioIngestFile({
        name: "take.aiff",
        type: "application/octet-stream",
      }),
    ).toBe(true);
    expect(isAudioIngestFile({ name: "notes.txt", type: "" })).toBe(false);
  });
});
