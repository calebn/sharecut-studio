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
  const unsaved = (edge: string) =>
    `That edit's ${edge} could not be saved right now, so it is back where it was. Try moving it again in a moment.`;

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
    [null, 408, unsaved("end")],
    [null, 429, unsaved("end")],
    [null, 500, unsaved("end")],
    ["pending_edit_changed", 503, unsaved("end")],
    [null, null, unsaved("end")],
  ])("code %s with status %s", (code, status, sentence) => {
    const error = new ApiError("server detail", code, status);
    expect(pendingRetimeRefusal(error, "end")).toBe(sentence);
  });

  it.each([
    [
      "cut_scope_changed",
      409,
      "The range changed after this suggestion was made, so it needs review again and the edge is back where it was.",
    ],
  ])("says the scope changed for %s", (code, status, sentence) => {
    const said = pendingRetimeRefusal(
      new ApiError("RAW server text", code, status),
      "end",
    );
    expect(said).toBe(sentence);
    expect(said).not.toContain("RAW");
    expect(said).not.toContain("pick a different range");
  });

  it.each([
    [401, null],
    [403, null],
    [403, "forbidden"],
    [404, "share_not_found"],
  ])("names a lost permission for status %s code %s", (status, code) => {
    const said = pendingRetimeRefusal(new ApiError("RAW", code, status), "end");
    expect(said).toBe(
      "You can no longer change this edit, so nothing was saved and the edge is back where it was. Sign in again or ask the host for access.",
    );
  });

  it("does not call an ordinary 404 a lost permission", () => {
    expect(pendingRetimeRefusal(new ApiError("x", null, 404), "end")).toBe(
      generic("end"),
    );
  });

  it.each([
    ["project_version_newer", 400, "newer version of the app"],
    ["project_version_unsupported", 400, "can't edit this project's version"],
    ["project_not_found", 404, "project file is missing"],
    ["project_unreadable", 500, "project file is damaged"],
  ])("names the project-level cause for %s", (code, status, part) => {
    const said = pendingRetimeRefusal(new ApiError("RAW", code, status), "end");
    expect(said).toContain(part);
    expect(said).toContain("back where it was");
    expect(said).not.toContain("Move the edge again");
    expect(said).not.toContain("RAW");
  });

  it("never shows the server's own text, and says the same for a transport error", () => {
    for (const status of [400, 409, 500, null]) {
      expect(
        pendingRetimeRefusal(new ApiError("RAW TEXT", null, status), "end"),
      ).not.toContain("RAW");
    }
    expect(pendingRetimeRefusal(new TypeError("Failed to fetch"), "end")).toBe(
      unsaved("end"),
    );
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
