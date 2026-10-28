import { describe, expect, it, vi } from "vitest";
import { recordParticipant, recordSnapshot } from "../test/fixtures";
import { hostRoomPhase, takeSaveCounts } from "./hostRoomPhase";
import { noteItems } from "./noteItems";
import { roomAlerts } from "./roomAlerts";
import { roomPeople } from "./roomPeople";
import type { SegmentAckRow } from "./saveStatus";
import { takeInputs } from "./takeInputs";

const host = recordParticipant({
  participant_id: "p_host",
  role: "host",
  display_name: "Hana",
});
const guest = recordParticipant({ participant_id: "p_g", display_name: "Bo" });

const row = (over: Partial<SegmentAckRow> = {}): SegmentAckRow => ({
  participant_id: "p_g",
  acked_parts: [],
  take_index: 0,
  segment_index: 0,
  file_ack: true,
  ...over,
});

describe("roomPeople", () => {
  it("is empty without a snapshot", () => {
    expect(roomPeople(null)).toEqual([]);
  });

  it("marks the host as you and carries their meter", () => {
    const people = roomPeople(recordSnapshot({ participants: [host, guest] }), {
      youLevel: 0.4,
      youSpeaking: true,
      clipped: 2,
    });
    expect(people[0]).toMatchObject({
      role: "host",
      you: true,
      presence: "live",
      level: 0.4,
      speaking: true,
      clipped: 2,
      connection: "good",
    });
    expect(people[1]).toMatchObject({
      presence: "live",
      person: { name: "Bo", colorIndex: 1 },
    });
  });

  it("reads presence from consent and connection and skips removed people", () => {
    const people = roomPeople(
      recordSnapshot({
        participants: [
          host,
          recordParticipant({
            participant_id: "a",
            display_name: "A",
            consented: null,
          }),
          recordParticipant({
            participant_id: "b",
            display_name: "B",
            consented: false,
          }),
          recordParticipant({
            participant_id: "c",
            display_name: "C",
            connected: false,
          }),
          recordParticipant({
            participant_id: "d",
            display_name: "D",
            removed: true,
          }),
        ],
      }),
      { dropped: true },
    );
    expect(people.map((p) => p.presence)).toEqual([
      "live",
      "joining",
      "declined",
      "left",
    ]);
    expect(people[0]?.connection).toBe("lost");
  });

  it("passes saving progress by participant", () => {
    const people = roomPeople(recordSnapshot({ participants: [host, guest] }), {
      saving: { p_g: { done: 1, total: 2 } },
    });
    expect(people[1]?.saving).toEqual({ done: 1, total: 2 });
    expect(people[0]?.saving).toBeNull();
  });
});

describe("hostRoomPhase", () => {
  it("waits in an empty lobby", () => {
    expect(hostRoomPhase(null)).toEqual({ kind: "waiting" });
    expect(hostRoomPhase(recordSnapshot({ state: "lobby" }))).toEqual({
      kind: "waiting",
    });
  });

  it("counts down room tone", () => {
    const snap = recordSnapshot({
      state: "lobby",
      room_tone: {
        round: 1,
        requested_wall_ms: 0,
        duration_ms: 3000,
        participant_ids: [],
      },
      countdown_left_ms: 1200,
    });
    expect(hostRoomPhase(snap)).toEqual({ kind: "countdown", secondsLeft: 2 });
    expect(hostRoomPhase(snap, { elapsedSinceSnapshotMs: 300 })).toEqual({
      kind: "countdown",
      secondsLeft: 1,
    });
    expect(hostRoomPhase(snap, { elapsedSinceSnapshotMs: 1200 })).toEqual({
      kind: "waiting",
    });
  });

  it("ticks the clock while recording and holds it while paused", () => {
    const live = recordSnapshot({
      state: "recording",
      take_index: 1,
      recording_ms: 10_000,
    });
    expect(hostRoomPhase(live, { elapsedSinceSnapshotMs: 2500 })).toEqual({
      kind: "live",
      take: 2,
      clockSec: 12.5,
    });
    expect(
      hostRoomPhase(
        { ...live, state: "paused" },
        { elapsedSinceSnapshotMs: 9 },
      ),
    ).toEqual({ kind: "paused", clockSec: 10 });
  });

  it("reconnects only while on air", () => {
    expect(
      hostRoomPhase(recordSnapshot({ state: "recording" }), { dropped: true }),
    ).toEqual({ kind: "reconnecting" });
    expect(
      hostRoomPhase(recordSnapshot({ state: "lobby" }), { dropped: true }),
    ).toEqual({ kind: "waiting" });
  });

  it("waits after stop when there are no takes", () => {
    expect(
      hostRoomPhase(recordSnapshot({ state: "stopped", take_index: 0 })),
    ).toEqual({ kind: "waiting" });
  });

  it("saves, then saved, after stop", () => {
    const snap = recordSnapshot({
      state: "stopped",
      participants: [host, guest],
      takes: [
        {
          take_index: 0,
          session_start_wall_ms: 0,
          session_start_iso: "t",
          pauses: [],
          consented_participant_ids: ["p_host", "p_g"],
        },
      ],
    });
    const segments = [
      row({ participant_id: "p_host" }),
      row({ file_ack: false }),
    ];
    expect(takeSaveCounts(snap, segments)).toEqual({ saved: 1, total: 2 });
    expect(hostRoomPhase(snap, { segments })).toEqual({
      kind: "saving",
      savedPeople: 1,
      totalPeople: 2,
    });
    expect(
      hostRoomPhase(snap, {
        segments: [row({ participant_id: "p_host" }), row()],
      }),
    ).toEqual({ kind: "saved" });
  });
});

describe("roomAlerts", () => {
  const quiet = {
    state: "recording" as const,
    captureHealth: null,
    keeperError: null,
    micLost: false,
    sinkError: null,
    uploadError: null,
    recoverable: false,
    monitorError: null,
    transportError: null,
    hydrateError: null,
    clipped: 0,
    muted: false,
  };

  it("is empty when nothing is wrong", () => {
    expect(roomAlerts(quiet)).toEqual([]);
  });

  it("reports mic loss and suppresses no audio under it", () => {
    const retryMic = vi.fn();
    const alerts = roomAlerts(
      { ...quiet, micLost: true, captureHealth: "silent" },
      { retryMic },
    );
    expect(alerts).toEqual([{ kind: "mic-lost", onAction: retryMic }]);
  });

  it("reports no audio only while recording", () => {
    expect(
      roomAlerts({ ...quiet, captureHealth: "silent" }).map((a) => a.kind),
    ).toEqual(["no-audio"]);
    expect(
      roomAlerts({ ...quiet, state: "paused", captureHealth: "silent" }),
    ).toEqual([]);
  });

  it("maps storage, upload, recovery, monitor, clipping, muted and generic", () => {
    const kinds = roomAlerts(
      {
        ...quiet,
        sinkError: "disk",
        uploadError: "stalled",
        recoverable: true,
        monitorError: "m",
        clipped: 3,
        muted: true,
        transportError: "nope",
      },
      { recover: () => undefined },
    );
    expect(kinds.map((a) => a.kind)).toEqual([
      "storage-failed",
      "saving-failed",
      "recovery",
      "monitor-failed",
      "clipping",
      "muted",
      "generic",
    ]);
    expect(kinds.at(-1)).toMatchObject({ message: "nope" });
  });

  it("prefers the sink error action and falls back to the keeper retry", () => {
    const retryStorage = vi.fn();
    const retryKeeper = vi.fn();
    expect(
      roomAlerts(
        { ...quiet, sinkError: "x", keeperError: "y" },
        {
          retryStorage,
          retryKeeper,
        },
      )[0]?.onAction,
    ).toBe(retryStorage);
    expect(
      roomAlerts(
        { ...quiet, keeperError: "y" },
        { retryStorage, retryKeeper },
      )[0]?.onAction,
    ).toBe(retryKeeper);
  });
});

describe("takeInputs", () => {
  const snap = recordSnapshot({
    state: "stopped",
    take_index: 1,
    participants: [host, guest],
    takes: [
      {
        take_index: 0,
        session_start_wall_ms: 1000,
        session_start_iso: "t",
        stopped_wall_ms: 71_000,
        pauses: [{ seq: 0, pause_wall_ms: 11_000, resume_wall_ms: 21_000 }],
        consented_participant_ids: ["p_host", "p_g"],
      },
      {
        take_index: 1,
        session_start_wall_ms: 100_000,
        session_start_iso: "t",
        stopped_wall_ms: 130_000,
        pauses: [],
        consented_participant_ids: ["p_host"],
      },
    ],
  });

  it("is empty without a snapshot", () => {
    expect(takeInputs(null)).toEqual([]);
  });

  it("subtracts pauses from take length and numbers takes from one", () => {
    const out = takeInputs(snap);
    expect(out.map((t) => [t.take, t.lengthSec, t.open])).toEqual([
      [1, 60, false],
      [2, 30, false],
    ]);
  });

  it("derives per-person save status and landing", () => {
    const out = takeInputs(snap, [
      row({ participant_id: "p_host", landed: true }),
      row({ file_ack: false }),
    ]);
    expect(out[0]?.people).toEqual([
      { id: "p_host", name: "Hana", status: "saved" },
      { id: "p_g", name: "Bo", status: "saving" },
    ]);
    expect(out[0]?.landed).toBe(false);
    expect(out[1]?.people[0]?.status).toBe("waiting");
    const failed = takeInputs(snap, [row({ land_failed: true })]);
    expect(failed[0]?.people[1]?.status).toBe("failed");
  });

  it("uses the live clock for the open take and lists clip times", () => {
    const live = { ...snap, state: "recording" as const, recording_ms: 4000 };
    const out = takeInputs(live, [], {
      takeIndex: 1,
      known: true,
      regions: [
        { segmentIndex: 0, startMs: 2500, endMs: 3000, segmentStartMs: 2500 },
      ],
    });
    expect(out[1]).toMatchObject({
      open: true,
      lengthSec: 4,
      clipTimes: [2.5],
    });
    expect(out[0]?.clipTimes).toEqual([]);
  });
});

describe("noteItems", () => {
  it("is empty without comments", () => {
    expect(noteItems(null)).toEqual([]);
    expect(noteItems(recordSnapshot())).toEqual([]);
  });

  it("resolves authors by participant id, even with duplicate names", () => {
    const items = noteItems(
      recordSnapshot({
        participants: [
          host,
          recordParticipant({ participant_id: "a", display_name: "Bo" }),
          recordParticipant({ participant_id: "b", display_name: "Bo" }),
        ],
        comments: [
          {
            id: "1",
            take_index: 0,
            recording_ms: 0,
            pressed_wall_ms: 0,
            author: "b",
            body: "x",
          },
          {
            id: "2",
            take_index: 0,
            recording_ms: 0,
            pressed_wall_ms: 0,
            author: "gone",
            body: "y",
          },
        ],
      }),
    );
    expect(items[0]?.author).toEqual({ name: "Bo", colorIndex: 2 });
    expect(items[1]?.author).toEqual({ name: "gone" });
  });

  it("maps markers and notes onto the recording clock", () => {
    const items = noteItems(
      recordSnapshot({
        participants: [host, guest],
        comments: [
          {
            id: "1",
            take_index: 0,
            recording_ms: 724_000,
            pressed_wall_ms: 0,
            author: "p_g",
            body: "Marker",
          },
          {
            id: "2",
            take_index: 0,
            recording_ms: 5000,
            pressed_wall_ms: 0,
            author: "p_host",
            body: "Retake this",
          },
        ],
      }),
    );
    expect(items).toEqual([
      {
        id: "1",
        kind: "marker",
        author: { name: "Bo", colorIndex: 1 },
        time: "12:04",
      },
      {
        id: "2",
        kind: "note",
        author: { name: "Hana", colorIndex: 0 },
        time: "0:05",
        text: "Retake this",
        visibility: "everyone",
      },
    ]);
  });
});
