import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordParticipant, recordSnapshot } from "../test/fixtures";
import {
  lateRoomToneDue,
  readRoomToneMark,
  roomToneMarkKey,
  writeRoomToneMark,
} from "./lateRoomTone";

const round = (ids: string[]) => ({
  round: 1,
  requested_wall_ms: 1000,
  duration_ms: 3000,
  participant_ids: ids,
});
const late = recordParticipant({ participant_id: "p_late" });
const lobby = (ids: string[] = ["p_early"]) =>
  recordSnapshot({
    state: "lobby",
    room_tone: round(ids),
    participants: [late],
  });

describe("lateRoomToneDue", () => {
  it("asks a consented guest the countdown did not name", () => {
    expect(lateRoomToneDue(lobby(), late)).toBe(true);
    expect(
      lateRoomToneDue({ ...lobby(), state: "stopped", take_index: 0 }, late),
    ).toBe(true);
  });

  it("skips a guest who was present for the countdown", () => {
    expect(lateRoomToneDue(lobby(["p_early", "p_late"]), late)).toBe(false);
  });

  it.each(["recording", "paused"] as const)(
    "waits for Stop while a take is %s",
    (state) => {
      expect(lateRoomToneDue({ ...lobby(), state }, late)).toBe(false);
    },
  );

  it("asks nobody before the host has started any countdown", () => {
    expect(lateRoomToneDue({ ...lobby(), room_tone: null }, late)).toBe(false);
    expect(lateRoomToneDue({ ...lobby(), room_tone: undefined }, late)).toBe(
      false,
    );
  });

  it.each([
    ["not yet consented", recordParticipant({ consented: null })],
    ["declined", recordParticipant({ consented: false })],
    ["missing", undefined],
  ])("skips a guest who is %s", (_name, me) => {
    expect(lateRoomToneDue(lobby(), me)).toBe(false);
  });

  it("skips without a snapshot", () => {
    expect(lateRoomToneDue(null, late)).toBe(false);
  });
});

describe("room tone marks", () => {
  beforeEach(() => localStorage.clear());

  it("keys a mark by session and guest", () => {
    expect(roomToneMarkKey("s1", "p1")).toBe("sharecut.room-tone.s1.p1");
    expect(roomToneMarkKey(null, "p1")).toBeNull();
    expect(roomToneMarkKey("s1", undefined)).toBeNull();
  });

  it("reads back what was written, and nothing else", () => {
    const key = "sharecut.room-tone.s1.p1";
    expect(readRoomToneMark(key)).toBeNull();
    writeRoomToneMark(key, "skipped");
    expect(readRoomToneMark(key)).toBe("skipped");
    writeRoomToneMark(key, "recorded");
    expect(readRoomToneMark(key)).toBe("recorded");
    localStorage.setItem(key, "garbage");
    expect(readRoomToneMark(key)).toBeNull();
  });

  it("works without a store", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => writeRoomToneMark("k", "skipped")).not.toThrow();
    expect(readRoomToneMark("k")).toBeNull();
    vi.restoreAllMocks();
  });
});
