import { describe, expect, it } from "vitest";
import { clipRow } from "../test/fixtures";
import { rowStamp } from "./useJoinEdit";

const row = clipRow({
  id: "right",
  join_in_mode: "crossfade",
  join_left_clip_id: "left",
  join_crossfade_ms: 40,
  join_borrow_sec: 0.02,
  source_duration_sec: 10,
});

describe("rowStamp", () => {
  it.each([
    ["join_borrow_sec", { join_borrow_sec: 0.005 }],
    ["join_borrow_sec dropped", { join_borrow_sec: undefined }],
    ["source_duration_sec", { source_duration_sec: 2.01 }],
    ["source_duration_sec unmeasured", { source_duration_sec: null }],
    ["join_crossfade_ms", { join_crossfade_ms: 10 }],
  ])("changes when only %s changes", (_name, change) => {
    expect(JSON.stringify(rowStamp({ ...row, ...change }))).not.toBe(
      JSON.stringify(rowStamp(row)),
    );
  });

  it("is stable for an equal row", () => {
    expect(JSON.stringify(rowStamp({ ...row }))).toBe(
      JSON.stringify(rowStamp(row)),
    );
  });
});
