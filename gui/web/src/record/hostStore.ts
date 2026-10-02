import { create } from "zustand";
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
  /** Last failed host record command (transport or land); shown in the Record room panel. */
  transportError: string | null;
  setTransportError: (error: string | null) => void;
  keeperSink: ByteSink | null;
  keeperStorageError: string | null;
  captureHealth: CaptureHealth;
  takeClipping: TakeClipping | null;
  setTakeClipping: (clipping: TakeClipping | null) => void;
  setCaptureHealth: (health: CaptureHealth) => void;
  setKeeperStorage: (sink: ByteSink | null, error: string | null) => void;
  setSnapshot: (snap: RecordSnapshot | null) => void;
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
  takeClipping: null,
  setTakeClipping: (takeClipping) => set({ takeClipping }),
  setCaptureHealth: (captureHealth) => set({ captureHealth }),
  setKeeperStorage: (keeperSink, keeperStorageError) =>
    set({ keeperSink, keeperStorageError }),
  setSnapshot: (snapshot) =>
    set((state) => {
      if (
        snapshot &&
        state.snapshot?.session_id === snapshot.session_id &&
        (!shouldApplyRecordSnapshot(snapshot, state.snapshot) ||
          (snapshot.server_time_ns != null &&
            snapshot.server_time_ns === state.snapshot.server_time_ns))
      )
        return state;
      return { snapshot, receivedAtMs: snapshot ? performance.now() : null };
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
