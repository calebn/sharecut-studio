import { describe, expect, it, vi } from "vitest";
import {
  MIC_CHECK_FAILED_COPY,
  ROOM_ALERT_PRIORITY,
  ROOM_ALERT_TEXT,
  type RoomAlertKind,
  roomAlertAction,
  roomAlertSecondary,
  roomAlertTitle,
  sortRoomAlerts,
} from "./roomAlertModel";

describe("ROOM_ALERT_PRIORITY", () => {
  it("orders the kinds from mic lost to the generic room error", () => {
    expect([...ROOM_ALERT_PRIORITY]).toEqual([
      "mic-lost",
      "no-audio",
      "storage-failed",
      "saving-failed",
      "notice",
      "recovery",
      "host-offline",
      "monitor-failed",
      "room-tone",
      "clipping",
      "muted",
      "connecting",
      "generic",
    ]);
  });

  it("has text for every kind", () => {
    for (const kind of ROOM_ALERT_PRIORITY) {
      expect(ROOM_ALERT_TEXT[kind].title).not.toBe("");
    }
  });

  it("keeps the one action the slot allows, never two", () => {
    expect(ROOM_ALERT_TEXT["saving-failed"].action).toBe("Resume saving");
    for (const kind of ROOM_ALERT_PRIORITY) {
      expect(ROOM_ALERT_TEXT[kind].action ?? "").not.toMatch(/save a copy/i);
    }
  });
});

describe("roomAlertTitle", () => {
  it("adds what to try when the last mic check failed", () => {
    expect(roomAlertTitle({ kind: "no-audio" })).toBe(
      "No sound is reaching the recorder.",
    );
    expect(roomAlertTitle({ kind: "no-audio", checkFailed: true })).toBe(
      `No sound is reaching the recorder. ${MIC_CHECK_FAILED_COPY}`,
    );
    expect(roomAlertTitle({ kind: "mic-lost", checkFailed: true })).toBe(
      "Your mic stopped.",
    );
  });

  it("asks for room tone, or prints the sentence it is given", () => {
    expect(roomAlertTitle({ kind: "room-tone" })).toBe(
      "Record 3 seconds of room tone.",
    );
    expect(roomAlertTitle({ kind: "room-tone", message: "Too loud." })).toBe(
      "Too loud.",
    );
    expect(
      roomAlertAction({ kind: "room-tone", onAction: vi.fn() })?.label,
    ).toBe("Record room tone");
  });

  it("prints a notice's own sentence", () => {
    expect(roomAlertTitle({ kind: "notice", message: "Recovered it." })).toBe(
      "Recovered it.",
    );
  });

  it("names the host, and says The host when no name is given", () => {
    expect(roomAlertTitle({ kind: "host-offline", name: "Rosa" })).toBe(
      "Rosa dropped. You're still recording on this device.",
    );
    expect(roomAlertTitle({ kind: "host-offline" })).toBe(
      "The host dropped. You're still recording on this device.",
    );
    expect(roomAlertTitle({ kind: "host-offline", name: "   " })).toBe(
      "The host dropped. You're still recording on this device.",
    );
  });

  it("keeps a $& or $1 in a host name literal", () => {
    expect(roomAlertTitle({ kind: "host-offline", name: "Rosa $& $1" })).toBe(
      "Rosa $& $1 dropped. You're still recording on this device.",
    );
  });

  it("takes the generic message, with the default sentence as fallback", () => {
    expect(
      roomAlertTitle({ kind: "generic", message: "The room closed." }),
    ).toBe("The room closed.");
    expect(roomAlertTitle({ kind: "generic", message: "  " })).toBe(
      "Something went wrong in the room.",
    );
    expect(roomAlertTitle({ kind: "generic" })).toBe(
      "Something went wrong in the room.",
    );
  });

  it("prints the fixed sentence for the other kinds", () => {
    expect(roomAlertTitle({ kind: "mic-lost", name: "Rosa" })).toBe(
      "Your mic stopped.",
    );
  });
});

describe("roomAlertAction", () => {
  it("offers the kind's action only when a handler is supplied", () => {
    const onAction = vi.fn();
    expect(roomAlertAction({ kind: "mic-lost", onAction })).toEqual({
      label: "Reconnect mic",
      onAction,
    });
    expect(roomAlertAction({ kind: "mic-lost" })).toBeUndefined();
  });

  it("has no action for the kinds that only inform", () => {
    const onAction = vi.fn();
    for (const kind of ["host-offline", "clipping", "muted"] as const) {
      expect(roomAlertAction({ kind, onAction })).toBeUndefined();
    }
  });
});

describe("roomAlertSecondary", () => {
  it("offers Save a copy for saving-failed only with a handler", () => {
    const onSecondaryAction = vi.fn();
    expect(
      roomAlertSecondary({ kind: "saving-failed", onSecondaryAction }),
    ).toEqual({ label: "Save a copy", onAction: onSecondaryAction });
    expect(roomAlertSecondary({ kind: "saving-failed" })).toBeUndefined();
  });

  it("offers Skip for room-tone only with a handler", () => {
    const onSecondaryAction = vi.fn();
    expect(
      roomAlertSecondary({ kind: "room-tone", onSecondaryAction }),
    ).toEqual({ label: "Skip", onAction: onSecondaryAction });
    expect(roomAlertSecondary({ kind: "room-tone" })).toBeUndefined();
  });

  it("has none for the other kinds", () => {
    const onSecondaryAction = vi.fn();
    for (const kind of ROOM_ALERT_PRIORITY.filter(
      (kind) => kind !== "saving-failed" && kind !== "room-tone",
    )) {
      expect(roomAlertSecondary({ kind, onSecondaryAction })).toBeUndefined();
    }
  });
});

describe("sortRoomAlerts", () => {
  it("returns no top and no rest for an empty list", () => {
    expect(sortRoomAlerts([])).toEqual({ top: null, rest: [] });
  });

  it("puts the most urgent alert on top and orders the rest", () => {
    const { top, rest } = sortRoomAlerts([
      { kind: "generic" as RoomAlertKind },
      { kind: "clipping" as RoomAlertKind },
      { kind: "no-audio" as RoomAlertKind },
      { kind: "mic-lost" as RoomAlertKind },
    ]);
    expect(top?.kind).toBe("mic-lost");
    expect(rest.map((alert) => alert.kind)).toEqual([
      "no-audio",
      "clipping",
      "generic",
    ]);
  });

  it("keeps the first alert of each kind", () => {
    const first = { kind: "muted" as const, name: "first" };
    const second = { kind: "muted" as const, name: "second" };
    const { top, rest } = sortRoomAlerts([first, second]);
    expect(top).toBe(first);
    expect(rest).toEqual([]);
  });

  it("drops unknown kinds instead of guessing a priority", () => {
    const { top, rest } = sortRoomAlerts([
      { kind: "launch-missiles" },
      { kind: "muted" },
    ]);
    expect(top).toEqual({ kind: "muted" });
    expect(rest).toEqual([]);
    expect(sortRoomAlerts([{ kind: "nope" }])).toEqual({
      top: null,
      rest: [],
    });
  });

  it("keeps the extra fields of the alerts it returns", () => {
    const onAction = vi.fn();
    const { top } = sortRoomAlerts([
      { kind: "host-offline" as RoomAlertKind, name: "Rosa", onAction },
    ]);
    expect(top?.name).toBe("Rosa");
    expect(top?.onAction).toBe(onAction);
  });
});
