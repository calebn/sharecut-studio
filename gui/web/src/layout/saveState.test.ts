import { describe, expect, it } from "vitest";
import {
  type SaveState,
  type SaveStateInput,
  saveStateOf,
  saveStateText,
} from "./saveState";

const quiet: SaveStateInput = {
  busy: false,
  pending: 0,
  conflicts: [],
  unreadable: false,
  loaded: true,
  settling: false,
};

describe("saveStateOf", () => {
  it("is saved when nothing is sending, queued or waiting for attention", () => {
    expect(saveStateOf(quiet)).toEqual({ kind: "saved" });
  });

  it("says nothing before the queue has been read", () => {
    expect(saveStateOf({ ...quiet, loaded: false })).toBeNull();
  });

  it("is saving while a send is in flight, even with edits already queued", () => {
    expect(saveStateOf({ ...quiet, busy: true, pending: 2 })).toEqual({
      kind: "saving",
    });
  });

  it("stays saving while a finished send's queue has not been read back", () => {
    expect(saveStateOf({ ...quiet, settling: true })).toEqual({
      kind: "saving",
    });
  });

  it("counts the edits waiting to send", () => {
    expect(saveStateOf({ ...quiet, pending: 3 })).toEqual({
      kind: "waiting",
      count: 3,
    });
  });

  it.each(["UndoHistory", "RedoHistory"])(
    "is not a failed save when only a refused %s is listed",
    (type) => {
      const refusedMove: SaveStateInput["conflicts"][number] = {
        command: {
          command_id: "move",
          client_id: "client",
          client_seq: 1,
          type,
          payload: {},
          created_at: 0,
        },
        kind: "refused",
        reason: "Nothing to undo",
        recovery: "edit-and-resubmit",
      };
      expect(saveStateOf({ ...quiet, conflicts: [refusedMove] })).toEqual({
        kind: "saved",
      });
      expect(
        saveStateOf({
          ...quiet,
          conflicts: [{ ...refusedMove, dismissed: true }],
        }),
      ).toEqual({ kind: "saved" });
    },
  );

  it("still fails on an earlier refused edit when a later Undo was refused", () => {
    const command = (id: string, type: string) => ({
      command_id: id,
      client_id: "client",
      client_seq: 1,
      type,
      payload: {},
      created_at: 0,
    });
    expect(
      saveStateOf({
        ...quiet,
        conflicts: [
          {
            command: command("edit", "MoveClips"),
            kind: "refused",
            reason: "The clip moved.",
            recovery: "edit-and-resubmit",
          },
          {
            command: command("undo", "UndoHistory"),
            kind: "refused",
            reason: "Nothing to undo",
            recovery: "edit-and-resubmit",
          },
        ],
      }),
    ).toEqual({ kind: "failed", cause: "refused", reason: "The clip moved." });
  });

  it("names the newest refusal as the reason a save failed", () => {
    expect(
      saveStateOf({
        ...quiet,
        pending: 1,
        conflicts: [
          {
            command: {
              command_id: "old",
              client_id: "client",
              client_seq: 1,
              type: "SetTrackMeta",
              payload: {},
              created_at: 0,
            },
            kind: "refused",
            reason: "The clip moved",
            recovery: "edit-and-resubmit",
          },
        ],
      }),
    ).toEqual({ kind: "failed", cause: "refused", reason: "The clip moved" });
  });

  it("keeps a dismissed refusal as terminal save truth", () => {
    expect(
      saveStateOf({
        ...quiet,
        conflicts: [
          {
            command: {
              command_id: "dismissed",
              client_id: "client",
              client_seq: 1,
              type: "SetTrackMeta",
              payload: {},
              created_at: 0,
            },
            kind: "refused",
            reason: "The server refused this edit.",
            recovery: "edit-and-resubmit",
            dismissed: true,
          },
        ],
      }),
    ).toEqual({
      kind: "failed",
      cause: "refused",
      reason: "The server refused this edit.",
    });
  });

  it("keeps unknown delivery distinct from a known refusal", () => {
    expect(
      saveStateOf({
        ...quiet,
        pending: 1,
        conflicts: [
          {
            command: {
              command_id: "unknown",
              client_id: "client",
              client_seq: 1,
              type: "UndoHistory",
              payload: {},
              created_at: 0,
            },
            kind: "unknown",
            reason: "Undo may have been applied",
            recovery: "inspect-history",
          },
        ],
      }),
    ).toEqual({
      kind: "unknown",
      reason: "Undo may have been applied",
      recovery: "inspect-history",
    });
  });

  it("fails when the saved edits cannot be read, even before a first read", () => {
    expect(saveStateOf({ ...quiet, loaded: false, unreadable: true })).toEqual({
      kind: "failed",
      cause: "unreadable",
    });
  });
});

describe("saveStateText", () => {
  const cases: [SaveState, string][] = [
    [{ kind: "saving" }, "Saving to project…"],
    [{ kind: "saved" }, "Saved to project"],
    [{ kind: "waiting", count: 1 }, "Not saved yet · 1 waiting to send"],
    [{ kind: "waiting", count: 4 }, "Not saved yet · 4 waiting to send"],
    [
      { kind: "failed", cause: "refused", reason: "x." },
      "Save failed · x. Edit and submit again.",
    ],
    [
      { kind: "failed", cause: "unreadable" },
      "Saved edits could not be read · Retry to read them",
    ],
    [
      {
        kind: "unknown",
        reason: "Undo may have been applied",
        recovery: "inspect-history",
      },
      "Outcome unknown · Undo may have been applied. Inspect History before trying again.",
    ],
  ];
  it.each(cases)("%j reads %s", (state, text) => {
    expect(saveStateText(state)).toBe(text);
  });
});
