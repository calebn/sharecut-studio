import { describe, expect, it } from "vitest";
import { offlineConflict } from "../test/fixtures";
import { DocumentCommand } from "../types/documentCommands.generated";
import { suggestionOf } from "./conflictRows";

const target = (start: number, end: number, track_ids = ["host"]) => ({
  intervals: [{ start, end }],
  track_ids,
  clips: [],
  media_seals: [],
});
const cut = (targets: unknown[] = [target(724, 727.5)], action = "cut") => ({
  type: DocumentCommand.EditSelectedRange,
  payload: { action, targets },
});
const refused = (
  command: { type: string; payload: Record<string, unknown> },
  code: string | null = "range_changed",
) => offlineConflict({ command, ...(code ? { code } : {}) });

describe("suggestionOf", () => {
  it("words a refused guest cut at the time it sat", () => {
    expect(suggestionOf(refused(cut()))).toEqual({
      title: "Your cut at 12:04 overlaps a newer edit",
      names: {
        hear: "Hear your cut at 12:04",
        suggestAgain: "Suggest again here, your cut at 12:04",
        drop: "Drop it, your cut at 12:04",
      },
      startSec: 724,
      endSec: 727.5,
      trackIds: ["host"],
    });
  });

  it("spans every interval and joins the tracks of every target", () => {
    const found = suggestionOf(
      refused(
        cut([target(730, 731, ["a", "b"]), target(724, 726, ["b", "c"])]),
      ),
    );
    expect(found).toMatchObject({
      startSec: 724,
      endSec: 731,
      trackIds: ["a", "b", "c"],
    });
  });

  it("reads an hour or more as h:mm:ss", () => {
    expect(suggestionOf(refused(cut([target(3725, 3727)])))?.title).toBe(
      "Your cut at 1:02:05 overlaps a newer edit",
    );
  });

  it.each([
    ["a mute", refused(cut(undefined, "mute"))],
    ["no code", refused(cut(), null)],
    ["another code", refused(cut(), "document_conflict")],
    [
      "another command",
      refused({ type: DocumentCommand.DeleteClip, payload: {} }),
    ],
    ["no targets", refused(cut([]))],
    ["a malformed target", refused(cut([{ intervals: "x" }, null]))],
    ["a reversed interval", refused(cut([target(9, 3)]))],
    ["a non-finite interval", refused(cut([target(Number.NaN, 3)]))],
    [
      "an unknown outcome",
      offlineConflict({ kind: "unknown", command: cut() }),
    ],
  ])("gives nothing for %s", (_name, conflict) => {
    expect(suggestionOf(conflict)).toBeUndefined();
  });
});
