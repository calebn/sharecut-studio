import { describe, expect, it } from "vitest";
import type { HistoryEntryId } from "../types/project";
import {
  parseSplitSpeakersResult,
  splitSpeakerNames,
  splitSpeakersBlocker,
  splitSpeakersDoneCopy,
  splitSpeakersListenNotes,
  splitSpeakersRequestBlocker,
} from "./speakerSplit";

const result = {
  lanes: [
    { track_id: "room", name: "Ana", muted_sec: 30 },
    { track_id: "room_ben", name: "Ben", muted_sec: 60 },
    { track_id: "room_cy", name: "Cy", muted_sec: 70 },
  ],
  crosstalk_sec: 12.4,
  low_confidence_sec: 75,
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
    const parsed = parseSplitSpeakersResult({ lanes: result.lanes });
    expect(parsed).toMatchObject({
      crosstalk_sec: 0,
      low_confidence_sec: 0,
      history_head_id: null,
    });
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
