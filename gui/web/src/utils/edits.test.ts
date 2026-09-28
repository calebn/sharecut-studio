import { describe, expect, it } from "vitest";
import type { PendingEditView } from "../types/project";
import { selectUnmappedPending, unmappedPendingLabel } from "./edits";

function pending(overrides: Partial<PendingEditView>): PendingEditView {
  return {
    id: "p1",
    track_id: "host",
    type: "remove",
    reason: "filler",
    source_start: 0,
    source_end: 1,
    timeline_start: null,
    timeline_end: null,
    timeline_spans: [],
    mappable: true,
    crossfade_ms: null,
    boundary_mode: null,
    cut_confidence: null,
    review_required: false,
    applied: false,
    ...overrides,
  };
}

describe("unmappedPendingLabel", () => {
  it("names the count", () => {
    expect(unmappedPendingLabel(3)).toBe("Edits in removed audio (3)");
  });
});

describe("selectUnmappedPending", () => {
  it("returns an empty array for empty, null, and undefined input", () => {
    expect(selectUnmappedPending([])).toEqual([]);
    expect(selectUnmappedPending(null)).toEqual([]);
    expect(selectUnmappedPending(undefined)).toEqual([]);
  });

  it("filters to only mappable: false", () => {
    const mappable = pending({ id: "a", mappable: true });
    const unmapped = pending({ id: "b", mappable: false });
    expect(selectUnmappedPending([mappable, unmapped])).toEqual([unmapped]);
  });
});
