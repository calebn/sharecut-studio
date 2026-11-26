import { create } from "zustand";
import { timelineViewportRegistry } from "../state/timelineViewportRegistry";
import type { TakeClipping } from "./keeper/clipRegions";
import type { ByteSink } from "./keeper/store";
import {
  type CaptureHealth,
  type RecordSnapshot,
  shouldApplyRecordSnapshot,
} from "./types";

type RecordHostState = {
  snapshot: RecordSnapshot | null;
  receivedAtMs: number | null;
  connected: boolean;
  /** The record socket was open and has since closed (a drop, not the first connect). */
  dropped: boolean;
  startPending: boolean;
  /** Last failed host record command (transport or land); shown on the Record stage. */
  transportError: string | null;
  setTransportError: (error: string | null) => void;
  keeperSink: ByteSink | null;
  keeperStorageError: string | null;
  captureHealth: CaptureHealth;
  /** The host mic is open: set by `useHostKeeperCapture` from the same `micLive` it opens the stream with. */
  micLive: boolean;
  setMicLive: (live: boolean) => void;
  /** Each remote guest's level, 0 to 1, from the host monitor. */
  peerLevels: Record<string, number>;
  setPeerLevels: (levels: Record<string, number>) => void;
  takeClipping: TakeClipping | null;
  setTakeClipping: (clipping: TakeClipping | null) => void;
  setCaptureHealth: (health: CaptureHealth) => void;
  setKeeperStorage: (sink: ByteSink | null, error: string | null) => void;
  /** The room the host ended: a snapshot for it is ignored until Undo lifts this or another room arrives. */
  endedSessionId: string | null;
  setSnapshot: (snap: RecordSnapshot | null) => void;
  /** Clears the room that ended and ignores later snapshots for it. */
  markEnded: (sessionId: string) => void;
  /** Undo brought the room back: snapshots for it apply again. */
  liftEnded: (sessionId: string) => void;
  setConnected: (connected: boolean) => void;
  /** The socket was torn down on purpose (project switch, disable): not a drop. */
  resetConnection: () => void;
  beginStart: () => void;
  finishStartRisk: (verified: boolean) => void;
};

export const useRecordHostStore = create<RecordHostState>((set) => ({
  snapshot: null,
  receivedAtMs: null,
  connected: false,
  dropped: false,
  startPending: false,
  transportError: null,
  setTransportError: (transportError) => set({ transportError }),
  keeperSink: null,
  keeperStorageError: null,
  captureHealth: null,
  micLive: false,
  setMicLive: (micLive) => set({ micLive }),
  peerLevels: {},
  setPeerLevels: (peerLevels) => set({ peerLevels }),
  takeClipping: null,
  setTakeClipping: (takeClipping) => set({ takeClipping }),
  setCaptureHealth: (captureHealth) => set({ captureHealth }),
  setKeeperStorage: (keeperSink, keeperStorageError) =>
    set({ keeperSink, keeperStorageError }),
  endedSessionId: null,
  markEnded: (sessionId) =>
    set((state) => {
      if (state.snapshot?.session_id === sessionId) {
        timelineViewportRegistry.setVisualPan(null);
        timelineViewportRegistry.setLayoutProjection(null);
        return { endedSessionId: sessionId, snapshot: null, receivedAtMs: null };
      }
      return { endedSessionId: sessionId };
    }),
  liftEnded: (sessionId) =>
    set((state) =>
      state.endedSessionId === sessionId ? { endedSessionId: null } : state,
    ),
  setSnapshot: (snapshot) =>
    set((state) => {
      if (snapshot && snapshot.session_id === state.endedSessionId) {
        return state;
      }
      const lift = snapshot && state.endedSessionId !== null;
      const ended = lift ? { endedSessionId: null } : {};
      if (
        snapshot &&
        state.snapshot?.session_id === snapshot.session_id &&
        (!shouldApplyRecordSnapshot(snapshot, state.snapshot) ||
          (snapshot.server_time_ns != null &&
            snapshot.server_time_ns === state.snapshot.server_time_ns))
      )
        return lift ? ended : state;
      if (
        (state.snapshot?.state === "recording" ||
          state.snapshot?.state === "paused") &&
        (!snapshot ||
          (snapshot.state !== "recording" && snapshot.state !== "paused") ||
          snapshot.session_id !== state.snapshot.session_id ||
          snapshot.take_index !== state.snapshot.take_index)
      ) {
        timelineViewportRegistry.setVisualPan(null);
        timelineViewportRegistry.setLayoutProjection(null);
      }
      return {
        ...ended,
        snapshot,
        receivedAtMs: snapshot ? performance.now() : null,
      };
    }),
  setConnected: (connected) =>
    set((state) => ({
      connected,
      dropped: connected ? false : state.connected || state.dropped,
    })),
  resetConnection: () => set({ connected: false, dropped: false }),
  beginStart: () => set({ startPending: true }),
  finishStartRisk: (verified) =>
    set((state) => ({
      startPending: verified ? false : state.startPending,
    })),
}));
