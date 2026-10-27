import { describe, expect, it } from "vitest";
import {
  appliedEditRecord,
  clipRow,
  minimalProject,
  pendingEditView,
  sampleComment,
  sampleTrack,
} from "../test/fixtures";
import type { ProjectView, Selection } from "../types/project";
import {
  type EditFacts,
  editFacts,
  selectionKind,
  selectionSpan,
} from "./editSelection";
import { makeRangeTarget } from "./rangeSelection";

const clips = [
  clipRow({
    id: "a",
    track_id: "host",
    source_start: 0,
    source_end: 4,
    timeline_start: 0,
    timeline_end: 4,
  }),
  clipRow({
    id: "b",
    track_id: "host",
    source_start: 6,
    source_end: 10,
    timeline_start: 6,
    timeline_end: 10,
  }),
  clipRow({
    id: "c",
    track_id: "host",
    source_start: 12,
    source_end: 14,
    timeline_start: 12,
    timeline_end: 14,
  }),
];

function project(overrides: Partial<ProjectView> = {}): ProjectView {
  return minimalProject({
    tracks: [sampleTrack({ id: "host", range_media_seal: "s" })],
    clips: { tracks: { host: clips }, clip_count: clips.length },
    transcript: {
      utterances: [
        {
          track_id: "host",
          speaker: "Host",
          start: 1,
          end: 8,
          text: "one two three",
          words: [
            { text: "one", start: 1, end: 2, word_index: 0 },
            { text: "two", start: 2.5, end: 3.5, word_index: 1 },
            { text: "three", start: 7, end: 8, word_index: 2 },
          ],
        },
      ],
    },
    ...overrides,
  });
}

const words = (start: number, end: number): Selection => ({
  kind: "transcriptRange",
  trackId: "host",
  startWordIndex: start,
  endWordIndex: end,
});
const ctx = { role: "host", clipboardHasAudio: false } as const;

describe("selectionKind", () => {
  const range = makeRangeTarget(project(), [{ start: 1, end: 2 }], ["host"]);
  if (!range) throw new Error("fixture range");
  const cases: [Selection, string][] = [
    [null, "playhead"],
    [words(0, 1), "words"],
    [{ kind: "range", target: range }, "range"],
    [{ kind: "clip", id: "a", trackId: "host" }, "clip"],
    [{ kind: "applied", id: "edit-1", trackId: "host" }, "seam"],
    [{ kind: "applied", id: "mute-1", trackId: "host" }, "appliedEdge"],
    [{ kind: "applied", id: "trim-1", trackId: "host" }, "appliedEdge"],
    [{ kind: "applied", id: "gone", trackId: "host" }, "appliedEdge"],
    [{ kind: "pending", id: "pending-1", trackId: "host" }, "suggestion"],
    [{ kind: "chapter", id: "ch", time: 5 }, "chapter"],
    [{ kind: "social", id: "s" }, "social"],
    [{ kind: "comment", id: "c1" }, "comment"],
    [{ kind: "track", trackId: "host" }, "track"],
    [{ kind: "envelope", trackId: "host" }, "envelope"],
    [{ kind: "envelopePoint", trackId: "host", pointId: "p" }, "envelopePoint"],
    [
      {
        kind: "bleedAttenuation",
        id: "b",
        trackId: "host",
        regionKey: null,
      },
      "bleed",
    ],
  ];
  const withRecords = project({
    applied_edits: {
      count: 3,
      records: [
        appliedEditRecord({ track_ids: ["host"] }),
        appliedEditRecord({
          id: "mute-1",
          operation: "edit_selected_range",
          params: { action: "mute" },
        }),
        appliedEditRecord({ id: "trim-1", operation: "trim_clip_edge" }),
      ],
    },
  });
  it.each(cases)("%j is %s", (selection, kind) => {
    expect(selectionKind(selection, withRecords)).toBe(kind);
  });
});

describe("selectionSpan", () => {
  const withObjects = project({
    applied_edits: {
      count: 1,
      records: [appliedEditRecord({ track_ids: ["host"] })],
    },
    pending_edits: [
      pendingEditView({ id: "p", track_id: "host", track_ids: ["host"] }),
    ],
    comments: [sampleComment()],
  });
  const range = makeRangeTarget(
    withObjects,
    [
      { start: 1, end: 2 },
      { start: 3, end: 5 },
    ],
    ["host"],
  );
  if (!range) throw new Error("fixture range");
  const cases: [string, Selection, unknown][] = [
    ["words", words(0, 1), { start: 1, end: 3.5, trackIds: ["host"] }],
    [
      "range",
      { kind: "range", target: range },
      { start: 1, end: 5, trackIds: ["host"] },
    ],
    [
      "clips",
      { kind: "clip", id: "a", trackId: "host", ids: ["a", "b"] },
      { start: 0, end: 10, trackIds: ["host"] },
    ],
    [
      "seam",
      { kind: "applied", id: "edit-1", trackId: "host" },
      { start: 2, end: 3, trackIds: ["host"] },
    ],
    [
      "suggestion",
      { kind: "pending", id: "p", trackId: "host" },
      { start: 2, end: 3, trackIds: ["host"] },
    ],
    [
      "chapter",
      { kind: "chapter", id: "ch", time: 12 },
      { start: 12, end: 12, trackIds: [] },
    ],
    [
      "comment",
      { kind: "comment", id: "c1" },
      { start: 12.5, end: 12.5, trackIds: [] },
    ],
    ["track", { kind: "track", trackId: "host" }, null],
    ["playhead", null, null],
  ];
  it.each(cases)("%s", (_name, selection, expected) => {
    expect(selectionSpan(selection, withObjects)).toEqual(expected);
  });
});

describe("editFacts", () => {
  const base: EditFacts = {
    kind: "playhead",
    count: 0,
    span: null,
    holdsCut: false,
    hasGap: false,
    suggestedAction: null,
    commentResolved: false,
    clipboardHasAudio: false,
    role: "host",
  };

  it("tells words over an applied cut from the same words with none", () => {
    const cut = project({
      transcript: {
        utterances: [
          {
            track_id: "host",
            speaker: "Host",
            start: 1,
            end: 8,
            text: "one two three",
            words: [
              { text: "one", start: 1, end: 2, word_index: 0 },
              {
                text: "two",
                start: 2.5,
                end: 3.5,
                word_index: 1,
                suppressed: true,
              },
              { text: "three", start: 7, end: 8, word_index: 2 },
            ],
          },
        ],
      },
    });
    expect(editFacts(words(0, 1), cut, ctx)).toEqual({
      ...base,
      kind: "words",
      count: 2,
      span: { start: 1, end: 3.5, trackIds: ["host"] },
      holdsCut: true,
    });
    expect(editFacts(words(0, 1), project(), ctx).holdsCut).toBe(false);
  });

  it("finds the gap between two clips in a range", () => {
    const p = project();
    const across = makeRangeTarget(p, [{ start: 4.5, end: 5.5 }], ["host"]);
    const inside = makeRangeTarget(p, [{ start: 1, end: 2 }], ["host"]);
    if (!across || !inside) throw new Error("fixture range");
    expect(editFacts({ kind: "range", target: across }, p, ctx)).toMatchObject({
      kind: "range",
      hasGap: true,
    });
    expect(editFacts({ kind: "range", target: inside }, p, ctx).hasGap).toBe(
      false,
    );
  });

  it("counts a clip selection", () => {
    expect(
      editFacts(
        { kind: "clip", id: "a", trackId: "host", ids: ["a", "b", "c"] },
        project(),
        ctx,
      ),
    ).toMatchObject({ kind: "clip", count: 3 });
  });

  describe("holdsCut", () => {
    const offsetClip = clipRow({
      id: "x",
      track_id: "host",
      source_start: 0,
      source_end: 20,
      timeline_start: 10,
      timeline_end: 30,
    });
    const offset = (records = [appliedEditRecord({ track_ids: ["host"] })]) =>
      project({
        clips: { tracks: { host: [offsetClip] }, clip_count: 1 },
        transcript: {
          utterances: [
            {
              track_id: "host",
              speaker: "Host",
              start: 1,
              end: 8,
              text: "one two three",
              words: [
                { text: "one", start: 1, end: 2, word_index: 0 },
                {
                  text: "two",
                  start: 2,
                  end: 3,
                  word_index: 1,
                  suppressed: true,
                  timeline_start: null,
                  timeline_end: null,
                },
                { text: "three", start: 7, end: 8, word_index: 2 },
              ],
            },
          ],
        },
        applied_edits: { count: records.length, records },
      });

    it("is true for a cut word whose clip sits later on the timeline", () => {
      const p = offset([
        appliedEditRecord({
          track_ids: ["host"],
          timeline_start: 12,
          timeline_end: 13,
        }),
      ]);
      expect(editFacts(words(1, 1), p, ctx).holdsCut).toBe(true);
    });

    it("is true for a cut word when no record is on file", () => {
      expect(editFacts(words(0, 1), offset([]), ctx).holdsCut).toBe(true);
    });

    it("is false for live words", () => {
      expect(editFacts(words(2, 2), offset(), ctx).holdsCut).toBe(false);
    });

    it("ignores a mute that overlaps live words", () => {
      const muted = offset([
        appliedEditRecord({
          track_ids: ["host"],
          operation: "edit_selected_range",
          params: { action: "mute" },
          timeline_start: 0,
          timeline_end: 100,
        }),
      ]);
      expect(editFacts(words(0, 0), muted, ctx).holdsCut).toBe(false);
    });

    it("counts a removal under a range and not a trim or a mute", () => {
      const removal = appliedEditRecord({ track_ids: ["host"] });
      const trim = appliedEditRecord({
        id: "trim",
        track_ids: ["host"],
        operation: "trim_clip_edge",
      });
      const mute = appliedEditRecord({
        id: "mute",
        track_ids: ["host"],
        params: { mute: true },
      });
      const holds = (records: ReturnType<typeof appliedEditRecord>[]) => {
        const p = project({
          applied_edits: { count: records.length, records },
        });
        const target = makeRangeTarget(p, [{ start: 1.5, end: 3.5 }], ["host"]);
        if (!target) throw new Error("fixture range");
        return editFacts({ kind: "range", target }, p, ctx).holdsCut;
      };
      expect(holds([removal])).toBe(true);
      expect(holds([trim, mute])).toBe(false);
    });

    it("is true at a removal seam and false at a mute", () => {
      const p = project({
        applied_edits: {
          count: 2,
          records: [
            appliedEditRecord({ track_ids: ["host"] }),
            appliedEditRecord({ id: "m", params: { mute: true } }),
          ],
        },
      });
      expect(
        editFacts({ kind: "applied", id: "edit-1" }, p, ctx).holdsCut,
      ).toBe(true);
      expect(editFacts({ kind: "applied", id: "m" }, p, ctx)).toMatchObject({
        kind: "appliedEdge",
        holdsCut: false,
      });
    });
  });

  it("carries the suggested action and the comment state", () => {
    const p = project({
      pending_edits: [
        pendingEditView({
          id: "p",
          type: "remove",
          suggested_action: "shorten",
        }),
      ],
      comments: [sampleComment({ resolved: true })],
    });
    expect(
      editFacts({ kind: "pending", id: "p", trackId: "host" }, p, ctx)
        .suggestedAction,
    ).toBe("shorten");
    expect(editFacts({ kind: "comment", id: "c1" }, p, ctx)).toMatchObject({
      kind: "comment",
      commentResolved: true,
      suggestedAction: null,
    });
  });

  it("passes the role and clipboard through", () => {
    expect(
      editFacts(null, project(), { role: "readOnly", clipboardHasAudio: true }),
    ).toEqual({ ...base, role: "readOnly", clipboardHasAudio: true });
  });
});
