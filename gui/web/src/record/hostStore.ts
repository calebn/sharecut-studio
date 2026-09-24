import { create } from "zustand";
import type { ByteSink } from "./keeper/store";
import type { RecordSnapshot } from "./types";

type RecordHostState = {
  snapshot: RecordSnapshot | null;
  connected: boolean;
  startPending: boolean;
  keeperSink: ByteSink | null;
  keeperStorageError: string | null;
  captureHealth: "pending" | "failed" | null;
  setCaptureHealth: (health: "pending" | "failed" | null) => void;
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
