import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("applies a newer snapshot that differs only in watchers", () => {
    useRecordHostStore
      .getState()
      .setSnapshot(
        recordSnapshot({ state: "paused", server_time_ns: 11, watchers: 0 }),
      );
    useRecordHostStore
      .getState()
      .setSnapshot(
        recordSnapshot({ state: "paused", server_time_ns: 12, watchers: 2 }),
      );
    expect(useRecordHostStore.getState().snapshot?.watchers).toBe(2);
  });

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

describe("ended room tombstone", () => {
  const store = () => useRecordHostStore.getState();

  beforeEach(() => {
    useRecordHostStore.setState({ endedSessionId: null, snapshot: null });
    store().setSnapshot(recordSnapshot({ session_id: "s1", state: "lobby" }));
  });

  afterEach(() => {
    useRecordHostStore.setState({ endedSessionId: null, snapshot: null });
  });

  it("clears the room and ignores a late snapshot for it", () => {
    store().markEnded("s1");
    expect(store().snapshot).toBeNull();
    store().setSnapshot(recordSnapshot({ session_id: "s1", state: "lobby" }));
    expect(store().snapshot).toBeNull();
  });

  it("applies snapshots again once Undo lifts it", () => {
    store().markEnded("s1");
    store().liftEnded("s1");
    store().setSnapshot(recordSnapshot({ session_id: "s1", state: "lobby" }));
    expect(store().snapshot?.session_id).toBe("s1");
  });

  it("does not let Undo of another room lift it", () => {
    store().markEnded("s1");
    store().liftEnded("s2");
    expect(store().endedSessionId).toBe("s1");
  });

  it("clears when a different session arrives", () => {
    store().markEnded("s1");
    store().setSnapshot(recordSnapshot({ session_id: "s2", state: "lobby" }));
    expect(store().snapshot?.session_id).toBe("s2");
    expect(store().endedSessionId).toBeNull();
  });

  it("marks a room that is not on stage without touching the stage's", () => {
    store().markEnded("s9");
    expect(store().snapshot?.session_id).toBe("s1");
    expect(store().endedSessionId).toBe("s9");
  });
});
