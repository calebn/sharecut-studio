import { describe, expect, it } from "vitest";
import type {
  ExactRangeTarget,
  HistoryEntryId,
  ProjectView,
  Selection,
} from "../types/project";
import {
  parseSplitSpeakersResult,
  siblingSplitLanes,
  speakerLaneMoveTarget,
  splitSpeakerNames,
  splitSpeakersBlocker,
  splitSpeakersDoneCopy,
  splitSpeakersEnrollment,
  splitSpeakersListenNotes,
  splitSpeakersRequestBlocker,
  voiceSampleFromSelection,
} from "./speakerSplit";

const result = {
  split_id: "split_1",
  lanes: [
    { track_id: "room", name: "Ana", muted_sec: 30 },
    { track_id: "room_ben", name: "Ben", muted_sec: 60 },
    { track_id: "room_cy", name: "Cy", muted_sec: 70 },
  ],
  crosstalk_sec: 12.4,
  low_confidence_sec: 75,
  review_spans: [
    {
      start_s: 20,
      end_s: 22,
      speakers: ["room_ben"],
      unsure: true,
      overlapping: false,
      timeline_spans: [{ start_s: 9, end_s: 11 }],
    },
  ],
  history_head_id: "h2" as HistoryEntryId,
};

describe("splitSpeakersBlocker", () => {
  const track = { media_path: "raw/room.wav", speaker_split_id: null };

  it("allows a host's track that has audio and is not a lane of a split", () => {
    expect(splitSpeakersBlocker(track, true)).toBeNull();
  });

  it.each([
    [track, false, "Host-only (not available on review links)"],
    [undefined, true, "Select a track to split"],
    [
      { ...track, speaker_split_id: "split_1" },
      true,
      "This track is already split by speaker. Undo the split to split it again.",
    ],
    [{ ...track, media_path: null }, true, "Import this track's audio first"],
  ])("says why it cannot run: %#", (candidate, canManage, reason) => {
    expect(splitSpeakersBlocker(candidate, canManage)).toBe(reason);
  });
});

describe("siblingSplitLanes", () => {
  const ana = {
    id: "room",
    label: "Ana",
    speaker_split_id: "split_1",
  } as const;
  const ben = {
    id: "room_ben",
    label: "Ben",
    speaker_split_id: "split_1",
  } as const;
  const other = {
    id: "call",
    label: "Call",
    speaker_split_id: null,
  } as const;

  it("lists the other tracks of the same split", () => {
    expect(siblingSplitLanes([ana, ben, other], "room")).toEqual([ben]);
  });

  it("is empty when the track is not a split lane", () => {
    expect(siblingSplitLanes([ana, ben, other], "call")).toEqual([]);
  });
});

describe("speakerLaneMoveTarget", () => {
  const tracks = [
    { id: "room", label: "Ana", speaker_split_id: "split_1" },
    { id: "room_ben", label: "Ben", speaker_split_id: "split_1" },
    { id: "call", label: "Call", speaker_split_id: null },
  ];
  const project = { tracks } as ProjectView;

  it("keeps a single-lane split-range interval", () => {
    const target: ExactRangeTarget = {
      kind: "exact_range",
      track_ids: ["room"],
      intervals: [{ start: 1, end: 1.4 }],
      clips: [],
      media_seals: {},
    };
    expect(speakerLaneMoveTarget(project, target)).toEqual({
      fromLaneId: "room",
      interval: { start: 1, end: 1.4 },
    });
  });

  it("is null when the range is not one split lane", () => {
    const twoTracks: ExactRangeTarget = {
      kind: "exact_range",
      track_ids: ["room", "room_ben"],
      intervals: [{ start: 1, end: 1.4 }],
      clips: [],
      media_seals: {},
    };
    const unsplit: ExactRangeTarget = {
      kind: "exact_range",
      track_ids: ["call"],
      intervals: [{ start: 1, end: 1.4 }],
      clips: [],
      media_seals: {},
    };
    expect(speakerLaneMoveTarget(project, twoTracks)).toBeNull();
    expect(speakerLaneMoveTarget(project, unsplit)).toBeNull();
    expect(speakerLaneMoveTarget(null, twoTracks)).toBeNull();
  });
});

describe("parseSplitSpeakersResult", () => {
  it("reads what the job carries", () => {
    expect(parseSplitSpeakersResult(result)).toEqual(result);
  });

  it("is null for anything that is not a split of two or more tracks", () => {
    expect(parseSplitSpeakersResult(null)).toBeNull();
    expect(parseSplitSpeakersResult({ paths: ["a.wav"] })).toBeNull();
    expect(parseSplitSpeakersResult({ lanes: [result.lanes[0]] })).toBeNull();
  });

  it("keeps a missing head and numbers as safe defaults", () => {
    const parsed = parseSplitSpeakersResult({
      split_id: result.split_id,
      lanes: result.lanes,
    });
    expect(parsed).toMatchObject({
      crosstalk_sec: 0,
      low_confidence_sec: 0,
      review_spans: [],
      history_head_id: null,
    });
  });

  it("drops malformed persisted review spans", () => {
    const parsed = parseSplitSpeakersResult({
      ...result,
      review_spans: [
        ...result.review_spans,
        {
          start_s: 3,
          end_s: 2,
          speakers: ["room"],
          unsure: true,
          overlapping: false,
        },
        {
          start_s: 4,
          end_s: 5,
          speakers: [],
          unsure: true,
          overlapping: false,
        },
        {
          start_s: 5,
          end_s: 6,
          speakers: ["missing-lane"],
          unsure: false,
          overlapping: true,
          timeline_spans: [],
        },
      ],
    });
    expect(parsed?.review_spans).toEqual(result.review_spans);
  });
});

describe("splitSpeakerNames", () => {
  it("sends nothing when no name was typed, so the server numbers them", () => {
    expect(splitSpeakerNames(["", "  "], 3)).toBeNull();
    expect(splitSpeakerNames([], 3)).toBeNull();
  });

  it("fills a blank with Speaker N and trims what was typed", () => {
    expect(splitSpeakerNames([" Ana ", "", "Cy", "Dee"], 3)).toEqual([
      "Ana",
      "Speaker 2",
      "Cy",
    ]);
  });
});

describe("splitSpeakersRequestBlocker", () => {
  it.each([null, 1, 9, 2.5])("asks for 2 to 8 speakers, not %s", (count) => {
    expect(splitSpeakersRequestBlocker(count, null)).toBe(
      "Enter 2 to 8 speakers.",
    );
  });

  it("asks for different names, ignoring case", () => {
    expect(splitSpeakersRequestBlocker(2, ["Ana", "ana"])).toBe(
      "Give each speaker a different name.",
    );
    expect(splitSpeakersRequestBlocker(2, ["Ana", "Ben"])).toBeNull();
    expect(splitSpeakersRequestBlocker(8, null)).toBeNull();
  });
});

describe("split copy", () => {
  it("names the tracks it made", () => {
    expect(splitSpeakersDoneCopy(result, "Room")).toBe(
      "Split Room into 3 tracks: Ana, Ben and Cy.",
    );
  });

  it("says what to listen for, and nothing when there is nothing", () => {
    expect(splitSpeakersListenNotes(result)).toEqual([
      "1:15 where the speaker is unclear. Listen there before relying on the tracks.",
      "12 s where people talk over each other. It plays once, on the track of the speaker heard most.",
    ]);
    expect(
      splitSpeakersListenNotes({
        ...result,
        crosstalk_sec: 0.4,
        low_confidence_sec: 0,
      }),
    ).toEqual([]);
  });
});

describe("voice samples", () => {
  const clip = (over: object) => ({
    id: "c",
    track_id: "room",
    source_start: 4,
    source_end: 64,
    timeline_start: 10,
    timeline_end: 70,
    ...over,
  });
  const projectWith = (...clips: object[]) =>
    ({ clips: { tracks: { room: clips } } }) as unknown as ProjectView;
  const range = (start: number, end: number, tracks = ["room"]): Selection =>
    ({
      kind: "range",
      target: {
        kind: "exact_range",
        intervals: [{ start, end }],
        track_ids: tracks,
        clips: [],
        media_seals: {},
      },
    }) as Selection;

  it("maps the selected timeline range to recording seconds", () => {
    const got = voiceSampleFromSelection(
      projectWith(clip({})),
      range(12, 18),
      "room",
    );
    expect(got.reason).toBeNull();
    expect(got.sample?.sourceStart).toBeCloseTo(6);
    expect(got.sample?.sourceEnd).toBeCloseTo(12);
  });

  it.each([
    [null, "Select a timeline or transcript range"],
    [range(12, 12.5), "Select at least 1 second"],
    [range(12, 18, ["other"]), "Select the range on the track being split"],
    [range(100, 110), "Select audio that is on the track"],
  ])("refuses %# with a reason", (selection, reason) => {
    const got = voiceSampleFromSelection(
      projectWith(clip({})),
      selection,
      "room",
    );
    expect(got.sample).toBeNull();
    expect(got.reason).toContain(reason);
  });

  it("refuses a range across a gap that keeps the same offset", () => {
    const got = voiceSampleFromSelection(
      projectWith(
        clip({
          timeline_start: 0,
          timeline_end: 10,
          source_start: 0,
          source_end: 10,
        }),
        clip({
          id: "d",
          timeline_start: 15,
          timeline_end: 30,
          source_start: 15,
          source_end: 30,
        }),
      ),
      range(8, 17),
      "room",
    );
    expect(got.reason).toBe(
      "The range crosses a cut. Select within one stretch.",
    );
  });

  it("accepts a range that ends on the clip edge", () => {
    const got = voiceSampleFromSelection(
      projectWith(clip({})),
      range(60, 70),
      "room",
    );
    expect(got.reason).toBeNull();
    expect(got.sample?.sourceEnd).toBeCloseTo(64);
  });

  it("refuses a range that spans other tracks too", () => {
    const got = voiceSampleFromSelection(
      projectWith(clip({})),
      range(12, 18, ["room", "other"]),
      "room",
    );
    expect(got.sample).toBeNull();
  });

  it("refuses a range that crosses a cut", () => {
    const got = voiceSampleFromSelection(
      projectWith(
        clip({ timeline_end: 15, source_end: 9 }),
        clip({
          id: "d",
          timeline_start: 15,
          timeline_end: 70,
          source_start: 30,
        }),
      ),
      range(12, 18),
      "room",
    );
    expect(got.reason).toBe(
      "The range crosses a cut. Select within one stretch.",
    );
  });

  it("builds the enrollment for the speakers that have a sample", () => {
    const sample = { sourceStart: 6, sourceEnd: 12 } as never;
    expect(splitSpeakersEnrollment(["Ana", "Ben"], [null, sample])).toEqual({
      Ben: [[6, 12]],
    });
    expect(splitSpeakersEnrollment(["Ana", "Ben"], [])).toBeNull();
    expect(splitSpeakersEnrollment(null, [sample])).toBeNull();
  });

  it("asks for names when a sample needs one", () => {
    expect(splitSpeakerNames([], 2, true)).toEqual(["Speaker 1", "Speaker 2"]);
  });
});
