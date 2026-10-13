import { describe, expect, it } from "vitest";
import { hostSaveLines, type SegmentAckRow } from "../src/record/saveStatus";
import { recordParticipant } from "../src/test/fixtures";
import { participantSaveStatus } from "./saveRoster";

const ava = recordParticipant({ participant_id: "p_a", display_name: "Ava" });
const avatar = recordParticipant({
  participant_id: "p_b",
  display_name: "Avatar",
});

function segment(
  segmentIndex: number,
  fileAck: boolean,
  participantId = "p_a",
): SegmentAckRow {
  return {
    participant_id: participantId,
    take_index: 0,
    segment_index: segmentIndex,
    acked_parts: [],
    file_ack: fileAck,
  };
}

function roster(segments: SegmentAckRow[]): string[] {
  return hostSaveLines([ava, avatar], segments).map((line) => line.text);
}

describe("participantSaveStatus", () => {
  it("reads one saved segment as saved", () => {
    expect(participantSaveStatus(roster([segment(0, true)]), "Ava")).toBe(
      "saved",
    );
  });

  it("reads a resumed take's two saved segments as saved (#1408)", () => {
    const lines = roster([segment(0, true), segment(1, true)]);
    expect(lines).not.toContain("Ava: Saved to project");
    expect(participantSaveStatus(lines, "Ava")).toBe("saved");
  });

  it("waits while any of the participant's segments is still saving", () => {
    expect(
      participantSaveStatus(
        roster([segment(0, true), segment(1, false)]),
        "Ava",
      ),
    ).toBe(
      JSON.stringify([
        "Ava, take 1 segment 1: Saved to project",
        "Ava, take 1 segment 2: Saving to project…",
      ]),
    );
  });

  it("ignores a participant whose name only starts with the same letters", () => {
    expect(
      participantSaveStatus(roster([segment(0, false, "p_b")]), "Ava"),
    ).toBe(JSON.stringify(["Ava: Saving to project…"]));
  });

  it("waits while the roster is not listed yet", () => {
    expect(participantSaveStatus([], "Ava")).toBe("[]");
  });
});
