import { describe, expect, it } from "vitest";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import type {
  ClipRow,
  ExactRangeTarget,
  ProjectView,
  Selection,
} from "../types/project";
import {
  makeRangeTarget,
  rangeIsCurrent,
  rangeTargetsEqual,
  resolveSelectionRange,
} from "./rangeSelection";

const selection: Selection = {
  kind: "transcriptRange",
  trackId: "speaker",
  startWordIndex: 0,
  endWordIndex: 1,
};
function project(clips: ClipRow[]): ProjectView {
  return minimalProject({
    tracks: [
      sampleTrack({ id: "speaker", range_media_seal: "s" }),
      sampleTrack({ id: "destination", range_media_seal: "d" }),
    ],
    clips: {
      tracks: {
        speaker: clips.filter((c) => c.track_id === "speaker"),
        destination: clips.filter((c) => c.track_id === "destination"),
      },
      clip_count: clips.length,
    },
    transcript: {
      utterances: [
        {
          track_id: "speaker",
          speaker: "Speaker",
          start: 1,
          end: 7,
          text: "one two",
          words: [
            { text: "one", start: 1, end: 2, word_index: 0 },
            { text: "two", start: 6, end: 7, word_index: 1 },
          ],
        },
      ],
    },
  });
}
const placement = (
  id: string,
  start: number,
  end: number,
  timeline: number,
  track = "speaker",
) =>
  clipRow({
    id,
    track_id: track,
    origin_track_id: "speaker",
    source_id: null,
    source_start: start,
    source_end: end,
    timeline_start: timeline,
    timeline_end: timeline + end - start,
  });

describe("exact transcript range resolution", () => {
  it("includes the phrase pause", () => {
    const resolved = resolveSelectionRange(
      project([placement("a", 0, 8, 0)]),
      selection,
    );
    expect(resolved.targets.map((t) => t.intervals)).toEqual([
      [{ start: 1, end: 7 }],
    ]);
  });
  it("combines surviving split and rippled fragments into one choice", () => {
    const resolved = resolveSelectionRange(
      project([placement("a", 0, 3, 0), placement("b", 5, 8, 3)]),
      selection,
    );
    expect(resolved.targets.map((t) => t.intervals)).toEqual([
      [{ start: 1, end: 5 }],
    ]);
  });
  it("keeps disjoint moved fragments and uses actual destination lane ids", () => {
    const resolved = resolveSelectionRange(
      project([
        placement("a", 0, 3, 20, "destination"),
        placement("b", 5, 8, 0, "destination"),
      ]),
      selection,
    );
    expect(
      resolved.targets.map((t) => ({
        intervals: t.intervals,
        tracks: t.track_ids,
      })),
    ).toEqual([
      {
        intervals: [
          { start: 0, end: 2 },
          { start: 21, end: 23 },
        ],
        tracks: ["destination"],
      },
    ]);
  });
  it("requires an explicit choice for identical repeated source material", () => {
    const p = project([
      placement("first", 0, 8, 0),
      placement("second", 0, 8, 10),
    ]);
    const resolved = resolveSelectionRange(p, selection);
    expect(resolved.reason).toBe("Choose the audible occurrence");
    expect(resolved.targets.map((t) => t.intervals)).toEqual([
      [{ start: 1, end: 7 }],
      [{ start: 11, end: 17 }],
    ]);
    expect(resolved.targets[1]?.clips.map((c) => c.id)).toEqual(["second"]);
  });
  it("never guesses a pairing for repeated split fragments", () => {
    const resolved = resolveSelectionRange(
      project([
        placement("a", 0, 3, 0),
        placement("b", 5, 8, 3),
        placement("c", 0, 3, 10),
        placement("d", 5, 8, 13),
      ]),
      selection,
    );
    expect(resolved.targets).toEqual([]);
    expect(resolved.reason).toBe(
      "Repeated split fragments cannot be paired safely. Select the intended range in the timeline.",
    );
  });
  it("does not confuse another recording with the selected source", () => {
    const p = project([placement("wrong", 0, 8, 0)]);
    p.clips.tracks.speaker![0]!.source_id = "another";
    expect(resolveSelectionRange(p, selection).targets).toEqual([]);
  });
  it("seals selected geometry and gaps while unrelated lanes may change", () => {
    const p = project([placement("a", 0, 8, 0)]);
    const target = makeRangeTarget(
      p,
      [
        { start: 1, end: 3 },
        { start: 2, end: 9 },
      ],
      ["speaker"],
    )!;
    expect(target.intervals).toEqual([{ start: 1, end: 9 }]);
    expect(rangeIsCurrent(p, target)).toBe(true);
    p.clips.tracks.destination = [placement("other", 0, 8, 0, "destination")];
    expect(rangeIsCurrent(p, target)).toBe(true);
    p.clips.tracks.speaker!.push(placement("inserted", 0, 1, 8));
    expect(rangeIsCurrent(p, target)).toBe(false);
  });
});

describe("exact range wire seals", () => {
  function fixture() {
    const first = placement("a", 0, 8, 10);
    first.mute_regions = [{ start_s: 1.2, end_s: 1.4 }];
    const p = project([first, placement("b", 0, 8, 10, "destination")]);
    const target = makeRangeTarget(
      p,
      [
        { start: 11, end: 12 },
        { start: 14, end: 15 },
      ],
      ["speaker", "destination"],
    )!;
    const wire: ExactRangeTarget = JSON.parse(
      JSON.stringify({
        media_seals: { destination: "d", speaker: "s" },
        clips: target.clips.map((clip) => ({
          id: clip.id,
          track_id: clip.track_id,
          source_start: clip.source_start,
          source_end: clip.source_end,
          timeline_start: clip.timeline_start,
          source_id: clip.source_id,
          fade_in_ms: clip.fade_in_ms,
          fade_out_ms: clip.fade_out_ms,
          join_in_mode: clip.join_in_mode,
          mute_regions: clip.mute_regions.map(({ start_s, end_s }) => ({
            end_s,
            start_s,
          })),
        })),
        track_ids: target.track_ids,
        intervals: target.intervals.map(({ start, end }) => ({ end, start })),
        kind: target.kind,
      }),
    );
    return { p, target, wire };
  }

  it("accepts the saved server-shaped target despite object key order", () => {
    const { p, target, wire } = fixture();
    expect(JSON.stringify(wire)).not.toEqual(JSON.stringify(target));
    expect(rangeIsCurrent(JSON.parse(JSON.stringify(p)), wire)).toBe(true);
  });

  it.each([
    ["id", "changed"],
    ["track_id", "destination"],
    ["source_id", "new-recording"],
    ["source_start", 0.1],
    ["source_end", 7.9],
    ["timeline_start", 10.1],
    ["fade_in_ms", 20],
    ["fade_out_ms", 20],
    ["join_in_mode", "cut"],
    ["mute_regions", [{ start_s: 1.2, end_s: 1.5 }]],
  ])("rejects changed sealed clip field %s", (field, value) => {
    const { p, wire } = fixture();
    const changed = {
      ...wire,
      clips: wire.clips.map((clip, index) =>
        index ? clip : { ...clip, [field as string]: value },
      ),
    };
    expect(rangeIsCurrent(p, changed)).toBe(false);
  });

  it("keeps media seal values and array ordering meaningful", () => {
    const { p, wire } = fixture();
    expect(
      rangeIsCurrent(p, {
        ...wire,
        media_seals: { ...wire.media_seals, speaker: "changed" },
      }),
    ).toBe(false);
    expect(
      rangeIsCurrent(p, {
        ...wire,
        media_seals: { ...wire.media_seals, extra: "seal" },
      }),
    ).toBe(false);
    expect(
      rangeIsCurrent(p, { ...wire, intervals: [...wire.intervals].reverse() }),
    ).toBe(false);
    expect(rangeIsCurrent(p, { ...wire, track_ids: ["speaker"] })).toBe(false);
    expect(
      rangeIsCurrent(p, { ...wire, clips: [...wire.clips].reverse() }),
    ).toBe(false);
    expect(
      rangeTargetsEqual(wire, { ...wire, intervals: [wire.intervals[0]] }),
    ).toBe(false);
    expect(
      rangeTargetsEqual(wire, {
        ...wire,
        track_ids: [...wire.track_ids].reverse(),
      }),
    ).toBe(false);
    expect(
      rangeTargetsEqual(wire, {
        ...wire,
        intervals: [...wire.intervals].reverse(),
      }),
    ).toBe(false);
    const changed = {
      ...p,
      tracks: p.tracks.map((track) =>
        track.id === "destination"
          ? { ...track, range_media_seal: "replacement" }
          : track,
      ),
    };
    expect(rangeIsCurrent(changed, wire)).toBe(false);
  });
});
