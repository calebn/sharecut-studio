import { describe, expect, it } from "vitest";
import { SEGMENT_INSERT_REFUSALS } from "../api/segments";
import { insertPreview, MUSIC_BED, segment } from "../segments/fixtures";
import { ApiError } from "../utils/apiError";
import {
  INSERT_FAILED,
  insertPreviewLines,
  PREVIEW_FAILED,
  segmentInsertedMessage,
  segmentInsertMessage,
  segmentPreviewMessage,
} from "./segmentInsertMessages";

describe("segmentInsertMessages", () => {
  it("has plain copy for every refusal code on insert and preview", () => {
    for (const code of SEGMENT_INSERT_REFUSALS) {
      const error = new ApiError("raw", code, 400);
      expect(segmentInsertMessage(error)).not.toBe(INSERT_FAILED);
      expect(segmentPreviewMessage(error)).not.toBe(PREVIEW_FAILED);
      expect(segmentInsertMessage(error)).not.toContain("raw");
    }
    expect(SEGMENT_INSERT_REFUSALS).toHaveLength(10);
  });

  it("words the two placement refusals", () => {
    expect(
      segmentInsertMessage(
        new ApiError("x", "segment_placement_unsupported", 400),
      ),
    ).toBe(
      "Dialogue segments cannot have their own lane. Choose Move the rest later.",
    );
    expect(
      segmentPreviewMessage(
        new ApiError("x", "segment_placement_invalid", 400),
      ),
    ).toBe("That placement is not available. Pick a placement again.");
  });

  it("keeps the ripple lines the same by default", () => {
    expect(insertPreviewLines(insertPreview({ at: 5 }))).toEqual([
      "Adds 0:22 at 0:05.",
      "Moves 4 clips later by 0:22.",
      "The episode becomes 10:22 long.",
    ]);
  });

  it("words own lane from the requested placement and the library row", () => {
    const preview = insertPreview({
      at: 5,
      clips_moved: 0,
      tracks_added: ["t"],
    });
    expect(insertPreviewLines(preview, "own_lane", MUSIC_BED)).toEqual([
      "Adds 0:22 at 0:05 on a new track.",
      "Nothing already in the episode moves.",
      "It plays at full level over the voices until it is ducked. Duck music under dialogue lowers it under speech.",
      "The episode becomes 10:22 long.",
    ]);
    const plain = segment({ role: "music", duck_under_dialogue: false });
    expect(insertPreviewLines(preview, "own_lane", plain)[2]).toBe(
      "It plays at full level. It was not saved to duck under dialogue.",
    );
    expect(insertPreviewLines(preview, "own_lane", null)[2]).toBe(
      "It plays at full level. It was not saved to duck under dialogue.",
    );
  });

  it("names the placement in the inserted toast", () => {
    const applied = {
      operation: "insert_segment" as const,
      affected_tracks: [],
      clip_count: 1,
      timeline_duration_sec: 10,
      segment_id: "a",
      segment_version: 1,
      at: 0,
      duration_sec: 22,
      tracks: {},
    };
    expect(segmentInsertedMessage("Bed", applied)).toBe(
      "Inserted Bed: 0:22 at 0:00",
    );
    expect(
      segmentInsertedMessage("Bed", { ...applied, placement: "own_lane" }),
    ).toBe("Inserted Bed over the episode: 0:22 at 0:00");
  });
});
