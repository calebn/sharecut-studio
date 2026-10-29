import { describe, expect, it } from "vitest";
import { minimalProject } from "../../test/fixtures";
import { lastClipEndSec, targetViewOf, wireTargetOf } from "./recordStageModel";

describe("session target mapping", () => {
  it("reads the server target as the chip's view", () => {
    expect(targetViewOf(undefined, 90)).toEqual({ kind: "end", afterSec: 90 });
    expect(targetViewOf({ kind: "start" }, 90)).toEqual({ kind: "start" });
    expect(targetViewOf({ kind: "insert", at_sec: 5 }, 90)).toEqual({
      kind: "insert",
      atSec: 5,
    });
    expect(
      targetViewOf(
        { kind: "replace", from_sec: 1, to_sec: 2, track_ids: ["a"] },
        90,
      ),
    ).toEqual({ kind: "replace", fromSec: 1, toSec: 2 });
  });

  it("writes the pick as the SetTarget payload", () => {
    expect(wireTargetOf({ kind: "end", afterSec: 90 }, [])).toEqual({
      kind: "end",
    });
    expect(wireTargetOf({ kind: "insert", atSec: 5 }, [])).toEqual({
      kind: "insert",
      at_sec: 5,
    });
    expect(
      wireTargetOf({ kind: "replace", fromSec: 1, toSec: 2 }, ["a", "b"]),
    ).toEqual({
      kind: "replace",
      from_sec: 1,
      to_sec: 2,
      track_ids: ["a", "b"],
    });
  });

  it("finds no end on an empty timeline", () => {
    expect(lastClipEndSec(null)).toBeUndefined();
    expect(lastClipEndSec(minimalProject())).toBeUndefined();
  });
});
