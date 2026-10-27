import { describe, expect, it } from "vitest";
import type { PendingEditView, ProjectView } from "../types/project";
import {
  applySuggestedSummary,
  filterTightenHits,
  isHarshTightenHit,
  isTightenPending,
  listTightenHits,
  tightenClassOf,
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
    kind: "filler",
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
    expect(isTightenPending(edit({ kind: "pause" }))).toBe(true);
    expect(isTightenPending(edit({ kind: "repeat" }))).toBe(true);
    expect(isTightenPending(edit({ kind: "false-start" }))).toBe(true);
    expect(isTightenPending(edit({ kind: "sound" }))).toBe(true);
    expect(isTightenPending(edit({ kind: "other", reason: "nl:topic" }))).toBe(
      false,
    );
  });

  it("fails closed when the server sent no kind", () => {
    const unclassified = edit();
    delete (unclassified as { kind?: string }).kind;
    expect(isTightenPending(unclassified)).toBe(false);
  });

  it("groups on the server kind and never reads the reason", () => {
    // A reason that looks like a filler, sent as another kind, follows the kind.
    expect(tightenClassOf(edit({ reason: "filler:um", kind: "pause" }))).toBe(
      "pause",
    );
    expect(
      tightenClassOf(edit({ reason: "filler:um", kind: "other" })),
    ).toBeNull();
  });

  it("lists and filters repetition and restart hits as review-required", () => {
    const hits = listTightenHits(
      [
        edit({
          id: "repeat",
          reason: "repetition:word:um",
          review_required: true,
          kind: "repeat",
          harsh: true,
        }),
        edit({
          id: "restart",
          reason: "restart:phrase:i went",
          review_required: true,
          kind: "false-start",
          harsh: true,
        }),
      ],
      transcript,
    );
    expect(hits.map((hit) => hit.tightenClass)).toEqual([
      "repeat",
      "false-start",
    ]);
    expect(hits.map((hit) => hit.riskBadge)).toEqual(["review", "review"]);
    expect(
      filterTightenHits(hits, {
        classFilter: "false-start",
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
          kind: "pause",
          harsh: true,
          source_start: 4,
          timeline_start: 4,
        }),
        edit({ id: "e3", reason: "nl:cut", kind: "other" }),
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

  it("asks one question that names the sounds and the per-sound actions", () => {
    expect(applySuggestedSummary(31)).toEqual({
      question: {
        title: "Apply suggested actions to 31 sounds?",
        message:
          "Each sound gets its own action: cut, shorten, lower or leave. A cut over another speaker ripples every track. One undo puts it all back.",
        keepLabel: "Keep reviewing",
        actionLabel: "Apply 31",
        danger: false,
      },
    });
    expect(applySuggestedSummary(1).question).toMatchObject({
      title: "Apply suggested actions to 1 sound?",
      actionLabel: "Apply 1",
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
