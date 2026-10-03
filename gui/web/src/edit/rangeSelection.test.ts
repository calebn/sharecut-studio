import { describe, expect, it } from "vitest";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import type { ClipRow, ProjectView, Selection } from "../types/project";
import {
  makeRangeTarget,
  rangeIsCurrent,
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
