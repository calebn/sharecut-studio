import { describe, expect, it } from "vitest";
import type { CoverProps } from "../system/Cover";
import type { RoomPhase } from "../system/roomPhase";
import { guestCovers } from "./guestRoomModel";
import { guestTabTitle } from "./guestTabTitle";

const downloadedCover = guestCovers({
  bootError: null,
  error: null,
  accessEnded: true,
  inviteClosed: false,
  left: false,
  stake: "unsent",
  keeperActions: {
    busy: false,
    error: null,
    notice: null,
    downloaded: true,
  },
});

const cover = (title: string): CoverProps => ({
  size: "page",
  glyph: "door-open",
  title,
  children: "Text.",
});

const room = {
  cover: null,
  bootstrapped: true,
  seat: "guest" as const,
  stance: "in" as const,
  phase: { kind: "waiting" } as RoomPhase,
  episode: "Shot of Truth",
};

describe("guestTabTitle", () => {
  it.each([
    [
      "loading",
      { bootstrapped: false, episode: "" },
      "Joining the room | ShareCut Studio",
    ],
    [
      "network cover before bootstrap",
      {
        cover: cover("Couldn't reach the room"),
        bootstrapped: false,
        episode: "",
      },
      "Couldn't reach the room | ShareCut Studio",
    ],
    [
      "room-full cover",
      { cover: cover("The room is full") },
      "The room is full | Shot of Truth",
    ],
    [
      "downloaded cover",
      { cover: downloadedCover },
      "Check your downloads | Shot of Truth",
    ],
    [
      "guest joining",
      { stance: "joining" as const },
      "Join the room | Shot of Truth",
    ],
    [
      "producer joining",
      { seat: "producer" as const, stance: "joining" as const },
      "Join to listen | Shot of Truth",
    ],
    [
      "producer declined",
      { seat: "producer" as const, stance: "declined" as const },
      "Join to listen | Shot of Truth",
    ],
    [
      "guest declined",
      { stance: "declined" as const },
      "Not being recorded | Shot of Truth",
    ],
    ["waiting", {}, "Waiting | Shot of Truth"],
    [
      "countdown",
      { phase: { kind: "countdown", secondsLeft: 30 } as RoomPhase },
      "Stay quiet | Shot of Truth",
    ],
    [
      "live",
      { phase: { kind: "live", clockSec: 12, take: 1 } as RoomPhase },
      "Recording | Shot of Truth",
    ],
    [
      "paused",
      { phase: { kind: "paused", clockSec: 12 } as RoomPhase },
      "Paused | Shot of Truth",
    ],
    [
      "saving",
      {
        phase: { kind: "saving", savedPeople: 1, totalPeople: 2 } as RoomPhase,
      },
      "Saving to project… | Shot of Truth",
    ],
    [
      "saving failed",
      {
        phase: {
          kind: "saving",
          savedPeople: 1,
          totalPeople: 2,
          failed: true,
        } as RoomPhase,
      },
      "Saving stopped | Shot of Truth",
    ],
    [
      "saved",
      { phase: { kind: "saved" } as RoomPhase },
      "Saved to project | Shot of Truth",
    ],
    [
      "reconnecting",
      { phase: { kind: "reconnecting" } as RoomPhase },
      "Reconnecting… | Shot of Truth",
    ],
    ["blank episode", { episode: "  " }, "Waiting | ShareCut Studio"],
  ])("names the tab for every state (%s)", (_name, over, expected) => {
    expect(guestTabTitle({ ...room, ...over })).toBe(expected);
  });
});
