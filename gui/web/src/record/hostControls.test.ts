import { describe, expect, it } from "vitest";
import { recordSnapshot } from "../test/fixtures";
import { landGate, startBlockerItems } from "./hostControls";

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
  it("words server blockers and offers the guest-link fix", () => {
    const snap = recordSnapshot({
      start_blockers: [{ code: "no_guest" }],
    });
    expect(startBlockerItems(snap, ready)).toEqual([
      {
        key: "no_guest",
        text: "No guest has joined yet. Send them the guest link.",
        fix: "copyGuestLink",
      },
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
      }).map((item) => [item.text, item.fix ?? null]),
    ).toEqual([
      ["Waiting for Ava to accept recording.", null],
      ["Storage is blocked.", "retryStorage"],
      ["Recording room tone. Start is available when it finishes.", null],
    ]);
    expect(
      startBlockerItems(recordSnapshot({ start_blockers: [] }), ready),
    ).toEqual([]);
  });
});

describe("landGate", () => {
  const stopped = recordSnapshot({ state: "stopped", take_index: 0 });

  it("refuses before the first take and while a take is open", () => {
    expect(landGate(recordSnapshot({ take_index: -1 }), [])).toEqual({
      enabled: false,
      label: "Land",
      reason: "Record a take first.",
    });
    expect(
      landGate(recordSnapshot({ state: "paused", take_index: 1 }), null),
    ).toEqual({
      enabled: false,
      label: "Land",
      reason: "Stop the take to land it on the timeline.",
    });
  });

  it("lands an acknowledged recording and retries a failed land", () => {
    expect(landGate(stopped, [segment({ file_ack: true })])).toEqual({
      enabled: true,
      label: "Land",
    });
    expect(
      landGate(stopped, [
        segment({ file_ack: true, landed: false, land_failed: true }),
      ]),
    ).toEqual({ enabled: true, label: "Retry land" });
  });

  it("lands live comments even when every recording already landed", () => {
    const withComment = recordSnapshot({
      state: "stopped",
      take_index: 0,
      comments: [
        {
          id: "c1",
          take_index: 0,
          recording_ms: 10,
          pressed_wall_ms: 10,
          author: "p_host",
          body: "Marker",
        },
      ],
    });
    expect(
      landGate(withComment, [segment({ file_ack: true, landed: true })]),
    ).toEqual({ enabled: true, label: "Land" });
  });

  it("explains why there is nothing to land yet", () => {
    expect(landGate(stopped, [segment({ file_ack: false })])).toEqual({
      enabled: false,
      label: "Land",
      reason: "Recordings are still saving to the project.",
    });
    expect(landGate(stopped, [])).toEqual({
      enabled: false,
      label: "Land",
      reason: "No recordings have reached the project yet.",
    });
    expect(
      landGate(stopped, [segment({ file_ack: true, landed: true })]),
    ).toEqual({
      enabled: false,
      label: "Land",
      reason: "Every take is on the timeline.",
    });
  });

  it("leaves an unread upload status to the server", () => {
    expect(landGate(stopped, null)).toEqual({ enabled: true, label: "Land" });
  });
});
