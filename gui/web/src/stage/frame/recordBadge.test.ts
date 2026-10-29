import { describe, expect, it } from "vitest";
import type { HostRoom, RecordSnapshot } from "../../record";
import { recordBadge } from "./recordBadge";

const guest = (id: string, extra: object = {}) => ({
  participant_id: id,
  role: "guest" as const,
  display_name: id,
  connected: true,
  consented: null,
  muted: false,
  headphones_ack: false,
  ...extra,
});

function roomOf(
  snapshot: Partial<RecordSnapshot> | null,
  overrides: Record<string, unknown> = {},
): HostRoom {
  const full = snapshot && {
    session_id: "s1",
    state: "lobby",
    take_index: -1,
    participants: [],
    caps: { recorded: 0, producers: 0 },
    ...snapshot,
  };
  return {
    snapshot: full,
    state: full?.state,
    capture: {},
    host: undefined,
    sinkError: null,
    upload: { error: null, recoverable: false },
    transportError: null,
    hydrateError: null,
    takeClipping: null,
    hostSegments: [],
    ...overrides,
  } as unknown as HostRoom;
}

const source = { captureHealth: null, receivedAtMs: 40, away: true } as const;

describe("recordBadge", () => {
  it("is idle with no room or nobody waiting", () => {
    expect(recordBadge(roomOf(null), source)).toEqual({ kind: "idle" });
    expect(recordBadge(roomOf({}), source)).toEqual({ kind: "idle" });
  });

  it("counts the guests connected and not turned away in the lobby", () => {
    const room = roomOf({
      participants: [
        guest("a"),
        guest("b", { consented: true }),
        guest("gone", { connected: false }),
        guest("no", { consented: false }),
        guest("out", { removed: true }),
        guest("p_host", { role: "host" }),
      ],
    });
    expect(recordBadge(room, source)).toEqual({ kind: "waiting", count: 2 });
  });

  it("carries the snapshot's clock and arrival time while recording", () => {
    const room = roomOf({ state: "recording", recording_ms: 724000 });
    expect(recordBadge(room, source)).toEqual({
      kind: "live",
      clockMs: 724000,
      receivedAtMs: 40,
      alert: false,
    });
  });

  it("is paused while paused", () => {
    expect(recordBadge(roomOf({ state: "paused" }), source)).toEqual({
      kind: "paused",
      alert: false,
    });
  });

  it("fills the saving ring by the people saved", () => {
    const room = roomOf(
      {
        state: "stopped",
        take_index: 0,
        takes: [
          {
            take_index: 0,
            consented_participant_ids: ["p_host", "a"],
          },
        ],
      } as Partial<RecordSnapshot>,
      {
        hostSegments: [
          { take_index: 0, participant_id: "p_host", file_ack: true },
          { take_index: 0, participant_id: "a", file_ack: false },
        ],
      },
    );
    expect(recordBadge(room, source)).toEqual({
      kind: "saving",
      progress: 0.5,
      alert: false,
    });
  });

  it("adds the alert dot to a live take and stands alone otherwise", () => {
    const failing = { sinkError: "Storage full" };
    expect(
      recordBadge(roomOf({ state: "recording" }, failing), source),
    ).toMatchObject({ kind: "live", alert: true });
    expect(
      recordBadge(roomOf({ state: "paused" }, failing), source),
    ).toMatchObject({ kind: "paused", alert: true });
    expect(
      recordBadge(roomOf({ participants: [guest("a")] }, failing), source),
    ).toEqual({ kind: "alert" });
  });

  it("leaves alerts to the Record stage while on it", () => {
    const room = roomOf({ state: "recording" }, { sinkError: "Storage full" });
    expect(recordBadge(room, { ...source, away: false })).toMatchObject({
      kind: "live",
      alert: false,
    });
  });
});
