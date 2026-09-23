import { describe, expect, it } from "vitest";
import {
  hostKeeperResetKey,
  hostReconnectPauseCopy,
  hostReconnectPauseCopyFromSnapshot,
  hostUploadLine,
  type RecordSnapshot,
  shouldApplyRecordSnapshot,
} from "./types";

const base: RecordSnapshot = {
  session_id: "room1",
  state: "paused",
  take_index: 0,
  participants: [],
  caps: { recorded: 4, producers: 2 },
};

describe("hostReconnectPauseCopy", () => {
  it("rounds the offline gap to whole seconds", () => {
    expect(hostReconnectPauseCopy(15_400)).toBe(
      "Paused — the host was offline for 15s. Resume when everyone is ready.",
    );
  });

  it("reads pause_reason from takes[].pauses when snapshot omits it", () => {
    const snap: RecordSnapshot = {
      ...base,
      takes: [
        {
          take_index: 0,
          session_start_wall_ms: 0,
          session_start_iso: "t0",
          pauses: [
            {
              seq: 0,
              pause_wall_ms: 10_000,
              resume_wall_ms: null,
              pause_reason: "host_reconnect",
            },
          ],
        },
      ],
      host_offline_gap_ms: 12_000,
    };
    expect(hostReconnectPauseCopyFromSnapshot(snap)).toContain("12s");
  });

  it("ignores a manual pause", () => {
    expect(
      hostReconnectPauseCopyFromSnapshot({
        ...base,
        host_offline_gap_ms: 12_000,
        takes: [
          {
            take_index: 0,
            session_start_wall_ms: 0,
            session_start_iso: "t0",
            pauses: [{ seq: 0, pause_wall_ms: 10_000, resume_wall_ms: null }],
          },
        ],
      }),
    ).toBeNull();
  });

  it("skips copy when the gap is missing or the pause is closed", () => {
    const openReconnect = {
      take_index: 0,
      session_start_wall_ms: 0,
      session_start_iso: "t0",
      pauses: [
        {
          seq: 0,
          pause_wall_ms: 10_000,
          resume_wall_ms: null,
          pause_reason: "host_reconnect" as const,
        },
      ],
    };
    expect(
      hostReconnectPauseCopyFromSnapshot({
        ...base,
        pause_reason: "host_reconnect",
        takes: [openReconnect],
      }),
    ).toBeNull();
    expect(
      hostReconnectPauseCopyFromSnapshot({
        ...base,
        host_offline_gap_ms: 12_000,
        pause_reason: "host_reconnect",
        takes: [
          {
            ...openReconnect,
            pauses: [
              {
                seq: 0,
                pause_wall_ms: 10_000,
                resume_wall_ms: 20_000,
                pause_reason: "host_reconnect",
              },
            ],
          },
        ],
      }),
    ).toBeNull();
  });
});

describe("hostKeeperResetKey", () => {
  it("stays at 0 while recording without a host-reconnect pause", () => {
    expect(hostKeeperResetKey({ ...base, state: "recording" })).toBe(0);
  });

  it("uses the open host-reconnect pause seq", () => {
    expect(
      hostKeeperResetKey({
        ...base,
        pause_reason: "host_reconnect",
        takes: [
          {
            take_index: 0,
            session_start_wall_ms: 0,
            session_start_iso: "t0",
            pauses: [
              {
                seq: 4,
                pause_wall_ms: 10_000,
                resume_wall_ms: null,
                pause_reason: "host_reconnect",
              },
            ],
          },
        ],
      }),
    ).toBe(5);
  });
});

describe("shouldApplyRecordSnapshot", () => {
  it("rejects HTTP snapshots older than the store", () => {
    const current: RecordSnapshot = { ...base, server_time_ns: 20 };
    expect(
      shouldApplyRecordSnapshot({ ...base, server_time_ns: 10 }, current),
    ).toBe(false);
    expect(
      shouldApplyRecordSnapshot({ ...base, server_time_ns: 20 }, current),
    ).toBe(true);
    expect(shouldApplyRecordSnapshot({ ...base }, current)).toBe(false);
    expect(
      shouldApplyRecordSnapshot({ ...base, server_time_ns: 1 }, null),
    ).toBe(true);
  });
});

describe("hostUploadLine", () => {
  it("pluralizes the chunk count for an undeclared total", () => {
    expect(hostUploadLine("Bo", false, 1)).toBe("Bo: 1 chunk acked.");
    expect(hostUploadLine("Bo", false, 2)).toBe("Bo: 2 chunks acked.");
    expect(hostUploadLine("Bo", false, 0)).toBe("Bo: waiting to upload.");
  });

  it("pluralizes the chunk count against the declared total", () => {
    expect(hostUploadLine("Bo", false, 1, 1)).toBe("Bo: 1/1 chunk acked.");
    expect(hostUploadLine("Bo", false, 0, 1)).toBe("Bo: 0/1 chunk acked.");
    expect(hostUploadLine("Bo", false, 1, 3)).toBe("Bo: 1/3 chunks acked.");
  });

  it("covers the uploaded, landed, and landing-failed branches", () => {
    expect(hostUploadLine("Bo", true, 1)).toBe(
      "Bo: uploaded; waiting to land.",
    );
    expect(hostUploadLine("Bo", true, 1, 1, true)).toBe("Bo: landed.");
    expect(hostUploadLine("Bo", true, 1, 1, true, true)).toBe(
      "Bo: landing failed — host must retry.",
    );
  });
});
