import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { timelineViewportRegistry } from "../state/timelineViewportRegistry";
import { recordSnapshot } from "../test/fixtures";
import { useRecordHostStore } from "./hostStore";
import type { RecordSnapshot } from "./types";

const scope = {
  projectPath: "/tmp/preview.json",
  playheadSec: 20,
  seekRevision: 1,
  zoomPxPerSec: 10,
};
const pan = {
  ...scope,
  geometry: { scrollLeft: 1200, lineOffsetPx: 100, zoomPxPerSec: 10 },
  scrollLeft: 1200,
};
const projection = { ...scope, requestedLeft: 1200, appliedLeft: 573 };

describe("record host preview lifetime", () => {
  beforeEach(() => {
    useRecordHostStore.getState().setSnapshot(null);
    useRecordHostStore
      .getState()
      .setSnapshot(recordSnapshot({ state: "paused", server_time_ns: 10 }));
    timelineViewportRegistry.setVisualPan(pan);
    timelineViewportRegistry.setLayoutProjection(projection);
  });

  afterEach(() => {
    useRecordHostStore.getState().setSnapshot(null);
    useRecordHostStore.getState().resetConnection();
    timelineViewportRegistry.clear();
  });

  it.each<Partial<RecordSnapshot> | null>([
    { state: "stopped", server_time_ns: 11 },
    { state: "lobby", server_time_ns: 11 },
    { state: "paused", take_index: 1, server_time_ns: 11 },
    { state: "paused", session_id: "replacement", server_time_ns: 1 },
    null,
  ])(
    "expires retained preview navigation on accepted replacement %j",
    (change) => {
      const snapshot = change === null ? null : recordSnapshot(change);
      useRecordHostStore.getState().setSnapshot(snapshot);
      expect(useRecordHostStore.getState().snapshot).toBe(snapshot);
      expect(timelineViewportRegistry.getVisualPan()).toBeNull();
      expect(timelineViewportRegistry.getLayoutProjection()).toBeNull();
      if (snapshot === null)
        expect(useRecordHostStore.getState().receivedAtMs).toBeNull();
    },
  );

  it.each<Partial<RecordSnapshot>>([
    { state: "stopped", server_time_ns: 9 },
    { state: "stopped", server_time_ns: 10 },
    { state: "stopped" },
    { state: "paused", take_index: 1, server_time_ns: 9 },
  ])(
    "preserves valid preview navigation when rejecting snapshot %j",
    (change) => {
      const before = useRecordHostStore.getState();
      useRecordHostStore.getState().setSnapshot(recordSnapshot(change));
      expect(useRecordHostStore.getState()).toBe(before);
      expect(timelineViewportRegistry.getVisualPan()).toBe(pan);
      expect(timelineViewportRegistry.getLayoutProjection()).toBe(projection);
    },
  );

  it.each([null, "stopped", "lobby"] as const)(
    "preserves ordinary layout projection with no live preview in %s",
    (state) => {
      useRecordHostStore
        .getState()
        .setSnapshot(
          state === null ? null : recordSnapshot({ state, server_time_ns: 11 }),
        );
      timelineViewportRegistry.setVisualPan(null);
      timelineViewportRegistry.setLayoutProjection(projection);
      useRecordHostStore
        .getState()
        .setSnapshot(
          state === null ? null : recordSnapshot({ state, server_time_ns: 12 }),
        );
      expect(timelineViewportRegistry.getLayoutProjection()).toBe(projection);
    },
  );

  it("preserves a live take through resume, pause and socket disconnect", () => {
    for (const state of ["recording", "paused"] as const) {
      useRecordHostStore.getState().setSnapshot(
        recordSnapshot({
          state,
          server_time_ns: state === "recording" ? 11 : 12,
        }),
      );
      expect(useRecordHostStore.getState().snapshot?.state).toBe(state);
      expect(timelineViewportRegistry.getVisualPan()).toBe(pan);
      expect(timelineViewportRegistry.getLayoutProjection()).toBe(projection);
    }
    useRecordHostStore.getState().setConnected(true);
    useRecordHostStore.getState().setConnected(false);
    expect(useRecordHostStore.getState().dropped).toBe(true);
    expect(timelineViewportRegistry.getVisualPan()).toBe(pan);
    expect(timelineViewportRegistry.getLayoutProjection()).toBe(projection);
  });
});

describe("accepted host snapshot clock cohort", () => {
  beforeEach(() => {
    useRecordHostStore.getState().setSnapshot(null);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1000);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    useRecordHostStore.getState().setSnapshot(null);
  });

  it("publishes a coherent cohort atomically and samples nothing for rejected or null snapshots", () => {
    const wall = vi.spyOn(Date, "now");
    const monotonic = vi.spyOn(performance, "now").mockReturnValue(100);
    const snapshot = recordSnapshot({ server_time_ns: 10 });
    const seen: {
      snapshot: RecordSnapshot | null;
      acceptedAtWallMs: number | null;
      receivedAtMs: number | null;
    }[] = [];
    const unsubscribe = useRecordHostStore.subscribe((state) => {
      seen.push({
        snapshot: state.snapshot,
        acceptedAtWallMs: state.acceptedAtWallMs,
        receivedAtMs: state.receivedAtMs,
      });
    });
    try {
      useRecordHostStore.getState().setSnapshot(snapshot);
      expect(seen).toEqual([
        { snapshot, acceptedAtWallMs: 1000, receivedAtMs: 100 },
      ]);
      const accepted = useRecordHostStore.getState();
      const wallReads = wall.mock.calls.length;
      const monotonicReads = monotonic.mock.calls.length;
      vi.setSystemTime(2000);
      for (const stale of [
        recordSnapshot({ server_time_ns: 9 }),
        recordSnapshot({ server_time_ns: 10 }),
        recordSnapshot(),
      ]) {
        useRecordHostStore.getState().setSnapshot(stale);
        expect(useRecordHostStore.getState()).toBe(accepted);
      }
      expect(seen).toHaveLength(1);
      expect(wall).toHaveBeenCalledTimes(wallReads);
      expect(monotonic).toHaveBeenCalledTimes(monotonicReads);
      useRecordHostStore.getState().setSnapshot(null);
      expect(seen.at(-1)).toEqual({
        snapshot: null,
        acceptedAtWallMs: null,
        receivedAtMs: null,
      });
      expect(wall).toHaveBeenCalledTimes(wallReads);
      expect(monotonic).toHaveBeenCalledTimes(monotonicReads);
      monotonic.mockReturnValue(250);
      const replacement = recordSnapshot({
        session_id: "replacement",
        server_time_ns: 1,
      });
      useRecordHostStore.getState().setSnapshot(replacement);
      expect(seen.at(-1)).toEqual({
        snapshot: replacement,
        acceptedAtWallMs: 2000,
        receivedAtMs: 250,
      });
    } finally {
      unsubscribe();
    }
  });

  it("retains wall origin for the current identity while monotonic preview receipts keep advancing", () => {
    const monotonic = vi.spyOn(performance, "now").mockReturnValue(100);
    const first = recordSnapshot();
    useRecordHostStore.getState().setSnapshot(first);
    vi.setSystemTime(2000);
    monotonic.mockReturnValue(200);
    useRecordHostStore.getState().setSnapshot(first);
    expect(useRecordHostStore.getState()).toMatchObject({
      snapshot: first,
      acceptedAtWallMs: 1000,
      receivedAtMs: 200,
    });
    const second = { ...first };
    vi.setSystemTime(3000);
    useRecordHostStore.getState().setSnapshot(second);
    expect(useRecordHostStore.getState().acceptedAtWallMs).toBe(3000);
    vi.setSystemTime(4000);
    useRecordHostStore.getState().setSnapshot(first);
    expect(useRecordHostStore.getState().acceptedAtWallMs).toBe(4000);
    useRecordHostStore.getState().setSnapshot(null);
    vi.setSystemTime(5000);
    useRecordHostStore.getState().setSnapshot(first);
    expect(useRecordHostStore.getState().acceptedAtWallMs).toBe(5000);
  });
});
