import { describe, expect, it } from "vitest";
import { recordParticipant, recordSnapshot } from "../test/fixtures";
import { TAKE_REASON } from "./deviceSheet";
import {
  endGate,
  landGate,
  moreRoomToneReason,
  roomToneRoundLeftMs,
  startBlockerItems,
} from "./hostControls";

const ready = {
  storageReady: true,
  storageError: null,
  capturingRoomTone: false,
};

const segment = (fields: {
  file_ack?: boolean;
  landed?: boolean;
  land_failed?: boolean;
}) => ({
  take_index: 0,
  participant_id: "p_g",
  segment_index: 0,
  acked_parts: [0],
  ...fields,
});

describe("startBlockerItems", () => {
  it("has no room blocker when only the host is in the room", () => {
    const snap = recordSnapshot({ start_blockers: [] });
    expect(startBlockerItems(snap, ready)).toEqual([]);
  });

  it("says the room is still being joined before anyone is in it", () => {
    const snap = recordSnapshot({ start_blockers: [{ code: "no_recorder" }] });
    expect(startBlockerItems(snap, ready)).toEqual([
      { key: "no_recorder", text: "Joining the room." },
    ]);
  });

  it("adds this device's storage and room-tone readiness after the room", () => {
    const snap = recordSnapshot({
      start_blockers: [
        { code: "consent_pending", participant_id: "p_g", display_name: "Ava" },
      ],
    });
    expect(
      startBlockerItems(snap, {
        storageReady: false,
        storageError: "Storage is blocked.",
        capturingRoomTone: true,
      }).map((item) => item.text),
    ).toEqual([
      "Waiting for Ava to accept recording.",
      "Storage is blocked.",
      "Recording room tone. Start is available when it finishes.",
    ]);
    expect(
      startBlockerItems(recordSnapshot({ start_blockers: [] }), ready),
    ).toEqual([]);
  });
});

describe("startBlockerItems with the host mic off", () => {
  const off = { ...ready, storageReady: false, hostMicOff: true };
  const host = recordParticipant({
    participant_id: "p_host",
    role: "host",
    consented: false,
  });

  it("ignores this device's storage and room tone, and waits for a guest who has accepted", () => {
    const snap = recordSnapshot({ start_blockers: [], participants: [host] });
    expect(
      startBlockerItems(snap, { ...off, capturingRoomTone: true }),
    ).toEqual([
      {
        key: "nobody_recording",
        text: "Your mic is off. Start is available when a guest has accepted.",
      },
    ]);
  });

  it("has no blocker once a guest has accepted", () => {
    const snap = recordSnapshot({
      start_blockers: [],
      participants: [host, recordParticipant()],
    });
    expect(startBlockerItems(snap, off)).toEqual([]);
  });

  it("keeps the server's own blockers and does not add a second one", () => {
    const snap = recordSnapshot({
      start_blockers: [
        { code: "consent_pending", participant_id: "p_g", display_name: "Ava" },
      ],
      participants: [host, recordParticipant({ consented: null })],
    });
    expect(startBlockerItems(snap, off).map((item) => item.key)).toEqual([
      "consent:p_g",
    ]);
  });
});

describe("landGate", () => {
  it("refuses before the first take and while a take is open", () => {
    expect(landGate(recordSnapshot({ take_index: -1 }))).toEqual({
      enabled: false,
      reason: "Record a take first.",
    });
    expect(
      landGate(recordSnapshot({ state: "paused", take_index: 1 })),
    ).toEqual({
      enabled: false,
      reason: "Stop the take to land it on the timeline.",
    });
  });

  it("leaves the rest to the server once a take has stopped", () => {
    expect(
      landGate(recordSnapshot({ state: "stopped", take_index: 0 })),
    ).toEqual({ enabled: true });
  });
});

describe("endGate", () => {
  const stopped = recordSnapshot({ state: "stopped", take_index: 0 });

  it("allows ending a room with nothing recorded", () => {
    expect(
      endGate(recordSnapshot({ state: "lobby", take_index: -1 }), []),
    ).toEqual({
      enabled: true,
    });
  });

  it("waits for a running take", () => {
    expect(
      endGate(recordSnapshot({ state: "recording", take_index: 0 }), []),
    ).toEqual({ enabled: false, reason: "Stop the take first." });
  });

  it("blocks while any recording is unsaved or not on the timeline", () => {
    for (const segments of [
      null,
      [segment({ file_ack: false })],
      [segment({ file_ack: true, landed: false })],
      [
        segment({ file_ack: true, landed: true }),
        { ...segment({ file_ack: true, landed: false }), segment_index: 1 },
      ],
    ]) {
      expect(endGate(stopped, segments).enabled).toBe(false);
    }
  });

  it("blocks while no recording has reached the project yet", () => {
    expect(endGate(stopped, []).enabled).toBe(false);
  });

  it("blocks while live notes are waiting to land", () => {
    const withNote = recordSnapshot({
      state: "stopped",
      take_index: 0,
      comments: [{ id: "c1" } as never],
    });
    const gate = endGate(withNote, [segment({ file_ack: true, landed: true })]);
    expect(gate.enabled).toBe(false);
  });

  it("allows ending once every take has landed", () => {
    expect(
      endGate(stopped, [segment({ file_ack: true, landed: true })]),
    ).toEqual({ enabled: true });
  });
});

describe("moreRoomToneReason", () => {
  const open = {
    state: "lobby" as const,
    noRecorder: false,
    roundLeftMs: 0,
    hostCapturing: false,
  };

  it("lets a room in the lobby or stopped start a round", () => {
    expect(moreRoomToneReason(open)).toBeUndefined();
    expect(moreRoomToneReason({ ...open, state: "stopped" })).toBeUndefined();
  });

  it("holds a running or paused take first", () => {
    const all = { noRecorder: true, roundLeftMs: 5, hostCapturing: true };
    expect(moreRoomToneReason({ ...open, ...all, state: "recording" })).toBe(
      TAKE_REASON,
    );
    expect(moreRoomToneReason({ ...open, ...all, state: "paused" })).toBe(
      TAKE_REASON,
    );
  });

  it("names the first of the remaining reasons", () => {
    const rest = { noRecorder: true, roundLeftMs: 5, hostCapturing: true };
    expect(moreRoomToneReason({ ...open, ...rest })).toBe(
      "Room tone starts once someone has joined the room.",
    );
    expect(moreRoomToneReason({ ...open, ...rest, noRecorder: false })).toBe(
      "Room tone is already recording.",
    );
    expect(moreRoomToneReason({ ...open, hostCapturing: true })).toBe(
      "Your own room tone is recording.",
    );
  });
});

describe("roomToneRoundLeftMs", () => {
  it("counts the round down from the snapshot and stops at zero", () => {
    const snap = recordSnapshot({
      room_tone: {
        round: 1,
        requested_wall_ms: 1000,
        duration_ms: 60_000,
        participant_ids: ["p_g"],
      },
      countdown_left_ms: 4000,
    });
    expect(roomToneRoundLeftMs(snap, 1500)).toBe(2500);
    expect(roomToneRoundLeftMs(snap, 9000)).toBe(0);
  });

  it("is zero with no round, whatever the countdown field holds", () => {
    const snap = recordSnapshot({ room_tone: null, countdown_left_ms: 4000 });
    expect(roomToneRoundLeftMs(snap, 0)).toBe(0);
  });
});
