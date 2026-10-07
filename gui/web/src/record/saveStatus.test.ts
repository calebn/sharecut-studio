import { describe, expect, it } from "vitest";
import { recordParticipant } from "../test/fixtures";
import {
  hostSaveLines,
  ownSaveLines,
  SAVE_STATE_COPY,
  type SegmentAckRow,
  type SegmentSave,
  segmentSaveFromAck,
  segmentStatusText,
} from "./saveStatus";

const ava = recordParticipant({ participant_id: "p_a", display_name: "Ava" });
const host = recordParticipant({
  participant_id: "p_host",
  role: "host",
  display_name: "Host",
});
const pat = recordParticipant({
  participant_id: "p_pat",
  role: "producer",
  display_name: "Pat",
});

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

describe("hostSaveLines", () => {
  it("lists a recorded participant with nothing uploaded as saving, never a producer", () => {
    expect(hostSaveLines([host, ava, pat], [])).toEqual([
      { key: "p_host", text: "Host: Saving to project…" },
      { key: "p_a", text: "Ava: Saving to project…" },
    ]);
  });

  it("names the take and segment only when a participant has several", () => {
    const lines = hostSaveLines(
      [ava, host],
      [
        row({ participant_id: "p_a", take_index: 1, segment_index: 0 }),
        row({
          participant_id: "p_a",
          take_index: 0,
          segment_index: 1,
          file_ack: true,
        }),
        row({
          participant_id: "p_a",
          take_index: 0,
          segment_index: 0,
          file_ack: true,
        }),
        row({ participant_id: "p_host", file_ack: true }),
      ],
    );
    expect(lines.map((line) => line.text)).toEqual([
      "Ava, take 1 segment 1: Saved to project",
      "Ava, take 1 segment 2: Saved to project",
      "Ava, take 2 segment 1: Saving to project…",
      "Host: Saved to project",
    ]);
  });

  it("falls back to the participant id for a row outside the roster", () => {
    expect(hostSaveLines([], [row({ participant_id: "p_gone" })])).toEqual([
      { key: "p_gone:0:0", text: "p_gone: Saving to project…" },
    ]);
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
