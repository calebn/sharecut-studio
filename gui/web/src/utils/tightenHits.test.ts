import { describe, expect, it } from "vitest";
import type { PendingEditView, ProjectView } from "../types/project";
import {
  applyAllSummary,
  eligibleApplyAllIds,
  filterTightenHits,
  isHarshTightenHit,
  isTightenPending,
  listTightenHits,
  tightenClassOfReason,
  tightenHitCanGoTo,
  tightenHitCanPreview,
  tightenSnippet,
} from "./tightenHits";

function edit(overrides: Partial<PendingEditView> = {}): PendingEditView {
  return {
    id: "e1",
    track_id: "host",
    type: "remove",
    reason: "filler:um",
    source_start: 1,
    source_end: 1.2,
    timeline_start: 1,
    timeline_end: 1.2,
    timeline_spans: [{ start: 1, end: 1.2 }],
    mappable: true,
    crossfade_ms: 10,
    boundary_mode: null,
    cut_confidence: 0.8,
    review_required: false,
    harsh: false,
    listen_one_by_one: false,
    applied: false,
    suggest_reason: null,
    ...overrides,
    source_start_timeline:
      overrides.source_start_timeline === undefined
        ? overrides.timeline_start === undefined
          ? 1
          : overrides.timeline_start
        : overrides.source_start_timeline,
    source_end_timeline:
      overrides.source_end_timeline === undefined
        ? overrides.timeline_end === undefined
          ? 1.2
          : overrides.timeline_end
        : overrides.source_end_timeline,
  };
}

const transcript: ProjectView["transcript"] = {
  utterances: [
    {
      track_id: "host",
      speaker: "Host",
      start: 0,
      end: 3,
      text: "so um hello there friend today",
      words: [
        { text: "so", start: 0, end: 0.4, word_index: 0 },
        { text: "um", start: 1, end: 1.2, word_index: 1 },
        { text: "hello", start: 1.3, end: 1.6, word_index: 2 },
        { text: "there", start: 1.7, end: 2, word_index: 3 },
        { text: "friend", start: 2.1, end: 2.4, word_index: 4 },
        { text: "today", start: 2.5, end: 3, word_index: 5 },
      ],
    },
  ],
};

describe("tightenHits", () => {
  it("selects all tighten proposal classes", () => {
    expect(isTightenPending(edit())).toBe(true);
    expect(isTightenPending(edit({ reason: "pause:1.1s" }))).toBe(true);
    expect(isTightenPending(edit({ reason: "repetition:word:the" }))).toBe(
      true,
    );
    expect(isTightenPending(edit({ reason: "restart:phrase:i went" }))).toBe(
      true,
    );
    expect(isTightenPending(edit({ reason: "nl:topic" }))).toBe(false);
  });

  it("lists and filters repetition and restart hits as review-required", () => {
    const hits = listTightenHits(
      [
        edit({
          id: "repeat",
          reason: "repetition:word:um",
          review_required: true,
          harsh: true,
        }),
        edit({
          id: "restart",
          reason: "restart:phrase:i went",
          review_required: true,
          harsh: true,
        }),
      ],
      transcript,
    );
    expect(hits.map((hit) => hit.tightenClass)).toEqual([
      "repetition",
      "restart",
    ]);
    expect(hits.map((hit) => hit.riskBadge)).toEqual(["review", "review"]);
    expect(eligibleApplyAllIds(hits, true)).toEqual([]);
    expect(
      filterTightenHits(hits, {
        classFilter: "restart",
        trackId: "",
        harshOnly: false,
        query: "",
      }).map((hit) => hit.id),
    ).toEqual(["restart"]);
  });

  it("reads harsh from the server flag, not from review or reason fields", () => {
    expect(isHarshTightenHit(edit())).toBe(false);
    expect(isHarshTightenHit(edit({ harsh: true }))).toBe(true);
    expect(
      isHarshTightenHit(
        edit({ reason: "filler:um:risky", review_required: true }),
      ),
    ).toBe(false);
  });

  it("treats a missing harsh flag as harsh", () => {
    const unclassified = edit();
    delete (unclassified as { harsh?: boolean }).harsh;
    expect(isHarshTightenHit(unclassified)).toBe(true);
  });

  it("leaves an unclassified edit out of apply-all when avoid-harsh is on", () => {
    const unclassified = edit({ id: "unclassified" });
    delete (unclassified as { harsh?: boolean }).harsh;
    const hits = listTightenHits([edit({ id: "safe" }), unclassified], null);
    expect(eligibleApplyAllIds(hits, true)).toEqual(["safe"]);
    expect(eligibleApplyAllIds(hits, false)).toEqual(["safe", "unclassified"]);
  });

  it("builds a ±3 word snippet", () => {
    expect(tightenSnippet(edit(), transcript)).toBe("so um hello there friend");
  });

  it("filters by class, track, harsh, and search", () => {
    const hits = listTightenHits(
      [
        edit(),
        edit({
          id: "e2",
          reason: "pause:0.8s",
          track_id: "guest",
          review_required: true,
          harsh: true,
          source_start: 4,
          timeline_start: 4,
        }),
        edit({ id: "e3", reason: "nl:cut" }),
      ],
      transcript,
    );
    expect(hits.map((h) => h.id)).toEqual(["e1", "e2"]);
    expect(
      filterTightenHits(hits, {
        classFilter: "pause",
        trackId: "",
        harshOnly: false,
        query: "",
      }).map((h) => h.id),
    ).toEqual(["e2"]);
    expect(
      filterTightenHits(hits, {
        classFilter: "all",
        trackId: "host",
        harshOnly: false,
        query: "",
      }).map((h) => h.id),
    ).toEqual(["e1"]);
    expect(
      filterTightenHits(hits, {
        classFilter: "all",
        trackId: "",
        harshOnly: true,
        query: "",
      }).map((h) => h.id),
    ).toEqual(["e2"]);
    expect(
      filterTightenHits(hits, {
        classFilter: "all",
        trackId: "",
        harshOnly: false,
        query: "um",
      }).map((h) => h.id),
    ).toEqual(["e1"]);
  });

  it("excludes harsh ids from apply-all when avoid-harsh is on", () => {
    const hits = listTightenHits(
      [
        edit(),
        edit({
          id: "e2",
          reason: "filler:uh:risky",
          review_required: true,
          harsh: true,
        }),
      ],
      null,
    );
    expect(eligibleApplyAllIds(hits, true)).toEqual(["e1"]);
    expect(eligibleApplyAllIds(hits, false)).toEqual(["e1", "e2"]);
    expect(applyAllSummary(31, 23)).toEqual({
      apply: 23,
      skipped: 8,
      question: {
        title: "Apply 23 tighten hits?",
        message: "Their cuts go into the timeline. 8 harsh hits stay pending.",
        keepLabel: "Keep reviewing",
        actionLabel: "Apply 23",
        danger: false,
      },
    });
    expect(applyAllSummary(2, 1).question).toMatchObject({
      title: "Apply 1 tighten hit?",
      message: "Their cuts go into the timeline. 1 harsh hit stays pending.",
    });
    expect(applyAllSummary(4, 4).question.message).toBe(
      "Their cuts go into the timeline.",
    );
  });

  it("never batches a pause trim, whether or not harsh cuts are avoided", () => {
    const hits = listTightenHits(
      [
        edit({ id: "um" }),
        edit({
          id: "trim",
          reason: "pause:1.10s:solo",
          review_required: true,
          harsh: true,
          listen_one_by_one: true,
        }),
        edit({
          id: "risky",
          reason: "filler:uh:risky",
          review_required: true,
          harsh: true,
        }),
      ],
      null,
    );
    expect(eligibleApplyAllIds(hits, true)).toEqual(["um"]);
    expect(eligibleApplyAllIds(hits, false)).toEqual(["um", "risky"]);
  });

  it("takes the listen-one-by-one rule from the server and fails closed without it", () => {
    const flagged = edit({ id: "trim", listen_one_by_one: true });
    const unclassified = edit({ id: "unknown" });
    delete (unclassified as { listen_one_by_one?: boolean }).listen_one_by_one;
    // A pause the server did not flag is batched; a hit it never classified is not.
    const unflaggedPause = edit({ id: "pause", reason: "pause:1.10s:solo" });
    const hits = listTightenHits([flagged, unclassified, unflaggedPause], null);
    expect(eligibleApplyAllIds(hits, false)).toEqual(["pause"]);
  });

  it("treats missing timeline bounds as not seekable or previewable", () => {
    const hit = listTightenHits(
      [
        edit({
          id: "e-open",
          timeline_start: null,
          timeline_end: null,
          mappable: false,
        }),
      ],
      null,
    )[0];
    expect(tightenHitCanGoTo(hit)).toBe(false);
    expect(tightenHitCanPreview(hit)).toBe(false);
  });
});

describe("tightenClassOfReason", () => {
  it("classifies a bare reason code", () => {
    expect(tightenClassOfReason("restart:partial:we")).toBe("restart");
    expect(tightenClassOfReason("tangent")).toBeNull();
    expect(tightenClassOfReason(null)).toBeNull();
  });
});
