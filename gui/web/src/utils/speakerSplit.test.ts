import { describe, expect, it } from "vitest";
import type {
  ExactRangeTarget,
  HistoryEntryId,
  ProjectView,
} from "../types/project";
import {
  parseSplitSpeakersResult,
  siblingSplitLanes,
  speakerLaneMoveTarget,
  splitSpeakersBlocker,
  splitSpeakersDoneCopy,
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

describe("split copy", () => {
  it("names the tracks it made", () => {
    expect(splitSpeakersDoneCopy(result, "Room")).toBe(
      "Split Room into 3 tracks: Ana, Ben and Cy.",
    );
  });
});
