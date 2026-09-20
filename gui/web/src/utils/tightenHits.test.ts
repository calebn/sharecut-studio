import { describe, expect, it } from "vitest";
import type { PendingEditView, ProjectView } from "../types/project";
import {
  applyAllSummary,
  eligibleApplyAllIds,
  filterTightenHits,
  isHarshTightenHit,
  isTightenPending,
  listTightenHits,
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
    applied: false,
    ...overrides,
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
  it("selects filler and pause reasons only", () => {
    expect(isTightenPending(edit())).toBe(true);
    expect(isTightenPending(edit({ reason: "pause:1.1s" }))).toBe(true);
    expect(isTightenPending(edit({ reason: "nl:topic" }))).toBe(false);
  });

  it("flags harsh cuts from review, join fail, and risky", () => {
    expect(isHarshTightenHit(edit())).toBe(false);
    expect(isHarshTightenHit(edit({ review_required: true }))).toBe(true);
    expect(
      isHarshTightenHit(
        edit({ join_risk: { verdict: "fail", source: "reason" } }),
      ),
    ).toBe(true);
    expect(
      isHarshTightenHit(
        edit({ reason: "filler:um:risky", join_risk: { verdict: "review" } }),
      ),
    ).toBe(true);
    expect(isHarshTightenHit(edit({ reason: "filler:um:join_review" }))).toBe(
      true,
    );
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
        edit({ id: "e2", reason: "filler:uh:risky", review_required: true }),
      ],
      null,
    );
    expect(eligibleApplyAllIds(hits, true)).toEqual(["e1"]);
    expect(eligibleApplyAllIds(hits, false)).toEqual(["e1", "e2"]);
    expect(applyAllSummary(31, 23)).toEqual({
      apply: 23,
      skipped: 8,
      confirm: "Apply 23 of 31 — 8 skipped as harsh",
    });
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
