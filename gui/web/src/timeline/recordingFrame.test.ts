import { afterEach, describe, expect, it, vi } from "vitest";
import { useRecordHostStore } from "../record/hostStore";
import { recordSnapshot } from "../test/fixtures";
import { hasRecordingFrame, recordingFrame } from "./recordingFrame";

afterEach(() => {
  useRecordHostStore.getState().setSnapshot(null);
  vi.restoreAllMocks();
});

describe("recording frame", () => {
  it("uses monotonic elapsed time across long gaps and clamps a negative frame delta", () => {
    const snap = recordSnapshot({ recording_ms: 1500, timeline_start_sec: 7 });
    expect(recordingFrame(snap, 100, 60100)).toEqual({
      startSec: 7,
      endSec: 68.5,
    });
    expect(recordingFrame(snap, 100, 50)?.endSec).toBe(8.5);
    expect(
      recordingFrame({ ...snap, state: "paused" }, 100, 60100)?.endSec,
    ).toBe(8.5);
  });
  it("requires an authoritative origin and clock sample", () => {
    for (const origin of [undefined, null, -1, NaN, Infinity]) {
      expect(
        recordingFrame(
          recordSnapshot({ timeline_start_sec: origin, recording_ms: 0 }),
          0,
          100,
        ),
      ).toBeNull();
    }
    expect(
      recordingFrame(recordSnapshot({ timeline_start_sec: 0 }), 0, 100),
    ).toBeNull();
    expect(
      recordingFrame(
        recordSnapshot({
          timeline_start_sec: 0,
          recording_ms: 0,
          state: "stopped",
        }),
        0,
        100,
      ),
    ).toBeNull();
    expect(recordingFrame(null, null, 100)).toBeNull();
    expect(
      hasRecordingFrame(
        recordSnapshot({ timeline_start_sec: 0, recording_ms: 0 }),
        0,
      ),
    ).toBe(true);
    expect(hasRecordingFrame(null, null)).toBe(false);
  });
  it("anchors accepted samples, ignores old/duplicate samples and corrects after reconnect and session change", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(100);
    const store = useRecordHostStore.getState();
    const first = recordSnapshot({
      timeline_start_sec: 7,
      recording_ms: 2000,
      server_time_ns: 20,
    });
    store.setSnapshot(first);
    now.mockReturnValue(900);
    store.setSnapshot({ ...first, server_time_ns: 19 });
    store.setSnapshot({ ...first });
    expect(useRecordHostStore.getState().receivedAtMs).toBe(100);
    store.setSnapshot({ ...first, recording_ms: 2500, server_time_ns: 21 });
    const accepted = useRecordHostStore.getState();
    expect(
      recordingFrame(accepted.snapshot, accepted.receivedAtMs, 1900)?.endSec,
    ).toBe(10.5);
    store.setSnapshot({
      ...first,
      take_index: 1,
      timeline_start_sec: 15,
      server_time_ns: 22,
    });
    expect(useRecordHostStore.getState().snapshot?.timeline_start_sec).toBe(15);
    store.setSnapshot({
      ...first,
      session_id: "new-session",
      server_time_ns: 1,
    });
    expect(useRecordHostStore.getState().snapshot?.session_id).toBe(
      "new-session",
    );
    store.setSnapshot(null);
    expect(useRecordHostStore.getState().receivedAtMs).toBeNull();
  });
});
