import { describe, expect, it } from "vitest";
import {
  mergeSegmentSaves,
  ownSaveLines,
  SAVE_STATE_COPY,
  type SaveLine,
  type SegmentAckRow,
  type SegmentSave,
  saveAnnouncement,
  segmentSaveFromAck,
  segmentStatusText,
} from "./saveStatus";

function row(overrides: Partial<SegmentAckRow> = {}): SegmentAckRow {
  return {
    participant_id: "p_a",
    take_index: 0,
    segment_index: 0,
    acked_parts: [],
    ...overrides,
  };
}

describe("segmentSaveFromAck", () => {
  it("is saving until the file is acknowledged", () => {
    expect(segmentSaveFromAck(row({ acked_parts: [0] })).state).toBe("saving");
    expect(segmentSaveFromAck(row({ file_ack: true })).state).toBe("saved");
  });

  it("carries chunk progress only while saving and the total is declared", () => {
    expect(
      segmentSaveFromAck(row({ acked_parts: [0, 1], expected_parts: 5 }))
        .chunks,
    ).toEqual({ acked: 2, total: 5 });
    expect(segmentSaveFromAck(row({ acked_parts: [0] })).chunks).toBeNull();
    expect(
      segmentSaveFromAck(row({ file_ack: true, expected_parts: 5 })).chunks,
    ).toBeNull();
  });
});

describe("segmentStatusText", () => {
  const saving: SegmentSave = {
    take: 0,
    segment: 0,
    state: "saving",
    chunks: null,
    landFailed: false,
  };

  it("reads the two states from one copy table", () => {
    expect(segmentStatusText(saving)).toBe("Saving to project…");
    expect(segmentStatusText({ ...saving, state: "saved" })).toBe(
      "Saved to project",
    );
    expect(SAVE_STATE_COPY).toEqual({
      saving: "Saving to project…",
      saved: "Saved to project",
    });
  });

  it("pluralizes chunk progress", () => {
    expect(
      segmentStatusText({ ...saving, chunks: { acked: 0, total: 1 } }),
    ).toBe("Saving to project… 0 of 1 chunk");
    expect(
      segmentStatusText({ ...saving, chunks: { acked: 1, total: 3 } }),
    ).toBe("Saving to project… 1 of 3 chunks");
  });

  it("keeps a failed landing visible without calling the file unsaved", () => {
    expect(
      segmentStatusText({ ...saving, state: "saved", landFailed: true }),
    ).toBe("Saved to project. Landing failed. Use Retry land.");
  });
});

describe("ownSaveLines", () => {
  it("labels each of the person's own segments", () => {
    expect(
      ownSaveLines([
        {
          take: 0,
          segment: 0,
          state: "saved",
          chunks: null,
          landFailed: false,
        },
        {
          take: 0,
          segment: 1,
          state: "saving",
          chunks: { acked: 1, total: 2 },
          landFailed: false,
        },
      ]).map((line) => line.text),
    ).toEqual([
      "Take 1 segment 1: Saved to project",
      "Take 1 segment 2: Saving to project… 1 of 2 chunks",
    ]);
  });
});

describe("mergeSegmentSaves", () => {
  const save = (segment: number, state: SegmentSave["state"]): SegmentSave => ({
    take: 0,
    segment,
    state,
    chunks: null,
    landFailed: false,
  });

  it("replaces a segment by identity and keeps ones the pass has not reached", () => {
    expect(
      mergeSegmentSaves(
        [save(0, "saving"), save(2, "saved")],
        [save(0, "saved"), save(1, "saving")],
      ),
    ).toEqual([save(0, "saved"), save(1, "saving"), save(2, "saved")]);
  });
});

describe("saveAnnouncement", () => {
  const line = (key: string, state: SaveLine["state"]): SaveLine => ({
    key,
    state,
    text: `${key}: ${state} 1 of 3 chunks`,
    announce: `${key}: ${SAVE_STATE_COPY[state]}`,
  });

  it("announces a segment that starts saving and one that finishes", () => {
    expect(saveAnnouncement(new Map(), [line("a", "saving")])).toBe(
      "a: Saving to project…",
    );
    expect(
      saveAnnouncement(new Map([["a", "saving"]]), [
        line("a", "saved"),
        line("b", "saving"),
      ]),
    ).toBe("a: Saved to project. b: Saving to project…");
  });

  it("stays silent for chunk progress and for state it never saw change", () => {
    expect(
      saveAnnouncement(new Map([["a", "saving"]]), [line("a", "saving")]),
    ).toBe("");
    expect(saveAnnouncement(new Map(), [line("a", "saved")])).toBe("");
    expect(
      saveAnnouncement(new Map([["a", "saved"]]), [line("a", "saved")]),
    ).toBe("");
  });
});
