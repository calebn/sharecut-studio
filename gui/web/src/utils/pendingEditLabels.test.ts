import { describe, expect, it } from "vitest";
import { sampleTrack } from "../test/fixtures";
import type { PendingKind } from "../types/project";
import { ApiError } from "./apiError";
import {
  pendingListRowLabel,
  pendingReasonLabel,
  pendingRetimeRefusal,
  pendingTypeLabel,
} from "./pendingEditLabels";

describe("pendingTypeLabel", () => {
  it("names the known types and capitalises the rest", () => {
    expect(pendingTypeLabel("remove")).toBe("Cut");
    expect(pendingTypeLabel("mute")).toBe("Mute");
    expect(pendingTypeLabel("split")).toBe("Split");
    expect(pendingTypeLabel("swap")).toBe("Swap");
  });
});

describe("pendingReasonLabel", () => {
  it.each([
    ["guest:suggest", "other", "Suggested by guest"],
    ["guest:suggest_split", "other", "Split suggested by guest"],
    ["guest:suggest_delete", "other", "Delete suggested by guest"],
    [
      "guest:suggest_ripple_delete",
      "other",
      "Ripple delete suggested by guest",
    ],
    ["nl:range", "other", "Agent edit (time range)"],
    ["nl:manual", "other", "Agent edit"],
    ["nl:words", "other", "Agent edit (selected words)"],
    ["other", "other", "Other"],
    ["nl:match:the end", "other", "Agent edit (matched text)"],
    ["nl:utterance:u7", "other", "Agent edit (utterance)"],
    ["filler:acoustic", "sound", "Filler sound"],
    ["filler:acoustic:likely_laugh", "sound", "Likely laugh"],
    ["filler:acoustic:likely_laugh:risky", "sound", "Likely laugh"],
    ["filler:acoustic:possible_word", "sound", "Possible missed word"],
    [
      "filler:acoustic:likely_laugh:possible_word:risky",
      "sound",
      "Possible missed word",
    ],
    ["filler:um", "filler", 'Filler word "um"'],
    ["pause:1.2s", "pause", "Long pause (1.2s)"],
    ["pause:", "pause", "Long pause"],
    ["repetition:word:the", "repeat", "Repeated word"],
    ["repetition:the", "repeat", "Repeated word"],
    ["restart:we", "false-start", "False start"],
    ["tangent", "other", "tangent"],
  ])("%s (%s) -> %s", (code, kind, label) => {
    expect(pendingReasonLabel(code, kind as PendingKind)).toBe(label);
  });

  it("labels by the server kind, not by the reason prefix", () => {
    expect(pendingReasonLabel("filler:um", "other")).toBe("filler:um");
    expect(pendingReasonLabel("filler:um", "pause")).toBe("Long pause (um)");
  });

  it("falls back to the raw reason for a missing or unknown kind", () => {
    expect(pendingReasonLabel("filler:um", undefined as never)).toBe(
      "filler:um",
    );
    expect(pendingReasonLabel("filler:um", "mystery" as never)).toBe(
      "filler:um",
    );
    expect(pendingReasonLabel("filler:um", "toString" as never)).toBe(
      "filler:um",
    );
  });

  it("handles a missing reason", () => {
    expect(pendingReasonLabel(null, "other")).toBe("No reason given");
    expect(pendingReasonLabel(undefined, "other")).toBe("No reason given");
  });
});

describe("pendingListRowLabel", () => {
  it("names the cut at the source clock like held-cut toasts", () => {
    const tracks = [sampleTrack({ id: "host", speaker: "Dani" })];
    expect(
      pendingListRowLabel(
        {
          id: "e1",
          track_id: "host",
          type: "remove",
          reason: "filler:um",
          source_start: 1826.1,
          source_end: 1827,
          source_start_timeline: null,
          source_end_timeline: null,
          timeline_start: null,
          timeline_end: null,
          timeline_spans: [],
          mappable: true,
          crossfade_ms: null,
          boundary_mode: null,
          cut_confidence: null,
          review_required: true,
          kind: "filler",
          harsh: false,
          applied: false,
          suggest_reason: null,
        },
        tracks,
      ),
    ).toBe('Dani\'s cut at 30:26.1 · Filler word "um"');
  });
});

describe("pendingRetimeRefusal", () => {
  const generic = (edge: string) =>
    `That edit's ${edge} was not saved, so it is back where it was. Move the edge again or pick a different range.`;

  it.each([
    [
      "exact_range_locked",
      409,
      "This range is exact and can't be moved by its edges. Select the range again.",
    ],
    ["edit_not_found", 404, "That suggestion is gone, so nothing was saved."],
    [
      "pending_edit_not_found",
      404,
      "That suggestion is gone, so nothing was saved.",
    ],
    [
      "range_end_before_start",
      400,
      "The end must come after the start, so the end is back where it was. Move the edge again.",
    ],
    [
      "pending_edit_changed",
      409,
      "That edit changed while you were moving it. Check the new range and try again.",
    ],
    ["something_new", 409, generic("end")],
    [null, 400, generic("end")],
    [null, 422, generic("end")],
  ])("says the same for code %s with status %s", (code, status, sentence) => {
    const error = new ApiError("server detail", code, status);
    expect(pendingRetimeRefusal(error, "end")).toBe(sentence);
  });

  it("names the edge that was dragged", () => {
    const error = new ApiError("x", null, 409);
    expect(pendingRetimeRefusal(error, "start")).toBe(generic("start"));
    const crossed = new ApiError("x", "range_end_before_start", 400);
    expect(pendingRetimeRefusal(crossed, "start")).toContain(
      "the start is back",
    );
  });
});
