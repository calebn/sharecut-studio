import { describe, expect, it } from "vitest";
import { minimalProject, pendingEditView } from "../test/fixtures";
import { HISTORY_ROOT_ID, type HistoryGroup } from "../types/project";
import { revisableSuggestedBatch } from "./suggestedBatch";

const sounds = [
  {
    id: "um",
    label: "Filler word",
    track_id: "host",
    timeline_start: 1,
    action: "cut",
  },
  {
    id: "laugh",
    label: "Laugh",
    track_id: "guest",
    timeline_start: null,
    action: "lower",
  },
];

function batchGroup(
  after: number,
  rows: unknown = sounds,
  operation = "apply_suggested_actions",
): HistoryGroup {
  return {
    kind: "mutation",
    before_index: after - 1,
    after_index: after,
    operation,
    params: { sounds: rows },
  };
}

function projectWith(
  groups: HistoryGroup[],
  cursor: number,
  pending: string[] = [],
) {
  return minimalProject({
    history: {
      cursor,
      head_id: HISTORY_ROOT_ID,
      can_undo: true,
      can_redo: false,
      groups,
    },
    pending_edits: pending.map((id) => pendingEditView({ id })),
  });
}

describe("revisableSuggestedBatch", () => {
  it("lists the sounds of a batch that is the latest edit", () => {
    expect(revisableSuggestedBatch(projectWith([batchGroup(1)], 1))).toEqual([
      {
        id: "um",
        label: "Filler word",
        trackId: "host",
        timelineStart: 1,
        action: "cut",
      },
      {
        id: "laugh",
        label: "Laugh",
        trackId: "guest",
        timelineStart: null,
        action: "lower",
      },
    ]);
  });

  it("looks past a preview render that followed the batch", () => {
    const groups: HistoryGroup[] = [
      batchGroup(1),
      { kind: "snapshot", index: 2, operation: "render_preview" },
    ];
    expect(revisableSuggestedBatch(projectWith(groups, 2))).toHaveLength(2);
  });

  it("is empty once another edit follows the batch", () => {
    const groups: HistoryGroup[] = [
      batchGroup(1),
      batchGroup(3, [], "approve_edits"),
    ];
    expect(revisableSuggestedBatch(projectWith(groups, 3))).toEqual([]);
  });

  it("is empty when the batch was undone", () => {
    expect(revisableSuggestedBatch(projectWith([batchGroup(1)], 0))).toEqual(
      [],
    );
  });

  it("leaves out a sound that stayed pending", () => {
    const batch = revisableSuggestedBatch(
      projectWith([batchGroup(1)], 1, ["laugh"]),
    );
    expect(batch.map((sound) => sound.id)).toEqual(["um"]);
  });

  it("ignores rows the server did not shape", () => {
    const rows = [
      null,
      { id: "x" },
      { ...sounds[0], action: "mute" },
      sounds[0],
    ];
    expect(
      revisableSuggestedBatch(projectWith([batchGroup(1, rows)], 1)).map(
        (sound) => sound.id,
      ),
    ).toEqual(["um"]);
    expect(
      revisableSuggestedBatch(projectWith([batchGroup(1, "nope")], 1)),
    ).toEqual([]);
  });

  it("is empty without history", () => {
    expect(revisableSuggestedBatch(projectWith([], 0))).toEqual([]);
  });
});
