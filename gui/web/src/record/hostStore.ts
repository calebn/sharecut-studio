import { create } from "zustand";
import type { ByteSink } from "./keeper/store";
import type { CaptureHealth, RecordSnapshot } from "./types";

type RecordHostState = {
  snapshot: RecordSnapshot | null;
  connected: boolean;
  startPending: boolean;
  /** Last failed host record command (transport or land); shown in the Record room panel. */
  transportError: string | null;
  setTransportError: (error: string | null) => void;
  keeperSink: ByteSink | null;
  keeperStorageError: string | null;
  captureHealth: CaptureHealth;
  setCaptureHealth: (health: CaptureHealth) => void;
  setKeeperStorage: (sink: ByteSink | null, error: string | null) => void;
  setSnapshot: (snap: RecordSnapshot | null) => void;
  setConnected: (connected: boolean) => void;
  beginStart: () => void;
  finishStartRisk: (verified: boolean) => void;
};

export const useRecordHostStore = create<RecordHostState>((set) => ({
  snapshot: null,
  connected: false,
  startPending: false,
  transportError: null,
  setTransportError: (transportError) => set({ transportError }),
  keeperSink: null,
  keeperStorageError: null,
  captureHealth: null,
  setCaptureHealth: (captureHealth) => set({ captureHealth }),
  setKeeperStorage: (keeperSink, keeperStorageError) =>
    set({ keeperSink, keeperStorageError }),
  setSnapshot: (snapshot) => set({ snapshot }),
  setConnected: (connected) => set({ connected }),
  beginStart: () => set({ startPending: true }),
  finishStartRisk: (verified) =>
    set((state) => ({
      startPending: verified ? false : state.startPending,
    })),
}));
